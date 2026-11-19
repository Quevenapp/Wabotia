import { effectiveSourceState } from "./state";
import type { Hono } from "hono";
import { all, batch, one } from "../db";
import type { Actor, Env } from "../types";
import { canProfile } from "../security";
import { requireAccess } from "../access";
import { modulesApi } from "../modules/api";
import { erpRoleOf } from "../modules/erp/identity";
import type { Destination, IntegrationEvent, IntegrationModule, SourceRef, Statement } from "./contracts";
import { INTEGRATION_MODULES, integrationProducer } from "./registry";
import { commercialPolicyView, ensureCommercialPolicy, initializeCommercialPolicy, patchCommercialPolicy, requireIntegrationHuman, requirePolicyAccess, humanReferenceRpc } from "./policy";
import { readIntegrationActivation } from "./activation";
import { acquireIntegrationLease, confirmIntegrationResult, integrationCasGuard, integrationStatements, persistPreparedRequest, readPreparedRequest, sourceBindings } from "./outbox";
import { authorizeManual, closeErpCommand, getErpOrigin, manualApplyErpRequest, prepareManualErpRequest } from "./erp-adapter";
import { closureRequest, countIntegrationAttempt, releaseIntegrationLease } from "./consumer";
import { saveCatalogLink } from "./catalog";
import { canonical, commandId, hash, uuid5, F3_NAMESPACES } from "./keys";
import { exactKeys, integer, IntegrationError, opaque, sanitizedError, validateSnapshot } from "./privacy";
import { reverseCommercialReceipt } from "./receipts";

const writes = [
  ["PATCH", "/commercial-policy", "policy.patch"], ["POST", "/commercial-policy/initialize", "policy.initialize"],
  ["POST", "/:module/sources/:id/retry", "retry"], ["POST", "/:module/sources/:id/replace", "replace"], ["POST", "/:module/sources/:id/post", "post"],
  ["PUT", "/:module/catalog/:kind/:id/:component", "catalog.put"], ["DELETE", "/:module/catalog/:kind/:id/:component", "catalog.delete"],
  ["POST", "/receipts/:id/reverse", "receipt.reverse"],
] as const;
const resourceRoutes = [
  ["GET", "/commercial-policy"], ["GET", "/document-origins"],
  ["GET", "/:module/status"], ["GET", "/:module/sources/:id"], ...writes,
].map(([method, path]) => ({ method, pattern: new RegExp(`^integrations${path.replace(/:[a-z]+/g, "[^/]+")}$`) }));
/** Só estas rotas delegam ao autorizador de recurso/destino da F3. */
export const integrationResourceRoute = (method: string, path: string) => resourceRoutes.some(route => route.method === method && route.pattern.test(path));
export const integrationOperation = (operation: string) => writes.some(([, , op]) => operation === `integration.${op}`);

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
  requireAccess(actor, source.module);
  const row = await one(env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
  const rows = await all(env, `SELECT e.id,e.seq,d.state,d.unresolved,d.error_code,d.completed_ms,d.receipt_json,
    json_extract(e.payload_json,'$.eligible') eligible,json_extract(e.payload_json,'$.operation') operation,
    json_extract(e.payload_json,'$.source.component') component
    FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND e.module_id=? AND e.source_id=? ORDER BY e.source_revision,e.seq`, ...sourceBindings(source));
  const { manual, ...status } = effectiveSourceState(rows, !!row?.replacement_key);
  const deliveries = rows.map(({ receipt_json, eligible, operation, component, ...d }) => d);
  return { source, revision: row?.revision ?? 0, confirmed_ms: row?.confirmed_ms ?? null, ...status,
    applied: status.applied.filter(d => d !== "finance" || financiallyVisible(actor)),
    manual_destinations: [...manual].filter(d => d === "finance" ? financiallyVisible(actor) : ["admin", "estoque"].includes(erpRoleOf(actor) ?? "")),
    deliveries: financiallyVisible(actor) ? deliveries : deliveries.map(d => ({ id: d.id, state: d.state, completed_ms: d.completed_ms })),
    links: (JSON.parse(row?.links_json ?? "[]") as any[]).filter(l => financiallyVisible(actor) || l.kind === "document") };
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
  const delivery = await one(env, "SELECT error_code FROM module_erp_delivery WHERE event_id=?", event.id);
  if (delivery?.error_code === "integration_divergent") throw new IntegrationError("integration_divergent", 409);
  const result = { event_id: event.id, accepted: true };
  await batch(env, [
    ["UPDATE module_erp_delivery SET state=CASE WHEN unresolved=1 THEN 'uncertain' ELSE 'pending' END,attempts=CASE WHEN unresolved=1 THEN attempts ELSE 0 END,preparation_attempts=0,lookup_attempts=0,next_attempt_ms=?,error_code=NULL,error_message=NULL WHERE event_id=? AND state<>'done' AND (lease_until_ms IS NULL OR lease_until_ms<=?)", [Date.now(), event.id, Date.now()]], receipt.finish(result),
  ]);
  return result;
}
/** Reserva a projeção e bloqueia a origem ANTES de qualquer fechamento. O
 * plano sobrevive a queda; a instalação e a confirmação D1 são um lote único.
 * Sucessores exigem revisão explícita, sem fechar ou renumerar fatos imutáveis. */
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
    const row = await one(env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
    const delivery = await one(env, "SELECT state,receipt_json,error_code FROM module_erp_delivery WHERE event_id=?", old.id);
    if (delivery.error_code === "integration_divergent") throw new IntegrationError("integration_divergent", 409);
    if (row.replacement_key && row.replacement_key !== newKey) throw new IntegrationError("correction_in_progress", 409);
    if (row.replacement_key === newKey) next = JSON.parse(row.replacement_json);
    else {
      if (manual && row.revision !== integer(data.version, 1)) throw new IntegrationError("version_conflict", 409);
      // Validar todos os bloqueadores antes de consumir a identidade original.
      if (row.enqueued_seq !== (old.seq ?? 0)) throw new IntegrationError("replacement_successors", 409);
      if (delivery.state !== "done" && row.applied_seq !== old.seq! - 1 || delivery.state === "done" && row.applied_seq !== row.enqueued_seq)
        throw new IntegrationError("version_conflict", 409);
      if (!manual && delivery.state === "done" && (!delivery.receipt_json || JSON.parse(delivery.receipt_json).outcome !== "closed")) throw new IntegrationError("version_conflict", 409);
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
      // Valida também o SQL/plano antes da reserva durável.
      integrationStatements({ source: old.source, expected_revision: row.revision, events: [next], next_state: { snapshot: next.snapshot }, replacement_key: newKey, automation_from: manual ? undefined : old.id });
      await batch(env, [[`UPDATE module_erp_sources SET replacement_key=?,replacement_json=?
        WHERE profile_id=? AND module_id=? AND source_id=? AND revision=? AND enqueued_seq=? AND applied_seq=? AND replacement_key IS NULL
        AND NOT EXISTS(SELECT 1 FROM module_erp_delivery WHERE event_id=? AND lease_until_ms>?)`,
        [newKey, canonical(next), ...sourceBindings(source), row.revision, row.enqueued_seq, row.applied_seq, old.id, Date.now()]], integrationCasGuard]);
    }
    const clear: Statement = ["UPDATE module_erp_sources SET replacement_key=NULL,replacement_json=NULL WHERE profile_id=? AND module_id=? AND source_id=? AND replacement_key=?", [...sourceBindings(source), newKey]];
    const install = [...integrationStatements({ source: old.source, expected_revision: next.source_revision - 1, events: [next], next_state: { snapshot: next.snapshot }, replacement_key: newKey, automation_from: manual ? undefined : old.id }), clear, integrationCasGuard];
    if (delivery.state !== "done") {
      const lease = await acquireIntegrationLease(env, old.id, Date.now(), true, newKey);
      if (!lease) throw new IntegrationError("lease_lost", 409);
      try {
        const request = await readPreparedRequest(env, old) ?? await persistPreparedRequest(env, old, await closureRequest(env, old), lease);
        const deadline = Date.now() + 25_000;
        await countIntegrationAttempt(env, old, lease, "lookup_attempts", deadline);
        const recovered = await getErpOrigin(env, request, actor, deadline);
        if (!recovered.receipt) await countIntegrationAttempt(env, old, lease, "attempts", deadline);
        const result = recovered.receipt ?? await closeErpCommand(env, request, manual ? "manual_requested" : data.reason_code, actor, deadline);
        const canReplace = manual || result.outcome === "closed";
        await confirmIntegrationResult(env, old, lease, result, canReplace ? install : [clear, integrationCasGuard]);
        if (!canReplace) throw new IntegrationError("version_conflict", 409);
      } catch (error) { await releaseIntegrationLease(env, old.id, lease, error); throw error; }
    } else await batch(env, install);
  }
  if (manual) {
    const delivery = await one(env, "SELECT state FROM module_erp_delivery WHERE event_id=?", next.id);
    if (delivery.state !== "done") {
      const lease = await acquireIntegrationLease(env, next.id, Date.now(), true);
      if (!lease) throw new IntegrationError("lease_lost", 409);
      try {
        const request = await readPreparedRequest(env, next) ?? await persistPreparedRequest(env, next, await prepareManualErpRequest(env, next, actor, destinations), lease);
        const deadline = Date.now() + 25_000;
        await countIntegrationAttempt(env, next, lease, "lookup_attempts", deadline);
        const recovered = await getErpOrigin(env, request, actor, deadline);
        if (!recovered.receipt) await countIntegrationAttempt(env, next, lease, "attempts", deadline);
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
  if (op !== "integration.post") requireAccess(actor, data.module);
  const source: SourceRef = { profile, module: data.module, source_id: opaque(data.id),
    component: op.startsWith("integration.catalog.") ? `catalog:${opaque(data.kind)}:${opaque(data.component)}` : "main" };
  if (["integration.retry", "integration.replace", "integration.post"].includes(op)) exactKeys(data,
    ["module", "id", "event_id", ...(op === "integration.replace" ? ["reason_code"] : op === "integration.post" ? ["destinations", "version"] : [])]);
  // A OS revalida a escrita no lote do vínculo. O replay já confirmado é
  // autorizado para leitura, mesmo que o trabalho tenha congelado depois.
  const workCatalog = source.module === "os" && op.startsWith("integration.catalog.");
  await authorizeIntegrationSource(env, actor, source, op !== "integration.post" && !workCatalog);
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
    return c.json(commercialPolicyView(await ensureCommercialPolicy(c.env, profile), c.get("actor")));
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
        await humanReferenceRpc(c.env, actor, profile, "erp_document_get", { p_kind: source.module === "os" ? "service_orders" : "sales_orders", p_id: document.id });
      } catch { continue; /* Nem o documento é visível para esta pessoa. */ }
      try {
        requireAccess(actor, source.module);
        await authorizeIntegrationSource(c.env, actor, source);
        data.push({ document_id: document.id, source, readonly: true });
      } catch {
        // A pessoa pode ler o documento, mas não a origem operacional.
        data.push({ document_id: document.id, source: null, readonly: true });
      }
    }
    return c.json({ data });
  });
  app.get(`${prefix}/:module/status`, async c => {
    const profile = c.req.param("profile")!, module = c.req.param("module") as IntegrationModule, actor = c.get("actor") as Actor;
    requireIntegrationHuman(actor, profile); requireAccess(actor, module);
    if (!INTEGRATION_MODULES.includes(module)) throw new IntegrationError("not_found", 404);
    const activation = await readIntegrationActivation(c.env, profile, module);
    const rows = await all(c.env, `SELECT e.source_id,s.replacement_key,d.state,d.unresolved,d.error_code,d.receipt_json,
      json_extract(e.payload_json,'$.eligible') eligible,json_extract(e.payload_json,'$.operation') operation,
      json_extract(e.payload_json,'$.source.component') component
      FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id
      JOIN module_erp_sources s ON s.profile_id=e.profile_id AND s.module_id=e.module_id AND s.source_id=e.source_id
      WHERE e.profile_id=? AND e.module_id=? ORDER BY e.source_id,e.source_revision,e.seq`, profile, module);
    const sources = new Map<string, any[]>();
    for (const row of rows) { const values = sources.get(row.source_id) ?? []; values.push(row); sources.set(row.source_id, values); }
    const counts = new Map<string, number>();
    for (const rows of sources.values()) { const { state } = effectiveSourceState(rows, !!rows[0].replacement_key); counts.set(state, (counts.get(state) ?? 0) + 1); }
    const counters = [...counts].map(([state, count]) => ({ state, count }));
    return c.json({ module, activations: activation.activations, counters });
  });
  app.get(`${prefix}/:module/sources/:id`, async c => c.json(await integrationSourceView(c.env, c.get("actor"), { profile: c.req.param("profile")!, module: c.req.param("module") as IntegrationModule, source_id: c.req.param("id"), component: "main" })));
  for (const [method, path, op] of writes) app.on(method, `${prefix}${path}`, async c => {
    try {
      const data = await c.req.json().catch(() => ({}));
      return await mutate(c, `integration.${op}`, c.req.param("profile")!, { ...data, ...Object.fromEntries(Object.entries(c.req.param()).filter(([k]) => k !== "profile")) });
    } catch (error) { const safe = sanitizedError(error); return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status }); }
  });
}
