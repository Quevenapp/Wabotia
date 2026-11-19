import { one } from "../db";
import type { Actor, Env } from "../types";
import { moduleById } from "../modules/registry";
import { erpIdentity, erpSystemIdentity, systemUserId, erpRoleOf } from "../modules/erp/identity";
import { readErpPartsState } from "../modules/erp/parts-state";
import { GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, encodeIdentity } from "../erp/engine/identity";
import { erpFetch } from "../erp/hub";
import { requireFinancialAal } from "../mfa";
import type { Destination, IntegrationEvent, IntegrationResult, PreparedErpRequest } from "./contracts";
import { ensureCommercialPolicy, requireIntegrationHuman } from "./policy";
import { readIntegrationActivation, eventEpochOpen, documentEpochOpen } from "./activation";
import { integrationProducer } from "./registry";
import { integrationPerson, resolveCommercialCustomer } from "./customer-adapter";
import { allocatedReceipt } from "./receipts";
import { readPreparedRequest, sourceBindings } from "./outbox";
import { canonical, hash } from "./keys";
import { IntegrationError, sanitizedError, validateEvent, validateResult } from "./privacy";

/** Wire F3: p_request é o DTO persistido; p_evidence é construído aqui,
 * nunca aceito da rota pública. B2 verifica ambos no D1 antes da transação.
 */
export interface ModuleExecutionEvidence {
  profile: string; module: string; source_id: string; seq: number; event_id: string;
  command_id: string; event_hash: string; request_hash: string; mode: "system" | "human";
}
export type ModuleRpc = "erp_module_apply" | "erp_module_origin_get" | "erp_module_command_close" | "erp_module_manual_apply";
export interface ErpOriginResult { receipt: IntegrationResult | null }
export async function prepareErpRequest(env: Env, event: IntegrationEvent): Promise<PreparedErpRequest> {
  const existing = await readPreparedRequest(env, event);
  return existing ?? prepare(env, event);
}
export async function prepareManualErpRequest(env: Env, event: IntegrationEvent, actor: Actor, destinations: readonly Destination[]): Promise<PreparedErpRequest> {
  authorizeManual(actor, event.source.profile, destinations);
  return prepare(env, event, actor, destinations);
}
export function authorizeManual(actor: Actor, profile: string, destinations: readonly Destination[]) {
  requireIntegrationHuman(actor, profile);
  if (!destinations.length || destinations.some(d => d !== "stock" && d !== "finance")) throw new IntegrationError("invalid_request", 400);
  const role = erpRoleOf(actor);
  if (destinations.some(d => role !== "admin" && role !== (d === "stock" ? "estoque" : "financeiro"))) throw new IntegrationError("forbidden", 403);
  if (destinations.includes("finance")) requireFinancialAal(actor);
}
async function prepare(env: Env, event: IntegrationEvent, actor?: Actor, destinations?: readonly Destination[]): Promise<PreparedErpRequest> {
  validateEvent(event); integrationProducer(event.source.module);
  const declaration = moduleById(event.source.module)?.integration;
  if (!declaration || !declaration.operations.includes(event.operation) || declaration.route === "delegate") throw new IntegrationError("integration_not_implemented");
  const state = await readIntegrationActivation(env, event.source.profile, event.source.module);
  if (!state.snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const policy = await ensureCommercialPolicy(env, event.source.profile);
  const source = await one(env, "SELECT links_json,applied_seq FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(event.source));
  if (!source || source.applied_seq !== event.seq - 1) throw new IntegrationError("version_conflict", 409);
  const links = JSON.parse(source.links_json) as IntegrationResult["links"];
  if (["receive", "reverse"].includes(event.operation) && !links.some(l => l.kind === "title" || l.kind === "document")) throw new IntegrationError("historical_origin_unlinked");
  const maintenance = event.operation === "cancel" || event.operation === "reverse";
  const requested = {
    document: event.eligible.document && (maintenance || documentEpochOpen(event, state.activations)),
    stock: event.eligible.stock && (maintenance || eventEpochOpen(event, state.activations, ["erp-produtos", "erp-estoque"])) && (destinations ? destinations.includes("stock") : policy.auto_post.stock),
    finance: event.eligible.finance && (maintenance || eventEpochOpen(event, state.activations, ["erp-financeiro"])) && (destinations ? destinations.includes("finance") : policy.auto_post.finance),
  };
  // Não consultar/promover clientes nem inicializar ERP para fato inelegível.
  if (!maintenance && !requested.document && !requested.stock && !requested.finance) throw new IntegrationError(
    (event.eligible.stock && !policy.auto_post.stock || event.eligible.finance && !policy.auto_post.finance) ? "waiting_manual" : "epoch_closed", 409);
  const contact = maintenance ? event.snapshot.contact_id : await resolveCommercialCustomer(env, event.snapshot, actor ?? await integrationPerson(env, event.source.profile, event.actor_id));
  if (requested.finance && ["execute", "recognize"].includes(event.operation) && !policy.revenue_category_id) throw new IntegrationError("category_required");
  const physical = event.snapshot.items.some(i => i.kind === "material" && i.product_id);
  if (requested.stock && physical && !maintenance && !policy.warehouse_id) throw new IntegrationError("warehouse_required");
  let receipt = null;
  if (event.receipt_key) {
    receipt = await allocatedReceipt(env, event.source, event.receipt_key);
    if (event.operation === "receive" && receipt.receipt.kind !== "receive" || event.operation === "reverse" && (receipt.receipt.kind !== "reverse" || receipt.receipt.reverses_key !== event.reverses_receipt_key)) throw new IntegrationError("invalid_request", 422);
    if (event.operation === "receive" && requested.finance && !policy.settlement_accounts[receipt.receipt.method]) throw new IntegrationError("settlement_account_required");
  } else if (["receive", "reverse"].includes(event.operation)) throw new IntegrationError("invalid_request", 422);
  const expected: Record<string, number> = {};
  for (const link of links) if (link.version !== null && ["document", "title", "stock_posting"].includes(link.kind)) expected[`${link.kind === "stock_posting" ? "posting" : link.kind}:${link.id}`] = link.version;
  const snapshot = { ...event.snapshot, contact_id: contact, items: event.snapshot.items.map(i => state.snapshot.parts.products || links.length ? i : { ...i, product_id: null, kind: "free" as const }) };
  return { schema: 1, command_id: event.command_id, actor_id: actor?.id ?? await systemUserId(event.source.module), source: event.source, seq: event.seq, event_hash: hash(event), expected,
    body: { operation: event.operation, route: declaration.route, snapshot, policy, eligible: event.eligible, requested, epochs: event.epochs, occurred_ms: event.occurred_ms, receipt, reason_code: event.reason_code, mode: actor ? "human" : "system" } };
}
async function moduleRpc(env: Env, request: PreparedErpRequest, rpc: ModuleRpc, actor?: Actor, reason?: string): Promise<any> {
  const state = await readErpPartsState(env, request.source.profile);
  if (!state.snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const eventRow = await one(env, "SELECT id,payload_json,event_hash FROM module_erp_events WHERE profile_id=? AND module_id=? AND source_id=? AND command_id=?", ...sourceBindings(request.source), request.command_id);
  if (!eventRow || eventRow.event_hash !== request.event_hash) throw new IntegrationError("not_found", 404);
  const stored = await readPreparedRequest(env, JSON.parse(eventRow.payload_json));
  if (!stored || hash(stored) !== hash(request)) throw new IntegrationError("idempotency_conflict", 409);
  const human = actor !== undefined;
  if (human) requireIntegrationHuman(actor, request.source.profile);
  if (rpc === "erp_module_manual_apply" && !human || rpc === "erp_module_apply" && request.body.mode !== "system") throw new IntegrationError("forbidden", 403);
  const identity = human ? await erpIdentity(env, actor, request.source.profile, "POST") : await erpSystemIdentity(env, request.source.profile, request.source.module);
  // Leitura/fechamento reconciliam inclusive uma chamada humana que perdeu a
  // resposta. O ator do pedido permanece imutável; a identidade técnica não
  // pode aplicar esse pedido em nome da pessoa.
  if (rpc === "erp_module_apply" && identity.actor?.user_id !== request.actor_id || rpc === "erp_module_manual_apply" && actor?.id !== request.actor_id) throw new IntegrationError("forbidden", 403);
  const evidence: ModuleExecutionEvidence = { profile: request.source.profile, module: request.source.module, source_id: request.source.source_id, seq: request.seq, event_id: eventRow.id, command_id: request.command_id, event_hash: request.event_hash, request_hash: hash(request), mode: human ? "human" : "system" };
  // Marca não confere poder: o motor precisa comparar a evidência com o D1.
  const envelope = { ...identity, module_execution: evidence };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await erpFetch(env, request.source.profile, `/erp-rpc/${rpc}`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(envelope), [SYSTEM_HEADER]: "1", [GATE_HEADER]: "1" },
      body: canonical({ p_user_id: identity.actor!.user_id, p_request: stored, p_evidence: evidence, ...(reason ? { p_reason_code: reason } : {}) }),
    });
    const body = await response.json<any>().catch(() => null);
    if (!response.ok) {
      // Lista fechada de códigos do motor; nunca propagar exceção bruta.
      if (body?.code === "22023" && ["erp_stock_insufficient_or_excess_quantity", "erp_stock_lot_insufficient"].includes(body.message))
        throw new IntegrationError("stock_unavailable", 422);
      const codes: Record<string, string> = { PGRST202: "integration_not_implemented", "40001": "version_conflict", "42501": "forbidden" };
      const known = ["part_disabled", "epoch_closed", "waiting_manual", "historical_origin_unlinked", "default_inactive", "erp_parts_unavailable"];
      throw new IntegrationError(known.includes(body?.code) ? body.code : codes[body?.code] ?? (response.status >= 500 || response.status === 429 ? "integration_unavailable" : "invalid_request"), response.status === 404 ? 422 : response.status);
    }
    return body;
  } catch (error) { throw sanitizedError(error); }
  finally { clearTimeout(timer); }
}
export async function applyErpRequest(env: Env, request: PreparedErpRequest): Promise<IntegrationResult> {
  return validateResult(await moduleRpc(env, request, "erp_module_apply"), request.command_id, request.seq);
}
export async function getErpOrigin(env: Env, request: PreparedErpRequest, actor?: Actor): Promise<ErpOriginResult> {
  const result = await moduleRpc(env, request, "erp_module_origin_get", actor);
  if (!result || !Object.hasOwn(result, "receipt")) throw new IntegrationError("integration_unavailable", 503);
  return { receipt: result.receipt === null ? null : validateResult(result.receipt, request.command_id, request.seq) };
}
export async function closeErpCommand(env: Env, request: PreparedErpRequest, reason: string, actor?: Actor): Promise<IntegrationResult> {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(reason)) throw new IntegrationError("invalid_request", 400);
  return validateResult(await moduleRpc(env, request, "erp_module_command_close", actor, reason), request.command_id, request.seq);
}
export async function manualApplyErpRequest(env: Env, request: PreparedErpRequest, actor: Actor): Promise<IntegrationResult> {
  const requested = request.body.requested as { stock: boolean; finance: boolean };
  authorizeManual(actor, request.source.profile, (["stock", "finance"] as const).filter(d => requested[d]));
  return validateResult(await moduleRpc(env, request, "erp_module_manual_apply", actor), request.command_id, request.seq);
}
