// Painéis do Estoque (Meu Negócio): public.erp_stock_dashboard_preference_get,
// _preference_set, erp_stock_dashboard_idle e erp_stock_dashboard_stock; e a
// lista de notas do check-in (erp_stock_checkin_notes). O gatilho
// guard_dashboard_preference (só por comando, versão +1) é garantido aqui.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { fold } from "../../catalog/public.ts";
import { averageCosts, costVisible, PRICE } from "../costs.ts";
import { ignoredWarehouse } from "../home.ts";
import { commandTaken, QTY, requireAccess, sha256 } from "../internal.ts";
import { priceText } from "../ledger.ts";
import { COMPOSITION_CURRENT, settingsDto, virtualPositions } from "../read.ts";

/** erp_access.require_permission */
function requirePermission(db: SqlDriver, user: string, key: string) {
  if (!permitted(db, user, key)) raise("42501", "erp_access_permission_denied");
}

const DEFAULT_PURCHASE = ["open", "in_progress", "partially_fulfilled"];
const DEFAULT_SALES = ["open", "verified", "in_progress", "partially_fulfilled", "fulfilled"];

/** erp_stock.dashboard_preference_dto(p_actor) */
function preferenceDto(db: SqlDriver, actor: string) {
  const p = one(db, 'SELECT purchase_statuses, sales_statuses, version, updated_at FROM "erp_stock__dashboard_preference" WHERE actor=?', actor);
  if (!p) return { purchase_statuses: DEFAULT_PURCHASE, sales_statuses: DEFAULT_SALES, version: 0, updated_at: null };
  return {
    purchase_statuses: JSON.parse(String(p.purchase_statuses)),
    sales_statuses: JSON.parse(String(p.sales_statuses)),
    version: Number(p.version),
    updated_at: p.updated_at === null ? null : jsonTimestamp(p.updated_at as number),
  };
}

/** erp_stock.dashboard_statuses(valor, permitidos, máximo): lista ordenada e sem repetição, ou null. */
export function dashboardStatuses(value: unknown, allowed: string[], max: number): string[] | null {
  if (value === null || value === undefined || jsonType(value) !== "array") return null;
  const list = value as unknown[];
  if (list.length < 1 || list.length > max || list.some((x) => typeof x !== "string")) return null;
  const v = list as string[];
  if (!v.every((x) => allowed.includes(x)) || new Set(v).size !== v.length) return null;
  return [...v].sort(pgCompareText);
}

registerRpc("erp_stock_dashboard_preference_get", (ctx: RpcContext, a: RpcArgs) => {
  requireAccess(ctx.db, a.p_user_id as string, false);
  return { scope: "stock_dashboard_preference", preference: preferenceDto(ctx.db, a.p_user_id as string), data_mode: "erp_native" };
});

registerRpc("erp_stock_dashboard_preference_set", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string,
    command = a.p_command_id as string | null,
    expected = a.p_expected_version as number | null;
  requireAccess(db, user, false);
  const purchase = dashboardStatuses(jsonbArg(a.p_purchase_statuses), ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"], 5);
  const sales = dashboardStatuses(jsonbArg(a.p_sales_statuses), ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"], 7);
  if (command === null || expected === null || expected < 0 || expected > 2147483646 || purchase === null || sales === null)
    raise("22023", "erp_stock_dashboard_preference_invalid");
  const hash = sha256(jsonbText({ profile: "stock-dashboard-preference-107", actor: user, expected_version: expected, purchase, sales }));
  const c = one(db, 'SELECT actor, request_hash, result FROM "erp_stock__dashboard_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.request_hash !== hash) raise("40001", "erp_stock_dashboard_command_conflict");
    return { ...JSON.parse(String(c.result)), preference: preferenceDto(db, user), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_dashboard_command_conflict");
  const p = one(db, 'SELECT version FROM "erp_stock__dashboard_preference" WHERE actor=?', user);
  if ((p ? Number(p.version) : 0) !== expected) raise("40001", "erp_stock_dashboard_version_conflict");
  const at = ctx.clock.next();
  const result = {
    scope: "stock_dashboard_preference",
    data_mode: "erp_native",
    receipt: { command_id: command, from_version: expected, to_version: expected + 1, saved_at: jsonTimestamp(at) },
  };
  db.exec('INSERT INTO "erp_stock__dashboard_command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, user, hash, JSON.stringify(result), at.toString());
  if (!p)
    db.exec(
      'INSERT INTO "erp_stock__dashboard_preference"(actor, purchase_statuses, sales_statuses, version, updated_at, command_id) VALUES(?,?,?,1,?,?)',
      user, JSON.stringify(purchase), JSON.stringify(sales), at.toString(), command,
    );
  else
    db.exec(
      'UPDATE "erp_stock__dashboard_preference" SET purchase_statuses=?, sales_statuses=?, version=version+1, updated_at=?, command_id=? WHERE actor=?',
      JSON.stringify(purchase), JSON.stringify(sales), at.toString(), command, user,
    );
  return { ...result, preference: preferenceDto(db, user), replayed: false };
});

const inDateRange = (d: string | null) => d !== null && d >= "1900-01-01" && d <= "2100-12-31";
const byName = <T extends { fold: string; id: string }>(x: T, y: T) => pgCompareText(x.fold, y.fold) || pgCompareText(x.id, y.id);

registerRpc("erp_stock_dashboard_idle", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, false);
  requirePermission(db, user, "meu_negocio.dashboard");
  requirePermission(db, user, "meu_negocio.dashboard.sem_movimentacao");
  const since = a.p_since as string | null,
    page = a.p_page as number | null,
    size = a.p_size as number | null;
  if (!inDateRange(since) || page === null || page < 1 || page > 100000 || size === null || size < 1 || size > 100) raise("22023", "erp_stock_invalid_query");
  const stock = new Map<string, bigint>();
  for (const b of db.exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance"').rows)
    if (!ignoredWarehouse(db, String(b.warehouse_id))) stock.set(String(b.product_id), (stock.get(String(b.product_id)) ?? 0n) + fromColumn(b.q));
  const lastSale = new Map<string, string>();
  for (const r of db.exec(
    `SELECT e.product_id, max(m.occurred_on) last FROM (
       SELECT dp.movement_id FROM "erp_stock__document_posting" dp JOIN "erp_documents__document" d ON d.id=dp.document_id WHERE dp.state='active' AND d.kind IN ('sales_orders','service_orders')
       UNION ALL SELECT ip.movement_id FROM "erp_stock__invoice_posting" ip JOIN "erp_fiscal_invoices__invoice" v ON v.id=ip.invoice_id WHERE ip.state='active' AND v.direction='1'
     ) x JOIN "erp_stock__movement" m ON m.id=x.movement_id JOIN "erp_stock__entry" e ON e.movement_id=m.id GROUP BY e.product_id`,
  ).rows)
    lastSale.set(String(r.product_id), String(r.last));
  const rows: { id: string; code: unknown; name: string; fold: string; quantity: bigint; last_sale: string | null }[] = [];
  for (const [id, q] of stock) {
    if (q <= 0n) continue;
    const r = one(db, `SELECT r.code, r.name, r.name__fold f, p.kind FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?`, id);
    if (!r || r.kind !== "P") continue;
    const last = lastSale.get(id) ?? null;
    if (last !== null && last >= since!) continue;
    rows.push({ id, code: r.code, name: String(r.name), fold: String(r.f), quantity: q, last_sale: last });
  }
  rows.sort((x, y) => (x.last_sale === y.last_sale ? byName(x, y) : x.last_sale === null ? -1 : y.last_sale === null ? 1 : x.last_sale < y.last_sale ? -1 : 1));
  return {
    scope: "stock_dashboard_idle", data_mode: "erp_native", since, page, size, total: rows.length,
    items: rows.slice((page! - 1) * size!, page! * size!).map((r) => ({ product_id: r.id, code: r.code, name: r.name, quantity: formatScaled(r.quantity, QTY), last_sale: r.last_sale })),
  };
});

const bad = (t: string | null, max: number) => t !== null && (pgLength(t) > max || pgHasCntrl.test(t));

registerRpc("erp_stock_dashboard_stock", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, false);
  requirePermission(db, user, "meu_negocio.dashboard");
  requirePermission(db, user, "meu_negocio.dashboard.estoque_produtos");
  const cost = costVisible(db, user);
  const page = a.p_page as number | null,
    size = a.p_size as number | null,
    searchBy = a.p_search_by as string | null,
    query = a.p_query as string | null,
    brand = a.p_brand as string | null,
    stockType = a.p_stock_type as string | null,
    warehouse = a.p_warehouse_id as string | null,
    supplierId = a.p_supplier_id as string | null;
  if (
    page === null || page < 1 || page > 100000 || size === null || size < 1 || size > 100 || searchBy === null || !["code", "description", "gtin"].includes(searchBy) ||
    bad(query, 120) || bad(brand, 100) || (stockType !== null && !["physical", "virtual"].includes(stockType))
  )
    raise("22023", "erp_stock_invalid_query");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  if (supplierId !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', supplierId)) raise("P0002", "erp_stock_supplier_not_found");
  const folded = query === null ? null : fold(pgBtrim(query));
  const q = folded === "" ? null : folded;
  const brandTerm = brand === null || pgBtrim(brand) === "" ? null : fold(pgBtrim(brand));
  const typed = db
    .exec(
      `SELECT r.id, r.name, r.name__fold nf, r.code, r.code__fold cf, p.price, p.gtin, p.gtin_tax, p.brand,
         (p.format='E' AND EXISTS(SELECT 1 FROM "erp_stock__composition" c WHERE c.product_id=r.id AND c.stock_type='virtual')
          AND EXISTS(SELECT 1 FROM ${COMPOSITION_CURRENT} i WHERE i.product_id=r.id)) is_virtual
       FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id
       WHERE p.kind='P' AND (? IS NULL OR EXISTS(SELECT 1 FROM "erp_catalog__product_supplier" s WHERE s.record_id=r.id AND s.supplier_id=?))`,
      supplierId, supplierId,
    )
    .rows.filter((p) => {
      if (q !== null) {
        if (searchBy === "code" && !String(p.cf ?? "").includes(q)) return false;
        if (searchBy === "gtin" && !(String(p.gtin ?? "").includes(pgBtrim(query!)) || String(p.gtin_tax ?? "").includes(pgBtrim(query!)))) return false;
        if (searchBy === "description" && !String(p.nf).includes(q)) return false;
      }
      if (brandTerm !== null && !fold(String(p.brand ?? ""))!.includes(brandTerm)) return false;
      if (stockType !== null && (stockType === "virtual") !== (p.is_virtual === 1)) return false;
      return true;
    })
    .map((p) => ({ id: String(p.id), name: String(p.name), fold: String(p.nf), code: p.code, price: p.price === null ? null : toScaled(String(p.price), PRICE), virtual: p.is_virtual === 1 }));
  const scoped: { product: string; warehouse: string; quantity: bigint; ignored: boolean }[] = [];
  for (const p of typed) {
    const positions = p.virtual
      ? virtualPositions(db, p.id).map((v) => ({ warehouse: v.warehouse_id, quantity: v.quantity * 10n ** BigInt(QTY) }))
      : db.exec('SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', p.id).rows.map((b) => ({ warehouse: String(b.warehouse_id), quantity: fromColumn(b.q) }));
    for (const s of positions) if (warehouse === null || s.warehouse === warehouse) scoped.push({ product: p.id, ...s, ignored: ignoredWarehouse(db, s.warehouse) });
  }
  const products = [...new Set(scoped.map((s) => s.product))];
  const costs = cost ? averageCosts(db, products) : new Map<string, bigint | null>();
  const supplierCost = new Map<string, bigint>();
  if (cost)
    for (const id of products) {
      const s = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1 AND cost_price IS NOT NULL', id);
      if (s) supplierCost.set(id, toScaled(String(s.cost_price), PRICE));
    }
  const stockOf = new Map<string, bigint | null>();
  for (const s of scoped) {
    const counts = warehouse !== null || !s.ignored;
    const prev = stockOf.has(s.product) ? stockOf.get(s.product)! : null;
    stockOf.set(s.product, counts ? (prev ?? 0n) + s.quantity : prev);
  }
  const rows = typed
    .filter((p) => stockOf.has(p.id))
    .map((p) => {
      const avg = costs.get(p.id) ?? null,
        sup = supplierCost.get(p.id) ?? null;
      return { ...p, quantity: stockOf.get(p.id) ?? 0n, average_cost: avg, supplier_cost: sup, unit_cost: sup ?? avg };
    })
    .sort(byName);
  const r2 = (v16: bigint) => formatScaled(rescale(v16, QTY + PRICE, 2), 2);
  const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, 0n);
  const priceOf = new Map(typed.map((p) => [p.id, p.price]));
  const byWarehouse = new Map<string, { ignored: boolean; quantity: bigint; value: bigint | null; cost: bigint | null; stock_cost: bigint | null }>();
  for (const s of scoped) {
    const w = byWarehouse.get(s.warehouse) ?? { ignored: false, quantity: 0n, value: null, cost: null, stock_cost: null };
    w.ignored ||= s.ignored;
    w.quantity += s.quantity;
    const price = priceOf.get(s.product) ?? null,
      avg = costs.get(s.product) ?? null,
      unit = supplierCost.get(s.product) ?? avg;
    if (price !== null) w.value = (w.value ?? 0n) + s.quantity * price;
    if (avg !== null) w.cost = (w.cost ?? 0n) + s.quantity * avg;
    if (unit !== null) w.stock_cost = (w.stock_cost ?? 0n) + s.quantity * unit;
    byWarehouse.set(s.warehouse, w);
  }
  const warehouses = [...byWarehouse]
    .map(([id, w]) => {
      const r = one(db, 'SELECT name, name__fold f FROM "erp_catalog__record" WHERE id=?', id);
      return r ? { id, name: r.name, fold: String(r.f), ...w } : null;
    })
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .sort(byName);
  return {
    scope: "stock_dashboard_stock", data_mode: "erp_native", page, size, total: rows.length,
    filters: { query, search_by: searchBy, warehouse_id: warehouse, brand, supplier_id: supplierId, stock_type: stockType },
    cost_basis: settingsDto(db).average_cost_base,
    cost_visible: cost,
    items: rows.slice((page! - 1) * size!, page! * size!).map((r) => ({
      product_id: r.id, code: r.code, name: r.name, quantity: formatScaled(r.quantity, QTY),
      value: r.price === null ? null : r2(r.quantity * r.price),
      average_cost: priceText(r.average_cost),
      cost: r.average_cost === null ? null : r2(r.quantity * r.average_cost),
      supplier_cost: priceText(r.supplier_cost),
      unit_cost: priceText(r.unit_cost),
      cost_source: r.supplier_cost !== null ? "supplier" : r.average_cost !== null ? "average" : null,
      stock_cost: r.unit_cost === null ? null : r2(r.quantity * r.unit_cost),
    })),
    totals: {
      quantity: formatScaled(sum(rows.map((r) => r.quantity)), QTY),
      value: r2(sum(rows.filter((r) => r.price !== null).map((r) => r.quantity * r.price!))),
      unpriced: rows.filter((r) => r.price === null).length,
      cost: cost ? r2(sum(rows.filter((r) => r.average_cost !== null).map((r) => r.quantity * r.average_cost!))) : null,
      uncosted: cost ? rows.filter((r) => r.average_cost === null && r.quantity !== 0n).length : null,
      stock_cost: cost ? r2(sum(rows.filter((r) => r.unit_cost !== null).map((r) => r.quantity * r.unit_cost!))) : null,
      stock_uncosted: cost ? rows.filter((r) => r.unit_cost === null && r.quantity !== 0n).length : null,
      supplier_costed: cost ? rows.filter((r) => r.supplier_cost !== null).length : null,
    },
    warehouses: warehouses.map((w) => ({
      warehouse_id: w.id, name: w.name, ignored: w.ignored, quantity: formatScaled(w.quantity, QTY),
      value: r2(w.value ?? 0n), cost: cost ? r2(w.cost ?? 0n) : null, stock_cost: cost ? r2(w.stock_cost ?? 0n) : null,
    })),
  };
});

/** erp_stock.checkin_access(p_actor, p_write) */
export function checkinAccess(db: SqlDriver, actor: string, write: boolean): string {
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor)?.role as string | undefined) ?? null;
  if (role === null || (write && !["admin", "estoque"].includes(role)) || (!write && !["admin", "estoque", "fiscal"].includes(role)))
    raise("42501", "erp_stock_checkin_access_denied");
  return role;
}
/** erp_stock.checkin_note_open */
export const checkinNoteOpen = (direction: unknown, deleted: unknown, status: unknown) => direction === "0" && deleted === null && ![3, 10].includes(Number(status));

/** erp_stock.checkin_note_dto(p_invoice) */
export function checkinNoteDto(db: SqlDriver, invoice: string) {
  const v = one(
    db,
    `SELECT id, version, model, issue_type, status, series, number, access_key, recipient, issue_date, created_at, direction, deleted_at FROM "erp_fiscal_invoices__invoice" WHERE id=?`,
    invoice,
  );
  if (!v) return null;
  const recipient = v.recipient === null ? null : (JSON.parse(String(v.recipient)) as Record<string, unknown> | null);
  const text = (x: unknown) => (x === null || x === undefined ? null : typeof x === "string" ? x : JSON.stringify(x));
  return {
    invoice_id: v.id, invoice_version: Number(v.version), model: v.model, issue_type: v.issue_type, status: Number(v.status), series: Number(v.series),
    number: v.number === null ? null : Number(v.number), access_key: v.access_key,
    supplier: { name: text(recipient?.name), document: text(recipient?.document), person_type: text(recipient?.person_type) },
    issue_date: v.issue_date, created_at: jsonTimestamp(v.created_at as number),
    items_count: Number(one(db, 'SELECT count(*) n FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=?', invoice)!.n),
    checkin_state: (one(db, 'SELECT state FROM "erp_stock__checkin" WHERE invoice_id=?', invoice)?.state as string | undefined) ?? "pending",
    open: checkinNoteOpen(v.direction, v.deleted_at, v.status),
  };
}

registerRpc("erp_stock_checkin_notes", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const role = checkinAccess(db, a.p_user_id as string, false);
  const offset = a.p_offset as number | null,
    limit = a.p_limit as number | null,
    query = a.p_query as string | null;
  if (offset === null || offset < 0 || offset > 100000 || limit === null || limit < 1 || limit > 100 || bad(query, 60)) raise("22023", "erp_stock_invalid_query");
  const digits = (query ?? "").replace(/[^0-9]/g, "");
  const q = digits === "" ? null : digits;
  if (query !== null && pgBtrim(query) !== "" && (q === null || !(q.length === 44 || q.length <= 9))) raise("22023", "erp_stock_invalid_query");
  const rows = db
    .exec(
      `SELECT id FROM "erp_fiscal_invoices__invoice" WHERE direction='0' AND deleted_at IS NULL AND status NOT IN (3,10)
        AND (? IS NULL OR (length(?)=44 AND access_key=?) OR (length(?)<=9 AND number=CAST(? AS INTEGER)))
       ORDER BY created_at DESC, id DESC`,
      q, q, q, q, q,
    )
    .rows.map((r) => String(r.id));
  return {
    scope: "stock_checkin_notes", data_mode: "erp_native", query, offset, limit, total: rows.length,
    items: rows.slice(offset!, offset! + limit!).map((id) => checkinNoteDto(db, id)),
    can_manage: ["admin", "estoque"].includes(role),
  };
});
