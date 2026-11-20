/** Leituras do acervo: nenhum projetor, vínculo ou registro operacional é escrito. */
import type { Row, SqlDriver } from "../engine/driver.ts";
import { BLING_LEGACY_ENTITIES, BlingError, type BlingContext, type BlingEntity, type BlingOperationMap, type BlingRawRecord, type BlingRecordMetadata, type RecordIdentity } from "./contracts.ts";
import { authorizeBlingOperation, parseBlingOperationInput, recordIdentitySchema, contentVersionSchema, captureSchema } from "./schema.ts";
import { validateCapture } from "./projection.ts";

const legacy = new Set<string>(BLING_LEGACY_ENTITIES);
export function rawTable(entity: BlingEntity): "origin_sync__raw_record" | "wb_bling_extra_raw" {
  return legacy.has(entity) ? "origin_sync__raw_record" : "wb_bling_extra_raw";
}
const iso = (value: unknown): string => {
  const date = new Date(Number(value));
  if (value === null || value === undefined || !Number.isSafeInteger(Number(value)) || !Number.isFinite(date.getTime())) throw new BlingError("BLING_RESPONSE_INVALID");
  return date.toISOString();
};
function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(String(value)) as T; } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
}
const metadataColumns = `m.semantic_hash AS meta_hash, m.size_bytes, m.first_seen_at AS meta_first_seen_at,
 m.last_seen_at AS meta_last_seen_at, m.source_time_quality, m.mapper_version, m.deleted_observed,
 m.deletion_evidence, m.capture_revision, m.metadata,
 CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' THEN 1 ELSE 0 END AS legacy_deleted`;
const currentColumns = `r.entity,r.source_id,CAST(r.version AS TEXT) AS version,r.version_hash AS semantic_hash,
 r.payload,r.document_links,r.price_capture,m.capture,r.source_updated_at,r.first_seen_at,r.last_seen_at,${metadataColumns}`;
const historyColumns = `r.entity,r.source_id,CAST(r.source_version AS TEXT) AS version,r.source_hash AS semantic_hash,
 r.payload,r.document_links,r.price_capture,m.capture,r.source_updated_at,r.observed_at AS first_seen_at,r.observed_at AS last_seen_at,${metadataColumns}`;
// Listagens não materializam dezenas de payloads grandes no Coordinator.
const currentSummary = `r.entity,r.source_id,CAST(r.version AS TEXT) AS version,r.version_hash AS semantic_hash,
 length(CAST(r.payload AS BLOB)) AS fallback_size_bytes,r.source_updated_at,r.first_seen_at,r.last_seen_at,${metadataColumns}`;
const historySummary = `r.entity,r.source_id,CAST(r.source_version AS TEXT) AS version,r.source_hash AS semantic_hash,
 length(CAST(r.payload AS BLOB)) AS fallback_size_bytes,r.source_updated_at,r.observed_at AS first_seen_at,r.observed_at AS last_seen_at,${metadataColumns}`;
const joinMetadata = (version: string) => `LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.${version}`;

export function metadataOf(row: Row, identity: RecordIdentity): BlingRecordMetadata {
  if (row.meta_hash != null && row.meta_hash !== row.semantic_hash) throw new BlingError("BLING_RESPONSE_INVALID");
  const extra = json<Record<string, unknown>>(row.metadata, {});
  const lexicalDate = extra.source_updated_at_lexical ?? extra.source_updated_at;
  return {
    identity, version: String(row.version), semantic_hash: String(row.semantic_hash),
    payload_bytes: row.size_bytes == null ? Number(row.fallback_size_bytes ?? new TextEncoder().encode(String(row.payload)).byteLength) : Number(row.size_bytes),
    first_observed_at: iso(row.meta_first_seen_at ?? row.first_seen_at),
    last_observed_at: iso(row.meta_last_seen_at ?? row.last_seen_at),
    source_updated_at: typeof lexicalDate === "string" ? lexicalDate : row.source_updated_at == null ? null : iso(row.source_updated_at),
    source_time_quality: (row.source_time_quality ?? (row.source_updated_at == null ? "unknown" : "remote")) as BlingRawRecord["source_time_quality"],
    deleted: Number(row.deleted_observed ?? row.legacy_deleted ?? 0) === 1,
    mapper_version: row.mapper_version == null ? null : String(row.mapper_version),
    capture_revision: Number(row.capture_revision ?? 0) > 0 ? String(row.capture_revision) : null,
  };
}
export function rawOf(row: Row, identity: RecordIdentity): BlingRawRecord {
  const metadata = metadataOf(row, identity);
  const record: BlingRawRecord = {
    identity, version: metadata.version, semantic_hash: metadata.semantic_hash,
    payload_text: String(row.payload), document_links: json(row.document_links, []),
    observed_at: metadata.last_observed_at, source_updated_at: metadata.source_updated_at,
    source_time_quality: metadata.source_time_quality, deleted: metadata.deleted,
    deletion_evidence: row.deletion_evidence == null ? metadata.deleted ? '{"kind":"explicit_payload","path":"/_brufap_source/deleted"}' : null : String(row.deletion_evidence),
    capture: json<BlingRawRecord["capture"]>(row.capture, null),
  };
  if (!record.capture && row.price_capture) {
    const legacy = json<Record<string, unknown>>(row.price_capture, {});
    // Revisão zero identifica prova legada cuja revisão própria era desconhecida.
    // Só adaptamos evidência explicitamente ligada ao mesmo hash e versão.
    if (legacy.source_hash === record.semantic_hash && String(legacy.source_version) === record.version) {
      const candidate = captureSchema.safeParse({ revision:"0",profile:legacy.profile,source:legacy.source === "list_fallback" ? "deleted_without_detail" : legacy.source,
        bytes_sha256:legacy.response_sha256,semantic_hash:record.semantic_hash,semantic_version:record.version,values:legacy.tokens });
      if (candidate.success) {
        try { record.capture=validateCapture({...record,capture:candidate.data}); } catch { /* Prova inválida não é promovida. */ }
      }
    }
  }
  return record;
}

export function authorizeArchiveRecord(ctx: BlingContext, identity: RecordIdentity, version?: string): void {
  if (ctx.origin === "internal") return;
  authorizeBlingOperation(ctx,"erp_bling_record_get",{entity:identity.entity,id:identity.source_id,version});
  // Bruto completo pode conter dados pessoais/sensíveis. Ambos são opções do
  // administrador, além da concessão de acesso ao bruto exigida pela base.
  if (ctx.identity.actor?.is_agent && (!ctx.authorization?.bot?.data_scopes.includes("personal") || !ctx.authorization.bot.data_scopes.includes("sensitive"))) throw new BlingError("BLING_SCOPE_REQUIRED");
}

type QueryState = { account: string; generation: string };
type Cursor = { v: 1; scope: string; key: string };
function encodeCursor(value: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(cursor: string | undefined, scope: string): string | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw 0;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))));
    if (value.v !== 1 || value.scope !== scope || typeof value.key !== "string" || value.key.length > 200) throw 0;
    return value.key;
  } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
}

export function createArchiveQueries(deps: { db: SqlDriver; profile: string }) {
  const { db, profile } = deps;
  function state(ctx: BlingContext): QueryState {
    if (ctx.profile !== profile) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    if (!ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED");
    const control = db.exec("SELECT account_id, generation, state FROM wb_bling_control WHERE id=1").rows[0];
    if (!control?.account_id) throw new BlingError("BLING_AUTH_REQUIRED");
    if (control.state === "purging") throw new BlingError("BLING_RETRY_WAIT");
    return { account: String(control.account_id), generation: String(control.generation) };
  }
  function identify(entity: BlingEntity, id: string, current: QueryState): RecordIdentity {
    return { profile, account_id: current.account, entity, source_id: id };
  }
  function findRow(identity: RecordIdentity, version?: string, summary=false): Row | null {
    const current = db.exec(`SELECT ${summary ? currentSummary : currentColumns} FROM ${rawTable(identity.entity)} r ${joinMetadata("version")} WHERE r.entity=? AND r.source_id=?`, identity.entity, identity.source_id).rows[0];
    if (current && (version === undefined || String(current.version) === version)) return current;
    if (version === undefined) return null;
    return db.exec(`SELECT ${summary ? historySummary : historyColumns} FROM erp_document_mirror__source_version r ${joinMetadata("source_version")} WHERE r.entity=? AND r.source_id=? AND r.source_version=?`, identity.entity, identity.source_id, version).rows[0] ?? null;
  }
  function readVersion(ctx: BlingContext, identity: RecordIdentity, version?: string): BlingRawRecord | null {
    if (!recordIdentitySchema.safeParse(identity).success || version !== undefined && !contentVersionSchema.safeParse(version).success) throw new BlingError("BLING_RESPONSE_INVALID");
    authorizeArchiveRecord(ctx,identity,version);
    return db.transaction(() => {
      const current = state(ctx);
      if (identity.profile !== profile || identity.account_id !== current.account) throw new BlingError("BLING_ACCOUNT_MISMATCH");
      const row = findRow(identity, version);
      return row ? rawOf(row, identity) : null;
    });
  }
  function recordMetadata(ctx: BlingContext, record: BlingRawRecord): BlingRecordMetadata {
    authorizeArchiveRecord(ctx,record.identity,record.version);
    return db.transaction(() => {
      const current = state(ctx);
      if (record.identity.profile !== profile || record.identity.account_id !== current.account) throw new BlingError("BLING_ACCOUNT_MISMATCH");
      const row = findRow(record.identity, record.version,true);
      if (!row || row.semantic_hash !== record.semantic_hash) throw new BlingError("BLING_REVISION_CONFLICT");
      return metadataOf(row, record.identity);
    });
  }
  function listRecords(ctx: BlingContext, input: BlingOperationMap["erp_bling_records_list"]["input"]): BlingOperationMap["erp_bling_records_list"]["output"] {
    const query = parseBlingOperationInput("erp_bling_records_list", input);
    authorizeBlingOperation(ctx, "erp_bling_records_list", query);
    return db.transaction(() => {
      const current = state(ctx), limit = query.limit ?? 25;
      const scope = JSON.stringify([profile,current.account,current.generation,"records",query.entity,query.deleted ?? null,query.from ?? null,query.to ?? null]);
      const after = decodeCursor(query.cursor, scope);
      const clauses = ["r.entity=?"], parameters: unknown[] = [query.entity];
      if (after !== null) { clauses.push("r.source_id>?"); parameters.push(after); }
      if (query.deleted !== undefined) { clauses.push("COALESCE(m.deleted_observed,CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' THEN 1 ELSE 0 END)=?"); parameters.push(query.deleted ? 1 : 0); }
      if (query.from) { clauses.push("COALESCE(m.last_seen_at,r.last_seen_at)>=?"); parameters.push(Date.parse(query.from)); }
      if (query.to) { clauses.push("COALESCE(m.last_seen_at,r.last_seen_at)<?"); parameters.push(Date.parse(query.to) + 86_400_000); }
      const rows = db.exec(`SELECT ${currentSummary} FROM ${rawTable(query.entity)} r ${joinMetadata("version")} WHERE ${clauses.join(" AND ")} ORDER BY r.source_id LIMIT ?`, ...parameters, limit + 1).rows;
      const items = rows.slice(0,limit).map(row => metadataOf(row, identify(query.entity,String(row.source_id),current)));
      return { items, next_cursor: rows.length > limit ? encodeCursor({ v:1,scope,key:items[items.length-1].identity.source_id }) : null };
    });
  }
  function listVersions(ctx: BlingContext, input: BlingOperationMap["erp_bling_versions_list"]["input"]): BlingOperationMap["erp_bling_versions_list"]["output"] {
    const query = parseBlingOperationInput("erp_bling_versions_list", input);
    authorizeBlingOperation(ctx, "erp_bling_versions_list", query);
    return db.transaction(() => {
      const current = state(ctx), limit = query.limit ?? 25;
      const scope = JSON.stringify([profile,current.account,current.generation,"versions",query.entity,query.id]);
      const after = decodeCursor(query.cursor, scope) ?? "0";
      if (!/^(0|[1-9]\d{0,15})$/.test(after)) throw new BlingError("BLING_RESPONSE_INVALID");
      const rows = db.exec(`SELECT * FROM (
        SELECT ${currentSummary} FROM ${rawTable(query.entity)} r ${joinMetadata("version")} WHERE r.entity=? AND r.source_id=? AND r.version>?
        UNION ALL SELECT ${historySummary} FROM erp_document_mirror__source_version r ${joinMetadata("source_version")}
        WHERE r.entity=? AND r.source_id=? AND r.source_version>? AND NOT EXISTS(SELECT 1 FROM ${rawTable(query.entity)} c WHERE c.entity=r.entity AND c.source_id=r.source_id AND c.version=r.source_version)
      ) ORDER BY CAST(version AS INTEGER) LIMIT ?`,query.entity,query.id,after,query.entity,query.id,after,limit+1).rows;
      const items = rows.slice(0,limit).map(row => metadataOf(row,identify(query.entity,query.id,current)));
      return { items, next_cursor: rows.length > limit ? encodeCursor({ v:1,scope,key:items[items.length-1].version }) : null };
    });
  }
  return { readVersion, listRecords, listVersions, recordMetadata };
}
