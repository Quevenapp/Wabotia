// Leituras de produto: filtros, ordem e páginas (erp_catalog.page_sql,
// product_filter_sql, page_order, product_filters_valid, page_valid,
// product_component_valid, product_ids_and, product_stock_filter,
// product_component_filter, product_custom_filter), o estoque resumido
// (erp_catalog.stock_summary, can_read_stock) e os itens da lista
// (list_item, product_list_item). Portado das versões finais no oráculo.
//
// O SQL dinâmico do Postgres vira filtro em TS sobre as linhas do produto:
// fold, matches e a ordem em collation C (bytes UTF-8) não existem no
// SQLite; o fold é calculado como no Fagoo, sem depender da coluna __fold
// (que pode vir nula em linha semeada).
//
// Os filtros de estoque origin_* leem o espelho do Origin (regra "Origin fora":
// leitura de linha espelhada se porta como leitura): originStockStates porta
// de erp_stock_mirror.product_summary só o estado e o físico que o filtro usa.
import { compareDec, formatScaled, fromColumn } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { ErpError, raise } from "../../engine/errors.ts";
import { arrow, jsonbKeys, jsonType } from "../../engine/json.ts";
import { pgLower } from "../../engine/text.ts";
import { jsonTimestamp, validDate } from "../../engine/time.ts";
import { requireAccess as stockAccess } from "../stock/public.ts";
import { CNTRL, btrim, chars, compareText, matches } from "./fields.ts";
import { fold, unitPriceNumeric } from "./internal.ts";
import { compareNum, num } from "./pricing/money.ts";

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STOCK_FILTERS = ["zero", "negative", "positive", "no_movements"];
const ORIGIN_STOCK = ["origin_zero", "origin_negative", "origin_positive", "origin_not_observed", "origin_unlinked"];
export const SORTS = ["created_desc", "name_asc", "name_desc", "code_asc", "code_desc"];
const QTY = 6;

/** lower() do Postgres (mapeamento simples, engine/text.ts). */
export { pgLower };

const dateOk = (d: string | null) => d === null || (!d.endsWith("infinity") && d >= "1900-01-01" && d <= "2100-12-31");

// ---------------------------------------------------------------------------
// Validação

export interface Filters {
  situation: string | null;
  query: string | null;
  productType: string | null;
  ncmPresence: string | null;
  ncm: string | null;
  brand: string | null;
  stock: string | null;
  images: string | null;
  tag: string | null;
  category: string | null;
  itemType: string | null;
  supplierCode: string | null;
  period: string | null;
  from: string | null;
  to: string | null;
}

/** erp_catalog.product_filters_valid */
export function filtersValid(f: Filters): boolean {
  const textOk = (v: string | null, max: number) => v === null || (chars(v) <= max && !CNTRL.test(v));
  return (
    f.situation !== null &&
    ["latest", "active", "inactive", "deleted"].includes(f.situation) &&
    textOk(f.query, 120) &&
    (f.productType === null ||
      ["composition", "no_composition", "products", "simple", "with_variations", "variations", "services"].includes(f.productType)) &&
    (f.ncmPresence === null || ["present", "missing"].includes(f.ncmPresence)) &&
    (f.ncm === null || (/^[0-9]{2,8}$/.test(f.ncm) && f.ncmPresence !== "missing")) &&
    textOk(f.brand, 100) &&
    (f.stock === null || [...STOCK_FILTERS, ...ORIGIN_STOCK].includes(f.stock)) &&
    (f.images === null || ["yes", "no"].includes(f.images)) &&
    (f.tag === null || f.tag === "none" || UUID_LOWER.test(f.tag)) &&
    (f.category === null || f.category === "none" || UUID_LOWER.test(f.category)) &&
    (f.itemType === null || ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "99"].includes(f.itemType)) &&
    textOk(f.supplierCode, 60) &&
    ((f.period === null && f.from === null && f.to === null) ||
      (f.period !== null && ["created", "updated", "expiry"].includes(f.period) && (f.from !== null || f.to !== null))) &&
    dateOk(f.from) &&
    dateOk(f.to) &&
    (f.from === null || f.to === null || f.from <= f.to)
  );
}

/** erp_catalog.page_valid */
export function pageValid(
  page: number | null,
  size: number | null,
  sort: string | null,
  query: string | null,
  period: string | null,
  from: string | null,
  to: string | null,
) {
  return (
    page !== null &&
    page >= 1 &&
    page <= 100000 &&
    size !== null &&
    size >= 1 &&
    size <= 100 &&
    sort !== null &&
    SORTS.includes(sort) &&
    (query === null || (chars(query) <= 120 && !CNTRL.test(query))) &&
    ((period === null && from === null && to === null) ||
      (period !== null && ["created", "updated"].includes(period) && (from !== null || to !== null))) &&
    dateOk(from) &&
    dateOk(to) &&
    (from === null || to === null || from <= to)
  );
}

/** erp_catalog.product_component_valid */
export const componentValid = (db: SqlDriver, productType: string | null, component: string | null) =>
  component === null ||
  (productType === "composition" && one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', component) !== null);

// ---------------------------------------------------------------------------
// Estoque

/** erp_catalog.can_read_stock: erp_stock.require_access(p_user_id,false) sem 42501. */
export function canReadStock(db: SqlDriver, user: string | null): boolean {
  try {
    stockAccess(db, user as string, false);
    return true;
  } catch (e) {
    if (e instanceof ErpError && e.code === "42501") return false;
    throw e;
  }
}

export interface StockSummary {
  state: string;
  /** escala 6 */
  quantity: bigint | null;
  warehouse_state: string | null;
  warehouse_quantity: bigint | null;
}

/** erp_catalog.stock_summary(p_ids, p_warehouse_id): por produto (null em p_ids = todos). */
export function stockSummary(db: SqlDriver, ids: string[] | null, warehouse: string | null): Map<string, StockSummary> {
  const out = new Map<string, StockSummary>();
  if (ids !== null && ids.length === 0) return out;
  const scope = ids === null ? "" : "WHERE p.record_id IN (SELECT value FROM json_each(?))";
  const args = ids === null ? [] : [JSON.stringify(ids)];
  const candidates = db.exec(`SELECT p.record_id id, p.unit, p.kind FROM "erp_catalog__product" p ${scope}`, ...args).rows;
  const unitOf = new Map(candidates.map((c) => [String(c.id), { unit: c.unit as string | null, kind: c.kind as string | null }]));
  type Pos = {
    bq: bigint | null;
    bunit: string | null;
    bversion: number | null;
    count: number;
    sum: bigint;
    last: number | null;
    unitsMatch: boolean;
    ledger: boolean;
    balance: boolean;
  };
  const positions = new Map<string, Map<string, Pos>>();
  const pos = (product: string, wh: string) => {
    const byWh = positions.get(product) ?? new Map<string, Pos>();
    positions.set(product, byWh);
    const p = byWh.get(wh) ?? {
      bq: null, bunit: null, bversion: null, count: 0, sum: 0n, last: null, unitsMatch: true, ledger: false, balance: false,
    };
    byWh.set(wh, p);
    return p;
  };
  for (const e of db.exec(
    `SELECT e.product_id, e.warehouse_id, CAST(e.quantity AS TEXT) q, e.unit, e.balance_version v FROM "erp_stock__entry" e
     ${ids === null ? "" : "WHERE e.product_id IN (SELECT value FROM json_each(?))"}`,
    ...args,
  ).rows) {
    const c = unitOf.get(String(e.product_id));
    if (!c) continue;
    const p = pos(String(e.product_id), String(e.warehouse_id));
    p.ledger = true;
    p.count++;
    p.sum += fromColumn(e.q);
    p.last = p.last === null ? Number(e.v) : Math.max(p.last, Number(e.v));
    if ((e.unit ?? null) !== (c.unit ?? null)) p.unitsMatch = false;
  }
  for (const b of db.exec(
    `SELECT b.product_id, b.warehouse_id, CAST(b.quantity AS TEXT) q, b.unit, b.version FROM "erp_stock__balance" b
     ${ids === null ? "" : "WHERE b.product_id IN (SELECT value FROM json_each(?))"}`,
    ...args,
  ).rows) {
    if (!unitOf.has(String(b.product_id))) continue;
    const p = pos(String(b.product_id), String(b.warehouse_id));
    p.balance = true;
    p.bq = fromColumn(b.q);
    p.bunit = (b.unit as string | null) ?? null;
    p.bversion = Number(b.version);
  }
  const ignored = new Set(
    db.exec('SELECT warehouse_id FROM "erp_stock__warehouse_setting" WHERE ignore_balance=1').rows.map((r) => String(r.warehouse_id)),
  );
  for (const [id, c] of unitOf) {
    const rows = [...(positions.get(id) ?? new Map<string, Pos>())].map(([wh, p]) => {
      const review =
        !p.balance ||
        !p.ledger ||
        c.unit === null ||
        c.kind !== "P" ||
        p.bunit !== c.unit ||
        !p.unitsMatch ||
        p.bversion !== p.count ||
        p.bversion !== p.last ||
        p.bq !== p.sum;
      return { wh, state: review ? "review_required" : "recorded", quantity: p.bq, ignored: ignored.has(wh) };
    });
    const anyReview = rows.some((r) => r.state === "review_required");
    const here = warehouse === null ? [] : rows.filter((r) => r.wh === warehouse);
    out.set(id, {
      state: anyReview ? "review_required" : rows.length === 0 ? "no_movements" : "recorded",
      quantity:
        anyReview || rows.length === 0 ? null : rows.filter((r) => !r.ignored).reduce((s, r) => s + (r.quantity ?? 0n), 0n),
      warehouse_state:
        warehouse === null ? null : here.length === 0 ? "no_movements" : here.some((r) => r.state === "review_required") ? "review_required" : "recorded",
      warehouse_quantity: warehouse === null ? null : (here.find((r) => r.state === "recorded")?.quantity ?? null),
    });
  }
  return out;
}

/** round(quantidade, 6)::text */
export const quantityText = (q: bigint | null) => (q === null ? null : formatScaled(q, QTY));

/** erp_catalog.product_stock_filter(p_stock, p_warehouse_id) */
export function stockFilter(db: SqlDriver, stock: string | null, warehouse: string | null): string[] | null {
  if (stock === null) return null;
  if (ORIGIN_STOCK.includes(stock))
    return originStockStates(db, warehouse)
      .filter((s) =>
        stock === "origin_unlinked"
          ? s.state === "unlinked"
          : stock === "origin_not_observed"
            ? s.state === "not_observed"
            : s.state === "observed" &&
              s.physical_state === "value" &&
              s.physical !== null &&
              (stock === "origin_zero" ? compareDec(s.physical, "0") === 0 : stock === "origin_positive" ? compareDec(s.physical, "0") > 0 : compareDec(s.physical, "0") < 0),
      )
      .map((s) => s.id);
  const ids: string[] = [];
  for (const [id, s] of stockSummary(db, null, warehouse)) {
    const state = warehouse === null ? s.state : s.warehouse_state;
    const q = warehouse === null ? s.quantity : s.warehouse_quantity;
    const hit =
      stock === "no_movements"
        ? state === "no_movements"
        : state === "recorded" &&
          q !== null &&
          (stock === "zero" ? q === 0n : stock === "positive" ? q > 0n : q < 0n);
    if (hit) ids.push(id);
  }
  return ids;
}

/** erp_catalog.product_component_filter(p_component_id): compostos (formato E) que usam o componente. */
export function componentFilter(db: SqlDriver, component: string | null): string[] | null {
  if (component === null) return null;
  return db
    .exec(
      `SELECT DISTINCT i.product_id FROM "erp_stock__composition" c
       JOIN "erp_stock__composition_item" i ON i.product_id=c.product_id AND i.version=c.version
       JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.component_id=? AND p.format='E'`,
      component,
    )
    .rows.map((r) => String(r.product_id));
}

/** erp_catalog.product_ids_and */
export function idsAnd(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set(b);
  return [...new Set(a.filter((x) => set.has(x)))];
}

const invalidQuery = (): never => raise("22023", "erp_catalog_invalid_query");

/** erp_catalog.detail_date(p_value jsonb) */
function detailDate(value: string | null): string | null {
  if (value === null) return null;
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!m || +m[1] < 1900 || +m[1] > 2100 || !validDate(value)) raise("22023", "erp_catalog_invalid_date");
  return value;
}

const NUMBER = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;

/** erp_catalog.product_custom_filter(p_custom jsonb): produtos que atendem todos os campos. */
export function customFilter(db: SqlDriver, custom: unknown): string[] | null {
  if (custom === null || custom === undefined) return null;
  if (jsonType(custom) !== "array" || (custom as unknown[]).length < 1 || (custom as unknown[]).length > 10) invalidQuery();
  let ids: string[] | null = null;
  for (const item of custom as Record<string, unknown>[]) {
    if (
      jsonType(item) !== "object" ||
      jsonbKeys(item).some((k) => !["field_id", "value", "from", "to"].includes(k)) ||
      jsonType(item.field_id) !== "string" ||
      !UUID_LOWER.test(item.field_id as string) ||
      jsonbKeys(item).some(
        (k) => k !== "field_id" && (!["string", "null"].includes(jsonType(item[k])!) || chars(arrow(item, k) ?? "") > 255),
      )
    )
      invalidQuery();
    const field = one(db, 'SELECT id, field_type FROM "erp_catalog__custom_field" WHERE id=? AND module=\'products\'', item.field_id);
    if (!field) invalidQuery();
    const nonEmpty = (k: string) => {
      const v = arrow(item, k);
      return v === "" ? null : v;
    };
    let value = nonEmpty("value");
    let from = nonEmpty("from");
    let to = nonEmpty("to");
    const values = db
      .exec('SELECT record_id, value FROM "erp_catalog__product_custom_value" WHERE field_id=?', field!.id)
      .rows.map((r) => ({ id: String(r.record_id), value: String(r.value) }));
    let set: string[];
    const type = String(field!.field_type);
    if (type === "text" || type === "long_text") {
      value = value === null || btrim(value) === "" ? null : btrim(value);
      if (value === null || CNTRL.test(value) || from !== null || to !== null) invalidQuery();
      const needle = fold(value)!;
      set = values.filter((v) => fold(v.value)!.includes(needle)).map((v) => v.id);
    } else if (type === "integer" || type === "decimal") {
      if (value !== null || (from === null && to === null) || (from !== null && !NUMBER.test(from)) || (to !== null && !NUMBER.test(to)))
        invalidQuery();
      if (from !== null && to !== null && compareNum(num(from), num(to)) > 0) invalidQuery();
      set = values
        .filter((v) => (from === null || compareNum(num(v.value), num(from)) >= 0) && (to === null || compareNum(num(v.value), num(to)) <= 0))
        .map((v) => v.id);
    } else if (type === "date") {
      if (value !== null || (from === null && to === null)) invalidQuery();
      from = detailDate(from);
      to = detailDate(to);
      if (from !== null && to !== null && from > to) invalidQuery();
      set = values.filter((v) => (from === null || v.value >= from) && (to === null || v.value <= to)).map((v) => v.id);
    } else if (type === "list") {
      value = value === null ? null : pgLower(value);
      if (
        value === null ||
        from !== null ||
        to !== null ||
        !UUID_LOWER.test(value) ||
        !one(db, 'SELECT 1 x FROM "erp_catalog__custom_field_option" WHERE id=? AND field_id=?', value, field!.id)
      )
        invalidQuery();
      set = values.filter((v) => v.value === value).map((v) => v.id);
    } else {
      if (value === null || !["true", "false"].includes(value) || from !== null || to !== null) invalidQuery();
      set = values.filter((v) => v.value === value).map((v) => v.id);
    }
    ids = ids === null ? [...new Set(set)] : idsAnd(ids, set);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Linhas, filtro e ordem

export interface ProductRow {
  id: string;
  created_at: bigint;
  updated_at: bigint;
  name: string;
  code: string | null;
  active: boolean;
  gtin: string | null;
  kind: string | null;
  format: string | null;
  ncm: string | null;
  brand: string | null;
  deleted: boolean;
  category_id: string | null;
  item_type: string | null;
  expiry_date: string | null;
}

export function productRows(db: SqlDriver): ProductRow[] {
  return db
    .exec(
      `SELECT r.id, CAST(r.created_at AS TEXT) created_at, CAST(r.updated_at AS TEXT) updated_at, r.name, r.code, r.active,
       p.gtin, p.kind, p.format, p.ncm, p.brand, d.deleted_at, d.category_id, d.item_type, d.expiry_date
       FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
       LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE r.entity='products'`,
    )
    .rows.map((r) => ({
      id: String(r.id),
      created_at: BigInt(String(r.created_at)),
      updated_at: BigInt(String(r.updated_at)),
      name: String(r.name),
      code: (r.code as string | null) ?? null,
      active: Number(r.active) === 1,
      gtin: (r.gtin as string | null) ?? null,
      kind: (r.kind as string | null) ?? null,
      format: (r.format as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      brand: (r.brand as string | null) ?? null,
      deleted: r.deleted_at !== null && r.deleted_at !== undefined,
      category_id: (r.category_id as string | null) ?? null,
      item_type: (r.item_type as string | null) ?? null,
      expiry_date: (r.expiry_date as string | null) ?? null,
    }));
}

/** O termo da busca bate com nome, código e GTIN (texto, GTIN compacto e só dígitos). */
export function searchHit(terms: string[], r: ProductRow) {
  const gtin = r.gtin ?? "";
  return matches(
    terms,
    fold([r.name, r.code, r.gtin].filter((v) => v !== null).join(" ")),
    pgLower(gtin).replace(/[^0-9a-z]/g, ""),
    gtin.replace(/[^0-9]/g, ""),
  );
}

/** nullif(btrim(ncm),'') is (not) null */
export const ncmPresent = (ncm: string | null) => ncm !== null && btrim(ncm) !== "";

const desc = (cmp: number) => -cmp;
const compareBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** erp_catalog.page_order(p_sort) */
export function pageOrder(sort: string) {
  const name = (r: ProductRow) => fold(r.name)!;
  const code = (r: ProductRow) => (r.code === null ? null : fold(r.code)!);
  const nullsLast = (a: string | null, b: string | null, dir: 1 | -1) =>
    a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : dir * compareText(a, b);
  switch (sort) {
    case "created_desc":
      return (a: ProductRow, b: ProductRow) => desc(compareBig(a.created_at, b.created_at)) || desc(compareText(a.id, b.id));
    case "name_asc":
      return (a: ProductRow, b: ProductRow) => compareText(name(a), name(b)) || compareText(a.id, b.id);
    case "name_desc":
      return (a: ProductRow, b: ProductRow) => desc(compareText(name(a), name(b))) || desc(compareText(a.id, b.id));
    case "code_asc":
      return (a: ProductRow, b: ProductRow) => nullsLast(code(a), code(b), 1) || compareText(a.id, b.id);
    default:
      return (a: ProductRow, b: ProductRow) => nullsLast(code(a), code(b), -1) || desc(compareText(a.id, b.id));
  }
}

export interface FilterArgs {
  situation: string;
  terms: string[] | null;
  productType: string | null;
  ncmPresence: string | null;
  ncm: string | null;
  /** nullif(btrim(p_brand),'') */
  brand: string | null;
  ids: string[] | null;
  images: string | null;
  tag: string | null;
  category: string | null;
  itemType: string | null;
  supplier: string | null;
  /** nullif(btrim(p_supplier_code),'') */
  supplierCode: string | null;
  /** created_at (período 'created') ou updated_at */
  period: string | null;
  fromStamp: bigint | null;
  toStamp: bigint | null;
  expiryFrom: string | null;
  expiryTo: string | null;
  includeDeleted: boolean;
}

/** erp_catalog.product_filter_sql + page_sql: total e a página de ids. */
export function filterProducts(db: SqlDriver, a: FilterArgs, sort: string, offset: number, limit: number) {
  const children = new Set(db.exec('SELECT child_id FROM "erp_catalog__product_variation"').rows.map((r) => String(r.child_id)));
  const withImages = new Set(db.exec('SELECT DISTINCT record_id FROM "erp_catalog__product_image"').rows.map((r) => String(r.record_id)));
  const tags = new Map<string, Set<string>>();
  for (const t of db.exec('SELECT record_id, tag_id FROM "erp_catalog__product_tag"').rows) {
    const s = tags.get(String(t.record_id)) ?? new Set<string>();
    s.add(String(t.tag_id));
    tags.set(String(t.record_id), s);
  }
  const suppliers = new Map<string, { supplier: string; code: string | null }[]>();
  for (const s of db.exec('SELECT record_id, supplier_id, code FROM "erp_catalog__product_supplier"').rows) {
    const list = suppliers.get(String(s.record_id)) ?? [];
    list.push({ supplier: String(s.supplier_id), code: (s.code as string | null) ?? null });
    suppliers.set(String(s.record_id), list);
  }
  const ids = a.ids === null ? null : new Set(a.ids);
  const brand = a.brand === null ? null : fold(a.brand)!;
  const code = a.supplierCode === null ? null : fold(a.supplierCode)!;
  const rows = productRows(db).filter((r) => {
    const situation =
      a.situation === "deleted"
        ? r.deleted
        : (!r.deleted && (a.situation === "active" ? r.active : a.situation === "inactive" ? !r.active : true)) ||
          (a.includeDeleted && r.deleted);
    if (!situation) return false;
    if (a.terms !== null && !searchHit(a.terms, r)) return false;
    switch (a.productType) {
      case "composition":
        if (r.format !== "E") return false;
        break;
      case "no_composition":
        if (r.format === "E") return false;
        break;
      case "products":
        if (r.kind !== "P") return false;
        break;
      case "simple":
        if (r.format !== "S") return false;
        break;
      case "with_variations":
        if (r.format !== "V") return false;
        break;
      case "variations":
        if (!children.has(r.id)) return false;
        break;
      case "services":
        if (r.kind !== "S") return false;
        break;
    }
    if (a.ncmPresence !== null && ncmPresent(r.ncm) !== (a.ncmPresence === "present")) return false;
    if (a.ncm !== null && [...(r.ncm ?? "")].slice(0, [...a.ncm].length).join("") !== a.ncm) return false;
    if (brand !== null && !fold(r.brand ?? "")!.includes(brand)) return false;
    if (ids !== null && !ids.has(r.id)) return false;
    if (a.images !== null && withImages.has(r.id) !== (a.images === "yes")) return false;
    if (a.tag !== null && (a.tag === "none" ? (tags.get(r.id)?.size ?? 0) > 0 : !tags.get(r.id)?.has(a.tag))) return false;
    if (a.category !== null && (a.category === "none" ? r.category_id !== null : r.category_id !== a.category)) return false;
    if (a.itemType !== null && r.item_type !== a.itemType) return false;
    if (a.supplier !== null && !(suppliers.get(r.id) ?? []).some((s) => s.supplier === a.supplier)) return false;
    if (code !== null && !(suppliers.get(r.id) ?? []).some((s) => fold(s.code ?? "")!.includes(code))) return false;
    const stamp = a.period === "created" ? r.created_at : r.updated_at;
    if (a.fromStamp !== null && stamp < a.fromStamp) return false;
    if (a.toStamp !== null && stamp >= a.toStamp) return false;
    if (a.expiryFrom !== null && (r.expiry_date === null || r.expiry_date < a.expiryFrom)) return false;
    if (a.expiryTo !== null && (r.expiry_date === null || r.expiry_date > a.expiryTo)) return false;
    return true;
  });
  rows.sort(pageOrder(sort));
  return { total: rows.length, ids: rows.slice(offset, offset + limit).map((r) => r.id), rows };
}

// ---------------------------------------------------------------------------
// Itens

/** erp_catalog.list_item(p_id) para produtos. */
export function listItem(db: SqlDriver, id: string): Record<string, unknown> {
  const r = one(
    db,
    `SELECT r.id, r.entity, r.active, CAST(r.version AS TEXT) version, r.name, r.code, CAST(r.created_at AS TEXT) created_at,
     CAST(r.updated_at AS TEXT) updated_at FROM "erp_catalog__record" r WHERE r.id=?`,
    id,
  )!;
  const p = one(db, 'SELECT unit, price, kind, format, gtin, brand, ncm FROM "erp_catalog__product" WHERE record_id=?', id);
  const origin = one(db, 'SELECT source_id, state FROM "erp_catalog__origin" WHERE record_id=?', id);
  return {
    id: r.id,
    entity: r.entity,
    active: Number(r.active) === 1,
    version: Number(r.version),
    name: r.name,
    code: r.code ?? null,
    created_at: jsonTimestamp(String(r.created_at)),
    updated_at: jsonTimestamp(String(r.updated_at)),
    // erp_catalog.origin do registro (leitura do espelho), como record-list.ts.
    source: origin ? { system: "origin", source_id: origin.source_id, state: origin.state } : null,
    ...(p
      ? {
          unit: p.unit ?? null,
          price: unitPriceNumeric(p.price, 14),
          kind: p.kind ?? null,
          format: p.format ?? null,
          gtin: p.gtin ?? null,
          brand: p.brand ?? null,
          ncm: p.ncm ?? null,
        }
      : {}),
  };
}

const scaled6 = (v: unknown) => (v === null || v === undefined ? null : formatScaled(fromColumn(v), 6));

/** erp_catalog.product_list_item(p_id) */
export function productListItem(db: SqlDriver, id: string): Record<string, unknown> {
  const p = one(
    db,
    `SELECT CAST(p.stock_min AS TEXT) stock_min, CAST(p.stock_max AS TEXT) stock_max, p.location, d.category_id, d.expiry_date, d.deleted_at
     FROM "erp_catalog__product" p LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=p.record_id WHERE p.record_id=?`,
    id,
  )!;
  const cost = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', id);
  const thumb = one(db, 'SELECT url FROM "erp_catalog__product_image" WHERE record_id=? ORDER BY position LIMIT 1', id);
  return {
    ...listItem(db, id),
    stock_min: scaled6(p.stock_min),
    stock_max: scaled6(p.stock_max),
    location: p.location ?? null,
    cost_price: cost ? unitPriceNumeric(cost.cost_price, 14) : null,
    thumbnail: thumb ? thumb.url : null,
    category_id: p.category_id ?? null,
    expiry_date: p.expiry_date ?? null,
    deleted: p.deleted_at !== null && p.deleted_at !== undefined,
  };
}

/** O objeto "stock" das páginas (null sem acesso ao estoque). */
export function stockJson(s: StockSummary | undefined, visible: boolean, warehouse: string | null) {
  if (!visible) return null;
  return {
    state: s?.state ?? null,
    quantity: s?.state === "recorded" ? quantityText(s.quantity) : null,
    warehouse:
      warehouse === null
        ? null
        : { id: warehouse, state: s?.warehouse_state ?? null, quantity: s?.warehouse_state === "recorded" ? quantityText(s.warehouse_quantity) : null },
  };
}

/**
 * erp_stock_mirror.product_summary(null, p_warehouse_id), só state, physical e
 * physical_state (as colunas que product_stock_filter usa). current_position é
 * position + observation; os LEFT JOIN da view são por chave única e não mudam
 * as linhas.
 */
export function originStockStates(db: SqlDriver, warehouse: string | null) {
  const wh =
    warehouse === null
      ? []
      : db.exec('SELECT source_id FROM "erp_warehouse_import__binding" WHERE warehouse_id=?', warehouse).rows.map((r) => String(r.source_id));
  const positions = db
    .exec(
      `SELECT p.product_source_id, o.warehouse_source_id, o.source_deleted, o.physical, o.physical_state
       FROM "erp_stock_mirror__position" p JOIN "erp_stock_mirror__observation" o ON o.id=p.observation_id`,
    )
    .rows.filter((c) => warehouse === null || wh.includes(String(c.warehouse_source_id)));
  const candidates = db.exec(
    `SELECT p.record_id id, o.source_id FROM "erp_catalog__product" p
     LEFT JOIN "erp_catalog__origin" o ON o.entity='products' AND o.record_id=p.record_id`,
  ).rows;
  return candidates.map((c) => {
    const source = c.source_id === null ? null : String(c.source_id);
    const mine = source === null ? [] : positions.filter((p) => String(p.product_source_id) === source);
    const live = mine.filter((p) => !Number(p.source_deleted));
    const removed = mine.length - live.length;
    const state =
      source === null
        ? "unlinked"
        : warehouse !== null && wh.length === 0
          ? "warehouse_unlinked"
          : live.length === 1
            ? "observed"
            : live.length > 1
              ? "multiple_warehouses"
              : removed > 0
                ? "source_deleted"
                : "not_observed";
    const s = live.length === 1 && (warehouse === null || wh.length > 0) ? live[0] : null;
    return {
      id: String(c.id),
      state,
      physical: s?.physical == null ? null : String(s.physical),
      physical_state: s ? String(s.physical_state) : null,
    };
  });
}