// Páginas e exportação de produtos: public.erp_catalog_product_page,
// _page_v2, _page_v3, _page_custom, _export e _export_v2 (o corpo comum das
// cinco últimas é o mesmo no Fagoo, com filtros extras por versão).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcArgs } from "../../engine/registry.ts";
import { jsonArg } from "./args.ts";
import { boolArg, intArg, textArg, uuidArg } from "./pricing/args.ts";
import { CNTRL, btrim, chars, compareText, searchTerms } from "./fields.ts";
import { dto, fold, productDetailData, unitPriceNumeric } from "./internal.ts";
import { dateOrInfinity } from "./pricing/args.ts";
import { requireAccess } from "./pricing/deps.ts";
import { saoPauloMidnight } from "./pricing/pricing.ts";
import {
  canReadStock,
  componentFilter,
  componentValid,
  customFilter,
  filterProducts,
  filtersValid,
  idsAnd,
  listItem,
  ncmPresent,
  pageOrder,
  pageValid,
  productListItem,
  productRows,
  quantityText,
  searchHit,
  stockFilter,
  stockJson,
  stockSummary,
  type Filters,
} from "./product-query.ts";

const invalidQuery = (): never => raise("22023", "erp_catalog_invalid_query");
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const nullIfBlank = (v: string | null) => (v === null || btrim(v) === "" ? null : btrim(v));

/** Acesso ao estoque e depósito do filtro (as mesmas recusas em todas as páginas). */
function stockScope(db: SqlDriver, user: string | null, stock: string | null, warehouse: string | null) {
  const visible = canReadStock(db, user);
  if ((stock !== null || warehouse !== null) && !visible) raise("42501", "erp_catalog_stock_access_denied");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse))
    raise("P0002", "erp_catalog_warehouse_not_found");
  return visible;
}

function filters(a: RpcArgs): Filters {
  return {
    situation: textArg(a, "p_situation", "latest"),
    query: textArg(a, "p_query"),
    productType: textArg(a, "p_product_type"),
    ncmPresence: textArg(a, "p_ncm_presence"),
    ncm: textArg(a, "p_ncm"),
    brand: textArg(a, "p_brand"),
    stock: textArg(a, "p_stock"),
    images: textArg(a, "p_images"),
    tag: textArg(a, "p_tag"),
    category: textArg(a, "p_category"),
    itemType: textArg(a, "p_item_type"),
    supplierCode: textArg(a, "p_supplier_code"),
    period: textArg(a, "p_period"),
    from: dateOrInfinity(a, "p_from"),
    to: dateOrInfinity(a, "p_to"),
  };
}

type Variant = "v2" | "v3" | "custom" | "export";

/**
 * Corpo comum de _page_v2, _page_v3, _page_custom e _export_v2: argumentos
 * na ordem da assinatura (o tipo falha antes do corpo), validação, estoque,
 * filtro de ids e a página.
 */
function run(db: SqlDriver, a: RpcArgs, variant: Variant) {
  const user = uuidArg(a, "p_user_id");
  const exporting = variant === "export";
  const offsetArg = exporting ? intArg(a, "p_offset", 0) : null;
  const limitArg = exporting ? intArg(a, "p_limit", 250) : null;
  const page = exporting ? null : intArg(a, "p_page", 1);
  const size = exporting ? null : intArg(a, "p_size", 100);
  const sort = textArg(a, "p_sort", "created_desc");
  const f = filters(a);
  const warehouse = uuidArg(a, "p_warehouse_id");
  const supplier = uuidArg(a, "p_supplier_id");
  const includeDeleted = exporting ? boolArg(a, "p_include_deleted", false) : false;
  const custom = variant === "v3" || variant === "custom" ? jsonArg(a, "p_custom") : null;
  const component = variant === "v3" || variant === "export" ? uuidArg(a, "p_component_id") : null;
  requireAccess(db, user, "products", false);
  const pageOk = exporting
    ? offsetArg !== null && offsetArg >= 0 && offsetArg <= 10000000 && limitArg !== null && limitArg >= 1 && limitArg <= 250 && includeDeleted !== null
    : page !== null && page >= 1 && page <= 100000 && size !== null && size >= 1 && size <= 100;
  if (
    !pageOk ||
    sort === null ||
    !["created_desc", "name_asc", "name_desc", "code_asc", "code_desc"].includes(sort) ||
    (variant === "custom" && custom === null) ||
    !filtersValid(f) ||
    ((variant === "v3" || variant === "export") && !componentValid(db, f.productType, component))
  )
    invalidQuery();
  const visible = stockScope(db, user, f.stock, warehouse);
  const fallback = exporting && visible ? one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1') : null;
  const defaultWarehouse = fallback && fallback.warehouse_id !== null ? String(fallback.warehouse_id) : null;
  let ids = stockFilter(db, f.stock, warehouse);
  if (variant === "custom") ids = idsAnd(ids, customFilter(db, custom));
  if (variant === "v3") ids = idsAnd(idsAnd(ids, custom === null ? null : customFilter(db, custom)), componentFilter(db, component));
  if (variant === "export") ids = idsAnd(ids, componentFilter(db, component));
  const stamped = f.period === "created" || f.period === "updated";
  const offset = exporting ? offsetArg! : (page! - 1) * size!;
  const limit = exporting ? limitArg! : size!;
  const result = filterProducts(
    db,
    {
      situation: f.situation!,
      terms: searchTerms(f.query),
      productType: f.productType,
      ncmPresence: f.ncmPresence,
      ncm: f.ncm,
      brand: nullIfBlank(f.brand),
      ids,
      images: f.images,
      tag: f.tag,
      category: f.category,
      itemType: f.itemType,
      supplier,
      supplierCode: nullIfBlank(f.supplierCode),
      period: f.period,
      fromStamp: stamped && f.from !== null ? saoPauloMidnight(f.from) : null,
      toStamp: stamped && f.to !== null ? saoPauloMidnight(nextDay(f.to)) : null,
      expiryFrom: f.period === "expiry" ? f.from : null,
      expiryTo: f.period === "expiry" ? f.to : null,
      includeDeleted: includeDeleted!,
    },
    sort!,
    offset,
    limit,
  );
  if (exporting) return exportResult(db, result, visible, defaultWarehouse, offset, limit);
  const summary = stockSummary(db, visible ? result.ids : [], warehouse);
  return {
    entity: "products",
    items: result.ids.map((id) => ({ ...productListItem(db, id), stock: stockJson(summary.get(id), visible, warehouse) })),
    page,
    size,
    total: result.total,
    sort,
    stock_visible: visible,
    data_mode: "erp_native",
  };
}

const omit = (o: Record<string, unknown> | null, keys: string[]) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));

function exportResult(
  db: SqlDriver,
  result: { total: number; ids: string[] },
  visible: boolean,
  defaultWarehouse: string | null,
  offset: number,
  limit: number,
) {
  const summary = stockSummary(db, visible ? result.ids : [], defaultWarehouse);
  const taxonomy = (column: string, id: string) => {
    const r = one(
      db,
      `SELECT t.name FROM "erp_catalog__taxonomy" t JOIN "erp_catalog__product_detail" d ON d.${column}=t.id WHERE d.record_id=?`,
      id,
    );
    return r ? r.name : null;
  };
  const items = result.ids.map((id) => {
    const k = summary.get(id);
    const supplier = one(
      db,
      `SELECT c.name, s.description, s.code, s.purchase_price, s.cost_price, s.warranty_months
       FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id
       WHERE s.record_id=? ORDER BY s.is_default DESC, s.position LIMIT 1`,
      id,
    );
    return {
      ...omit(dto(db, id), ["source", "entity"]),
      ...omit(productDetailData(db, id, true), ["suppliers", "dun_codes", "images"]),
      category: taxonomy("category_id", id),
      product_group: taxonomy("product_group_id", id),
      tags: db
        .exec(
          'SELECT t.name FROM "erp_catalog__product_tag" x JOIN "erp_catalog__taxonomy" t ON t.id=x.tag_id WHERE x.record_id=?',
          id,
        )
        .rows.map((r) => String(r.name))
        .sort((x, y) => compareText(fold(x)!, fold(y)!)),
      images: db
        .exec('SELECT url FROM "erp_catalog__product_image" WHERE record_id=? ORDER BY position', id)
        .rows.map((r) => r.url),
      supplier: supplier
        ? {
            name: supplier.name,
            description: supplier.description ?? null,
            code: supplier.code ?? null,
            purchase_price: unitPriceNumeric(supplier.purchase_price, 14),
            cost_price: unitPriceNumeric(supplier.cost_price, 14),
            warranty_months: supplier.warranty_months === null ? null : String(supplier.warranty_months),
          }
        : null,
      stock: !visible
        ? null
        : defaultWarehouse !== null
          ? k?.warehouse_state === "recorded"
            ? quantityText(k.warehouse_quantity)
            : null
          : k?.state === "recorded"
            ? quantityText(k.quantity)
            : null,
      source_id: null,
    };
  });
  const warehouseRow =
    defaultWarehouse === null ? null : one(db, 'SELECT id, name FROM "erp_catalog__record" WHERE id=?', defaultWarehouse);
  return {
    entity: "products",
    items,
    offset,
    limit,
    total: result.total,
    stock_visible: visible,
    stock_scope: !visible ? null : defaultWarehouse === null ? "considered_warehouses" : "default_warehouse",
    stock_warehouse: warehouseRow ? { id: warehouseRow.id, name: warehouseRow.name } : null,
    data_mode: "erp_native",
  };
}

export const productPageV2 = (db: SqlDriver, a: RpcArgs) => run(db, a, "v2");
export const productPageV3 = (db: SqlDriver, a: RpcArgs) => run(db, a, "v3");
export const productPageCustom = (db: SqlDriver, a: RpcArgs) => run(db, a, "custom");
export const productExportV2 = (db: SqlDriver, a: RpcArgs) => run(db, a, "export");

/** public.erp_catalog_product_page (v1): filtros próprios, sem situação de exclusão. */
export function productPage(db: SqlDriver, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const page = intArg(a, "p_page", 1);
  const size = intArg(a, "p_size", 100);
  const sort = textArg(a, "p_sort", "created_desc");
  const query = textArg(a, "p_query");
  const active = boolArg(a, "p_active");
  const kind = textArg(a, "p_kind");
  const format = textArg(a, "p_format");
  const presence = textArg(a, "p_ncm_presence");
  const ncm = textArg(a, "p_ncm");
  const brandArg = textArg(a, "p_brand");
  const stock = textArg(a, "p_stock");
  const warehouse = uuidArg(a, "p_warehouse_id");
  const period = textArg(a, "p_period");
  const from = dateOrInfinity(a, "p_from");
  const to = dateOrInfinity(a, "p_to");
  requireAccess(db, user, "products", false);
  if (
    !pageValid(page, size, sort, query, period, from, to) ||
    (kind !== null && !["P", "S", "N"].includes(kind)) ||
    (format !== null && !["S", "V", "E"].includes(format)) ||
    (presence !== null && !["present", "missing"].includes(presence)) ||
    (ncm !== null && (!/^[0-9]{2,8}$/.test(ncm) || presence === "missing")) ||
    (brandArg !== null && (chars(brandArg) > 100 || CNTRL.test(brandArg))) ||
    (stock !== null && !["zero", "negative", "positive", "no_movements"].includes(stock))
  )
    invalidQuery();
  const visible = stockScope(db, user, stock, warehouse);
  const ids = stock === null ? null : new Set(stockFilter(db, stock, warehouse));
  const terms = searchTerms(query);
  const low = from === null ? null : saoPauloMidnight(from);
  const high = to === null ? null : saoPauloMidnight(nextDay(to));
  const brand = nullIfBlank(brandArg) === null ? null : fold(nullIfBlank(brandArg))!;
  const rows = productRows(db).filter((r) => {
    const stamp = period === "updated" ? r.updated_at : r.created_at;
    return (
      (active === null || r.active === active) &&
      (terms === null || searchHit(terms, r)) &&
      (kind === null || r.kind === kind) &&
      (format === null || r.format === format) &&
      (presence === null || ncmPresent(r.ncm) === (presence === "present")) &&
      (ncm === null || [...(r.ncm ?? "")].slice(0, [...ncm].length).join("") === ncm) &&
      (brand === null || fold(r.brand ?? "")!.includes(brand)) &&
      (ids === null || ids.has(r.id)) &&
      (low === null || stamp >= low) &&
      (high === null || stamp < high)
    );
  });
  rows.sort(pageOrder(sort!));
  const pageIds = rows.slice((page! - 1) * size!, (page! - 1) * size! + size!).map((r) => r.id);
  const summary = stockSummary(db, visible ? pageIds : [], warehouse);
  return {
    entity: "products",
    items: pageIds.map((id) => ({ ...listItem(db, id), stock: stockJson(summary.get(id), visible, warehouse) })),
    page,
    size,
    total: rows.length,
    sort,
    stock_visible: visible,
    data_mode: "erp_native",
  };
}
