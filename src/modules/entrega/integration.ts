import { batch, one } from "../../db";
import type { Actor } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import { registerIntegrationProducer } from "../../integrations/registry";
import { aliasStatements, integrationStatements } from "../../integrations/outbox";
import { resolveCustomer } from "../../customer/ports";
import { ensureCommercialPolicy } from "../../integrations/policy";
import { canonical, hash } from "../../integrations/keys";
import { integer, IntegrationError } from "../../integrations/privacy";
import { registerReceiptReverser } from "../../integrations/receipts";
import { CommercePlan, commerceGuard, commercialId, manualReceipt, netAllocated, receiptReplay, reverseReceiptStatements, saleSnapshot, saleSource, savedSale, singleReceiptStatements, orderSourceForId, type SourceRef, type Statement } from "../pedido/public";

interface DeliveryCommercial { version: number; price_cents: number | null; authorized_at: number | null; delegate?: SourceRef }
export const deliveryCommercial = (row: any): DeliveryCommercial => ({ version: 0, price_cents: null, authorized_at: null, ...JSON.parse(row.commercial_json ?? "{}") });
const sourceOf = (ctx: ModuleContext, row: any) => saleSource(ctx.profile, "entrega", row.id);
function requirePerson(ctx: ModuleContext, actor: Actor) {
  ctx.access(actor, "conversations:write");
  if (actor.kind !== "user" || actor.via || actor.credential) throw new IntegrationError("forbidden", 403);
}
async function load(ctx: ModuleContext, id: string) {
  const row = await one(ctx.env, "SELECT * FROM entrega_deliveries WHERE profile_id=? AND id=?", ctx.profile, id);
  if (!row) throw new IntegrationError("not_found", 404);
  return row;
}
export async function deliveryCreationStatements(ctx: ModuleContext, row: any): Promise<Statement[]> {
  if (row.source === "pedido") {
    const owner = await orderSourceForId(ctx.env, ctx.profile, row.source_ref);
    const existing = await one(ctx.env, "SELECT 1 FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", owner.profile, owner.module, owner.source_id);
    return [...(existing ? [] : integrationStatements({ source: owner, expected_revision: 0, events: [], next_state: {} })), ...aliasStatements(owner, "order", row.source_ref), ...aliasStatements(owner, "delivery", row.id), ["UPDATE entrega_deliveries SET commercial_json=? WHERE profile_id=? AND id=?", [canonical({ version: 0, price_cents: null, authorized_at: null, delegate: owner }), ctx.profile, row.id]]];
  }
  const source = sourceOf(ctx, row);
  return [...integrationStatements({ source, expected_revision: 0, events: [], next_state: {} }), ...aliasStatements(source, "delivery", row.id)];
}
export async function projectDelivery(ctx: ModuleContext, row: any) {
  if (row.source === "pedido") throw new IntegrationError("delegated_origin", 409);
  const source = sourceOf(ctx, row), commercial = deliveryCommercial(row);
  const saved = await savedSale(ctx.env, source);
  if (saved) return { ...saved, lifecycle: { ...saved.lifecycle, base_status: row.status, delivered_at: row.delivered_at ?? saved.lifecycle.delivered_at } };
  if (!commercial.price_cents || !commercial.authorized_at) throw new IntegrationError("price_required", 422);
  const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
  const snapshot = saleSnapshot(source, commercial.price_cents, commercial.authorized_at, [{ id: commercialId(source, "delivery"), description: "Serviço de entrega", quantity: "1", unit_cents: commercial.price_cents, unit: "UN", kind: "service", product_id: null }], policy.version);
  // Só o resolvedor cadastral comum; não procura cliente por telefone.
  if (row.conversation_id) {
    const ref = await resolveCustomer(ctx.env, await ctx.conversation(row.conversation_id));
    snapshot.customer_ref = ref.namespace === "team" && ref.state === "ready" && ref.contactId ? ref.contactId : `unresolved:${row.conversation_id}`;
    snapshot.contact_id = ref.state === "ready" && ref.namespace === "team" ? ref.erp?.id ?? null : null;
  }
  snapshot.lifecycle.base_status = row.status;
  snapshot.lifecycle.delivered_at = row.delivered_at ?? null;
  return snapshot;
}
const commandScope = (ctx: ModuleContext, actor: Actor) => `f3-entrega:${ctx.profile}:${actor.id}`;
async function replay(ctx: ModuleContext, actor: Actor, request: string, data: unknown) {
  const row = await one(ctx.env, "SELECT fingerprint,response FROM receipts WHERE scope=? AND key=?", commandScope(ctx, actor), request);
  if (row && row.fingerprint !== hash(data)) throw new IntegrationError("idempotency_conflict", 409);
  return row ? JSON.parse(row.response) : null;
}
export async function updateDeliveryCommercial(ctx: ModuleContext, actor: Actor, data: any, request: string) {
  requirePerson(ctx, actor);
  const input = { id: data.id, version: integer(data.version), price_cents: data.price_cents === null ? null : integer(data.price_cents), authorize: data.authorize === true };
  const old = await replay(ctx, actor, request, input); if (old) return old;
  const row = await load(ctx, data.id), commercial = deliveryCommercial(row);
  if (row.source === "pedido") throw new IntegrationError("delegated_origin", 409);
  if (commercial.version !== input.version) throw new IntegrationError("version_conflict", 409);
  if (commercial.authorized_at) throw new IntegrationError("commercial_frozen", 409);
  if (row.status === "cancelled") throw new IntegrationError("invalid_request", 409);
  if (input.authorize && !input.price_cents) throw new IntegrationError("price_required", 422);
  const at = Date.now();
  const next: DeliveryCommercial = { version: commercial.version + 1, price_cents: input.price_cents, authorized_at: input.authorize ? at : null };
  const plan = new CommercePlan(ctx, actor.id, at);
  if (next.authorized_at) await plan.add(await projectDelivery(ctx, { ...row, commercial_json: canonical(next) }), [{ operation: "prepare", stock: false }, { operation: "execute", stock: false }]);
  const result = { id: row.id, commercial: next };
  await batch(ctx.env, [
    ["UPDATE entrega_deliveries SET commercial_json=?,updated=? WHERE profile_id=? AND id=? AND commercial_json=? AND status=?", [canonical(next), at, ctx.profile, row.id, row.commercial_json, row.status]], commerceGuard,
    ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,?,?,'Preço comercial atualizado.',?)", [crypto.randomUUID(), ctx.profile, row.id, row.status, actor.id, at]],
    ...plan.statements(),
    ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [commandScope(ctx, actor), request, hash(input), canonical(result), at]],
  ]);
  return result;
}
export async function receiveDelivery(ctx: ModuleContext, actor: Actor, data: any, request: string) {
  requirePerson(ctx, actor);
  const row = await load(ctx, data.id);
  if (row.source === "pedido") throw new IntegrationError("delegated_origin", 409);
  const source = sourceOf(ctx, row);
  if (!["cash", "pix", "card", "other"].includes(data.method)) throw new IntegrationError("invalid_request", 400);
  const receipt = manualReceipt(source, request, integer(data.amount_cents, 1), data.method, actor.id);
  const old = await receiptReplay(ctx.env, receipt);
  if (old) return { receipt_key: old.receipt_key, amount_cents: old.amount_cents };
  const snapshot = await projectDelivery(ctx, row);
  if (row.status === "cancelled" || receipt.amount_cents > snapshot.total_cents - await netAllocated(ctx.env, source)) throw new IntegrationError("invalid_request", 409);
  await batch(ctx.env, [
    ["UPDATE entrega_deliveries SET updated=? WHERE profile_id=? AND id=? AND status=? AND commercial_json=?", [Date.now(), ctx.profile, row.id, row.status, row.commercial_json]], commerceGuard,
    ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,?,?,'Recebimento manual confirmado.',?)", [crypto.randomUUID(), ctx.profile, row.id, row.status, actor.id, Date.now()]],
    ...await singleReceiptStatements(ctx, snapshot, receipt),
  ]);
  return { receipt_key: receipt.receipt_key, amount_cents: receipt.amount_cents };
}
export async function deliveryLifecycleStatements(ctx: ModuleContext, row: any, actor: string, cancel: boolean): Promise<Statement[]> {
  if (row.source === "pedido" || !deliveryCommercial(row).authorized_at) return [];
  const plan = new CommercePlan(ctx, actor);
  const snapshot = await projectDelivery(ctx, row);
  await plan.add(snapshot, cancel && await netAllocated(ctx.env, snapshot.source) > 0 ? [] : [{ operation: cancel ? "cancel" : "lifecycle", stock: false, reason: cancel ? "delivery_cancelled" : undefined }]);
  return plan.statements();
}
registerIntegrationProducer({ module: "entrega", async authorizeSource(ctx, actor, source, write) {
  if (source.profile !== ctx.profile || source.module !== "entrega") throw new IntegrationError("not_found", 404);
  if (write) requirePerson(ctx, actor); else ctx.access(actor, "conversations:read");
  if (actor.credential) throw new IntegrationError("forbidden", 403);
  await load(ctx, source.source_id);
}, async project(ctx, source) { return projectDelivery(ctx, await load(ctx, source.source_id)); } });
registerReceiptReverser("entrega", async (env, actor, original, input) => {
  const ctx = modulesApi(env, original.profile_id, "entrega"); requirePerson(ctx, actor);
  const row = await load(ctx, original.source_id);
  const statements = await reverseReceiptStatements(ctx, original, actor.id, input.reason_code);
  if (statements.length) await batch(env, [...statements, ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,?,?,'Recebimento anulado.',?)", [crypto.randomUUID(), ctx.profile, row.id, row.status, actor.id, Date.now()]]]);
  return { receipt_key: `${original.receipt_key}:reverse` };
});
