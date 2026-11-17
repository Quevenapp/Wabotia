// public.erp_document_transition: mudar a situação do documento, passo a passo como o original.
// Sem situações adotadas (proposta): a transição do status pelas transitions(). Com situações
// (pedidos e OS): a regra da transição (Preferências, sessão G), as ações configuradas
// (estornar e lançar estoque, pela sessão N; estornar e lançar contas, B5) e a ocorrência.
// Linha de corte do Origin: erp_document_mirror.require_visible não tem efeito.
// Pendente (B5): as ações reverse_finance e post_finance e o auto_finance, quando há o que
// lançar ou estornar, chamam os erp_document_finance_*, ainda não portados: 0A000.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { notPorted, raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { situationOf, transitionRule } from "../../preferences/shared.ts";
import { erpDocumentStockPost, erpDocumentStockPreview, erpDocumentStockReverse, erpDocumentStockReversePreview } from "../../stock/public.ts";
import { approvalSituations, discountApprover, documentDto, documentView, situationAdopted, situationJson, situationKeyValid, textValue } from "../internal.ts";
import { transitions } from "../preferences.ts";
import { stockLaunchDate } from "../public.ts";
import { contactUsable, requireRole } from "../reads-g.ts";
import { updateDocument } from "../rows.ts";
import { categoryUsable, commandReplay, currentVersion, editable, fieldText, recordOccurrence, requireOsPermission } from "../save-checks.ts";
import { autoFinance } from "./erp_document_save.ts";

type Data = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const LEGACY: Record<string, Record<string, string[]>> = {
  sales_proposals: { draft: ["open", "cancelled"], open: ["pending", "waiting", "approved", "rejected", "cancelled"], pending: ["open", "waiting", "approved", "rejected", "cancelled"], waiting: ["open", "pending", "approved", "rejected", "cancelled"], approved: ["open", "cancelled"], rejected: ["open"], cancelled: ["open"], completed: [] },
  sales_orders: { draft: ["open", "cancelled"], open: ["verified", "in_progress", "cancelled"], verified: ["open", "in_progress", "cancelled"], in_progress: ["partially_fulfilled", "fulfilled", "cancelled"], partially_fulfilled: ["in_progress", "fulfilled", "cancelled"], fulfilled: ["open"], cancelled: ["open"] },
  purchase_orders: { open: ["in_progress", "cancelled"], in_progress: ["partially_fulfilled", "fulfilled", "cancelled"], partially_fulfilled: ["in_progress", "fulfilled", "cancelled"], fulfilled: ["open"], cancelled: ["open"] },
  service_orders: { open: ["quoted", "no_repair", "cancelled"], quoted: ["approved", "rejected", "cancelled"], approved: ["in_progress", "cancelled"], rejected: ["quoted", "no_repair"], in_progress: ["waiting_parts", "service_done", "no_repair", "cancelled"], waiting_parts: ["in_progress", "no_repair", "cancelled"], service_done: ["in_progress", "finalized"], finalized: ["open"], no_repair: ["open"], cancelled: ["open"] },
};

/** erp_documents.transition_reason_required(kind, de, para) */
export function transitionReasonRequired(kind: string, from: string | null, to: string | null): boolean {
  if (to === "cancelled") return true;
  if (to === "open" && ["approved", "rejected", "fulfilled", "finalized", "no_repair", "cancelled"].includes(String(from))) return true;
  if ((from === "rejected" && to === "quoted") || (from === "service_done" && to === "in_progress")) return true;
  const legacy = from === null || to === null ? false : (LEGACY[kind]?.[from] ?? []).includes(to);
  return !legacy && !editable(from);
}

/** erp_documents.check_situation_change(usuário, kind, de, para) */
export function checkSituationChange(db: SqlDriver, user: string, kind: string, from: string | null, to: string | null) {
  requireOsPermission(db, user, kind, "situacoes");
  if (kind !== "sales_orders") return;
  const set = approvalSituations(db) as string[];
  const inSet = (k: string | null) => k !== null && UUID.test(k) && set.includes(k);
  if (inSet(from) && !inSet(to ?? "") && !discountApprover(db, user, "sales_orders")) raise("42501", "erp_document_discount_approval_required");
}

/** erp_documents.transition_command(comando, ação): md5(...)::uuid */
export function transitionCommand(command: string, action: string) {
  const h = createHash("md5").update(`situation-transition:${action}:${command}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** erp_documents.finance_category(kind, categoria) */
export function financeCategory(db: SqlDriver, kind: string, category: string | null): string | null {
  if (category !== null) return category;
  const key = { sales_orders: "sale", service_orders: "service", purchase_orders: "purchase" }[kind];
  if (key === undefined) return null;
  return (one(db, 'SELECT d.category_id FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id WHERE d.key=? AND c.active=1 AND c.deleted_at IS NULL', key)?.category_id as string | undefined) ?? null;
}

/** erp_documents.document_finance_category(documento, categoria) */
export function documentFinanceCategory(db: SqlDriver, d: Data, category: string | null): string | null {
  if (category !== null) return category;
  const body = JSON.parse(String(d.body));
  const own = fieldText(body, "category_id");
  if (categoryUsable(db, String(d.kind), own)) return own;
  return financeCategory(db, String(d.kind), null);
}

/** erp_documents.transition_action(usuário, kind, documento, comando, ação, rótulo) */
function transitionAction(ctx: RpcContext, user: string, kind: string, id: string, command: string, action: string, label: string): Data {
  const db = ctx.db;
  const day = todaySaoPaulo();
  const reason = [...`${action.startsWith("reverse_") ? "Estorno pela mudança de situação para " : "Lançamento pela mudança de situação para "}${label}`].slice(0, 500).join("");
  const scope = () => ({ p_user_id: user, p_kind: kind, p_document_id: id, p_expected_version: currentVersion(db, id) });
  if (action === "reverse_stock") {
    const p = one(db, `SELECT id, version FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, id);
    if (!p) return { action, outcome: "skipped" };
    const preview = (erpDocumentStockReversePreview(ctx, { ...scope(), p_posting_id: p.id, p_posting_version: p.version, p_occurred_on: day, p_reason: reason }) as Data).preview as Data;
    erpDocumentStockReverse(ctx, {
      ...scope(), p_posting_id: p.id, p_posting_version: p.version, p_command_id: transitionCommand(command, action), p_preview_hash: fieldText(preview, "preview_hash"), p_occurred_on: day, p_reason: reason,
    });
    return { action, outcome: "done", posting_id: p.id };
  }
  if (action === "reverse_finance") {
    const p = one(db, `SELECT id, version FROM "erp_finance__document_posting" WHERE document_id=? AND state='active'`, id);
    if (!p) return { action, outcome: "skipped" };
    return notPorted("erp_document_finance_reverse (ação reverse_finance da transição)");
  }
  if (action === "post_stock") {
    if (one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id)) return { action, outcome: "skipped" };
    const launch = stockLaunchDate(db, id);
    const preview = (erpDocumentStockPreview(ctx, { ...scope(), p_occurred_on: launch, p_reason: reason }) as Data).preview as Data;
    const ignored = Array.isArray(preview?.ignored) ? (preview.ignored as Data[]).map((i) => (i === null || typeof i !== "object" ? null : (i.id ?? null))) : [];
    const result = erpDocumentStockPost(ctx, {
      ...scope(), p_command_id: transitionCommand(command, action), p_preview_hash: fieldText(preview, "preview_hash"), p_occurred_on: launch, p_reason: reason, p_ignored_item_ids: ignored,
    }) as Data;
    return { action, outcome: "done", posting_id: fieldText((result as Data).posting, "id") };
  }
  if (action === "post_finance") {
    if (one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id)) return { action, outcome: "skipped" };
    const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', id)!;
    if (documentFinanceCategory(db, d, null) === null) raise("22023", "erp_document_transition_category_required");
    return notPorted("erp_document_finance_post (ação post_finance da transição)");
  }
  raise("22023", "erp_document_transition_action_invalid");
}

function audit(ctx: RpcContext, a: { actor: string; command: string; document: string; reason: string | null; before: unknown; after: unknown }) {
  ctx.db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), a.actor, a.command, a.document, "transition", a.reason,
    a.before === null || a.before === undefined ? null : JSON.stringify(a.before), JSON.stringify(a.after), ctx.clock.next().toString(),
  );
}

export function erpDocumentTransition(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const status = (a.p_status as string | null) ?? null;
  const reasonArg = (a.p_reason as string | null) ?? null;
  // 239: o perfil grava o tipo; a OS também pede "Gerenciar situações" (abaixo, com a regra de aprovação).
  requireRole(db, user, kind, true);
  if (id === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "transition", actor: user, kind, id, version: expected, status, reason: reasonArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const row = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!row) raise("P0002", "erp_document_not_found");
  if (row.version !== expected || row.version === 2147483647) raise("40001", "erp_document_version_conflict");
  const reason = textValue(reasonArg, 1000) as string | null;
  if (!contactUsable(db, user, row.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  const finish = (result: Data, before: unknown, after: unknown) => {
    audit(ctx, { actor: user, command: command!, document: id, reason, before, after });
    db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, user, hash, JSON.stringify(result), ctx.clock.next().toString());
    return result;
  };
  const len = (t: string | null) => (t === null ? 0 : [...t].length);
  if (!situationAdopted(db, kind)) {
    checkSituationChange(db, user, kind!, row.status as string, status);
    if (status === null || !(transitions()[kind!]?.[String(row.status)] ?? []).includes(status)) raise("22023", "erp_document_transition_invalid");
    if (transitionReasonRequired(kind!, row.status as string, status) && len(reason) < 3) raise("22023", "erp_document_reason_required");
    if (fieldText(JSON.parse(String(row.body)), "template") === "true" && status === "approved") raise("22023", "erp_document_template_not_approvable");
    const before = documentDto(ctx, id);
    updateDocument(ctx, id, { status, version: Number(row.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
    recordOccurrence(ctx, { document: id, actor: user, command: command!, version: Number(row.version) + 1, before: row.status, after: status, text: reason });
    const auto = autoFinance(ctx, user, id, command!);
    let result: Data = { kind, document: documentDto(ctx, id), replayed: false, data_mode: "erp_native", operational_effects: false };
    if (auto !== null) result = { ...result, auto_finance: auto };
    return finish(result, before, documentDto(ctx, id));
  }
  const current = (one(db, 'SELECT situation_id FROM "erp_documents__document_situation" WHERE document_id=?', id)?.situation_id as string | undefined) ?? null;
  const fromKey = current ?? (row.status as string);
  checkSituationChange(db, user, kind!, fromKey, status);
  if (status === null || status === fromKey || !situationKeyValid(db, kind, status)) raise("22023", "erp_document_transition_invalid");
  const rule = transitionRule(db, kind!, fromKey, status);
  const target = situationOf(db, kind!, status);
  if (rule === null || target === null || !rule.configured) raise("22023", "erp_document_transition_invalid");
  // O par precisa estar ativo, e a situação de destino também; sair de uma situação inativa continua possível.
  const pair = one(db, 'SELECT active FROM "erp_preferences__transition" WHERE kind=? AND from_key=? AND to_key=?', kind, fromKey, status);
  if ((pair && Number(pair.active) !== 1) || !target.active) raise("22023", "erp_document_transition_inactive");
  const toBase = rule.to_base;
  const custom = target.default ? null : status;
  if (toBase !== row.status && transitionReasonRequired(kind!, row.status as string, toBase) && len(reason) < 3) raise("22023", "erp_document_reason_required");
  const actions = rule.actions;
  const fromSituation = situationJson(db, kind, row.status as string, current);
  const before = documentView(ctx, id);
  const effects: Data[] = [];
  for (const action of ["reverse_stock", "reverse_finance"]) if (actions.includes(action)) effects.push(transitionAction(ctx, user, kind!, id, command!, action, target.name));
  updateDocument(ctx, id, { status: toBase, version: Number(currentVersion(db, id)) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
  db.exec('DELETE FROM "erp_documents__document_situation" WHERE document_id=?', id);
  if (custom !== null)
    db.exec(
      'INSERT INTO "erp_documents__document_situation"(document_id, kind, situation_id, base_status, actor, command_id, set_at) VALUES(?,?,?,?,?,?,?)',
      id, kind, custom, toBase, user, command, ctx.clock.next().toString(),
    );
  for (const action of ["post_stock", "post_finance"]) if (actions.includes(action)) effects.push(transitionAction(ctx, user, kind!, id, command!, action, target.name));
  const auto = autoFinance(ctx, user, id, command!);
  const toSituation = situationJson(db, kind, toBase, custom);
  recordOccurrence(ctx, {
    document: id, actor: user, command: command!, version: currentVersion(db, id), before: row.status, after: toBase !== row.status ? toBase : null, text: reason,
    situationBefore: fromSituation, situationAfter: toSituation,
  });
  let result: Data = { kind, document: documentView(ctx, id), effects, replayed: false, data_mode: "erp_native", operational_effects: false };
  if (auto !== null) result = { ...result, auto_finance: auto };
  return finish(result, before, { ...documentView(ctx, id), effects, ...(auto !== null ? { auto_finance: auto } : {}) });
}

registerRpc("erp_document_transition", erpDocumentTransition);
