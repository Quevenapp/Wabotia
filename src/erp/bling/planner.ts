/** Planejamento puro: nenhuma posse, transporte ou aplicação operacional. */
import { BlingError, type BlingCheckpoint, type BlingRawRecord, type BlingSelection, type BlingUnitKind, type JsonObject, type ResourceDescriptor } from "./contracts.ts";

const DAY = 86_400_000;
export const COLLECTION_POLICY = Object.freeze({ overlap_ms: 900_000, sweep_ms: 900_000, finance_stale_ms: 3_600_000, scan_size: 10 });
export const COLLECTION_BACKOFFS = Object.freeze({
  list: { base: 60_000, maximum: 3_600_000, missing: 3_600_000, scope: DAY },
  detail: { base: 60_000, maximum: 3_600_000, missing: 3_600_000, scope: DAY },
  stock: { base: 60_000, maximum: 3_600_000, missing: 3_600_000, scope: DAY },
  finance_refresh: { base: 300_000, maximum: DAY, missing: 3_600_000, scope: DAY },
  reference: { base: 300_000, maximum: DAY, missing: 3_600_000, scope: DAY },
  capture_repair: { base: 300_000, maximum: DAY, missing: DAY, scope: DAY },
});
/** Jitter determinístico; toda espera é um timestamp persistível. */
export function collectionBackoff(kind: BlingUnitKind, status: number, failures: number, now: number, seed = ""): number {
  const policy = COLLECTION_BACKOFFS[kind as keyof typeof COLLECTION_BACKOFFS] ?? COLLECTION_BACKOFFS.detail;
  const exponent = Math.min(8, Math.max(0, failures - 1));
  const delay = status === 403 ? policy.scope : status === 404 ? Math.min(DAY, policy.missing * 2 ** exponent) : Math.min(policy.maximum, policy.base * 2 ** exponent);
  const jitter = status === 403 || status === 404 ? 0 : [...seed].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 1000, 0);
  return now + delay + jitter;
}
export function localTimestamp(now: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const shift = (value: string, ms: number) => new Date(Date.parse(value.replace(" ", "T") + "Z") + ms).toISOString().slice(0, 19).replace("T", " ");
const min = (a: string, b: string) => a < b ? a : b;
const max = (a: string, b: string) => a > b ? a : b;
export interface WindowCursor { from?: string; to?: string; cutoff?: string; page: number; offset?: number; list_fingerprint?: string; started_at: string }
export interface WindowState { cp: JsonObject; lane: "recent" | "history" | "unfiltered"; cursor: WindowCursor }
/** Extraído de nextWindow/advanceWindow do original sem importar sync.mjs.
 * Os limites permanecem datas civis de São Paulo, com interseção da seleção. */
export function nextWindow(resource: ResourceDescriptor, checkpoint: JsonObject, now: number, selection: BlingSelection): WindowState {
  const cp = structuredClone(checkpoint);
  const cutoff = min(localTimestamp(now), selection.to ? selection.to + " 23:59:59" : "9999-12-31 23:59:59");
  const start = (selection.from ?? "1970-01-01") + " 00:00:00";
  const lane = resource.dateFilter?.kind === "U" ? "unfiltered" : cp.nextLane === "history" ? "history" : "recent";
  const old = cp[lane] as unknown as WindowCursor | undefined;
  if (old) return { cp, lane, cursor: structuredClone(old) };
  if (lane === "unfiltered") return { cp, lane, cursor: { page: 1, started_at: new Date(now).toISOString() } };
  if (start > cutoff) throw new BlingError("BLING_RETRY_WAIT", { retry_at: now + COLLECTION_POLICY.sweep_ms });
  const completed = typeof cp.recentCompletedAt === "string" ? min(cp.recentCompletedAt, cutoff) : null;
  const from = lane === "history" ? start : max(start, max(shift(cutoff, -30 * DAY), completed ? shift(completed, -COLLECTION_POLICY.overlap_ms) : start));
  return { cp, lane, cursor: { from, to: min(shift(from, 30 * DAY), cutoff), cutoff, page: 1, started_at: new Date(now).toISOString() } };
}
export function advanceWindow(state: WindowState, count: number, now: number, sourcePage = false): JsonObject {
  const cp = structuredClone(state.cp), { lane, cursor } = state;
  const more = sourcePage ? count > 0 : count >= 10;
  if (more) cp[lane] = { ...cursor, page: cursor.page + 1, offset: 0, list_fingerprint: "" } as unknown as JsonObject;
  else if (lane === "history" && cursor.to! < cursor.cutoff!) {
    const from = cursor.to!;
    cp[lane] = { from, to: min(shift(from, 30 * DAY), cursor.cutoff!), cutoff: cursor.cutoff!, page: 1, started_at: cursor.started_at };
  } else {
    delete cp[lane];
    // Frescor é o começo da passagem completa; nunca o instante do último GET.
    cp[`${lane}CompletedAt`] = localTimestamp(Date.parse(cursor.started_at));
    cp[`${lane}PassStartedAt`] = cursor.started_at;
    cp[`${lane}PassCompletedAt`] = new Date(now).toISOString();
    cp.not_before = now + COLLECTION_POLICY.sweep_ms;
  }
  cp.nextLane = lane === "recent" ? "history" : "recent";
  // A outra pista pode prosseguir imediatamente quando esta ainda tem páginas.
  if (cp.recent || cp.history || (lane !== "unfiltered" && !cp[`${cp.nextLane}PassCompletedAt`])) delete cp.not_before;
  delete cp.page;
  cp.last_served_at = now;
  return cp;
}
export interface PageCursor {
  ids: string[]; fingerprint: string; subcursor: number;
  state: WindowState; listed_count: number; slice_end: number; more: boolean;
  fallback_id?: string;
}
/** Persistir só IDs/fingerprint, jamais duplicar payload no plano da página. */
export function pageSlice(state: WindowState, ids: string[], fingerprint: string, sourcePage: boolean): PageCursor {
  if (ids.length > (sourcePage ? 1000 : 10) || new Set(ids).size !== ids.length) throw new BlingError("BLING_RESPONSE_INVALID");
  const offset = sourcePage && state.cursor.list_fingerprint === fingerprint ? state.cursor.offset ?? 0 : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ids.length) throw new BlingError("BLING_RESPONSE_INVALID");
  const slice = ids.slice(offset, offset + 10), end = offset + slice.length;
  return { ids: slice, fingerprint, subcursor: 0, state: structuredClone(state), listed_count: ids.length, slice_end: end, more: end < ids.length };
}
export function finishPageItem(checkpoint: BlingCheckpoint, resource: ResourceDescriptor, now: number): JsonObject {
  const cp = structuredClone(checkpoint.cursor), page = cp.page as unknown as PageCursor;
  if (!page || page.subcursor >= page.ids.length) throw new BlingError("BLING_REVISION_CONFLICT");
  page.subcursor++;
  delete page.fallback_id;
  if (page.subcursor < page.ids.length) { cp.page = page as unknown as JsonObject; cp.last_served_at = now; return cp; }
  if (page.more) {
    const next = structuredClone(cp);
    delete next.page;
    next[page.state.lane] = { ...page.state.cursor, offset: page.slice_end, list_fingerprint: page.fingerprint } as unknown as JsonObject;
    next.nextLane = page.state.lane; next.last_served_at = now;
    return next;
  }
  return advanceWindow({ ...page.state, cp }, page.listed_count, now, resource.pagination?.strategy === "source_page");
}
export function nextCheckpoint(previous: BlingCheckpoint, cursor: JsonObject, now: number): BlingCheckpoint {
  const completed = Object.entries(cursor).filter(([key, value]) => key.endsWith("PassCompletedAt") && typeof value === "string").sort((a, b) => String(a[1]).localeCompare(String(b[1]))).at(-1);
  const page = cursor.page as unknown as PageCursor | undefined;
  const started = page?.state.cursor.started_at ?? (completed ? cursor[completed[0].replace("CompletedAt", "StartedAt")] : null);
  return { revision: String(BigInt(previous.revision) + 1n), cursor, pass_started_at: typeof started === "string" ? started : previous.pass_started_at ?? new Date(now).toISOString(), pass_completed_at: completed ? String(completed[1]) : previous.pass_completed_at };
}
/** Cobertura incompleta é permanente; último GET não é prova de frescor. */
export function collectionFreshness(lanes: { resource: ResourceDescriptor; checkpoint: BlingCheckpoint }[]): string | null {
  if (!lanes.length) return null;
  const starts: string[] = [];
  for (const { resource, checkpoint } of lanes) {
    for (const lane of resource.dateFilter?.kind === "U" ? ["unfiltered"] : ["recent", "history"]) {
      const start = checkpoint.cursor[`${lane}PassStartedAt`], end = checkpoint.cursor[`${lane}PassCompletedAt`];
      if (typeof start !== "string" || typeof end !== "string" || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
      starts.push(start);
    }
  }
  return starts.sort()[0] ?? null;
}
export function financeRefreshEligible(record: BlingRawRecord, now: number): boolean {
  if (!["receivables", "payables"].includes(record.identity.entity) || Date.parse(record.observed_at) > now - COLLECTION_POLICY.finance_stale_ms) return false;
  // JSON.parse não é usado para transportar dados; só o enumerado situacao.
  try { return ["1", "3"].includes(String(JSON.parse(record.payload_text).situacao)); } catch { return false; }
}
export function captureRepairEligible(record: BlingRawRecord): boolean {
  if (!["products", "sales_proposals", "purchase_orders", "sales_orders"].includes(record.identity.entity) || record.deleted) return false;
  const profile = record.identity.entity === "purchase_orders" ? "origin-purchase-price-json-v1" : record.identity.entity === "sales_orders" ? "origin-sales-price-json-v1" : "origin-price-json-v1";
  if (!record.capture || record.capture.profile !== profile || record.capture.semantic_hash !== record.semantic_hash || record.capture.semantic_version !== record.version || record.capture.source !== "detail") return true;
  try {
    // Só inspeciona tipos/caminhos do acervo existente; valores não são usados
    // para gravar, comparar ou produzir evidência decimal.
    const data = JSON.parse(record.payload_text);
    const paths = record.identity.entity === "products" ? (typeof data.preco === "number" ? ["/preco"] : []) :
      (Array.isArray(data.itens) ? data.itens.flatMap((item: { valor?: unknown }, i: number) => typeof item.valor === "number" ? [`/itens/${i}/valor`] : []) : []);
    return paths.length !== record.capture.values.length || paths.some((path: string) => !record.capture!.values.some(value => value.path === path));
  } catch { return true; }
}
/** Justiça por última unidade servida, inclusive entre entidades com muitas variantes. */
export function chooseFair<T extends { key: string; entity: string; last_served_at: number; not_before: number }>(candidates: T[], now: number): T | null {
  const eligible = candidates.filter(x => x.not_before <= now);
  const entityLast = new Map<string, number>();
  for (const c of candidates) entityLast.set(c.entity, Math.max(entityLast.get(c.entity) ?? 0, c.last_served_at));
  eligible.sort((a, b) => (entityLast.get(a.entity)! - entityLast.get(b.entity)!) || a.last_served_at - b.last_served_at || a.key.localeCompare(b.key));
  return eligible[0] ?? null;
}
