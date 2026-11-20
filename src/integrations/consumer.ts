import { all, one } from "../db";
import type { Env } from "../types";
import { systemUserId } from "../modules/erp/identity";
import { readErpPartsState } from "../modules/erp/parts-state";
import type { DeliveryIntegrationState, IntegrationEvent, PreparedErpRequest } from "./contracts";
import { acquireIntegrationLease, confirmIntegrationResult, persistPreparedRequest, readPreparedRequest, renewIntegrationLease } from "./outbox";
import { applyErpRequest, closeErpCommand, getErpOrigin, prepareErpRequest } from "./erp-adapter";
import { readIntegrationActivation, eventEpochOpen, documentEpochOpen } from "./activation";
import { integrationProducer } from "./registry";
import { IntegrationError, integer, logIntegrationError, sanitizedError } from "./privacy";
import { hash } from "./keys";
import { eventAutomation } from "./automation";
import { checkDeadline, withinDeadline } from "./deadline";
export const INTEGRATION_LEASE_MS = 60_000;
export const retryDelay = (attempts: number) => Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempts - 1));
export async function closureRequest(env: Env, event: IntegrationEvent): Promise<PreparedErpRequest> {
  if (event.seq === null) throw new IntegrationError("invalid_request", 400);
  return await readPreparedRequest(env, event) ?? {
    schema: 1, command_id: event.command_id, source: event.source, seq: event.seq,
    actor_id: await systemUserId(event.source.module), event_hash: hash(event), expected: {},
    body: { mode: "system", operation: event.operation, close_only: true },
  };
}
export async function releaseIntegrationLease(env: Env, eventId: string, token: string, error: unknown): Promise<void> {
  const safe = sanitizedError(error);
  const row = await one(env, "SELECT * FROM module_erp_delivery WHERE event_id=? AND lease_token=?", eventId, token);
  if (!row) return;
  const suspension = safe.code === "part_disabled" || safe.code === "erp_parts_unavailable";
  const retryable = safe.status >= 500 || safe.status === 429;
  const uncertain = !!row.unresolved && (retryable || safe.code === "waiting_manual");
  const state: DeliveryIntegrationState = safe.code === "integration_divergent" ? "blocked" : uncertain ? (row.attempts >= 12 || row.lookup_attempts >= 12 || row.preparation_attempts >= 12 || safe.code === "waiting_manual" ? "uncertain" : "pending")
    : safe.code === "waiting_manual" ? "waiting_manual" : suspension ? "pending"
    : retryable ? Math.max(row.preparation_attempts, row.lookup_attempts, row.attempts) >= 12 ? "failed" : "pending"
    : safe.status === 409 || safe.status === 422 ? "blocked" : "failed";
  const delay = retryDelay(Math.max(row.preparation_attempts, row.lookup_attempts, row.attempts));
  await env.DB.prepare(`UPDATE module_erp_delivery SET state=?,next_attempt_ms=?,error_code=?,error_message=?,unresolved=?,lease_token=NULL,lease_until_ms=NULL
    WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'`)
    .bind(state, Date.now() + (suspension ? 60_000 : delay), state === "uncertain" ? "integration_uncertain" : safe.code,
      state === "uncertain" ? new IntegrationError("integration_uncertain").message : safe.message,
      uncertain || suspension && row.unresolved ? 1 : 0, eventId, token, Date.now()).run();
}
export async function countIntegrationAttempt(env: Env, event: IntegrationEvent, token: string, column: "attempts" | "preparation_attempts" | "lookup_attempts", deadline: number) {
  checkDeadline(deadline);
  const result = await env.DB.prepare(`UPDATE module_erp_delivery SET ${column}=${column}+1${column === "attempts" ? ",unresolved=1" : ""}
    WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending' AND ${column}<12`)
    .bind(event.id, token, Date.now()).run();
  if (result.meta.changes !== 1) throw new IntegrationError("integration_unavailable", 503);
}

async function countInitialAttempt(env: Env, event: IntegrationEvent, token: string, deadline: number) {
  checkDeadline(deadline);
  // Contar antes de ler o corpo: essa leitura também pode falhar ou expirar.
  // Pedido persistido inicia consulta, inclusive após esgotar a preparação ou
  // o envio; assim o limite local nunca impede recuperar um recibo remoto.
  const prepared = "EXISTS(SELECT 1 FROM module_erp_requests r WHERE r.event_id=module_erp_delivery.event_id)";
  const result = await env.DB.prepare(`UPDATE module_erp_delivery SET
      preparation_attempts=preparation_attempts+CASE WHEN ${prepared} THEN 0 ELSE 1 END,
      lookup_attempts=lookup_attempts+CASE WHEN ${prepared} THEN 1 ELSE 0 END
    WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'
      AND CASE WHEN ${prepared} THEN lookup_attempts ELSE preparation_attempts END<12
    RETURNING ${prepared} AS prepared`)
    .bind(event.id, token, Date.now()).all<{ prepared: number }>();
  if (result.meta.changes !== 1) throw new IntegrationError("integration_unavailable", 503);
  return result.results[0].prepared ? "lookup_attempts" : "preparation_attempts";
}

async function attempt(env: Env, event: IntegrationEvent, token: string, deadline: number): Promise<void> {
  const counts = { preparation_attempts: 0, lookup_attempts: 0 };
  counts[await countInitialAttempt(env, event, token, deadline)]++;
  try { await attemptCounted(env, event, token, deadline, counts); }
  catch (error) {
    // Só suspensão confirmada devolve o crédito desta passagem. Nenhum envio
    // incerto é zerado, e indisponibilidade de leitura continua sendo falha.
    if (sanitizedError(error).code === "part_disabled") await env.DB.prepare(`UPDATE module_erp_delivery
      SET preparation_attempts=preparation_attempts-?,lookup_attempts=lookup_attempts-CASE WHEN unresolved=0 THEN ? ELSE 0 END
      WHERE event_id=? AND lease_token=? AND state='sending' AND lease_until_ms>?`)
      .bind(counts.preparation_attempts, counts.lookup_attempts, event.id, token, Date.now()).run();
    throw error;
  }
}
async function attemptCounted(env: Env, event: IntegrationEvent, token: string, deadline: number, counts: { preparation_attempts: number; lookup_attempts: number }): Promise<void> {
  integrationProducer(event.source.module);
  let request = await readPreparedRequest(env, event);
  const source = ["receive", "lifecycle"].includes(event.operation) ? await one(env, "SELECT links_json FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", event.source.profile, event.source.module, event.source.source_id) : null;
  const linked = JSON.parse(source?.links_json ?? "[]");
  const historicalReceive = event.operation === "receive" && linked.some((l: any) => l.kind === "title");
  const maintenance = event.operation === "cancel" || event.operation === "reverse" || event.operation === "lifecycle" && linked.some((l: any) => l.kind === "document");
  // Alguns produtores antigos marcaram manutenção como manual ao desligar
  // auto_post. Isso não pode impedir estorno histórico. A ação humana criada
  // pela rota /post, porém, continua reservada àquela pessoa.
  if (!request && event.reason_code === "manual_requested" && (!maintenance || event.event_key.startsWith("wb:replacement:")))
    throw new IntegrationError("waiting_manual", 409);
  // Recuperar o resultado ANTES de decidir por corte ou automação atual.
  if (request) {
    const remote = await getErpOrigin(env, request, undefined, deadline);
    checkDeadline(deadline);
    if (remote.receipt) { await confirmIntegrationResult(env, event, token, remote.receipt); return; }
    const sent = await one(env, "SELECT attempts,preparation_attempts,unresolved FROM module_erp_delivery WHERE event_id=?", event.id);
    // Mesmo após o último envio, só consultar o recibo da identidade original.
    // Ausência momentânea não prova que uma chamada em voo foi abortada.
    if (sent.attempts >= 12 || sent.preparation_attempts >= 12) throw new IntegrationError("integration_unavailable", 503);
    if (request.body.mode === "human" && sent.unresolved) throw new IntegrationError("integration_unavailable", 503);
    await env.DB.prepare("UPDATE module_erp_delivery SET lookup_attempts=0 WHERE event_id=? AND lease_token=?").bind(event.id, token).run();
    counts.lookup_attempts = 0; // Consulta concluída: esse crédito já foi devolvido.
    if (request.body.mode === "human") throw new IntegrationError("waiting_manual", 409);
    await countIntegrationAttempt(env, event, token, "preparation_attempts", deadline);
    counts.preparation_attempts++;
  }
  const state = await readIntegrationActivation(env, event.source.profile, event.source.module);
  if (!state.snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const eligible = event.eligible;
  if (event.seq === null) throw new IntegrationError("invalid_request", 400);
  // Um pedido já preparado é indivisível: corte de qualquer destino solicitado
  // exige fechamento. Uma nova projeção autorizada pode continuar o outro.
  const requested = request?.body.requested as typeof eligible | undefined;
  const checked = requested ?? eligible;
  if (historicalReceive && !state.snapshot.parts.finance) throw new IntegrationError("part_disabled", 409);
  const ended = !maintenance && !historicalReceive && (
    !eventEpochOpen(event, state.activations, []) ||
    checked.stock && !eventEpochOpen(event, state.activations, ["erp-produtos", "erp-estoque"]) ||
    checked.finance && !eventEpochOpen(event, state.activations, ["erp-financeiro"]) ||
    checked.document && !documentEpochOpen(event, state.activations)
  );
  if (ended || request?.body.close_only) {
    request ??= await persistPreparedRequest(env, event, await closureRequest(env, event), token);
    await countIntegrationAttempt(env, event, token, "attempts", deadline);
    const result = await closeErpCommand(env, request, "epoch_closed", undefined, deadline);
    checkDeadline(deadline);
    await confirmIntegrationResult(env, event, token, result);
    return;
  }
  const automation = await eventAutomation(env, event);
  if (request && !maintenance && (requested?.stock && !automation.stock || requested?.finance && !automation.finance)) throw new IntegrationError("waiting_manual", 409);
  if (!request) {
    if (!maintenance && !eligible.document && (eligible.finance && !automation.finance || eligible.stock && !automation.stock)) throw new IntegrationError("waiting_manual", 409);
    const prepared = await prepareErpRequest(env, event);
    checkDeadline(deadline);
    request = await persistPreparedRequest(env, event, prepared, token);
  }
  if (!(await renewIntegrationLease(env, event.id, token))) throw new IntegrationError("lease_lost", 409);
  await countIntegrationAttempt(env, event, token, "attempts", deadline);
  const result = await applyErpRequest(env, request, deadline);
  checkDeadline(deadline);
  await confirmIntegrationResult(env, event, token, result);
}
export async function drainIntegrationOutbox(env: Env, profile: string, options: { limit?: number; budget_ms?: number } = {}): Promise<void> {
  const limit = Math.min(100, integer(options.limit ?? 20, 1)), deadline = Date.now() + Math.min(25_000, integer(options.budget_ms ?? 20_000, 1));
  // Nunca abre erp:<área>, nem promove cliente, quando Base está desligada.
  if (!(await withinDeadline(deadline, () => readErpPartsState(env, profile))).snapshot.parts.customers) return;
  const rows = await withinDeadline(deadline, () => all(env, `SELECT e.id,e.payload_json FROM module_erp_events e
    JOIN module_erp_delivery d ON d.event_id=e.id
    JOIN module_erp_sources s ON s.profile_id=e.profile_id AND s.module_id=e.module_id AND s.source_id=e.source_id
    WHERE e.profile_id=? AND e.seq=s.applied_seq+1 AND d.state IN ('pending','sending','uncertain') AND (d.lookup_attempts<12 OR d.state='sending') AND s.replacement_key IS NULL AND d.next_attempt_ms<=?
      AND (d.lease_until_ms IS NULL OR d.lease_until_ms<=?)
    ORDER BY d.next_attempt_ms,e.id LIMIT ?`, profile, Date.now(), Date.now(), limit));
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    const token = await acquireIntegrationLease(env, row.id);
    if (!token) continue;
    try { await withinDeadline(deadline, () => attempt(env, JSON.parse(row.payload_json), token, deadline)); }
    catch (error) {
      await releaseIntegrationLease(env, row.id, token, error).catch(logIntegrationError);
      logIntegrationError(error);
    }
  }
}
