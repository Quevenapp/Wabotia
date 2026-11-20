import { all, one } from "../../db";
import type { Actor } from "../../types";
import { requireFinancialAal } from "../../mfa";
import type { ModuleContext } from "../api";
import { registerIntegrationProducer } from "../../integrations/registry";
import { aliasStatements } from "../../integrations/outbox";
import { commercialReceiptStatements } from "../../integrations/receipts";
import { IntegrationError } from "../../integrations/privacy";
import { hash } from "../../integrations/keys";
import { billTotals } from "./model";
import { CommercePlan, allocateSale, commercialId, manualReceipt, projectOrder, receiptReplay, saleSnapshot, saleSource, savedSale, tabOrders, type CommercialReceipt, type CommercialSnapshot, type SourceRef } from "../pedido/public";

export function requireReceiptPerson(actor: Actor) {
  if (actor.kind !== "user" || actor.via || actor.credential) throw new IntegrationError("forbidden", 403);
  requireFinancialAal(actor);
}
export function tableReceiptData(ctx: ModuleContext, tabId: string, input: any, request: string, actor: Actor) {
  requireReceiptPerson(actor);
  const receipt = manualReceipt(saleSource(ctx.profile, "mesas", tabId), request, input.amount_cents, input.method, actor.id);
  receipt.evidence_hash = hash([receipt.evidence_hash, input.tendered_cents ?? null]);
  return receipt;
}
export async function tableReceipt(ctx: ModuleContext, tabId: string, input: any, request: string, actor: Actor) {
  const receipt = tableReceiptData(ctx, tabId, input, request, actor);
  const previous = await receiptReplay(ctx.env, receipt);
  return { receipt: previous ?? receipt, repeated: !!previous };
}

/** Revisão explícita da taxa; acréscimos são novos documentos de serviço.
 * Cancelamento e substituto compartilham a sequência e nunca ultrapassam
 * um comando anterior incerto. Reduzir componente pago exige correção humana. */
export async function serviceComponents(ctx: ModuleContext, tab: any, desired: number, plan: CommercePlan, priorAmount?: number, additionalSources: SourceRef[] = [], knownAliases?: any[]): Promise<CommercialSnapshot[]> {
  const aliases = knownAliases ?? await all(ctx.env, `WITH RECURSIVE members(id) AS (
    SELECT id FROM mesas_tabs WHERE profile_id=? AND id=? UNION SELECT t.id FROM mesas_tabs t JOIN members m ON t.merged_into=m.id WHERE t.profile_id=?
  ) SELECT source_id,component FROM module_erp_aliases WHERE profile_id=? AND module_id='mesas' AND record_kind='service' AND source_id IN (SELECT id FROM members)`, ctx.profile, tab.id, ctx.profile, ctx.profile);
  await plan.inspectMany([...additionalSources, ...aliases.map(alias => saleSource(ctx.profile, "mesas", alias.source_id, alias.component))]);
  let active: CommercialSnapshot[] = [];
  for (const alias of aliases) {
    const snapshot = (await plan.inspect(saleSource(ctx.profile, "mesas", alias.source_id, alias.component))).snapshot;
    if (snapshot && snapshot.lifecycle.base_status !== "cancelled") active.push(snapshot);
  }
  const current = active.reduce((n, s) => n + s.total_cents, 0);
  if (current === desired) return active;
  let retained = current;
  if (desired < current) {
    const unpaid: CommercialSnapshot[] = [], paid: CommercialSnapshot[] = [];
    for (const snapshot of active) ((await plan.inspect(snapshot.source)).allocated ? paid : unpaid).push(snapshot);
    retained = paid.reduce((n, s) => n + s.total_cents, 0);
    if (desired < retained) throw new IntegrationError("service_paid_correction_required", 409);
    for (const snapshot of unpaid) await plan.add({ ...snapshot, lifecycle: { ...snapshot.lifecycle, base_status: "cancelled" } }, [{ operation: "cancel", stock: false, reason: "service_revised" }]);
    active = paid;
  }
  const amount = desired - retained;
  if (amount > 0) {
    const policy = await plan.policy();
    let revision = aliases.filter(a => a.source_id === tab.id).length;
    const create = async (cents: number, at: number) => {
      if (!cents) return;
      const source = saleSource(ctx.profile, "mesas", tab.id, `service:${++revision}`);
      const snapshot = saleSnapshot(source, cents, at, [{ id: commercialId(source, "service"), description: "Taxa de serviço", quantity: "1", unit_cents: cents, unit: "UN", kind: "service", product_id: null }], policy.version);
      await plan.add(snapshot, [{ operation: "prepare", stock: false }, { operation: "execute", stock: false }]);
      plan.append(...aliasStatements(source, "service", `${tab.id}:${revision}`));
      active.push(snapshot);
    };
    const historical = !aliases.length;
    const prior = historical ? Math.min(amount, priorAmount ?? amount) : 0;
    await create(prior, tab.opened_at);
    await create(amount - prior, Math.max(plan.at, Date.now()));
  }
  return active;
}

export async function tablePaymentPlan(ctx: ModuleContext, tab: any, serviceCents: number, receipts: CommercialReceipt[], actor: string, orders?: Awaited<ReturnType<typeof tabOrders>>) {
  const plan = new CommercePlan(ctx, actor);
  const obligations: { snapshot: CommercialSnapshot; balance: number; title: string }[] = [];
  const currentOrders = orders ?? await tabOrders(ctx.env, ctx.profile, tab.id);
  const aliases = await all(ctx.env, `WITH RECURSIVE members(id) AS (
    SELECT id FROM mesas_tabs WHERE profile_id=? AND id=? UNION SELECT t.id FROM mesas_tabs t JOIN members m ON t.merged_into=m.id WHERE t.profile_id=?
  ) SELECT module_id,record_kind,record_id,source_id,component FROM module_erp_aliases WHERE profile_id=? AND
    ((module_id='mesas' AND record_kind='service' AND source_id IN (SELECT id FROM members)) OR
     (module_id IN ('mesas','pedido') AND record_kind='order' AND record_id IN (SELECT value FROM json_each(?))))`,
    ctx.profile, tab.id, ctx.profile, ctx.profile, JSON.stringify(currentOrders.map(order => order.id)));
  const sources = currentOrders.map(order => {
    const alias = aliases.find(a => a.record_kind === "order" && a.record_id === order.id);
    return alias ? saleSource(ctx.profile, alias.module_id, alias.source_id, alias.component)
      : saleSource(ctx.profile, "mesas", order.table!.tab_id, `order:${order.id}`);
  });
  const services = await serviceComponents(ctx, tab, serviceCents, plan, undefined, sources, aliases.filter(a => a.record_kind === "service"));
  for (const [index, order] of currentOrders.entries()) {
    if (order.status === "cancelled") continue;
    const source = sources[index];
    // A ausência do DTO identifica origem histórica: não cria venda retroativa.
    const state = await plan.inspect(source);
    const snapshot = state.snapshot ?? await projectOrder(ctx, order, source, plan);
    obligations.push({ snapshot, balance: snapshot.total_cents - state.allocated, title: state.title ?? commercialId(source, "title") });
  }
  for (const snapshot of services) {
    const state = await plan.inspect(snapshot.source);
    obligations.push({ snapshot, balance: snapshot.total_cents - state.allocated, title: state.title ?? commercialId(snapshot.source, "title") });
  }
  obligations.sort((a, b) => (a.snapshot.installments[0]?.due_on ?? a.snapshot.issued_on).localeCompare(b.snapshot.installments[0]?.due_on ?? b.snapshot.issued_on) || a.title.localeCompare(b.title));
  for (const receipt of receipts) {
    plan.append(...commercialReceiptStatements(receipt));
    let left = receipt.amount_cents, ordinal = 0;
    for (const obligation of obligations) {
      const amount = Math.min(left, Math.max(0, obligation.balance));
      if (!amount) continue;
      await allocateSale(plan, obligation.snapshot, receipt, amount, ordinal++);
      obligation.balance -= amount; left -= amount;
    }
    // Excedente não vira receita; recibo conserva a evidência e o restante.
    if (left && !obligations.length) {
      const policy = await plan.policy();
      await plan.add(saleSnapshot(saleSource(ctx.profile, "mesas", tab.id), 0, plan.at, [], policy.version));
    }
  }
  return plan;
}
export async function authorizeTableSource(ctx: ModuleContext, actor: Actor, source: SourceRef, write: boolean) {
  if (source.profile !== ctx.profile || source.module !== "mesas") throw new IntegrationError("not_found", 404);
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  if (write && actor.kind === "user" && actor.role !== "admin" && !await ctx.granted(actor, "waiter")) throw new IntegrationError("forbidden", 403);
  if (!await one(ctx.env, "SELECT id FROM mesas_tabs WHERE id=? AND profile_id=?", source.source_id, ctx.profile)) throw new IntegrationError("not_found", 404);
}
registerIntegrationProducer({ module: "mesas", authorizeSource: authorizeTableSource, async project(ctx, source) {
  if (source.profile !== ctx.profile) throw new IntegrationError("not_found", 404);
  const snapshot = await savedSale(ctx.env, source);
  if (snapshot) return snapshot;
  throw new IntegrationError("historical_origin_unlinked");
} });

/** União e transferência preservam aliases e têm CAS independente do relógio. */
export async function touchTableOrigin(ctx: ModuleContext, tab: any, plan: CommercePlan) {
  const row = await one(ctx.env, "SELECT state_json FROM module_erp_sources WHERE profile_id=? AND module_id='mesas' AND source_id=?", ctx.profile, tab.id);
  const snapshot = row ? JSON.parse(row.state_json).snapshot as CommercialSnapshot | undefined : undefined;
  if (snapshot) await plan.add(snapshot);
  else {
    const policy = await plan.policy();
    await plan.add(saleSnapshot(saleSource(ctx.profile, "mesas", tab.id), 0, tab.opened_at, [], policy.version));
  }
}

/** O cancelamento do pedido e a taxa correspondente usam o mesmo plano/lote. */
export async function cancelledOrderService(ctx: ModuleContext, order: any, plan: CommercePlan) {
  const tab = await one(ctx.env, "SELECT * FROM mesas_tabs WHERE profile_id=? AND id=?", ctx.profile, order.tab_id);
  if (!tab || !["open", "closing"].includes(tab.status)) return;
  const orders = await tabOrders(ctx.env, ctx.profile, tab.id);
  const subtotal = orders.filter(o => o.id !== order.id && o.status !== "cancelled").reduce((sum, o) => sum + o.total_cents, 0);
  const desired = billTotals(subtotal, !!tab.service, tab.service_permille, 0).service_cents;
  await serviceComponents(ctx, tab, desired, plan);
  plan.append(["UPDATE mesas_tabs SET updated=? WHERE profile_id=? AND id=? AND updated=? AND status=?", [plan.at, ctx.profile, tab.id, tab.updated, tab.status]],
    ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('integration_version_conflict') END", []]);
}
