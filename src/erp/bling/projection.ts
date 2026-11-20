/** Consulta pura do acervo. Não importa projetores nem escreve no ERP. */
import { createHash } from "node:crypto";
import { BlingError, type BlingCapture, type BlingCoverage, type BlingHistoricalDto, type BlingRawRecord, type JsonObject, type JsonValue } from "./contracts.ts";
// O auxiliar lexical original é JavaScript puro, sem declarações TypeScript.
// @ts-expect-error Módulo original sem arquivo de declaração.
import { canonicalPriceToken } from "../fagoo/workers/origin-sync/src/price-json-parser.mjs";

export const MAPPER_VERSION = "bling-history-v1";
const MAX_BYTES = 8_388_608;
const MAX_ROWS = 1_000;
const INVALID = () => new BlingError("BLING_RESPONSE_INVALID");
const pointer = (parts: (string | number)[]) => parts.map(part => "/" + String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export interface HistoricalPayload { payload: JsonObject; numeric_paths: ReadonlyMap<string, string> }

/** Adaptação síncrona da gramática limitada original. Todos os números ficam
 * lexicais, inclusive IDs; o mapa distingue um número JSON de uma string. */
export function parseHistoricalPayload(text: string): HistoricalPayload {
  if (typeof text !== "string" || text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw INVALID();
  let at = 0, nodes = 0;
  const numeric = new Map<string, string>();
  const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const white = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '"') { try { return JSON.parse(text.slice(start, at)); } catch { throw INVALID(); } }
      if (ch.charCodeAt(0) < 32) throw INVALID();
      if (ch === "\\") { if (at >= text.length) throw INVALID(); at++; }
    }
    throw INVALID();
  };
  const value = (path: (string | number)[], depth: number): JsonValue => {
    if (++nodes > 200_000 || depth > 64) throw INVALID();
    white(); const ch = text[at];
    if (ch === '"') return string();
    if (ch === "{") {
      at++; const result: JsonObject = {}, keys = new Set<string>(); white();
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        white(); if (text[at] !== '"') throw INVALID();
        const key = string(); if (keys.has(key)) throw INVALID(); keys.add(key);
        white(); if (text[at++] !== ":") throw INVALID();
        Object.defineProperty(result, key, { value: value([...path, key], depth + 1), enumerable: true, configurable: true, writable: true });
        white(); const sep = text[at++]; if (sep === "}") return result; if (sep !== ",") throw INVALID();
      }
    }
    if (ch === "[") {
      at++; const result: JsonValue[] = []; white(); if (text[at] === "]") { at++; return result; }
      for (;;) { result.push(value([...path, result.length], depth + 1)); white(); const sep = text[at++]; if (sep === "]") return result; if (sep !== ",") throw INVALID(); }
    }
    for (const [literal, primitive] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return primitive; }
    }
    numberToken.lastIndex = at;
    const match = numberToken.exec(text);
    if (!match) throw INVALID();
    at += match[0].length; numeric.set(pointer(path), match[0]); return match[0];
  };
  const payload = value([], 0); white();
  if (at !== text.length || !object(payload)) throw INVALID();
  return { payload, numeric_paths: numeric };
}

export function atPath(value: JsonValue | undefined, path: readonly (string | number)[]): JsonValue | undefined {
  for (const part of path) {
    if (Array.isArray(value) && typeof part === "number") value = value[part];
    else if (object(value) && own(value, String(part))) value = value[String(part)];
    else return undefined;
  }
  return value;
}

export type ObservedState = "unknown" | "absent" | "null" | "invalid" | "value";
export interface ObservedValue extends JsonObject { state: ObservedState; value: string | null; original: string | null }
export const unknownValue = (): ObservedValue => ({ state: "unknown", value: null, original: null });

export function observedText(value: JsonValue | undefined, max = 4_000): ObservedValue {
  if (value === undefined) return { state: "absent", value: null, original: null };
  if (value === null) return { state: "null", value: null, original: null };
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f-\x9f]/.test(value)) return { state: "invalid", value: null, original: null };
  return { state: "value", value, original: value };
}

/** Não arredonda. O limite de estoque reproduz magnitude < 10^24 e escala 12. */
export function observedDecimal(value: JsonValue | undefined, stock = false): ObservedValue {
  const observed = observedText(value, stock ? 80 : 128);
  if (observed.state !== "value") return observed;
  try {
    const decimal: string = canonicalPriceToken(observed.value);
    const [whole, fraction = ""] = decimal.replace(/^-/, "").split(".");
    if (stock && (whole.length > 24 || fraction.length > 12)) return { ...observed, state: "invalid", value: null };
    return { ...observed, value: decimal };
  } catch { return { ...observed, state: "invalid", value: null }; }
}

export function exactSourceId(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^[0-9]{1,40}$/.test(value) && !/^0+$/.test(value) ? value : null;
}

export function observedDate(value: JsonValue | undefined): ObservedValue {
  const observed = observedText(value, 80);
  if (observed.state !== "value") return observed;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(observed.value!);
  const clock = /[T ](\d{2}):(\d{2}):(\d{2})/.exec(observed.value!);
  if (!match || match[1] === "0000" || clock && (clock[1] > "23" || clock[2] > "59" || clock[3] > "59")) return { ...observed, state: "invalid", value: null };
  const day = match[1] + "-" + match[2] + "-" + match[3], stamp = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== day || !Number.isFinite(Date.parse(observed.value!))) return { ...observed, state: "invalid", value: null };
  return observed;
}

const captureProfiles: Record<string, string> = {
  products: "origin-price-json-v1", sales_proposals: "origin-price-json-v1", sales_orders: "origin-sales-price-json-v1",
  purchase_orders: "origin-purchase-price-json-v1", stock_balances: "origin-stock-json-v1", service_orders: "origin-service-json-v1",
};
function capturePath(entity: string, path: string): boolean {
  if (entity === "products") return path === "/preco";
  if (["sales_orders", "purchase_orders", "sales_proposals"].includes(entity)) return /^\/itens\/\d+\/valor$/.test(path);
  if (entity === "stock_balances") return /^\/(?:saldoFisicoTotal|saldoVirtualTotal)$/.test(path) || /^\/depositos\/\d+\/(?:saldoFisico|saldoVirtual)$/.test(path);
  if (entity === "service_orders") return /^\/(?:total|totalPecas|totalServicos|valorFrete)$/.test(path) || path === "/desconto/valor" || /^\/(?:pecas|servicos|itens)\/\d+\/(?:quantidade|horas|valorUnitario|valor|precoLista|desconto|total|valorTotal)$/.test(path);
  return false;
}

/** Valida provas já capturadas. Ausência permanece desconhecida, não é prova.
 * Quando bytes são fornecidos, verifica SHA e que os lexemas vieram do mesmo
 * detalhe/produto. Não exige reserializar o envelope HTTP para consultá-lo. */
export function validateCapture(record: BlingRawRecord, bytes?: Uint8Array): BlingCapture | null {
  if (record.capture === null) return null;
  const capture = record.capture, parsed = parseHistoricalPayload(record.payload_text), entity = record.identity.entity;
  if (!capture || !captureProfiles[entity] || capture.profile !== captureProfiles[entity] || !/^(0|[1-9][0-9]{0,15})$/.test(capture.revision) || BigInt(capture.revision) > 9_007_199_254_740_991n || !/^[a-f0-9]{64}$/.test(capture.bytes_sha256) || capture.semantic_hash !== record.semantic_hash || capture.semantic_version !== record.version || !Array.isArray(capture.values) || capture.values.length > 4_096 || new TextEncoder().encode(JSON.stringify(capture)).byteLength > 131_072) throw INVALID();
  if (exactSourceId(entity === "stock_balances" ? atPath(parsed.payload, ["produto", "id"]) : parsed.payload.id) !== record.identity.source_id) throw INVALID();
  if (entity === "stock_balances" ? capture.source !== "stock_product" : capture.source !== "detail") {
    const marker = parsed.payload._brufap_source;
    if (entity !== "products" || capture.source !== "deleted_without_detail" || !record.deleted || !record.deletion_evidence || !object(marker) || marker.deleted !== true || marker.detail_available !== false) throw INVALID();
  }
  const expected = new Map([...parsed.numeric_paths].filter(([path]) => capturePath(entity, path)));
  const seen = new Set<string>();
  for (const token of capture.values) {
    if (!token || typeof token.path !== "string" || typeof token.lexeme !== "string" || seen.has(token.path) || !expected.has(token.path)) throw INVALID();
    try { if (canonicalPriceToken(token.lexeme) !== canonicalPriceToken(expected.get(token.path))) throw INVALID(); } catch { throw INVALID(); }
    seen.add(token.path);
  }
  if (seen.size !== expected.size) throw INVALID();
  if (bytes !== undefined) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== capture.bytes_sha256) throw INVALID();
    let response: HistoricalPayload;
    try { response = parseHistoricalPayload(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw INVALID(); }
    let prefix = "", responsePayload = response.payload;
    if (object(response.payload.data)) { prefix = "/data"; responsePayload = response.payload.data; }
    else if (Array.isArray(response.payload.data)) {
      const matching = response.payload.data.map((item, index) => ({ item, index })).filter(({ item }) => object(item) && exactSourceId(entity === "stock_balances" ? atPath(item, ["produto", "id"]) : item.id) === record.identity.source_id);
      if (matching.length !== 1 || !object(matching[0].item)) throw INVALID();
      responsePayload = matching[0].item; prefix = "/data/" + matching[0].index;
    }
    if (exactSourceId(entity === "stock_balances" ? atPath(responsePayload, ["produto", "id"]) : responsePayload.id) !== record.identity.source_id) throw INVALID();
    for (const token of capture.values) if (response.numeric_paths.get(prefix + token.path) !== token.lexeme) throw INVALID();
  }
  return capture;
}

export interface CompletedPass { key: string; started_at: string | null; completed_at: string | null; observed?: number; changed?: number; pending?: number }
export const safeCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function safeTime(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && observedDate(value).state === "value" ? value : null;
}

/** Frescor só existe se TODAS as pistas necessárias concluíram uma passagem. */
export function coverageFromPasses(required: readonly string[], passes: readonly CompletedPass[]): BlingCoverage {
  const selected = required.map(key => passes.filter(pass => pass.key === key && safeTime(pass.started_at) && safeTime(pass.completed_at) && Date.parse(pass.started_at!) <= Date.parse(pass.completed_at!)).sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!))[0]);
  const known = selected.filter((pass): pass is CompletedPass => !!pass);
  const completeEvidence = required.length > 0 && known.length === required.length;
  const oldest = known.reduce<string | null>((prior, pass) => !prior || Date.parse(pass.started_at!) < Date.parse(prior) ? pass.started_at : prior, null);
  const latest = known.reduce<string | null>((prior, pass) => !prior || Date.parse(pass.completed_at!) > Date.parse(prior) ? pass.completed_at : prior, null);
  const total = (field: "observed" | "changed" | "pending") => known.reduce((sum, pass) => Math.min(Number.MAX_SAFE_INTEGER, sum + safeCount(pass[field])), 0);
  return { complete: false, observed: total("observed"), changed: total("changed"), pending: total("pending"), last_pass_started_at: oldest, last_pass_completed_at: latest, freshness_at: completeEvidence ? oldest : null, limitations: ["A coleta não certifica completude da conta.", ...(!completeEvidence ? ["Há pistas sem passagem concluída; frescor desconhecido."] : [])] };
}

/** Referência retirada/inválida resulta em null: nenhum vínculo é aproximado. */
export function explicitOrderReference(record: BlingRawRecord): JsonObject | null {
  if (record.identity.entity !== "sales_orders" || record.deleted) return null;
  const { payload } = parseHistoricalPayload(record.payload_text), invoice = exactSourceId(atPath(payload, ["notaFiscal", "id"]));
  if (!invoice) return null;
  return { profile: record.identity.profile, account_id: record.identity.account_id, order_source_id: record.identity.source_id, invoice_source_id: invoice, source_version: record.version, source_hash: record.semantic_hash, target_entities: ["nfe", "nfce"], state: "unresolved" };
}

/** Mesmo ID NF-e/NFC-e é ambíguo sem entidade comprovada. */
export function resolveOrderReference(reference: JsonObject, candidates: readonly Pick<BlingRawRecord, "identity" | "version">[]): JsonObject {
  const matching = candidates.filter(record => record.identity.profile === reference.profile && record.identity.account_id === reference.account_id && ["nfe", "nfce"].includes(record.identity.entity) && record.identity.source_id === reference.invoice_source_id);
  const identities = new Set(matching.map(record => record.identity.profile + ":" + record.identity.account_id + ":" + record.identity.entity + ":" + record.identity.source_id));
  if (identities.size !== 1) return { ...reference, state: identities.size ? "ambiguous" : "unresolved", entity: null };
  return { ...reference, state: "resolved", entity: matching[0].identity.entity, version: matching[0].version };
}

export function fiscalIndex(record: BlingRawRecord): JsonObject {
  const { payload } = parseHistoricalPayload(record.payload_text), entity = record.identity.entity;
  if (entity !== "nfe" && entity !== "nfce") throw INVALID();
  const key = typeof payload.chaveAcesso === "string" && /^\d{44}$/.test(payload.chaveAcesso) ? payload.chaveAcesso : null;
  const environments = [payload.ambiente, payload.tpAmb].filter(value => value !== undefined && value !== null);
  const environment = environments.length > 0 && environments.every(value => value === "1") ? "production" : environments.length > 0 && environments.every(value => value === "2") ? "test" : "unknown";
  const direction = observedText(payload.tipo, 80);
  if (direction.state === "value" && direction.value !== "0" && direction.value !== "1") { direction.state = "invalid"; direction.value = null; }
  return { entity, source_id: record.identity.source_id, access_key: key, model: entity === "nfe" ? "55" : "65", environment, environment_state: environments.length ? environment === "unknown" ? "invalid" : "value" : own(payload, "ambiente") || own(payload, "tpAmb") ? "null" : "absent", environment_evidence: environment === "unknown" ? "unknown" : "payload", number: observedText(payload.numero, 80), series: observedText(payload.serie, 80), issued_at: observedDate(payload.dataEmissao), operated_at: observedDate(payload.dataOperacao), status: observedText(object(payload.situacao) ? payload.situacao.id : payload.situacao, 80), direction, total: observedDecimal(payload.valorNota), cryptographic_certification: false };
}

export function productStatus(record: BlingRawRecord): "A" | "I" | "E" | null {
  if (record.identity.entity !== "products") return null;
  if (record.deleted && record.deletion_evidence) return "E";
  const status = parseHistoricalPayload(record.payload_text).payload.situacao;
  return status === "A" || status === "I" || status === "E" ? status : null;
}

/** Cobertura fiscal não junta modelos, ambientes nem identidades por chave. */
export function fiscalCoverage(records: readonly BlingRawRecord[]): JsonObject {
  const buckets: Record<string, { observed: number; missing_key: number; unknown_environment: number }> = {};
  for (const record of records) {
    if (record.identity.entity !== "nfe" && record.identity.entity !== "nfce") continue;
    const index = fiscalIndex(record), name = `${index.entity}:${index.environment}:${(index.direction as ObservedValue).value ?? "unknown"}`;
    const bucket = buckets[name] ??= { observed: 0, missing_key: 0, unknown_environment: 0 };
    bucket.observed++; if (index.access_key === null) bucket.missing_key++; if (index.environment === "unknown") bucket.unknown_environment++;
  }
  return { complete: false, xml_availability: "unknown", cryptographic_certification: false, buckets };
}

function arrayState(value: JsonValue | undefined): string { return value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? "value" : "invalid"; }
function reference(entity: string, id: JsonValue | undefined, path: string): JsonObject | null {
  const source_id = exactSourceId(id); return source_id ? { entity, source_id, path, state: "unresolved" } : null;
}

/** Mapper histórico independente de vínculos e partes operacionais. */
export function projectRecord(record: BlingRawRecord): BlingHistoricalDto {
  const { payload: p } = parseHistoricalPayload(record.payload_text), entity = record.identity.entity;
  const references: JsonObject[] = [], mapped = new Set(["id", "_brufap_source"]);
  let referenceLimit = false;
  const use = (...keys: string[]) => { keys.forEach(key => mapped.add(key)); };
  const appendReference = (found: JsonObject) => { if (references.length < MAX_ROWS) references.push(found); else referenceLimit = true; };
  const ref = (target: string, id: JsonValue | undefined, path: string) => { const found = reference(target, id, path); if (found) appendReference(found); };
  let captureState = "unknown";
  try { captureState = validateCapture(record) ? "bound" : "unknown"; } catch { captureState = "invalid"; }
  const fields: JsonObject = {
    mapper_version: MAPPER_VERSION, entity, source_id: record.identity.source_id, version: record.version,
    observed_at: record.observed_at, source_updated_at: record.source_updated_at, source_time_quality: record.source_time_quality,
    deleted: record.deleted, deletion_evidence: record.deletion_evidence, read_only: true, native_effects: false,
    capture: { state: captureState, revision: captureState === "bound" ? record.capture!.revision : null },
  };
  const coverage = coverageFromPasses([], []);
  coverage.observed = 1;
  coverage.limitations.push("URLs de imagens e anexos são referências; os bytes não estão arquivados.");
  if (["sales_orders", "sales_proposals", "purchase_orders", "service_orders"].includes(entity)) {
    use("numero", "data", "dataPrevista", "situacao", "contato", "itens", "pecas", "servicos", "parcelas", "total", "totalProdutos", "totalServicos", "totalPecas", "desconto", "transporte", "outrasDespesas", "notaFiscal", "observacoes", "observacoesInternas");
    fields.number = observedText(p.numero, 80); fields.date = observedDate(p.data); fields.expected_date = observedDate(p.dataPrevista);
    fields.status = observedText(object(p.situacao) ? p.situacao.id : p.situacao, 80);
    fields.customer = { id: observedText(atPath(p, ["contato", "id"]), 40), name: observedText(atPath(p, ["contato", "nome"]), 200) };
    ref("contacts", atPath(p, ["contato", "id"]), "/contato/id");
    const rows = Array.isArray(p.itens) ? p.itens : [];
    fields.items_state = arrayState(p.itens);
    fields.items = rows.slice(0, MAX_ROWS).map((row, index) => {
      const item = object(row) ? row : {}, product = atPath(item, ["produto", "id"]);
      ref("products", product, `/itens/${index}/produto/id`);
      return { position: index + 1, state: object(row) ? "value" : "invalid", source_product_id: observedText(product, 40), code: observedText(item.codigo, 100), description: observedText(item.descricao, 4_000), unit: observedText(item.unidade, 16), quantity: observedDecimal(item.quantidade), unit_price: observedDecimal(item.valor), discount_observed: observedDecimal(item.desconto), list_price: observedDecimal(item.valorLista), total_observed: observedDecimal(item.total), discount_reapplied: false };
    });
    fields.items_truncated = rows.length > MAX_ROWS;
    fields.total_observed = observedDecimal(p.total); fields.products_total_observed = observedDecimal(p.totalProdutos);
    fields.freight_observed = observedDecimal(atPath(p, ["transporte", "frete"])); fields.other_expenses_observed = observedDecimal(p.outrasDespesas);
    fields.discount_observed = observedDecimal(object(p.desconto) ? p.desconto.valor : p.desconto);
    fields.reconciliation = { state: "unknown", calculated_total: null, difference: null, commercial_math_reconciled: false };
    fields.installments_state = arrayState(p.parcelas);
    fields.installments = (Array.isArray(p.parcelas) ? p.parcelas : []).slice(0, MAX_ROWS).map(row => {
      const item = object(row) ? row : {}; return { due_date: observedDate(own(item, "dataVencimento") ? item.dataVencimento : item.data), amount: observedDecimal(item.valor), note: observedText(item.observacoes, 2_000) };
    });
    fields.notes = observedText(p.observacoes); fields.internal_notes = observedText(p.observacoesInternas);
    const order = explicitOrderReference(record); if (order) appendReference(order);
    coverage.limitations.push("Totais, descontos e parcelas são valores observados, sem conciliação comercial.");
    if (entity === "service_orders") {
      fields.parts_total_observed = observedDecimal(p.totalPecas); fields.service_total_observed = observedDecimal(p.totalServicos);
      fields.parts_state = arrayState(p.pecas); fields.services_state = arrayState(p.servicos);
      for (const group of ["pecas", "servicos"] as const) fields[group] = (Array.isArray(p[group]) ? p[group] : []).slice(0, MAX_ROWS).map(row => {
        const item = object(row) ? row : {}; return { description: observedText(item.descricao), quantity: observedDecimal(item.quantidade), hours: observedDecimal(item.horas), unit_price: observedDecimal(item.valorUnitario), total_observed: observedDecimal(item.total), discount_observed: observedDecimal(item.desconto) };
      });
    }
  } else if (entity === "stock_balances") {
    use("produto", "depositos", "saldoFisicoTotal", "saldoVirtualTotal");
    const product = exactSourceId(atPath(p, ["produto", "id"])), rows = Array.isArray(p.depositos) ? p.depositos : [];
    const warehouseIds = rows.map(row => exactSourceId(object(row) ? row.id : undefined));
    const valid = product === record.identity.source_id && Array.isArray(p.depositos) && rows.length <= MAX_ROWS && warehouseIds.every(Boolean) && new Set(warehouseIds).size === warehouseIds.length;
    fields.product_source_id = product; fields.warehouses_state = valid ? "value" : "invalid";
    fields.physical_total = observedDecimal(p.saldoFisicoTotal, true); fields.virtual_total = observedDecimal(p.saldoVirtualTotal, true);
    fields.positions = rows.slice(0, MAX_ROWS).map((row, index) => {
      const item = object(row) ? row : {}; ref("warehouses", item.id, `/depositos/${index}/id`);
      const unavailable: ObservedValue = { state: valid ? "absent" : "invalid", value: null, original: null };
      return { warehouse_source_id: warehouseIds[index], physical: valid && !record.deleted ? observedDecimal(item.saldoFisico, true) : unavailable, virtual: valid && !record.deleted ? observedDecimal(item.saldoVirtual, true) : unavailable, reserved: unknownValue() };
    });
    ref("products", atPath(p, ["produto", "id"]), "/produto/id");
    coverage.limitations.push("Saldo observado não representa movimento, reserva, lote ou abertura de estoque.");
  } else if (entity === "nfe" || entity === "nfce") {
    use("chaveAcesso", "numero", "serie", "dataEmissao", "dataOperacao", "situacao", "tipo", "valorNota", "ambiente", "tpAmb");
    fields.fiscal = fiscalIndex(record);
    coverage.limitations.push("A fonte não comprova disponibilidade, assinatura criptográfica ou autorização do XML.");
  } else if (entity === "receivables" || entity === "payables") {
    use("valor", "saldo", "situacao", "dataEmissao", "vencimento", "dataVencimento", "contato", "historico");
    fields.amount = observedDecimal(p.valor); fields.open_balance = observedDecimal(p.saldo);
    fields.status = observedText(object(p.situacao) ? p.situacao.id : p.situacao, 80);
    fields.issue_date = observedDate(p.dataEmissao); fields.due_date = observedDate(own(p, "dataVencimento") ? p.dataVencimento : p.vencimento);
    fields.description = observedText(p.historico); fields.settlements = unknownValue(); fields.reconciled = false;
    ref("contacts", atPath(p, ["contato", "id"]), "/contato/id");
    coverage.limitations.push("Saldo ausente não é zero; o título observado não reconstrói baixas ou saldo bancário.");
  } else if (entity === "products" || entity === "contacts" || entity === "warehouses") {
    use("nome", "descricao", "codigo", "situacao", "preco", "unidade");
    fields.name = observedText(own(p, "nome") ? p.nome : p.descricao, 200); fields.code = observedText(p.codigo, 100);
    fields.status_observed = observedText(p.situacao, 80); fields.unit = observedText(p.unidade, 16);
    if (entity === "products") { fields.price = observedDecimal(p.preco); fields.product_status = productStatus(record); }
  } else coverage.limitations.push("Bruto preservado sem interpretação operacional para este recurso.");
  if (captureState !== "bound" && captureProfiles[entity]) coverage.limitations.push("A evidência lexical não está confirmada para esta versão.");
  const unmapped = Object.keys(p).filter(key => !mapped.has(key));
  // Marcar um objeto conhecido não esconde campos filhos que o mapper não usa.
  const knownNested = /^\/(?:situacao\/id|contato\/(?:id|nome)|notaFiscal\/id|desconto\/valor|transporte\/frete|produto\/id|itens\/\d+\/(?:produto\/id|codigo|descricao|unidade|quantidade|valor|desconto|valorLista|total)|parcelas\/\d+\/(?:dataVencimento|data|valor|observacoes)|depositos\/\d+\/(?:id|saldoFisico|saldoVirtual)|(?:pecas|servicos)\/\d+\/(?:descricao|quantidade|horas|valorUnitario|total|desconto))$/;
  const visit = (value: JsonValue, path: (string | number)[]) => {
    if (unmapped.length >= 10_000) return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, [...path, index])); return; }
    if (object(value)) { Object.entries(value).forEach(([key, child]) => visit(child, [...path, key])); return; }
    const location = pointer(path); if (!knownNested.test(location)) unmapped.push(location);
  };
  for (const [key, value] of Object.entries(p)) if (key !== "_brufap_source" && mapped.has(key) && (object(value) || Array.isArray(value))) visit(value, [key]);
  fields.references_truncated = referenceLimit; fields.unmapped_fields_truncated = unmapped.length >= 10_000;
  if (referenceLimit || unmapped.length >= 10_000) coverage.limitations.push("O resumo atingiu seu limite; consulte o bruto preservado para os demais campos e referências.");
  return { label: "Consulta histórica — não opera no ERP", kind: entity, fields, unresolved_references: references, unmapped_fields: unmapped.slice(0, 10_000).sort(), coverage };
}
