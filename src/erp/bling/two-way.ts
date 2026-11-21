/** Mão dupla com o Bling, depois do corte (tabelas da versão 19).
 *
 * Receber (entrada): a coleta incremental continua trazendo o que mudou no
 * Bling; aqui, para as entidades com "Receber do Bling" ligado, cada registro
 * novo do acervo é adotado e cada registro já ligado recebe a versão nova pelas
 * mesmas funções da adoção (RPCs das telas). Sem I/O externo.
 *
 * Escrever (saída): para as entidades com "Escrever no Bling" ligado, a
 * varredura compara a impressão do que seria enviado com a da última
 * sincronização; mudou, vira item da fila de saída com id estável. Um item por
 * acordada do alarme do Coordinator, uma chamada HTTP por vez, dentro do limite
 * de taxa da conta. Resposta incerta nunca é repetida às cegas: o item fica
 * "conferindo" e o próximo passo é um GET no Bling. Queda no meio do envio
 * (item ficou "enviando") também é conferida antes de qualquer reenvio.
 *
 * Conflito: o mesmo registro mudou nos dois lados desde a última
 * sincronização. Nada é sobrescrito: vira pendência com os dois lados e a
 * pessoa escolhe. Sem conflito, a mudança mais recente vence (a do lado que
 * mudou). Interruptores todos desligados por padrão: desligado, nada é enviado. */
import { formatScaled, toScaled } from "../engine/dec.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { invokeRpc, type RpcContext } from "../engine/registry.ts";
import { todaySaoPaulo } from "../engine/time.ts";
import { ERP_PART_MODULES, ERP_PART_NAMES, type ErpParts } from "../parts.ts";
import type { BlingContext } from "./contracts.ts";
import {
  BLING_ADOPTION_REASONS, BLING_ADOPTION_UPDATABLE, BlingAdoptionError, isAdoptionB2,
  type BlingAdoptionB2Entity, type BlingAdoptionEntity, type BlingAdoptionOperationMap, type BlingAdoptionRecordEntity,
} from "./adoption-contracts.ts";
import { adoptCollected, applyBlingUpdate, blingSummary, command, domainFailure, erpSummary, systemIdentity, transaction, type AdoptionCall } from "./adoption.ts";
import { applyB2Update, BLING_TWO_WAY_SETTLE_NOTE } from "./adoption-documents.ts";
import { adoptionTables, archiveAvailable, at, clip, commandUuid, linkOf, readRaw, sourceOf, text, writeLink, type AdoptionRaw, type Json } from "./adoption-store.ts";
import {
  BLING_TWO_WAY_ACTIONS, BLING_TWO_WAY_DIRECTIONS, BLING_TWO_WAY_ENTITIES, BLING_TWO_WAY_ISSUE_KINDS, BLING_TWO_WAY_LABELS, BLING_TWO_WAY_OPS, BLING_TWO_WAY_PARTS,
  BLING_TWO_WAY_PRIORITY, BLING_TWO_WAY_SINGULAR, BLING_TWO_WAY_STATES, BLING_TWO_WAY_TEXTS,
  type BlingTwoWayAction, type BlingTwoWayDirection, type BlingTwoWayEntity, type BlingTwoWayIssue, type BlingTwoWayIssueKind, type BlingTwoWayOp,
  type BlingTwoWayQueueItem, type BlingTwoWayState, type BlingTwoWayStatus,
} from "./two-way-contracts.ts";
import {
  BLING_TWO_WAY_PATHS, blingIdOf, centsOfRemote, dataOf, decimalText, erpSnapshot, naturalMatches, remoteHas, remoteId, settlementPlan, stockOf, twoWayHash, upsertRequest,
  type Snapshot,
} from "./two-way-map.ts";
import type { BlingWritePort } from "./writer.ts";
import { resolveReturnIssue, returnsQueueRows, returnsStatus } from "./returns.ts";

type Map_<K extends keyof BlingAdoptionOperationMap> = BlingAdoptionOperationMap[K];
const iso = (v: unknown) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();
const one = (db: SqlDriver, sql: string, ...params: unknown[]): Row | undefined => db.exec(sql, ...params).rows[0];
const parse = (value: unknown): Json => { try { const v = JSON.parse(String(value ?? "{}")); return v && typeof v === "object" && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };
/** Limites de uma unidade local do alarme (entrada e varredura): poucos registros, pouco tempo. */
export const TWO_WAY_UNIT = Object.freeze({ records: 40, wall_ms: 1500, idle_ms: 60_000, verify_limit: 6 });

// ---------------------------------------------------------------------------
// Tabelas, interruptores e o corte

/** As tabelas da versão 19 existem? (esquema antigo: mão dupla indisponível) */
export function twoWayTables(db: SqlDriver): boolean {
  try { db.exec("SELECT 1 AS x FROM wb_bling_twoway_setting LIMIT 1"); return true; } catch { return false; }
}
function cutoverOf(db: SqlDriver): { cutover_on: string; confirmed_at: number } | null {
  try {
    const r = one(db, "SELECT cutover_on, confirmed_at FROM wb_bling_cutover WHERE id=1");
    return r ? { cutover_on: String(r.cutover_on), confirmed_at: Number(r.confirmed_at) } : null;
  } catch { return null; }
}
interface Setting { entity: BlingTwoWayEntity; direction: BlingTwoWayDirection; enabled: boolean; since: number | null; watermark: Json; by: string }
function settings(db: SqlDriver): Setting[] {
  return db.exec("SELECT entity, direction, enabled, enabled_since, watermark, updated_by FROM wb_bling_twoway_setting").rows.map(r => ({
    entity: r.entity as BlingTwoWayEntity, direction: r.direction as BlingTwoWayDirection, enabled: Number(r.enabled) === 1,
    since: r.enabled_since == null ? null : Number(r.enabled_since), watermark: parse(r.watermark), by: String(r.updated_by) }));
}
const settingOf = (list: Setting[], entity: BlingTwoWayEntity, direction: BlingTwoWayDirection) => list.find(s => s.entity === entity && s.direction === direction && s.enabled) ?? null;
function saveWatermark(db: SqlDriver, entity: BlingTwoWayEntity, direction: BlingTwoWayDirection, watermark: Json) {
  db.exec("UPDATE wb_bling_twoway_setting SET watermark=? WHERE entity=? AND direction=?", JSON.stringify(watermark), entity, direction);
}
/** A entidade tem as partes do ERP ligadas? */
export function twoWayPartsOn(entity: BlingTwoWayEntity, parts: Readonly<ErpParts> | null | undefined): boolean {
  return !!parts?.customers && BLING_TWO_WAY_PARTS[entity].every(key => !!parts[key]);
}
export function twoWayPartOffMessage(entity: BlingTwoWayEntity, parts: Readonly<ErpParts> | null | undefined): string | null {
  if (twoWayPartsOn(entity, parts)) return null;
  const off = [...(parts?.customers ? [] : ["customers" as const]), ...BLING_TWO_WAY_PARTS[entity].filter(key => !parts?.[key])];
  const names = [...new Set(off.map(key => ERP_PART_NAMES[ERP_PART_MODULES[key]]))];
  const spoken = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
  return `Para a mão dupla de ${BLING_TWO_WAY_LABELS[entity].toLowerCase()}, ligue ${names.length > 1 ? "os módulos" : "o módulo"} ${spoken} em Gestão → Módulos.`;
}
interface Main { pace_minutes: number; scan: Json; last_in: Json; last_out: Json }
function main(db: SqlDriver): Main {
  const r = one(db, "SELECT pace_minutes, scan, last_in, last_out FROM wb_bling_twoway WHERE id=1");
  return r ? { pace_minutes: Number(r.pace_minutes), scan: parse(r.scan), last_in: parse(r.last_in), last_out: parse(r.last_out) } : { pace_minutes: 15, scan: {}, last_in: {}, last_out: {} };
}
function saveMain(db: SqlDriver, patch: Partial<Main>, now: number, actor: string | null = null) {
  const m = { ...main(db), ...patch };
  db.exec(`INSERT INTO wb_bling_twoway(id,pace_minutes,scan,last_in,last_out,revision,updated_by,updated_at) VALUES(1,?,?,?,?,1,?,?)
    ON CONFLICT(id) DO UPDATE SET pace_minutes=excluded.pace_minutes, scan=excluded.scan, last_in=excluded.last_in, last_out=excluded.last_out, revision=revision+1,
      updated_by=coalesce(excluded.updated_by, updated_by), updated_at=excluded.updated_at`,
    m.pace_minutes, JSON.stringify(m.scan), JSON.stringify(m.last_in), JSON.stringify(m.last_out), actor, now);
}
function bump(db: SqlDriver, side: "last_in" | "last_out", counts: Record<string, number>, now: number) {
  if (!Object.values(counts).some(Boolean)) return;
  const m = main(db), current = (m[side].counts && typeof m[side].counts === "object" ? m[side].counts : {}) as Record<string, number>;
  for (const [key, value] of Object.entries(counts)) current[key] = (Number(current[key]) || 0) + value;
  saveMain(db, { [side]: { at: now, counts: current } }, now);
}
/** Ritmo da coleta contínua (minutos entre as passagens pelo que mudou). null: tabela ausente. */
export function twoWayPaceMs(db: SqlDriver): number | null {
  try { const r = one(db, "SELECT pace_minutes FROM wb_bling_twoway WHERE id=1"); return r ? Number(r.pace_minutes) * 60_000 : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Linha de base, pendências e fila

interface State { source_id: string | null; erp_hash: string | null; bling_version: number; bling_hash: string | null; echo_after: number | null }
function readState(db: SqlDriver, entity: BlingTwoWayEntity, record: string): State | null {
  const r = one(db, "SELECT source_id, erp_hash, bling_version, bling_hash, echo_after FROM wb_bling_twoway_state WHERE entity=? AND record_id=?", entity, record);
  return r ? { source_id: r.source_id == null ? null : String(r.source_id), erp_hash: r.erp_hash == null ? null : String(r.erp_hash), bling_version: Number(r.bling_version),
    bling_hash: r.bling_hash == null ? null : String(r.bling_hash), echo_after: r.echo_after == null ? null : Number(r.echo_after) } : null;
}
function writeState(db: SqlDriver, entity: BlingTwoWayEntity, record: string, patch: Partial<State>, now: number) {
  const s = { ...(readState(db, entity, record) ?? { source_id: null, erp_hash: null, bling_version: 0, bling_hash: null, echo_after: null }), ...patch };
  db.exec(`INSERT INTO wb_bling_twoway_state(entity,record_id,source_id,erp_hash,bling_version,bling_hash,echo_after,synced_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(entity,record_id) DO UPDATE SET source_id=excluded.source_id, erp_hash=excluded.erp_hash, bling_version=excluded.bling_version, bling_hash=excluded.bling_hash,
      echo_after=excluded.echo_after, synced_at=excluded.synced_at`, entity, record, s.source_id, s.erp_hash, s.bling_version, s.bling_hash, s.echo_after, now);
}
const stateBySource = (db: SqlDriver, entity: BlingTwoWayEntity, source: string) =>
  (one(db, "SELECT record_id FROM wb_bling_twoway_state WHERE entity=? AND source_id=?", entity, source)?.record_id as string | undefined) ?? null;
/** Registro do ERP ligado ao id do Bling (vínculo da adoção ou criado pela mão dupla). */
function recordOf(db: SqlDriver, entity: BlingAdoptionEntity, source: string | null): string | null {
  if (!source) return null;
  const link = linkOf(db, entity, source);
  if (link) return link.record_id;
  return entity === "contacts" || entity === "products" || isAdoptionB2(entity) ? stateBySource(db, entity as BlingTwoWayEntity, source) : null;
}
/** Saldos do Bling (acervo stock_balances, um registro por produto). */
const readStockRaw = (db: SqlDriver, source: string) => readRaw(db, "stock_balances" as BlingAdoptionEntity, source);
const snapHash = (snap: Snapshot | null) => !snap ? null : snap.gone ? twoWayHash({ gone: true }) : twoWayHash(snap.body);

interface IssueInput { kind: BlingTwoWayIssueKind; entity: BlingTwoWayEntity; record?: string | null; source?: string | null; outbox?: string | null; label: string; reason: string; erp?: Json | null; bling?: Json | null; data?: Json }
function openIssue(db: SqlDriver, key: string, input: IssueInput, now: number) {
  db.exec(`INSERT INTO wb_bling_twoway_issue(key,kind,entity,record_id,source_id,outbox_id,state,label,reason,erp,bling,data,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, record_id=excluded.record_id, source_id=excluded.source_id, outbox_id=excluded.outbox_id, state='open', label=excluded.label,
      reason=excluded.reason, erp=excluded.erp, bling=excluded.bling, data=excluded.data, resolution=NULL, resolved_by=NULL, resolved_at=NULL, updated_at=excluded.updated_at`,
    key, input.kind, input.entity, input.record ?? null, input.source ?? null, input.outbox ?? null, clip(input.label, 200), clip(input.reason, 600),
    input.erp ? JSON.stringify(input.erp) : null, input.bling ? JSON.stringify(input.bling) : null, JSON.stringify(input.data ?? {}), now, now);
}
function closeIssue(db: SqlDriver, key: string, resolution: string, actor: string | null, now: number) {
  db.exec("UPDATE wb_bling_twoway_issue SET state='resolved', resolution=?, resolved_by=?, resolved_at=?, updated_at=? WHERE key=? AND state='open'", resolution, actor, now, now, key);
}
const issueOpen = (db: SqlDriver, key: string) => !!one(db, "SELECT 1 AS x FROM wb_bling_twoway_issue WHERE key=? AND state='open'", key);

interface Outbox { id: string; entity: BlingTwoWayEntity; record_id: string; op: BlingTwoWayOp; state: BlingTwoWayState; request: Json; verify: Json; erp_hash: string | null; label: string; attempts: number; checks: number; not_before: number; remote_id: string | null }
const outboxOf = (r: Row): Outbox => ({ id: String(r.id), entity: r.entity as BlingTwoWayEntity, record_id: String(r.record_id), op: r.op as BlingTwoWayOp, state: r.state as BlingTwoWayState,
  request: parse(r.request), verify: parse(r.verify), erp_hash: r.erp_hash == null ? null : String(r.erp_hash), label: String(r.label), attempts: Number(r.attempts), checks: Number(r.checks),
  not_before: Number(r.not_before), remote_id: r.remote_id == null ? null : String(r.remote_id) });
const openOutbox = (db: SqlDriver, entity: BlingTwoWayEntity, record: string, states = ["pending", "held", "sending", "uncertain"]) =>
  db.exec(`SELECT * FROM wb_bling_twoway_outbox WHERE entity=? AND record_id=? AND op<>'settle' AND state IN (SELECT value FROM json_each(?))`, entity, record, JSON.stringify(states)).rows.map(outboxOf);
function setOutbox(db: SqlDriver, id: string, patch: Record<string, unknown>, now: number) {
  const keys = Object.keys(patch);
  const finished = patch.state === "done" || patch.state === "superseded";
  db.exec(`UPDATE wb_bling_twoway_outbox SET ${keys.map(k => `${k}=?`).join(", ")}, updated_at=?, finished_at=${finished ? "?" : "NULL"} WHERE id=?`,
    ...keys.map(k => patch[k]), now, ...(finished ? [now] : []), id);
}
function enqueue(db: SqlDriver, item: { id: string; entity: BlingTwoWayEntity; record: string; op: BlingTwoWayOp; request: Json; verify: Json; erp_hash: string | null; label: string }, now: number): boolean {
  if (item.op !== "settle")
    for (const old of openOutbox(db, item.entity, item.record, ["pending", "held"])) if (old.id !== item.id) setOutbox(db, old.id, { state: "superseded" }, now);
  const before = Number(one(db, "SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE id=?", item.id)?.n ?? 0);
  if (before) return false;
  db.exec(`INSERT INTO wb_bling_twoway_outbox(id,entity,record_id,op,priority,state,request,verify,erp_hash,label,not_before,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
    item.id, item.entity, item.record, item.op, item.op === "settle" ? 5 : BLING_TWO_WAY_PRIORITY[item.entity], JSON.stringify(item.request), JSON.stringify(item.verify),
    item.erp_hash, clip(item.label, 200) || BLING_TWO_WAY_SINGULAR[item.entity], now, now, now);
  return true;
}

// ---------------------------------------------------------------------------
// Entrada: do Bling para o ERP

/** Aplica no ERP a versão nova do Bling num registro ligado (mesmas funções da adoção). */
function applyInbound(ctx: RpcContext, entity: Exclude<BlingTwoWayEntity, "stock_balances">, raw: AdoptionRaw, record: string, actor: string, now: number, salt: string) {
  if (isAdoptionB2(entity)) applyB2Update(ctx, entity as BlingAdoptionB2Entity, raw, record, actor, salt);
  else {
    if (raw.deleted) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "O registro foi excluído no Bling. Exclua também no ERP, se quiser.");
    applyBlingUpdate(ctx, entity as BlingAdoptionRecordEntity, raw, record, actor, now, salt);
  }
}
function linkVersion(db: SqlDriver, entity: BlingAdoptionEntity, source: string, raw: AdoptionRaw) {
  db.exec(`UPDATE ${adoptionTables(entity).link} SET source_version=?, source_hash=? WHERE entity=? AND source_id=? AND source_version<?`, raw.version, raw.hash, entity, source, raw.version);
}
function erpSide(db: SqlDriver, entity: BlingTwoWayEntity, record: string, snap: Snapshot | null): Json | null {
  if (snap && !snap.gone) return snap.summary;
  return entity === "stock_balances" ? null : erpSummary(db, entity, record);
}
function conflict(db: SqlDriver, entity: BlingTwoWayEntity, record: string, source: string, snap: Snapshot | null, bling: Json | null, raw: { version: number; hash: string } | null, now: number) {
  for (const item of openOutbox(db, entity, record, ["pending"])) setOutbox(db, item.id, { state: "held" }, now);
  openIssue(db, `conflict:${entity}:${record}`, { kind: "conflict", entity, record, source, label: snap?.label ?? `${BLING_TWO_WAY_SINGULAR[entity]} (id ${source} no Bling)`,
    reason: "Este registro mudou no ERP e no Bling desde a última sincronização. Nada foi sobrescrito: escolha qual versão vale.",
    erp: erpSide(db, entity, record, snap), bling, data: raw ? { bling_version: raw.version, bling_hash: raw.hash } : {} }, now);
}

type InOutcome = "applied" | "adopted" | "pending" | "conflict" | "skipped" | "echo";
function inboundOne(ctx: RpcContext, entity: Exclude<BlingTwoWayEntity, "stock_balances">, source: string, actor: string, now: number): InOutcome {
  const db = ctx.db, raw = readRaw(db, entity, source);
  if (!raw) return "skipped";
  let record = linkOf(db, entity, source)?.record_id ?? null;
  if (!record) {
    // Criado no Bling pela própria mão dupla: liga, não adota de novo.
    const mine = stateBySource(db, entity, source);
    if (mine) {
      writeLink(db, entity, raw, mine, "linked", actor, now);
      writeState(db, entity, mine, { bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
      return "echo";
    }
    if (raw.deleted) return "skipped";
    const outcome = adoptCollected(ctx, entity, raw, actor, now);
    record = linkOf(db, entity, source)?.record_id ?? null;
    if (record) writeState(db, entity, record, { erp_hash: snapHash(erpSnapshot(db, entity, record)), bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
    return outcome === "adopted" || outcome === "linked" ? "adopted" : outcome === "pending" ? "pending" : "skipped";
  }
  const link = linkOf(db, entity, source)!;
  const snap = erpSnapshot(db, entity, record), hash = snapHash(snap);
  let state = readState(db, entity, record);
  // Primeira vez: o ERP de agora vale como ponto de partida, contra a versão adotada.
  if (!state) { writeState(db, entity, record, { erp_hash: hash, bling_version: link.source_version, bling_hash: null, echo_after: null }, now); state = readState(db, entity, record)!; }
  if (raw.version <= state.bling_version || raw.hash === state.bling_hash) {
    if (raw.version > state.bling_version) { writeState(db, entity, record, { bling_version: raw.version, bling_hash: raw.hash }, now); linkVersion(db, entity, source, raw); }
    return "skipped";
  }
  // Eco do que a mão dupla acabou de gravar no Bling.
  if (state.echo_after !== null) {
    writeState(db, entity, record, { bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
    linkVersion(db, entity, source, raw);
    return "echo";
  }
  if ((hash !== null && hash !== state.erp_hash) || openOutbox(db, entity, record).length) {
    conflict(db, entity, record, source, snap, blingSummary(db, entity, source), raw, now);
    return "conflict";
  }
  applyInbound(ctx, entity, raw, record, actor, now, `in:${raw.version}`);
  linkVersion(db, entity, source, raw);
  writeState(db, entity, record, { erp_hash: snapHash(erpSnapshot(db, entity, record)), bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
  closeIssue(db, `in:${entity}:${source}`, "applied", null, now);
  return "applied";
}

/** Saldos: cada depósito ligado recebe o saldo físico do Bling (ajuste pelo erp_stock_post). */
function inboundStock(ctx: RpcContext, source: string, actor: string, now: number): InOutcome {
  const db = ctx.db, raw = readStockRaw(db, source);
  if (!raw) return "skipped";
  const product = recordOf(db, "products", text(at(raw.payload, "produto", "id")) ?? source);
  if (!product) return "skipped";
  const deposits = Array.isArray(raw.payload.depositos) ? raw.payload.depositos : [];
  const items: Json[] = [], baselines: [string, string][] = [];
  let outcome: InOutcome = "skipped";
  for (const deposit of deposits) {
    const warehouse = recordOf(db, "warehouses", sourceOf(deposit));
    const value = text(at(deposit, "saldoFisico"));
    if (!warehouse || value === null || !/^-?\d{1,12}(\.\d{1,6})?$/.test(value)) continue;
    const pair = `${product}:${warehouse}`, bling = twoWayHash({ q: Number(value) });
    const balance = one(db, "SELECT quantity, version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse);
    const erp = decimalText("erp_stock__balance", "quantity", balance?.quantity ?? 0) ?? "0", erpHash = snapHash(erpSnapshot(db, "stock_balances", pair));
    const state = readState(db, "stock_balances", pair);
    if (state && state.bling_hash === bling) continue;
    if (state?.echo_after != null) { writeState(db, "stock_balances", pair, { bling_version: raw.version, bling_hash: bling, echo_after: null }, now); outcome = "echo"; continue; }
    if (state && (erpHash !== state.erp_hash || openOutbox(db, "stock_balances", pair).length)) {
      conflict(db, "stock_balances", pair, source, erpSnapshot(db, "stock_balances", pair), { "Saldo no Bling": value.replace(".", ",") }, raw, now);
      outcome = "conflict"; continue;
    }
    const delta = toScaled(value, 6) - toScaled(erp, 6);
    if (delta !== 0n) items.push({ product_id: product, warehouse_id: warehouse, quantity: formatScaled(delta, 6), expected_version: Number(balance?.version ?? 0) });
    baselines.push([pair, bling]);
  }
  if (items.length) {
    invokeRpc(ctx, "erp_stock_post", { p_user_id: actor, p_command_id: commandUuid("bling-twoway-stock", source, String(raw.version)), p_kind: "adjustment",
      p_occurred_on: todaySaoPaulo(now), p_reason: "Saldo igualado pelo Bling (mão dupla)", p_reference: clip(`Bling: produto ${source}`, 100), p_items: items });
    outcome = "applied";
  }
  for (const [pair, bling] of baselines)
    writeState(db, "stock_balances", pair, { erp_hash: snapHash(erpSnapshot(db, "stock_balances", pair)), bling_version: raw.version, bling_hash: bling, echo_after: null }, now);
  return outcome;
}

// ---------------------------------------------------------------------------
// Saída: do ERP para a fila

const LINK_EXISTS = (table: string) => `(EXISTS(SELECT 1 FROM ${table} l WHERE l.entity=? AND l.record_id=x.id) OR EXISTS(SELECT 1 FROM wb_bling_twoway_state s WHERE s.entity=? AND s.record_id=x.id AND s.source_id IS NOT NULL))`;
/** Registros candidatos (ligados ao Bling, ou criados no ERP depois do corte), por id. */
function candidates(db: SqlDriver, entity: BlingTwoWayEntity, after: string, sinceMicros: number, limit: number): string[] {
  if (entity === "stock_balances") {
    return db.exec(`SELECT x.id FROM (SELECT b.product_id || ':' || b.warehouse_id AS id, b.product_id, b.warehouse_id FROM erp_stock__balance b) x
      WHERE x.id>? AND (EXISTS(SELECT 1 FROM wb_bling_adoption_link l WHERE l.entity='products' AND l.record_id=x.product_id) OR EXISTS(SELECT 1 FROM wb_bling_twoway_state s WHERE s.entity='products' AND s.record_id=x.product_id AND s.source_id IS NOT NULL))
        AND EXISTS(SELECT 1 FROM wb_bling_adoption_link l WHERE l.entity='warehouses' AND l.record_id=x.warehouse_id) ORDER BY x.id LIMIT ?`, after, limit).rows.map(r => String(r.id));
  }
  const link = adoptionTables(entity).link;
  const source = entity === "contacts" || entity === "products" ? { from: "erp_catalog__record x", where: "x.entity=?", param: entity }
    : entity === "receivables" || entity === "payables" ? { from: "erp_finance__title x", where: "x.kind=?", param: entity === "receivables" ? "receivable" : "payable" }
    : { from: "erp_documents__document x", where: "x.kind=?", param: entity };
  // Produto novo só simples (variações e composições ficam de fora).
  const simple = entity === "products" ? " AND NOT EXISTS(SELECT 1 FROM erp_catalog__product p WHERE p.record_id=x.id AND coalesce(p.format,'S')<>'S')" : "";
  return db.exec(`SELECT x.id FROM ${source.from} WHERE ${source.where} AND x.id>? AND (${LINK_EXISTS(link)} OR (CAST(x.created_at AS INTEGER)>=?${simple}))
    ORDER BY x.id LIMIT ?`, source.param, after, entity, entity, sinceMicros, limit).rows.map(r => String(r.id));
}
/** O que precisa existir no Bling antes vai ser enviado pela própria mão dupla? */
function dependencyComing(db: SqlDriver, list: Setting[], needed: { entity: BlingAdoptionEntity; record_id: string }): boolean {
  if (needed.entity !== "contacts" && needed.entity !== "products") return false;
  if (!settingOf(list, needed.entity, "outbound")) return false;
  return true;
}
type OutOutcome = "queued" | "same" | "baseline" | "conflict" | "waiting" | "blocked";
function outboundOne(db: SqlDriver, entity: BlingTwoWayEntity, record: string, list: Setting[], now: number): OutOutcome {
  const snap = erpSnapshot(db, entity, record);
  if (!snap) return "same";
  const source = entity === "stock_balances" ? null : blingIdOf(db, entity, record);
  const state = readState(db, entity, record), hash = snapHash(snap)!;
  const known = entity === "stock_balances" ? !!state || !snap.gone : !!source;
  if (snap.gone) {
    if (source && state?.erp_hash !== hash) {
      openIssue(db, `gone:${entity}:${record}`, { kind: "blocked", entity, record, source, label: snap.label, reason: snap.reason }, now);
      writeState(db, entity, record, { erp_hash: hash }, now);
    }
    return "blocked";
  }
  if (!state && known) {
    // Ligado e ainda sem linha de base: o ERP de agora é o ponto de partida.
    const raw = source ? readRaw(db, entity as BlingAdoptionEntity, source) : null;
    const link = source ? linkOf(db, entity as BlingAdoptionEntity, source) : null;
    writeState(db, entity, record, { erp_hash: hash, bling_version: link?.source_version ?? raw?.version ?? 0, bling_hash: null, echo_after: null }, now);
    return "baseline";
  }
  if (state && state.erp_hash === hash) return "same";
  if (openOutbox(db, entity, record, ["sending", "uncertain"]).length) return "waiting";
  if (source && state && state.echo_after === null) {
    const raw = readRaw(db, entity as BlingAdoptionEntity, source);
    if (raw && raw.version > state.bling_version && raw.hash !== state.bling_hash) {
      conflict(db, entity, record, source, snap, blingSummary(db, entity as BlingAdoptionEntity, source), raw, now);
      return "conflict";
    }
  }
  if (issueOpen(db, `conflict:${entity}:${record}`)) return "conflict";
  if (snap.needs.length) {
    if (snap.needs.every(need => dependencyComing(db, list, need))) return "waiting";
    const missing = snap.needs.filter(need => !dependencyComing(db, list, need));
    openIssue(db, `needs:${entity}:${record}`, { kind: "blocked", entity, record, label: snap.label,
      reason: clip(`Para enviar ao Bling, falta existir lá: ${missing.map(m => m.label).join("; ")}. Ligue "Escrever no Bling" para ${missing.some(m => m.entity === "products") ? "Produtos" : "Contatos"}, ou adote o registro do Bling, e a fila segue sozinha.`, 600)! }, now);
    return "blocked";
  }
  closeIssue(db, `needs:${entity}:${record}`, "sent", null, now);
  const op: BlingTwoWayOp = entity === "stock_balances" ? "stock" : source ? "update" : "create";
  const request = entity === "stock_balances" ? { method: "POST", path: "/estoques", body: snap.body } : upsertRequest(db, entity, source, snap);
  const verify: Json = op === "create" ? { natural: snap.natural, sent: snap.body, path: BLING_TWO_WAY_PATHS[entity as Exclude<BlingTwoWayEntity, "stock_balances">] }
    : op === "update" ? { path: request.path, sent: snap.body }
    : { product: String(at(snap.body, "produto", "id")), deposit: String(at(snap.body, "deposito", "id")), quantity: Number(snap.body.quantidade) };
  enqueue(db, { id: `${op}.${entity}.${record}.${hash.slice(0, 16)}`, entity, record, op, request: request as unknown as Json, verify, erp_hash: hash, label: snap.label }, now);
  return "queued";
}
/** Baixas feitas no ERP depois de ligar a escrita, nas contas que existem no Bling. */
function settlementsScan(db: SqlDriver, entity: "receivables" | "payables", since: number, now: number): number {
  const rows = db.exec(`SELECT s.id FROM erp_finance__settlement s JOIN erp_finance__title t ON t.id=s.title_id WHERE t.kind=? AND CAST(s.created_at AS INTEGER)>=?
      AND coalesce(s.note,'')<>? AND NOT EXISTS(SELECT 1 FROM wb_bling_twoway_outbox o WHERE o.id='settle.' || s.id) AND NOT EXISTS(SELECT 1 FROM wb_bling_twoway_issue i WHERE i.key='settle:' || s.id)
    ORDER BY s.created_at, s.id LIMIT 25`, entity === "receivables" ? "receivable" : "payable", since * 1000, BLING_TWO_WAY_SETTLE_NOTE).rows;
  let queued = 0;
  for (const r of rows) {
    const id = String(r.id), result = settlementPlan(db, entity, id);
    if (!result || "waiting" in result) continue;
    if ("refused" in result) {
      const title = one(db, "SELECT t.id, t.description FROM erp_finance__settlement s JOIN erp_finance__title t ON t.id=s.title_id WHERE s.id=?", id);
      openIssue(db, `settle:${id}`, { kind: "blocked", entity, record: String(title?.id ?? id), label: clip(`Baixa em ${title?.description ?? "conta"}`, 200)!, reason: result.refused }, now);
      continue;
    }
    const p = result.plan;
    queued += enqueue(db, { id: `settle.${id}`, entity, record: String(one(db, "SELECT title_id FROM erp_finance__settlement WHERE id=?", id)?.title_id), op: "settle",
      request: p.request as unknown as Json, verify: { path: `${BLING_TWO_WAY_PATHS[entity]}/${p.title_source}`, before_cents: p.before_cents.toString(), expected_cents: p.expected_cents.toString() },
      erp_hash: null, label: p.label }, now) ? 1 : 0;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Unidade local do alarme: entrada e varredura (sem I/O)

export interface TwoWayEngineOptions { db: SqlDriver; profile: string; now(): number; parts: Readonly<ErpParts> }
/** Há trabalho local da mão dupla vencido? Consulta barata para o alarme. */
export function twoWayLocalDue(db: SqlDriver, now: number): boolean {
  try {
    if (!one(db, "SELECT 1 AS x FROM wb_bling_twoway_setting WHERE enabled=1 LIMIT 1") || !cutoverOf(db)) return false;
    const next = Number(main(db).scan.next_at ?? 0);
    return next <= now;
  } catch { return false; }
}
export function runTwoWayLocalUnit(options: TwoWayEngineOptions): { worked: boolean; more: boolean } {
  const { db, profile, now, parts } = options;
  if (!twoWayTables(db) || !cutoverOf(db) || !archiveAvailable(db)) return { worked: false, more: false };
  const list = settings(db).filter(s => s.enabled && twoWayPartsOn(s.entity, parts));
  if (!list.length) return { worked: false, more: false };
  const started = now();
  let handled = 0, more = false;
  const budget = () => handled < TWO_WAY_UNIT.records && now() - started < TWO_WAY_UNIT.wall_ms;
  const counts: Record<string, number> = { applied: 0, adopted: 0, conflicts: 0, failed: 0 };
  // Entrada: o que a coleta trouxe depois da marca d'água, na ordem das entidades.
  for (const entity of BLING_TWO_WAY_ENTITIES) {
    const s = settingOf(list, entity, "inbound");
    if (!s) continue;
    while (budget()) {
      const wm = settingOf(settings(db), entity, "inbound")?.watermark ?? s.watermark;
      const afterAt = Number(wm.at ?? s.since ?? 0), afterId = String(wm.id ?? "");
      const next = one(db, `SELECT source_id, changed_at FROM origin_sync__raw_record WHERE entity=? AND (changed_at>? OR (changed_at=? AND source_id>?)) ORDER BY changed_at, source_id LIMIT 1`,
        entity, afterAt, afterAt, afterId);
      if (!next) break;
      const source = String(next.source_id), at_ = now();
      try {
        transaction(db, profile, ctx => {
          const outcome = entity === "stock_balances" ? inboundStock(ctx, source, s.by, at_) : inboundOne(ctx, entity, source, s.by, at_);
          if (outcome === "applied") counts.applied++; else if (outcome === "adopted") counts.adopted++; else if (outcome === "conflict") counts.conflicts++;
          saveWatermark(db, entity, "inbound", { at: Number(next.changed_at), id: source });
        }, { identity: systemIdentity(s.by), parts });
      } catch (error) {
        const failure = error instanceof BlingAdoptionError ? { reason: "invalid_data" as const, detail: error.detail ?? error.message, stop: null } : domainFailure(error);
        db.transaction(() => {
          const record = entity === "stock_balances" ? null : linkOf(db, entity, source)?.record_id ?? null;
          openIssue(db, `in:${entity}:${source}`, { kind: "failed", entity, record, source, label: `${BLING_TWO_WAY_SINGULAR[entity]} (id ${source} no Bling)`,
            reason: clip(`O ERP não aceitou a mudança vinda do Bling. ${[failure.detail, BLING_ADOPTION_REASONS[failure.reason]].filter(Boolean)[0] ?? ""}`, 600)!,
            erp: record ? erpSide(db, entity, record, null) : null, bling: entity === "stock_balances" ? null : blingSummary(db, entity, source) }, at_);
          saveWatermark(db, entity, "inbound", { at: Number(next.changed_at), id: source });
        });
        counts.failed++;
      }
      handled++;
    }
    if (!budget()) { more = true; break; }
  }
  // Saída: varredura por cursor (entidade e id), registro a registro.
  const outbound = BLING_TWO_WAY_ENTITIES.filter(e => settingOf(list, e, "outbound"));
  const cutover = cutoverOf(db)!;
  let scan = main(db).scan;
  let queued = 0;
  if (outbound.length && budget()) {
    let entity = (outbound.includes(scan.entity as BlingTwoWayEntity) ? scan.entity : outbound[0]) as BlingTwoWayEntity;
    let after = outbound.includes(scan.entity as BlingTwoWayEntity) ? String(scan.after ?? "") : "";
    while (budget()) {
      const ids = candidates(db, entity, after, cutover.confirmed_at * 1000, Math.max(1, TWO_WAY_UNIT.records - handled));
      for (const id of ids) {
        if (!budget()) break;
        db.transaction(() => { if (outboundOne(db, entity, id, list, now()) === "queued") queued++; });
        after = id; handled++;
      }
      if (ids.length && budget()) continue;
      if (!budget()) break;
      if (entity === "receivables" || entity === "payables") queued += db.transaction(() => settlementsScan(db, entity as "receivables" | "payables", settingOf(list, entity, "outbound")!.since ?? now(), now()));
      const index = outbound.indexOf(entity);
      if (index === outbound.length - 1) { entity = outbound[0]; after = ""; scan = { ...scan, cycle_done_at: now() }; break; }
      entity = outbound[index + 1]; after = "";
    }
    scan = { ...scan, entity, after };
    if (budget() === false) more = true;
  }
  const finished = !more;
  db.transaction(() => {
    saveMain(db, { scan: { ...scan, next_at: finished ? now() + TWO_WAY_UNIT.idle_ms : now() + 1_000 } }, now());
    bump(db, "last_in", counts, now());
    if (queued) bump(db, "last_out", { queued }, now());
  });
  return { worked: handled > 0 || queued > 0, more };
}

// ---------------------------------------------------------------------------
// Saída: um item da fila por acordada (uma chamada HTTP)

/** Próximo horário de envio ou conferência. null: nada na fila. */
export function twoWayOutboxDue(db: SqlDriver): number | null {
  try {
    const r = one(db, `SELECT min(o.not_before) AS due FROM wb_bling_twoway_outbox o WHERE o.state IN ('sending','uncertain')
      OR (o.state='pending' AND EXISTS(SELECT 1 FROM wb_bling_twoway_setting s WHERE s.entity=o.entity AND s.direction='outbound' AND s.enabled=1))`);
    return r?.due == null ? null : Number(r.due);
  } catch { return null; }
}
/** Mesma reserva do coletor: credencial pronta, intervalo mínimo e teto diário. */
export function takeCall(db: SqlDriver, now: number): { ok: true } | { ok: false; retry_at: number; reason: string } {
  return db.transaction(() => {
    const c = one(db, "SELECT credential_status, next_allowed_at, calls_day, calls_today, daily_call_limit, min_interval_ms, state FROM wb_bling_control WHERE id=1");
    if (!c || c.state === "purging") return { ok: false as const, retry_at: now + 3_600_000, reason: "O acervo do Bling não está disponível." };
    if (!["ready", "expired"].includes(String(c.credential_status))) return { ok: false as const, retry_at: now + 900_000, reason: "A conta do Bling precisa ser autorizada de novo." };
    if (Number(c.next_allowed_at ?? 0) > now) return { ok: false as const, retry_at: Number(c.next_allowed_at), reason: "Aguardando o intervalo entre chamadas." };
    const day = new Date(now - 3 * 3_600_000).toISOString().slice(0, 10), used = c.calls_day === day ? Number(c.calls_today) : 0;
    if (used >= Number(c.daily_call_limit)) return { ok: false as const, retry_at: Date.parse(day + "T03:00:00Z") + 86_400_000, reason: "O limite de chamadas do dia acabou." };
    db.exec("UPDATE wb_bling_control SET calls_day=?, calls_today=?, next_allowed_at=?, updated_at=? WHERE id=1", day, used + 1, now + Math.max(700, Number(c.min_interval_ms)), now);
    return { ok: true as const };
  });
}
const UNCERTAIN_TEXT = "O Bling não respondeu a tempo. Antes de tentar de novo, o sistema confere no Bling se a mudança entrou.";
function done(db: SqlDriver, item: Outbox, remote: string | null, now: number) {
  db.transaction(() => {
    setOutbox(db, item.id, { state: "done", remote_id: remote ?? item.remote_id, error_code: null, error_text: null }, now);
    if (item.op === "create" && remote) writeState(db, item.entity, item.record_id, { source_id: remote, erp_hash: item.erp_hash, echo_after: now }, now);
    else if (item.op === "update" || item.op === "stock") writeState(db, item.entity, item.record_id, { erp_hash: item.erp_hash, echo_after: now }, now);
    else if (item.op === "settle" && readState(db, item.entity, item.record_id)) writeState(db, item.entity, item.record_id, { echo_after: now }, now);
    closeIssue(db, `out:${item.id}`, "done", null, now);
    bump(db, "last_out", { confirmed: 1 }, now);
  });
}
function refuse(db: SqlDriver, item: Outbox, reason: string, now: number, code = "refused") {
  db.transaction(() => {
    setOutbox(db, item.id, { state: "failed", error_code: code, error_text: clip(reason, 600) }, now);
    openIssue(db, `out:${item.id}`, { kind: "failed", entity: item.entity, record: item.record_id, outbox: item.id, label: item.label, reason,
      erp: item.entity === "stock_balances" ? null : erpSide(db, item.entity, item.record_id, erpSnapshot(db, item.entity, item.record_id)) }, now);
    bump(db, "last_out", { failed: 1 }, now);
  });
}
function askPerson(db: SqlDriver, item: Outbox, reason: string, now: number) {
  db.transaction(() => {
    setOutbox(db, item.id, { state: "uncertain", not_before: now + 86_400_000, error_code: "unconfirmed", error_text: clip(reason, 600), checks: item.checks + 1 }, now);
    openIssue(db, `out:${item.id}`, { kind: "uncertain", entity: item.entity, record: item.record_id, outbox: item.id, label: item.label, reason,
      erp: item.entity === "stock_balances" ? null : erpSide(db, item.entity, item.record_id, erpSnapshot(db, item.entity, item.record_id)), data: { op: item.op } }, now);
  });
}

export interface TwoWayOutboundOptions extends TwoWayEngineOptions { writer: BlingWritePort; ctx: BlingContext; deadline: number }
export async function runTwoWayOutboundUnit(options: TwoWayOutboundOptions): Promise<{ worked: boolean; nextWake: number | null; requests: 0 | 1 }> {
  const { db, now, parts, writer, ctx, deadline } = options;
  if (!twoWayTables(db) || !cutoverOf(db)) return { worked: false, nextWake: null, requests: 0 };
  const enabled = new Set(settings(db).filter(s => s.direction === "outbound" && s.enabled && twoWayPartsOn(s.entity, parts)).map(s => s.entity));
  const rows = db.exec(`SELECT * FROM wb_bling_twoway_outbox WHERE state IN ('sending','uncertain','pending') AND not_before<=?
    ORDER BY CASE state WHEN 'sending' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END, priority, created_at, id LIMIT 50`, now()).rows.map(outboxOf);
  // Desligado: nada pendente sai. Conferência (só GET) continua.
  const item = rows.find(r => r.state !== "pending" || enabled.has(r.entity));
  if (!item) return { worked: false, nextWake: twoWayOutboxDue(db), requests: 0 };
  // Queda no meio do envio: não se sabe se entrou. Vira conferência, sem reenviar.
  if (item.state === "sending") {
    db.transaction(() => setOutbox(db, item.id, { state: "uncertain", not_before: now(), error_code: "interrupted", error_text: "O envio foi interrompido antes da resposta do Bling. Conferindo se entrou antes de tentar de novo." }, now()));
    return { worked: true, nextWake: now() + 1_000, requests: 0 };
  }
  if (item.state === "pending" && item.op !== "settle") {
    const snap = erpSnapshot(db, item.entity, item.record_id);
    if (!snap || snap.gone || snapHash(snap) !== item.erp_hash) {
      db.transaction(() => setOutbox(db, item.id, { state: "superseded" }, now()));
      return { worked: true, nextWake: now() + 1_000, requests: 0 };
    }
  }
  if (item.state === "uncertain" && item.op === "create" && !item.verify.natural) {
    askPerson(db, item, "O Bling não respondeu a tempo e este registro não tem código, documento ou número para conferir lá. Veja no Bling se ele entrou: se entrou, informe o id; se não, mande de novo.", now());
    return { worked: true, nextWake: now() + 1_000, requests: 0 };
  }
  const call = takeCall(db, now());
  if (!call.ok) return { worked: false, nextWake: call.retry_at, requests: 0 };
  const budget = Math.min(deadline, now() + 3_000);
  if (item.state === "uncertain") { await verify(db, writer, ctx, item, budget, now); return { worked: true, nextWake: now() + 1_000, requests: 1 }; }
  db.transaction(() => setOutbox(db, item.id, { state: "sending", attempts: item.attempts + 1, sent_at: now(), error_code: null, error_text: null }, now()));
  const result = await writer.send(ctx, { method: item.request.method as "POST" | "PUT", path: String(item.request.path), body: item.request.body as Json, deadline: budget });
  const at_ = now();
  switch (result.kind) {
    case "ok": {
      const remote = item.op === "create" ? remoteId(result.data) : null;
      if (item.op === "create" && !remote) db.transaction(() => setOutbox(db, item.id, { state: "uncertain", not_before: at_, error_code: "no_id", error_text: "O Bling aceitou, mas não devolveu o id. Conferindo lá." }, at_));
      else done(db, item, remote, at_);
      break;
    }
    case "rejected": refuse(db, item, result.message, at_); break;
    case "rate":
      db.transaction(() => {
        setOutbox(db, item.id, { state: "pending", not_before: result.retry_at, error_code: "rate", error_text: "O Bling pediu para esperar (limite de chamadas). O envio segue sozinho." }, at_);
        db.exec("UPDATE wb_bling_control SET next_allowed_at=max(coalesce(next_allowed_at,0),?), updated_at=? WHERE id=1", result.retry_at, at_);
      });
      break;
    case "auth":
      if (result.status === 403) refuse(db, item, result.message, at_, "scope");
      else db.transaction(() => setOutbox(db, item.id, { state: "pending", not_before: at_ + 900_000, error_code: "auth", error_text: result.message }, at_));
      break;
    case "not_sent": db.transaction(() => setOutbox(db, item.id, { state: "pending", attempts: item.attempts, not_before: result.retry_at, error_code: "not_sent", error_text: result.message }, at_)); break;
    case "uncertain":
      db.transaction(() => { setOutbox(db, item.id, { state: "uncertain", not_before: at_ + 60_000, error_code: result.reason, error_text: UNCERTAIN_TEXT }, at_); bump(db, "last_out", { uncertain: 1 }, at_); });
      break;
  }
  return { worked: true, nextWake: now() + 1_000, requests: 1 };
}

/** Conferência por GET depois de resposta incerta: entrou, não entrou ou não dá para saber. */
async function verify(db: SqlDriver, writer: BlingWritePort, ctx: BlingContext, item: Outbox, deadline: number, now: () => number): Promise<void> {
  const v = item.verify;
  const read = item.op === "create" ? await writer.read(ctx, { path: String(v.path), query: (v.natural as Json).query as Record<string, string>, deadline })
    : item.op === "stock" ? await writer.read(ctx, { path: "/estoques/saldos", query: { "idsProdutos[]": [String(v.product)] }, deadline })
    : await writer.read(ctx, { path: String(v.path), deadline });
  const at_ = now();
  const again = (text_: string) => db.transaction(() => setOutbox(db, item.id, { state: "pending", not_before: at_, checks: item.checks + 1, error_code: "absent", error_text: text_ }, at_));
  if (read.kind !== "ok") {
    if (read.kind === "missing") { refuse(db, item, "O registro não existe mais no Bling (foi excluído lá?). Confira e decida se cria de novo.", at_, "missing"); return; }
    if (item.checks + 1 >= TWO_WAY_UNIT.verify_limit) { askPerson(db, item, `${UNCERTAIN_TEXT} A conferência não teve resposta depois de várias tentativas. Veja no Bling e diga se entrou.`, at_); return; }
    const wait = read.kind === "rate" || read.kind === "retry" ? read.retry_at : at_ + 900_000;
    db.transaction(() => setOutbox(db, item.id, { checks: item.checks + 1, not_before: Math.max(wait, at_ + 30_000), error_text: read.kind === "auth" ? read.message : UNCERTAIN_TEXT }, at_));
    return;
  }
  const data = dataOf(read.data);
  if (item.op === "update") { if (remoteHas(data, v.sent as Json)) done(db, item, null, at_); else again("Conferido no Bling: a mudança não entrou. Vai ser enviada de novo."); return; }
  if (item.op === "stock") {
    const saldo = stockOf(read.data, String(v.product), String(v.deposit));
    if (saldo !== null && saldo === Number(v.quantity)) done(db, item, null, at_); else again("Conferido no Bling: o saldo ainda não é o do ERP. Vai ser igualado de novo.");
    return;
  }
  if (item.op === "settle") {
    const saldo = centsOfRemote((data as Json | null)?.saldo);
    if (saldo !== null && saldo.toString() === String(v.expected_cents)) done(db, item, null, at_);
    else if (saldo !== null && saldo.toString() === String(v.before_cents)) again("Conferido no Bling: a baixa não entrou. Vai ser enviada de novo.");
    else askPerson(db, item, "O saldo da conta no Bling não bate nem com a baixa feita nem sem ela (pode ter havido outra baixa lá). Veja no Bling e diga se esta baixa entrou.", at_);
    return;
  }
  const matches = naturalMatches(read.data, (v.natural as Json).match as Json);
  if (matches.length === 1) done(db, item, text(matches[0].id), at_);
  else if (!matches.length) again("Conferido no Bling: o registro não foi criado. Vai ser enviado de novo.");
  else askPerson(db, item, "Achamos mais de um registro parecido no Bling. Veja qual é o certo e informe o id dele, ou mande de novo.", at_);
}

// ---------------------------------------------------------------------------
// Operações (tela e bots; ligar e o ritmo só do administrador)

function requireTables(db: SqlDriver) {
  if (!twoWayTables(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE", "Esta área ainda não tem a versão do ERP com a mão dupla. Atualize o ERP e tente de novo.");
}
const auditLabel = (direction: BlingTwoWayDirection) => direction === "inbound" ? "Receber do Bling" : "Escrever no Bling";

export function twoWayStatus(call: Pick<AdoptionCall, "db" | "parts"> & { profile?: string }): BlingTwoWayStatus {
  const db = call.db;
  requireTables(db);
  const cut = cutoverOf(db), available = archiveAvailable(db), list = settings(db), m = main(db);
  const count = (sql: string, ...params: unknown[]) => Number(one(db, sql, ...params)?.n ?? 0);
  const queue = Object.fromEntries(Object.keys(BLING_TWO_WAY_STATES).map(state => [state, count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state=?", state)])) as Record<BlingTwoWayState, number>;
  const side = (s: Setting | undefined) => ({ enabled: !!s?.enabled, since: s?.enabled ? iso(s.since) : null });
  return {
    available, unavailable_message: available ? null : "O acervo do Bling ainda não tem conta vinculada ou está sendo apagado.",
    cutover: { confirmed: !!cut, cutover_on: cut?.cutover_on ?? null }, pace_minutes: m.pace_minutes,
    entities: BLING_TWO_WAY_ENTITIES.map(entity => ({
      entity, label: BLING_TWO_WAY_LABELS[entity], module_name: ERP_PART_NAMES[ERP_PART_MODULES[BLING_TWO_WAY_PARTS[entity][0]]],
      enabled: twoWayPartsOn(entity, call.parts), part_off_message: twoWayPartOffMessage(entity, call.parts),
      inbound: side(list.find(s => s.entity === entity && s.direction === "inbound")), outbound: side(list.find(s => s.entity === entity && s.direction === "outbound")),
      queued: count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE entity=? AND state IN ('pending','sending','held')", entity),
      uncertain: count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE entity=? AND state='uncertain'", entity),
      failed: count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE entity=? AND state='failed'", entity),
      issues: count("SELECT count(*) AS n FROM wb_bling_twoway_issue WHERE entity=? AND state='open'", entity),
    })),
    last_in: { at: iso(m.last_in.at), counts: (m.last_in.counts ?? {}) as Record<string, number> },
    last_out: { at: iso(m.last_out.at), counts: (m.last_out.counts ?? {}) as Record<string, number> },
    queue, issues: { open: count("SELECT count(*) AS n FROM wb_bling_twoway_issue WHERE state='open'"), conflicts: count("SELECT count(*) AS n FROM wb_bling_twoway_issue WHERE state='open' AND kind='conflict'") },
    audit: db.exec(`SELECT a.created_at, a.actor_id, a.entity, a.direction, a.enabled, a.detail, p.name FROM wb_bling_twoway_audit a LEFT JOIN erp_access__profile p ON p.user_id=a.actor_id ORDER BY a.created_at DESC, a.id DESC LIMIT 20`).rows
      .map(r => ({ at: iso(r.created_at)!, by: clip(String(r.name ?? r.actor_id), 200)!, entity: (r.entity ?? null) as BlingTwoWayEntity | null, direction: (r.direction ?? null) as BlingTwoWayDirection | null,
        enabled: r.enabled == null ? null : Number(r.enabled) === 1, detail: String(r.detail) })),
    texts: { ...BLING_TWO_WAY_TEXTS },
    // Volta ao Bling (versão 32): nota, situação e rastreio, e o webhook.
    ...(() => { const returns = returnsStatus(db, call.profile ?? "", call.parts); return returns ? { returns } : {}; })(),
  };
}
const cursorOf = (value?: string) => { if (!value) return null; const i = value.indexOf("."); return { at: Number(value.slice(0, i)), id: value.slice(i + 1) }; };
export function twoWayQueue(call: Pick<AdoptionCall, "db">, input: Map_<"erp_bling_twoway_queue">["input"]): Map_<"erp_bling_twoway_queue">["output"] {
  requireTables(call.db);
  const limit = input.limit ?? 20, c = cursorOf(input.cursor), scope = input.state ?? "open";
  const states = scope === "open" ? ["pending", "sending", "uncertain", "held", "failed"] : scope === "done" ? ["done", "superseded"] : Object.keys(BLING_TWO_WAY_STATES);
  const rows = call.db.exec(`SELECT * FROM wb_bling_twoway_outbox WHERE state IN (SELECT value FROM json_each(?)) AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?))
    ORDER BY updated_at DESC, id DESC LIMIT ?`, JSON.stringify(states), c?.at ?? null, c?.at ?? null, c?.at ?? null, c?.id ?? null, limit + 1).rows
    // Volta ao Bling (versão 32): a nota, a situação e o rastreio entram na mesma fila, como pedidos de venda.
    .concat(returnsQueueRows(call.db, states.filter(s => s !== "held"), c, limit + 1).map(r => ({ ...r, entity: "sales_orders", op: r.kind, remote_id: null })))
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at) || (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0));
  const items: BlingTwoWayQueueItem[] = rows.slice(0, limit).map(r => ({
    id: String(r.id), entity: r.entity as BlingTwoWayEntity, label: String(r.label), op: r.op as BlingTwoWayOp, op_text: BLING_TWO_WAY_OPS[r.op as BlingTwoWayOp],
    state: r.state as BlingTwoWayState, state_text: BLING_TWO_WAY_STATES[r.state as BlingTwoWayState], attempts: Number(r.attempts), checks: Number(r.checks),
    not_before: iso(r.not_before), sent_at: iso(r.sent_at), updated_at: iso(r.updated_at), remote_id: r.remote_id == null ? null : String(r.remote_id), error_text: r.error_text == null ? null : String(r.error_text),
  }));
  const last = rows[limit - 1];
  return { items, next_cursor: rows.length > limit && last ? `${Number(last.updated_at)}.${last.id}` : null };
}
function actionsOf(kind: BlingTwoWayIssueKind, key: string, data: Json, entity: BlingTwoWayEntity): BlingTwoWayAction[] {
  if (kind === "conflict") return ["use_bling", "use_erp"];
  if (kind === "uncertain") return ["confirm_sent", "resend"];
  if (kind === "failed") return key.startsWith("in:") ? ["retry", "discard"] : ["retry", "discard"];
  void data; void entity;
  return key.startsWith("needs:") ? ["retry", "discard"] : ["discard"];
}
export function twoWayIssues(call: Pick<AdoptionCall, "db">, input: Map_<"erp_bling_twoway_issues">["input"]): Map_<"erp_bling_twoway_issues">["output"] {
  requireTables(call.db);
  const db = call.db, limit = input.limit ?? 20, c = cursorOf(input.cursor), state = input.state ?? "open";
  const rows = db.exec(`SELECT * FROM wb_bling_twoway_issue WHERE state=? AND (? IS NULL OR created_at<? OR (created_at=? AND key<?)) ORDER BY created_at DESC, key DESC LIMIT ?`,
    state, c?.at ?? null, c?.at ?? null, c?.at ?? null, c?.id ?? null, limit + 1).rows;
  const items: BlingTwoWayIssue[] = rows.slice(0, limit).map(r => {
    const kind = r.kind as BlingTwoWayIssueKind, key = String(r.key), data = parse(r.data);
    return { key, kind, kind_text: BLING_TWO_WAY_ISSUE_KINDS[kind], entity: r.entity as BlingTwoWayEntity, label: String(r.label), reason: String(r.reason), state: r.state as "open" | "resolved",
      erp: r.erp == null ? null : parse(r.erp) as Record<string, string | null>, bling: r.bling == null ? null : parse(r.bling) as Record<string, string | null>,
      actions: state === "open" ? actionsOf(kind, key, data, r.entity as BlingTwoWayEntity).map(action => ({ action, label: BLING_TWO_WAY_ACTIONS[action] })) : [],
      created_at: iso(r.created_at), resolution: r.resolution == null ? null : BLING_TWO_WAY_ACTIONS[r.resolution as BlingTwoWayAction] ?? String(r.resolution) };
  });
  const last = rows[limit - 1];
  return { items, next_cursor: rows.length > limit && last ? `${Number(last.created_at)}.${last.key}` : null,
    total: Number(one(db, "SELECT count(*) AS n FROM wb_bling_twoway_issue WHERE state=?", state)?.n ?? 0) };
}

export function twoWayResolve(call: AdoptionCall, input: Map_<"erp_bling_twoway_resolve">["input"]) {
  return command(call, "erp_bling_twoway_resolve", input.command_id, ctx => {
    const db = ctx.db, actor = call.identity.actor!.user_id, now = call.now();
    requireTables(db);
    const r = one(db, "SELECT * FROM wb_bling_twoway_issue WHERE key=? AND state='open'", input.key);
    if (!r) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Esta pendência já foi decidida ou não existe mais. Atualize a tela.");
    // Volta ao Bling (nota, situação e rastreio): fila própria, mesmas ações.
    if (String(r.key).startsWith("ret:")) return resolveReturnIssue(db, r, input.action, actor, now);
    const kind = r.kind as BlingTwoWayIssueKind, entity = r.entity as BlingTwoWayEntity, record = r.record_id == null ? null : String(r.record_id);
    const source = r.source_id == null ? null : String(r.source_id), key = String(r.key);
    if (!twoWayPartsOn(entity, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", twoWayPartOffMessage(entity, call.parts)!);
    const allowed = actionsOf(kind, key, parse(r.data), entity);
    if (!allowed.includes(input.action)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", `Para esta pendência, escolha: ${allowed.map(a => BLING_TWO_WAY_ACTIONS[a]).join(" ou ")}.`);
    const finish = (outcome: "applied" | "queued" | "kept" | "confirmed" | "retrying" | "discarded", message: string) => { closeIssue(db, key, input.action, actor, now); return { outcome, message }; };
    const outbox = r.outbox_id == null ? null : one(db, "SELECT * FROM wb_bling_twoway_outbox WHERE id=?", r.outbox_id);
    const item = outbox ? outboxOf(outbox) : null;
    if (kind === "conflict") {
      if (!record || !source) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
      const held = openOutbox(db, entity, record, ["pending", "held"]);
      if (input.action === "use_bling") {
        if (entity === "stock_balances") {
          const [product, warehouse] = record.split(":");
          const raw = readStockRaw(db, source);
          const dep = (Array.isArray(raw?.payload.depositos) ? raw!.payload.depositos : []).find(d => recordOf(db, "warehouses", sourceOf(d)) === warehouse);
          const value = text(at(dep, "saldoFisico"));
          if (!raw || value === null) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "O saldo do Bling não está mais no acervo. Peça uma nova coleta.");
          const balance = one(db, "SELECT quantity, version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse);
          const delta = toScaled(value, 6) - toScaled(decimalText("erp_stock__balance", "quantity", balance?.quantity ?? 0) ?? "0", 6);
          if (delta !== 0n) invokeRpc(ctx, "erp_stock_post", { p_user_id: actor, p_command_id: commandUuid("bling-twoway-stock-resolve", input.command_id), p_kind: "adjustment", p_occurred_on: todaySaoPaulo(now),
            p_reason: "Saldo igualado pelo Bling (conflito decidido)", p_reference: clip(`Bling: produto ${source}`, 100), p_items: [{ product_id: product, warehouse_id: warehouse, quantity: formatScaled(delta, 6), expected_version: Number(balance?.version ?? 0) }] });
          writeState(db, entity, record, { erp_hash: snapHash(erpSnapshot(db, entity, record)), bling_version: raw.version, bling_hash: twoWayHash({ q: Number(value) }), echo_after: null }, now);
        } else {
          const raw = readRaw(db, entity, source);
          if (!raw) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "A versão do Bling não está mais no acervo. Peça uma nova coleta.");
          if (!isAdoptionB2(entity) && !BLING_ADOPTION_UPDATABLE.has(entity)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID");
          try { applyInbound(ctx, entity, raw, record, actor, now, `resolve:${input.command_id}`); }
          catch (error) {
            if (error instanceof BlingAdoptionError) throw error;
            const failure = domainFailure(error);
            if (failure.stop === "permission") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
            throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", [BLING_ADOPTION_REASONS[failure.reason], failure.detail].filter(Boolean).join(" "));
          }
          linkVersion(db, entity, source, raw);
          writeState(db, entity, record, { erp_hash: snapHash(erpSnapshot(db, entity, record)), bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
        }
        for (const old of held) setOutbox(db, old.id, { state: "superseded" }, now);
        return finish("applied", "Usada a versão do Bling: o ERP foi atualizado e nada vai ser enviado ao Bling.");
      }
      // Usar a do ERP: o Bling visto passa a ser a base; o ERP volta ao Bling se a escrita estiver ligada.
      const data = parse(r.data);
      writeState(db, entity, record, { bling_version: Number(data.bling_version ?? readState(db, entity, record)?.bling_version ?? 0), bling_hash: data.bling_hash ? String(data.bling_hash) : null, echo_after: null }, now);
      if (entity !== "stock_balances") { const raw = readRaw(db, entity, source); if (raw) linkVersion(db, entity, source, raw); }
      const writing = settingOf(settings(db), entity, "outbound");
      if (!writing) {
        writeState(db, entity, record, { erp_hash: snapHash(erpSnapshot(db, entity, record)) }, now);
        for (const old of held) setOutbox(db, old.id, { state: "superseded" }, now);
        return finish("kept", "O ERP ficou como está. O Bling continua com a versão dele: ligue \"Escrever no Bling\" para este tipo de registro ou ajuste lá.");
      }
      if (held.length) { for (const old of held) setOutbox(db, old.id, { state: "pending", not_before: now }, now); }
      else db.exec("UPDATE wb_bling_twoway_state SET erp_hash=NULL WHERE entity=? AND record_id=?", entity, record);
      closeIssue(db, key, input.action, actor, now);
      if (!held.length) outboundOne(db, entity, record, settings(db), now);
      return { outcome: "queued" as const, message: "Usada a versão do ERP: ela foi para a fila de saída e vai ser gravada no Bling." };
    }
    if (kind === "uncertain") {
      if (!item) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
      if (input.action === "confirm_sent") {
        if (item.op === "create" && !input.remote_id) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Informe o id do registro no Bling (aparece no endereço da página do registro lá).");
        done(db, item, input.remote_id ?? null, now);
        return finish("confirmed", "Marcado como gravado no Bling. Nada vai ser reenviado.");
      }
      setOutbox(db, item.id, { state: "pending", not_before: now, error_code: null, error_text: "Uma pessoa conferiu que não entrou: vai ser enviado de novo." }, now);
      return finish("retrying", "Vai ser enviado de novo ao Bling.");
    }
    if (kind === "failed" && key.startsWith("in:")) {
      if (!source || entity === "stock_balances") throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
      const raw = readRaw(db, entity, source), link = linkOf(db, entity, source);
      if (input.action === "discard") {
        if (raw && link) { linkVersion(db, entity, source, raw); writeState(db, entity, link.record_id, { bling_version: raw.version, bling_hash: raw.hash, erp_hash: snapHash(erpSnapshot(db, entity, link.record_id)) }, now); }
        return finish("discarded", "O ERP ficou como está; esta mudança do Bling não vai ser aplicada.");
      }
      if (!raw || !link) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "O registro não está mais ligado ou não está no acervo. Atualize a tela.");
      try { applyInbound(ctx, entity, raw, link.record_id, actor, now, `retry:${input.command_id}`); }
      catch (error) {
        if (error instanceof BlingAdoptionError) throw error;
        const failure = domainFailure(error);
        throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", [BLING_ADOPTION_REASONS[failure.reason], failure.detail].filter(Boolean).join(" "));
      }
      linkVersion(db, entity, source, raw);
      writeState(db, entity, link.record_id, { erp_hash: snapHash(erpSnapshot(db, entity, link.record_id)), bling_version: raw.version, bling_hash: raw.hash, echo_after: null }, now);
      return finish("applied", "A mudança do Bling foi aplicada no ERP.");
    }
    if (kind === "failed") {
      if (!item) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
      if (input.action === "retry") { setOutbox(db, item.id, { state: "pending", not_before: now, error_code: null, error_text: null }, now); return finish("retrying", "Vai ser enviado de novo ao Bling."); }
      setOutbox(db, item.id, { state: "superseded" }, now);
      if (item.op !== "settle" && record) writeState(db, entity, record, { erp_hash: item.erp_hash }, now);
      return finish("discarded", "Ficou como está: este envio não vai ser repetido. O Bling continua diferente do ERP neste registro.");
    }
    // Falta algo para enviar (dependência, excluído, estorno): tentar de novo é varrer outra vez.
    if (input.action === "retry" && record) { closeIssue(db, key, input.action, actor, now); outboundOne(db, entity, record, settings(db), now); return { outcome: "retrying" as const, message: "Conferido de novo. Se ainda faltar algo, a pendência volta com o motivo." }; }
    return finish("discarded", "Ciente: nada vai ser enviado ao Bling por este motivo.");
  });
}

export function twoWaySwitch(call: AdoptionCall, input: Map_<"erp_bling_twoway_switch">["input"]) {
  return command(call, "erp_bling_twoway_switch", input.command_id, ctx => {
    const db = ctx.db, actor = call.identity.actor!.user_id, now = call.now();
    requireTables(db);
    const { entity, direction, enabled } = input;
    if (!(BLING_TWO_WAY_DIRECTIONS as readonly string[]).includes(direction)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID");
    if (enabled) {
      if (!twoWayPartsOn(entity, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", twoWayPartOffMessage(entity, call.parts)!);
      if (!cutoverOf(db)) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", BLING_TWO_WAY_TEXTS.no_cutover);
      if (!archiveAvailable(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
      if (input.acknowledged !== true) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Ligar pede que você confirme o aviso.");
    }
    const current = one(db, "SELECT enabled, enabled_since FROM wb_bling_twoway_setting WHERE entity=? AND direction=?", entity, direction);
    const wasOn = Number(current?.enabled ?? 0) === 1;
    const since = enabled ? wasOn ? Number(current!.enabled_since) : now : null;
    db.exec(`INSERT INTO wb_bling_twoway_setting(entity,direction,enabled,enabled_since,watermark,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(entity,direction) DO UPDATE SET enabled=excluded.enabled, enabled_since=excluded.enabled_since,
        watermark=CASE WHEN excluded.enabled=1 AND wb_bling_twoway_setting.enabled=0 THEN excluded.watermark ELSE wb_bling_twoway_setting.watermark END,
        updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      entity, direction, enabled ? 1 : 0, since, JSON.stringify({ at: now, id: "" }), actor, now);
    if (enabled !== wasOn) {
      db.exec("INSERT INTO wb_bling_twoway_audit(id,actor_id,action,entity,direction,enabled,detail,created_at) VALUES(?,?,'switch',?,?,?,?,?)",
        commandUuid("bling-twoway-audit", input.command_id), actor, entity, direction, enabled ? 1 : 0,
        `${enabled ? "Ligou" : "Desligou"} "${auditLabel(direction)}" para ${BLING_TWO_WAY_LABELS[entity].toLowerCase()}${enabled ? " (aviso confirmado)" : ""}.`, now);
      // Liga: a varredura começa agora.
      saveMain(db, { scan: { ...main(db).scan, next_at: now } }, now, actor);
    }
    return { entity, direction, enabled, since: iso(since) };
  });
}
export function twoWayPace(call: AdoptionCall, input: Map_<"erp_bling_twoway_pace">["input"]) {
  return command(call, "erp_bling_twoway_pace", input.command_id, ctx => {
    const db = ctx.db, actor = call.identity.actor!.user_id, now = call.now();
    requireTables(db);
    const before = main(db).pace_minutes;
    saveMain(db, { pace_minutes: input.minutes }, now, actor);
    if (before !== input.minutes)
      db.exec("INSERT INTO wb_bling_twoway_audit(id,actor_id,action,entity,direction,enabled,detail,created_at) VALUES(?,?,'pace',NULL,NULL,NULL,?,?)",
        commandUuid("bling-twoway-audit", input.command_id), actor, `Mudou o ritmo da coleta contínua de ${before} para ${input.minutes} minutos.`, now);
    return { minutes: input.minutes };
  });
}
