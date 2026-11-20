import { env as testEnv } from "cloudflare:test";
import { vi } from "vitest";
import { batch, exec, one } from "../../src/db";
import { defaults, uid, type Actor, type Env } from "../../src/types";
import * as definitions from "../../src/modules/registry";
import * as adapter from "../../src/integrations/erp-adapter";
import { activationStatements, readIntegrationActivation } from "../../src/integrations/activation";
import { ensureCommercialPolicy } from "../../src/integrations/policy";
import * as producers from "../../src/integrations/registry";
import { integrationStatements, sourceBindings } from "../../src/integrations/outbox";
import { canonical, commandId, eventKey, hash, uuid5, F3_NAMESPACES } from "../../src/integrations/keys";
import { IntegrationError } from "../../src/integrations/privacy";
import type { IntegrationProducer } from "../../src/integrations/ports";
import type { CommercialSnapshot, IntegrationEvent, IntegrationResult, PreparedErpRequest, SourceRef } from "../../src/integrations/contracts";

const env = testEnv as Env;
const producer: IntegrationProducer = {
  module: "os",
  async authorizeSource(ctx, actor, source) {
    if (!actor.profiles.includes(ctx.profile) || source.profile !== ctx.profile || !await one(ctx.env,
      "SELECT 1 FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source))) throw new IntegrationError("not_found", 404);
  },
  async project(ctx, source) {
    const row = await one(ctx.env, "SELECT state_json FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
    if (!row) throw new IntegrationError("not_found", 404);
    return JSON.parse(row.state_json).snapshot;
  },
};
export function installFixtureProducer() {
  // A junção já registra o produtor real da OS; simular a porta sem disputar
  // seu registro global e sem afetar os testes integrados que não usam esta função.
  const installed = producers.integrationProducer;
  vi.spyOn(producers, "integrationProducer").mockImplementation(module => module === "os" ? producer : installed(module));
  const original = definitions.moduleById;
  vi.spyOn(definitions, "moduleById").mockImplementation(id => {
    const definition = original(id);
    return definition && id === "os" ? { ...definition, integration: { route: "work", privacy: "commercial", uses: ["customers", "products", "stock", "finance"], operations: ["prepare", "recognize", "execute", "lifecycle", "receive", "cancel", "reverse"] } } : definition;
  });
}
export async function f3Fixture(automation = true) {
  const profile = uid(), local = uid(), customer = uid(), actorId = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Área F3',?,1,?)", profile, JSON.stringify(defaults), Date.now());
  await exec(env, "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,'test','admin',?,?)", actorId, `${actorId}@example.test`, "Pessoa", JSON.stringify([profile]), Date.now());
  const actor: Actor = { id: actorId, kind: "user", name: "Pessoa", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 0, runLimit: 0, aal: 2, mfa: { factor: true, policy: "financial" } };
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,erp_contact_id,erp_version,created_by,updated_by,created,updated)
    VALUES(?,?,'team','Cliente','cliente','manual',?,1,?,?,?,?)`, local, profile, customer, actorId, actorId, Date.now(), Date.now());
  await setParts(profile, { os: true, erp: true, "erp-produtos": true, "erp-vendas": true, "erp-estoque": true, "erp-financeiro": true }, Date.now() - 1000);
  const policy = await ensureCommercialPolicy(env, profile);
  if (automation) policy.auto_post = { stock: true, finance: true }; // Escolha explícita desta preparação.
  policy.revenue_category_id = uid(); policy.warehouse_id = uid(); policy.settlement_accounts.cash = uid();
  const { profile: _, version: __, ...config } = policy;
  await exec(env, "UPDATE module_erp_policy SET config_json=? WHERE profile_id=?", canonical(config), profile);
  const state = await readIntegrationActivation(env, profile, "os");
  const source: SourceRef = { profile, module: "os", source_id: uid(), component: "main" };
  const snapshot: CommercialSnapshot = {
    schema: 1, source, source_revision: 1, contact_id: customer, customer_ref: local, privacy: "commercial", description: "Serviço contratado", issued_on: "2026-11-19",
    items: [{ id: uid(), description: "Serviço contratado", quantity: "1", unit_cents: 1000, unit: "UN", kind: "service", product_id: null }],
    total_cents: 1000, freight_cents: 0, discount_cents: 0, installments: [{ key: "main", due_on: "2026-11-19", amount_cents: 1000, payment_method_id: null }], policy_version: policy.version,
    lifecycle: { base_status: "in_progress", stage_id: null, quote_version: 1, authorization: "approved_quote", authorized_at: Date.now(), first_execution_at: Date.now(), delivered_at: null, warranty_until: null }, technical: null,
  };
  const event: IntegrationEvent = { id: uid(), command_id: commandId(source, 1), event_key: eventKey(source, "execute", 1), source, seq: 1, source_revision: 1, operation: "execute", occurred_ms: Date.now(), epochs: state.epochs, eligible: { document: true, stock: true, finance: true }, snapshot, receipt_key: null, reverses_receipt_key: null, reason_code: null, actor_id: actorId };
  return { env: env as Env, profile, actor, local, customer, source, event, policy };
}
export type F3Fixture = Awaited<ReturnType<typeof f3Fixture>>;
export async function setParts(profile: string, choices: Record<string, boolean>, at = Date.now()) {
  await batch(env, [
    ...Object.entries(choices).map(([id, enabled]): [string, unknown[]] => ["INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?, 'fixture') ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated", [profile, id, enabled ? 1 : 0, at]]),
    ...activationStatements(profile, Object.entries(choices).map(([module_id, enabled]) => ({ module_id, enabled })), at),
  ]);
}
export async function enqueue(f: F3Fixture, event = f.event) {
  return batch(f.env, integrationStatements({ source: event.source, expected_revision: event.source_revision - 1, events: [event], next_state: { snapshot: event.snapshot } }));
}
export const due = (f: F3Fixture) => exec(f.env, "UPDATE module_erp_delivery SET next_attempt_ms=0 WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile);
export const delivery = (f: F3Fixture, id = f.event.id) => one(f.env, "SELECT * FROM module_erp_delivery WHERE event_id=?", id);

/** Motor simulado só para testar transporte. Não confirma capacidade real B2. */
export function installFakeErp() {
  const receipts = new Map<string, IntegrationResult>(), requests = new Map<string, string>();
  const mutations: string[] = [];
  let loseReply = false;
  async function verify(env: Env, request: PreparedErpRequest) {
    const row = await one(env, "SELECT r.* FROM module_erp_requests r JOIN module_erp_events e ON e.id=r.event_id WHERE e.command_id=?", request.command_id);
    if (!row || row.request_hash !== hash(request) || row.actor_id !== request.actor_id || row.body_json !== canonical(request.body)) throw new Error("request_not_persisted");
    const old = requests.get(request.command_id);
    if (old && old !== hash(request)) throw new IntegrationError("idempotency_conflict", 409);
    requests.set(request.command_id, hash(request));
  }
  const result = (request: PreparedErpRequest, closed: boolean): IntegrationResult => {
    const requested = request.body.requested as { stock: boolean; finance: boolean } | undefined;
    return { command_id: request.command_id, seq: request.seq, replayed: false, outcome: closed ? "closed" : "applied",
      links: closed ? [] : [{ slot: `${request.source.component}:document`, kind: "document", id: uuid5(F3_NAMESPACES.origin, canonical(request.source)), version: request.seq }],
      effects: { stock: closed || !requested?.stock ? "not_requested" : "posted", finance: closed || !requested?.finance ? "not_requested" : "posted" }, reason_code: closed ? "epoch_closed" : null };
  };
  const apply = vi.spyOn(adapter, "applyErpRequest").mockImplementation(async (env, request) => {
    await verify(env, request);
    const previous = receipts.get(request.command_id);
    if (previous) return { ...previous, replayed: true };
    const next = result(request, false);
    receipts.set(request.command_id, next); mutations.push(request.command_id);
    if (loseReply) { loseReply = false; throw new Error("resposta perdida: conteúdo privado nunca registrado"); }
    return next;
  });
  const close = vi.spyOn(adapter, "closeErpCommand").mockImplementation(async (env, request) => {
    await verify(env, request);
    const previous = receipts.get(request.command_id);
    if (previous) return { ...previous, replayed: true };
    const next = result(request, true); receipts.set(request.command_id, next); return next;
  });
  const get = vi.spyOn(adapter, "getErpOrigin").mockImplementation(async (env, request) => {
    await verify(env, request);
    return { receipt: receipts.get(request.command_id) ?? null };
  });
  return { apply, close, get, receipts, requests, mutations, loseNextReply: () => { loseReply = true; } };
}
