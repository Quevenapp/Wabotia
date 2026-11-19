// Preços de venda e custo em massa: public.erp_catalog_product_price_adjust
// (Reajustar preços: produtos selecionados com versão, ou o conjunto filtrado
// da lista) e public.erp_catalog_product_prices_update (Atualizar preços:
// venda e custo do fornecedor, tudo ou nada). Com a preferência de composição
// ligada, as composições que usam os produtos são recalculadas.
// O UPDATE de erp_catalog.origin ('local_modified') vai no updateRecord (record.ts).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { ErpPartDisabled } from "../../../engine/parts-gate.ts";
import { arrow, jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { validDate } from "../../../engine/time.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { uuidArg } from "../pricing/args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { compositionKits, compositionSync, compositionSyncOn } from "../composition.ts";
import { btrim, compareText, searchTerms } from "../fields.ts";
import { capture, unitPrice, unitPriceNumeric } from "../internal.ts";
import { detailUuid } from "../access.ts";
import { saoPauloMidnight } from "../pricing/pricing.ts";
import { productCostCapture } from "../product-detail.ts";
import {
  canReadStock,
  componentFilter,
  componentValid,
  customFilter,
  filterProducts,
  filtersValid,
  idsAnd,
  stockFilter,
} from "../product-query.ts";
import { updateRecord } from "../record.ts";
import { catalogUnavailable } from "../cost.ts";
import { priceRuleResult, priceRuleValid } from "./erp_catalog_product_price_preview.ts";

const MAX_VERSION = 2147483647;
const invalidCommand = (): never => raise("22023", "erp_catalog_invalid_command");
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** expected_version de um item: número JSON inteiro de 1 a 2^31-1. */
const versionOk = (v: unknown) =>
  jsonType(v) === "number" && /^[1-9][0-9]{0,9}$/.test(jsonbText(v)) && BigInt(jsonbText(v)) <= BigInt(MAX_VERSION);

/** (texto)::date no bloco com exception: formato inválido → invalid_command; ±infinity passa (o filtro recusa). */
function filterDate(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim().toLowerCase();
  if (t === "infinity" || t === "-infinity") return t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v)) invalidCommand();
  return v;
}

/** UPDATE de product (preço) com os gatilhos: os BEFORE não mudam nada aqui; zz_origin_sync. */
function setPrice(ctx: RpcContext, id: string, price: string) {
  ctx.db.exec('UPDATE "erp_catalog__product" SET price=? WHERE record_id=?', price, id);
  capture(ctx, id, "upsert");
}

/** Nova versão do cadastro (UPDATE de record com os gatilhos), mesmo nome, código e situação. */
function bump(ctx: RpcContext, id: string, user: string) {
  const r = one(ctx.db, 'SELECT name, code, active FROM "erp_catalog__record" WHERE id=?', id)!;
  const active = Number(r.active) === 1;
  updateRecord(ctx, id, { entity: "products", active }, { name: String(r.name), code: (r.code as string | null) ?? null, active }, user);
}

const auditRow = (ctx: RpcContext, user: string, command: string, id: string, action: string, before: unknown, after: unknown) =>
  ctx.db.exec(
    `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    user,
    command,
    "products",
    id,
    action,
    jsonbText(before),
    jsonbText(after),
    ctx.clock.next().toString(),
  );

export function erpCatalogProductPriceAdjust(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const command = uuidArg(a, "p_command_id");
  const rule = jsonArg(a, "p_rule") as Record<string, unknown> | null;
  const items = jsonArg(a, "p_items") as Record<string, unknown>[] | null;
  const filters = jsonArg(a, "p_filters") as Record<string, unknown> | null;
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  if (command === null || !priceRuleValid(rule) || (items === null) === (filters === null)) invalidCommand();
  let ids: string[] = [];
  const expected = new Map<string, number>();
  let from: string | null = null,
    to: string | null = null,
    period: string | null = null;
  if (items !== null) {
    if (
      jsonType(items) !== "array" ||
      items.length < 1 ||
      items.length > 100 ||
      items.some(
        (x) =>
          jsonType(x) !== "object" ||
          jsonbKeys(x).some((k) => !["id", "expected_version"].includes(k)) ||
          detailUuid(x.id) === null ||
          !versionOk(x.expected_version),
      )
    )
      invalidCommand();
    for (const x of items) expected.set(detailUuid(x.id)!, Number(x.expected_version));
    ids = [...expected.keys()].sort(compareText);
    if (ids.length !== items.length) invalidCommand();
  } else {
    const f = filters!;
    if (
      jsonType(f) !== "object" ||
      jsonbKeys(f).some(
        (k) =>
          ![
            "situation", "query", "product_type", "ncm_presence", "ncm", "brand", "stock", "warehouse_id", "images", "tag", "category",
            "item_type", "supplier_id", "supplier_code", "period", "from", "to", "custom", "component_id",
          ].includes(k),
      ) ||
      jsonbKeys(f).some((k) => k !== "custom" && !["string", "null"].includes(jsonType(f[k])!)) ||
      ("custom" in f && !["array", "null"].includes(jsonType(f.custom)!))
    )
      invalidCommand();
    period = arrow(f, "period");
    from = filterDate(arrow(f, "from"));
    to = filterDate(arrow(f, "to"));
    const s = (k: string) => arrow(f, k);
    if (
      (s("situation") ?? "latest") === "deleted" ||
      (s("warehouse_id") !== null && !UUID_LOWER.test(s("warehouse_id")!)) ||
      (s("supplier_id") !== null && !UUID_LOWER.test(s("supplier_id")!)) ||
      (s("component_id") !== null && (!UUID_LOWER.test(s("component_id")!) || !componentValid(db, s("product_type"), s("component_id")))) ||
      !filtersValid({
        situation: s("situation") ?? "latest", query: s("query"), productType: s("product_type"), ncmPresence: s("ncm_presence"), ncm: s("ncm"),
        brand: s("brand"), stock: s("stock"), images: s("images"), tag: s("tag"), category: s("category"), itemType: s("item_type"),
        supplierCode: s("supplier_code"), period, from, to,
      })
    )
      invalidCommand();
    if ((s("stock") !== null || s("warehouse_id") !== null) && !canReadStock(db, user)) raise("42501", "erp_catalog_stock_access_denied");
  }
  const hash = requestHash({ actor: user, action: "price_adjust", rule, items, filters });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  if (filters !== null) {
    const f = filters;
    const s = (k: string) => arrow(f, k);
    const blank = (v: string | null) => (v === null || btrim(v) === "" ? null : btrim(v));
    const filter = idsAnd(idsAnd(stockFilter(db, s("stock"), s("warehouse_id")), customFilter(db, f.custom ?? null)), componentFilter(db, s("component_id")));
    const stamped = period === "created" || period === "updated";
    const found = filterProducts(
      db,
      {
        situation: s("situation") ?? "latest", terms: searchTerms(s("query")), productType: s("product_type"), ncmPresence: s("ncm_presence"),
        ncm: s("ncm"), brand: blank(s("brand")), ids: filter, images: s("images"), tag: s("tag"), category: s("category"), itemType: s("item_type"),
        supplier: s("supplier_id"), supplierCode: blank(s("supplier_code")), period,
        fromStamp: stamped && from !== null ? saoPauloMidnight(from) : null,
        toStamp: stamped && to !== null ? saoPauloMidnight(nextDay(to)) : null,
        expiryFrom: period === "expiry" ? from : null, expiryTo: period === "expiry" ? to : null, includeDeleted: false,
      },
      "created_desc",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    ids = found.rows.map((r) => r.id).sort(compareText);
    if (ids.length > 5000) raise("22023", "erp_catalog_adjust_too_many");
  }
  const sync = compositionSyncOn(ctx);
  let applied = 0,
    unchanged = 0,
    skippedTotal = 0;
  const skipped: Record<string, unknown>[] = [];
  const changed: string[] = [];
  const rows = db
    .exec(
      `SELECT r.id, CAST(r.version AS TEXT) version, r.name, p.price, d.deleted_at FROM "erp_catalog__record" r
       JOIN "erp_catalog__product" p ON p.record_id=r.id LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id
       WHERE r.entity='products' AND r.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    )
    .rows.sort((x, y) => compareText(String(x.id), String(y.id)));
  for (const r of rows) {
    const id = String(r.id);
    const version = Number(r.version);
    const price = (r.price as string | null) ?? null;
    const outcome =
      r.deleted_at !== null && r.deleted_at !== undefined
        ? { status: "deleted" }
        : items !== null && expected.get(id) !== version
          ? { status: "conflict" }
          : priceRuleResult(price, rule!);
    if (outcome.status === "ok") {
      if (version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
      const before = { price: unitPriceNumeric(price, 14) };
      setPrice(ctx, id, (outcome as { price: string }).price);
      bump(ctx, id, user!);
      auditRow(ctx, user!, command!, id, "price_adjust", before, { price: (outcome as { price: string }).price, rule });
      applied++;
      changed.push(id);
    } else if (outcome.status === "unchanged") unchanged++;
    else {
      skippedTotal++;
      if (skipped.length < 50) skipped.push({ id, name: r.name, reason: outcome.status });
    }
  }
  if (sync && changed.length > 0) compositionSync(ctx, user!, command!, compositionKits(db, changed));
  // Selecionado que não é produto (ou não existe): informado, não ignorado.
  if (items !== null) {
    const missing = ids.filter((x) => !one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', x));
    skippedTotal += missing.length;
    for (const x of missing) skipped.push({ id: x, name: null, reason: "not_found" });
  }
  const result = {
    entity: "products", total: ids.length, applied, unchanged, skipped_total: skippedTotal, skipped, rule, replayed: false, data_mode: "erp_native",
  };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

export function erpCatalogProductPricesUpdate(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const command = uuidArg(a, "p_command_id");
  const supplier = uuidArg(a, "p_supplier_id");
  const items = jsonArg(a, "p_items") as Record<string, unknown>[] | null;
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  if (
    command === null ||
    items === null ||
    jsonType(items) !== "array" ||
    items.length < 1 ||
    items.length > 100 ||
    items.some(
      (x) =>
        jsonType(x) !== "object" ||
        jsonbKeys(x).some((k) => !["product_id", "expected_version", "price", "cost_price"].includes(k)) ||
        detailUuid(x.product_id) === null ||
        !versionOk(x.expected_version) ||
        (!("price" in x) && !("cost_price" in x)) ||
        ("price" in x && jsonType(x.price) !== "string") ||
        ("cost_price" in x && jsonType(x.cost_price) !== "string"),
    ) ||
    new Set(items.map((x) => arrow(x, "product_id"))).size !== items.length ||
    (supplier === null && items.some((x) => "cost_price" in x))
  )
    invalidCommand();
  if (supplier !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', supplier))
    raise("22023", "erp_catalog_invalid_reference");
  const hash = requestHash({ actor: user, action: "prices_update", supplier, items });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  const ids = items!.map((x) => detailUuid(x.product_id)!);
  const sync = compositionSyncOn(ctx);
  const costOf = (id: string) =>
    supplier === null || !ctx.parts.stock || !ctx.parts.purchases
      ? null
      : unitPriceNumeric(
          one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', id, supplier)?.cost_price ?? null,
          14,
        );
  const priceOf = (id: string) => unitPriceNumeric(one(db, 'SELECT price FROM "erp_catalog__product" WHERE record_id=?', id)?.price ?? null, 14);
  const out = [];
  for (const item of [...items!].sort((x, y) => compareText(detailUuid(x.product_id)!, detailUuid(y.product_id)!))) {
    const id = detailUuid(item.product_id)!;
    const row = one(db, `SELECT CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity='products'`, id);
    if (!row) raise("P0002", "erp_catalog_not_found");
    const version = Number(row.version);
    if (version !== Number(item.expected_version)) raise("40001", "erp_catalog_version_conflict");
    if (one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', id))
      raise("40001", "erp_catalog_product_deleted");
    if (version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    const price = "price" in item ? unitPrice(item.price, 14) : null;
    const cost = "cost_price" in item ? unitPrice(item.cost_price, 14) : null;
    const costAvailable = ctx.parts.stock && ctx.parts.purchases;
    if (cost !== null && !costAvailable) {
      const saved = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', id, supplier);
      if (unitPriceNumeric(saved?.cost_price, 14) !== unitPriceNumeric(cost, 14)) throw new ErpPartDisabled();
    }
    const before = { price: priceOf(id), cost_price: costOf(id) };
    if (price !== null) setPrice(ctx, id, price);
    if (cost !== null && costAvailable) {
      const existing = one(db, 'SELECT is_default, purchase_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', id, supplier);
      if (existing) {
        db.exec('UPDATE "erp_catalog__product_supplier" SET cost_price=? WHERE record_id=? AND supplier_id=?', cost, id, supplier);
        if (Number(existing.is_default) === 1) productCostCapture(ctx, id, (existing.purchase_price as string | null) ?? null, cost);
      } else {
        const position = Number(one(db, 'SELECT coalesce(max(position),0) p FROM "erp_catalog__product_supplier" WHERE record_id=?', id)!.p) + 1;
        if (position > 20) raise("22023", "erp_catalog_invalid_list");
        const first = !one(db, 'SELECT 1 x FROM "erp_catalog__product_supplier" WHERE record_id=?', id);
        db.exec(
          'INSERT INTO "erp_catalog__product_supplier"(record_id, position, supplier_id, cost_price, is_default) VALUES(?,?,?,?,?)',
          id,
          position,
          supplier,
          cost,
          first ? 1 : 0,
        );
        if (first) productCostCapture(ctx, id, null, cost);
      }
    }
    bump(ctx, id, user!);
    auditRow(ctx, user!, command!, id, "prices_update", before, {
      price: price ?? before.price,
      cost_price: cost ?? before.cost_price,
      supplier_id: supplier,
    });
    out.push({ product_id: id, version: version + 1, price: priceOf(id), cost_price: costOf(id) });
  }
  if (sync) compositionSync(ctx, user!, command!, compositionKits(db, ids));
  const result = { entity: "products", supplier_id: supplier, items: out, replayed: false, data_mode: "erp_native",
    ...catalogUnavailable(ctx.parts, ["stock", "purchases"]) };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_product_price_adjust", erpCatalogProductPriceAdjust);
registerRpc("erp_catalog_product_prices_update", erpCatalogProductPricesUpdate);
