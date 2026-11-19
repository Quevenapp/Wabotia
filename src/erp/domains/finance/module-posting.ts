import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcArgs, RpcContext } from "../../engine/registry.ts";
import { assertOwnEffect, execution, internalCommand, originScope, previousReceipt, requireOriginOperation, systemScope, targetOrigin, withOriginOperation, writeOriginAnchor, type ComponentState } from "../../engine/module-origin.ts";
import { permitted } from "../access/public.ts";
import { insertAudit, titleUpdateGuards, writeRow, captureFinance } from "./internal.ts";
import { updateTitle } from "./titles.ts";
import { canonical } from "../../../integrations/keys.ts";
import { erpFinanceTitleExecute } from "./rpc/erp_finance_title_execute.ts";
import { erpFinanceExecute } from "./rpc/erp_finance_execute.ts";
import { erpDocumentFinancePost, erpDocumentFinancePreview, erpDocumentFinanceReverse, erpDocumentFinanceReversePreview } from "./rpc/erp_document_finance.ts";
import { erpDocumentStockPost, erpDocumentStockPreview, erpDocumentStockReverse, erpDocumentStockReversePreview } from "../stock/rpc/document-stock.ts";
import type { ModuleBody } from "../documents/module-policy.ts";

type Data = Record<string, any>;
/** Núcleo explícito de manutenção F3; preserva os gatilhos financeiros. */
export function moduleUpdateTitle(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  if (!originScope(ctx) || ctx.parts.finance) return updateTitle(ctx, id, set);
  const scope = originScope(ctx)!, anchor = targetOrigin(ctx.db, "title", id);
  const old = one(ctx.db, "SELECT * FROM erp_finance__title WHERE id=?", id);
  if (!anchor || !old || old.kind !== "receivable" || canonical(anchor.source) !== canonical(execution(ctx).request.source) ||
      !["title_cancel", "settlement_reverse"].includes(scope.operation) || Number(set.version) !== Number(old.version) + 1 ||
      Object.keys(set).some(k => !["cancelled", "settled_cents", "version", "updated_at"].includes(k))) raise("42501", "module_origin_denied");
  if (scope.operation === "title_cancel") {
    if (set.cancelled !== true || "settled_cents" in set || Number(old.settled_cents) !== 0 ||
        one(ctx.db, "SELECT 1 FROM erp_cnab__billing_title WHERE title_id=?", id)) raise("40001", "erp_finance_active_payments");
  } else if ("cancelled" in set || Number(set.settled_cents) < 0 || Number(set.settled_cents) >= Number(old.settled_cents)) raise("42501", "module_origin_denied");
  writeRow(ctx, "erp_finance__title", "id", id, titleUpdateGuards(ctx, old, set));
  captureFinance(ctx, "title", id);
}
export function moduleFinanceAudit(ctx: RpcContext, actor: string, command: string, action: string, before: unknown, after: unknown) {
  if (!originScope(ctx)) return insertAudit(ctx, actor, command, action, before, after);
  if (!systemScope(ctx)) {
    const permission = action === "document_post" || action === "title_create" ? "ie" : action === "document_reverse" || action === "title_cancel" ? "cancelar" : "baixar";
    if (!permitted(ctx.db, actor, `financas.contas_receber.${permission}`)) raise("42501", "erp_finance_permission_denied");
  }
  const op = originScope(ctx)!.operation;
  if (!({ title_create: ["title_create", "document_post"], title_settle: ["settle"], title_cancel: ["title_cancel", "document_reverse"], settlement_reverse: ["reverse"] } as Record<string, string[]>)[op]?.includes(action)) raise("42501", "module_origin_denied");
  ctx.db.exec("INSERT INTO erp_finance__audit(actor,command_id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)",
    actor, command, action, before == null ? null : JSON.stringify(before), JSON.stringify(after), ctx.clock.next().toString());
}
export function moduleFinancePreviewGuard(ctx: RpcContext, preview: Data) {
  if (!originScope(ctx)) return;
  const b = execution(ctx).request.body as unknown as ModuleBody;
  const planned = b.snapshot.installments;
  if (preview.direction !== "receivable" || preview.issued_on !== b.snapshot.issued_on ||
      !Array.isArray(preview.installments) || preview.installments.length !== planned.length ||
      preview.installments.some((part: Data, i: number) => part.due_on !== planned[i].due_on || Number(part.amount_cents) !== planned[i].amount_cents))
    raise("40001", "module_payment_plan_conflict");
}
export function moduleFinancialGuard(ctx: RpcContext, action: string | null, data: any) {
  const scope = originScope(ctx);
  if (!scope) return;
  const operations = { title_create: "title_create", settle: "title_settle", title_cancel: "title_cancel", reverse: "settlement_reverse" } as const;
  if (!action || !(action in operations) || scope.operation !== operations[action as keyof typeof operations]) raise("42501", "module_origin_denied");
  if (action === "title_create") {
    if (data?.kind !== "receivable" || !data.category_id || (execution(ctx).request.body as any).route !== "title") raise("42501", "module_origin_denied");
    return;
  }
  requireOriginOperation(ctx, scope.operation, data?.id);
  const title = one(ctx.db, "SELECT * FROM erp_finance__title WHERE id=?", data.id);
  if (!title || title.kind !== "receivable" || !targetOrigin(ctx.db, "title", data.id)) raise("42501", "module_origin_denied");
  // As baixas/reversões do núcleo continuam validando versão, conta, datas e saldo.
  if (action === "title_cancel" && one(ctx.db, "SELECT 1 FROM erp_cnab__billing_title WHERE title_id=?", data.id)) raise("40001", "erp_finance_billed_locked");
  if (action === "reverse") assertOwnEffect(ctx, "settlement", data.settlement_id);
  if (action === "settle") {
    const b = execution(ctx).request.body as unknown as ModuleBody;
    if (!b.receipt || b.operation !== "receive" || Number(data.principal_cents) > b.receipt.amount_cents ||
        ["interest_cents", "penalty_cents", "discount_cents", "fee_cents"].some(k => data[k] != null && data[k] !== "0")) raise("42501", "module_origin_denied");
  }
}
export function requireManualDestinations(ctx: RpcContext, b: ModuleBody) {
  if (execution(ctx).evidence.mode !== "human") return;
  const actor = ctx.identity.actor!, role = one(ctx.db, "SELECT role FROM erp_access__membership WHERE user_id=? AND active=1", actor.user_id)?.role;
  if (actor.is_agent || (!b.requested.stock && !b.requested.finance)) raise("42501", "module_manual_denied");
  for (const part of ["stock", "finance"] as const) if (b.requested[part]) {
    if (role !== "admin" && role !== (part === "stock" ? "estoque" : "financeiro")) raise("42501", "module_manual_denied");
    if (part === "finance" && (actor.aal !== "aal2" || !actor.verified_factor || !actor.session_id)) raise("42501", "module_manual_mfa_required");
    const key = part === "stock" ? "suprimentos.controle_estoque.insercao" : b.operation === "receive" || b.operation === "reverse" ? "financas.contas_receber.baixar" : b.operation === "cancel" ? "financas.contas_receber.cancelar" : "financas.contas_receber.ie";
    if (!permitted(ctx.db, actor.user_id, key)) raise("42501", "module_manual_denied");
  }
}
const version = (ctx: RpcContext, table: string, id: string) => Number(one(ctx.db, `SELECT version FROM ${table} WHERE id=?`, id)?.version);
function effect(ctx: RpcContext, state: ComponentState, kind: string, id: string, command: string, slot: string, receipt: string | null = null, amount?: number) {
  writeOriginAnchor(ctx, slot, kind, id);
  state.effects.push({ kind, id, actor: execution(ctx).request.actor_id, command_id: command, receipt_key: receipt, version: kind === "settlement" ? null : 1, ...(amount !== undefined ? { amount_cents: amount } : {}) });
}
export function postModuleDocument(ctx: RpcContext, b: ModuleBody, state: ComponentState, document: string, destination: "stock" | "finance", reverse = false) {
  const { request } = execution(ctx), user = request.actor_id;
  const kind = b.route === "work" ? "service_orders" : "sales_orders";
  const postingKind = destination === "stock" ? "stock_posting" : "finance_posting";
  const posting = reverse ? state.effects.find(e => e.kind === postingKind) : undefined;
  if (reverse && !posting) return false;
  if (!reverse && destination === "stock" && !one(ctx.db, `SELECT 1 FROM erp_documents__item i JOIN erp_catalog__product p ON p.record_id=i.product_id
      WHERE i.document_id=? AND p.kind='P' LIMIT 1`, document)) return false;
  const command = internalCommand(request.command_id, `${reverse ? "reverse" : "post"}_${destination}`);
  const operation = destination === "stock" ? reverse ? "stock_reverse" : "stock_post" : reverse ? "title_cancel" : "title_create";
  return withOriginOperation(ctx, operation, [document], posting ? [posting.id] : [], inner => {
    if (posting) assertOwnEffect(inner, postingKind, posting.id);
    const args: RpcArgs = { p_user_id: user, p_kind: kind, p_document_id: document, p_expected_version: version(inner, "erp_documents__document", document) };
    const reason = b.reason_code ?? "module_execution";
    const day = new Date(execution(ctx).event.occurred_ms - 3 * 3600000).toISOString().slice(0, 10);
    let result: Data;
    if (destination === "stock") {
      Object.assign(args, { p_occurred_on: day, p_reason: reason });
      if (reverse) Object.assign(args, { p_posting_id: posting!.id, p_posting_version: version(inner, "erp_stock__document_posting", posting!.id) });
      const preview = (reverse ? erpDocumentStockReversePreview(inner, args) : erpDocumentStockPreview(inner, args)).preview;
      // Linhas livres/serviços não fabricam uma postagem vazia.
      if (!reverse && !preview.positions.length) return false;
      result = (reverse ? erpDocumentStockReverse : erpDocumentStockPost)(inner, { ...args, p_command_id: command,
        p_preview_hash: preview.preview_hash, p_ignored_item_ids: preview.ignored?.map(i => i.id) ?? [] });
    } else {
      if (!b.policy.revenue_category_id && !reverse) raise("22023", "module_category_required");
      Object.assign(args, { p_category_id: b.policy.revenue_category_id, p_plan: null });
      if (reverse) Object.assign(args, { p_posting_id: posting!.id, p_posting_version: version(inner, "erp_finance__document_posting", posting!.id) });
      const preview = (reverse ? erpDocumentFinanceReversePreview(inner, args) : erpDocumentFinancePreview(inner, args)).preview as Data;
      result = (reverse ? erpDocumentFinanceReverse : erpDocumentFinancePost)(inner, { ...args, p_command_id: command, p_preview_hash: preview.preview_hash,
        p_reason: reason, p_title_versions: preview.titles?.map((t: Data) => ({ id: t.id, version: t.version })) ?? [] });
    }
    if (!reverse) {
      effect(ctx, state, postingKind, result.posting.id, command, postingKind);
      if (destination === "finance") for (const title of result.titles as Data[])
        effect(ctx, state, "title", title.id, command, `title:${title.installment ?? title.position ?? state.effects.length}`);
    }
    return true;
  });
}
export function createModuleTitles(ctx: RpcContext, b: ModuleBody, state: ComponentState) {
  const { request } = execution(ctx), s = b.snapshot;
  if (!b.policy.revenue_category_id) raise("22023", "module_category_required");
  for (const [index, part] of s.installments.entries()) {
    const command = internalCommand(request.command_id, "title_create", part.key);
    const result = withOriginOperation(ctx, "title_create", [], [], inner => erpFinanceTitleExecute(inner, {
      p_user_id: request.actor_id, p_command_id: command, p_action: "title_create", p_data: {
        kind: "receivable", contact_id: s.contact_id, category_id: b.policy.revenue_category_id, description: s.description,
        issued_on: s.issued_on, competence_on: s.issued_on, total_cents: String(part.amount_cents),
        payment_method_id: part.payment_method_id ?? b.policy.payment_method_id,
        installments: [{ due_on: part.due_on, amount_cents: String(part.amount_cents) }],
      },
    })) as Data;
    for (const t of result.items as Data[]) effect(ctx, state, "title", t.id, command, `title:${index}`);
  }
  state.finance_posted = true;
}
export function settleModuleTitles(ctx: RpcContext, b: ModuleBody, state: ComponentState) {
  const { request } = execution(ctx), receipt = b.receipt;
  if (!receipt || b.operation !== "receive") raise("42501", "module_origin_denied");
  const key = receipt.receipt.receipt_key;
  if (state.effects.some(e => e.receipt_key === key)) return false;
  const account = b.policy.settlement_accounts[receipt.receipt.method];
  if (!account) raise("22023", "module_account_required");
  const titles = state.effects.filter(e => e.kind === "title").map(e => one(ctx.db, "SELECT * FROM erp_finance__title WHERE id=?", e.id)!)
    .filter(t => !t.cancelled).sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)) || String(a.id).localeCompare(String(b.id)));
  let remaining = receipt.amount_cents;
  for (const title of titles) {
    const amount = Math.min(remaining, Number(title.amount_cents) - Number(title.settled_cents));
    if (amount <= 0) continue;
    const id = String(title.id), command = internalCommand(request.command_id, "settle", id);
    const result = withOriginOperation(ctx, "title_settle", [id], [], inner => erpFinanceExecute(inner, {
      p_user_id: request.actor_id, p_command_id: command, p_action: "settle", p_data: { id, expected_version: title.version,
        account_id: account, posted_on: new Date(receipt.receipt.occurred_ms - 3 * 3600000).toISOString().slice(0, 10), principal_cents: String(amount) },
    })) as Data;
    effect(ctx, state, "settlement", result.settlement.id, command, `settlement:${key}:${id}`, key, amount);
    remaining -= amount;
  }
  if (remaining) raise("40001", "module_receipt_excess");
  return true;
}
export function reverseModuleSettlements(ctx: RpcContext, b: ModuleBody, state: ComponentState) {
  const { request } = execution(ctx), receipt = b.receipt;
  if (!receipt || b.operation !== "reverse") raise("42501", "module_origin_denied");
  const originals = state.effects.filter(e => e.kind === "settlement" && e.receipt_key === receipt.receipt.reverses_key);
  if (originals.reduce((n, e) => n + (e.amount_cents ?? 0), 0) !== receipt.amount_cents) raise("42501", "module_origin_denied");
  if (state.effects.some(e => e.receipt_key === receipt.receipt.receipt_key)) return false;
  for (const original of originals) {
    const s = one(ctx.db, "SELECT title_id FROM erp_finance__settlement WHERE id=?", original.id)!;
    const id = String(s.title_id), command = internalCommand(request.command_id, "reverse_settlement", original.id);
    const result = withOriginOperation(ctx, "settlement_reverse", [id], [original.id], inner => erpFinanceExecute(inner, {
      p_user_id: request.actor_id, p_command_id: command, p_action: "reverse", p_data: { id, expected_version: version(ctx, "erp_finance__title", id),
        settlement_id: original.id, posted_on: new Date(receipt.receipt.occurred_ms - 3 * 3600000).toISOString().slice(0, 10), note: b.reason_code ?? "module_reversal" },
    })) as Data;
    effect(ctx, state, "settlement", result.settlement.id, command, `reversal:${original.id}`, receipt.receipt.receipt_key, original.amount_cents);
  }
  return true;
}
export function cancelModuleTitles(ctx: RpcContext, b: ModuleBody, state: ComponentState) {
  const { request } = execution(ctx);
  for (const e of state.effects.filter(e => e.kind === "title")) {
    const title = one(ctx.db, "SELECT * FROM erp_finance__title WHERE id=?", e.id)!;
    if (title.cancelled) continue;
    if (systemScope(ctx) && e.actor !== request.actor_id) raise("42501", "module_origin_denied");
    withOriginOperation(ctx, "title_cancel", [e.id], [], inner => erpFinanceExecute(inner, {
      p_user_id: request.actor_id, p_command_id: internalCommand(request.command_id, "cancel", e.id), p_action: "title_cancel",
      p_data: { id: e.id, expected_version: title.version, note: b.reason_code ?? "module_cancellation" },
    }));
  }
}
