// Escritores do núcleo que se apoiam no save: public.erp_document_proposal_version (Salvar nova
// versão da proposta, 269), erp_document_notes_save (só Observações e Observações internas, 303)
// e erp_document_trash (Excluir e Restaurar, lixeira dos documentos).
import { createHash } from "node:crypto";
import { linkedDocumentGuard } from "../module-policy.ts";
import { uuidIn } from "../../../engine/args.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim } from "../../../engine/text.ts";
import { permitted } from "../../access/public.ts";
import { documentDto, effectFlags, proposalVersionJson, textValue } from "../internal.ts";
import { guardEffect, requireVisible } from "../mirror.ts";
import { contactUsable, requireAccess } from "../reads-g.ts";
import { updateDocument } from "../rows.ts";
import { commandReplay, editable, fieldText, proposalSuperseded, withoutUnavailableLinks } from "../save-checks.ts";
import { erpDocumentSave, transitionCommand } from "./erp_document_save.ts";
import { com1TrashBlocker, guardCom1NotesSave } from "../../fiscal/comnfe/effect-policy.ts";

type Data = Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const has = (o: unknown, k: string) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);

function audit(ctx: RpcContext, a: { actor: string; command: string; document: unknown; action: string; reason?: string | null; before: unknown; after: unknown }) {
  guardEffect(ctx.db, a.document); // aa_mirror_authority
  ctx.db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), a.actor, a.command, a.document, a.action, a.reason ?? null,
    a.before === null || a.before === undefined ? null : JSON.stringify(a.before), a.after === null || a.after === undefined ? null : JSON.stringify(a.after),
    ctx.clock.next().toString(),
  );
}
const receipt = (ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) =>
  ctx.db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, actor, hash, JSON.stringify(result), ctx.clock.next().toString());

/** public.erp_document_proposal_version: uma nova proposta 123-2 a partir do formulário. */
export function erpDocumentProposalVersion(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const body = a.p_body === undefined ? null : jsonbArg(a.p_body);
  requireVisible(db, user, id, true);
  requireAccess(db, user, "sales_proposals", true);
  if (id === null || command === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  // A versão leva a numeração automática; nunca traz proposta de origem nem atualização do contato.
  if (body === null || jsonType(body) !== "object" || has(body, "number") || has(body, "source_proposal") || has(body, "refresh_contact") || Buffer.byteLength(jsonbText(body), "utf8") > 262144)
    raise("22023", "erp_document_body_invalid");
  const hash = sha256(jsonbText({ op: "proposal_version", actor: user, id, version: expected, body }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const s = one(db, `SELECT * FROM "erp_documents__document" WHERE id=? AND kind='sales_proposals'`, id);
  if (!s || !contactUsable(db, user, s.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (s.version !== expected) raise("40001", "erp_document_version_conflict");
  if (fieldText(JSON.parse(String(s.body)), "template") === "true" || (body as Data).template === true) raise("22023", "erp_proposal_version_template");
  if (proposalSuperseded(db, id)) raise("40001", "erp_document_version_locked");
  const base = (one(db, 'SELECT base_id FROM "erp_documents__proposal_version" WHERE document_id=?', id)?.base_id as string | undefined) ?? id;
  const seq = Number(one(db, 'SELECT coalesce(max(version_seq),1) n FROM "erp_documents__proposal_version" WHERE base_id=?', base)!.n) + 1;
  if (seq > 9999) raise("54000", "erp_proposal_version_limit");
  const saved = erpDocumentSave(ctx, {
    p_user_id: user, p_kind: "sales_proposals", p_id: null, p_expected_version: 0, p_command_id: transitionCommand(command, "proposal_version"), p_body: withoutUnavailableLinks(ctx, body as Data),
  }) as Data;
  const versionId = String((saved.document as Data).id);
  db.exec(
    'INSERT INTO "erp_documents__proposal_version"(document_id, base_id, version_seq, source_id, created_by, created_at) VALUES(?,?,?,?,?,?)',
    versionId, base, seq, id, user, ctx.clock.next().toString(),
  );
  audit(ctx, { actor: user, command, document: id, action: "proposal_version", before: null, after: { version_id: versionId, version_seq: seq, base_id: base } });
  const result = {
    kind: "sales_proposals", document: documentDto(ctx, versionId), proposal_version: proposalVersionJson(db, versionId),
    source: { id: s.id, number: s.number === null ? null : String(s.number), version: s.version }, replayed: false, data_mode: "erp_native", operational_effects: false,
  };
  receipt(ctx, command, user, hash, result);
  return result;
}

/** erp_documents.effects_active(documento) */
export function effectsActive(db: SqlDriver, id: string): boolean {
  return (
    !!one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id) ||
    !!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id) ||
    !!one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', id) ||
    !!one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active' LIMIT 1`, id) ||
    !!one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id) LIMIT 1', id)
  );
}

/** public.erp_document_notes_save: Observações e Observações internas, também com efeito ativo (303). */
export function erpDocumentNotesSave(ctx: RpcContext, a: RpcArgs) {
  linkedDocumentGuard(ctx.db, a.p_id);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const notesArg = (a.p_notes as string | null) ?? null;
  const internalArg = (a.p_internal_notes as string | null) ?? null;
  requireVisible(db, user, id, true);
  if (kind === null || !["sales_orders", "service_orders", "purchase_orders"].includes(kind) || id === null) raise("22023", "erp_document_query_invalid");
  requireAccess(db, user, kind, true);
  if (expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "notes", actor: user, kind, id, version: expected, notes: notesArg, internal_notes: internalArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const notes = textValue(notesArg, 4000, false, true) as string | null;
  const internal = textValue(internalArg, 4000, false, true) as string | null;
  const row = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!row) raise("P0002", "erp_document_not_found");
  // 238: documento de contato que o usuário não vê não existe para ele.
  if (!contactUsable(db, user, row.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (row.version !== expected || row.version === 2147483647) raise("40001", "erp_document_version_conflict");
  if (!editable(row.status) && !effectsActive(db, id)) raise("40001", "erp_document_state_locked");
  const body = JSON.parse(String(row.body)) as Data;
  guardCom1NotesSave(ctx, id, fieldText(body, "notes"), notes);
  if (fieldText(body, "notes") !== notes || fieldText(body, "internal_notes") !== internal) {
    const before = documentDto(ctx, id);
    updateDocument(ctx, id, { body: JSON.stringify({ ...body, notes, internal_notes: internal }), version: Number(row.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
    audit(ctx, { actor: user, command: command!, document: id, action: "notes", before, after: documentDto(ctx, id) });
  }
  const result = { kind, document: documentDto(ctx, id), replayed: false, data_mode: "erp_native", operational_effects: false };
  receipt(ctx, command!, user, hash, result);
  return result;
}

/** erp_documents.trash_key(kind) */
const trashKey = (kind: string) =>
  ({ sales_proposals: "vendas.propostas.ex", sales_orders: "vendas.pedidos_venda.ex", purchase_orders: "suprimentos.pedidos_compra.ex", service_orders: "servicos.ordem_servico.ex" })[kind] ?? null;

/** erp_documents.trash_blocker(documento): por que o documento não vai para a lixeira, ou null. */
export function trashBlocker(ctx: RpcContext, id: string): string | null {
  const db = ctx.db;
  const f = effectFlags(ctx, id);
  if (f.stock_active) return "stock_posted";
  if (f.finance_active) return "finance_posted";
  const commercialNfe = com1TrashBlocker(ctx, id);
  if (commercialNfe) return commercialNfe;
  if (one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id WHERE o.document_id=? AND n.deleted_at IS NULL LIMIT 1', id)) return "invoice_linked";
  if (one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active' LIMIT 1`, id)) return "stock_reserved";
  if (one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', id)) return "grouped_billing";
  if (one(db, `SELECT 1 x FROM "erp_documents__checkout" WHERE document_id=? AND json_array_length(reads)>0 LIMIT 1`, id)) return "checkout";
  if (one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE source_proposal_id=? AND deleted_at IS NULL LIMIT 1', id)) return "generated_document";
  return null;
}

/** public.erp_document_trash: Excluir e Restaurar em lote. */
export function erpDocumentTrash(ctx: RpcContext, a: RpcArgs) {
  linkedDocumentGuard(ctx.db, a.p_id);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const action = (a.p_action as string | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const ids = a.p_ids === undefined ? null : jsonbArg(a.p_ids);
  if (Array.isArray(ids)) for (const id of ids) linkedDocumentGuard(ctx.db, id);
  const reasonArg = (a.p_reason as string | null) ?? null;
  if (
    kind === null || !["sales_proposals", "sales_orders", "purchase_orders", "service_orders"].includes(kind) || action === null || !["delete", "restore"].includes(action) ||
    command === null || ids === null || jsonType(ids) !== "array" || (ids as unknown[]).length < 1 || (ids as unknown[]).length > 100
  )
    raise("22023", "erp_document_trash_invalid");
  requireAccess(db, user, kind, true);
  if (!permitted(db, user, trashKey(kind)!)) raise("42501", "erp_document_access_denied");
  let reason: string | null = pgBtrim(reasonArg ?? "") || null;
  if (action === "delete" && (reason === null || [...reason].length < 3 || [...reason].length > 1000)) raise("22023", "erp_document_trash_reason");
  if (action === "restore") reason = null;
  // array_agg(distinct (x#>>'{}')::uuid order by ...): o null do jsonb vira NULL (por último).
  const cast = [...new Set((ids as unknown[]).map((x) => (x === null ? null : uuidIn(typeof x === "string" ? x : jsonbText(x)))))];
  const list = [...cast.filter((x): x is string => x !== null).sort(), ...(cast.includes(null) ? [null] : [])];
  for (const x of list) requireVisible(db, user, x, true);
  const hash = sha256(jsonbText({ kind, action, ids: list, reason }));
  const prior = one(db, 'SELECT actor, request_hash, result FROM "erp_documents__command" WHERE command_id=?', command);
  if (prior) {
    if (prior.actor !== user || prior.request_hash !== hash) raise("40001", "erp_document_command_conflict");
    return { ...JSON.parse(String(prior.result)), replayed: true };
  }
  const results: Data[] = [];
  for (const id of list) {
    const d = id === null ? undefined : one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
    if (!d || !contactUsable(db, user, d.contact_id as string | null)) {
      results.push({ id, ok: false, reason: "not_found" });
      continue;
    }
    if ((action === "delete") === (d.deleted_at !== null)) {
      results.push({ id, ok: true, reason: null });
      continue;
    }
    if (action === "delete") {
      const block = trashBlocker(ctx, id!);
      if (block !== null) {
        results.push({ id, ok: false, reason: block });
        continue;
      }
      const now = ctx.clock.next().toString();
      updateDocument(ctx, id!, { deleted_at: now, deleted_by: user, delete_reason: reason, version: Number(d.version) + 1, updated_at: now, updated_by: user });
    } else updateDocument(ctx, id!, { deleted_at: null, deleted_by: null, delete_reason: null, version: Number(d.version) + 1, updated_at: ctx.clock.next().toString(), updated_by: user });
    audit(ctx, {
      actor: user, command, document: id, action: action === "delete" ? "trash" : "restore", reason,
      before: { deleted: d.deleted_at !== null, version: d.version }, after: { deleted: action === "delete", version: Number(d.version) + 1 },
    });
    results.push({ id, ok: true, reason: null });
  }
  const result = { scope: "document_trash", data_mode: "erp_native", kind, action, command_id: command, results };
  receipt(ctx, command, user, hash, result);
  return { ...result, replayed: false };
}

registerRpc("erp_document_proposal_version", erpDocumentProposalVersion);
registerRpc("erp_document_notes_save", erpDocumentNotesSave);
registerRpc("erp_document_trash", erpDocumentTrash);
