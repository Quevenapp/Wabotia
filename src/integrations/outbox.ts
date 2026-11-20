import { batch, one } from "../db";
import type { Env } from "../types";
import type { IntegrationEvent, IntegrationResult, PreparedErpRequest, SourceRef, Statement } from "./contracts";
import { canonical, hash, commandId, localEventId } from "./keys";
import { exactKeys, integer, IntegrationError, validateEvent, validateResult, validateSnapshot, validateSource } from "./privacy";

export const integrationCasGuard: Statement = ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('integration_version_conflict') END", []];
export const sourceBindings = (s: SourceRef) => [s.profile, s.module, s.source_id];
/** O produtor inclui estas instruções no MESMO batch da mutação e histórico.
 * next_state é {} ou {snapshot: CommercialSnapshot}; não recebe registro bruto.
 * Repetição de um lote já confirmado é recuperada por findIntegrationEvent.
 */
export function integrationStatements(input: {
  source: SourceRef; expected_revision: number; events: readonly IntegrationEvent[]; next_state: Readonly<Record<string, unknown>>;
  replacement_key?: string;
  automation_from?: string;
}): Statement[] {
  const { source, expected_revision, events, next_state } = input;
  validateSource(source); integer(expected_revision);
  exactKeys(next_state, ["snapshot"]);
  if (next_state.snapshot) {
    validateSnapshot(next_state.snapshot as IntegrationEvent["snapshot"]);
    const snapshot = next_state.snapshot as IntegrationEvent["snapshot"];
    if (canonical(snapshot.source) !== canonical(source) || snapshot.source_revision !== expected_revision + 1) throw new IntegrationError("version_conflict", 409);
  }
  if (events.length > 100) throw new IntegrationError("invalid_request", 400);
  for (const [i, event] of events.entries()) {
    validateEvent(event);
    if (canonical(sourceBindings(event.source)) !== canonical(sourceBindings(source)) || event.source_revision !== expected_revision + 1 || event.seq === null || (i > 0 && event.seq !== events[i - 1].seq! + 1)) throw new IntegrationError("version_conflict", 409);
  }
  // Os produtores propõem a ordem; somente destinos elegíveis reservam um
  // número remoto. O fato local continua imutável e visível, com seq=null.
  const previousSeq = events.length ? events[0].seq! - 1 : 0;
  let remoteSeq = previousSeq;
  const facts = events.map(event => {
    if (!Object.values(event.eligible).some(Boolean)) {
      const id = localEventId(event.source, event.event_key);
      return { ...event, id, command_id: id, seq: null };
    }
    const seq = ++remoteSeq;
    const command = commandId(event.source, seq);
    return { ...event, seq, command_id: command, id: event.id === event.command_id ? command : event.id };
  });
  const remoteCount = remoteSeq - previousSeq;
  const key = sourceBindings(source);
  const statements: Statement[] = [
    [`INSERT INTO module_erp_sources(profile_id,module_id,source_id,revision,state_json,enqueued_seq)
      VALUES(?,?,?,CASE WHEN (?=0 AND ?=0)
        OR EXISTS(SELECT 1 FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?)
        THEN 1 ELSE json('integration_version_conflict') END,?,?)
      ON CONFLICT(profile_id,module_id,source_id) DO UPDATE SET
        revision=CASE WHEN module_erp_sources.revision=? AND module_erp_sources.replacement_key IS ?${events.length ? " AND module_erp_sources.enqueued_seq=?" : ""}
          THEN module_erp_sources.revision+1 ELSE json('integration_version_conflict') END,
        state_json=excluded.state_json,enqueued_seq=module_erp_sources.enqueued_seq+?`,
    [...key, expected_revision, previousSeq, ...key, canonical(next_state), remoteCount,
      expected_revision, input.replacement_key ?? null, ...(events.length ? [previousSeq] : []), remoteCount]],
  ];
  for (const event of facts) {
    statements.push([
      `INSERT INTO module_erp_events(id,profile_id,module_id,source_id,seq,source_revision,command_id,event_key,occurred_ms,event_hash,payload_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [event.id, ...key, event.seq, event.source_revision, event.command_id, event.event_key, event.occurred_ms, hash(event), canonical(event)],
    ], [
      `INSERT INTO module_erp_event_automation(event_id,authorization_json)
       VALUES(?,CASE WHEN ? IS NOT NULL THEN COALESCE((SELECT authorization_json FROM module_erp_event_automation WHERE event_id=?),'{}')
       ELSE COALESCE((SELECT json_object('stock',json_extract(config_json,'$.auto_post.stock'),
         'finance',json_extract(config_json,'$.auto_post.finance'),'stock_epoch',stock_epoch,'finance_epoch',finance_epoch)
         FROM module_erp_policy WHERE profile_id=?),'{}') END)`,
      [event.id, input.automation_from ?? null, input.automation_from ?? null, source.profile],
    ], ["INSERT INTO module_erp_delivery(event_id,next_attempt_ms,state,completed_ms,error_code) VALUES(?,?,?,?,?)",
      [event.id, event.occurred_ms, event.seq === null ? "done" : "pending", event.seq === null ? event.occurred_ms : null,
        event.seq === null ? event.snapshot.items.length === 0 && event.snapshot.total_cents === 0 ? "no_commercial_content" : "part_disabled" : null]]);
  }
  return statements;
}
export async function findIntegrationEvent(env: Env, profile: string, eventKey: string, expected?: IntegrationEvent): Promise<IntegrationEvent | null> {
  const row = await one(env, "SELECT payload_json,event_hash FROM module_erp_events WHERE profile_id=? AND event_key=?", profile, eventKey);
  if (!row) return null;
  if (expected && row.event_hash !== hash(expected)) throw new IntegrationError("idempotency_conflict", 409);
  return JSON.parse(row.payload_json);
}
export function aliasStatements(source: SourceRef, kind: string, recordId: string): Statement[] {
  validateSource(source);
  return [
    [`INSERT INTO module_erp_aliases(profile_id,module_id,record_kind,record_id,source_id,component) VALUES(?,?,?,?,?,?)
      ON CONFLICT(profile_id,module_id,record_kind,record_id) DO UPDATE SET component=
      CASE WHEN module_erp_aliases.source_id=excluded.source_id AND module_erp_aliases.component=excluded.component
        THEN module_erp_aliases.component ELSE json('integration_alias_conflict') END`,
      [source.profile, source.module, kind, recordId, source.source_id, source.component]],
  ];
}
/** Recibos locais independentes entre si, juntos na mesma escrita do lote sem ultrapassar o
 * limite de parâmetros D1. Conflito em qualquer chave desfaz o lote inteiro. */
export function compactReceiptWrites(statements: Statement[]): Statement[] {
  const receiptSql = /^INSERT INTO receipts\(scope,key,fingerprint,response,status,created\) VALUES\s*\(\?,\?,\?,\?,200,\?\)(?:,\(\?,\?,\?,\?,200,\?\))*$/;
  const receipts: unknown[][] = [], rest: Statement[] = [];
  for (const statement of statements) {
    if (!receiptSql.test(statement[0])) { rest.push(statement); continue; }
    for (let i = 0; i < statement[1].length; i += 5) receipts.push(statement[1].slice(i, i + 5));
  }
  if (receipts.length) rest.push([`INSERT INTO receipts(scope,key,fingerprint,response,status,created)
    SELECT value ->> '$[0]',value ->> '$[1]',value ->> '$[2]',value ->> '$[3]',200,value ->> '$[4]' FROM json_each(?)`, [canonical(receipts)]]);
  return rest;
}
export async function readPreparedRequest(env: Env, event: IntegrationEvent): Promise<PreparedErpRequest | null> {
  if (event.seq === null) return null;
  const row = await one(env, "SELECT * FROM module_erp_requests WHERE event_id=?", event.id);
  if (!row) return null;
  const request: PreparedErpRequest = { schema: 1, source: event.source, command_id: event.command_id, seq: event.seq, event_hash: hash(event), actor_id: row.actor_id, expected: JSON.parse(row.expected_json), body: JSON.parse(row.body_json) };
  if (hash(request) !== row.request_hash) throw new IntegrationError("idempotency_conflict", 409);
  return request;
}
export async function persistPreparedRequest(env: Env, event: IntegrationEvent, request: PreparedErpRequest, token: string): Promise<PreparedErpRequest> {
  validateEvent(event);
  if (event.seq === null) throw new IntegrationError("invalid_request", 400);
  if (request.event_hash !== hash(event) || request.command_id !== event.command_id || request.seq !== event.seq || canonical(request.source) !== canonical(event.source)) throw new IntegrationError("idempotency_conflict", 409);
  exactKeys(request, ["schema", "command_id", "actor_id", "source", "seq", "event_hash", "expected", "body"]);
  if (request.schema !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.actor_id)) throw new IntegrationError("invalid_request", 400);
  exactKeys(request.body, request.body.close_only === true ? ["mode", "operation", "close_only"] :
    ["operation", "route", "snapshot", "policy", "eligible", "requested", "epochs", "occurred_ms", "receipt", "reason_code", "mode", "stock_reversal"]);
  if (!["system", "human"].includes(String(request.body.mode)) || request.body.operation !== event.operation) throw new IntegrationError("invalid_request", 400);
  if (!request.body.close_only) validateSnapshot(request.body.snapshot as IntegrationEvent["snapshot"]);
  for (const [key, value] of Object.entries(request.expected)) {
    if (!/^(document|title|posting):[0-9a-f-]{36}$/i.test(key)) throw new IntegrationError("invalid_request", 400);
    integer(value);
  }
  await batch(env, [
    [`SELECT CASE WHEN EXISTS(SELECT 1 FROM module_erp_events WHERE id=? AND command_id=? AND event_hash=? AND profile_id=? AND module_id=? AND source_id=? AND seq=?) THEN 1 ELSE json('integration_request_conflict') END`,
      [event.id, event.command_id, hash(event), ...sourceBindings(event.source), event.seq]],
    ["UPDATE module_erp_delivery SET lease_until_ms=? WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'", [Date.now() + 60_000, event.id, token, Date.now()]], integrationCasGuard,
    [`INSERT OR IGNORE INTO module_erp_requests(event_id,actor_id,request_hash,expected_json,body_json,prepared_ms) VALUES(?,?,?,?,?,?)`, [event.id, request.actor_id, hash(request), canonical(request.expected), canonical(request.body), Date.now()]],
  ]);
  // Se outro consumidor já preparou, usar exclusivamente o pedido vencedor.
  return (await readPreparedRequest(env, event))!;
}
export async function acquireIntegrationLease(env: Env, eventId: string, now = Date.now(), force = false, replacementKey: string | null = null): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await env.DB.prepare(`UPDATE module_erp_delivery SET state='sending',lease_token=?,lease_until_ms=?
    WHERE event_id=? AND state<>'done' AND (lease_until_ms IS NULL OR lease_until_ms<=?)
    AND (?=1 OR (state IN ('pending','sending','uncertain') AND (lookup_attempts<12 OR state='sending') AND next_attempt_ms<=?))
    AND EXISTS(SELECT 1 FROM module_erp_events e JOIN module_erp_sources s
      ON s.profile_id=e.profile_id AND s.module_id=e.module_id AND s.source_id=e.source_id
      WHERE e.id=event_id AND e.seq=s.applied_seq+1 AND s.replacement_key IS ?)`)
    .bind(token, now + 60_000, eventId, now, force ? 1 : 0, now, replacementKey).run();
  return result.meta.changes === 1 ? token : null;
}
export async function renewIntegrationLease(env: Env, eventId: string, token: string): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB.prepare("UPDATE module_erp_delivery SET lease_until_ms=? WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'").bind(now + 60_000, eventId, token, now).run();
  return r.meta.changes === 1;
}
export async function confirmIntegrationResult(env: Env, event: IntegrationEvent, token: string, receipt: IntegrationResult, extra: Statement[] = []): Promise<void> {
  if (event.seq === null) throw new IntegrationError("invalid_request", 400);
  validateResult(receipt, event.command_id, event.seq);
  const source = await one(env, "SELECT links_json FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(event.source));
  const links = new Map<string, IntegrationResult["links"][number]>();
  // Componentes distintos podem usar o mesmo slot (por exemplo, cada pedido
  // de uma conta de mesa). A identidade do alvo, não o rótulo do slot, une
  // versões; nunca descarta o vínculo comercial de outro componente.
  for (const link of JSON.parse(source?.links_json ?? "[]") as IntegrationResult["links"]) links.set(`${link.kind}:${link.id}`, link);
  for (const link of receipt.links) links.set(`${link.kind}:${link.id}`, link);
  const at = Date.now();
  await batch(env, [
    [`UPDATE module_erp_delivery SET state='done',receipt_json=?,completed_ms=?,lease_token=NULL,lease_until_ms=NULL,error_code=NULL,error_message=NULL,unresolved=0
      WHERE event_id=? AND lease_token=? AND lease_until_ms>? AND state='sending'`, [canonical(receipt), at, event.id, token, at]], integrationCasGuard,
    [`UPDATE module_erp_sources SET applied_seq=?,links_json=?,confirmed_ms=? WHERE profile_id=? AND module_id=? AND source_id=? AND applied_seq=?`, [event.seq, canonical([...links.values()]), at, ...sourceBindings(event.source), event.seq - 1]], integrationCasGuard,
    ...extra,
  ]);
}
