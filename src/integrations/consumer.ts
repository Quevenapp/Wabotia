import { all, one } from "../db";
import type { Env } from "../types";
import { systemUserId } from "../modules/erp/identity";
import { readErpPartsState } from "../modules/erp/parts-state";
import type { IntegrationEvent, PreparedErpRequest } from "./contracts";
import { acquireIntegrationLease, confirmIntegrationResult, persistPreparedRequest, readPreparedRequest, renewIntegrationLease } from "./outbox";
import { applyErpRequest, closeErpCommand, getErpOrigin, prepareErpRequest } from "./erp-adapter";
import { readIntegrationActivation, eventEpochOpen, documentEpochOpen } from "./activation";
import { ensureCommercialPolicy } from "./policy";
import { integrationProducer } from "./registry";
import { IntegrationError, integer, logIntegrationError, sanitizedError } from "./privacy";
import { hash } from "./keys";
export const INTEGRATION_LEASE_MS = 60_000;
export const retryDelay = (attempts: number) => Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempts - 1));
export async function closureRequest(env: Env, event: IntegrationEvent): Promise<PreparedErpRequest> {
  return await readPreparedRequest(env, event) ?? {
    schema: 1, command_id: event.command_id, source: event.source, seq: event.seq,
    actor_id: await systemUserId(event.source.module), event_hash: hash(event), expected: {},
    body: { mode: "system", operation: event.operation, close_only: true },
  };
}
export async function releaseIntegrationLease(env: Env, eventId: string, token: string, error: unknown): Promise<void> {
  const safe = sanitizedError(error);
  const row = await one(env, "SELECT attempts FROM module_erp_delivery WHERE event_id=? AND lease_token=?", eventId, token);
  if (!row) return;
  const suspension = safe.code === "part_disabled" || safe.code === "erp_parts_unavailable";
  const retryable = safe.status >= 500 || safe.status === 429;
  const state = safe.code === "waiting_manual" ? "waiting_manual" : suspension ? "pending" : retryable ? row.attempts < 12 ? "pending" : "failed" : safe.status === 409 || safe.status === 422 ? "blocked" : "failed";
  await env.DB.prepare(`UPDATE module_erp_delivery SET state=?,next_attempt_ms=?,error_code=?,error_message=?,lease_token=NULL,lease_until_ms=NULL
    WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'`)
    .bind(state, Date.now() + (suspension ? 60_000 : retryDelay(row.attempts)), safe.code, safe.message, eventId, token, Date.now()).run();
}
async function attempt(env: Env, event: IntegrationEvent, token: string): Promise<void> {
  integrationProducer(event.source.module);
  let request = await readPreparedRequest(env, event);
  if (!request && event.reason_code === "manual_requested") throw new IntegrationError("waiting_manual", 409);
  // Recuperar o resultado ANTES de decidir por corte ou automação atual.
  if (request) {
    const remote = await getErpOrigin(env, request);
    if (remote.receipt) { await confirmIntegrationResult(env, event, token, remote.receipt); return; }
    if (request.body.mode === "human") throw new IntegrationError("waiting_manual", 409);
  }
  const state = await readIntegrationActivation(env, event.source.profile, event.source.module);
  if (!state.snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const maintenance = event.operation === "cancel" || event.operation === "reverse";
  const eligible = event.eligible;
  if (!eligible.document && !eligible.stock && !eligible.finance && !maintenance) throw new IntegrationError("part_disabled", 409);
  // Um pedido já preparado é indivisível: corte de qualquer destino solicitado
  // exige fechamento. Uma nova projeção autorizada pode continuar o outro.
  const requested = request?.body.requested as typeof eligible | undefined;
  const checked = requested ?? eligible;
  const ended = !maintenance && (
    !eventEpochOpen(event, state.activations, []) ||
    checked.stock && !eventEpochOpen(event, state.activations, ["erp-produtos", "erp-estoque"]) ||
    checked.finance && !eventEpochOpen(event, state.activations, ["erp-financeiro"]) ||
    checked.document && !documentEpochOpen(event, state.activations)
  );
  if (ended || request?.body.close_only) {
    request ??= await persistPreparedRequest(env, event, await closureRequest(env, event), token);
    const result = await closeErpCommand(env, request, "epoch_closed");
    await confirmIntegrationResult(env, event, token, result);
    return;
  }
  const policy = await ensureCommercialPolicy(env, event.source.profile);
  if (request && !maintenance && (requested?.stock && !policy.auto_post.stock || requested?.finance && !policy.auto_post.finance)) throw new IntegrationError("waiting_manual", 409);
  if (!request) {
    if (!eligible.document && (eligible.finance && !policy.auto_post.finance || eligible.stock && !policy.auto_post.stock)) throw new IntegrationError("waiting_manual", 409);
    request = await persistPreparedRequest(env, event, await prepareErpRequest(env, event), token);
  }
  if (!(await renewIntegrationLease(env, event.id, token))) throw new IntegrationError("lease_lost", 409);
  // Conta a tentativa de envio antes de enviar: queda também consome limite.
  const updated = await env.DB.prepare("UPDATE module_erp_delivery SET attempts=attempts+1 WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND attempts<12 AND state='sending'").bind(event.id, token, Date.now()).run();
  if (updated.meta.changes !== 1) throw new IntegrationError("integration_unavailable", 503);
  const result = await applyErpRequest(env, request);
  await confirmIntegrationResult(env, event, token, result);
}
export async function drainIntegrationOutbox(env: Env, profile: string, options: { limit?: number; budget_ms?: number } = {}): Promise<void> {
  const limit = Math.min(100, integer(options.limit ?? 20, 1)), deadline = Date.now() + Math.min(25_000, integer(options.budget_ms ?? 20_000, 1));
  // Nunca abre erp:<área>, nem promove cliente, quando Base está desligada.
  if (!(await readErpPartsState(env, profile)).snapshot.parts.customers) return;
  const rows = await all(env, `SELECT e.id,e.payload_json FROM module_erp_events e
    JOIN module_erp_delivery d ON d.event_id=e.id
    JOIN module_erp_sources s ON s.profile_id=e.profile_id AND s.module_id=e.module_id AND s.source_id=e.source_id
    WHERE e.profile_id=? AND e.seq=s.applied_seq+1 AND d.state IN ('pending','sending') AND d.next_attempt_ms<=?
      AND (d.lease_until_ms IS NULL OR d.lease_until_ms<=?)
    ORDER BY d.next_attempt_ms,e.id LIMIT ?`, profile, Date.now(), Date.now(), limit);
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    const token = await acquireIntegrationLease(env, row.id);
    if (!token) continue;
    try { await attempt(env, JSON.parse(row.payload_json), token); }
    catch (error) {
      await releaseIntegrationLease(env, row.id, token, error).catch(logIntegrationError);
      logIntegrationError(error);
    }
  }
}
