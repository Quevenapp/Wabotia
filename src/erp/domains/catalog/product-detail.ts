// Detalhe do produto (o que o erp_catalog_product_save grava além do
// cadastro base): erp_catalog.product_detail_keys, product_detail_validate,
// detail_text, detail_decimal, detail_date, product_detail_references,
// category_lineage, custom_field_applies, custom_value,
// product_custom_values, product_custom_resolve, product_detail_write, o
// gatilho product_cost_capture (product_supplier) e o ramo de produtos de
// erp_catalog.warnings. Versões finais no oráculo.
import { decText, toParam, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgHasSpace, pgLower, pgUpper } from "../../engine/text.ts";
import { validDate } from "../../engine/time.ts";
import { detailUuid } from "./access.ts";
import { CNTRL, btrim, chars, compareText } from "./fields.ts";
import { capture, data, fold, unitPrice } from "./internal.ts";
import { compareNum, num } from "./pricing/money.ts";

export const PRODUCT_DETAIL_KEYS = [
  "expiry_date", "free_shipping", "discreet_description", "complementary_description", "external_link", "video_url", "notes",
  "crossdocking_days", "category_id", "product_group_id", "fci_number", "item_type", "tax_percent", "icms_st_retention_base",
  "icms_st_retention_value", "icms_own_substitute_value", "ipi_tipi_exception", "ipi_framework_class", "ipi_fixed_value",
  "ipi_seal_code", "pis_fixed_value", "cofins_fixed_value", "anp_code", "anp_description", "glp_percent", "glgnn_percent",
  "glgni_percent", "starting_value", "dun_codes", "suppliers", "tag_ids", "images", "custom_values", "items_per_box_decimal",
  "lot_control",
];

/** erp_catalog.product_detail_keys() */
export const productDetailKeys = () => [...PRODUCT_DETAIL_KEYS];

const isNull = (v: unknown) => v === null || v === undefined;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** erp_catalog.detail_text(p_value, p_max, p_lines default false) */
export function detailText(value: unknown, max: number, lines = false): string | null {
  if (isNull(value)) return null;
  if (jsonType(value) !== "string") raise("22023", "erp_catalog_text_required");
  const t = btrim(value as string);
  const v = t === "" ? null : t;
  if (v !== null && (chars(v) > max || CNTRL.test(lines ? v.replace(/[\n\r\t]/g, "") : v))) raise("22023", "erp_catalog_invalid_text");
  return v;
}

/** erp_catalog.detail_decimal(p_value, p_integers, p_scale, p_max default null): round(v, escala)::text */
export function detailDecimal(value: unknown, integers: number, scale: number, max: number | null = null): string | null {
  if (isNull(value)) return null;
  if (jsonType(value) !== "string") raise("22023", "erp_catalog_invalid_decimal");
  const v = value as string;
  if (!new RegExp(`^(0|[1-9][0-9]{0,${integers - 1}})(\\.[0-9]{1,${scale}})?$`).test(v) || (max !== null && compareNum(num(v), num(String(max))) > 0))
    raise("22023", "erp_catalog_invalid_decimal");
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(scale, "0")}`;
}

/** erp_catalog.detail_date(p_value jsonb) */
export function detailDate(value: unknown): string | null {
  if (isNull(value)) return null;
  const v = value as string;
  if (jsonType(value) !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) raise("22023", "erp_catalog_invalid_date");
  const y = Number(v.slice(0, 4));
  if (y < 1900 || y > 2100 || !validDate(v)) raise("22023", "erp_catalog_invalid_date");
  return v;
}

const invalidList = (): never => raise("22023", "erp_catalog_invalid_list");

/** erp_catalog.product_detail_validate(p_data jsonb): campos do detalhe na ordem do jsonb. */
export function productDetailValidate(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of jsonbKeys(input)) {
    const value = input[key];
    switch (key) {
      case "expiry_date":
        out[key] = detailDate(value);
        break;
      case "free_shipping":
        if (!["boolean", "null"].includes(jsonType(value)!)) raise("22023", "erp_catalog_invalid_flag");
        out[key] = value;
        break;
      case "discreet_description":
        out[key] = detailText(value, 120);
        break;
      case "complementary_description":
        out[key] = detailText(value, 4000, true);
        break;
      case "notes":
        out[key] = detailText(value, 2000, true);
        break;
      case "anp_description":
        out[key] = detailText(value, 95);
        break;
      case "external_link":
      case "video_url": {
        const t = detailText(value, key === "video_url" ? 100 : 120);
        if (t !== null && !(/^https?:\/\//.test(t) && t.length > t.indexOf("//") + 2 && !pgHasSpace.test(t)))
          raise("22023", "erp_catalog_invalid_url");
        out[key] = t;
        break;
      }
      case "crossdocking_days":
        if (value !== null && (jsonType(value) !== "string" || !/^(0|[1-9][0-9]{0,3})$/.test(value as string)))
          raise("22023", "erp_catalog_invalid_count");
        out[key] = value === null ? null : String(Number(value));
        break;
      case "category_id":
      case "product_group_id":
        out[key] = detailUuid(value);
        break;
      case "fci_number": {
        const raw = detailText(value, 36);
        const t = raw === null ? null : pgUpper(raw);
        if (t !== null && !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(t))
          raise("22023", "erp_catalog_invalid_identifier");
        out[key] = t;
        break;
      }
      case "item_type": {
        const t = detailText(value, 2);
        if (t !== null && !["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "99"].includes(t))
          raise("22023", "erp_catalog_invalid_enum");
        out[key] = t;
        break;
      }
      case "ipi_tipi_exception":
      case "ipi_framework_class":
      case "anp_code": {
        const t = detailText(value, 9);
        const re = key === "ipi_tipi_exception" ? /^[0-9]{1,3}$/ : key === "ipi_framework_class" ? /^[0-9]{3}$/ : /^[0-9]{9}$/;
        if (t !== null && !re.test(t)) raise("22023", "erp_catalog_invalid_identifier");
        out[key] = t;
        break;
      }
      case "ipi_seal_code": {
        const t = detailText(value, 60);
        if (t !== null && !/^[0-9A-Za-z./-]+$/.test(t)) raise("22023", "erp_catalog_invalid_identifier");
        out[key] = t;
        break;
      }
      case "tax_percent":
      case "glp_percent":
      case "glgnn_percent":
      case "glgni_percent":
        out[key] = detailDecimal(value, 3, 4, 100);
        break;
      case "icms_st_retention_base":
      case "icms_st_retention_value":
      case "icms_own_substitute_value":
      case "starting_value":
        out[key] = detailDecimal(value, 13, 2);
        break;
      case "ipi_fixed_value":
      case "pis_fixed_value":
      case "cofins_fixed_value":
        out[key] = detailDecimal(value, 11, 4);
        break;
      case "items_per_box_decimal":
        out[key] = detailDecimal(value, 6, 6);
        break;
      case "lot_control":
        if (jsonType(value) !== "boolean") raise("22023", "erp_catalog_invalid_flag");
        out[key] = value;
        break;
      case "dun_codes": {
        if (jsonType(value) !== "array" || (value as unknown[]).length > 10) invalidList();
        const seen = new Set<string>();
        const list = [];
        for (const item of value as Record<string, unknown>[]) {
          if (
            jsonType(item) !== "object" ||
            jsonbKeys(item).some((k) => !["code", "quantity"].includes(k)) ||
            jsonType(item.code) !== "string" ||
            !/^[0-9]{14}$/.test(item.code as string) ||
            seen.has(item.code as string)
          )
            invalidList();
          const quantity = detailDecimal(item.quantity, 12, 6);
          if (quantity === null || num(quantity).v <= 0n) invalidList();
          seen.add(item.code as string);
          list.push({ code: item.code, quantity });
        }
        out[key] = list;
        break;
      }
      case "suppliers": {
        if (jsonType(value) !== "array" || (value as unknown[]).length > 20) invalidList();
        const seen = new Set<string>();
        let defaults = 0;
        const list = [];
        for (const item of value as Record<string, unknown>[]) {
          if (
            jsonType(item) !== "object" ||
            jsonbKeys(item).some(
              (k) => !["supplier_id", "description", "code", "purchase_price", "cost_price", "warranty_months", "is_default"].includes(k),
            ) ||
            jsonType(item.is_default) !== "boolean" ||
            ("warranty_months" in item &&
              item.warranty_months !== null &&
              (jsonType(item.warranty_months) !== "string" || !/^(0|[1-9][0-9]{0,2})$/.test(item.warranty_months as string)))
          )
            invalidList();
          const row = {
            supplier_id: detailUuid(item.supplier_id),
            description: detailText(item.description, 120),
            code: detailText(item.code, 60),
            purchase_price: isNull(item.purchase_price) ? null : unitPrice(item.purchase_price, 14),
            cost_price: isNull(item.cost_price) ? null : unitPrice(item.cost_price, 14),
            warranty_months: isNull(item.warranty_months) ? null : String(Number(item.warranty_months)),
            is_default: item.is_default,
          };
          if (row.supplier_id === null || seen.has(row.supplier_id)) invalidList();
          if (item.is_default === true) defaults++;
          seen.add(row.supplier_id!);
          list.push(row);
        }
        if (defaults > 1) invalidList();
        out[key] = list;
        break;
      }
      case "tag_ids": {
        if (jsonType(value) !== "array" || (value as unknown[]).length > 50) invalidList();
        const ids = (value as unknown[]).map(detailUuid);
        if (new Set(ids.filter((x) => x !== null)).size !== ids.length) invalidList();
        out[key] = (ids as string[]).slice().sort(compareText);
        break;
      }
      case "images": {
        if (jsonType(value) !== "array" || (value as unknown[]).length > 20) invalidList();
        const seen = new Set<string>();
        const list = [];
        for (const item of value as Record<string, unknown>[]) {
          const url = jsonType(item) === "object" ? item.url : undefined;
          if (
            jsonType(item) !== "object" ||
            jsonbKeys(item).some((k) => k !== "url") ||
            jsonType(url) !== "string" ||
            chars(url as string) < 9 ||
            chars(url as string) > 1000 ||
            !/^https:\/\//.test(url as string) ||
            (url as string).length <= 8 ||
            pgHasSpace.test(url as string) ||
            CNTRL.test(url as string) ||
            seen.has(url as string)
          )
            raise("22023", "erp_catalog_invalid_url");
          seen.add(url as string);
          list.push({ url });
        }
        out[key] = list;
        break;
      }
      case "custom_values": {
        if (
          jsonType(value) !== "object" ||
          Object.keys(value as object).length > 60 ||
          Object.entries(value as Record<string, unknown>).some(
            ([k, v]) => !UUID_LOWER.test(k) || !["string", "null"].includes(jsonType(v)!) || (typeof v === "string" && chars(v) > 4000),
          )
        )
          invalidList();
        out[key] = value;
        break;
      }
      default:
        raise("22023", "erp_catalog_unknown_field");
    }
  }
  return out;
}

/** erp_catalog.product_detail_references(p_detail) */
export function productDetailReferences(db: SqlDriver, d: Record<string, unknown>) {
  const taxonomy = (id: unknown, kind: string, extra = "") =>
    one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind=? ${extra}`, id, kind) !== null;
  if (
    (!isNull(d.category_id) && !taxonomy(d.category_id, "categories")) ||
    (!isNull(d.product_group_id) && !taxonomy(d.product_group_id, "product_groups")) ||
    ((d.tag_ids as string[] | undefined) ?? []).some((t) => !taxonomy(t, "tags", "AND tag_type='products'")) ||
    ((d.suppliers as { supplier_id: string }[] | undefined) ?? []).some(
      (s) => !one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', s.supplier_id),
    )
  )
    raise("22023", "erp_catalog_invalid_reference");
}

/** erp_catalog.category_lineage(p_category): a categoria e as ancestrais (até 50 níveis). */
export function categoryLineage(db: SqlDriver, category: string | null): string[] {
  if (category === null || !one(db, "SELECT 1 x FROM \"erp_catalog__taxonomy\" WHERE id=? AND kind='categories'", category)) return [];
  const out = [category];
  let current = category;
  for (let depth = 0; depth < 50; depth++) {
    const r = one(db, 'SELECT parent_id FROM "erp_catalog__taxonomy" WHERE id=?', current);
    if (!r || r.parent_id === null) break;
    current = String(r.parent_id);
    out.push(current);
  }
  return out;
}

/** erp_catalog.custom_field_applies(p_field_id, p_grouped, p_lineage) */
export const customFieldApplies = (db: SqlDriver, field: string, grouped: boolean, lineage: string[]) =>
  !grouped ||
  one(
    db,
    'SELECT 1 x FROM "erp_catalog__custom_field_category" WHERE field_id=? AND category_id IN (SELECT value FROM json_each(?))',
    field,
    JSON.stringify(lineage),
  ) !== null;

interface CustomField {
  id: string;
  field_type: string;
  active: boolean;
  grouped: boolean;
  required: boolean;
  min_length: number | null;
  max_length: number | null;
}
const toField = (r: Record<string, unknown>): CustomField => ({
  id: String(r.id),
  field_type: String(r.field_type),
  active: Number(r.active) === 1,
  grouped: Number(r.grouped) === 1,
  required: Number(r.required) === 1,
  min_length: r.min_length === null ? null : Number(r.min_length),
  max_length: r.max_length === null ? null : Number(r.max_length),
});
const FIELD_COLUMNS = "id, field_type, active, grouped, required, min_length, max_length";

/** trim_scale(numeric)::text */
function trimScaleText(v: string) {
  let t = v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
  if (/^-0+$/.test(t)) t = "0";
  return t;
}

const invalidCustom = (): never => raise("22023", "erp_catalog_invalid_custom_value");

/** erp_catalog.custom_value(p_field, p_value jsonb) */
export function customValue(db: SqlDriver, field: CustomField, value: unknown): string | null {
  if (isNull(value)) return null;
  if (jsonType(value) !== "string") invalidCustom();
  let v: string | null = value as string;
  v = ["text", "long_text"].includes(field.field_type) ? (btrim(v) === "" ? null : btrim(v)) : v === "" ? null : v;
  if (v === null) return null;
  switch (field.field_type) {
    case "integer":
      if (!/^-?(0|[1-9][0-9]{0,17})$/.test(v) || v === "-0") invalidCustom();
      break;
    case "decimal":
      if (!/^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(v)) invalidCustom();
      v = trimScaleText(v);
      break;
    case "text":
      if (chars(v) > 255 || CNTRL.test(v)) invalidCustom();
      break;
    case "long_text":
      if (chars(v) > 4000 || CNTRL.test(v.replace(/[\n\r\t]/g, ""))) invalidCustom();
      break;
    case "boolean":
      if (!["true", "false"].includes(v)) invalidCustom();
      break;
    case "date":
      v = detailDate(v);
      break;
    default:
      v = pgLower(v);
      if (!UUID_LOWER.test(v) || !one(db, 'SELECT 1 x FROM "erp_catalog__custom_field_option" WHERE id=? AND field_id=?', v, field.id))
        invalidCustom();
  }
  if ((field.min_length !== null && chars(v!) < field.min_length) || (field.max_length !== null && chars(v!) > field.max_length))
    invalidCustom();
  return v;
}

/** erp_catalog.product_custom_values(p_id): mapa campo → texto. */
export function productCustomValues(db: SqlDriver, id: string): Record<string, string> {
  return Object.fromEntries(
    db
      .exec('SELECT field_id, value FROM "erp_catalog__product_custom_value" WHERE record_id=?', id)
      .rows.map((r) => [String(r.field_id), String(r.value)]),
  );
}

/** erp_catalog.product_custom_resolve(p_id, p_detail): o mapa final dos campos customizados. */
export function productCustomResolve(db: SqlDriver, id: string | null, detail: Record<string, unknown>): Record<string, unknown> {
  if (!("custom_values" in detail) && !("category_id" in detail)) return detail;
  let current: Record<string, string> = {};
  let old: string | null = null;
  if (id !== null) {
    current = productCustomValues(db, id);
    const d = one(db, 'SELECT category_id FROM "erp_catalog__product_detail" WHERE record_id=?', id);
    old = d ? ((d.category_id as string | null) ?? null) : null;
  }
  const category = "category_id" in detail ? ((detail.category_id as string | null) ?? null) : old;
  const lineage = categoryLineage(db, category);
  let final: Record<string, string> = { ...current };
  if (category !== old && Object.keys(final).length > 0) {
    final = Object.fromEntries(
      Object.entries(final).filter(([k]) => {
        const f = one(db, `SELECT ${FIELD_COLUMNS} FROM "erp_catalog__custom_field" WHERE id=?`, k);
        return f !== null && customFieldApplies(db, k, toField(f).grouped, lineage);
      }),
    );
  }
  const patch = detail.custom_values as Record<string, unknown> | null | undefined;
  if (patch !== undefined && patch !== null) {
    for (const key of Object.keys(patch).sort(compareText)) {
      const r = one(db, `SELECT ${FIELD_COLUMNS} FROM "erp_catalog__custom_field" WHERE id=? AND module='products'`, key);
      if (!r) raise("22023", "erp_catalog_invalid_reference");
      const field = toField(r);
      const value = customValue(db, field, patch[key]);
      if (value === (final[key] ?? null)) continue;
      if (value === null) {
        delete final[key];
        continue;
      }
      if (!field.active || !customFieldApplies(db, field.id, field.grouped, lineage)) raise("22023", "erp_catalog_custom_field_unavailable");
      final[key] = value;
    }
    const missing = db
      .exec(`SELECT ${FIELD_COLUMNS} FROM "erp_catalog__custom_field" WHERE module='products' AND active=1 AND required=1`)
      .rows.map(toField)
      .some((f) => customFieldApplies(db, f.id, f.grouped, lineage) && !(f.id in final));
    if (missing) raise("22023", "erp_catalog_custom_field_required");
  }
  if (new TextEncoder().encode(jsonbText(final)).length > 8192) raise("22023", "erp_catalog_invalid_custom_value");
  return { ...detail, custom_values: final };
}

// ---------------------------------------------------------------------------
// Gravação

const DETAIL_TEXT = [
  "discreet_description", "complementary_description", "external_link", "video_url", "notes", "category_id", "product_group_id",
  "fci_number", "item_type", "ipi_tipi_exception", "ipi_framework_class", "ipi_seal_code", "anp_code", "anp_description", "expiry_date",
];
const DETAIL_SCALE: Record<string, number> = {
  tax_percent: 4, icms_st_retention_base: 2, icms_st_retention_value: 2, icms_own_substitute_value: 2, ipi_fixed_value: 4,
  pis_fixed_value: 4, cofins_fixed_value: 4, glp_percent: 4, glgnn_percent: 4, glgni_percent: 4, starting_value: 2,
};
const scaled = (v: unknown, s: number) => (isNull(v) ? null : toParam(toScaled(String(v), s)));
const flag = (v: unknown) => (isNull(v) ? null : v === true || v === "true" ? 1 : 0);

/** Gatilho erp_catalog.product_cost_capture (AFTER INSERT OR UPDATE de product_supplier, linha padrão): histórico de custo. */
export function productCostCapture(ctx: RpcContext, product: string, purchase: string | null, cost: string | null) {
  const h = one(
    ctx.db,
    'SELECT cost_price, purchase_price FROM "erp_catalog__product_cost_history" WHERE product_id=? ORDER BY valid_from DESC, id DESC LIMIT 1',
    product,
  );
  const differs = (a: unknown, b: string | null) =>
    a === null || a === undefined ? b !== null : b === null ? true : compareNum(num(String(a)), num(b)) !== 0;
  if (!h || differs(h.cost_price, cost) || differs(h.purchase_price, purchase))
    ctx.db.exec(
      `INSERT INTO "erp_catalog__product_cost_history"(product_id, cost_price, purchase_price, valid_from, source) VALUES(?,?,?,?, 'cadastro')`,
      product,
      // numeric(24,10): escala fixa, como o Postgres grava.
      cost === null ? null : decText(cost, 10, true),
      purchase === null ? null : decText(purchase, 10, true),
      ctx.clock.next().toString(),
    );
}

/** erp_catalog.product_detail_write(p_id, p_detail) */
export function productDetailWrite(ctx: RpcContext, id: string, d: Record<string, unknown>) {
  const db = ctx.db;
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=?', id)) {
    db.exec('INSERT INTO "erp_catalog__product_detail"(record_id) VALUES(?)', id);
    capture(ctx, id, "upsert"); // zz_origin_sync de product_detail
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of DETAIL_TEXT)
    if (k in d) {
      sets.push(`${k}=?`);
      params.push(d[k] ?? null);
    }
  if ("free_shipping" in d) sets.push("free_shipping=?"), params.push(flag(d.free_shipping));
  if ("crossdocking_days" in d) sets.push("crossdocking_days=?"), params.push(isNull(d.crossdocking_days) ? null : Number(d.crossdocking_days));
  for (const [k, s] of Object.entries(DETAIL_SCALE))
    if (k in d) {
      sets.push(`${k}=?`);
      params.push(scaled(d[k], s));
    }
  if ("lot_control" in d) sets.push("lot_control=?"), params.push(flag(d.lot_control));
  // O UPDATE do Postgres roda sempre (sem colunas, ainda dispara o gatilho de captura).
  if (sets.length) db.exec(`UPDATE "erp_catalog__product_detail" SET ${sets.join(", ")} WHERE record_id=?`, ...params, id);
  capture(ctx, id, "upsert");
  // Itens p/ caixa: o valor exato no detalhe; a coluna inteira do catálogo o espelha (vazia com casas).
  if ("items_per_box_decimal" in d) {
    const box = d.items_per_box_decimal as string | null;
    const whole = box !== null && /^\d+\.0+$/.test(box) ? Number(box.split(".")[0]) : null;
    ctx.settings.set("erp_catalog.items_per_box_detail", "on");
    db.exec('UPDATE "erp_catalog__product" SET items_per_box=? WHERE record_id=?', box === null ? null : whole, id);
    capture(ctx, id, "upsert"); // zz_origin_sync de product
    db.exec('UPDATE "erp_catalog__product_detail" SET items_per_box=? WHERE record_id=?', scaled(box, 6), id);
    capture(ctx, id, "upsert");
    ctx.settings.set("erp_catalog.items_per_box_detail", "");
  }
  if ("dun_codes" in d) {
    db.exec('DELETE FROM "erp_catalog__product_dun" WHERE record_id=?', id);
    (d.dun_codes as { code: string; quantity: string }[]).forEach((x, n) =>
      db.exec(
        'INSERT INTO "erp_catalog__product_dun"(record_id, position, code, quantity) VALUES(?,?,?,?)',
        id,
        n + 1,
        x.code,
        scaled(x.quantity, 6),
      ),
    );
  }
  if ("suppliers" in d) {
    db.exec('DELETE FROM "erp_catalog__product_supplier" WHERE record_id=?', id);
    (d.suppliers as Record<string, unknown>[]).forEach((x, n) => {
      db.exec(
        `INSERT INTO "erp_catalog__product_supplier"(record_id, position, supplier_id, description, code, purchase_price, cost_price,
         warranty_months, is_default) VALUES(?,?,?,?,?,?,?,?,?)`,
        id,
        n + 1,
        x.supplier_id,
        x.description ?? null,
        x.code ?? null,
        x.purchase_price ?? null,
        x.cost_price ?? null,
        isNull(x.warranty_months) ? null : Number(x.warranty_months),
        x.is_default ? 1 : 0,
      );
      if (x.is_default) productCostCapture(ctx, id, (x.purchase_price as string | null) ?? null, (x.cost_price as string | null) ?? null);
    });
  }
  if ("tag_ids" in d) {
    db.exec('DELETE FROM "erp_catalog__product_tag" WHERE record_id=?', id);
    for (const t of d.tag_ids as string[]) db.exec('INSERT INTO "erp_catalog__product_tag"(record_id, tag_id) VALUES(?,?)', id, t);
  }
  if ("images" in d) {
    db.exec('DELETE FROM "erp_catalog__product_image" WHERE record_id=?', id);
    (d.images as { url: string }[]).forEach((x, n) =>
      db.exec('INSERT INTO "erp_catalog__product_image"(record_id, position, url) VALUES(?,?,?)', id, n + 1, x.url),
    );
  }
  // custom_values chega já resolvido (mapa final completo, product_custom_resolve).
  if ("custom_values" in d && jsonbText(d.custom_values) !== jsonbText(productCustomValues(db, id))) {
    db.exec('DELETE FROM "erp_catalog__product_custom_value" WHERE record_id=?', id);
    for (const [k, v] of Object.entries((d.custom_values as Record<string, string | null>) ?? {}))
      db.exec('INSERT INTO "erp_catalog__product_custom_value"(record_id, field_id, value) VALUES(?,?,?)', id, k, v);
  }
}

// ---------------------------------------------------------------------------
// Avisos

/** O ramo de produtos de erp_catalog.warnings(p_entity, p_id, p_data). */
export function productWarnings(db: SqlDriver, id: string | null, patch: Record<string, unknown>) {
  const previous = id === null ? {} : (data(db, id) ?? {});
  const out: Record<string, unknown>[] = [];
  const found = (rows: Record<string, unknown>[]) => {
    const sorted = rows
      .map((r) => ({ ...r, created: BigInt(String(r.created_at)) }) as Record<string, unknown> & { created: bigint })
      .sort((a, b) => (a.created > b.created ? -1 : a.created < b.created ? 1 : compareText(String(a.id), String(b.id))));
    return {
      total: sorted.length,
      matches: sorted.slice(0, 5).map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, active: Number(r.active) === 1 })),
    };
  };
  const code = (patch.code as string | null | undefined) ?? null;
  if (code !== null && code !== ((previous as Record<string, unknown>).code ?? null)) {
    const target = fold(code);
    const rows = db
      .exec(`SELECT id, name, code, active, CAST(created_at AS TEXT) created_at FROM "erp_catalog__record" WHERE entity='products' AND code IS NOT NULL`)
      .rows.filter((r) => fold(String(r.code)) === target && r.id !== id);
    const m = found(rows);
    if (m.total > 0) out.push({ code: "duplicate_code", field: "code", total: m.total, matches: m.matches });
  }
  const gtin = (patch.gtin as string | null | undefined) ?? null;
  if (gtin !== null && gtin !== "SEM GTIN" && gtin !== ((previous as Record<string, unknown>).gtin ?? null)) {
    const rows = db
      .exec(
        `SELECT r.id, r.name, r.code, r.active, CAST(r.created_at AS TEXT) created_at FROM "erp_catalog__product" p
         JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE p.gtin=? AND p.gtin<>'SEM GTIN'`,
        gtin,
      )
      .rows.filter((r) => r.id !== id);
    const m = found(rows);
    if (m.total > 0) out.push({ code: "duplicate_gtin", field: "gtin", total: m.total, matches: m.matches });
  }
  return out;
}
