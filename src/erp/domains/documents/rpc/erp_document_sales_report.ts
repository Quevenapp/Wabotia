// public.erp_document_sales_report (Relatório de vendas: agrupado por contato, produto, vendedor ou
// bairro, com subgrupo, filtros e lucro) e erp_document_sales_report_options (as listas do filtro).
// Valores exatos em BigInt: quantidade na escala 6, valores na escala 10, custo na escala 16; o
// texto sai como o numeric do Postgres (soma com a maior escala das parcelas; ::numeric(20,2); round(,2)).
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgLeft, pgLower, pgUpper } from "../../../engine/text.ts";
import { contactScope, contactVisibleTo, productCostAt } from "../../catalog/public.ts";
import * as stock from "../../stock/public.ts";
import { dateValue, textValue, uuidValue, unavailableParts } from "../internal.ts";
import { erpFieldRequirement, erpOperationRequirement, erpRequirement, erpRequirementMet } from "../../../parts-requirements.ts";
import { requireErpParts } from "../../../engine/parts-gate.ts";
import { reportCoverage } from "../mirror-reads.ts";
import { transitions } from "../preferences.ts";
import { reportLastPurchaseUntil } from "../public.ts";
import { requireAccess } from "../reads-g.ts";

type Row = Record<string, unknown>;
const st = stock;

const has = (o: unknown, k: string) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);
const parse = (v: unknown): Row => (v === null || v === undefined ? {} : typeof v === "string" ? JSON.parse(v) : (v as Row));
/** O ->> do jsonb. */
const arrowText = (o: unknown, k: string): string | null => {
  if (!has(o, k)) return null;
  const v = (o as Row)[k];
  return v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
/** O #>> do jsonb. */
const pathText = (o: unknown, ...keys: string[]): string | null => {
  let v: unknown = o;
  for (const k of keys) {
    if (!has(v, k)) return null;
    v = (v as Row)[k];
  }
  return v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
const UUID_I = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = () => raise("22023", "erp_document_report_invalid");
const days = (a: string, b: string) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000;
const lessText = (a: string | null, b: string | null) => a !== null && b !== null && pgCompareText(a, b) < 0;
const betweenText = (v: string | null, from: string, to: string) => v !== null && pgCompareText(v, from) >= 0 && pgCompareText(v, to) <= 0;
const minText = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : pgCompareText(b, a) < 0 ? b : a);
const ACTIVE = (db: SqlDriver, user: string, roles: string[]) =>
  !!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role IN (${roles.map(() => "?").join(",")})`, user, ...roles);

/** erp_documents.report_uuid_list(valor, máx) */
function reportUuidList(value: unknown, max: number): string[] | null {
  if (value === undefined || value === null) return null;
  const list = value as unknown[];
  if (jsonType(value) !== "array" || list.length > max || list.some((x) => typeof x !== "string" || !UUID_I.test(x)) || new Set(list.map((x) => pgLower(x as string))).size !== list.length)
    invalid();
  return list.map((x) => (x as string).toLowerCase());
}

/** erp_documents.report_seller(corpo) */
const reportSeller = (body: Row) => {
  const label = pathText(body, "commercial", "seller_reference", "label");
  if (label !== null && pgBtrim(label) !== "") return pgBtrim(label);
  const source = pathText(body, "commercial", "seller_reference", "source_id");
  return source !== null ? `Vendedor Origin ${source}` : null;
};
/** erp_documents.report_seller_key(corpo) */
const reportSellerKey = (body: Row) => {
  const s = arrowText(body, "seller_id");
  return s !== null && UUID_I.test(s) ? `vendedor:${pgLower(s)}` : (reportSeller(body) ?? "");
};
/** erp_documents.report_seller_label(corpo) */
function reportSellerLabel(db: SqlDriver, body: Row) {
  const s = arrowText(body, "seller_id");
  const name =
    s !== null && UUID_I.test(s)
      ? (one(db, 'SELECT r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', s.toLowerCase())?.name as string | undefined)
      : undefined;
  return name !== undefined && name !== null ? pgLeft(name, 300) : (reportSeller(body) ?? "Sem vendedor");
}

/** erp_documents.report_unit_cost(produto, base, até, saldos): na escala 10. */
function reportUnitCost(db: SqlDriver, product: string | null, base: string | null, until: string | null, balances: boolean): bigint | null {
  const dec = (v: string | null | undefined) => (v === null || v === undefined ? null : toScaled(String(v), 10));
  if (product === null) return null;
  // As do Estoque já vêm na escala 10 (numeric(24,10)).
  if (base === "cost") return st.defaultSupplier(db, product)?.cost_price ?? null;
  if (base === "last_purchase") return st.lastPurchase(db, product, balances)?.unit_price ?? null;
  if (base === "last_purchase_until" && until !== null) return reportLastPurchaseUntil(db, product, until, balances);
  if ((base === "cost_until" || base === "applied") && until !== null) return dec(productCostAt(db, product, until));
  return null;
}

/** Número com a escala do numeric do Postgres: a soma fica com a maior escala das parcelas. */
type Qty = { v: bigint; scale: number };
const addQty = (a: Qty | null, b: Qty | null): Qty | null => (a === null ? b : b === null ? a : { v: a.v + b.v, scale: Math.max(a.scale, b.scale) });
const qtyText = (q: Qty | null) => (q === null ? null : formatScaled(rescale(q.v, 6, q.scale), q.scale));
const add = (a: bigint | null, b: bigint | null) => (a === null ? b : b === null ? a : a + b);

type Line = { order: string; contact: string | null; snapshot: Row; body: Row; product: string | null; description: string | null; code: string | null; qty: Qty | null; amount: bigint | null; cost: bigint | null; costless: number };
type Agg = { key: string | null; label: string | null; orders: Set<string>; items: Qty | null; amount: bigint | null; cost: bigint | null };

/** public.erp_document_sales_report */
export function erpDocumentSalesReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  // Texto chega como o texto do jsonb (o Postgres o lê como JSON).
  const filters = a.p_filters === undefined || a.p_filters === null ? null : typeof a.p_filters === "string" ? JSON.parse(a.p_filters) : a.p_filters;
  requireAccess(db, user, "sales_orders", false);
  const KEYS = ["from", "to", "date_type", "group", "subgroup", "order", "statuses", "include_freight", "contact_id", "product_id", "warehouse_id", "city", "state", "without_invoice",
    "first_purchase", "seller_id", "supplier_id", "category_ids", "contact_type_ids", "contact_untyped", "tag_ids", "untagged", "show_profit", "profit_base"];
  if (
    filters === null || jsonType(filters) !== "object" || Object.keys(filters).some((k) => !KEYS.includes(k)) ||
    ["include_freight", "without_invoice", "first_purchase", "contact_untyped", "untagged", "show_profit"].some((k) => has(filters, k) && jsonType(filters[k]) !== "boolean") ||
    ["date_type", "group", "subgroup", "order", "profit_base"].some((k) => has(filters, k) && jsonType(filters[k]) !== "string")
  )
    invalid();
  const f = filters as Row;
  if (f.show_profit === true || f.profit_base != null) requireErpParts(ctx, erpOperationRequirement("margin"));
  if (f.category_ids != null) requireErpParts(ctx, erpFieldRequirement("category_id"));
  if (f.warehouse_id != null) requireErpParts(ctx, erpFieldRequirement("warehouse_id"));
  if (f.without_invoice === true || f.date_type === "invoice") requireErpParts(ctx, erpRequirement("erp-fiscal"));
  const get = (k: string) => (has(f, k) ? f[k] : null);
  const bool = (k: string, d: boolean) => (get(k) === null ? d : (get(k) as boolean));
  const from = dateValue(get("from"), true)!;
  const to = dateValue(get("to"), true)!;
  const group = (get("group") as string | null) ?? "contact";
  const sub = get("subgroup") === "none" ? null : ((get("subgroup") as string | null) ?? null);
  const order = (get("order") as string | null) ?? "name";
  const dateType = (get("date_type") as string | null) ?? "date";
  const freightIn = bool("include_freight", true);
  const without = bool("without_invoice", false);
  const first = bool("first_purchase", false);
  const contact = uuidValue(get("contact_id"));
  const product = uuidValue(get("product_id"));
  const warehouse = uuidValue(get("warehouse_id"));
  const seller = uuidValue(get("seller_id"));
  const supplier = uuidValue(get("supplier_id"));
  const cityText = textValue(get("city"), 100);
  const city = cityText === null ? null : pgLower(cityText);
  const stateText = textValue(get("state"), 2);
  const state = stateText === null ? null : pgUpper(stateText);
  // Tipo de contato e Tags: o filtro existe quando a lista vem; "Sem vínculo" vai junto.
  const types = reportUuidList(get("contact_type_ids"), 100);
  const untyped = bool("contact_untyped", false);
  const tags = reportUuidList(get("tag_ids"), 500);
  const untagged = bool("untagged", false);
  const profit = bool("show_profit", false);
  const base = profit ? ((get("profit_base") as string | null) ?? "cost") : null;
  if ((has(f, "contact_untyped") && types === null) || (has(f, "untagged") && tags === null) || (has(f, "profit_base") && !profit) ||
    (profit && !["cost", "last_purchase", "last_purchase_until", "cost_until", "applied"].includes(base!)))
    invalid();
  let statuses: Set<string> | null = null;
  if (get("statuses") !== null) {
    const list = get("statuses") as unknown[];
    const keys = (transitions() as Row).sales_orders as Row;
    if (jsonType(list) !== "array" || list.length < 1 || list.length > 20 || list.some((s) => typeof s !== "string" || !has(keys, s))) invalid();
    statuses = new Set(list as string[]);
  }
  // Categorias de receitas e despesas: as escolhidas e as subcategorias.
  let categories: Set<string> | null = null;
  if (get("category_ids") !== null) {
    const chosen = reportUuidList(get("category_ids"), 50)!;
    const all = db.exec(`SELECT id, parent_id FROM "erp_finance__category" WHERE kind='receivable'`).rows;
    categories = new Set(all.filter((c) => chosen.includes(String(c.id))).map((c) => String(c.id)));
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of all) if (c.parent_id !== null && categories.has(String(c.parent_id)) && !categories.has(String(c.id))) (categories.add(String(c.id)), (grew = true));
    }
  }
  if (
    from > to || days(from, to) > 731 || !["contact", "product", "seller", "district"].includes(group) ||
    (sub !== null && (!["contact", "product", "seller"].includes(sub) || sub === group)) || !["name", "amount", "items", "sales"].includes(order) ||
    !["date", "expected_date", "invoice"].includes(dateType) ||
    (state !== null && !/^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/.test(state))
  )
    invalid();
  // As notas da Brufap (e os rascunhos) só são lidas por admin e fiscal (113).
  const fiscal = ACTIVE(db, user, ["admin", "fiscal"]);
  if ((without || dateType === "invoice") && !fiscal) raise("42501", "erp_document_access_denied");
  // Custo e preço de compra são dados de compra (145).
  if (profit && !st.costVisible(db, user)) raise("42501", "erp_document_access_denied");
  const balances = st.settingsDto(db).consider_balances === true;
  const itemsMode = group === "product" || sub === "product";
  const itemFilter = product !== null || supplier !== null || tags !== null;
  const scope = contactScope(db, user);

  // base
  const all = db.exec(`SELECT id, contact_id, contact_snapshot, body, total, number, status, warehouse_id FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`).rows;
  const typed = (id: unknown) => db.exec('SELECT type_id FROM "erp_catalog__contact_type_link" WHERE contact_id=?', id).rows.map((r) => String(r.type_id));
  const orders = all.filter((d) => {
    const body = parse(d.body);
    const snap = parse(d.contact_snapshot);
    if (statuses !== null && !statuses.has(String(d.status))) return false;
    if (!contactVisibleTo(db, scope, (d.contact_id as string | null) ?? null)) return false;
    const day =
      dateType === "expected_date" ? arrowText(body, "expected_date")
      : dateType === "invoice"
        ? ((one(db, `SELECT min(n.issue_date) d FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id
              WHERE o.document_id=? AND n.deleted_at IS NULL AND n.direction='1' AND n.status NOT IN (3,10)`, d.id)?.d as string | null) ?? null)
        : arrowText(body, "date");
    if (!betweenText(day, from, to)) return false;
    if (contact !== null && d.contact_id !== contact) return false;
    if (warehouse !== null && d.warehouse_id !== warehouse) return false;
    if (city !== null && !pgLower(arrowText(snap, "city") ?? "").includes(city)) return false;
    if (state !== null && pgUpper(arrowText(snap, "state") ?? "") !== state) return false;
    if (seller !== null) {
      const s = arrowText(body, "seller_id");
      if (s === null || pgLower(s) !== seller) return false;
    }
    if (categories !== null) {
      const c = arrowText(body, "category_id");
      if (c === null || !categories.has(pgLower(c))) return false;
    }
    if (types !== null) {
      const t = typed(d.contact_id);
      if (!t.some((x) => types.includes(x)) && !(untyped && t.length === 0)) return false;
    }
    if (without &&
      (one(db, `SELECT 1 x FROM "erp_fiscal_drafts__draft" WHERE source_document_id=? AND status='draft' LIMIT 1`, d.id) ||
        one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id WHERE o.document_id=? AND n.deleted_at IS NULL LIMIT 1', d.id)))
      return false;
    if (first) {
      if (d.status === "cancelled") return false;
      const dDate = arrowText(body, "date");
      const before = all.some((x) => {
        if (x.contact_id !== d.contact_id || d.contact_id === null || x.status === "cancelled" || x.id === d.id) return false;
        const xDate = arrowText(parse(x.body), "date");
        // (data, número) < (data, número): linha do Postgres; nulo deixa a comparação nula.
        if (xDate === null || dDate === null) return false;
        const c = pgCompareText(xDate, dDate);
        if (c !== 0) return c < 0;
        return x.number !== null && d.number !== null && Number(x.number) < Number(d.number);
      });
      if (before) return false;
    }
    return true;
  });

  // itens
  type Item = { id: string; doc: string; product: string | null; qty: Qty | null; total: bigint | null; data: Row; chosen: boolean };
  const itemsOf = new Map<string, Item[]>();
  for (const d of orders) {
    itemsOf.set(
      String(d.id),
      db.exec('SELECT id, product_id, quantity, total, data FROM "erp_documents__item" WHERE document_id=?', d.id).rows.map((i) => {
        const p = (i.product_id as string | null) ?? null;
        const chosen =
          (product === null || p === product) &&
          (supplier === null || (p !== null && !!one(db, 'SELECT 1 x FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', p, supplier))) &&
          (tags === null ||
            (p !== null && db.exec('SELECT tag_id FROM "erp_catalog__product_tag" WHERE record_id=?', p).rows.some((t) => tags.includes(String(t.tag_id)))) ||
            (untagged && (p === null || !one(db, 'SELECT 1 x FROM "erp_catalog__product_tag" WHERE record_id=?', p))));
        return {
          id: String(i.id), doc: String(d.id), product: p, qty: i.quantity === null ? null : { v: fromColumn(i.quantity), scale: 6 },
          total: i.total === null ? null : fromColumn(i.total) * 10n ** 8n, data: parse(i.data), chosen,
        };
      }),
    );
  }
  const kept = orders.filter((o) => !itemFilter || itemsOf.get(String(o.id))!.some((i) => i.chosen));
  // preço e custo por item
  const priceCache = new Map<string, bigint | null>();
  const priced = new Map<string, { item: Item; cost: bigint | null; costless: boolean }[]>();
  for (const o of kept) {
    const onDate = base !== null && ["last_purchase_until", "cost_until", "applied"].includes(base) ? arrowText(parse(o.body), "date") : null;
    priced.set(
      String(o.id),
      itemsOf.get(String(o.id))!.map((it) => {
        let price: bigint | null = null;
        if (profit && it.product !== null) {
          const key = `${it.product}|${onDate}`;
          if (!priceCache.has(key)) priceCache.set(key, reportUnitCost(db, it.product, base, onDate, balances));
          price = priceCache.get(key)!;
        }
        // 374: Custo aplicado na operação (congelado na confirmação comercial), senão o custo do cadastro na data.
        if (base === "applied") {
          const ac = one(db, 'SELECT unit_cost FROM "erp_documents__item_cost_applied" WHERE item_id=?', it.id);
          if (ac) price = toScaled(String(ac.unit_cost), 10);
        }
        const cost = it.qty === null || price === null ? null : rescale(it.qty.v, 6, 6) * price; // escala 16
        return { item: it, cost, costless: it.product === null || price === null };
      }),
    );
  }
  // linhas
  const lines: Line[] = [];
  for (const o of kept) {
    const body = parse(o.body);
    const snap = parse(o.contact_snapshot);
    const ps = priced.get(String(o.id))!;
    if (itemsMode) {
      for (const p of ps)
        if (p.item.chosen)
          lines.push({
            order: String(o.id), contact: (o.contact_id as string | null) ?? null, snapshot: snap, body, product: p.item.product,
            description: arrowText(p.item.data, "description"), code: arrowText(p.item.data, "code"), qty: p.item.qty, amount: p.item.total,
            cost: profit ? (p.cost ?? 0n) : null, costless: profit && p.costless ? 1 : 0,
          });
    } else {
      const freightText = arrowText(body, "freight");
      const freight = freightText === null ? 0n : toScaled(freightText, 10);
      const qty = ps.reduce<Qty | null>((s, p) => addQty(s, p.item.qty), null) ?? { v: 0n, scale: 0 };
      lines.push({
        order: String(o.id), contact: (o.contact_id as string | null) ?? null, snapshot: snap, body, product: null, description: null, code: null, qty,
        amount: o.total === null ? null : fromColumn(o.total) * 10n ** 8n - (freightIn ? 0n : freight),
        cost: profit ? (ps.reduce<bigint | null>((s, p) => add(s, p.cost), null) ?? 0n) : null,
        costless: profit ? ps.filter((p) => p.costless).length : 0,
      });
    }
  }
  const district = (l: Line) => {
    const a = pathText(l.body, "delivery_address", "district");
    if (a !== null && pgBtrim(a) !== "") return pgBtrim(a);
    const b = arrowText(l.snapshot, "district");
    if (b !== null && pgBtrim(b) !== "") return pgBtrim(b);
    return null;
  };
  const productKey = (l: Line) => l.product ?? (l.description === null ? null : `livre:${pgLower(l.description)}`);
  const productLabel = (l: Line) => (l.description === null ? null : l.description + (l.code !== null ? ` (${l.code})` : ""));
  const keyOf = (dim: string, l: Line): string | null =>
    dim === "contact" ? l.contact : dim === "product" ? productKey(l) : dim === "seller" ? reportSellerKey(l.body) : pgLower(district(l) ?? "");
  const labelOf = (dim: string, l: Line): string | null =>
    dim === "contact" ? arrowText(l.snapshot, "name") : dim === "product" ? productLabel(l) : dim === "seller" ? reportSellerLabel(db, l.body) : (district(l) ?? "Sem bairro");
  const aggregate = (rows: Line[], dim: string) => {
    const m = new Map<string | null, Agg>();
    for (const l of rows) {
      const key = keyOf(dim, l);
      const g = m.get(key) ?? { key, label: null, orders: new Set<string>(), items: null, amount: null, cost: null };
      g.label = minText(g.label, labelOf(dim, l));
      g.orders.add(l.order);
      g.items = addQty(g.items, l.qty);
      g.amount = add(g.amount, l.amount);
      g.cost = add(g.cost, l.cost);
      m.set(key, g);
    }
    return [...m.values()];
  };
  const descNullsLast = (x: bigint | number | null, y: bigint | number | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x > y ? -1 : 1);
  const qtyNum = (q: Qty | null) => (q === null ? null : q.v);
  const ascNullsLast = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : pgCompareText(x, y));
  const rank = (x: Agg, y: Agg) =>
    (order === "amount" ? descNullsLast(x.amount, y.amount) : 0) ||
    (order === "items" ? descNullsLast(qtyNum(x.items), qtyNum(y.items)) : 0) ||
    (order === "sales" ? descNullsLast(x.orders.size, y.orders.size) : 0) ||
    ascNullsLast(x.label === null ? null : pgLower(x.label), y.label === null ? null : pgLower(y.label)) ||
    ascNullsLast(x.key, y.key);
  const r2 = (v: bigint | null) => (v === null ? null : rescale(v, 10, 2));
  const c2 = (v: bigint | null) => (v === null ? null : rescale(v, 16, 2));
  const money = (v: bigint | null) => (v === null ? null : formatScaled(v, 2));
  const out = (g: Agg) => ({
    key: g.key, label: g.label, sales: g.orders.size, items: qtyText(g.items), amount: money(r2(g.amount)),
    cost: profit ? money(c2(g.cost)) : null, profit: profit ? (g.amount === null || g.cost === null ? null : money(r2(g.amount)! - c2(g.cost)!)) : null,
  });
  const groups = aggregate(lines, group).sort(rank);
  const result = groups.slice(0, 2000).map((g) => ({
    ...out(g),
    subgroups:
      sub === null || g.key === null
        ? []
        : aggregate(lines.filter((l) => keyOf(group, l) === g.key), sub).sort(rank).slice(0, 500).map(out),
  }));
  const sumAmount = lines.reduce<bigint | null>((s, l) => add(s, l.amount), null) ?? 0n;
  const sumCost = lines.reduce<bigint | null>((s, l) => add(s, l.cost), null) ?? 0n;
  const totals = {
    sales: kept.length,
    items: qtyText(lines.reduce<Qty | null>((s, l) => addQty(s, l.qty), null)) ?? "0",
    amount: money(r2(sumAmount)),
    cost: profit ? money(c2(sumCost)) : null,
    profit: profit ? money(r2(sumAmount)! - c2(sumCost)!) : null,
    ...(erpRequirementMet(ctx.parts, erpOperationRequirement("margin")) ? { items_without_cost: lines.reduce((s, l) => s + l.costless, 0) } : {}),
  };
  return {
    report: "sales", group, subgroup: sub, from, to, date_type: dateType, item_values: itemsMode, include_freight: freightIn, show_profit: profit, profit_base: base,
    groups: result, group_count: groups.length, truncated: groups.length > 2000, totals, data_mode: "erp_native", operational_effects: false,
    ...unavailableParts(ctx, ["purchases", "stock", "finance", "fiscal"]),
    ...reportCoverage(db, user, "sales_orders", from, to),
  };
}

/** public.erp_document_sales_report_options */
export function erpDocumentSalesReportOptions(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, "sales_orders", false);
  const scope = contactScope(db, user);
  const byPosition = (x: Row, y: Row) => Number(x.position) - Number(y.position) || pgCompareText(String(x.label), String(y.label)) || pgCompareText(String(x.id), String(y.id));
  const types = db
    .exec('SELECT id, label, position FROM "erp_catalog__contact_type" WHERE active=1')
    .rows.sort(byPosition)
    .slice(0, 100)
    .map((t) => ({ id: t.id, label: t.label }));
  const byName = (x: { id: unknown; name: string }, y: { id: unknown; name: string }) => pgCompareText(pgLower(x.name), pgLower(y.name)) || pgCompareText(String(x.id), String(y.id));
  const tags = db
    .exec(`SELECT t.id, t.name, g.name parent FROM "erp_catalog__taxonomy" t LEFT JOIN "erp_catalog__taxonomy" g ON g.id=t.parent_id WHERE t.kind='tags' AND t.tag_type='products'`)
    .rows.map((t) => ({ id: t.id, name: pgLeft(t.parent !== null ? `${t.parent} › ${t.name}` : String(t.name), 200) }))
    .sort(byName);
  // Usuário com escopo de vendedor (267) vê só o próprio vendedor.
  const sellers = db
    .exec('SELECT s.id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE r.active=1')
    .rows.filter((s) => scope === null || s.id === scope)
    .map((s) => ({ id: s.id, name: pgLeft(String(s.name), 200) }))
    .sort(byName);
  return {
    report: "sales_options", contact_types: types, tags: tags.slice(0, 500), tag_count: tags.length, sellers: sellers.slice(0, 500), seller_count: sellers.length,
    profit_visible: erpRequirementMet(ctx.parts, erpOperationRequirement("margin")) && st.costVisible(db, user),
    invoice_visible: ctx.parts.fiscal && ACTIVE(db, user, ["admin", "fiscal"]), data_mode: "erp_native", operational_effects: false,
    ...unavailableParts(ctx, ["purchases", "stock", "finance", "fiscal"]),
  };
}

registerRpc("erp_document_sales_report", erpDocumentSalesReport);
registerRpc("erp_document_sales_report_options", erpDocumentSalesReportOptions);
