// Compra sem retrabalho, fora da nota (só do motor; assinaturas em
// engine/signatures-engine.ts, partes em engine/parts-gate.ts):
// - erp_inbound_replenishment: reposição pelo estoque mínimo e máximo do
//   cadastro do produto. Para quem está abaixo do mínimo, a sugestão é
//   máximo − saldo − pedidos de compra em aberto (sem máximo, o mínimo).
// - erp_inbound_replenishment_generate: os pedidos de compra das sugestões,
//   um por fornecedor, pelo salvar de documento do Compras (erp_document_save),
//   com comandos derivados: repetir o pedido não cria outro.
// - erp_inbound_inventory: inventário valorizado numa data, por produto e
//   depósito: o saldo dos lançamentos até a data e o custo médio da data.
// Quantidades na escala 6 (texto com 6 casas), preços na escala 10, valores
// em reais com 2 casas.
import { formatScaled, fromColumn, rescale, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { activeRole } from "../access/public.ts";
import * as documents from "../documents/public.ts";
import * as stock from "../stock/public.ts";
import { subCommand } from "./rpc.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const PRICE = /^(0|[1-9][0-9]{0,13})(\.[0-9]{1,10})?$/;
const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const q6 = (v: bigint) => formatScaled(v, 6);
const p10 = (v: bigint | null) => (v === null ? null : formatScaled(v, 10));
/** Quantidade (escala 6) × preço (escala 10) → reais com 2 casas. */
const money = (qty: bigint, price: bigint) => formatScaled(rescale(qty * price, 16, 2), 2);
/** Situações do pedido de compra que ainda vão chegar. */
const OPEN_ORDER = ["open", "in_progress", "partially_fulfilled"];

function input(a: RpcArgs): Record<string, any> {
  const value = parse(a.p_input);
  if (!value || typeof value !== "object" || Array.isArray(value)) raise("22023", "inbound_input_invalid");
  return value;
}
const uuidOrNull = (v: unknown, code: string) => (v === undefined || v === null ? null : typeof v === "string" && UUID.test(v) ? v : raise("22023", code));

/** Depósitos ativos, para o filtro da tela. */
const activeWarehouses = (db: SqlDriver) =>
  db.exec(`SELECT id, name FROM "erp_catalog__record" WHERE entity='warehouses' AND active=1 ORDER BY name, id`).rows.map((r) => ({ id: String(r.id), name: String(r.name) }));

function warehouseOf(db: SqlDriver, id: string | null) {
  if (id !== null && !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='warehouses'`, id)) raise("P0002", "inbound_warehouse_not_found");
  return id;
}

/** Pedidos de compra em aberto: o que falta chegar de cada produto (no depósito, quando ele vem). */
export function openOrderQuantities(db: SqlDriver, warehouse: string | null): Map<string, { quantity: bigint; orders: { id: string; number: string | null; quantity: string }[] }> {
  const out = new Map<string, { quantity: bigint; orders: { id: string; number: string | null; quantity: string }[] }>();
  const docs = db.exec(
    `SELECT d.id, CAST(d.number AS TEXT) number, d.status, d.warehouse_id FROM "erp_documents__document" d
      WHERE d.kind='purchase_orders' AND d.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM "erp_stock__document_posting" p WHERE p.document_id=d.id AND p.state='active')`,
  ).rows.filter((d) => OPEN_ORDER.includes(String(d.status)) && (warehouse === null || d.warehouse_id === null || d.warehouse_id === warehouse));
  for (const d of docs) {
    const current = stock.purchaseReceiptCurrent(db, String(d.id)) as { items: { product_id: string | null; remaining_quantity: string | null }[] };
    for (const i of current.items) {
      if (!i.product_id || i.remaining_quantity === null) continue;
      const left = toScaled(i.remaining_quantity, 6);
      if (left <= 0n) continue;
      const g = out.get(i.product_id) ?? { quantity: 0n, orders: [] };
      g.quantity += left;
      g.orders.push({ id: String(d.id), number: d.number === null ? null : String(d.number), quantity: q6(left) });
      out.set(i.product_id, g);
    }
  }
  return out;
}

/** Preço da sugestão: o do fornecedor (compra, senão custo) e, sem ele, o da última compra. */
function supplierPrice(db: SqlDriver, product: string, supplier: string | null) {
  const s = supplier === null ? null : one(db, 'SELECT purchase_price, cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', product, supplier);
  const own = s?.purchase_price ?? s?.cost_price ?? null;
  if (own !== null && own !== undefined) return { price: toScaled(String(own), 10), source: s?.purchase_price != null ? "supplier_purchase" : "supplier_cost" };
  const last = stock.lastPurchase(db, product, false);
  return last ? { price: last.unit_price as bigint, source: "last_purchase" } : { price: null, source: null };
}

function replenishmentAccess(db: SqlDriver, user: string) {
  stock.requireAccess(db, user, false);
  if (!documents.allowed(activeRole(db, user), "purchase_orders", false)) raise("42501", "inbound_replenishment_denied");
}

export function replenishmentRows(db: SqlDriver, warehouse: string | null, supplierFilter: string | null, onlyBelow: boolean) {
  const open = openOrderQuantities(db, warehouse);
  const rows = db.exec(
    `SELECT r.id, r.code, r.name, p.unit, CAST(p.stock_min AS TEXT) smin, CAST(p.stock_max AS TEXT) smax
       FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id
      WHERE p.kind='P' AND r.active=1 AND (p.stock_min IS NOT NULL OR p.stock_max IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)`,
  ).rows;
  const out = [];
  for (const r of rows) {
    const id = String(r.id);
    const min = r.smin === null ? null : fromColumn(r.smin), max = r.smax === null ? null : fromColumn(r.smax);
    const supplier = supplierFilter !== null
      ? one(db, 'SELECT s.supplier_id, c.name FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id WHERE s.record_id=? AND s.supplier_id=?', id, supplierFilter)
      : one(db, 'SELECT s.supplier_id, c.name FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id WHERE s.record_id=? ORDER BY s.is_default DESC, s.position LIMIT 1', id);
    if (supplierFilter !== null && !supplier) continue;
    const balance = stock.countPhysical(db, id, warehouse) as bigint;
    const ordered = open.get(id)?.quantity ?? 0n;
    const below = min !== null && balance < min;
    if (onlyBelow && !below) continue;
    // Abaixo do mínimo: completa até o máximo (sem máximo, até o mínimo), descontando o que já está pedido.
    const target = max ?? min ?? 0n;
    const raw = below ? target - balance - ordered : 0n;
    const suggestion = raw > 0n ? raw : 0n;
    const supplierId = supplier ? String(supplier.supplier_id) : null;
    const price = supplierPrice(db, id, supplierId);
    out.push({
      product_id: id, code: (r.code as string | null) ?? null, name: String(r.name), unit: (r.unit as string | null) ?? null,
      stock_min: min === null ? null : q6(min), stock_max: max === null ? null : q6(max), balance: q6(balance), ordered: q6(ordered),
      orders: open.get(id)?.orders ?? [], below_min: below, suggestion: q6(suggestion),
      covered_by_orders: below && raw <= 0n,
      supplier_id: supplierId, supplier_name: supplier ? String(supplier.name) : null,
      // Os fornecedores do produto (aba Fornecedores do cadastro), para a pessoa trocar o da linha.
      suppliers: db.exec('SELECT s.supplier_id id, c.name FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id WHERE s.record_id=? AND c.active=1 ORDER BY s.is_default DESC, s.position', id)
        .rows.map((s) => ({ id: String(s.id), name: String(s.name) })),
      unit_price: p10(price.price), price_source: price.source, value: price.price === null ? null : money(suggestion, price.price),
    });
  }
  return out.sort((x, y) => (x.below_min === y.below_min ? x.name.localeCompare(y.name, "pt-BR") || x.product_id.localeCompare(y.product_id) : x.below_min ? -1 : 1));
}

registerRpc("erp_inbound_replenishment", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  replenishmentAccess(db, user);
  const p = input(a);
  const warehouse = warehouseOf(db, uuidOrNull(p.warehouse_id, "inbound_replenishment_invalid"));
  const supplier = uuidOrNull(p.supplier_id, "inbound_replenishment_invalid");
  if (supplier !== null && !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, supplier)) raise("P0002", "inbound_supplier_not_found");
  if (p.only_below !== undefined && typeof p.only_below !== "boolean") raise("22023", "inbound_replenishment_invalid");
  const items = replenishmentRows(db, warehouse, supplier, p.only_below !== false);
  const toBuy = items.filter((i) => toScaled(i.suggestion, 6) > 0n);
  return {
    scope: "inbound_replenishment", filters: { warehouse_id: warehouse, supplier_id: supplier, only_below: p.only_below !== false },
    can_order: documents.allowed(activeRole(db, user), "purchase_orders", true),
    warehouses: activeWarehouses(db),
    total: items.length, items,
    totals: {
      below_min: items.filter((i) => i.below_min).length, to_buy: toBuy.length,
      without_supplier: toBuy.filter((i) => i.supplier_id === null).length,
      value: formatScaled(toBuy.reduce((t, i) => t + (i.value === null ? 0n : toScaled(i.value, 2)), 0n), 2),
    },
  };
});

registerRpc("erp_inbound_replenishment_generate", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  replenishmentAccess(db, user);
  if (!documents.allowed(activeRole(db, user), "purchase_orders", true)) raise("42501", "inbound_replenishment_order_denied");
  const p = input(a);
  if (typeof p.command_id !== "string" || !UUID.test(p.command_id)) raise("22023", "inbound_command_invalid");
  if (Object.keys(p).some((k) => !["command_id", "warehouse_id", "items"].includes(k))) raise("22023", "inbound_replenishment_invalid");
  const warehouse = warehouseOf(db, uuidOrNull(p.warehouse_id, "inbound_replenishment_invalid"));
  if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 500) raise("22023", "inbound_replenishment_invalid");
  const groups = new Map<string, { product_id: string; name: string; unit: string | null; quantity: string; unit_price: string }[]>();
  const seen = new Set<string>();
  for (const raw of p.items) {
    const i = obj(raw);
    if (Object.keys(i).some((k) => !["product_id", "quantity", "supplier_id", "unit_price"].includes(k))) raise("22023", "inbound_replenishment_invalid");
    const product = uuidOrNull(i.product_id, "inbound_replenishment_invalid");
    if (product === null || seen.has(product)) raise("22023", "inbound_replenishment_invalid");
    seen.add(product);
    if (typeof i.quantity !== "string" || !QTY.test(i.quantity) || toScaled(i.quantity, 6) <= 0n) raise("22023", `inbound_replenishment_quantity_invalid:${product}`);
    const r = one(db, `SELECT r.name, r.active, p.unit, p.kind FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?`, product);
    if (!r || Number(r.active) !== 1 || r.kind !== "P") raise("22023", `inbound_replenishment_product_unavailable:${product}`);
    const fallback = one(db, 'SELECT supplier_id FROM "erp_catalog__product_supplier" WHERE record_id=? ORDER BY is_default DESC, position LIMIT 1', product);
    const supplier = uuidOrNull(i.supplier_id, "inbound_replenishment_invalid") ?? ((fallback?.supplier_id as string | undefined) ?? null);
    if (supplier === null) raise("22023", `inbound_replenishment_supplier_missing:${String(r.name).slice(0, 80)}`);
    if (!one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts' AND active=1`, supplier)) raise("22023", "inbound_supplier_not_found");
    if (i.unit_price !== undefined && i.unit_price !== null && (typeof i.unit_price !== "string" || !PRICE.test(i.unit_price))) raise("22023", "inbound_replenishment_invalid");
    const price = typeof i.unit_price === "string" ? i.unit_price : p10(supplierPrice(db, product, supplier).price) ?? "0";
    const list = groups.get(supplier) ?? [];
    list.push({ product_id: product, name: String(r.name), unit: (r.unit as string | null) ?? null, quantity: q6(toScaled(i.quantity, 6)), unit_price: price });
    groups.set(supplier, list);
  }
  // Um pedido por fornecedor, na ordem do fornecedor: o mesmo comando gera os mesmos comandos de cada pedido.
  const created = [...groups].sort((x, y) => x[0].localeCompare(y[0])).map(([supplier, lines]) => {
    const saved = invokeRpc(ctx, "erp_document_save", {
      p_user_id: user, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: subCommand(p.command_id, `order:${supplier}`),
      p_body: {
        date: todaySaoPaulo(), contact_id: supplier, ...(warehouse ? { warehouse_id: warehouse } : {}),
        items: lines.map((l) => ({ product_id: l.product_id, description: l.name, unit: l.unit, quantity: l.quantity, unit_price: l.unit_price, discount_percent: "0" })),
      },
    }) as { document: Record<string, unknown>; replayed?: boolean };
    const name = one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', supplier)?.name ?? null;
    return { document_id: String(saved.document.id), number: saved.document.number ?? null, supplier_id: supplier, supplier_name: name, items: lines.length, replayed: saved.replayed === true };
  });
  return { scope: "inbound_replenishment_generate", orders: created, replayed: created.every((o) => o.replayed) };
});

registerRpc("erp_inbound_inventory", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  stock.requireAccess(db, user, false);
  const p = input(a);
  const date = typeof p.date === "string" && DAY.test(p.date) && !Number.isNaN(Date.parse(`${p.date}T00:00:00Z`)) ? p.date : raise("22023", "inbound_inventory_date_invalid");
  if (date < "1900-01-01" || date > "2100-12-31") raise("22023", "inbound_inventory_date_invalid");
  const warehouse = warehouseOf(db, uuidOrNull(p.warehouse_id, "inbound_inventory_invalid"));
  if (p.include_zero !== undefined && typeof p.include_zero !== "boolean") raise("22023", "inbound_inventory_invalid");
  // Custo só para quem vê pedidos de compra (a mesma regra dos relatórios do Estoque).
  const cost = stock.costVisible(db, user);
  const sums = new Map<string, bigint>();
  for (const e of db.exec(
    `SELECT e.product_id, e.warehouse_id, CAST(e.quantity AS TEXT) q FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
      WHERE m.occurred_on<=? AND (? IS NULL OR e.warehouse_id=?)`,
    date, warehouse, warehouse,
  ).rows) {
    const key = `${e.product_id}|${e.warehouse_id}`;
    sums.set(key, (sums.get(key) ?? 0n) + fromColumn(e.q));
  }
  const productIds = [...new Set([...sums.keys()].map((k) => k.split("|")[0]))];
  const costs = cost ? stock.averageCosts(db, productIds, date) : new Map<string, bigint | null>();
  const names = new Map<string, Record<string, unknown>>();
  const info = (id: string) => {
    if (!names.has(id)) names.set(id, one(db, `SELECT r.code, r.name, r.entity, p.unit, p.kind FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?`, id) ?? {});
    return names.get(id)!;
  };
  const items = [...sums]
    .filter(([, q]) => p.include_zero === true || q !== 0n)
    .map(([key, q]) => {
      const [product, wh] = key.split("|");
      const pr = info(product), w = info(wh);
      const avg = costs.get(product) ?? null;
      return {
        product_id: product, code: (pr.code as string | null) ?? null, name: String(pr.name ?? "Produto"), unit: (pr.unit as string | null) ?? null,
        warehouse_id: wh, warehouse_name: String(w.name ?? "Depósito"), ignored: stock.ignoredWarehouse(db, wh) as boolean,
        quantity: q6(q), average_cost: cost ? p10(avg) : null, value: cost && avg !== null ? money(q, avg) : null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, "pt-BR") || x.product_id.localeCompare(y.product_id) || x.warehouse_name.localeCompare(y.warehouse_name, "pt-BR"));
  const byWarehouse = new Map<string, { warehouse_id: string; name: string; products: number; value: bigint }>();
  for (const i of items) {
    const g = byWarehouse.get(i.warehouse_id) ?? { warehouse_id: i.warehouse_id, name: i.warehouse_name, products: 0, value: 0n };
    g.products++;
    if (i.value !== null) g.value += toScaled(i.value, 2);
    byWarehouse.set(i.warehouse_id, g);
  }
  return {
    scope: "inbound_inventory", filters: { date, warehouse_id: warehouse, include_zero: p.include_zero === true }, cost_visible: cost,
    cost_basis: (stock.settingsDto(db) as { average_cost_base: string }).average_cost_base,
    warehouses_available: activeWarehouses(db),
    total: items.length, items,
    warehouses: [...byWarehouse.values()].map((w) => ({ warehouse_id: w.warehouse_id, name: w.name, products: w.products, value: cost ? formatScaled(w.value, 2) : null })),
    totals: {
      value: cost ? formatScaled(items.reduce((t, i) => t + (i.value === null ? 0n : toScaled(i.value, 2)), 0n), 2) : null,
      uncosted: cost ? items.filter((i) => i.value === null && i.quantity !== q6(0n)).length : null,
    },
  };
});

export const REPLENISHMENT_RPCS = ["erp_inbound_replenishment", "erp_inbound_replenishment_generate", "erp_inbound_inventory"] as const;
