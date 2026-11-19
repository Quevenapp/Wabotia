import type { Hono } from "hono";
import { all, batch, one } from "../db";
import type { Actor, Env } from "../types";
import { canProfile } from "../security";
import { requireAccess } from "../access";
import { modulesApi } from "../modules/api";
import { erpRoleOf } from "../modules/erp/identity";
import type { Destination, IntegrationEvent, IntegrationModule, SourceRef, Statement } from "./contracts";
import { INTEGRATION_MODULES, integrationProducer } from "./registry";
import { ensureCommercialPolicy, initializeCommercialPolicy, patchCommercialPolicy, requireIntegrationHuman, requirePolicyAccess, humanReferenceRpc } from "./policy";
import { readIntegrationActivation } from "./activation";
import { acquireIntegrationLease, confirmIntegrationResult, integrationStatements, persistPreparedRequest, readPreparedRequest, sourceBindings } from "./outbox";
import { authorizeManual, closeErpCommand, getErpOrigin, manualApplyErpRequest, prepareManualErpRequest } from "./erp-adapter";
import { closureRequest, releaseIntegrationLease } from "./consumer";
import { saveCatalogLink } from "./catalog";
import { canonical, commandId, hash, uuid5, F3_NAMESPACES } from "./keys";
import { exactKeys, integer, IntegrationError, opaque, sanitizedError, validateSnapshot } from "./privacy";
import { reverseCommercialReceipt } from "./receipts";

export async function authorizeIntegrationSource(env: Env, actor: Actor, source: SourceRef, write = false) {
  if (!canProfile(actor, source.profile)) throw new IntegrationError("not_found", 404);
  const producer = integrationProducer(source.module), ctx = modulesApi(env, source.profile, source.module);
  await producer.authorizeSource(ctx, actor, source, write);
  return { producer, ctx };
}
const financiallyVisible = (actor: Actor) => ["admin", "financeiro"].includes(erpRoleOf(actor) ?? "");
async function sourceEvent(env: Env, source: SourceRef, id: unknown): Promise<IntegrationEvent> {
  const row = await one(env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id=? AND source_id=? AND id=?", ...sourceBindings(source), opaque(id));
  if (!row) throw new IntegrationError("not_found", 404);
  return JSON.parse(row.payload_json);
}
export async function integrationSourceView(env: Env, actor: Actor, source: SourceRef) {
  await authorizeIntegrationSource(env, actor, source);
  const row = await one(env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
  if (!row) throw new IntegrationError("not_found", 404);
  const rows = await all(env, `SELECT e.id,e.seq,d.state,d.error_code,d.completed_ms,d.receipt_json,
    json_extract(e.payload_json,'$.eligible') eligible,json_extract(e.payload_json,'$.operation') operation
    FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND e.module_id=? AND e.source_id=? ORDER BY e.seq`, ...sourceBindings(source));
  // O transporte pode estar concluído e um destino ainda aguardar uma pessoa.
  // O recibo posterior de postagem/reversão resolve a pendência desse destino.
  const manual = new Set<Destination>();
  let review = false;
  for (const d of rows) if (d.receipt_json) {
    const result = JSON.parse(d.receipt_json), eligible = JSON.parse(d.eligible);
    review = result.outcome === "closed";
    for (const destination of ["stock", "finance"] as const) {
      if (["posted", "settled", "reversed"].includes(result.effects[destination])) manual.delete(destination);
      else if (eligible[destination] && ["execute", "recognize", "receive"].includes(d.operation) && result.outcome !== "closed") manual.add(destination);
    }
  }
  const deliveries = rows.map(({ receipt_json, eligible, operation, ...d }) => d);
  const state = deliveries.some(d => d.state !== "done") ? deliveries.find(d => d.state !== "done")!.state : review ? "blocked" : manual.size ? "waiting_manual" : "done";
  return { source, revision: row.revision, confirmed_ms: row.confirmed_ms, state, pending: state !== "done",
    manual_destinations: [...manual].filter(d => d === "finance" ? financiallyVisible(actor) : ["admin", "estoque"].includes(erpRoleOf(actor) ?? "")),
    deliveries: financiallyVisible(actor) ? deliveries : deliveries.map(d => ({ id: d.id, state: d.state, completed_ms: d.completed_ms })),
    links: (JSON.parse(row.links_json) as any[]).filter(l => financiallyVisible(actor) || l.kind === "document") };
}
function receiptScope(profile: string, actor: Actor, operation: string) { return `f3:${profile}:${actor.id}:${operation}`; }
async function reserve(env: Env, profile: string, actor: Actor, op: string, key: string, data: unknown) {
  const scope = receiptScope(profile, actor, op), fingerprint = hash(data);
  await batch(env, [["INSERT OR IGNORE INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)", [scope, key, fingerprint, Date.now()]]]);
  const row = await one(env, "SELECT * FROM receipts WHERE scope=? AND key=?", scope, key);
  if (row.fingerprint !== fingerprint) throw new IntegrationError("idempotency_conflict", 409);
  return { previous: row.response ? JSON.parse(row.response) : null,
    finish: (result: unknown): Statement => ["UPDATE receipts SET response=?,status=202 WHERE scope=? AND key=? AND fingerprint=?", [canonical(result), scope, key, fingerprint]] };
}
async function retry(env: Env, actor: Actor, source: SourceRef, data: any, key: string) {
  const event = await sourceEvent(env, source, data.event_id);
  const receipt = await reserve(env, source.profile, actor, "retry", key, { source, event_id: event.id });
  if (receipt.previous) return receipt.previous;
  const result = { event_id: event.id, accepted: true };
  await batch(env, [
    ["UPDATE module_erp_delivery SET state='pending',attempts=0,next_attempt_ms=?,error_code=NULL,error_message=NULL WHERE event_id=? AND state<>'done' AND (lease_until_ms IS NULL OR lease_until_ms<=?)", [Date.now(), event.id, Date.now()]], receipt.finish(result),
  ]);
  return result;
}
/** Fecha a identidade antiga antes de projetar outro corpo. Em caso de queda,
 * o recibo ERP e a chave local permitem retomar sem trocar pedido incerto. */
async function replace(env: Env, actor: Actor, source: SourceRef, data: any, key: string, manual = false) {
  const { producer, ctx } = await authorizeIntegrationSource(env, actor, source, !manual);
  const old = await sourceEvent(env, source, data.event_id);
  const destinations: Destination[] = manual ? data.destinations : [];
  if (manual && (!Array.isArray(destinations) || !destinations.length || destinations.some(d => d !== "stock" && d !== "finance"))) throw new IntegrationError("invalid_request", 400);
  if (manual) authorizeManual(actor, source.profile, destinations);
  if (!manual && (typeof data.reason_code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(data.reason_code))) throw new IntegrationError("invalid_request", 400);
  const receipt = await reserve(env, source.profile, actor, manual ? "post" : "replace", key, { source, data });
  if (receipt.previous) return receipt.previous;
  const newKey = `wb:replacement:${hash([source, key, actor.id, manual])}`;
  const installed = await one(env, "SELECT id,payload_json FROM module_erp_events WHERE profile_id=? AND event_key=?", source.profile, newKey);
  let next: IntegrationEvent;
  if (installed) next = JSON.parse(installed.payload_json);
  else {
    if (manual) {
      integer(data.version, 1);
      const current = await one(env, "SELECT revision FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
      if (current?.revision !== data.version) throw new IntegrationError("version_conflict", 409);
    }
    const delivery = await one(env, "SELECT state,receipt_json FROM module_erp_delivery WHERE event_id=?", old.id);
    if (delivery.state !== "done") {
      const lease = await acquireIntegrationLease(env, old.id, Date.now(), true);
      if (!lease) throw new IntegrationError("lease_lost", 409);
      try {
        const request = await readPreparedRequest(env, old) ?? await persistPreparedRequest(env, old, await closureRequest(env, old), lease);
        const recovered = await getErpOrigin(env, request, actor);
        const result = recovered.receipt ?? await closeErpCommand(env, request, manual ? "manual_requested" : data.reason_code, actor);
        await confirmIntegrationResult(env, old, lease, result);
        if (!manual && result.outcome !== "closed") throw new IntegrationError("version_conflict", 409);
      } catch (error) { await releaseIntegrationLease(env, old.id, lease, error); throw error; }
    } else if (!manual && JSON.parse(delivery.receipt_json).outcome !== "closed") throw new IntegrationError("version_conflict", 409);
    const row = await one(env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
    if (row.applied_seq !== row.enqueued_seq || row.enqueued_seq !== old.seq) throw new IntegrationError("version_conflict", 409);
    const snapshot = await producer.project(ctx, old.source);
    validateSnapshot(snapshot);
    if (canonical(snapshot.source) !== canonical(old.source)) throw new IntegrationError("not_found", 404);
    const state = await readIntegrationActivation(env, source.profile, source.module);
    const seq = row.enqueued_seq + 1, revision = row.revision + 1;
    next = { ...old, id: uuid5(F3_NAMESPACES.internal, newKey), command_id: commandId(source, seq), event_key: newKey,
      seq, source_revision: revision, snapshot: { ...snapshot, source_revision: revision },
      actor_id: actor.id, reason_code: manual ? "manual_requested" : data.reason_code,
      ...(manual ? { occurred_ms: Date.now(), epochs: state.epochs,
        eligible: { document: old.eligible.document, stock: destinations.includes("stock") && state.snapshot.parts.stock, finance: destinations.includes("finance") && state.snapshot.parts.finance } } : {}),
    };
    if (manual && destinations.some(d => !next.eligible[d])) throw new IntegrationError("part_disabled", 409);
    await batch(env, integrationStatements({ source: old.source, expected_revision: row.revision, events: [next], next_state: { snapshot: next.snapshot } }));
  }
  if (manual) {
    const delivery = await one(env, "SELECT state FROM module_erp_delivery WHERE event_id=?", next.id);
    if (delivery.state !== "done") {
      const lease = await acquireIntegrationLease(env, next.id, Date.now(), true);
      if (!lease) throw new IntegrationError("lease_lost", 409);
      try {
        const request = await readPreparedRequest(env, next) ?? await persistPreparedRequest(env, next, await prepareManualErpRequest(env, next, actor, destinations), lease);
        const recovered = await getErpOrigin(env, request, actor);
        const result = recovered.receipt ?? await manualApplyErpRequest(env, request, actor);
        await confirmIntegrationResult(env, next, lease, result);
      } catch (error) { await releaseIntegrationLease(env, next.id, lease, error); throw error; }
    }
  }
  const result = { event_id: next.id, accepted: true };
  await batch(env, [receipt.finish(result)]);
  return result;
}
export async function integrationCommand(env: Env, actor: Actor, profile: string, op: string, data: any, key: string): Promise<any> {
  requireIntegrationHuman(actor, profile);
  if (op === "integration.policy.patch") return patchCommercialPolicy(env, actor, profile, data, key);
  if (op === "integration.policy.initialize") return initializeCommercialPolicy(env, actor, profile, data, key);
  if (op === "integration.receipt.reverse") return reverseCommercialReceipt(env, actor, profile, data, key);
  if (!INTEGRATION_MODULES.includes(data.module)) throw new IntegrationError("not_found", 404);
  const source: SourceRef = { profile, module: data.module, source_id: opaque(data.id),
    component: op.startsWith("integration.catalog.") ? `catalog:${opaque(data.kind)}:${opaque(data.component)}` : "main" };
  if (["integration.retry", "integration.replace", "integration.post"].includes(op)) exactKeys(data,
    ["module", "id", "event_id", ...(op === "integration.replace" ? ["reason_code"] : op === "integration.post" ? ["destinations", "version"] : [])]);
  await authorizeIntegrationSource(env, actor, source, op !== "integration.post");
  if (op === "integration.retry") return retry(env, actor, source, data, key);
  if (op === "integration.replace" || op === "integration.post") return replace(env, actor, source, data, key, op === "integration.post");
  if (op === "integration.catalog.put" || op === "integration.catalog.delete") return saveCatalogLink(env, actor, source, data.kind, data.id, data.component, op.endsWith("delete") ? null : data.erp_item_id, data.version, key);
  throw new IntegrationError("integration_not_implemented");
}
export function registerIntegrationRoutes(app: Hono<any>, mutate: (c: any, op: string, profile: string, data: any) => Promise<Response>) {
  const prefix = "/api/v1/profiles/:profile/integrations";
  app.use(`${prefix}/*`, async (c, next) => {
    try { await next(); }
    catch (error) { const safe = sanitizedError(error); return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status }); }
  });
  // Nomes estáticos precedem :module; as rotas comuns não exigem módulo novo.
  app.get(`${prefix}/commercial-policy`, async c => {
    const profile = c.req.param("profile")!; requirePolicyAccess(c.get("actor"), profile);
    return c.json(await ensureCommercialPolicy(c.env, profile));
  });
  app.get(`${prefix}/document-origins`, async c => {
    const profile = c.req.param("profile")!, actor = c.get("actor") as Actor;
    requireIntegrationHuman(actor, profile);
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
    if (ids.length > 50) throw new IntegrationError("invalid_request", 400);
    const links = await all(c.env, `SELECT s.module_id,s.source_id,j.value link FROM module_erp_sources s,json_each(s.links_json) j
      WHERE s.profile_id=? AND json_extract(j.value,'$.kind')='document' AND json_extract(j.value,'$.id') IN (SELECT value FROM json_each(?))`, profile, JSON.stringify(ids));
    const data = [];
    for (const link of links) {
      const source: SourceRef = { profile, module: link.module_id, source_id: link.source_id, component: "main" }, document = JSON.parse(link.link);
      try {
        await authorizeIntegrationSource(c.env, actor, source);
        await humanReferenceRpc(c.env, actor, profile, "erp_document_get", { p_kind: source.module === "os" ? "service_orders" : "sales_orders", p_id: document.id });
        data.push({ document_id: document.id, source, readonly: true });
      } catch { /* Não revelar origem de documento que a pessoa não pode ler. */ }
    }
    return c.json({ data });
  });
  app.get(`${prefix}/:module/status`, async c => {
    const profile = c.req.param("profile")!, module = c.req.param("module") as IntegrationModule, actor = c.get("actor") as Actor;
    requireIntegrationHuman(actor, profile); requireAccess(actor, module);
    if (!INTEGRATION_MODULES.includes(module)) throw new IntegrationError("not_found", 404);
    const activation = await readIntegrationActivation(c.env, profile, module);
    const counters = await all(c.env, "SELECT d.state,count(*) count FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND e.module_id=? GROUP BY d.state", profile, module);
    return c.json({ module, activations: activation.activations, counters });
  });
  app.get(`${prefix}/:module/sources/:id`, async c => c.json(await integrationSourceView(c.env, c.get("actor"), { profile: c.req.param("profile")!, module: c.req.param("module") as IntegrationModule, source_id: c.req.param("id"), component: "main" })));
  const writes = [
    ["PATCH", "/commercial-policy", "policy.patch"], ["POST", "/commercial-policy/initialize", "policy.initialize"],
    ["POST", "/:module/sources/:id/retry", "retry"], ["POST", "/:module/sources/:id/replace", "replace"], ["POST", "/:module/sources/:id/post", "post"],
    ["PUT", "/:module/catalog/:kind/:id/:component", "catalog.put"], ["DELETE", "/:module/catalog/:kind/:id/:component", "catalog.delete"],
    ["POST", "/receipts/:id/reverse", "receipt.reverse"],
  ];
  for (const [method, path, op] of writes) app.on(method, `${prefix}${path}`, async c => {
    try {
      const data = await c.req.json().catch(() => ({}));
      return await mutate(c, `integration.${op}`, c.req.param("profile")!, { ...data, ...Object.fromEntries(Object.entries(c.req.param()).filter(([k]) => k !== "profile")) });
    } catch (error) { const safe = sanitizedError(error); return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status }); }
  });
}
