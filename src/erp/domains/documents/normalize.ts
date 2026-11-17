// Documentos (erp_documents): a validação de entrada do erp_document_save.
// Portado de erp_documents.normalize, normalize_core, extension_data,
// extension_keys, commercial_data, commercial_reference, has_commercial_data,
// installment_details, optional_amount, payment_types, rich_text,
// delivery_address, custom_field_value e check_custom_fields.
//
// O que o Postgres faz e o porte segue:
// - p_body->'k' de chave ausente é NULL do SQL (aqui undefined); o jsonb null é
//   null. coalesce(p_body->'k', '"0"') só troca o ausente.
// - A ordem das recusas é a ordem de avaliação do PL/pgSQL: argumentos da
//   esquerda para a direita, OR com curto-circuito, jsonb_each na ordem das
//   chaves do jsonb (tamanho, depois bytes).
// - Conta numeric exata (BigInt) com a escala de exibição do numeric; a divisão
//   usa a escala de select_div_scale do Postgres antes do round(…, 2).
// - Limite do motor: o corpo chega por JSON.parse, então 1.0 vira 1 (o
//   b->>'indent' e o r->>'size' do texto rico aceitam aqui o que o Postgres
//   recusa como texto "1.0"). Declarado em schema/structural.ts, "numero-json".
import type { SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgUpper } from "../../engine/text.ts";
import { unitPrice, unitPriceNumeric } from "../catalog/public.ts";
import { dateValue, decimalValue, textValue, uuidValue } from "./internal.ts";
import { transitions } from "./preferences.ts";

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

// Tipo explícito: só assim o TypeScript entende que a chamada não volta (estreita o tipo depois dela).
const bad: (message: string) => never = (message) => raise("22023", message);
const isObject = (v: unknown): v is Json => jsonType(v) === "object";
const has = (v: Json, k: string) => Object.prototype.hasOwnProperty.call(v, k);
/** v->'k': undefined quando v não é objeto ou não tem a chave (NULL do SQL). */
const get = (v: unknown, k: string): unknown => (isObject(v) && has(v, k) ? v[k] : undefined);
/** v->>'k' */
const getText = (v: unknown, k: string): string | null => {
  const x = get(v, k);
  return x === undefined || x === null ? null : typeof x === "string" ? x : jsonbText(x);
};
/** (select count(*) from jsonb_object_keys(v)) = n and v ?& keys */
const exactKeys = (v: Json, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => has(v, k));
const allowedKeys = (v: Json, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
const without = (v: Json, keys: string[]) => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
const utf8 = new TextEncoder();
const octets = (v: unknown) => utf8.encode(jsonbText(v)).length;
const multilineCntrl = (s: string) => pgHasCntrl.test(s.replace(/[\n\r\t]/g, ""));
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// numeric do Postgres: valor × 10^-escala, com a escala de exibição (dscale).

type Num = { v: bigint; s: number };
const ZERO: Num = { v: 0n, s: 0 };
const pow10 = (n: number) => 10n ** BigInt(n);
function num(text: string): Num {
  const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new RangeError(`Decimal inválido: ${text}`);
  const frac = m[3] ?? "";
  const v = BigInt(m[2] + frac);
  return { v: m[1] ? -v : v, s: frac.length };
}
const align = (a: Num, s: number) => a.v * pow10(s - a.s);
const add = (a: Num, b: Num): Num => {
  const s = Math.max(a.s, b.s);
  return { v: align(a, s) + align(b, s), s };
};
const sub = (a: Num, b: Num): Num => add(a, { v: -b.v, s: b.s });
const mul = (a: Num, b: Num): Num => ({ v: a.v * b.v, s: a.s + b.s });
const cmp = (a: Num, b: Num) => {
  const s = Math.max(a.s, b.s);
  const x = align(a, s),
    y = align(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
};
/** Divide arredondando metade para longe do zero. */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n,
    b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return neg ? -q : q;
}
/** round(a, s) */
const round = (a: Num, s: number): Num =>
  s >= a.s ? { v: align(a, s), s } : { v: divRound(a.v, pow10(a.s - s)), s };
/** Peso e primeiro dígito na base 10000 (como o NumericVar do Postgres). */
function nbase(a: Num): [number, bigint] {
  if (a.v === 0n) return [0, 0n];
  const abs = a.v < 0n ? -a.v : a.v;
  const w = Math.floor((abs.toString().length - 1 - a.s) / 4);
  const shift = a.s + 4 * w;
  return [w, shift >= 0 ? abs / pow10(shift) : abs * pow10(-shift)];
}
/** a / b do numeric: escala de select_div_scale, arredondada. */
function div(a: Num, b: Num): Num {
  if (b.v === 0n) raise("22012", "division by zero");
  const [w1, f1] = nbase(a);
  const [w2, f2] = nbase(b);
  let qweight = w1 - w2;
  if (f1 <= f2) qweight--;
  const s = Math.min(Math.max(16 - qweight * 4, a.s, b.s, 0), 1000);
  return { v: divRound(a.v * pow10(b.s + s), b.v * pow10(a.s)), s };
}
/** ::numeric(p,s)::text */
function fixed(a: Num, s: number): string {
  const r = round(a, s);
  const neg = r.v < 0n;
  const digits = (neg ? -r.v : r.v).toString().padStart(s + 1, "0");
  return (neg ? "-" : "") + (s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits);
}
const LIMIT = num("999999999999.99");
const HUNDRED = num("100");
const decimal = (value: unknown, precision: number, digits: number) => num(decimalValue(value, precision, digits));

// ---------------------------------------------------------------------------
// Listas fixas

/** erp_documents.extension_keys() */
export const extensionKeys = (): string[] => [
  "ship_date", "finish_date", "start_time", "end_time", "customer_po_number", "quote_requested", "quoted", "warranty_days",
  "warranty_months", "warranty_info", "reception_notes", "template_name", "delivery_address", "order_reference", "seller_id",
  "category_id", "carrier_id", "price_list_id", "payment_account_id", "payment_means", "payment_indicator",
  "other_items", "commercial_conditions",
];

/** erp_documents.payment_types() */
export const paymentTypes = (): string[] => [
  "01", "02", "03", "04", "05", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "90", "91", "99",
];

// ---------------------------------------------------------------------------
// Partes do corpo

/** erp_documents.optional_amount(valor): texto numeric(18,2) ou null. */
export function optionalAmount(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return fixed(decimal(value, 2, 12), 2);
}

/** erp_documents.commercial_reference(v): {system:'origin', source_id, label} ou null. */
export function commercialReference(v: unknown): Json | null {
  if (v === null) return null;
  if (
    !isObject(v) ||
    !exactKeys(v, ["system", "source_id", "label"]) ||
    v.system !== "origin" ||
    jsonType(v.source_id) !== "string" ||
    !/^[1-9][0-9]{0,39}$/.test(v.source_id as string)
  )
    bad("erp_document_reference_invalid");
  const r = v as Json;
  return { system: "origin", source_id: r.source_id, label: textValue(r.label, 200) };
}

const TRANSPORT = ["freight_mode", "volume_count", "gross_weight", "delivery_days", "carrier_reference", "service_reference", "tracking_code"];
const COMMERCIAL = ["introduction", "attention_to", "seller_reference", "store_reference", "business_unit_reference", "transport"];

/** erp_documents.commercial_data(v): o bloco comercial (apresentação, referências e transporte). */
export function commercialData(v: unknown): Json | null {
  if (v === null) return null;
  if (!isObject(v) || !exactKeys(v, COMMERCIAL)) bad("erp_document_commercial_fields_invalid");
  const c = v as Json;
  const t = c.transport;
  let transport: Json | null = null;
  if (t !== null) {
    if (!isObject(t) || !exactKeys(t, TRANSPORT)) bad("erp_document_transport_fields_invalid");
    const x = t as Json;
    if (x.freight_mode !== null && (jsonType(x.freight_mode) !== "string" || !["0", "1", "2", "3", "4", "9"].includes(x.freight_mode as string)))
      bad("erp_document_freight_mode_invalid");
    if (x.delivery_days !== null && (jsonType(x.delivery_days) !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(x.delivery_days as string)))
      bad("erp_document_delivery_days_invalid");
    const volume = x.volume_count === null ? null : fixed(decimal(x.volume_count, 6, 12), 6);
    const weight = x.gross_weight === null ? null : fixed(decimal(x.gross_weight, 6, 12), 6);
    transport = {
      freight_mode: x.freight_mode,
      volume_count: volume,
      gross_weight: weight,
      delivery_days: x.delivery_days,
      carrier_reference: commercialReference(x.carrier_reference),
      service_reference: commercialReference(x.service_reference),
      tracking_code: textValue(x.tracking_code, 200),
    };
  }
  return {
    introduction: textValue(c.introduction, 4000, false, true),
    attention_to: textValue(c.attention_to, 200),
    seller_reference: commercialReference(c.seller_reference),
    store_reference: commercialReference(c.store_reference),
    business_unit_reference: commercialReference(c.business_unit_reference),
    transport,
  };
}

/** erp_documents.has_commercial_data(corpo): bloco comercial, descrição detalhada ou nota/referência de parcela. */
export function hasCommercialData(v: unknown): boolean {
  if (get(v, "commercial") !== undefined && get(v, "commercial") !== null) return true;
  const list = (x: unknown): unknown[] => {
    const a = x === undefined ? [] : x;
    if (jsonType(a) !== "array") bad(`cannot extract elements from ${jsonType(a) === "object" ? "an object" : "a scalar"}`);
    return a as unknown[];
  };
  const filled = (x: unknown, k: string) => get(x, k) !== undefined && get(x, k) !== null;
  if (list(get(v, "items")).some((i) => filled(i, "detailed_description"))) return true;
  return list(get(v, "installments")).some((p) => filled(p, "note") || filled(p, "payment_reference"));
}

const COLOR = /^#[0-9a-f]{6}$/;
const SIZES = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36"];
const textOf = (v: unknown) => (typeof v === "string" ? v : jsonbText(v));

/** erp_documents.rich_text(valor): o texto rico validado, como veio, ou null. */
export function richText(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const invalid = () => bad("erp_document_rich_text_invalid");
  const p = value as Json;
  if (
    !isObject(value) ||
    !exactKeys(p, ["version", "blocks"]) ||
    p.version !== 1 ||
    jsonType(p.blocks) !== "array" ||
    (p.blocks as unknown[]).length > 200
  )
    invalid();
  let runs = 0,
    chars = 0;
  for (const b of p.blocks as unknown[]) {
    const x = b as Json;
    if (
      !isObject(b) ||
      !exactKeys(x, ["align", "indent", "code", "runs"]) ||
      jsonType(x.align) !== "string" ||
      !["left", "center", "right", "justify"].includes(x.align as string) ||
      jsonType(x.indent) !== "number" ||
      !/^[0-5]$/.test(textOf(x.indent)) ||
      jsonType(x.code) !== "boolean" ||
      jsonType(x.runs) !== "array"
    )
      invalid();
    for (const r of x.runs as unknown[]) {
      const y = r as Json;
      if (
        !isObject(r) ||
        !exactKeys(y, ["text", "bold", "italic", "underline", "color", "background", "size"]) ||
        jsonType(y.text) !== "string" ||
        y.text === "" ||
        /[\x01-\x1f\x7f]/.test(y.text as string) ||
        jsonType(y.bold) !== "boolean" ||
        jsonType(y.italic) !== "boolean" ||
        jsonType(y.underline) !== "boolean" ||
        (y.color !== null && (jsonType(y.color) !== "string" || !COLOR.test(y.color as string))) ||
        (y.background !== null && (jsonType(y.background) !== "string" || !COLOR.test(y.background as string))) ||
        (y.size !== null && (jsonType(y.size) !== "number" || !SIZES.includes(textOf(y.size))))
      )
        invalid();
      runs++;
      chars += pgLength(y.text as string);
    }
  }
  if (runs > 1000 || chars > 20000) invalid();
  return value;
}

const ADDRESS = ["name", "postal_code", "state", "city", "district", "street", "number", "complement", "country"];
const STATES = /^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;

/** erp_documents.delivery_address(v): o endereço de entrega validado ou null. */
export function deliveryAddress(v: unknown): Json | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v) || !exactKeys(v, ADDRESS)) bad("erp_document_delivery_address_invalid");
  const a = v as Json;
  let postal = textValue(a.postal_code, 9);
  if (postal !== null) {
    if (!/^[0-9]{5}-?[0-9]{3}$/.test(postal)) bad("erp_document_delivery_address_invalid");
    postal = postal.replace(/-/g, "");
  }
  const stateText = textValue(a.state, 2);
  const state = stateText === null ? null : pgUpper(stateText);
  if (state !== null && !STATES.test(state)) bad("erp_document_delivery_address_invalid");
  const result = {
    name: textValue(a.name, 120),
    postal_code: postal,
    state,
    city: textValue(a.city, 100),
    district: textValue(a.district, 100),
    street: textValue(a.street, 100),
    number: textValue(a.number, 30),
    complement: textValue(a.complement, 100),
    country: textValue(a.country, 60),
  };
  if (result.street === null || result.city === null) bad("erp_document_delivery_address_invalid");
  return result;
}

const DETAILS = ["account_id", "payment_type", "card_brand", "integration_type", "acquirer_cnpj", "authorization_code", "received_amount", "fee_amount", "commission_fee_amount"];
const CARD_BRANDS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "99"];

/** erp_documents.installment_details(tipo, valor, valor da parcela como texto numeric): os detalhes do pagamento da parcela ou null. */
export function installmentDetails(kind: string | null, value: unknown, amount: string | null): Json | null {
  if (value === undefined || value === null) return null;
  const invalid = () => bad("erp_document_installment_details_invalid");
  const p = value as Json;
  if (kind === "sales_proposals" || !isObject(value) || !allowedKeys(p, DETAILS) || !DETAILS.every((k) => has(p, k))) invalid();
  for (const k of ["payment_type", "card_brand", "integration_type", "acquirer_cnpj", "authorization_code"])
    if (p[k] !== null && jsonType(p[k]) !== "string") invalid();
  const s = (k: string) => p[k] as string | null;
  if (
    (s("payment_type") !== null && !paymentTypes().includes(s("payment_type")!)) ||
    (s("card_brand") !== null && !CARD_BRANDS.includes(s("card_brand")!)) ||
    (s("integration_type") !== null && !["1", "2"].includes(s("integration_type")!)) ||
    (s("acquirer_cnpj") !== null && !/^[A-Z0-9]{12}[0-9]{2}$/.test(s("acquirer_cnpj")!)) ||
    (s("authorization_code") !== null && !/^[A-Za-z0-9./-]{1,128}$/.test(s("authorization_code")!))
  )
    invalid();
  const result: Json = {
    account_id: uuidValue(p.account_id),
    payment_type: p.payment_type,
    card_brand: p.card_brand,
    integration_type: p.integration_type,
    acquirer_cnpj: p.acquirer_cnpj,
    authorization_code: p.authorization_code,
    received_amount: optionalAmount(p.received_amount),
    fee_amount: optionalAmount(p.fee_amount),
    commission_fee_amount: optionalAmount(p.commission_fee_amount),
  };
  // (v_result->>x)::numeric > p_amount: com p_amount nulo a comparação é nula e não recusa.
  if (amount !== null)
    for (const k of ["received_amount", "fee_amount", "commission_fee_amount"])
      if (result[k] !== null && cmp(num(result[k] as string), num(amount)) > 0) invalid();
  return result;
}

/** erp_documents.extension_data(corpo): os campos de extensão presentes, validados. */
export function extensionData(body: unknown): Json {
  const result: Json = {};
  // p_body?k: chave do objeto, texto da lista ou o próprio texto escalar; com o
  // corpo NULL do SQL é nulo, e "if not NULL then continue" não pula. Fora do
  // objeto, p_body->k é NULL do SQL (undefined) e v<>'null' fica nulo (não recusa).
  const hasKey = (k: string) =>
    body === undefined || (isObject(body) ? has(body, k) : Array.isArray(body) ? body.includes(k) : body === k);
  for (const k of extensionKeys()) {
    if (!hasKey(k)) continue;
    let v: unknown = get(body, k);
    const given = v !== null && v !== undefined;
    if (k === "ship_date" || k === "finish_date") v = dateValue(v);
    else if (k === "start_time" || k === "end_time") {
      if (given && (jsonType(v) !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v as string))) bad("erp_document_time_invalid");
    } else if (k === "quote_requested" || k === "quoted") {
      if (given && jsonType(v) !== "boolean") bad("erp_document_flag_invalid");
    } else if (k === "warranty_days") {
      if (given && (jsonType(v) !== "string" || !/^(0|[1-9][0-9]{0,3})$/.test(v as string))) bad("erp_document_warranty_invalid");
    } else if (k === "warranty_months") {
      if (given && (jsonType(v) !== "string" || !/^(0|[1-9][0-9]{0,2})$/.test(v as string))) bad("erp_document_warranty_invalid");
    } else if (k === "customer_po_number") v = textValue(v, 60);
    else if (k === "template_name") v = textValue(v, 120);
    else if (k === "order_reference") v = textValue(v, 100);
    else if (k === "warranty_info" || k === "reception_notes") v = textValue(v, 4000, false, true);
    else if (k === "delivery_address") v = deliveryAddress(v);
    else if (["seller_id", "category_id", "carrier_id", "price_list_id", "payment_account_id"].includes(k)) v = uuidValue(v);
    else if (k === "payment_means") {
      if (given && (jsonType(v) !== "string" || !paymentTypes().includes(v as string))) bad("erp_document_payment_invalid");
    } else if (k === "payment_indicator") {
      if (given && (jsonType(v) !== "string" || !["0", "1"].includes(v as string))) bad("erp_document_payment_invalid");
    } else if (k === "other_items") {
      if (given) {
        if (!isObject(v) || !exactKeys(v, ["content", "total"])) bad("erp_document_other_items_invalid");
        const o = v as Json;
        v = { content: richText(o.content), total: fixed(decimal(o.total, 2, 12), 2) };
      }
    } else if (k === "commercial_conditions") {
      if (given) {
        const o = v as Json;
        if (
          !isObject(v) ||
          !exactKeys(o, ["mode", "text"]) ||
          jsonType(o.mode) !== "string" ||
          !["none", "installments", "text"].includes(o.mode as string)
        )
          bad("erp_document_conditions_invalid");
        v = { mode: o.mode, text: richText(o.text) };
      }
    }
    result[k] = v ?? null;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Campos customizados (leem o banco)

/** erp_documents.custom_field_value(campo, valor): o valor do campo customizado validado pelo tipo, ou null. */
export function customFieldValue(field: Row, value: string | null): string | null {
  const v = value;
  if (v === null || v === "") return null;
  const invalid = () => bad("erp_document_custom_field_invalid");
  const type = field.field_type as string;
  if ((type === "text" || type === "long_text") && v !== pgBtrim(v)) invalid();
  if (type === "integer") {
    if (!/^-?(0|[1-9][0-9]{0,17})$/.test(v) || v === "-0") invalid();
  } else if (type === "decimal") {
    if (!/^-?(0|[1-9][0-9]{0,14})(\.[0-9]{0,5}[1-9])?$/.test(v) || v === "-0") invalid();
  } else if (type === "text") {
    if (pgLength(v) > 255 || pgHasCntrl.test(v)) invalid();
  } else if (type === "long_text") {
    if (pgLength(v) > 4000 || multilineCntrl(v)) invalid();
  } else if (type === "boolean") {
    if (v !== "true" && v !== "false") invalid();
  } else if (type === "date") {
    // date_value(to_jsonb(v))::text<>v: data impossível recusa no date_value (erp_document_date_invalid).
    if (!/^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v) || dateValue(v) !== v) invalid();
  } else {
    const options = typeof field.options === "string" ? JSON.parse(field.options) : field.options;
    if (!UUID_LOWER.test(v) || !(options as unknown[]).some((o) => getText(o, "id") === v)) invalid();
  }
  const min = field.min_length as number | null,
    max = field.max_length as number | null;
  if ((min !== null && pgLength(v) < min) || (max !== null && pgLength(v) > max)) invalid();
  return v;
}

/** (texto)::uuid do Postgres: chaves, hífens entre grupos de 4 e maiúsculas aceitos. */
function uuidCast(text: string): string {
  const m = /^\{?([0-9a-fA-F]{4}-?){7}[0-9a-fA-F]{4}\}?$/.exec(text);
  if (!m || text.startsWith("{") !== text.endsWith("}")) raise("22P02", `invalid input syntax for type uuid: "${text}"`);
  const hex = text.replace(/[{}-]/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * erp_documents.check_custom_fields(tipo, valores, corpo anterior): valores contra as definições ativas e obrigatórias.
 * undefined é o NULL do SQL: valores undefined = nenhum campo; before undefined = sem documento anterior
 * (o null do jsonb em before conta como documento anterior sem campos, como no Postgres).
 */
export function checkCustomFields(db: SqlDriver, kind: string | null, values: unknown, before: unknown): void {
  const vals = values === undefined ? {} : values;
  if (!isObject(vals)) bad("cannot call jsonb_each on a non-object");
  for (const key of jsonbKeys(vals as Json)) {
    const raw = (vals as Json)[key];
    const text = raw === null ? null : textOf(raw);
    // where x.id=v_key::uuid and x.kind=p_kind: no oráculo (tabela pequena, varredura) o filtro de kind vem
    // antes do cast, então chave que não é uuid só dá 22P02 se existe campo do tipo. Com índice o cast viria
    // antes; a chave já chega validada pelo normalize, então isso só aparece chamando a função sozinha.
    const ofKind = kind !== null && db.exec('SELECT 1 x FROM "erp_documents__custom_field" WHERE kind=? LIMIT 1', kind).rows.length > 0;
    const field = ofKind ? db.exec('SELECT * FROM "erp_documents__custom_field" WHERE id=? AND kind=?', uuidCast(key), kind).rows[0] : undefined;
    if (!field) bad("erp_document_custom_field_invalid");
    const active = Number(field.active) === 1;
    if (!active && (before === undefined || getText(get(before, "custom_fields"), key) !== text))
      bad("erp_document_custom_field_inactive");
    if (active && customFieldValue(field, text) !== text) bad("erp_document_custom_field_invalid");
  }
  const required = db.exec(
    'SELECT id FROM "erp_documents__custom_field" WHERE kind=? AND active=1 AND required=1',
    kind,
  ).rows;
  if (required.some((f) => (getText(values, String(f.id)) ?? "") === "")) bad("erp_document_custom_field_required");
}

// ---------------------------------------------------------------------------
// O corpo

const CORE_FIELDS = [
  "date", "contact_id", "warehouse_id", "expected_date", "valid_until", "next_contact", "template", "items", "discount_mode",
  "discount_value", "freight", "other_expenses", "installments", "notes", "internal_notes", "payment_terms", "delivery_terms",
  "equipment", "serial_number", "technician", "defect", "solution", "commercial",
];
const CORE_ITEM = ["id", "product_id", "description", "code", "unit", "quantity", "unit_price", "discount_percent", "detailed_description"];
// jsonb_each('{"notes":4000,…}'): a ordem das chaves do jsonb.
const TEXT_FIELDS: [string, number][] = [
  ["notes", 4000], ["defect", 4000], ["solution", 4000], ["equipment", 200], ["technician", 200],
  ["payment_terms", 4000], ["serial_number", 100], ["delivery_terms", 2000], ["internal_notes", 4000],
];
const MULTILINE = ["notes", "internal_notes", "payment_terms", "delivery_terms", "defect", "solution"];
const SERVICE_FIELDS = ["equipment", "serial_number", "technician", "defect", "solution"];
const BODY_LIMIT = 262144;
const orZero = (v: unknown) => (v === undefined ? "0" : v);

/** erp_documents.normalize_core(tipo, corpo): itens, desconto, frete, parcelas, textos e comercial, com os totais. */
export function normalizeCore(kind: string | null, body: unknown): Json {
  const b = body as Json;
  if (
    kind === null ||
    !has(transitions(), kind) ||
    !isObject(body) ||
    octets(body) > BODY_LIMIT ||
    jsonType(b.items) !== "array" ||
    (b.items as unknown[]).length > 250 ||
    ((b.items as unknown[]).length === 0 && kind !== "service_orders")
  )
    bad("erp_document_body_invalid");
  if (!allowedKeys(b, CORE_FIELDS)) bad("erp_document_unknown_field");
  if ((has(b, "template") && jsonType(b.template) !== "boolean") || (b.template === true && kind !== "sales_proposals"))
    bad("erp_document_template_invalid");
  const seen = new Set<string>();
  const items: Json[] = [];
  const totalsItems: Json[] = [];
  let gross: Num = ZERO,
    lineDiscount: Num = ZERO,
    i = 0;
  for (const item of b.items as unknown[]) {
    const it = item as Json;
    if (!isObject(item) || !allowedKeys(it, CORE_ITEM)) bad("erp_document_item_invalid");
    const id = uuidValue(it.id);
    if (id !== null && seen.has(id)) bad("erp_document_item_duplicate");
    if (id !== null) seen.add(id);
    const qty = decimal(it.quantity, 6, 9);
    const priceText = unitPrice(it.unit_price, 10);
    const price = num(priceText);
    const percent = decimal(orZero(it.discount_percent), 4, 3);
    if (qty.v <= 0n || cmp(percent, HUNDRED) > 0) bad("erp_document_item_value_invalid");
    const base = round(mul(qty, price), 2);
    const itemDiscount = round(div(mul(base, percent), HUNDRED), 2);
    gross = add(gross, base);
    lineDiscount = add(lineDiscount, itemDiscount);
    i++;
    if (cmp(gross, LIMIT) > 0) bad("erp_document_total_limit");
    const row = { gross: fixed(base, 2), discount: fixed(itemDiscount, 2), total: fixed(sub(base, itemDiscount), 2) };
    totalsItems.push(row);
    const out: Json = {
      ...row,
      id,
      product_id: uuidValue(it.product_id),
      description: textValue(it.description, 200, true),
      code: textValue(it.code, 100),
      unit: textValue(it.unit, 16, true),
      quantity: fixed(qty, 6),
      unit_price: unitPriceNumeric(priceText, 10),
      discount_percent: fixed(percent, 4),
      position: i,
    };
    if (has(it, "detailed_description")) out.detailed_description = textValue(it.detailed_description, 4000, false, true);
    items.push(out);
  }
  const subtotal = sub(gross, lineDiscount);
  const mode = textValue(b.discount_mode, 10) ?? "amount";
  if (mode !== "amount" && mode !== "percent") bad("erp_document_discount_mode_invalid");
  let value: Num, discount: Num;
  if (mode === "percent") {
    value = decimal(orZero(b.discount_value), 4, 3);
    if (cmp(value, HUNDRED) > 0) bad("erp_document_percent_invalid");
    discount = round(div(mul(subtotal, value), HUNDRED), 2);
  } else {
    value = decimal(orZero(b.discount_value), 2, 12);
    discount = value;
  }
  if (cmp(discount, subtotal) > 0) bad("erp_document_discount_exceeds_subtotal");
  const freight = decimal(orZero(b.freight), 2, 12);
  const other = decimal(orZero(b.other_expenses), 2, 12);
  const total = add(add(sub(subtotal, discount), freight), other);
  if (cmp(total, LIMIT) > 0) bad("erp_document_total_limit");
  if (has(b, "installments") && (jsonType(b.installments) !== "array" || (b.installments as unknown[]).length > 120))
    bad("erp_document_installments_invalid");
  const installments: Json[] = [];
  let installmentTotal: Num = ZERO;
  for (const p of (b.installments ?? []) as unknown[]) {
    const x = p as Json;
    if (!isObject(p) || !allowedKeys(x, ["due_date", "amount", "method", "note", "payment_reference"])) bad("erp_document_installment_invalid");
    const amount = decimal(x.amount, 2, 12);
    if (amount.v <= 0n) bad("erp_document_installment_invalid");
    installmentTotal = add(installmentTotal, amount);
    const out: Json = {
      position: installments.length + 1,
      due_date: dateValue(x.due_date, true),
      amount: fixed(amount, 2),
      method: textValue(x.method, 100),
    };
    if (has(x, "note")) out.note = textValue(x.note, 2000, false, true);
    if (has(x, "payment_reference")) out.payment_reference = commercialReference(x.payment_reference);
    installments.push(out);
  }
  if (installments.length > 0 && cmp(installmentTotal, total) !== 0) bad("erp_document_installment_total_mismatch");
  const result: Json = {
    date: dateValue(b.date, true),
    contact_id: uuidValue(b.contact_id, true),
    warehouse_id: uuidValue(b.warehouse_id),
    expected_date: dateValue(b.expected_date),
    valid_until: dateValue(b.valid_until),
    next_contact: dateValue(b.next_contact),
    template: b.template ?? false,
    items,
    discount_mode: mode,
    discount_value: mode === "percent" ? fixed(value, 4) : fixed(value, 2),
    freight: fixed(freight, 2),
    other_expenses: fixed(other, 2),
    installments,
    totals: {
      items: totalsItems,
      gross: fixed(gross, 2),
      line_discount: fixed(lineDiscount, 2),
      subtotal: fixed(subtotal, 2),
      discount: fixed(discount, 2),
      freight: fixed(freight, 2),
      other_expenses: fixed(other, 2),
      total: fixed(total, 2),
    },
  };
  for (const [key, max] of TEXT_FIELDS) {
    if (kind !== "service_orders" && SERVICE_FIELDS.includes(key) && textValue(b[key], 4000) !== null)
      bad("erp_document_service_field_invalid");
    result[key] = textValue(b[key], max, false, MULTILINE.includes(key));
  }
  if (has(b, "commercial")) {
    const commercial = commercialData(b.commercial);
    result.commercial = commercial;
    const transport = commercial === null ? null : (commercial.transport as Json | null);
    if (transport !== null && transport.freight_mode === "9" && freight.v !== 0n) bad("erp_document_transport_conflict");
  }
  return result;
}

const EXTRA_BODY = ["installments", "tax_ipi", "tax_icms_st", "equipment", "custom_fields"];
const EXTRA_ITEM = ["list_price", "supplier_code", "group", "quote", "done", "lots", "warranty_days", "ipi_rate"];
const INSTALLMENT = ["due_date", "amount", "method", "note", "payment_reference", "payment_method_id", "details"];

/** erp_documents.normalize(tipo, corpo): o corpo do documento validado e normalizado, com totais e parcelas. */
export function normalize(kind: string | null, body: unknown): Json {
  if (!isObject(body) || octets(body) > BODY_LIMIT) bad("erp_document_body_invalid");
  const b = body as Json;
  const core = without(b, [...extensionKeys(), ...EXTRA_BODY]);
  if (jsonType(b.items) === "array")
    core.items = (b.items as unknown[]).map((i) => (isObject(i) ? without(i, EXTRA_ITEM) : i));
  let result: Json = { ...normalizeCore(kind, core), ...extensionData(b) };
  if (kind !== "service_orders" && textValue(b.equipment, 4000, false, true) !== null) bad("erp_document_service_field_invalid");
  result.equipment = textValue(b.equipment, 4000, false, true);
  const present = (k: string) => result[k] !== undefined && result[k] !== null;
  if (kind !== "sales_proposals" && (present("other_items") || present("commercial_conditions"))) bad("erp_document_other_items_invalid");
  if (kind === "purchase_orders" && present("price_list_id")) bad("erp_document_price_list_invalid");
  if (
    (kind === "sales_proposals" && present("payment_account_id")) ||
    (kind !== "sales_orders" && (present("payment_means") || present("payment_indicator")))
  )
    bad("erp_document_payment_invalid");
  const items: Json[] = [];
  let itemIpi: Num = ZERO,
    rated = false;
  (b.items as unknown[]).forEach((item, n) => {
    const it = item as Json;
    const out: Json = { ...((result.items as Json[])[n] ?? {}) };
    if (has(it, "list_price"))
      out.list_price = it.list_price === null ? null : unitPriceNumeric(unitPrice(it.list_price, 10), 10);
    if (has(it, "supplier_code")) {
      const code = textValue(it.supplier_code, 100);
      if (code !== null && kind !== "purchase_orders") bad("erp_document_supplier_code_invalid");
      out.supplier_code = code;
    }
    if (has(it, "group") || has(it, "quote") || has(it, "done")) {
      if (
        kind !== "service_orders" ||
        (has(it, "group") && !["part", "service"].includes(getText(it, "group") ?? "")) ||
        (has(it, "quote") && jsonType(it.quote) !== "boolean") ||
        (has(it, "done") && jsonType(it.done) !== "boolean") ||
        ((it.quote === true || it.done === true) && getText(it, "group") !== "service")
      )
        bad("erp_document_item_group_invalid");
      if (has(it, "group")) out.group = getText(it, "group");
      if (has(it, "quote")) out.quote = it.quote;
      if (has(it, "done")) out.done = it.done;
    }
    if (has(it, "lots") && it.lots !== null) {
      const lots = it.lots as unknown[];
      if (!["sales_orders", "service_orders"].includes(kind!) || jsonType(lots) !== "array" || lots.length > 50)
        bad("erp_document_item_lots_invalid");
      if (lots.length > 0) {
        if (getText(out, "product_id") === null || (kind === "service_orders" && getText(it, "group") === "service"))
          bad("erp_document_item_lots_invalid");
        const list: Json[] = [];
        const seenLots = new Set<string>();
        let sum: Num = ZERO;
        for (const lot of lots) {
          const l = lot as Json;
          if (!isObject(lot) || !exactKeys(l, ["lot_id", "quantity"])) bad("erp_document_item_lots_invalid");
          const lotId = uuidValue(l.lot_id, true)!;
          if (seenLots.has(lotId)) bad("erp_document_item_lots_invalid");
          seenLots.add(lotId);
          const qty = decimal(l.quantity, 6, 9);
          if (qty.v <= 0n) bad("erp_document_item_lots_invalid");
          sum = add(sum, qty);
          list.push({ lot_id: lotId, quantity: fixed(qty, 6) });
        }
        if (cmp(sum, num(getText(out, "quantity")!)) !== 0) bad("erp_document_item_lots_quantity");
        out.lots = list;
      }
    }
    if (has(it, "warranty_days") && it.warranty_days !== null) {
      if (kind !== "service_orders" || jsonType(it.warranty_days) !== "string" || !/^(0|[1-9][0-9]{0,3})$/.test(it.warranty_days as string))
        bad("erp_document_warranty_invalid");
      out.warranty_days = it.warranty_days;
    }
    if (has(it, "ipi_rate") && it.ipi_rate !== null) {
      if (kind !== "purchase_orders") bad("erp_document_tax_invalid");
      const rate = decimal(it.ipi_rate, 4, 3);
      if (cmp(rate, HUNDRED) > 0) bad("erp_document_tax_invalid");
      out.ipi_rate = fixed(rate, 4);
      itemIpi = add(itemIpi, round(div(mul(num(getText(out, "total")!), rate), HUNDRED), 2));
      rated = true;
    }
    items.push(out);
  });
  result.items = items;
  if (has(b, "custom_fields") && b.custom_fields !== null) {
    const cf = b.custom_fields as Json;
    if (kind !== "service_orders" || !isObject(cf) || Object.keys(cf).length > 60) bad("erp_document_custom_field_invalid");
    const fields: Json = {};
    for (const key of jsonbKeys(cf)) {
      const v = cf[key];
      const text = v === null ? null : textOf(v);
      if (
        !UUID_LOWER.test(key) ||
        (v !== null && jsonType(v) !== "string") ||
        (text !== null && pgLength(text) > 4000) ||
        multilineCntrl(text ?? "")
      )
        bad("erp_document_custom_field_invalid");
      if ((text ?? "") !== "") fields[key] = text;
    }
    if (Object.keys(fields).length > 0) result.custom_fields = fields;
  }
  let ipi: Num = ZERO,
    st: Num = ZERO;
  if (has(b, "tax_ipi")) ipi = decimal(b.tax_ipi, 2, 12);
  if (has(b, "tax_icms_st")) st = decimal(b.tax_icms_st, 2, 12);
  if (rated) ipi = itemIpi;
  else if (kind === "purchase_orders" && ipi.v !== 0n) bad("erp_document_tax_invalid");
  const totals = result.totals as Json;
  const otherItems = result.other_items as Json | null | undefined;
  const otherTotal = otherItems ? num(otherItems.total as string) : ZERO;
  const total = add(add(add(num(totals.total as string), ipi), st), otherTotal);
  if (cmp(total, LIMIT) > 0) bad("erp_document_total_limit");
  if (has(b, "tax_ipi") || has(b, "tax_icms_st") || rated) {
    result.totals = { ...(result.totals as Json), ipi: fixed(ipi, 2), icms_st: fixed(st, 2), total: fixed(total, 2) };
    if (has(b, "tax_ipi") && !rated) result.tax_ipi = fixed(ipi, 2);
    if (has(b, "tax_icms_st")) result.tax_icms_st = fixed(st, 2);
  }
  if (otherItems) result.totals = { ...(result.totals as Json), other_items: otherItems.total, total: fixed(total, 2) };
  if (has(b, "installments") && (jsonType(b.installments) !== "array" || (b.installments as unknown[]).length > 120))
    bad("erp_document_installments_invalid");
  const installments: Json[] = [];
  let sum: Num = ZERO;
  for (const p of (b.installments ?? []) as unknown[]) {
    const x = p as Json;
    if (!isObject(p) || !allowedKeys(x, INSTALLMENT)) bad("erp_document_installment_invalid");
    const amount = decimal(x.amount, 2, 12);
    if (amount.v <= 0n) bad("erp_document_installment_invalid");
    sum = add(sum, amount);
    const out: Json = {
      position: installments.length + 1,
      due_date: dateValue(x.due_date, true),
      amount: fixed(amount, 2),
      method: textValue(x.method, 100),
    };
    if (has(x, "note")) out.note = textValue(x.note, 2000, false, true);
    if (has(x, "payment_reference")) out.payment_reference = commercialReference(x.payment_reference);
    if (has(x, "payment_method_id")) out.payment_method_id = uuidValue(x.payment_method_id);
    if (has(x, "details")) out.details = installmentDetails(kind, x.details, decimalValue(x.amount, 2, 12));
    installments.push(out);
  }
  if (installments.length > 0 && cmp(sum, total) !== 0) bad("erp_document_installment_total_mismatch");
  const conditions = result.commercial_conditions as Json | null | undefined;
  if (installments.length > 0 && conditions && (conditions.mode === "none" || conditions.mode === "text"))
    bad("erp_document_conditions_invalid");
  result = { ...result, installments };
  return result;
}
