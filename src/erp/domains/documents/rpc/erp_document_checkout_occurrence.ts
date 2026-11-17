// public.erp_document_checkout_save (conferência do pedido de venda: as leituras, o checkout parcial
// e a verificação pelo transition) e erp_document_occurrence_add (ocorrência manual, com a mudança
// de situação pelo transition e o próximo contato da proposta).
import { createHash } from "node:crypto";
import { jsonbArg } from "../../../engine/args.ts";
import { decText, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim } from "../../../engine/text.ts";
import { saoPauloParts } from "../../../engine/time.ts";
import { dateValue, decimalValue, documentDto, documentSituationJson, documentView, preference, situationAdopted, situationKeyValid, textValue } from "../internal.ts";
import { requireVisible } from "../mirror.ts";
import { transitions } from "../preferences.ts";
import { contactUsable, requireAccess, requireRole } from "../reads-g.ts";
import { updateDocument } from "../rows.ts";
import { commandReplay, recordOccurrence } from "../save-checks.ts";
import { checkoutLines, checkoutSettings, checkoutView, occurrenceJson } from "../views.ts";
import { erpDocumentTransition } from "./erp_document_transition.ts";

type Data = Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** md5(texto)::uuid */
const md5Uuid = (text: string) => {
  const h = createHash("md5").update(text, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const num = (t: string) => toScaled(decText(t, 30, false), 30);
const receipt = (ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) =>
  ctx.db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, actor, hash, JSON.stringify(result), ctx.clock.next().toString());

export function erpDocumentCheckoutSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const checkoutVersion = (a.p_checkout_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const reads = a.p_reads === undefined ? null : jsonbArg(a.p_reads);
  requireVisible(db, user, id, true);
  requireAccess(db, user, "sales_orders", true);
  if (id === null || expected === null || expected < 1 || checkoutVersion === null || checkoutVersion < 0) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "checkout", actor: user, id, version: expected, checkout_version: checkoutVersion, reads }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const d = one(db, `SELECT * FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, id);
  if (!d || !contactUsable(db, user, d.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (d.version !== expected) raise("40001", "erp_document_version_conflict");
  if (!["open", "checkout_partial"].includes(String(d.status))) raise("40001", "erp_document_checkout_unavailable");
  const c = one(db, 'SELECT * FROM "erp_documents__checkout" WHERE document_id=?', id);
  if (Number(c?.version ?? 0) !== checkoutVersion || c?.version === 2147483647) raise("40001", "erp_document_version_conflict");
  const split = c ? Number(c.split) === 1 : checkoutSettings(db).split;
  const lines = checkoutLines(db, id, split);
  if (reads === null || jsonType(reads) !== "array" || (reads as unknown[]).length > 1000) raise("22023", "erp_document_checkout_invalid");
  const keys: string[] = [];
  const saved: { key: string; quantity: string }[] = [];
  let any = false;
  for (const r of reads as unknown[]) {
    const o = r as Data;
    if (jsonType(r) !== "object" || Object.keys(o).length !== 2 || !("key" in o) || !("quantity" in o) || typeof o.key !== "string" || keys.includes(o.key))
      raise("22023", "erp_document_checkout_invalid");
    const line = lines.find((x) => x.key === o.key);
    if (!line) raise("22023", "erp_document_checkout_invalid");
    const qty = decimalValue(o.quantity, 6, 15) as string | null;
    if (qty !== null && line.quantity !== null && num(qty) > num(line.quantity)) raise("22023", "erp_document_checkout_exceeds");
    keys.push(o.key as string);
    if (qty !== null && num(qty) > 0n) {
      saved.push({ key: o.key as string, quantity: decText(qty, 6, true) });
      any = true;
    }
  }
  let complete = true;
  for (const l of lines) {
    const got = saved.find((x) => x.key === l.key);
    const read = got ? num(got.quantity) : 0n;
    if (l.quantity === null || read !== num(l.quantity)) complete = false;
  }
  if (lines.length === 0) raise("22023", "erp_document_checkout_invalid");
  const target = complete ? "verified" : any ? "checkout_partial" : "open";
  const now = ctx.clock.next().toString();
  if (!c)
    db.exec('INSERT INTO "erp_documents__checkout"(document_id, reads, split, version, updated_by, updated_at) VALUES(?,?,?,1,?,?)', id, JSON.stringify(saved), split ? 1 : 0, user, now);
  else db.exec('UPDATE "erp_documents__checkout" SET reads=?, version=version+1, updated_by=?, updated_at=? WHERE document_id=?', JSON.stringify(saved), user, now, id);
  db.exec(
    'INSERT INTO "erp_documents__checkout_audit"(id, document_id, actor, command_id, version, status_before, status_after, reads, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__checkout_audit", "id"), id, user, command, checkoutVersion + 1, d.status, target, JSON.stringify(saved), ctx.clock.next().toString(),
  );
  let transition: Data | null = null;
  // A situação muda pelo transition (ocorrência, Gerenciador, contas automáticas), com comando derivado.
  if (target !== d.status)
    transition = erpDocumentTransition(ctx, {
      p_user_id: user, p_kind: "sales_orders", p_id: id, p_expected_version: d.version, p_command_id: md5Uuid(`${command}:checkout`), p_status: target, p_reason: null,
    }) as Data;
  let result: Data = { ...(checkoutView(db, id) as Data), complete, replayed: false };
  if (transition && "auto_finance" in transition) result = { ...result, auto_finance: transition.auto_finance };
  receipt(ctx, command!, user, hash, result);
  return result;
}

export function erpDocumentOccurrenceAdd(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_document_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const onArg = (a.p_occurred_on as string | null) ?? null;
  const timeArg = (a.p_occurred_time as string | null) ?? null;
  const textArg = (a.p_text as string | null) ?? null;
  const status = (a.p_status as string | null) ?? null;
  const nextArg = (a.p_next_contact as string | null) ?? null;
  const nowParts = saoPauloParts(ctx.clock.next());
  requireVisible(db, user, id, true);
  // 239: a mudança de situação é conferida pelo transition; a nota pede a permissão de edição.
  requireRole(db, user, kind, true);
  if (status === null) requireAccess(db, user, kind, true);
  const adopted = situationAdopted(db, kind);
  if (
    id === null || expected === null || expected < 1 || timeArg === null || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(timeArg) ||
    (status !== null && !(adopted ? situationKeyValid(db, kind, status) : kind !== null && Object.prototype.hasOwnProperty.call(transitions()[kind] ?? {}, status))) ||
    (nextArg !== null && kind !== "sales_proposals")
  )
    raise("22023", "erp_document_occurrence_invalid");
  let on = dateValue(onArg, true) as string;
  const text = textValue(textArg, 1000, false, true) as string | null;
  const next = dateValue(nextArg) as string | null;
  const hash = sha256(jsonbText({ op: "occurrence", actor: user, kind, id, version: expected, occurred_on: onArg, occurred_time: timeArg, text: textArg, status, next_contact: nextArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  // Sem a preferência, a ocorrência fica com a data e a hora atuais; com ela, qualquer momento até agora.
  let time: string;
  if (preference(db, "empresa.editar_data_ocorrencia") === true) {
    time = timeArg;
    if (`${on} ${time}` > `${nowParts.date} ${nowParts.hm}`) raise("22023", "erp_document_occurrence_future");
  } else {
    on = nowParts.date;
    time = nowParts.hm;
  }
  const row = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!row) raise("P0002", "erp_document_not_found");
  if (row.version !== expected || row.version === 2147483647) raise("40001", "erp_document_version_conflict");
  if (!contactUsable(db, user, row.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  const key = adopted ? ((one(db, 'SELECT situation_id FROM "erp_documents__document_situation" WHERE document_id=?', id)?.situation_id as string | undefined) ?? String(row.status)) : String(row.status);
  const change = status !== null && status !== key;
  // Situação igual à atual é só nota: pede a permissão de edição também.
  if (status !== null && !change) requireAccess(db, user, kind, true);
  if (!change && text === null && next === null) raise("22023", "erp_document_occurrence_empty");
  const settings: [string, string][] = [["on", on], ["time", time], ["text", text ?? ""], ["next_contact", next ?? ""]];
  for (const [k, v] of settings) ctx.settings.set(`erp_documents.occurrence_${k}`, v);
  let transition: Data | null = null;
  try {
    if (change) {
      const reason = pgBtrim((text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")) || null;
      transition = erpDocumentTransition(ctx, {
        p_user_id: user, p_kind: kind, p_id: id, p_expected_version: row.version, p_command_id: md5Uuid(`occurrence-transition:${command}`), p_status: status, p_reason: reason,
      }) as Data;
    } else if (adopted)
      recordOccurrence(ctx, {
        document: id, actor: user, command: command!, version: Number(row.version), before: row.status, after: null, text, situationBefore: documentSituationJson(db, id), situationAfter: null,
      });
    else recordOccurrence(ctx, { document: id, actor: user, command: command!, version: Number(row.version), before: row.status, after: null, text });
  } finally {
    for (const [k] of settings) ctx.settings.set(`erp_documents.occurrence_${k}`, "");
  }
  const audit = (action: string, reason: string | null, before: unknown, after: unknown) =>
    db.exec(
      'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      nextIdentity(ctx, "erp_documents__audit", "id"), user, command, id, action, reason, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      ctx.clock.next().toString(),
    );
  if (next !== null) {
    const before = documentDto(ctx, id);
    const current = one(db, 'SELECT version, body FROM "erp_documents__document" WHERE id=?', id)!;
    updateDocument(ctx, id, {
      body: JSON.stringify({ ...(JSON.parse(String(current.body)) as Data), next_contact: next }), version: Number(current.version) + 1, updated_by: user,
      updated_at: ctx.clock.next().toString(),
    });
    audit("next_contact", null, before, documentDto(ctx, id));
  } else if (!change) audit("occurrence", text, null, null);
  const last = one(db, 'SELECT * FROM "erp_documents__occurrence" WHERE document_id=? ORDER BY sequence DESC LIMIT 1', id);
  let result: Data = {
    kind, document: documentView(ctx, id), occurrence: last ? occurrenceJson(last) : null, replayed: false, data_mode: "erp_native", operational_effects: false,
  };
  if (transition && "auto_finance" in transition) result = { ...result, auto_finance: transition.auto_finance };
  receipt(ctx, command!, user, hash, result);
  return result;
}

registerRpc("erp_document_checkout_save", erpDocumentCheckoutSave);
registerRpc("erp_document_occurrence_add", erpDocumentOccurrenceAdd);
