import type { CommercialSnapshot, CommercialPolicy, IntegrationOperation } from "../../../integrations/contracts.ts";
import { canonical, hash } from "../../../integrations/keys.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise, ErpError } from "../../engine/errors.ts";
import type { RpcArgs, RpcContext } from "../../engine/registry.ts";
import { execution, originAnchor, originScope, targetOrigin, requireOriginOperation, previousReceipt, driverContext, type ComponentState } from "../../engine/module-origin.ts";

export interface ModuleBody {
  operation: IntegrationOperation; route: "work" | "sale" | "title"; snapshot: CommercialSnapshot; policy: CommercialPolicy;
  requested: { document: boolean; stock: boolean; finance: boolean }; reason_code: string | null;
  receipt: { receipt: { receipt_key: string; kind: string; reverses_key: string | null; method: keyof CommercialPolicy["settlement_accounts"]; occurred_ms: number }; amount_cents: number } | null;
}
const own = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const invalid = (): never => raise("22023", "module_commercial_invalid");
export const money = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const WORK: Record<string, string> = { received: "open", analyzing: "open", quoted: "quoted", approved: "approved", declined: "rejected", in_progress: "in_progress", ready: "service_done", delivered: "finalized", cancelled: "cancelled" };
const WORK_NEXT: Record<string, string[]> = {
  received: ["analyzing", "quoted", "in_progress", "cancelled"], analyzing: ["quoted", "in_progress", "cancelled"],
  quoted: ["analyzing", "approved", "declined", "cancelled"], approved: ["in_progress", "cancelled"],
  declined: ["analyzing", "quoted", "ready", "cancelled"], in_progress: ["ready", "cancelled"],
  ready: ["delivered", "in_progress", "cancelled"], delivered: [], cancelled: [],
};
function keys(value: unknown, allowed: string[]) {
  if (!own(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid();
}
export const moduleStatus = (b: ModuleBody, current?: string) => b.route === "work" ? WORK[b.snapshot.lifecycle.base_status] :
  b.operation === "cancel" ? "cancelled" : b.operation === "execute" ? "in_progress" : current ?? "open";
export function validateModuleBody(ctx: RpcContext): ModuleBody {
  const { request: r, event } = execution(ctx), b = structuredClone(r.body) as unknown as ModuleBody, s = b.snapshot;
  if (Object.keys(r.body).some(k => !["operation", "route", "snapshot", "policy", "eligible", "requested", "epochs", "occurred_ms", "receipt", "reason_code", "mode"].includes(k))) invalid();
  keys(s, ["schema", "source", "source_revision", "contact_id", "customer_ref", "privacy", "description", "issued_on", "items", "total_cents", "freight_cents", "discount_cents", "installments", "policy_version", "lifecycle", "technical"]);
  keys(s.lifecycle, ["base_status", "stage_id", "quote_version", "authorization", "authorized_at", "first_execution_at", "delivered_at", "warranty_until"]);
  if (s.technical !== null) keys(s.technical, ["equipment", "serial_number", "technician", "defect", "solution"]);
  const route = r.source.module === "os" ? "work" : ["pedido", "mesas", "entrega"].includes(r.source.module) ? "sale" : "title";
  if (b.route !== route || !["prepare", "recognize", "execute", "lifecycle", "receive", "cancel", "reverse"].includes(b.operation) ||
      route === "title" && ["prepare", "execute", "lifecycle"].includes(b.operation) || route !== "title" && b.operation === "recognize" ||
      !own(s) || s.schema !== 1 || !same(s.source, r.source) || !same(s.source, event.snapshot.source) || s.source_revision !== event.source_revision ||
      !own(b.policy) || b.policy.profile !== r.source.profile || !own(b.requested) ||
      Object.keys(b.requested).sort().join() !== "document,finance,stock" || Object.values(b.requested).some(v => typeof v !== "boolean") ||
      !own(s.lifecycle) || !Array.isArray(s.items) || !Array.isArray(s.installments) || !["commercial", "adult_payer_only"].includes(s.privacy)) invalid();
  // A preparação só pode promover o cliente e, sem Produtos, tornar livres as linhas.
  const projected = { ...s, contact_id: event.snapshot.contact_id, items: s.items.map((item, i) => {
    const original = event.snapshot.items[i];
    if (!original || !same(item, original) && !(item.product_id === null && item.kind === "free" && same({ ...item, kind: original.kind, product_id: original.product_id }, original))) invalid();
    return original;
  }) };
  if (!same(projected, event.snapshot)) invalid();
  const previous = previousReceipt(ctx)?.components[r.source.component];
  const document = originAnchor(ctx.db, r.source, "document");
  const linked = document ? one(ctx.db, "SELECT contact_id,warehouse_id FROM erp_documents__document WHERE id=?", document.target.id) : null;
  const titles = (previous?.effects ?? []).filter(e => e.kind === "title").map(e => {
    if (!same(targetOrigin(ctx.db, "title", e.id)?.source, r.source)) raise("42501", "module_origin_denied");
    return one(ctx.db, "SELECT contact_id,category_id,payment_method_id FROM erp_finance__title WHERE id=?", e.id);
  });
  if (["cancel", "reverse", "lifecycle", "receive"].includes(b.operation) && previous) {
    const contact = linked?.contact_id ?? titles[0]?.contact_id;
    if (!contact || titles.some(t => t?.contact_id !== contact) || s.contact_id !== null && s.contact_id !== contact) invalid();
    s.contact_id = String(contact);
  }
  // Padrões pertencem ao componente criado, não à política vigente. Recibos
  // anteriores a esta guarda recuperam os parâmetros que existem nas linhas.
  if (previous) b.policy = { ...b.policy,
    warehouse_id: previous.parameters ? previous.parameters.warehouse_id : linked ? linked.warehouse_id as string | null : b.policy.warehouse_id,
    // Financeiro ainda não lançado pode receber seus primeiros padrões válidos.
    ...(previous.finance_posted ? {
      revenue_category_id: previous.parameters ? previous.parameters.revenue_category_id : titles[0]?.category_id as string | null,
      payment_method_id: previous.parameters ? previous.parameters.payment_method_id : titles[0]?.payment_method_id as string | null,
    } : {}),
  };
  if (!s.contact_id || !/^[0-9a-f-]{36}$/.test(s.contact_id) ||
      s.privacy === "adult_payer_only" && (s.technical !== null || s.description !== "Serviço contratado" || s.items.some(i => i.description !== "Serviço contratado"))) invalid();
  for (const value of [s.total_cents, s.freight_cents, s.discount_cents, ...s.items.map(i => i.unit_cents), ...s.installments.map(i => i.amount_cents)])
    if (!Number.isSafeInteger(value) || value < 0) invalid();
  let total = 0n;
  const ids = new Set<string>();
  for (const item of s.items) {
    keys(item, ["id", "description", "quantity", "unit_cents", "unit", "kind", "product_id"]);
    if (!/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(item.quantity) || !item.description || !item.unit) invalid();
    ids.add(item.id);
    if (!["material", "service", "free"].includes(item.kind) || item.kind === "free" && item.product_id !== null) invalid();
    if (ctx.parts.products && item.product_id && !previous?.stock_posted && !previous?.finance_posted && ["prepare", "execute"].includes(b.operation)) {
      const product = one(ctx.db, "SELECT p.kind,p.unit,r.active FROM erp_catalog__product p JOIN erp_catalog__record r ON r.id=p.record_id WHERE p.record_id=?", item.product_id);
      if (!product || !product.active || product.kind !== (item.kind === "material" ? "P" : "S") || product.unit !== item.unit) raise("22023", "module_product_incompatible");
    }
    const [integer, fraction = ""] = item.quantity.split(".");
    const q = BigInt(integer) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    if (q <= 0n) invalid();
    total += (q * BigInt(item.unit_cents) + 500000n) / 1000000n;
  }
  if (route !== "title" && total + BigInt(s.freight_cents) - BigInt(s.discount_cents) !== BigInt(s.total_cents)) raise("22023", "module_total_mismatch");
  if (s.installments.reduce((sum, i) => sum + BigInt(i.amount_cents), 0n) !== BigInt(s.total_cents)) raise("22023", "module_installments_mismatch");
  const installments = new Set<string>();
  for (const part of s.installments) {
    keys(part, ["key", "due_on", "amount_cents", "payment_method_id"]);
    if (!part.key || installments.has(part.key)) invalid(); installments.add(part.key);
  }
  if (previous && b.route === "work" && previous.base_status !== s.lifecycle.base_status &&
      !WORK_NEXT[previous.base_status]?.includes(s.lifecycle.base_status)) raise("40001", "module_transition_invalid");
  if (previous && s.source_revision < previous.source_revision) raise("40001", "module_revision_conflict");
  const manual = execution(ctx).evidence.mode === "human";
  if ((b.operation === "execute" || manual && b.operation === "lifecycle") && b.route === "work" &&
      (!moduleStatus(b) || !(manual ? ["in_progress", "ready", "delivered"] : ["in_progress"]).includes(s.lifecycle.base_status) || !s.lifecycle.first_execution_at || !s.lifecycle.authorized_at ||
       !["approved_quote", "fixed_price"].includes(s.lifecycle.authorization ?? "") ||
       s.lifecycle.authorization === "approved_quote" && !s.lifecycle.quote_version || s.lifecycle.authorized_at > s.lifecycle.first_execution_at))
    raise("22023", "module_authorization_required");
  if ((b.operation === "cancel" || previous?.base_status === "ready" && s.lifecycle.base_status === "in_progress" ||
      previous?.base_status === "declined" && s.lifecycle.base_status === "quoted") && !b.reason_code) raise("22023", "module_reason_required");
  if (b.reason_code !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(b.reason_code)) invalid();
  if ((previous?.delivered_at || previous?.base_status === "delivered") && (s.lifecycle.delivered_at !== previous.delivered_at || s.lifecycle.base_status !== "delivered" && b.operation !== "receive" && b.operation !== "reverse"))
    raise("40001", "module_delivered_locked");
  if (previous?.first_execution_at && s.lifecycle.first_execution_at !== previous.first_execution_at) raise("40001", "module_execution_locked");
  if (b.operation === "lifecycle" && !moduleStatus(b)) invalid();
  return b;
}
export function commercialHash(b: ModuleBody): string {
  const s = b.snapshot;
  return hash({ contact_id: s.contact_id, items: s.items, total: s.total_cents, freight: s.freight_cents, discount: s.discount_cents,
    installments: s.installments, issued_on: s.issued_on, ...(b.route !== "title" ? { warehouse: b.policy.warehouse_id } : {}), description: s.description, technical: s.technical });
}
export function nextComponent(b: ModuleBody, previous?: ComponentState): ComponentState {
  const lifecycle = b.snapshot.lifecycle;
  const priorHash = previous && (previous.parameters ? previous.commercial_hash : commercialHash({ ...b, snapshot: previous.snapshot }));
  if (previous && (previous.stock_posted || previous.finance_posted) && priorHash !== commercialHash(b)) raise("40001", "module_commercial_frozen");
  const { warehouse_id, revenue_category_id, payment_method_id } = b.policy;
  return { snapshot: b.snapshot, parameters: { warehouse_id: b.route === "title" ? null : warehouse_id, revenue_category_id, payment_method_id },
    executed: previous?.executed ?? false, commercial_hash: commercialHash(b), first_execution_at: previous?.first_execution_at ?? lifecycle.first_execution_at,
    delivered_at: previous?.delivered_at ?? lifecycle.delivered_at, warranty_until: lifecycle.warranty_until,
    stock_posted: previous?.stock_posted ?? false, finance_posted: previous?.finance_posted ?? false,
    effects: previous?.effects.map(e => ({ ...e })) ?? [], base_status: lifecycle.base_status, source_revision: b.snapshot.source_revision };
}
export function requestedDestinations(ctx: RpcContext, b: ModuleBody) {
  const proof = execution(ctx), maintenance = ["cancel", "reverse"].includes(b.operation), linkedLifecycle = b.operation === "lifecycle" && !!originAnchor(ctx.db, proof.request.source, "document"), linkedReceive = b.operation === "receive" && !!previousReceipt(ctx)?.components[proof.request.source.component]?.effects.some(e => e.kind === "title"), human = proof.evidence.mode === "human";
  const requested = {
    document: b.requested.document && (maintenance || linkedLifecycle || proof.open.document) && (ctx.parts.sales || ctx.parts.finance || ctx.parts.stock),
    stock: b.requested.stock && (maintenance || proof.open.stock && ctx.parts.stock && ctx.parts.products && (human || b.policy.auto_post?.stock === true)),
    finance: b.requested.finance && (maintenance || (proof.open.finance || linkedReceive) && ctx.parts.finance && (human || b.policy.auto_post?.finance === true)),
  };
  if (!maintenance && !requested.document && !requested.stock && !requested.finance) throw new ErpError("epoch_closed", "epoch_closed");
  return requested;
}
export function moduleDocumentBody(ctx: RpcContext, b: ModuleBody) {
  const s = b.snapshot;
  return { date: s.issued_on, contact_id: s.contact_id, warehouse_id: ctx.parts.stock ? b.policy.warehouse_id : null,
    category_id: ctx.parts.finance ? b.policy.revenue_category_id : null,
    freight: money(s.freight_cents), discount_mode: "amount", discount_value: money(s.discount_cents),
    items: s.items.map(i => ({ id: i.id, description: i.description, unit: i.unit, quantity: i.quantity, unit_price: money(i.unit_cents),
      product_id: ctx.parts.products ? i.product_id : null,
      ...(b.route === "work" ? { group: i.kind === "material" ? "part" : "service", quote: false, done: false } : {}) })),
    installments: s.installments.map(i => ({ amount: money(i.amount_cents), due_date: i.due_on, payment_method_id: i.payment_method_id })),
    ...(b.route === "work" && s.technical ? { equipment: s.technical.equipment, serial_number: s.technical.serial_number,
      technician: s.technical.technician, defect: s.technical.defect, solution: s.technical.solution } : {}),
  };
}
export function linkedDocumentGuard(db: SqlDriver, id: unknown, ctx?: RpcContext): void {
  if (typeof id !== "string" || !targetOrigin(db, "document", id)) return;
  const scope = ctx && originScope(ctx);
  if (!scope) raise("42501", "module_document_read_only");
  requireOriginOperation(ctx!, scope.operation, id);
}
/** Uma nota vinculada não cria uma segunda autoridade sobre os efeitos da venda. */
export function linkedInvoiceDocumentsGuard(db: SqlDriver, invoice: unknown): void {
  if (typeof invoice !== "string") return;
  for (const row of db.exec("SELECT document_id FROM erp_fiscal_invoices__invoice_order WHERE invoice_id=?", invoice.toLowerCase()).rows)
    linkedDocumentGuard(db, row.document_id);
}
/** Inclui efeitos históricos que o executor não pode adotar nem estornar. */
export function moduleCancellationBlocked(db: SqlDriver, document: string): boolean {
  return !!one(db, `SELECT 1 FROM erp_stock__document_posting WHERE document_id=? AND state='active'
    UNION ALL SELECT 1 FROM erp_finance__document_posting WHERE document_id=? AND state='active'
    UNION ALL SELECT 1 FROM erp_finance__grouped_billing_document WHERE document_id=? AND active=1
    UNION ALL SELECT 1 FROM erp_stock__reservation WHERE document_id=? AND state='active'
    UNION ALL SELECT 1 FROM erp_fiscal_invoices__invoice_order o WHERE o.document_id=? AND (
      EXISTS(SELECT 1 FROM erp_finance__invoice_posting p WHERE p.invoice_id=o.invoice_id AND p.state='active') OR
      EXISTS(SELECT 1 FROM erp_stock__invoice_posting p WHERE p.invoice_id=o.invoice_id AND p.state='active') OR
      EXISTS(SELECT 1 FROM erp_finance__grouped_billing_invoice g WHERE g.invoice_id=o.invoice_id AND g.active=1)) LIMIT 1`,
    document, document, document, document, document);
}
export function operationalChangeAllowed(ctx: RpcContext | undefined, o: Record<string, unknown>, n: Record<string, unknown>): boolean {
  if (!ctx || !originScope(ctx) || !targetOrigin(ctx.db, "document", String(o.id))) return false;
  requireOriginOperation(ctx, originScope(ctx)!.operation, String(o.id));
  const keys = ["status", "version", "updated_at", "updated_by"];
  if (!same(Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))), Object.fromEntries(Object.entries(n).filter(([k]) => !keys.includes(k))))) return false;
  if (o.status === n.status) return true;
  if (originScope(ctx)!.operation !== "document_transition") return false;
  const b = execution(ctx).request.body as unknown as ModuleBody;
  if (n.status === "cancelled" && moduleCancellationBlocked(ctx.db, String(o.id))) return false;
  return n.status === moduleStatus(b, String(o.status));
}
export function guardModuleRow(ctx: RpcContext, old: Record<string, unknown> | null, row: Record<string, unknown>) {
  if (!old) {
    const scope = originScope(ctx);
    if (scope) {
      const b = execution(ctx).request.body as unknown as ModuleBody;
      if (scope.operation !== "document_prepare" || scope.target_ids.size || b.route === "title" ||
          row.kind !== (b.route === "work" ? "service_orders" : "sales_orders") || row.authority !== "brufap") raise("42501", "module_origin_denied");
    }
    return;
  }
  const anchor = targetOrigin(ctx.db, "document", String(old.id));
  if (!anchor) return;
  linkedDocumentGuard(ctx.db, old.id, ctx);
  const active = one(ctx.db, "SELECT 1 FROM erp_stock__document_posting WHERE document_id=? AND state='active' UNION ALL SELECT 1 FROM erp_finance__document_posting WHERE document_id=? AND state='active'", old.id, old.id);
  if ((active || originScope(ctx)?.operation !== "document_prepare") && !operationalChangeAllowed(ctx, old, row)) raise("40001", "module_commercial_frozen");
}
export function guardModuleItem(ctx: RpcContext, document: string) {
  if (!targetOrigin(ctx.db, "document", document)) return;
  linkedDocumentGuard(ctx.db, document, ctx);
  if (originScope(ctx)?.operation !== "document_prepare" || one(ctx.db, "SELECT 1 FROM erp_stock__document_posting WHERE document_id=? UNION ALL SELECT 1 FROM erp_finance__document_posting WHERE document_id=?", document, document))
    raise("40001", "module_commercial_frozen");
}
/** Defesa comum para RPCs laterais que escrevem diretamente no diário/metadado. */
export function guardModuleRpc(ctx: RpcContext, name: string, a: RpcArgs) {
  if (originScope(ctx)) return;
  if (ctx.workEnabled && (name === "erp_proposal_convert_to_service" || name === "erp_sales_order_convert_to_service" ||
      a.p_kind === "service_orders" && ["erp_document_save", "erp_document_copy"].includes(name) && a.p_id == null))
    raise("work_required", "Crie o trabalho para gerar sua parte comercial.");
  if (/(?:save|transition|trash|copy|convert|append|remove|post|reverse|occurrence_add|change)$/.test(name) &&
      /(?:document|service_journal|proposal_convert|sales_order_convert)/.test(name))
    for (const id of [a.p_id, a.p_document_id, a.p_source_id, a.p_source_document_id]) linkedDocumentGuard(ctx.db, id);
}
export function scopeDocumentAccess(db: SqlDriver, user: string | null, kind: string | null): boolean {
  const ctx = driverContext(db);
  if (!ctx) return false;
  const b = execution(ctx).request.body as unknown as ModuleBody;
  if (user !== ctx.identity.actor?.user_id || kind !== (b.route === "work" ? "service_orders" : "sales_orders")) raise("42501", "module_origin_denied");
  return true;
}
