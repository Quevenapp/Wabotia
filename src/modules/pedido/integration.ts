// Projeções comerciais: somente D1. Nenhum caminho de atendimento chama o ERP.
import { Buffer } from "node:buffer";
import { optionalCommercialPaymentEvidence, commercialReceiptFromEvidence, pendingPaymentStatements, resolvedPaymentStatements, paymentPendingEventKey } from "../../payments-commercial-evidence";
import { all, batch, one } from "../../db";
import type { Actor, Env } from "../../types";
import type { ModuleContext } from "../api";
import type { CommercialItem, CommercialSnapshot, IntegrationEvent, IntegrationModule, IntegrationOperation, SourceRef, Statement } from "../../integrations/contracts";
import { aliasStatements, integrationStatements, integrationCasGuard } from "../../integrations/outbox";
import { readIntegrationActivation, eventEpochOpen } from "../../integrations/activation";
import { ensureCommercialPolicy } from "../../integrations/policy";
import { canonical, commandId, eventKey, F3_NAMESPACES, hash, uuid5, localEventId } from "../../integrations/keys";
import { IntegrationError, integer, validateSnapshot } from "../../integrations/privacy";
import { registerIntegrationProducer } from "../../integrations/registry";
import { allocationKey, allocationStatements, commercialReceiptStatements, registerReceiptReverser, manualReceiptKey, providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../../integrations/receipts";

export { integrationCasGuard as commerceGuard };
export type { CommercialSnapshot, SourceRef, Statement, CommercialReceipt };
export const saleSource = (profile: string, module: IntegrationModule, id: string, component = "main"): SourceRef => ({ profile, module, source_id: id, component });
export const commercialDate = (ms: number) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
export const commercialId = (...parts: unknown[]) => uuid5(F3_NAMESPACES.internal, canonical(["commerce", ...parts]));
const snapshotScope = (s: SourceRef) => `f3-sale:${hash(s)}`;

/** O recibo local conserva o DTO por componente inclusive com ERP desligado.
 * state_json da base só admite uma fotografia; Mesas tem vários componentes.
 * Não contém notas, endereços, nomes de clientes nem dados do provedor. */
export async function savedSale(env: Env, source: SourceRef): Promise<CommercialSnapshot | null> {
  const row = await one(env, "SELECT response FROM receipts WHERE scope=? ORDER BY CAST(key AS INTEGER) DESC LIMIT 1", snapshotScope(source));
  return row ? JSON.parse(row.response) : null;
}
export async function orderOwner(env: Env, profile: string, row: any): Promise<SourceRef> {
  const alias = await one(env, "SELECT module_id,source_id,component FROM module_erp_aliases WHERE profile_id=? AND record_kind='order' AND record_id=? AND module_id IN ('pedido','mesas')", profile, row.id);
  if (alias) return saleSource(profile, alias.module_id, alias.source_id, alias.component);
  return (row.tab_id ?? row.table?.tab_id) ? saleSource(profile, "mesas", row.tab_id ?? row.table.tab_id, `order:${row.id}`) : saleSource(profile, "pedido", row.id);
}

export function saleSnapshot(source: SourceRef, amount: number, at: number, items: CommercialItem[], policyVersion: number): CommercialSnapshot {
  return {
    schema: 1, source, source_revision: 1, customer_ref: null, contact_id: null,
    privacy: "commercial", description: source.module === "entrega" ? "Serviço de entrega" : source.component.startsWith("service:") ? "Taxa de serviço" : "Venda do pedido",
    issued_on: commercialDate(at), items, total_cents: integer(amount), freight_cents: 0, discount_cents: 0,
    installments: amount ? [{ key: "main", due_on: commercialDate(at), amount_cents: amount, payment_method_id: null }] : [],
    policy_version: policyVersion, lifecycle: { base_status: "received", stage_id: null, quote_version: null, authorization: "fixed_price", authorized_at: at, first_execution_at: at, delivered_at: null, warranty_until: null }, technical: null,
  };
}

export async function projectOrder(ctx: ModuleContext, row: any, source: SourceRef, plan = new CommercePlan(ctx, null)): Promise<CommercialSnapshot> {
  const saved = (await plan.inspect(source)).snapshot;
  if (saved) return { ...saved, lifecycle: { ...saved.lifecycle, base_status: row.status, delivered_at: row.delivered_at ?? saved.lifecycle.delivered_at } };
  const activation = await plan.activation(source.module);
  const policy = await plan.policy();
  const links = activation.snapshot.parts.products ? await all(ctx.env,
    "SELECT record_kind,record_id,component,erp_item_id FROM module_erp_catalog_links WHERE profile_id=? AND module_id='pedido'", ctx.profile) : [];
  const linked = (kind: string, id: string, component = "") => links.find(l => l.record_kind === kind && l.record_id === id && l.component === component)?.erp_item_id ?? null;
  const lines = typeof row.lines === "string" ? JSON.parse(row.lines) : row.lines;
  const items: CommercialItem[] = [];
  for (const line of lines) {
    const options = line.options ?? [];
    const base = integer(line.unit_cents - options.reduce((n: number, o: any) => n + integer(o.price_cents), 0));
    const quantity = String(integer(line.quantity, 1));
    const product = linked("item", line.item_id);
    items.push({ id: commercialId(row.id, line.item_id, line.slot ?? 0, "item"), description: line.name, quantity, unit_cents: base, unit: "UN", kind: product ? "material" : "free", product_id: product });
    for (const option of options) {
      const product = linked("option", option.group_id, option.id);
      items.push({ id: commercialId(row.id, line.item_id, line.slot ?? 0, "option", option.group_id, option.id), description: option.name, quantity, unit_cents: integer(option.price_cents), unit: "UN", kind: product ? "material" : "free", product_id: product });
    }
  }
  const at = row.confirmed_at ?? row.created;
  const snapshot = saleSnapshot(source, row.total_cents, at, items, policy.version);
  // contact_id do Pedido é local: somente a ponte cadastral promove no consumidor.
  snapshot.customer_ref = row.contact_id ?? row.customer?.contact_id ?? null;
  snapshot.freight_cents = row.delivery_fee_cents ?? 0;
  snapshot.discount_cents = row.discount_cents ?? 0;
  snapshot.lifecycle.base_status = row.status;
  snapshot.lifecycle.delivered_at = row.delivered_at ?? null;
  validateSnapshot(snapshot);
  return snapshot;
}

type EventInput = { operation: IntegrationOperation; receipt?: CommercialReceipt; reason?: string; stock?: boolean; at?: number; local?: boolean };
type PlannedSource = { source: SourceRef; revision: number; seq: number; events: IntegrationEvent[]; snapshot: CommercialSnapshot; snapshots: Map<string, CommercialSnapshot> };
/** Um CAS por origem, mesmo quando o pagamento alcança vários componentes. */
export class CommercePlan {
  private sources = new Map<string, PlannedSource>();
  private extras: Statement[] = [];
  // Só durante a preparação deste lote: não reutiliza leituras após escrever.
  private readings = new Map<string, any>();
  private activations = new Map<IntegrationModule, ReturnType<typeof readIntegrationActivation>>();
  private policyPromise?: ReturnType<typeof ensureCommercialPolicy>;
  activation(module: IntegrationModule) {
    let value = this.activations.get(module);
    if (!value) { value = readIntegrationActivation(this.ctx.env, this.ctx.profile, module); this.activations.set(module, value); }
    return value;
  }
  policy() { return this.policyPromise ??= ensureCommercialPolicy(this.ctx.env, this.ctx.profile); }
  async inspectMany(sources: SourceRef[]) {
    const missing = sources.filter(source => !this.readings.has(canonical(source)));
    if (!missing.length) return;
    const rows = await all(this.ctx.env, `WITH inputs AS (
      SELECT value ->> '$.profile' profile,value ->> '$.module' module,value ->> '$.source_id' source_id,
        value ->> '$.component' component,value ->> '$.scope' scope FROM json_each(?)
    ) SELECT i.*,s.revision,s.enqueued_seq,
      (SELECT payload_json FROM module_erp_events e WHERE e.profile_id=i.profile AND e.module_id=i.module AND e.source_id=i.source_id
        AND e.payload_json ->> '$.source.component'=i.component AND e.payload_json ->> '$.operation'='execute' ORDER BY e.seq DESC LIMIT 1) execution_json,
      (SELECT response FROM receipts WHERE scope=i.scope ORDER BY CAST(key AS INTEGER) DESC LIMIT 1) snapshot_json,
      (SELECT COALESCE(sum(CASE WHEN r.kind='receive' THEN a.amount_cents ELSE -a.amount_cents END),0)
        FROM module_erp_allocations a JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key
        WHERE a.profile_id=i.profile AND a.module_id=i.module AND a.source_id=i.source_id AND a.component=i.component) allocated,
      (SELECT j.value ->> '$.id' FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id,json_each(d.receipt_json,'$.links') j
        WHERE e.profile_id=i.profile AND e.module_id=i.module AND e.source_id=i.source_id
          AND e.payload_json ->> '$.source.component'=i.component AND j.value ->> '$.kind'='title'
        ORDER BY e.seq DESC,j.value ->> '$.id' LIMIT 1) title
      FROM inputs i LEFT JOIN module_erp_sources s ON s.profile_id=i.profile AND s.module_id=i.module AND s.source_id=i.source_id`,
      canonical(missing.map(source => ({ ...source, scope: snapshotScope(source) }))));
    for (const row of rows) {
      const source: SourceRef = { profile: row.profile, module: row.module, source_id: row.source_id, component: row.component };
      this.readings.set(canonical(source), { ...row, snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) as CommercialSnapshot : null });
    }
  }
  async inspect(source: SourceRef) { await this.inspectMany([source]); return this.readings.get(canonical(source))!; }
  constructor(readonly ctx: ModuleContext, readonly actor: string | null, readonly at = Date.now()) {}
  async add(snapshot: CommercialSnapshot, operations: EventInput[] = []) {
    const source = snapshot.source;
    const key = canonical([source.profile, source.module, source.source_id]);
    let plan = this.sources.get(key);
    if (!plan) {
      const row = await this.inspect(source);
      plan = { source, revision: row?.revision ?? 0, seq: row?.enqueued_seq ?? 0, events: [], snapshot, snapshots: new Map() };
      this.sources.set(key, plan);
    }
    const next = { ...snapshot, source_revision: plan.revision + 1 };
    plan.snapshot = next; plan.snapshots.set(source.component, next);
    if (!operations.length) return;
    const state = await this.activation(source.module);
    for (const input of operations) {
      const occurred = input.at ?? Math.max(this.at, Date.now());
      const eligible = { document: false, stock: false, finance: false };
      const check = { source, epochs: state.epochs, occurred_ms: occurred } as IntegrationEvent;
      const original = next.lifecycle.first_execution_at ?? occurred;
      // Não reconhece pedido antigo no primeiro pagamento ou religamento.
      const trigger = ["prepare", "execute"].includes(input.operation) ? { ...check, occurred_ms: original } : check;
      eligible.finance = eventEpochOpen(trigger, state.activations, ["erp-financeiro"]);
      eligible.stock = input.stock !== false && next.items.some(i => i.kind === "material" && i.product_id !== null) && eventEpochOpen(trigger, state.activations, ["erp-produtos", "erp-estoque"]);
      eligible.document = eligible.finance || eligible.stock || eventEpochOpen(trigger, state.activations, ["erp-vendas"]);
      if (["cancel", "reverse", "receive"].includes(input.operation)) {
        const prior = (await this.inspect(source)).execution_json;
        if (prior) {
          const old = JSON.parse(prior) as IntegrationEvent;
          eligible.document ||= input.operation !== "receive" && old.eligible.document;
          eligible.finance ||= old.eligible.finance;
          eligible.stock ||= input.operation !== "receive" && input.stock !== false && old.eligible.stock;
        }
      }
      if (input.local) Object.assign(eligible, { document: false, stock: false, finance: false });
      if (!input.local && !eligible.document && !eligible.stock && !eligible.finance) continue;
      const seq = ++plan.seq;
      const event: IntegrationEvent = { id: commandId(source, seq), command_id: commandId(source, seq), event_key: eventKey(source, input.operation, next.source_revision), source, seq, source_revision: next.source_revision,
        operation: input.operation, occurred_ms: occurred, epochs: state.epochs, eligible, snapshot: next,
        receipt_key: input.receipt?.receipt_key ?? null, reverses_receipt_key: input.receipt?.reverses_key ?? null, reason_code: input.reason ?? null, actor_id: this.actor };
      // Dois recebimentos no mesmo fechamento têm fatos distintos. Base64url
      // conserva o SHA-256 inteiro em 43 caracteres: em hexadecimal, o sufixo
      // faz a chave de order:<UUID> ultrapassar o limite de 200 da base.
      if (input.receipt) event.event_key += `:${Buffer.from(hash(input.receipt.receipt_key), "hex").toString("base64url")}`;
      plan.events.push(event);
      if (input.local) this.append(["UPDATE module_erp_delivery SET state='blocked',completed_ms=NULL,error_code=?,error_message=? WHERE event_id=?",
        [input.reason, new IntegrationError(input.reason!).message, localEventId(source, event.event_key)]]);
      else if (input.operation === "cancel") this.append([`UPDATE module_erp_delivery SET state='done',completed_ms=?,error_code='cancellation_resolved',error_message=NULL
        WHERE error_code='refund_required' AND event_id IN (SELECT id FROM module_erp_events WHERE profile_id=? AND module_id=? AND source_id=? AND seq IS NULL)`,
        [this.at, source.profile, source.module, source.source_id]]);
    }
  }
  append(...statements: Statement[]) { this.extras.push(...statements); }
  statements(): Statement[] {
    const out: Statement[] = [];
    for (const plan of this.sources.values()) {
      // state_json segue o último componente; os DTOs locais preservam todos.
      out.push(...integrationStatements({ source: plan.snapshot.source, expected_revision: plan.revision, events: plan.events, next_state: { snapshot: plan.snapshot } }));
      const snapshots = [...plan.snapshots.values()];
      for (let i = 0; i < snapshots.length; i += 20) {
        const part = snapshots.slice(i, i + 20);
        out.push([`INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES ${part.map(() => "(?,?,?,?,200,?)").join(",")}`,
          part.flatMap(snapshot => [snapshotScope(snapshot.source), String(snapshot.source_revision), hash(snapshot), canonical(snapshot), this.at])]);
      }
    }
    return [...out, ...this.extras];
  }
}

export async function buildOrderCommerce(ctx: ModuleContext, row: any, actor: string, operation: "received" | "lifecycle" | "cancel", at = Date.now(), newSource?: SourceRef): Promise<CommercePlan> {
  const source = newSource ?? await orderOwner(ctx.env, ctx.profile, row);
  const plan = new CommercePlan(ctx, actor, at);
  const snapshot = await projectOrder(ctx, row, source, plan);
  const existing = (await plan.inspect(source)).snapshot;
  const consumed = !!row.preparing_at || ["preparing", "ready", "out_for_delivery", "delivered"].includes(row.status);
  let operations: EventInput[] = [];
  if (operation === "received" && !existing) operations = [{ operation: "prepare" }, { operation: "execute" }];
  else if (operation === "cancel") {
    const paid = row.payment_status === "paid" || await netAllocated(ctx.env, source) > 0;
    // A anulação confirmada enfileira primeiro as reversões e depois o
    // cancelamento. Não deixa um cancelamento bloqueado à frente do estorno.
    if ((existing || row.confirmed_at) && !paid) operations = [{ operation: "cancel", stock: !consumed, reason: consumed ? "consumption_requires_classification" : "order_cancelled" }];
  } else if (existing) operations = [{ operation: "lifecycle" }];
  await plan.add(snapshot, operations);
  plan.append(...aliasStatements(source, "order", row.id));
  return plan;
}
export async function orderCommerce(ctx: ModuleContext, row: any, actor: string, operation: "received" | "lifecycle" | "cancel", at = Date.now()): Promise<Statement[]> {
  const plan = await buildOrderCommerce(ctx, row, actor, operation, at);
  if (operation === "cancel" && row.tab_id) {
    const { cancelledOrderService } = await import("../mesas/integration");
    await cancelledOrderService(ctx, row, plan);
  }
  return plan.statements();
}

export function manualReceipt(source: SourceRef, request: string, amount: number, method: string, actor: string, at = Date.now()): CommercialReceipt {
  const normalized = ["cash", "pix", "card", "other"].includes(method) ? method as CommercialReceipt["method"] : "unknown";
  return { profile_id: source.profile, receipt_key: manualReceiptKey(source.profile, source.module, request), owner_module: source.module, source_id: source.source_id, kind: "receive", evidence: "manual", reverses_key: null, amount_cents: integer(amount, 1), method: normalized, occurred_ms: at, actor_id: actor, evidence_hash: hash([source, request, amount, normalized]) };
}
export async function receiptReplay(env: Env, receipt: CommercialReceipt): Promise<CommercialReceipt | null> {
  const old = await one<CommercialReceipt>(env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", receipt.profile_id, receipt.receipt_key);
  if (old && (old.owner_module !== receipt.owner_module || old.source_id !== receipt.source_id || old.amount_cents !== receipt.amount_cents || old.evidence_hash !== receipt.evidence_hash || old.method !== receipt.method || old.actor_id !== receipt.actor_id)) throw new IntegrationError("idempotency_conflict", 409);
  return old;
}
export async function allocateSale(plan: CommercePlan, snapshot: CommercialSnapshot, receipt: CommercialReceipt, amount: number, ordinal: number) {
  await plan.add(snapshot, [{ operation: receipt.kind, receipt, stock: false }]);
  plan.append(...allocationStatements(snapshot.source, receipt.receipt_key, allocationKey(receipt.receipt_key, snapshot.source, ordinal), amount));
}
export async function singleReceiptStatements(ctx: ModuleContext, snapshot: CommercialSnapshot, receipt: CommercialReceipt): Promise<Statement[]> {
  if (await receiptReplay(ctx.env, receipt)) return [];
  const plan = new CommercePlan(ctx, receipt.actor_id, receipt.occurred_ms);
  plan.append(...commercialReceiptStatements(receipt));
  if (!await savedSale(ctx.env, snapshot.source) && snapshot.lifecycle.base_status === "received") await plan.add(snapshot, [{ operation: "prepare" }, { operation: "execute" }]);
  const received = await netAllocated(ctx.env, snapshot.source);
  const amount = receipt.kind === "reverse" ? receipt.amount_cents : Math.min(receipt.amount_cents, Math.max(0, snapshot.total_cents - received));
  if (amount) await allocateSale(plan, snapshot, receipt, amount, 0);
  else await plan.add(snapshot);
  return plan.statements();
}
export async function netAllocated(env: Env, source: SourceRef): Promise<number> {
  const r = await one(env, `SELECT COALESCE(sum(CASE WHEN r.kind='receive' THEN a.amount_cents ELSE -a.amount_cents END),0) amount FROM module_erp_allocations a JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key WHERE a.profile_id=? AND a.module_id=? AND a.source_id=? AND a.component=?`, source.profile, source.module, source.source_id, source.component);
  return r.amount;
}
export async function reverseReceiptStatements(ctx: ModuleContext, original: CommercialReceipt, actor: string | null, reason: string, at = Date.now(), confirmed?: CommercialReceipt): Promise<Statement[]> {
  const receipt: CommercialReceipt = confirmed ?? { ...original, receipt_key: reverseReceiptKey(original.receipt_key), kind: "reverse", reverses_key: original.receipt_key, actor_id: actor, occurred_ms: at, evidence_hash: hash([original.receipt_key, reason]) };
  if (await receiptReplay(ctx.env, receipt)) return [];
  const plan = new CommercePlan(ctx, actor, at);
  plan.append(...commercialReceiptStatements(receipt));
  const allocations = await all(ctx.env, "SELECT * FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? ORDER BY allocation_key", ctx.profile, original.receipt_key);
  for (const [i, a] of allocations.entries()) {
    const snapshot = await savedSale(ctx.env, saleSource(ctx.profile, a.module_id, a.source_id, a.component));
    if (!snapshot) throw new IntegrationError("historical_origin_unlinked");
    await allocateSale(plan, snapshot, receipt, a.amount_cents, i);
    if (snapshot.lifecycle.base_status === "cancelled" && await netAllocated(ctx.env, snapshot.source) === a.amount_cents) await plan.add(snapshot, [{ operation: "cancel", stock: false,
      reason: snapshot.source.module === "entrega" ? "delivery_cancelled" : "refund_confirmed_review_stock" }]);
  }
  return plan.statements();
}

/** Evidência lida do núcleo, nunca de campos alegados pelo cliente. */
export async function providerOrderStatements(ctx: ModuleContext, row: any, paymentId: string, reverse = false, validateOnly = false, receiptKey?: string): Promise<Statement[]> {
  if (row.tab_id) throw new IntegrationError("invalid_request", 409);
  const receiptFields = "profile_id,receipt_key,owner_module,source_id,kind,evidence,reverses_key,amount_cents,method,occurred_ms,actor_id,evidence_hash".split(",");
  const pendingKey = paymentPendingEventKey(saleSource(ctx.profile, "pedido", row.id), paymentId, reverse ? "refunded" : "paid");
  const payment = await one(ctx.env, `SELECT p.*,
    EXISTS(SELECT 1 FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
      WHERE e.profile_id=p.profile_id AND e.event_key=? AND d.error_code='payment_evidence_required') recovery_pending,
    (SELECT payload FROM events WHERE profile_id=p.profile_id AND kind='payment.evidence' AND source_key=?) evidence_json,
    (SELECT json_object('module_id',module_id,'source_id',source_id,'component',component) FROM module_erp_aliases
      WHERE profile_id=p.profile_id AND record_kind='order' AND record_id=p.ref_id AND module_id IN ('pedido','mesas')) source_json,
    (SELECT json_object(${receiptFields.map(f => `'${f}',${f}`).join(",")}) FROM module_commercial_receipts
      WHERE profile_id=p.profile_id AND receipt_key=?) receipt_json
    FROM payments p WHERE p.id=? AND p.profile_id=? AND p.module_id='pedido' AND p.ref_id=?`, pendingKey, receiptKey ? `payment.evidence:${receiptKey}` : null, receiptKey ?? null, paymentId, ctx.profile, row.id);
  if (!payment || !payment.provider_payment_id) throw new IntegrationError("invalid_request", 422);
  payment.evidence_key = receiptKey;
  const fact = await optionalCommercialPaymentEvidence(ctx.env, ctx.profile, "pedido", paymentId, row.id, reverse ? "refunded" : "paid", undefined, payment);

  const alias = payment.source_json ? JSON.parse(payment.source_json) : null;
  const source = alias ? saleSource(ctx.profile, alias.module_id, alias.source_id, alias.component) : saleSource(ctx.profile, "pedido", row.id);
  if (!fact) return validateOnly ? [] : pendingPaymentStatements(ctx.env, await projectOrder(ctx, row, source), paymentId, reverse ? "refunded" : "paid");
  const paidFact = fact.original ? { ...fact.original, original: null } : fact;
  const recovered = payment.recovery_pending ? resolvedPaymentStatements({ source }, paymentId, reverse ? "refunded" : "paid") : [];
  const key = providerReceiptKey(ctx.profile, payment.provider, payment.account_id, payment.provider_payment_id);
  if (receiptKey && receiptKey !== key) throw new IntegrationError("idempotency_conflict", 409);
  const old: CommercialReceipt | null = receiptKey
    ? payment.receipt_json ? JSON.parse(payment.receipt_json) : null
    : await one<CommercialReceipt>(ctx.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, key);
  if (old && (old.owner_module !== "pedido" || old.source_id !== row.id || old.amount_cents !== payment.amount_cents || old.evidence !== "provider" || old.kind !== "receive" || old.method !== paidFact.method)) throw new IntegrationError("idempotency_conflict", 409);
  if (validateOnly) return [];
  if (reverse) return [...recovered, ...resolvedPaymentStatements({ source }, paymentId, "paid"), ...(old
    ? await reverseReceiptStatements(ctx, old, null, "provider_refund", fact.occurred_ms, commercialReceiptFromEvidence(fact))
    : [...commercialReceiptStatements(commercialReceiptFromEvidence(paidFact)), ...commercialReceiptStatements(commercialReceiptFromEvidence(fact))])];
  if (old && (row.status === "cancelled" || await netAllocated(ctx.env, source) >= row.total_cents || await one(ctx.env, "SELECT 1 FROM module_erp_allocations WHERE profile_id=? AND receipt_key=?", ctx.profile, key))) return recovered;
  const receipt: CommercialReceipt = old ?? commercialReceiptFromEvidence(paidFact);
  const plan = new CommercePlan(ctx, row.created_by ?? null);
  const snapshot = await projectOrder(ctx, row, source, plan);
  const state = await plan.inspect(source);
  if (!state.snapshot && row.status === "received") await plan.add(snapshot, [{ operation: "prepare" }, { operation: "execute" }]);
  plan.append(...recovered, ...commercialReceiptStatements(receipt));
  const amount = row.status === "cancelled" ? 0 : Math.min(receipt.amount_cents, Math.max(0, snapshot.total_cents - state.allocated));
  if (amount) await allocateSale(plan, snapshot, receipt, amount, 0);
  else await plan.add(snapshot);
  plan.append(...aliasStatements(source, "order", row.id));
  return plan.statements();
}

export async function authorizePedidoSource(ctx: ModuleContext, actor: Actor, source: SourceRef, write: boolean) {
  if (source.profile !== ctx.profile || source.module !== "pedido") throw new IntegrationError("not_found", 404);
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  if (source.component.startsWith("catalog:")) {
    if (actor.kind !== "user" || actor.role !== "admin" || actor.via) throw new IntegrationError("forbidden", 403);
    const [, kind, component] = source.component.split(":");
    const row = kind === "item" ? await one(ctx.env, "SELECT id FROM pedido_items WHERE profile_id=? AND id=?", ctx.profile, source.source_id)
      : kind === "option" ? await one(ctx.env, "SELECT id FROM pedido_groups WHERE profile_id=? AND id=? AND EXISTS(SELECT 1 FROM json_each(options) WHERE json_extract(value,'$.id')=?)", ctx.profile, source.source_id, component) : null;
    if (!row) throw new IntegrationError("not_found", 404);
    return;
  }
  const row = await one(ctx.env, "SELECT id,tab_id FROM pedido_orders WHERE profile_id=? AND id=?", ctx.profile, source.source_id);
  if (!row || row.tab_id) throw new IntegrationError("not_found", 404);
}
registerIntegrationProducer({ module: "pedido", authorizeSource: authorizePedidoSource, async project(ctx, source) {
  if (source.profile !== ctx.profile || source.module !== "pedido" || source.component !== "main") throw new IntegrationError("not_found", 404);
  const row = await one(ctx.env, "SELECT * FROM pedido_orders WHERE profile_id=? AND id=? AND tab_id IS NULL", ctx.profile, source.source_id);
  if (!row) throw new IntegrationError("not_found", 404);
  return projectOrder(ctx, row, source);
} });

registerReceiptReverser("pedido", async (env, actor, original, input) => {
  if (actor.kind !== "user" || actor.via || actor.credential) throw new IntegrationError("forbidden", 403);
  const { modulesApi } = await import("../api");
  const ctx = modulesApi(env, original.profile_id, "pedido");
  const row = await one(env, "SELECT * FROM pedido_orders WHERE id=? AND profile_id=? AND tab_id IS NULL", original.source_id, original.profile_id);
  if (!row) throw new IntegrationError("not_found", 404);
  const statements = await reverseReceiptStatements(ctx, original, actor.id, input.reason_code);
  if (statements.length) await batch(env, [
    ["UPDATE pedido_orders SET payment_status='refunded',needs_refund=0,updated=? WHERE id=? AND profile_id=? AND payment_status='paid'", [Date.now(), row.id, ctx.profile]], integrationCasGuard,
    ["INSERT INTO pedido_history(id,profile_id,order_id,kind,actor,note,created) VALUES(?,?,?,'payment',?,'Recebimento anulado.',?)", [crypto.randomUUID(), ctx.profile, row.id, actor.id, Date.now()]], ...statements,
  ]);
  return { receipt_key: reverseReceiptKey(original.receipt_key) };
});
