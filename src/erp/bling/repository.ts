/** Persistência exclusiva do acervo. Nenhum projetor ou aplicador operacional é chamado. */
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../engine/driver.ts";
import {
  BLING_BUDGET, BLING_ENTITIES, BLING_LEGACY_ENTITIES, BlingError,
  type BlingCheckpoint, type BlingContext, type BlingEntity, type BlingExpectedState,
  type BlingFailure, type BlingLease, type BlingOperationMap, type BlingRawRecord,
  type BlingReceipt, type BlingUnit, type JsonObject, type RecordIdentity,
} from "./contracts.ts";
import type { BlingCommitInput, BlingReserveInput, CollectionStore } from "./ports.ts";
import { authorizeBlingOperation, BLING_OPERATIONS, commitInputSchema, rawRecordSchema, reserveInputSchema, unitSchema } from "./schema.ts";
import { BLING_XML_RESOURCE, getBlingResource, resourceVariants } from "./resources.ts";

const encoder = new TextEncoder();
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = <T>(value: unknown, fallback: T): T => typeof value === "string" ? JSON.parse(value) as T : fallback;
const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(Number(value)).toISOString();
const numeric = (value: unknown) => Number(value ?? 0);
const legacy = (entity: string) => (BLING_LEGACY_ENTITIES as readonly string[]).includes(entity);
const rawTable = (entity: string) => legacy(entity) ? "origin_sync__raw_record" : "wb_bling_extra_raw";
const fail = (code: ConstructorParameters<typeof BlingError>[0]): never => { throw new BlingError(code); };

type LexicalNumber = { readonly lexicalNumber: string };
const lexicals = new WeakSet<object>();
/** Gramática síncrona usada no commit: preserva TODO número, inclusive IDs, antes de materializar. */
export function parseStoredPayload(text: string): unknown {
  if (typeof text !== "string" || encoder.encode(text).byteLength > 8_388_608) fail("BLING_RESPONSE_INVALID");
  let at = 0, nodes = 0;
  const whitespace = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { fail("BLING_RESPONSE_INVALID"); } }
      if (ch.charCodeAt(0) < 32) fail("BLING_RESPONSE_INVALID");
      if (ch === "\\") at++;
    }
    return fail("BLING_RESPONSE_INVALID");
  };
  const value = (depth: number): unknown => {
    if (depth > 64 || ++nodes > 200_000) fail("BLING_RESPONSE_INVALID");
    whitespace(); const ch = text[at];
    if (ch === '"') return string();
    if (ch === "{") {
      at++; whitespace(); const result: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        whitespace(); if (text[at] !== '"') fail("BLING_RESPONSE_INVALID"); const key = string();
        if (Object.hasOwn(result, key)) fail("BLING_RESPONSE_INVALID");
        whitespace(); if (text[at++] !== ":") fail("BLING_RESPONSE_INVALID"); result[key] = value(depth + 1);
        whitespace(); const separator = text[at++]; if (separator === "}") return result; if (separator !== ",") fail("BLING_RESPONSE_INVALID");
      }
    }
    if (ch === "[") {
      at++; whitespace(); const result: unknown[] = [];
      if (text[at] === "]") { at++; return result; }
      for (;;) { result.push(value(depth + 1)); whitespace(); const separator = text[at++]; if (separator === "]") return result; if (separator !== ",") fail("BLING_RESPONSE_INVALID"); }
    }
    for (const [word, primitive] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return primitive; }
    }
    const matched = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!matched || matched[0].length > 4096) return fail("BLING_RESPONSE_INVALID");
    at += matched[0].length; const number: LexicalNumber = { lexicalNumber: matched[0] }; lexicals.add(number); return number;
  };
  const parsed = value(0); whitespace(); if (at !== text.length) fail("BLING_RESPONSE_INVALID"); return parsed;
}
function decimal(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return fail("BLING_RESPONSE_INVALID");
  const [mantissa, exponent = "0"] = value.toLowerCase().split("e");
  if (exponent.length > 6 || BigInt(exponent) < -10000n || BigInt(exponent) > 10000n) return fail("BLING_RESPONSE_INVALID");
  const [whole, fraction = ""] = mantissa.split("."); let coefficient = BigInt(whole + fraction), scale = BigInt(fraction.length) - BigInt(exponent);
  if (coefficient === 0n) return "0";
  while (coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  return `${coefficient}e${-scale}`;
}
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value !== null && typeof value === "object" && lexicals.has(value)) return decimal((value as LexicalNumber).lexicalNumber);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("BLING_RESPONSE_INVALID"); return decimal(String(value)); }
  return JSON.stringify(value);
}
/** Mesmo envelope para coleta e futura releitura; nenhuma conversão monetária para Number. */
export function semanticHash(payloadText: string, documentLinks: JsonObject[]): string {
  return hash(canonical({ payload: parseStoredPayload(payloadText), document_links: documentLinks }));
}
/** Data remota estrita: Date.parse sozinho normaliza 31/02 e não comprova calendário. */
export function remoteTimestampMillis(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const zone = match[8] ?? "-03:00";
  if (zone !== "Z") { const offset = zone.slice(1).replace(":", ""), hours = Number(offset.slice(0, 2)), minutes = Number(offset.slice(2)); if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) return null; }
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ? "." + match[7] : ""}${zone}`);
  return Number.isFinite(parsed) ? parsed : null;
}
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && lexicals.has(value)) return (value as LexicalNumber).lexicalNumber;
  return null;
}
function payloadObject(record: BlingRawRecord): Record<string, unknown> {
  const value = parseStoredPayload(record.payload_text);
  if (!value || typeof value !== "object" || Array.isArray(value) || lexicals.has(value)) return fail("BLING_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function validateRecord(record: BlingRawRecord): void {
  if (!rawRecordSchema.safeParse(record).success) fail("BLING_RESPONSE_INVALID");
  const payload = payloadObject(record);
  // Estoque identifica o produto, não a posição dentro da página.
  const id = scalar(payload.id) ?? scalar((payload.produto as Record<string, unknown> | undefined)?.id);
  if (id !== record.identity.source_id.split(":").at(-1)) fail("BLING_RESPONSE_INVALID");
  if (semanticHash(record.payload_text, record.document_links) !== record.semantic_hash) fail("BLING_RESPONSE_INVALID");
  const profiles: Partial<Record<BlingEntity, string>> = { products: "origin-price-json-v1", sales_proposals: "origin-price-json-v1", sales_orders: "origin-sales-price-json-v1", purchase_orders: "origin-purchase-price-json-v1", service_orders: "origin-service-json-v1", stock_balances: "origin-stock-json-v1" };
  if (profiles[record.identity.entity] && (!record.capture || record.capture.profile !== profiles[record.identity.entity])) fail("BLING_RESPONSE_INVALID");
  if (record.capture) {
    if (record.capture.source === "deleted_without_detail" && (!record.deleted || !record.deletion_evidence || record.identity.entity !== "products")) fail("BLING_RESPONSE_INVALID");
    for (const entry of record.capture.values) {
      const components = entry.path.replace(/^\//, "").split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      let target: unknown = payload;
      for (const component of components) target = target && typeof target === "object" ? (target as Record<string, unknown>)[component] : undefined;
      const token = scalar(target);
      if (token === null || decimal(token) !== decimal(entry.lexeme)) fail("BLING_RESPONSE_INVALID");
    }
    const required: string[] = [];
    const add = (path: string, value: unknown) => { if (value && typeof value === "object" && lexicals.has(value)) required.push(path); };
    if (record.identity.entity === "products") add("/preco", payload.preco);
    if (["sales_proposals", "sales_orders", "purchase_orders"].includes(record.identity.entity) && Array.isArray(payload.itens)) payload.itens.forEach((item, index) => add(`/itens/${index}/valor`, (item as Record<string, unknown>)?.valor));
    if (record.identity.entity === "stock_balances") {
      for (const field of ["saldoFisicoTotal", "saldoVirtualTotal"]) add(`/${field}`, payload[field]);
      if (Array.isArray(payload.depositos)) payload.depositos.forEach((item, index) => { for (const field of ["saldoFisico", "saldoVirtual"]) add(`/depositos/${index}/${field}`, (item as Record<string, unknown>)?.[field]); });
    }
    if (record.identity.entity === "service_orders") {
      for (const field of ["total", "totalPecas", "totalServicos", "valorFrete"]) add(`/${field}`, payload[field]);
      add("/desconto/valor", (payload.desconto as Record<string, unknown> | undefined)?.valor);
      for (const collection of ["pecas", "servicos", "itens"]) if (Array.isArray(payload[collection])) (payload[collection] as Record<string, unknown>[]).forEach((item, index) => { for (const field of ["quantidade", "horas", "valorUnitario", "valor", "precoLista", "desconto", "total", "valorTotal"]) add(`/${collection}/${index}/${field}`, item?.[field]); });
    }
    if (profiles[record.identity.entity] && canonical(required.sort()) !== canonical(record.capture.values.map(entry => entry.path).sort())) fail("BLING_RESPONSE_INVALID");
  }
}

export interface CollectionRepositoryOptions {
  db: SqlDriver;
  randomId(): string;
  databaseSize(): number;
  /** Validação adicional do acervo, síncrona e sem I/O. */
  validateRecord?(ctx: BlingContext, record: BlingRawRecord): void;
}

export class SqliteCollectionStore implements CollectionStore {
  private readonly options: CollectionRepositoryOptions;
  private readonly db: SqlDriver;
  constructor(options: CollectionRepositoryOptions) { this.options = options; this.db = options.db; }

  private commitTransaction<T>(fn: () => T): T {
    try { return this.db.transaction(fn); }
    catch (cause) {
      const detail = cause as { code?: unknown; message?: unknown };
      if (String(detail?.code ?? "").includes("SQLITE_FULL") || /SQLITE_FULL|database or disk is full/i.test(String(detail?.message ?? ""))) fail("BLING_CAPACITY_STOP");
      throw cause;
    }
  }

  control(_ctx?: BlingContext): Row | null { return one(this.db, "SELECT * FROM wb_bling_control WHERE id=1"); }

  private selected(control: Row, resourceKey: string): boolean {
    return json<Array<string | { key: string; selected: boolean }>>(control.selection, []).some(selection => {
      const key = typeof selection === "string" ? selection : selection.selected ? selection.key : "";
      if (!key) return false; if (key === resourceKey) return true;
      try { return getBlingResource(key).variants.some(variant => variant.key === resourceKey); } catch { return false; }
    });
  }

  assertExpected(ctx: BlingContext, expected: BlingExpectedState, resourceKey?: string | null): Row {
    const control = this.control(ctx);
    if (!control || String(control.generation) !== expected.generation || control.state === "purging") return fail("BLING_GENERATION_RETIRED");
    if (!ctx.identity.parts?.customers || !control.collect_enabled || !control.approved_by || control.approved_at === null || !control.approval_hash) return fail("BLING_DISABLED");
    const parts = ctx.identity.partsControl;
    if (parts && (parts.profile !== ctx.profile || parts.revision !== expected.parts_revision || parts.expires_at <= ctx.clock.now())) return fail("BLING_DISABLED");
    if (String(control.revision) !== expected.configuration_revision || String(control.authorization_revision) !== expected.authorization_revision || String(control.credential_revision) !== expected.credential_revision) return fail("BLING_REVISION_CONFLICT");
    if (control.account_id !== expected.account_id) return fail("BLING_ACCOUNT_MISMATCH");
    if (!["ready", "expired"].includes(String(control.credential_status))) return fail("BLING_AUTH_REQUIRED");
    if (resourceKey) {
      if (!this.selected(control, resourceKey)) return fail("BLING_DISABLED");
    }
    return control;
  }

  checkpoint(resource: string): BlingCheckpoint {
    const row = one(this.db, "SELECT checkpoint,checkpoint_version FROM origin_sync__resource_state WHERE resource=?", resource);
    if (!row) return { revision: "0", cursor: {}, pass_started_at: null, pass_completed_at: null };
    const stored = json<JsonObject>(row.checkpoint, {});
    return { revision: String(row.checkpoint_version), cursor: stored,
      pass_started_at: typeof stored.pass_started_at === "string" ? stored.pass_started_at : null,
      pass_completed_at: typeof stored.pass_completed_at === "string" ? stored.pass_completed_at : null };
  }

  private decodeUnit(row: Row): BlingUnit {
    const checkpoint = json<BlingCheckpoint>(row.expected_checkpoint, { revision: String(row.expected_checkpoint_version), cursor: {}, pass_started_at: null, pass_completed_at: null });
    return {
      work_id: String(row.id), attempt_id: String(row.attempt_id), command_id: String(row.command_id), request_hash: String(row.request_hash), kind: row.kind as BlingUnit["kind"],
      entity: row.entity as BlingUnit["entity"], source_id: row.source_id as string | null, resource_key: row.resource as string | null, phase: row.phase as BlingUnit["phase"],
      expected: { generation: String(row.generation), authorization_revision: String(row.authorization_revision), credential_revision: String(row.credential_revision), configuration_revision: String(row.configuration_revision), account_id: String(row.account_id), parts_revision: String(row.parts_revision) },
      checkpoint, lease: row.owner === null ? null : { owner: String(row.owner), fence: String(row.fence), expires_at: Number(row.lease_until) }, not_before: Number(row.not_before),
      plan: json<JsonObject>(row.plan, {}), page: row.page_fingerprint === null ? null : { ids: json<string[]>(row.page_ids, []), fingerprint: String(row.page_fingerprint), subcursor: Number(row.subcursor) }, progress: json<JsonObject>(row.progress, {}),
    };
  }
  pending(ctx: BlingContext): BlingUnit[] {
    const control = this.control(ctx); if (!control) return [];
    // Um representante de cada pista evita que uma fila extensa esconda outra entidade.
    return this.db.exec("SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY resource ORDER BY not_before,created_at,id) AS lane_rank FROM wb_bling_unit WHERE generation=? AND phase NOT IN ('committed','superseded') AND kind IN ('list','detail','stock','reference','finance_refresh','capture_repair')) WHERE lane_rank=1 ORDER BY updated_at,not_before,id LIMIT 128", control.generation).rows.map(row => this.decodeUnit(row));
  }

  /** Revisões antigas só deixam recibo terminal; jamais são recicladas com outra credencial. */
  retireObsolete(ctx: BlingContext, expected: BlingExpectedState): void {
    this.db.transaction(() => {
      this.assertExpected(ctx, expected);
      const rows = this.db.exec("SELECT * FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded') AND kind IN ('list','detail','stock','reference','finance_refresh','capture_repair') AND (generation<>? OR authorization_revision<>? OR credential_revision<>? OR configuration_revision<>? OR account_id<>? OR parts_revision<>?) LIMIT 128", expected.generation, expected.authorization_revision, expected.credential_revision, expected.configuration_revision, expected.account_id, expected.parts_revision).rows;
      for (const row of rows) {
        const unit = this.decodeUnit(row);
        const existing = this.receipt(ctx, { command_id: unit.command_id, request_hash: unit.request_hash, generation: unit.expected.generation });
        this.db.exec("UPDATE wb_bling_unit SET phase='superseded',finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", ctx.clock.now(), ctx.clock.now(), unit.work_id);
        this.db.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE resource=? AND lease_token IS ?", unit.resource_key, unit.lease?.fence ?? null);
        if (!existing) this.writeReceipt({ command_id: unit.command_id, request_hash: unit.request_hash, generation: unit.expected.generation, operation: "erp_bling_collect_unit", state: "superseded", committed_at: new Date(ctx.clock.now()).toISOString(), references: { work_id: unit.work_id }, counts: {}, error: null }, unit);
      }
    });
  }

  supersede(ctx: BlingContext, requested: BlingUnit, error?: BlingFailure): BlingReceipt {
    return this.db.transaction(() => {
      const previous = this.receipt(ctx, { command_id: requested.command_id, request_hash: requested.request_hash, generation: requested.expected.generation });
      if (previous) return previous;
      const unit = this.live(ctx, requested), now = ctx.clock.now();
      this.db.exec("UPDATE wb_bling_unit SET phase='superseded',finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", now, now, unit.work_id);
      this.db.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE resource=? AND lease_token=?", unit.resource_key, unit.lease!.fence);
      const receipt: BlingReceipt = { command_id: unit.command_id, request_hash: unit.request_hash, generation: unit.expected.generation, operation: "erp_bling_collect_unit", state: "superseded", committed_at: new Date(now).toISOString(), references: { work_id: unit.work_id, ...(error ? { reason: new BlingError(error.code).code } : {}) }, counts: {}, error: null };
      this.writeReceipt(receipt, unit); return receipt;
    });
  }

  enqueue(ctx: BlingContext, unit: BlingUnit): void {
    if (!unitSchema.safeParse(unit).success || unit.phase !== "queued" || unit.lease) fail("BLING_RESPONSE_INVALID");
    this.db.transaction(() => { this.assertExpected(ctx, unit.expected, unit.resource_key); this.insertUnit(ctx, unit); });
  }
  private insertUnit(ctx: BlingContext, unit: BlingUnit): void {
    const existing = one(this.db, "SELECT * FROM wb_bling_unit WHERE id=? OR command_id=? OR attempt_id=?", unit.work_id, unit.command_id, unit.attempt_id);
    if (existing) { if (String(existing.id) !== unit.work_id || String(existing.command_id) !== unit.command_id || String(existing.attempt_id) !== unit.attempt_id || String(existing.request_hash) !== unit.request_hash) fail("BLING_COMMAND_CONFLICT"); return; }
    if (!unit.resource_key || !unit.entity) fail("BLING_RESPONSE_INVALID");
    this.db.exec("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,?)", ctx.clock.now());
    this.db.exec("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)", unit.resource_key, ctx.clock.now());
    this.db.exec("INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,account_id,parts_revision,kind,resource,entity,source_id,phase,plan,expected_checkpoint,expected_checkpoint_version,not_before,page_ids,page_fingerprint,subcursor,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)",
      unit.work_id, unit.attempt_id, unit.command_id, unit.request_hash, unit.expected.generation, unit.expected.authorization_revision, unit.expected.credential_revision, unit.expected.configuration_revision, unit.expected.account_id, unit.expected.parts_revision, unit.kind, unit.resource_key, unit.entity, unit.source_id,
      JSON.stringify(unit.plan), JSON.stringify(unit.checkpoint), unit.checkpoint.revision, unit.not_before, JSON.stringify(unit.page?.ids ?? []), unit.page?.fingerprint ?? null, unit.page?.subcursor ?? 0, JSON.stringify(unit.progress), ctx.clock.now(), ctx.clock.now());
  }

  receipt(_ctx: BlingContext, input: { command_id: string; request_hash: string; generation: string }): BlingReceipt | null {
    const auxiliary = one(this.db, "SELECT request_hash,generation,result FROM wb_bling_receipt WHERE command_id=?", input.command_id);
    const previous = auxiliary ?? one(this.db, "SELECT request_hash,result FROM origin_sync__batch_inbox WHERE batch_id=?", input.command_id);
    if (!previous) return null;
    const result = json<BlingReceipt>(previous.result, null as unknown as BlingReceipt);
    if (String(previous.request_hash) !== input.request_hash || result.generation !== input.generation) fail("BLING_COMMAND_CONFLICT");
    return result;
  }
  reserve(ctx: BlingContext, input: BlingReserveInput): { unit: BlingUnit; receipt: BlingReceipt | null } {
    if (!reserveInputSchema.safeParse(input).success || input.lease_until <= ctx.clock.now()) fail("BLING_RESPONSE_INVALID");
    return this.db.transaction(() => {
      const previous = this.receipt(ctx, { command_id: input.unit.command_id, request_hash: input.unit.request_hash, generation: input.unit.expected.generation });
      if (previous) return { unit: input.unit, receipt: previous };
      this.assertExpected(ctx, input.unit.expected, input.unit.resource_key); this.insertUnit(ctx, input.unit);
      const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE id=?", input.unit.work_id)!;
      const stored = this.decodeUnit(row), now = ctx.clock.now();
      if (stored.phase === "blocked" || stored.phase === "superseded" || stored.phase === "committed") fail("BLING_REVISION_CONFLICT");
      if (stored.not_before > now) throw new BlingError("BLING_RETRY_WAIT", { retry_at: stored.not_before });
      if (stored.lease && stored.lease.expires_at > now && stored.lease.owner !== input.owner) fail("BLING_LEASE_LOST");
      const resourceLease = one(this.db, "SELECT lease_owner,lease_token,lease_expires_at FROM origin_sync__resource_state WHERE resource=?", stored.resource_key);
      if (resourceLease?.lease_owner && numeric(resourceLease.lease_expires_at) > now &&
          (resourceLease.lease_owner !== input.owner || !stored.lease || resourceLease.lease_token !== stored.lease.fence)) fail("BLING_LEASE_LOST");
      const checkpoint = this.checkpoint(stored.resource_key!);
      if (checkpoint.revision !== stored.checkpoint.revision || canonical(checkpoint.cursor) !== canonical(stored.checkpoint.cursor)) fail("BLING_REVISION_CONFLICT");
      const fence = stored.lease && stored.lease.expires_at > now ? stored.lease.fence : this.options.randomId();
      this.db.exec("UPDATE wb_bling_unit SET phase='reserved',owner=?,fence=?,lease_until=?,updated_at=? WHERE id=?", input.owner, fence, input.lease_until, now, stored.work_id);
      this.db.exec("UPDATE origin_sync__resource_state SET lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=? WHERE resource=?", input.owner, fence, input.lease_until, now, stored.resource_key);
      if (!one(this.db, "SELECT id FROM erp_sync__run WHERE state IN ('queued','running')")) {
        // XML conserva trabalho/manifesto próprios. A rodada mede passagens
        // das entidades; um descritor de arquivo não é uma pista paginada.
        const control = this.control(ctx)!, resources = json<Array<string | { key: string; selected: boolean }>>(control.selection, []).flatMap(selection => typeof selection === "string" ? [selection] : selection.selected ? [selection.key] : []).filter(key => key !== "fiscal_xml");
        if (resources.length) {
          const runId = this.options.randomId();
          this.db.exec("INSERT INTO erp_sync__run(id,requested_by,requested_at,started_at,state,phase,cursor) VALUES(?,?,?,?,'running','fetch',?)", runId, ctx.identity.actor?.user_id ?? null, now, now, JSON.stringify({ resources }));
          this.audit(ctx, "erp_bling_run_start", stored.command_id, stored.expected.generation, {});
        }
      }
      return { unit: { ...stored, phase: "reserved", lease: { owner: input.owner, fence, expires_at: input.lease_until } }, receipt: null };
    });
  }
  private live(ctx: BlingContext, unit: BlingUnit): BlingUnit {
    const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE id=?", unit.work_id);
    if (!row) return fail("BLING_LEASE_LOST"); const stored = this.decodeUnit(row);
    if (!stored.lease || !unit.lease || stored.lease.fence !== unit.lease.fence || stored.lease.owner !== unit.lease.owner || stored.lease.expires_at <= ctx.clock.now() || stored.attempt_id !== unit.attempt_id || !["reserved", "fetching"].includes(stored.phase)) return fail("BLING_LEASE_LOST");
    const resourceLease = one(this.db, "SELECT lease_owner,lease_token,lease_expires_at FROM origin_sync__resource_state WHERE resource=?", stored.resource_key);
    if (!resourceLease || resourceLease.lease_owner !== stored.lease.owner || resourceLease.lease_token !== stored.lease.fence || numeric(resourceLease.lease_expires_at) <= ctx.clock.now()) return fail("BLING_LEASE_LOST");
    const control = this.assertExpected(ctx, stored.expected, stored.resource_key);
    if (typeof stored.plan.target_resource_key === "string" && !this.selected(control, stored.plan.target_resource_key)) fail("BLING_DISABLED");
    return stored;
  }
  renew(ctx: BlingContext, input: { work_id: string; attempt_id: string; owner: string; fence: string; lease_until: number }): BlingLease {
    return this.db.transaction(() => {
      const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE id=?", input.work_id); if (!row) return fail("BLING_LEASE_LOST");
      const unit = this.decodeUnit(row); this.live(ctx, { ...unit, attempt_id: input.attempt_id, lease: { owner: input.owner, fence: input.fence, expires_at: input.lease_until } });
      if (input.lease_until <= ctx.clock.now()) fail("BLING_LEASE_LOST");
      this.db.exec("UPDATE wb_bling_unit SET lease_until=?,updated_at=? WHERE id=?", input.lease_until, ctx.clock.now(), input.work_id);
      this.db.exec("UPDATE origin_sync__resource_state SET lease_expires_at=? WHERE resource=? AND lease_token=?", input.lease_until, unit.resource_key, input.fence);
      return { owner: input.owner, fence: input.fence, expires_at: input.lease_until };
    });
  }
  release(_ctx: BlingContext, input: { work_id: string; owner: string; fence: string }): void {
    this.db.transaction(() => {
      const row = one(this.db, "SELECT resource FROM wb_bling_unit WHERE id=? AND owner=? AND fence=? AND phase IN ('reserved','fetching')", input.work_id, input.owner, input.fence);
      if (!row) return;
      this.db.exec("UPDATE wb_bling_unit SET phase='queued',owner=NULL,fence=NULL,lease_until=NULL WHERE id=? AND owner=? AND fence=?", input.work_id, input.owner, input.fence);
      this.db.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE resource=? AND lease_owner=? AND lease_token=?", row.resource, input.owner, input.fence);
    });
  }
  markFetching(ctx: BlingContext, unit: BlingUnit): BlingUnit {
    return this.db.transaction(() => { const stored = this.live(ctx, unit); this.db.exec("UPDATE wb_bling_unit SET phase='fetching',updated_at=? WHERE id=?", ctx.clock.now(), unit.work_id); return { ...stored, phase: "fetching" }; });
  }

  takeCall(ctx: BlingContext, unit: BlingUnit): void {
    const refusal = this.db.transaction(() => {
      const stored = this.live(ctx, unit); if (stored.phase !== "fetching") fail("BLING_REVISION_CONFLICT");
      const control = this.assertExpected(ctx, unit.expected, unit.resource_key), now = ctx.clock.now();
      if (control.credential_status !== "ready") return fail("BLING_AUTH_REQUIRED");
      if (numeric(control.next_allowed_at) > now) throw new BlingError("BLING_RATE_WAIT", { retry_at: numeric(control.next_allowed_at) });
      const day = new Date(now - 3 * 60 * 60_000).toISOString().slice(0, 10), used = control.calls_day === day ? numeric(control.calls_today) : 0;
      if (used >= numeric(control.daily_call_limit)) {
        const retryAt = Date.parse(day + "T03:00:00Z") + 86_400_000;
        this.db.exec("UPDATE wb_bling_control SET next_allowed_at=?,state='waiting_rate',updated_at=? WHERE id=1", retryAt, now);
        return new BlingError("BLING_RATE_WAIT", { retry_at: retryAt });
      }
      // A resposta é limitada a 8 MiB. Reservar antes do GET seu pior caso,
      // captura/índices/recibo e os snapshots que ela poderá substituir.
      const writesSources = unit.kind !== "list" || !!unit.plan.fallback_id;
      let projectedGrowth = 4096 + (writesSources ? 3 * 8_388_608 + 10 * 8192 : 16_384);
      if (writesSources && Array.isArray(unit.plan.source_expectations)) {
        for (const source of unit.plan.source_expectations.slice(0, 10)) {
          if (!source || typeof source !== "object" || Array.isArray(source)) fail("BLING_RESPONSE_INVALID");
          const identity = (source as JsonObject).identity as unknown as RecordIdentity;
          if (!identity || typeof identity.entity !== "string" || typeof identity.source_id !== "string") fail("BLING_RESPONSE_INVALID");
          if (identity.entity !== unit.entity) continue;
          projectedGrowth += numeric(one(this.db, `SELECT length(CAST(payload AS BLOB)) AS bytes FROM ${rawTable(identity.entity)} WHERE entity=? AND source_id=?`, identity.entity, identity.source_id)?.bytes);
        }
      }
      if (this.options.databaseSize() + projectedGrowth >= BLING_BUDGET.database_ceiling_bytes * BLING_BUDGET.stop_ratio) fail("BLING_CAPACITY_STOP");
      this.db.exec("UPDATE wb_bling_control SET calls_day=?,calls_today=?,next_allowed_at=?,state='running',updated_at=? WHERE id=1", day, used + 1, now + Math.max(700, numeric(control.min_interval_ms)), now);
      return null;
    });
    if (refusal) throw refusal;
  }
  pauseAccount(ctx: BlingContext, unit: BlingUnit, retryAt: number, error: BlingFailure): void {
    this.db.transaction(() => {
      this.live(ctx, unit);
      this.db.exec("UPDATE wb_bling_control SET next_allowed_at=max(coalesce(next_allowed_at,0),?),state=?,updated_at=? WHERE id=1", retryAt, error.code === "BLING_RATE_WAIT" ? "waiting_rate" : "waiting_retry", ctx.clock.now());
    });
  }

  readCurrent(ctx: BlingContext, identity: RecordIdentity): BlingRawRecord | null {
    const control = this.control(ctx);
    if (identity.profile !== ctx.profile || !control || control.account_id !== identity.account_id) return fail("BLING_ACCOUNT_MISMATCH");
    const row = one(this.db, `SELECT * FROM ${rawTable(identity.entity)} WHERE entity=? AND source_id=?`, identity.entity, identity.source_id);
    if (!row) return null;
    const metadata = one(this.db, "SELECT * FROM wb_bling_record_version WHERE entity=? AND source_id=? AND version=?", identity.entity, identity.source_id, row.version);
    const extra = json<JsonObject>(metadata?.metadata, {});
    const storedCapture = json<Record<string, unknown> | null>(metadata?.capture ?? row.price_capture, null);
    // Evidência legada sem vínculo semântico é conservada no raw e requer reparo.
    let capture = storedCapture?.semantic_hash === row.version_hash && String(storedCapture?.semantic_version) === String(row.version) ? storedCapture as unknown as BlingRawRecord["capture"] : null;
    if (!capture && storedCapture && storedCapture.source_hash === row.version_hash && String(storedCapture.source_version) === String(row.version) && storedCapture.source === "detail" && typeof storedCapture.response_sha256 === "string" && /^[a-f0-9]{64}$/.test(storedCapture.response_sha256) && Array.isArray(storedCapture.tokens)) {
      const candidate: NonNullable<BlingRawRecord["capture"]> = { revision: "1", profile: String(storedCapture.profile), source: "detail", bytes_sha256: storedCapture.response_sha256, semantic_hash: String(row.version_hash), semantic_version: String(row.version), values: storedCapture.tokens as NonNullable<BlingRawRecord["capture"]>["values"] };
      try {
        const semantic = semanticHash(String(row.payload), json<JsonObject[]>(row.document_links, []));
        validateRecord({ identity, version: String(row.version), semantic_hash: semantic, payload_text: String(row.payload), document_links: json<JsonObject[]>(row.document_links, []), observed_at: iso(row.last_seen_at)!, source_updated_at: null, source_time_quality: "unknown", deleted: false, deletion_evidence: null, capture: { ...candidate, semantic_hash: semantic } });
        capture = candidate;
      } catch { /* Prova legada incompleta continua disponível no raw e elegível a reparo. */ }
    }
    return { identity, version: String(row.version), semantic_hash: String(row.version_hash), payload_text: String(row.payload), document_links: json<JsonObject[]>(row.document_links, []), observed_at: iso(row.last_seen_at)!, source_updated_at: typeof extra.source_updated_text === "string" ? extra.source_updated_text : iso(row.source_updated_at),
      source_time_quality: (metadata?.source_time_quality ?? (row.source_updated_at === null ? "unknown" : "remote")) as BlingRawRecord["source_time_quality"], deleted: !!metadata?.deleted_observed,
      deletion_evidence: metadata?.deletion_evidence ? String(json<JsonObject>(metadata.deletion_evidence, {}).evidence ?? "explicit") : null,
      capture };
  }
  knownProducts(after = "", limit = 25): string[] {
    return this.db.exec("SELECT source_id FROM origin_sync__raw_record WHERE entity='products' AND source_id>? ORDER BY source_id LIMIT ?", after, Math.max(1, Math.min(25, limit))).rows.map(row => String(row.source_id));
  }
  scanSources(ctx: BlingContext, entity: BlingEntity, after = "", limit = 10): BlingRawRecord[] {
    const control = this.control(ctx); if (!control?.account_id) return [];
    return this.db.exec(`SELECT source_id FROM ${rawTable(entity)} WHERE entity=? AND source_id>? ORDER BY source_id LIMIT ?`, entity, after, Math.max(1, Math.min(10, limit))).rows.map(row => this.readCurrent(ctx, { profile: ctx.profile, account_id: String(control.account_id), entity, source_id: String(row.source_id) })!);
  }

  isCaptureRepairAllowed(_ctx: BlingContext, record: BlingRawRecord): boolean {
    if (record.identity.entity !== "sales_orders") return true;
    if (one(this.db, "SELECT 1 FROM erp_sales_history__snapshot WHERE source_id=? LIMIT 1", record.identity.source_id)) return false;
    if (!record.capture || record.capture.source !== "detail" || record.capture.semantic_hash !== record.semantic_hash || record.capture.semantic_version !== record.version) return true;
    try {
      const semantic = semanticHash(record.payload_text, record.document_links);
      validateRecord({ ...record, semantic_hash: semantic, capture: { ...record.capture, semantic_hash: semantic } });
      return false;
    } catch { return true; }
  }
  isReferenceWitnessAllowed(_ctx: BlingContext, record: BlingRawRecord): boolean {
    return record.identity.entity === "sales_proposals" && !one(this.db, "SELECT 1 FROM erp_documents__origin_import_origin WHERE entity='sales_proposals' AND source_id=? LIMIT 1", record.identity.source_id);
  }

  commitBatch(ctx: BlingContext, input: BlingCommitInput): BlingReceipt {
    if (!commitInputSchema.safeParse(input).success) fail("BLING_RESPONSE_INVALID");
    const responseHash = hash(canonical({ records: input.records, checkpoint: input.next_checkpoint, counts: input.counts, expectations: input.source_expectations, page: input.unit.page, progress: input.unit.progress }));
    return this.commitTransaction(() => {
      const previous = this.receipt(ctx, { command_id: input.unit.command_id, request_hash: input.request_hash, generation: input.expected.generation });
      if (previous) {
        const committed = one(this.db, "SELECT response_hash FROM wb_bling_unit WHERE id=? AND command_id=?", input.unit.work_id, input.unit.command_id);
        if (!committed || committed.response_hash !== responseHash) fail("BLING_COMMAND_CONFLICT");
        return previous;
      }
      const unit = this.live(ctx, input.unit);
      if (unit.phase !== "fetching" || unit.lease?.fence !== input.fence || unit.request_hash !== input.request_hash) fail("BLING_LEASE_LOST");
      if (canonical(input.expected) !== canonical(unit.expected) || canonical(input.unit.plan) !== canonical(unit.plan)) fail("BLING_COMMAND_CONFLICT");
      if (unit.plan.source_expectations && canonical(unit.plan.source_expectations) !== canonical(input.source_expectations)) fail("BLING_COMMAND_CONFLICT");
      const checkpoint = this.checkpoint(unit.resource_key!);
      if (checkpoint.revision !== unit.checkpoint.revision || canonical(checkpoint.cursor) !== canonical(unit.checkpoint.cursor) || BigInt(input.next_checkpoint.revision) !== BigInt(checkpoint.revision) + 1n) fail("BLING_REVISION_CONFLICT");
      for (const expected of input.source_expectations) {
        const current = this.readCurrent(ctx, expected.identity);
        if ((current?.version ?? null) !== expected.version || (current?.semantic_hash ?? null) !== expected.semantic_hash) fail("BLING_REVISION_CONFLICT");
        if (expected.identity.entity === unit.entity && expected.identity.source_id === unit.source_id && unit.plan.source_seen_at && current?.observed_at !== unit.plan.source_seen_at) fail("BLING_REVISION_CONFLICT");
      }
      if (unit.plan.local_only === true && (unit.source_id !== null || input.records.length || input.source_expectations.length)) fail("BLING_RESPONSE_INVALID");
      if (unit.kind === "reference" || unit.kind === "capture_repair" && unit.entity === "products" && unit.plan.local_only !== true) {
        const proof = input.source_expectations.find(source => source.identity.entity === "sales_proposals");
        const witness = proof && this.readCurrent(ctx, proof.identity);
        if (!witness || !this.isReferenceWitnessAllowed(ctx, witness) || encoder.encode(witness.payload_text).byteLength > 524288 || unit.plan.witness_seen_at && unit.plan.witness_seen_at !== witness.observed_at) fail("BLING_REVISION_CONFLICT");
        const payload = payloadObject(witness!);
        if (!["Rascunho", "Pendente", "Aguardando"].includes(String(payload.situacao)) || !Array.isArray(payload.itens) || !payload.itens.length || payload.itens.length > 250) fail("BLING_REVISION_CONFLICT");
        const matches = unit.entity === "contacts" ? scalar((payload.contato as Record<string, unknown> | undefined)?.id) === unit.source_id : unit.entity === "products" && (payload.itens as Record<string, unknown>[]).some(item => scalar((item?.produto as Record<string, unknown> | undefined)?.id) === unit.source_id);
        if (!matches) fail("BLING_REVISION_CONFLICT");
      }
      let estimate = 4096, changed = 0, observed = 0;
      for (const record of input.records) {
        validateRecord(record); this.options.validateRecord?.(ctx, record);
        if (record.capture?.source === "deleted_without_detail") {
          const page = unit.checkpoint.cursor.page as JsonObject | undefined;
          if (unit.kind !== "list" || unit.plan.fallback_id !== record.identity.source_id || page?.fallback_id !== record.identity.source_id || !getBlingResource(unit.resource_key!).variants.some(variant => variant.deleted)) fail("BLING_RESPONSE_INVALID");
        } else if (record.capture && record.capture.source !== (record.identity.entity === "stock_balances" ? "stock_product" : "detail")) fail("BLING_RESPONSE_INVALID");
        if (unit.kind === "capture_repair") { const source = this.readCurrent(ctx, record.identity); if (source && !this.isCaptureRepairAllowed(ctx, source)) fail("BLING_REVISION_CONFLICT"); }
        if (record.identity.entity !== unit.entity || record.identity.profile !== ctx.profile || record.identity.account_id !== unit.expected.account_id) fail("BLING_RESPONSE_INVALID");
        const old = this.readCurrent(ctx, record.identity);
        estimate += encoder.encode(record.payload_text).byteLength * 3 + (old ? encoder.encode(old.payload_text).byteLength : 0) + 8192;
      }
      if (this.options.databaseSize() + estimate >= BLING_BUDGET.database_ceiling_bytes * BLING_BUDGET.stop_ratio) fail("BLING_CAPACITY_STOP");
      const now = ctx.clock.now();
      for (const incoming of input.records) {
        const result = this.stage(ctx, unit, incoming); changed += result.changed; observed += result.observed;
      }
      const nextCursor = { ...input.next_checkpoint.cursor, pass_started_at: input.next_checkpoint.pass_started_at, pass_completed_at: input.next_checkpoint.pass_completed_at,
        observed_count: numeric(checkpoint.cursor.observed_count) + observed, changed_count: numeric(checkpoint.cursor.changed_count) + changed };
      this.db.exec("UPDATE origin_sync__resource_state SET checkpoint=?,checkpoint_version=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE resource=? AND checkpoint_version=?", JSON.stringify(nextCursor), input.next_checkpoint.revision, now, unit.resource_key, checkpoint.revision);
      const counts = { ...input.counts, observed, changed };
      const receipt: BlingReceipt = { command_id: unit.command_id, request_hash: unit.request_hash, generation: unit.expected.generation, operation: "erp_bling_collect_unit", state: "committed", committed_at: new Date(now).toISOString(), references: { work_id: unit.work_id, attempt_id: unit.attempt_id, checkpoint_revision: input.next_checkpoint.revision }, counts, error: null };
      this.db.exec("UPDATE wb_bling_unit SET phase='committed',page_ids=?,page_fingerprint=?,subcursor=?,progress=?,response_hash=?,finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", JSON.stringify(input.unit.page?.ids ?? []), input.unit.page?.fingerprint ?? null, input.unit.page?.subcursor ?? 0, JSON.stringify(input.unit.progress), responseHash, now, now, unit.work_id);
      this.db.exec("UPDATE wb_bling_control SET archive_bytes=archive_bytes+?,observed_count=observed_count+?,state='ready',updated_at=? WHERE id=1", estimate, observed, now);
      if (legacy(unit.entity!)) this.db.exec("INSERT INTO origin_sync__batch_inbox(batch_id,resource,entity,owner,lease_token,request_hash,checkpoint_before,checkpoint_after,result,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?)", unit.command_id, unit.resource_key, unit.entity, unit.lease!.owner, unit.lease!.fence, unit.request_hash, JSON.stringify(unit.checkpoint), JSON.stringify(input.next_checkpoint), JSON.stringify(receipt), now);
      else this.writeReceipt(receipt, unit);
      const run = one(this.db, "SELECT id,stats,cursor,requested_at FROM erp_sync__run WHERE state IN ('queued','running')");
      if (run) {
        const stats = json<Record<string, number>>(run.stats, {}); for (const [key, value] of Object.entries(counts)) stats[key] = (stats[key] ?? 0) + value;
        const runCursor = { ...json<JsonObject>(run.cursor, {}), resource: unit.resource_key, checkpoint: input.next_checkpoint.revision };
        const completedPass = input.next_checkpoint.pass_completed_at && input.next_checkpoint.pass_completed_at !== unit.checkpoint.pass_completed_at;
        const completedRun = !!completedPass && this.runPassesComplete(runCursor, Number(run.requested_at));
        this.db.exec("UPDATE erp_sync__run SET state=?,phase=?,started_at=coalesce(started_at,?),finished_at=?,stats=?,cursor=? WHERE id=?", completedRun ? "done" : "running", completedRun ? "done" : "fetch", now, completedRun ? now : null, JSON.stringify(stats), JSON.stringify(runCursor), run.id);
        if (completedRun) this.audit(ctx, "erp_bling_run_complete", unit.command_id, unit.expected.generation, stats);
      }
      const passReferences = { resource: unit.resource_key, checkpoint_revision: input.next_checkpoint.revision };
      if (input.next_checkpoint.pass_started_at && input.next_checkpoint.pass_started_at !== unit.checkpoint.pass_started_at)
        this.audit(ctx, "erp_bling_pass_start", unit.command_id, unit.expected.generation, counts, null,
          { ...passReferences, pass_started_at: input.next_checkpoint.pass_started_at });
      if (input.next_checkpoint.pass_completed_at && input.next_checkpoint.pass_completed_at !== unit.checkpoint.pass_completed_at) {
        this.audit(ctx, "erp_bling_pass_complete", unit.command_id, unit.expected.generation, counts, null,
          { ...passReferences, pass_completed_at: input.next_checkpoint.pass_completed_at });
        this.audit(ctx, "erp_bling_coverage_changed", unit.command_id, unit.expected.generation, counts, null,
          { ...passReferences, pass_completed_at: input.next_checkpoint.pass_completed_at, coverage_complete: false });
      }
      return receipt;
    });
  }

  private runPassesComplete(cursor: JsonObject, requestedAt: number): boolean {
    if (!Array.isArray(cursor.resources) || !cursor.resources.length || cursor.resources.length > 128) return false;
    const requested = (cursor.requested_since ?? {}) as JsonObject;
    for (const key of cursor.resources) {
      if (typeof key !== "string") return false;
      let lanes; try { lanes = resourceVariants(key); } catch { return false; }
      if (!lanes.length) return false;
      for (const lane of lanes) {
        const checkpoint = this.checkpoint(lane.key).cursor;
        const required = lane.dateFilter?.kind === "U" ? ["unfiltered"] : ["recent", "history"];
        const since = typeof requested[key] === "number" ? requested[key] as number : requestedAt;
        if (required.some(kind => typeof checkpoint[`${kind}PassCompletedAt`] !== "string" || !(Date.parse(checkpoint[`${kind}PassCompletedAt`] as string) >= since))) return false;
      }
    }
    // Encerrar rodada é só evidência das passagens; cobertura permanece incompleta.
    return true;
  }

  private stage(ctx: BlingContext, unit: BlingUnit, incoming: BlingRawRecord): { observed: number; changed: number } {
    const table = rawTable(incoming.identity.entity), old = this.readCurrent(ctx, incoming.identity), now = ctx.clock.now();
    const remoteTime = incoming.source_time_quality === "remote" && incoming.source_updated_at !== null ? remoteTimestampMillis(incoming.source_updated_at) : null;
    if (incoming.source_time_quality === "remote" && remoteTime === null) fail("BLING_RESPONSE_INVALID");
    const oldRemoteTime = old?.source_time_quality === "remote" && old.source_updated_at ? remoteTimestampMillis(old.source_updated_at) : null;
    if (old && oldRemoteTime !== null && remoteTime !== null && remoteTime < oldRemoteTime) {
      this.db.exec(`UPDATE ${table} SET last_seen_at=max(last_seen_at,?) WHERE entity=? AND source_id=?`, now, incoming.identity.entity, incoming.identity.source_id);
      this.db.exec("UPDATE wb_bling_record_version SET last_seen_at=max(last_seen_at,?) WHERE entity=? AND source_id=? AND version=?", now, incoming.identity.entity, incoming.identity.source_id, old.version);
      return { observed: 1, changed: 0 };
    }
    const links = incoming.document_links.length ? incoming.document_links : old?.document_links ?? [];
    const incomingSemantic = semanticHash(incoming.payload_text, links);
    // Hash legado tem outra codificação canônica. Conteúdo equivalente preserva
    // sua versão/hash; a primeira alteração real passa a usar o canonicalizador comum.
    const semantic = old && semanticHash(old.payload_text, old.document_links) === incomingSemantic ? old.semantic_hash : incomingSemantic;
    const changed = !old || old.semantic_hash !== semantic;
    const version = old ? String(BigInt(old.version) + (changed ? 1n : 0n)) : "1";
    const payloadText = old && !changed ? old.payload_text : incoming.payload_text;
    const timestamp = !changed && remoteTime === null ? oldRemoteTime : remoteTime;
    const timeQuality = timestamp !== null && incoming.source_time_quality !== "remote" && !changed ? "remote" : incoming.source_time_quality;
    const capture = incoming.capture ? { ...incoming.capture, semantic_hash: semantic, semantic_version: version, revision: String(BigInt(old?.capture?.revision ?? "0") + (canonical(incoming.capture.values) === canonical(old?.capture?.values) && incoming.capture.bytes_sha256 === old?.capture?.bytes_sha256 ? 0n : 1n)) } : !changed ? old?.capture ?? null : null;
    if (old && changed) {
      this.db.exec("INSERT INTO erp_document_mirror__source_version(entity,source_id,source_version,source_hash,payload,document_links,price_capture,observed_at,source_updated_at) SELECT entity,source_id,version,version_hash,payload,document_links,price_capture,last_seen_at,source_updated_at FROM " + table + " WHERE entity=? AND source_id=?", incoming.identity.entity, incoming.identity.source_id);
    }
    if (old) this.db.exec(`UPDATE ${table} SET last_resource=?,payload=?,document_links=?,version_hash=?,version=?,source_updated_at=?,last_seen_at=?,changed_at=CASE WHEN version_hash<>? THEN ? ELSE changed_at END,price_capture=CASE WHEN ? IS NULL AND version_hash=? THEN price_capture ELSE ? END WHERE entity=? AND source_id=?`, unit.resource_key, payloadText, JSON.stringify(links), semantic, version, timestamp, now, semantic, now, capture ? JSON.stringify(capture) : null, semantic, capture ? JSON.stringify(capture) : null, incoming.identity.entity, incoming.identity.source_id);
    else this.db.exec(`INSERT INTO ${table}(entity,source_id,last_resource,payload,document_links,version_hash,version,source_updated_at,first_seen_at,last_seen_at,changed_at,price_capture${legacy(incoming.identity.entity) ? "" : ",generation"}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?${legacy(incoming.identity.entity) ? "" : ",?"})`, incoming.identity.entity, incoming.identity.source_id, unit.resource_key, payloadText, JSON.stringify(links), semantic, version, timestamp, now, now, now, capture ? JSON.stringify(capture) : null, ...(legacy(incoming.identity.entity) ? [] : [unit.expected.generation]));
    const size = encoder.encode(payloadText).byteLength;
    const evidence = incoming.deletion_evidence ? JSON.stringify({ evidence: incoming.deletion_evidence }) : null;
    const oldMetadata = old ? one(this.db, "SELECT metadata FROM wb_bling_record_version WHERE entity=? AND source_id=? AND version=?", incoming.identity.entity, incoming.identity.source_id, old.version) : null;
    const metadata = json<JsonObject>(oldMetadata?.metadata, {});
    metadata.source_updated_text = timestamp === remoteTime ? incoming.source_updated_at : old?.source_updated_at ?? null;
    metadata.source_unit = unit.work_id;
    if (incoming.identity.entity === "stock_balances") {
      const partition = unit.plan.stock_partition;
      if (![0, 1, 2].includes(Number(partition))) fail("BLING_RESPONSE_INVALID");
      const group = typeof unit.plan.stock_group === "string" ? unit.plan.stock_group : unit.page?.fingerprint ?? "", observations = (metadata.partitions ?? {}) as JsonObject;
      const conflict = Object.entries(observations).some(([key, value]) => key !== String(partition) && value && typeof value === "object" && !Array.isArray(value) && value.group === group && value.semantic_hash !== semantic);
      observations[String(partition)] = { group, semantic_hash: semantic, observed_at: new Date(now).toISOString() };
      metadata.partitions = observations; metadata.partition = Number(partition);
      if (conflict) {
        metadata.partition_divergence = true;
        this.db.exec("INSERT INTO erp_sync__issue(created_at,direction,entity,source_id,code,detail) SELECT ?,'census','stock_balances',?,'BLING_STOCK_PARTITION_DIVERGENCE',? WHERE NOT EXISTS(SELECT 1 FROM erp_sync__issue WHERE direction='census' AND entity='stock_balances' AND source_id=? AND code='BLING_STOCK_PARTITION_DIVERGENCE' AND resolved_at IS NULL)", now, incoming.identity.source_id, "Saldos divergentes entre partições observadas; cobertura incompleta.", incoming.identity.source_id);
      }
    }
    this.db.exec("INSERT INTO wb_bling_record_version(entity,source_id,version,generation,semantic_hash,size_bytes,first_seen_at,last_seen_at,source_updated_at,source_time_quality,deleted_observed,deletion_evidence,references_json,capture_revision,capture,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity,source_id,version) DO UPDATE SET last_seen_at=excluded.last_seen_at,source_updated_at=excluded.source_updated_at,source_time_quality=excluded.source_time_quality,deleted_observed=max(deleted_observed,excluded.deleted_observed),deletion_evidence=coalesce(excluded.deletion_evidence,deletion_evidence),capture_revision=excluded.capture_revision,capture=excluded.capture,metadata=excluded.metadata",
      incoming.identity.entity, incoming.identity.source_id, version, unit.expected.generation, semantic, size, now, now, timestamp, timeQuality, incoming.deleted ? 1 : 0, evidence, JSON.stringify(links), capture?.revision ?? "0", capture ? JSON.stringify(capture) : null, JSON.stringify(metadata));
    if (changed) this.db.exec("INSERT INTO erp_sync__inbox(entity,source_id,version,seen_at,retry_at) VALUES(?,?,?,?,?) ON CONFLICT(entity,source_id) DO UPDATE SET version=excluded.version,seen_at=excluded.seen_at,retry_at=min(retry_at,excluded.retry_at)", incoming.identity.entity, incoming.identity.source_id, version, now, now);
    return { observed: 1, changed: changed ? 1 : 0 };
  }

  reschedule(ctx: BlingContext, input: { unit: BlingUnit; not_before: number; error: BlingFailure; blocked: boolean }): void {
    if (!unitSchema.safeParse(input.unit).success) fail("BLING_RESPONSE_INVALID");
    this.db.transaction(() => {
      const unit = this.live(ctx, input.unit), now = ctx.clock.now();
      const error = new BlingError(input.error.code).toJSON();
      this.db.exec("UPDATE wb_bling_unit SET phase=?,not_before=?,error_code=?,progress=?,owner=NULL,fence=NULL,lease_until=NULL,updated_at=? WHERE id=?", input.blocked ? "blocked" : "waiting", Math.max(now, input.not_before), error.code, JSON.stringify(input.unit.progress), now, unit.work_id);
      this.db.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE resource=? AND lease_token=?", now, unit.resource_key, unit.lease!.fence);
      const state = error.code === "BLING_CAPACITY_STOP" ? "blocked_capacity" : error.code === "BLING_SCOPE_REQUIRED" ? "blocked_scope" : error.code === "BLING_RATE_WAIT" ? "waiting_rate" : error.code === "BLING_AUTH_REQUIRED" ? "needs_authorization" : "waiting_retry";
      this.db.exec("UPDATE wb_bling_control SET state=?,updated_at=? WHERE id=1", state, now);
      if (input.blocked || input.unit.progress.unavailable) {
        this.db.exec("INSERT INTO erp_sync__issue(created_at,direction,entity,source_id,code,detail) SELECT ?,'census',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM erp_sync__issue WHERE direction='census' AND entity=? AND source_id IS ? AND code=? AND resolved_at IS NULL)", now, unit.entity, unit.source_id, error.code, error.message, unit.entity, unit.source_id, error.code);
        this.audit(ctx, "erp_bling_collect_blocked", unit.command_id, unit.expected.generation, {}, error.code);
      }
    });
  }

  requestCollection(ctx: BlingContext, input: BlingOperationMap["erp_bling_collect_request"]["input"]): BlingOperationMap["erp_bling_collect_request"]["output"] {
    authorizeBlingOperation(ctx, "erp_bling_collect_request", input);
    if (!BLING_OPERATIONS.erp_bling_collect_request.input.safeParse(input).success) fail("BLING_RESPONSE_INVALID");
    return this.db.transaction(() => {
      const control = this.control(ctx); if (!control?.collect_enabled) return fail("BLING_DISABLED");
      if (ctx.identity.actor?.is_agent) {
        const policy = json<{ bots?: { bot_id: string; entities: string[]; allow_sensitive?: boolean }[] }>(control.permissions, {});
        const bot = policy.bots?.find(entry => entry.bot_id === ctx.authorization?.bot?.id);
        if (ctx.authorization?.bot?.allow_sensitive && !bot?.allow_sensitive) fail("BLING_SCOPE_REQUIRED");
        if (input.resource_keys.some(key => !(bot?.entities ?? [...BLING_ENTITIES]).includes(key === BLING_XML_RESOURCE.key ? BLING_XML_RESOURCE.entity : getBlingResource(key).entity))) fail("BLING_SCOPE_REQUIRED");
      }
      const requestHash = ctx.authorization?.request_hash ?? hash(JSON.stringify(input));
      const previous = this.receipt(ctx, { command_id: input.command_id, request_hash: requestHash, generation: String(control.generation) });
      if (previous) return { run_id: String(previous.references.run_id), next_wake: previous.references.next_wake as number | null, receipt: previous };
      if (String(control.revision) !== input.expected_revision) fail("BLING_REVISION_CONFLICT");
      if (!input.resource_keys.length || input.resource_keys.some(key => !this.selected(control, key))) fail("BLING_DISABLED");
      const requestedResources = input.resource_keys.filter(key => key !== BLING_XML_RESOURCE.key), xmlRequested = input.resource_keys.includes(BLING_XML_RESOURCE.key);
      const existing = requestedResources.length ? one(this.db, "SELECT id,cursor FROM erp_sync__run WHERE state IN ('queued','running')") : null;
      const runId = existing ? String(existing.id) : this.options.randomId(), now = ctx.clock.now();
      if (!requestedResources.length) {
        // Pedido apenas de XML não inventa uma passagem paginada nem prova
        // que seus arquivos estejam prontos; o manifesto informa esse estado.
        this.db.exec("INSERT INTO erp_sync__run(id,requested_by,requested_at,started_at,finished_at,state,phase,cursor) VALUES(?,?,?,?,?,'done','done',?)", runId, ctx.identity.actor!.user_id, now, now, now, JSON.stringify({ resources: [], xml_requested: true, xml_complete: false }));
      }
      else if (!existing) this.db.exec("INSERT INTO erp_sync__run(id,requested_by,requested_at,state,phase,cursor) VALUES(?,?,?,'queued','fetch',?)", runId, ctx.identity.actor!.user_id, now, JSON.stringify({ resources: requestedResources, xml_requested: xmlRequested }));
      else {
        const cursor = json<JsonObject>(existing.cursor, {}), since = (cursor.requested_since ?? {}) as JsonObject;
        const resources = new Set((Array.isArray(cursor.resources) ? cursor.resources : []).filter(key => key !== BLING_XML_RESOURCE.key));
        for (const resource of requestedResources) { resources.add(resource); since[resource] = now; }
        this.db.exec("UPDATE erp_sync__run SET cursor=? WHERE id=?", JSON.stringify({ ...cursor, resources: [...resources], requested_since: since, xml_requested: xmlRequested || cursor.xml_requested === true }), runId);
      }
      const nextWake = Math.max(now, numeric(control.next_allowed_at));
      const receipt: BlingReceipt = { command_id: input.command_id, request_hash: requestHash, generation: String(control.generation), operation: "erp_bling_collect_request", state: "committed", committed_at: new Date(now).toISOString(), references: { run_id: runId, next_wake: nextWake, xml_requested: xmlRequested }, counts: {}, error: null };
      this.writeReceipt(receipt); this.audit(ctx, receipt.operation, input.command_id, receipt.generation, {}); return { run_id: runId, next_wake: nextWake, receipt };
    });
  }
  private writeReceipt(receipt: BlingReceipt, unit?: BlingUnit): void {
    this.db.exec("INSERT INTO wb_bling_receipt(command_id,operation,request_hash,generation,unit_id,attempt_id,state,result,references_json,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", receipt.command_id, receipt.operation, receipt.request_hash, receipt.generation, unit?.work_id ?? null, unit?.attempt_id ?? null, receipt.state, JSON.stringify(receipt), JSON.stringify(receipt.references), receipt.error?.code ?? null, Date.parse(receipt.committed_at));
  }
  private audit(ctx: BlingContext, operation: string, command: string, generation: string, counts: Record<string, number>, code: string | null = null, references: JsonObject = {}): void {
    this.db.exec("INSERT INTO wb_bling_audit(id,actor_id,operation,command_id,generation,counts,references_json,code,created_at) VALUES(?,?,?,?,?,?,?,?,?)", this.options.randomId(), ctx.identity.actor?.user_id ?? "collector", operation, command, generation, JSON.stringify(counts), JSON.stringify(references), code, ctx.clock.now());
  }
}

export function createCollectionStore(options: CollectionRepositoryOptions): SqliteCollectionStore { return new SqliteCollectionStore(options); }
