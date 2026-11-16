// Catálogo (erp_catalog): funções internas e a camada de tabela (gatilhos)
// que erp_catalog.document_product alcança. Portado das migrações do Fagoo
// (versões finais no oráculo; fecho por scripts/erp/call-graph.mjs).
import { decText, formatScaled, fromColumn, toParam, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import * as preferences from "../preferences/public.ts";
import * as sync from "../sync/public.ts";

/** [[:cntrl:]] do Postgres em UTF-8 (C0, DEL e C1). */
const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
const btrim = (s: string) => s.replace(/^ +| +$/g, "");
const chars = (s: string) => [...s].length;

// ---------------------------------------------------------------------------
// Texto e números

const FOLD_FROM = "ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñÝŸýÿ";
const FOLD_TO = "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYYyy";

/** erp_catalog.fold: sem acento e minúsculo (coluna __fold dos índices). */
export function fold(value: string | null): string | null {
  if (value === null) return null;
  let out = "";
  for (const ch of value) {
    const i = FOLD_FROM.indexOf(ch);
    out += i >= 0 ? FOLD_TO[i] : ch;
  }
  return out.toLowerCase();
}

/** erp_catalog.unit_price(p_value jsonb, p_integers): preço com 4 ou 10 casas. */
export function unitPrice(value: unknown, integers: number | null): string {
  if (integers === null || ![10, 14].includes(integers) || jsonType(value) !== "string")
    raise("22023", "erp_unit_price_invalid");
  const v = value as string;
  const shape = new RegExp(`^(0|[1-9][0-9]{0,${integers - 1}})(\\.[0-9]+)?$`);
  if (new TextEncoder().encode(v).length > 80 || !shape.test(v)) raise("22023", "erp_unit_price_invalid");
  const [whole, rest = ""] = v.split(".");
  const fraction = rest.replace(/0+$/, "");
  if (fraction.length > 10) raise("22023", "erp_unit_price_invalid");
  return `${whole}.${fraction.padEnd(fraction.length <= 4 ? 4 : 10, "0")}`;
}

/** trim_scale(numeric)::text */
const trimScale = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);

/** erp_catalog.unit_price_numeric(numeric, p_integers) */
export const unitPriceNumeric = (value: unknown, integers: number) =>
  value === null || value === undefined ? null : unitPrice(trimScale(String(value)), integers);

/** numeric(p,s)::text de coluna escalada (dec / dec_i64). */
const scaledText = (value: unknown, scale: number) =>
  value === null || value === undefined ? null : formatScaled(fromColumn(value), scale);

// ---------------------------------------------------------------------------
// Validação do jsonb de cadastro

const SPECS_BASE: Record<string, number> = { name: 200, code: 100 };
const SPECS: Record<string, Record<string, number>> = {
  contacts: {
    trade_name: 200, person_type: 1, document: 30, ie: 30, email: 254, phone: 40, mobile: 40, postal_code: 20,
    street: 200, number: 30, complement: 200, district: 100, city: 100, state: 2, roles: 0,
  },
  products: {
    unit: 16, price: 0, kind: 1, format: 1, description: 4000, ncm: 8, gtin: 14, brand: 100, condition: 11,
    production: 11, net_weight: 0, gross_weight: 0, width: 0, height: 0, depth: 0, dimension_unit: 2, volumes: 0,
    items_per_box: 0, gtin_tax: 14, stock_min: 0, stock_max: 0, location: 100, cest: 7, origin: 1, additional_info: 2000,
  },
  warehouses: { description: 1000 },
};
const MEASURES = ["net_weight", "gross_weight", "width", "height", "depth", "stock_min", "stock_max"];
const COUNTS = ["volumes", "items_per_box"];
const ENUMS: Record<string, (v: string) => boolean> = {
  person_type: (v) => ["J", "F", "E"].includes(v),
  kind: (v) => ["P", "S", "N"].includes(v),
  format: (v) => ["S", "V", "E"].includes(v),
  condition: (v) => ["new", "used", "refurbished", "unspecified"].includes(v),
  production: (v) => ["own", "third_party"].includes(v),
  dimension_unit: (v) => ["m", "cm", "mm"].includes(v),
  origin: (v) => /^[0-8]$/.test(v),
};
const GTIN = /^([0-9]{8}|[0-9]{12,14})$/;

/**
 * erp_catalog.validate_data(p_entity, p_data, p_full): valida e normaliza o
 * jsonb do cadastro. Campos na ordem do jsonb (o primeiro erro é o mesmo).
 */
export function validateData(entity: string | null, data: unknown, full: boolean): Record<string, unknown> {
  if (
    entity === null ||
    !["contacts", "products", "warehouses"].includes(entity) ||
    data === null ||
    data === undefined ||
    jsonType(data) !== "object" ||
    new TextEncoder().encode(jsonbText(data)).length > 16384
  )
    raise("22023", "erp_catalog_invalid_data");
  const specs = { ...SPECS_BASE, ...SPECS[entity] };
  const input = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of jsonbKeys(input)) {
    const value = input[key];
    if (!(key in specs)) raise("22023", "erp_catalog_unknown_field");
    if (key === "roles") {
      if (
        jsonType(value) !== "array" ||
        (value as unknown[]).length > 3 ||
        (value as unknown[]).some((a) => jsonType(a) !== "string" || !["customer", "supplier", "carrier"].includes(a as string))
      )
        raise("22023", "erp_catalog_invalid_roles");
      result.roles = [...new Set(value as string[])].sort();
    } else if (key === "price") {
      result.price = value === null ? null : unitPrice(value, 14);
    } else if (MEASURES.includes(key)) {
      if (value !== null && (jsonType(value) !== "string" || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(value as string)))
        raise("22023", "erp_catalog_invalid_measure");
      result[key] = value === null ? null : formatScaled(toScaled(value as string, 6), 6);
    } else if (COUNTS.includes(key)) {
      if (value !== null && (jsonType(value) !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(value as string)))
        raise("22023", "erp_catalog_invalid_count");
      result[key] = value === null ? null : String(Number(value));
    } else {
      if (value !== null && jsonType(value) !== "string") raise("22023", "erp_catalog_text_required");
      const raw = value === null ? null : btrim(value as string);
      const text = raw === "" ? null : raw;
      if (text !== null) {
        const plain = ["description", "additional_info"].includes(key) ? text.replace(/[\n\r\t]/g, "") : text;
        if (chars(text) > specs[key] || CNTRL.test(plain)) raise("22023", "erp_catalog_invalid_text");
        if (ENUMS[key] && !ENUMS[key](text)) raise("22023", "erp_catalog_invalid_enum");
        if ((key === "gtin_tax" && text !== "SEM GTIN" && !GTIN.test(text)) || (key === "cest" && !/^[0-9]{7}$/.test(text)))
          raise("22023", "erp_catalog_invalid_identifier");
      }
      result[key] = text;
    }
  }
  if (full && (result.name === null || result.name === undefined || result.name === "")) raise("22023", "erp_catalog_name_required");
  if (full && entity === "contacts" && !("roles" in result)) result.roles = [];
  if (
    entity === "products" &&
    typeof result.stock_min === "string" &&
    typeof result.stock_max === "string" &&
    toScaled(result.stock_min, 6) > toScaled(result.stock_max, 6)
  )
    raise("22023", "erp_catalog_stock_metadata_range");
  return result;
}

/** erp_catalog.validate_product_identifiers(p_patch, p_previous) */
export function validateProductIdentifiers(patch: Record<string, unknown>, previous: Record<string, unknown> | null) {
  for (const k of ["ncm", "gtin"]) {
    if (!(k in patch) || jsonbText(patch[k]) === jsonbText(previous?.[k] ?? undefined)) continue;
    const v = patch[k] as string | null;
    // v !~ regex com v nulo é nulo: não lança.
    if (v === null) continue;
    if ((k === "ncm" && !/^[0-9]{8}$/.test(v)) || (k === "gtin" && v !== "SEM GTIN" && !GTIN.test(v)))
      raise("22023", "erp_catalog_invalid_identifier");
  }
}

/** erp_catalog.gtin_check_digit */
export function gtinCheckDigit(digits: string): string {
  let sum = 0;
  for (let i = 1; i <= digits.length; i++) sum += Number(digits[digits.length - i]) * (i % 2 === 1 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

/** erp_catalog.next_product_code(p_strict) */
export function nextProductCode(db: SqlDriver, strict: boolean): string | null {
  const mode = preferences.get(db, "produtos.codigo");
  const codes = (where: string, ...params: unknown[]) =>
    db
      .exec(`SELECT code FROM "erp_catalog__record" WHERE entity='products' AND code IS NOT NULL ${where}`, ...params)
      .rows.map((r) => String(r.code));
  if (mode === "sequencial") {
    let max = 0n;
    for (const c of codes("AND length(code)<=18")) if (/^[0-9]{1,18}$/.test(c) && BigInt(c) > max) max = BigInt(c);
    return (max + 1n).toString();
  }
  if (mode !== "sequencial_ean") return null;
  const raw = preferences.get(db, "produtos.ean_prefixo");
  const prefix = raw === null ? null : typeof raw === "string" ? raw : jsonbText(raw);
  if (prefix === null || !/^[0-9]{7,11}$/.test(prefix)) {
    if (strict) raise("22023", "erp_catalog_ean_prefix_missing");
    return null;
  }
  const digits = 12 - prefix.length;
  let next = -1n;
  for (const c of codes("AND length(code)=13 AND substr(code,1,?)=?", prefix.length, prefix))
    if (/^[0-9]{13}$/.test(c)) {
      const n = BigInt(c.slice(prefix.length, prefix.length + digits));
      if (n > next) next = n;
    }
  next = next + 1n;
  const floor = preferences.get(db, "produtos.ean_proximo");
  if (jsonType(floor) === "number") {
    if (!Number.isInteger(floor)) raise("22P02", `invalid input syntax for type bigint: "${jsonbText(floor)}"`);
    const f = BigInt(floor as number);
    if (f > next) next = f;
  }
  if (next >= 10n ** BigInt(digits)) {
    if (strict) raise("22023", "erp_catalog_ean_exhausted");
    return null;
  }
  const body = prefix + next.toString().padStart(digits, "0");
  return body + gtinCheckDigit(body);
}

// ---------------------------------------------------------------------------
// Camada de tabela: record, product, product_detail

/** erp_sync.capture_catalog para uma linha de cadastro. */
function capture(ctx: RpcContext, record: string, op: "upsert" | "delete") {
  const r = one(ctx.db, 'SELECT entity FROM "erp_catalog__record" WHERE id=?', record);
  if (r && ["contacts", "products"].includes(String(r.entity))) sync.enqueue(ctx, String(r.entity), record, op, null, null);
}

/** INSERT em record (padrões do Postgres, colunas __fold, gatilho zz_origin_sync). */
export function insertRecord(
  ctx: RpcContext,
  r: { entity: string; name: string; code: string | null; active: boolean; actor: string; humanEdited: boolean },
): string {
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  ctx.db.exec(
    `INSERT INTO "erp_catalog__record"(id, entity, name, code, active, version, human_edited, created_by, updated_by, created_at, updated_at, code__fold, name__fold)
     VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?)`,
    id,
    r.entity,
    r.name,
    r.code,
    r.active ? 1 : 0,
    r.humanEdited ? 1 : 0,
    r.actor,
    r.actor,
    now,
    ctx.clock.next().toString(),
    fold(r.code),
    fold(r.name),
  );
  capture(ctx, id, "upsert");
  return id;
}

const PRODUCT_TEXT = [
  "unit", "kind", "format", "description", "ncm", "gtin", "brand", "condition", "production", "dimension_unit",
  "gtin_tax", "location", "cest", "origin", "additional_info",
];

/**
 * erp_catalog.write_fields para produto novo (jsonb_populate_record): as
 * chaves que não são coluna ficam de fora; depois os gatilhos AFTER INSERT na
 * ordem do Postgres (por nome): items_per_box e zz_origin_sync.
 */
export function insertProduct(ctx: RpcContext, id: string, data: Record<string, unknown>) {
  const cols: string[] = ["record_id"];
  const values: unknown[] = [id];
  for (const k of PRODUCT_TEXT) if (k in data) (cols.push(k), values.push(data[k] ?? null));
  if ("price" in data) (cols.push("price"), values.push(data.price === null ? null : decText(String(data.price), 10, false)));
  for (const k of MEASURES)
    if (k in data) (cols.push(k), values.push(data[k] === null ? null : toParam(toScaled(String(data[k]), 6))));
  for (const k of COUNTS) if (k in data) (cols.push(k), values.push(data[k] === null ? null : Number(data[k])));
  ctx.db.exec(
    `INSERT INTO "erp_catalog__product"(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(",")})`,
    ...values,
  );
  // erp_catalog_product_items_per_box_insert → items_per_box_follow
  const items = "items_per_box" in data && data.items_per_box !== null ? Number(data.items_per_box) : null;
  if (items !== null && ctx.settings.get("erp_catalog.items_per_box_detail") !== "on") {
    const detail = one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=?', id);
    if (detail)
      ctx.db.exec('UPDATE "erp_catalog__product_detail" SET items_per_box=? WHERE record_id=?', toParam(toScaled(String(items), 6)), id);
    else
      ctx.db.exec('INSERT INTO "erp_catalog__product_detail"(record_id, items_per_box) VALUES(?,?)', id, toParam(toScaled(String(items), 6)));
    capture(ctx, id, "upsert"); // zz_origin_sync de product_detail
  }
  capture(ctx, id, "upsert"); // zz_origin_sync de product
}

// ---------------------------------------------------------------------------
// Leitura (DTO)

const PRODUCT_COLUMNS = [
  "unit", "price", "kind", "format", "description", "ncm", "gtin", "brand", "condition", "production", "net_weight",
  "gross_weight", "width", "height", "depth", "dimension_unit", "volumes", "items_per_box", "gtin_tax", "stock_min",
  "stock_max", "location", "cest", "origin", "additional_info",
];

/** erp_catalog.data(p_id): só produtos nesta fase (contatos e depósitos: domínio Catálogo). */
export function data(db: SqlDriver, id: string): Record<string, unknown> | null {
  const r = one(db, 'SELECT entity, name, code FROM "erp_catalog__record" WHERE id=?', id);
  if (!r) return null;
  const base = { name: r.name, code: r.code };
  if (r.entity !== "products") raise("0A000", "rpc_not_ported:erp_catalog.data(" + String(r.entity) + ")");
  const p = one(
    db,
    `SELECT ${PRODUCT_COLUMNS.map((c) => (MEASURES.includes(c) ? `CAST(${c} AS TEXT) ${c}` : c)).join(", ")} FROM "erp_catalog__product" WHERE record_id=?`,
    id,
  );
  if (!p) return null; // base || null → null
  const out: Record<string, unknown> = { ...base };
  for (const c of PRODUCT_COLUMNS) out[c] = p[c] ?? null;
  out.price = unitPriceNumeric(p.price, 14);
  for (const c of MEASURES) out[c] = scaledText(p[c], 6);
  for (const c of COUNTS) out[c] = p[c] === null || p[c] === undefined ? null : String(p[c]);
  return out;
}

/** erp_catalog.dto(p_id) */
export function dto(db: SqlDriver, id: string): Record<string, unknown> | null {
  const r = one(db, 'SELECT id, entity, active, version, created_at, updated_at FROM "erp_catalog__record" WHERE id=?', id);
  if (!r) return null;
  const d = data(db, id);
  if (d === null) return null;
  const o = one(
    db,
    'SELECT source_id, state, applied_hash, latest_hash FROM "erp_catalog__origin" WHERE record_id=?',
    id,
  );
  return {
    ...d,
    id: r.id,
    entity: r.entity,
    active: !!r.active,
    version: r.version,
    created_at: jsonTimestamp(r.created_at as number),
    updated_at: jsonTimestamp(r.updated_at as number),
    source: o
      ? { system: "origin", source_id: o.source_id, state: o.state, applied_hash: o.applied_hash, latest_hash: o.latest_hash }
      : null,
  };
}

const DETAIL_SCALED: Record<string, number> = {
  tax_percent: 4, icms_st_retention_base: 2, icms_st_retention_value: 2, icms_own_substitute_value: 2,
  ipi_fixed_value: 4, pis_fixed_value: 4, cofins_fixed_value: 4, glp_percent: 4, glgnn_percent: 4,
  glgni_percent: 4, starting_value: 2,
};
const DETAIL_TEXT = [
  "discreet_description", "complementary_description", "external_link", "video_url", "notes", "category_id",
  "product_group_id", "fci_number", "item_type", "ipi_tipi_exception", "ipi_framework_class", "ipi_seal_code",
  "anp_code", "anp_description",
];

/** erp_catalog.product_detail_data(p_id, p_display) */
export function productDetailData(db: SqlDriver, id: string, display: boolean): Record<string, unknown> | null {
  const p = one(db, 'SELECT items_per_box FROM "erp_catalog__product" WHERE record_id=?', id);
  if (!p) return null;
  const d = one(db, 'SELECT *, CAST(items_per_box AS TEXT) ipb FROM "erp_catalog__product_detail" WHERE record_id=?', id) ?? {};
  const out: Record<string, unknown> = {
    expiry_date: d.expiry_date ?? null,
    free_shipping: d.free_shipping === null || d.free_shipping === undefined ? null : !!d.free_shipping,
    crossdocking_days: d.crossdocking_days === null || d.crossdocking_days === undefined ? null : String(d.crossdocking_days),
  };
  for (const k of DETAIL_TEXT) out[k] = d[k] ?? null;
  for (const [k, s] of Object.entries(DETAIL_SCALED)) out[k] = scaledText(d[k], s);
  const ipb = d.ipb ?? (p.items_per_box === null ? null : toParam(toScaled(String(p.items_per_box), 6)));
  out.items_per_box_decimal = scaledText(ipb, 6);
  out.lot_control = d.lot_control === null || d.lot_control === undefined ? false : !!d.lot_control;
  out.dun_codes = db
    .exec('SELECT code, CAST(quantity AS TEXT) q FROM "erp_catalog__product_dun" WHERE record_id=? ORDER BY position', id)
    .rows.map((x) => ({ code: x.code, quantity: scaledText(x.q, 6) }));
  out.suppliers = db
    .exec(
      `SELECT s.supplier_id, s.description, s.code, s.purchase_price, s.cost_price, s.warranty_months, s.is_default, r.name, r.code rcode
       FROM "erp_catalog__product_supplier" s LEFT JOIN "erp_catalog__record" r ON r.id=s.supplier_id WHERE s.record_id=? ORDER BY s.position`,
      id,
    )
    .rows.map((s) => ({
      supplier_id: s.supplier_id,
      description: s.description,
      code: s.code,
      purchase_price: unitPriceNumeric(s.purchase_price, 14),
      cost_price: unitPriceNumeric(s.cost_price, 14),
      warranty_months: s.warranty_months === null ? null : String(s.warranty_months),
      is_default: !!s.is_default,
      ...(display ? { supplier_name: s.name ?? null, supplier_code: s.rcode ?? null } : {}),
    }));
  out.tag_ids = db
    .exec('SELECT tag_id FROM "erp_catalog__product_tag" WHERE record_id=? ORDER BY tag_id', id)
    .rows.map((x) => String(x.tag_id));
  out.images = db
    .exec('SELECT url FROM "erp_catalog__product_image" WHERE record_id=? ORDER BY position', id)
    .rows.map((x) => ({ url: x.url }));
  out.custom_values = Object.fromEntries(
    db
      .exec('SELECT field_id, value FROM "erp_catalog__product_custom_value" WHERE record_id=?', id)
      .rows.map((x) => [String(x.field_id), JSON.parse(String(x.value))]),
  );
  if (display) {
    out.deleted_at = d.deleted_at === null || d.deleted_at === undefined ? null : jsonTimestamp(d.deleted_at as number);
    const cost = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', id);
    out.cost_price = cost ? unitPriceNumeric(cost.cost_price, 14) : null;
  }
  return out;
}

/** erp_catalog.product_full(p_id) = dto || product_detail_data(p_id, true) */
export function productFull(db: SqlDriver, id: string) {
  const a = dto(db, id),
    b = productDetailData(db, id, true);
  return a === null || b === null ? null : { ...a, ...b };
}
