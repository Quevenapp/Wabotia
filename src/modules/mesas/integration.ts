import { all, one } from "../../db";
import type { Actor } from "../../types";
import type { ModuleContext } from "../api";
import { registerIntegrationProducer } from "../../integrations/registry";
import { aliasStatements } from "../../integrations/outbox";
import { ensureCommercialPolicy } from "../../integrations/policy";
import { commercialReceiptStatements } from "../../integrations/receipts";
import { IntegrationError } from "../../integrations/privacy";
import { hash } from "../../integrations/keys";
import { CommercePlan, allocateSale, commercialId, manualReceipt, netAllocated, orderOwner, projectOrder, receiptReplay, saleSnapshot, saleSource, savedSale, tabOrders, type CommercialReceipt, type CommercialSnapshot, type SourceRef } from "../pedido/public";

export function requireReceiptPerson(actor: Actor) {
  if (actor.kind !== "user" || actor.via || actor.credential) throw new IntegrationError("forbidden", 403);
}
export async function tableReceipt(ctx: ModuleContext, tabId: string, input: any, request: string, actor: Actor) {
  requireReceiptPerson(actor);
  const receipt = manualReceipt(saleSource(ctx.profile, "mesas", tabId), request, input.amount_cents, input.method, actor.id);
  receipt.evidence_hash = hash([receipt.evidence_hash, input.tendered_cents ?? null]);
  const previous = await receiptReplay(ctx.env, receipt);
  return { receipt: previous ?? receipt, repeated: !!previous };
}

async function members(ctx: ModuleContext, tab: string): Promise<string[]> {
  const rows = await all(ctx.env, `WITH RECURSIVE members(id) AS (SELECT id FROM mesas_tabs WHERE profile_id=? AND id=? UNION SELECT t.id FROM mesas_tabs t JOIN members m ON t.merged_into=m.id WHERE t.profile_id=?) SELECT id FROM members`, ctx.profile, tab, ctx.profile);
  return rows.map(r => r.id);
}

/** Revisão explícita da taxa; acréscimos são novos documentos de serviço.
 * Cancelamento e substituto compartilham a sequência e nunca ultrapassam
 * um comando anterior incerto. Reduzir componente pago exige correção humana. */
export async function serviceComponents(ctx: ModuleContext, tab: any, desired: number, plan: CommercePlan, priorAmount?: number): Promise<CommercialSnapshot[]> {
  const owners = await members(ctx, tab.id);
  const aliases = await all(ctx.env, "SELECT source_id,component FROM module_erp_aliases WHERE profile_id=? AND module_id='mesas' AND record_kind='service'", ctx.profile);
  let active: CommercialSnapshot[] = [];
  for (const alias of aliases.filter(a => owners.includes(a.source_id))) {
    const snapshot = await savedSale(ctx.env, saleSource(ctx.profile, "mesas", alias.source_id, alias.component));
    if (snapshot && snapshot.lifecycle.base_status !== "cancelled") active.push(snapshot);
  }
  const current = active.reduce((n, s) => n + s.total_cents, 0);
  if (current === desired) return active;
  let retained = current;
  if (desired < current) {
    const unpaid: CommercialSnapshot[] = [], paid: CommercialSnapshot[] = [];
    for (const snapshot of active) (await netAllocated(ctx.env, snapshot.source) ? paid : unpaid).push(snapshot);
    retained = paid.reduce((n, s) => n + s.total_cents, 0);
    if (desired < retained) throw new IntegrationError("service_paid_correction_required", 409);
    for (const snapshot of unpaid) await plan.add({ ...snapshot, lifecycle: { ...snapshot.lifecycle, base_status: "cancelled" } }, [{ operation: "cancel", stock: false, reason: "service_revised" }]);
    active = paid;
  }
  const amount = desired - retained;
  if (amount > 0) {
    const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
    let revision = aliases.filter(a => a.source_id === tab.id).length;
    const create = async (cents: number, at: number) => {
      if (!cents) return;
      const source = saleSource(ctx.profile, "mesas", tab.id, `service:${++revision}`);
      const snapshot = saleSnapshot(source, cents, at, [{ id: commercialId(source, "service"), description: "Taxa de serviço", quantity: "1", unit_cents: cents, unit: "UN", kind: "service", product_id: null }], policy.version);
      await plan.add(snapshot, [{ operation: "prepare", stock: false }, { operation: "execute", stock: false }]);
      plan.append(...aliasStatements(source, "service", `${tab.id}:${revision}`));
      active.push(snapshot);
    };
    const historical = !aliases.some(a => owners.includes(a.source_id));
    const prior = historical ? Math.min(amount, priorAmount ?? amount) : 0;
    await create(prior, tab.opened_at);
    await create(amount - prior, Math.max(plan.at, Date.now()));
  }
  return active;
}

export async function tablePaymentPlan(ctx: ModuleContext, tab: any, serviceCents: number, receipts: CommercialReceipt[], actor: string) {
  const plan = new CommercePlan(ctx, actor);
  const services = await serviceComponents(ctx, tab, serviceCents, plan);
  const obligations: { snapshot: CommercialSnapshot; balance: number; title: string }[] = [];
  for (const order of await tabOrders(ctx.env, ctx.profile, tab.id)) {
    if (order.status === "cancelled") continue;
    const source = await orderOwner(ctx.env, ctx.profile, order);
    // A ausência do DTO identifica origem histórica: não cria venda retroativa.
    const snapshot = await savedSale(ctx.env, source) ?? await projectOrder(ctx, order, source);
    obligations.push({ snapshot, balance: snapshot.total_cents - await netAllocated(ctx.env, source), title: await titleKey(ctx, source) });
  }
  for (const snapshot of services) obligations.push({ snapshot, balance: snapshot.total_cents - await netAllocated(ctx.env, snapshot.source), title: await titleKey(ctx, snapshot.source) });
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
      const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
      await plan.add(saleSnapshot(saleSource(ctx.profile, "mesas", tab.id), 0, plan.at, [], policy.version));
    }
  }
  return plan;
}
async function titleKey(ctx: ModuleContext, source: SourceRef) {
  const row = await one(ctx.env, `SELECT j.value ->> '$.id' id FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id, json_each(d.receipt_json,'$.links') j WHERE e.profile_id=? AND e.module_id=? AND e.source_id=? AND json_extract(e.payload_json,'$.source.component')=? AND j.value ->> '$.kind'='title' ORDER BY e.seq DESC,j.value ->> '$.id' LIMIT 1`, source.profile, source.module, source.source_id, source.component);
  // Antes da resposta ERP só existe a identidade imutável do componente.
  return row?.id ?? commercialId(source, "title");
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
    const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
    await plan.add(saleSnapshot(saleSource(ctx.profile, "mesas", tab.id), 0, tab.opened_at, [], policy.version));
  }
}
