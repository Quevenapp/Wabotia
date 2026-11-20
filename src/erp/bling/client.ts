/** Transporte de dados de uma tentativa. Não possui repetição, espera ou renovação implícita. */
import { BLING_BUDGET, BlingError, type BlingCapture, type BlingContext, type BlingExpectedState, type BlingFailure, type JsonObject, type ResourceDescriptor } from "./contracts.ts";
import type { AuthorizationPort, BlingDataPort, BlingDataRequest, BlingDataResult } from "./ports.ts";
import { BLING_RESOURCES, BLING_XML_RESOURCE, assertResourceConfirmed, buildBlingListQuery, exactSourceId, getBlingResource } from "./resources.ts";
// @ts-ignore Gramática lexical pura original, com limites e rejeição de chaves duplicadas.
import { parseSelectedPriceJson, isCapturedPriceNumber } from "../fagoo/workers/origin-sync/src/price-json-parser.mjs";
// @ts-ignore Perfis puros originais; nenhum executor é importado.
import { parsePriceJson, priceCapture } from "../fagoo/workers/origin-sync/src/price-json.mjs";
// @ts-ignore Perfis puros originais.
import { parseSalesPriceJson, salesPriceCapture } from "../fagoo/workers/origin-sync/src/sales-price-json.mjs";
// @ts-ignore Perfis puros originais.
import { parsePurchasePriceJson, purchasePriceCapture } from "../fagoo/workers/origin-sync/src/purchase-price-json.mjs";
// @ts-ignore Perfis puros originais.
import { parseStockJson, stockCapture } from "../fagoo/workers/origin-sync/src/stock-json.mjs";
// @ts-ignore Perfis puros originais.
import { parseServiceJson } from "../fagoo/workers/origin-sync/src/service-json.mjs";

const encoder = new TextEncoder();
const responseLimit = 8 * 1024 * 1024;
type Token = { path: string; lexeme: string };
export type ParsedBlingCapture = Pick<BlingCapture, "profile" | "source" | "bytes_sha256" | "values">;
export interface ParsedBlingItem { id: string; value: JsonObject; payload_text: string; capture: ParsedBlingCapture | null }
export interface ParsedBlingResponse { items: ParsedBlingItem[]; bytes_sha256: string }
const invalid = () => new BlingError("BLING_RESPONSE_INVALID");
const pointer = (path: (string | number)[]) => "/" + path.map(part => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Ordena somente chaves. Números JSON.rawJSON mantêm o valor decimal exato. */
export function canonicalJson(value: unknown): string {
  if (isCapturedPriceNumber(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) throw invalid();
  return result;
}
export const lexicalJson = canonicalJson;

/** Captura TODOS os números antes que qualquer perfil específico os materialize. */
async function lexical(text: string, bytes: Uint8Array): Promise<{ result: unknown; hash: string; tokens: Map<number, Token[]> }> {
  try { return await parseSelectedPriceJson(text, bytes, (path: (string | number)[]) => [0, pointer(path)]); }
  catch { throw invalid(); }
}
export async function parseLexicalJson(text: string): Promise<JsonObject> {
  const parsed = await lexical(text, encoder.encode(text));
  if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) throw invalid();
  return parsed.result as JsonObject;
}
const parsedCache = new WeakMap<Uint8Array, { key: string; path: string; result: ParsedBlingResponse }>();
export async function parseBlingResponse(resourceKey: string, path: string, bytes: Uint8Array, catalog: readonly ResourceDescriptor[] = BLING_RESOURCES): Promise<ParsedBlingResponse> {
  const cached = parsedCache.get(bytes);
  if (cached?.key === resourceKey && cached.path === path) return cached.result;
  try {
    const resource = getBlingResource(resourceKey, catalog);
    const list = path === resource.path;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = await lexical(text, bytes);
    const envelope = parsed.result as Record<string, unknown>;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.hasOwn(envelope, "error")) throw invalid();
    const bareCash = resource.entity === "cash_entries" && !list && Object.hasOwn(envelope, "id");
    const data = bareCash ? envelope : envelope.data;
    if (list !== Array.isArray(data) || !data || typeof data !== "object") throw invalid();
    if (bareCash && Object.hasOwn(envelope, "data") && typeof envelope.data !== "string") throw invalid();
    const rows = (list ? data : [data]) as Record<string, unknown>[];
    const limit = resource.pagination?.strategy === "source_page" ? 1000 : resource.entity === "stock_balances" ? 25 : list ? 10 : 1;
    if (rows.length > limit) throw invalid();
    let precise: Record<string, unknown>[] | null = null;
    let evidence: ((value: unknown) => { profile: string; tokens: Token[] } | null) | null = null;
    if (resource.entity === "products" || (resource.entity === "sales_proposals" && !list)) {
      const profileResult = await parsePriceJson(text, bytes, resource.entity === "products" ? list ? "product_list" : "product_detail" : "proposal_detail");
      precise = list ? profileResult.data : [profileResult.data];
      evidence = value => priceCapture(value, list ? "list_fallback" : "detail");
    } else if (resource.entity === "sales_orders" && !list) {
      precise = [(await parseSalesPriceJson(text, bytes, "sales_detail")).data]; evidence = salesPriceCapture;
    } else if (resource.entity === "purchase_orders" && !list) {
      precise = [(await parsePurchasePriceJson(text, bytes, "purchase_detail")).data]; evidence = purchasePriceCapture;
    } else if (resource.entity === "stock_balances") {
      precise = (await parseStockJson(text, bytes)).data; evidence = stockCapture;
    } else if (resource.entity === "service_orders" && !list) {
      precise = [(await parseServiceJson(text, bytes)).data];
      evidence = value => (value as Record<string, unknown>)._brufap_service_capture as { profile: string; tokens: Token[] };
    }
    const items: ParsedBlingItem[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid();
      const id = exactSourceId(resource.entity === "stock_balances" ? (row.produto as Record<string, unknown> | undefined)?.id : row.id);
      if (!list && id !== path.slice(path.lastIndexOf("/") + 1)) throw invalid();
      if (ids.has(id)) throw invalid(); ids.add(id);
      if (resource.entity === "stock_balances" && row.depositos !== undefined) {
        if (!Array.isArray(row.depositos) || row.depositos.length > 1000) throw invalid();
        const deposits = row.depositos.map(deposit => exactSourceId((deposit as Record<string, unknown>)?.id));
        if (new Set(deposits).size !== deposits.length) throw invalid();
      }
      const payload_text = canonicalJson(row);
      let capture: ParsedBlingCapture | null = null;
      const source = resource.entity === "stock_balances" ? "stock_product" : list ? "deleted_without_detail" : "detail";
      if (!list || resource.entity === "stock_balances" || (resource.entity === "products" && resource.variants.length === 1 && resource.variants[0].deleted)) {
        const original = evidence && precise ? evidence(precise[index]) : null;
        const prefix = bareCash ? "" : list ? `/data/${index}` : "/data";
        const values = original?.tokens ?? (parsed.tokens.get(0) ?? []).filter(token => token.path.startsWith(prefix + "/")).map(token => ({ path: token.path.slice(prefix.length), lexeme: token.lexeme }));
        capture = { profile: original?.profile ?? "bling-lexical-json-v1", source, bytes_sha256: resource.entity === "stock_balances" ? await sha256Bytes(encoder.encode(payload_text)) : parsed.hash, values };
      }
      items.push({ id, value: row as JsonObject, payload_text, capture });
    }
    const result = { items, bytes_sha256: parsed.hash };
    parsedCache.set(bytes, { key: resourceKey, path, result });
    return result;
  } catch { throw invalid(); }
}

export interface BlingClientTimer { set(callback: () => void, milliseconds: number): unknown; clear(handle: unknown): void }
export interface BlingDataClientOptions {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  authorization: Pick<AuthorizationPort, "privateCredential">;
  revalidate(ctx: BlingContext, expected: BlingExpectedState): Promise<void>;
  resources?: readonly ResourceDescriptor[];
  /** Apenas origem oficial fixa ou domínio reservado do simulador, nunca entrada pública. */
  baseUrl?: string;
  maxResponseBytes?: number;
  timer?: BlingClientTimer;
}
const defaultTimer: BlingClientTimer = { set: (callback, milliseconds) => setTimeout(callback, milliseconds), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
function localFailure(error: unknown): BlingFailure { return error instanceof BlingError ? error.toJSON() : invalid().toJSON(); }
function discard(response: Response): void { try { void response.body?.cancel().catch(() => {}); } catch { /* Sem corpo em erro/log. */ } }
function retry(code: "BLING_RATE_WAIT" | "BLING_RETRY_WAIT", retry_at: number): BlingDataResult { return { kind: "retry", retry_at, error: new BlingError(code, { retry_at }).toJSON() }; }
function retryAfter(value: string | null, now: number): number {
  if (value && /^\d{1,12}(?:\.\d{1,3})?$/.test(value.trim())) return Math.min(Number.MAX_SAFE_INTEGER, now + Math.ceil(Number(value) * 1000));
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > now ? date : now + 60000;
}

function requestUrl(request: BlingDataRequest, catalog: readonly ResourceDescriptor[], baseUrl: string): { url: string; xml: boolean } {
  if (request.method !== "GET") throw invalid();
  const resource = request.resource_key === BLING_XML_RESOURCE.key ? catalog.find(entry => entry.key === BLING_XML_RESOURCE.key) : getBlingResource(request.resource_key, catalog);
  if (!resource) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
  assertResourceConfirmed(resource);
  const xml = resource.key === BLING_XML_RESOURCE.key;
  const known = xml ? BLING_XML_RESOURCE : BLING_RESOURCES.find(entry => entry.entity === resource.entity);
  if (!known?.path || resource.path !== known.path || resource.detail?.path !== known.detail?.path) throw invalid();
  const path = request.path;
  const isList = path === resource.path;
  const detailPrefix = resource.detail?.path.replace(/\{id\}$/, "");
  if (xml ? !/^\/nfe\/documento\/\d{44}$/.test(path) : !isList && (!detailPrefix || !path.startsWith(detailPrefix) || !/^\d{1,40}$/.test(path.slice(detailPrefix.length)) || /^0+$/.test(path.slice(detailPrefix.length)))) throw invalid();
  if (!request.query || typeof request.query !== "object" || Array.isArray(request.query)) throw invalid();
  const keys = Object.keys(request.query);
  if (xml) {
    if (keys.length !== 1 || request.query.formato !== "xml") throw invalid();
  } else if (!isList) {
    if (keys.length) throw invalid();
  } else if (resource.entity === "stock_balances") {
    const ids = request.query["idsProdutos[]"];
    if (keys.length !== 2 || !Array.isArray(ids) || ids.length < 1 || ids.length > 25 || new Set(ids).size !== ids.length || ids.some(id => exactSourceId(id) !== id) || !["0", "1", "2"].includes(request.query.filtroSaldoEstoque as string)) throw invalid();
  } else {
    const variants = resource.variants;
    const valid = variants.some(variant => {
      try {
        const expected = buildBlingListQuery(variant.key, { page: Number(request.query.pagina), limit: resource.pagination?.limit_parameter ? Number(request.query.limite) : 10, from: resource.dateFilter?.from ? request.query[resource.dateFilter.from] as string : undefined, to: resource.dateFilter?.to ? request.query[resource.dateFilter.to] as string : undefined });
        return canonicalJson(expected) === canonicalJson(request.query);
      } catch { return false; }
    });
    if (!valid) throw invalid();
  }
  const url = new URL(baseUrl + path);
  for (const [key, entry] of Object.entries(request.query)) {
    const values = Array.isArray(entry) ? entry : [entry];
    for (const value of values) { if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value)) throw invalid(); url.searchParams.append(key, value); }
  }
  return { url: url.toString(), xml };
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw invalid(); chunks.push(value.slice());
    }
    if (declared !== null && Number(declared) !== size) throw invalid();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { try { void reader.cancel().catch(() => {}); } catch { /* Sem erro remoto. */ } throw invalid(); }
  finally { reader.releaseLock(); }
}

export function createBlingDataClient(options: BlingDataClientOptions): BlingDataPort {
  const baseUrl = options.baseUrl ?? "https://api.bling.com.br/Api/v3";
  if (!["https://api.bling.com.br/Api/v3", "https://bling.invalid/Api/v3"].includes(baseUrl)) throw invalid();
  const limit = options.maxResponseBytes ?? responseLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > responseLimit) throw invalid();
  const catalog = options.resources ?? BLING_RESOURCES, timer = options.timer ?? defaultTimer;
  return {
    async get(ctx, request) {
      let address: { url: string; xml: boolean };
      try { address = requestUrl(request, catalog, baseUrl); }
      catch (error) { return { kind: "failure", status: error instanceof BlingError ? error.status : 409, error: localFailure(error) }; }
      const deadline = Math.min(request.deadline, ctx.clock.now() + BLING_BUDGET.http_ms);
      if (!Number.isSafeInteger(deadline) || deadline <= ctx.clock.now()) return retry("BLING_RETRY_WAIT", ctx.clock.now() + 1000);
      const controller = new AbortController(); let handle: unknown;
      const timeout = new Promise<BlingDataResult>(resolve => { handle = timer.set(() => { controller.abort(); resolve(retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000)); }, deadline - ctx.clock.now()); });
      const attempt = async (): Promise<BlingDataResult> => {
        try {
          await options.revalidate(ctx, request.expected);
          if (controller.signal.aborted || ctx.clock.now() >= deadline) return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000);
          const credential = await options.authorization.privateCredential(ctx, request.expected);
          await options.revalidate(ctx, request.expected);
          if (controller.signal.aborted || ctx.clock.now() >= deadline) return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000);
          if (!credential.access_token || /\s/.test(credential.access_token) || credential.access_token.length > 8192) throw new BlingError("BLING_AUTH_REQUIRED");
          const response = await options.fetch(address.url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Authorization: `Bearer ${credential.access_token}`, Accept: address.xml ? "application/xml, application/json" : "application/json", "enable-jwt": "1" } });
          await options.revalidate(ctx, request.expected);
          if (controller.signal.aborted || ctx.clock.now() >= deadline) { discard(response); return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000); }
          if (response.redirected || response.status >= 300 && response.status < 400) { discard(response); return { kind: "failure", status: response.status, error: invalid().toJSON() }; }
          if (response.status !== 200) {
            const status = response.status, wait = retryAfter(response.headers.get("retry-after"), ctx.clock.now()); discard(response);
            if (status === 429) return retry("BLING_RATE_WAIT", wait);
            if (status >= 500) return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000);
            return { kind: "failure", status, error: new BlingError(status === 401 ? "BLING_AUTH_REQUIRED" : status === 403 ? "BLING_SCOPE_REQUIRED" : status === 404 ? "BLING_RETRY_WAIT" : "BLING_RESPONSE_INVALID", status === 404 ? { retry_at: ctx.clock.now() + 3600000 } : {}).toJSON() };
          }
          const bytes = await readBounded(response, limit);
          if (!address.xml) await parseBlingResponse(request.resource_key, request.path, bytes, catalog);
          await options.revalidate(ctx, request.expected);
          if (controller.signal.aborted || ctx.clock.now() >= deadline) return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000);
          return { kind: "success", status: 200, bytes, received_at: ctx.clock.now() };
        } catch (error) {
          controller.abort();
          if (error instanceof BlingError && error.code !== "BLING_RESPONSE_INVALID") return { kind: "failure", status: error.status, error: error.toJSON() };
          return retry("BLING_RETRY_WAIT", ctx.clock.now() + 60000);
        }
      };
      try { return await Promise.race([attempt(), timeout]); }
      finally { timer.clear(handle); }
    },
  };
}
