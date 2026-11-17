// Meu Negócio: public.erp_home_business_panel e os painéis que ele despacha
// (mensal, diário, pedidos de venda, vendas por vendedor, venda por canal,
// previsão de estoque v1 e v2, margem por pedido, novos e recorrentes,
// atividade da carteira, curva ABC e metas). Valores exatos: centavos em
// bigint de escala 2, quantidades de escala 6, custos unitários como texto
// decimal; arredondamento metade para longe do zero, como o numeric.
// O gatilho guard_goal e a trilha imutável são cumpridos aqui.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { dateArgError, jsonTimestamp, saoPauloMidnight, todaySaoPaulo } from "../../../engine/time.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { requirePermission } from "../../access/public.ts";
import { fold, productCostAt } from "../../catalog/public.ts";
import { allowed as documentsAllowed, reportCoverage, reportLastPurchaseUntil } from "../../documents/public.ts";
import * as preferences from "../public.ts";
import { countPhysical, ignoredWarehouse, priceText, virtualQuantity } from "../../stock/public.ts";
import { json, text, uuid } from "../args.ts";
import { bizCostVisible, bizFreight, bizRole } from "../business-rules.ts";
import { compareText } from "../order.ts";

void saoPauloMidnight;
type Json = Record<string, unknown>;
const invalid = (): never => raise("22023", "erp_home_business_input_invalid");
const denied = (): never => raise("42501", "erp_home_business_access_denied");

// ---------- aritmética exata ----------
const P10 = (n: number) => 10n ** BigInt(n);
/** a/b arredondado metade para longe do zero */
function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a,
    y = b < 0n ? -b : b;
  const q = x / y,
    r = x % y;
  const v = r * 2n >= y ? q + 1n : q;
  return neg ? -v : v;
}
/** erp_home.money */
const money = (c: bigint | null) => formatScaled(c ?? 0n, 2);
/** erp_home.qty */
const qty = (q: bigint | null) => formatScaled(q ?? 0n, 6);
/** erp_home.ratio(part, whole) com part na escala ps e whole na escala ws */
const ratio = (part: bigint | null, ps: number, whole: bigint | null, ws: number) =>
  !whole ? "0.00" : formatScaled(divRound((part ?? 0n) * P10(ws + 2), whole * P10(ps)), 2);
/** erp_home.pct(part, whole) na mesma escala */
const pct = (part: bigint | null, whole: bigint | null) => (!whole ? null : formatScaled(divRound((part ?? 0n) * 10000n, whole), 2));
/** round(quantity*unit_cost, 2) em centavos */
const lineCost = (q6: bigint, unitCost: string) => divRound(q6 * toScaled(unitCost, 10), P10(14));

// ---------- textos ----------
const CNTRL_ALL = new RegExp(PG_CNTRL, "gu");
/** erp_home.biz_text */
const bizText = (t: string | null | undefined, max: number) => {
  const v = pgBtrim(pgLeft(pgBtrim((t ?? "").replace(CNTRL_ALL, " ")), max));
  return v === "" ? null : v;
};
function jp(o: unknown, ...keys: string[]): string | null {
  let v = o;
  for (const k of keys) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Json)[k];
  }
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : jsonbText(v);
}
const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

// ---------- datas ----------
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const diff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function addMonths(d: string, n: number) {
  const x = new Date(`${monthStart(d)}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x.toISOString().slice(0, 10);
}
const monthEnd = (d: string) => addDays(addMonths(d, 1), -1);
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const months = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
};
const today = () => todaySaoPaulo();

// ---------- argumentos (os casts do Postgres em p_args) ----------
function dateOf(args: Json, key: string): string | null {
  const v = jp(args, key);
  if (v === null) return null;
  if (v === "infinity" || v === "-infinity") return v;
  const bad = dateArgError(v);
  if (bad) raise(bad.code, bad.message);
  return v;
}
function uuidOf(args: Json, key: string): string | null {
  const v = jp(args, key);
  if (v === null) return null;
  const s = v.trim().replace(/^\{|\}$/g, "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) raise("22P02", `invalid input syntax for type uuid: "${v}"`);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function boolOf(args: Json, key: string): boolean | null {
  const v = jp(args, key);
  if (v === null) return null;
  const s = v.trim().toLowerCase();
  if (["t", "tr", "tru", "true", "y", "ye", "yes", "on", "1"].includes(s)) return true;
  if (["f", "fa", "fal", "fals", "false", "n", "no", "of", "off", "0"].includes(s)) return false;
  return raise("22P02", `invalid input syntax for type boolean: "${v}"`);
}
function intOf(args: Json, key: string): number | null {
  const v = jp(args, key);
  if (v === null) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(v)) raise("22P02", `invalid input syntax for type integer: "${v}"`);
  const n = Number(v.trim());
  if (n > 2147483647 || n < -2147483648) raise("22003", "value \"" + v + "\" is out of range for type integer");
  return n;
}

// ---------- regras ----------

const STATUS_ORDER = ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"];
/** erp_home.biz_statuses */
function bizStatuses(list: (string | null)[] | null): string[] {
  if (list === null || list.length < 1 || list.length > 7 || list.includes(null) || new Set(list).size !== list.length || list.some((s) => !STATUS_ORDER.includes(s!)))
    invalid();
  return STATUS_ORDER.filter((s) => list!.includes(s));
}
function statusesJson(p: unknown): string[] {
  if (p === null || p === undefined || jsonType(p) !== "array" || (p as unknown[]).some((x) => jsonType(x) !== "string")) invalid();
  return bizStatuses(p as string[]);
}
/** erp_home.biz_finished */
function bizFinished(db: SqlDriver): string[] {
  const d = one(db, `SELECT default_value FROM "erp_preferences__definition" WHERE key='negocio.situacoes_finalizado'`);
  if (!d) return bizStatuses(null);
  const def = parse(d.default_value);
  const v = preferences.get(db, "negocio.situacoes_finalizado") ?? def;
  const arr = Array.isArray(v) && v.length > 0 ? v : def;
  return bizStatuses((arr as unknown[]).map((x) => (typeof x === "string" ? x : x === null ? null : jsonbText(x))));
}
/** erp_home.biz_period */
function bizPeriod(from: string | null, to: string | null, max = 732) {
  if (from === null || to === null || /infinity/.test(from) || /infinity/.test(to) || from > to || diff(from, to) >= max || from < "2000-01-01" || to > "2100-12-31")
    invalid();
}
const costVisible = (role: string) => bizCostVisible(role);
const stockVisible = (role: string) => ["admin", "consulta", "estoque", "vendas", "fiscal"].includes(role);
/** erp_home.biz_tax_rate (escala 2) */
function taxRate(db: SqlDriver): bigint {
  const v = preferences.get(db, "negocio.aliquota_imposto");
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/.test(v)) return 0n;
  const r = toScaled(v, 2);
  return r <= 10000n ? r : 0n;
}
/** erp_home.biz_tax(revenue) em centavos */
const bizTax = (rev: bigint, rate: bigint) => divRound(rev * rate, 10000n);

interface Order {
  id: string;
  number: number;
  day: string;
  status: string;
  contact_id: string | null;
  contact_name: string;
  channel: string;
  seller: string | null;
  state: string | null;
  total: bigint;
  freight: bigint;
  units: bigint;
  warehouse_id: string | null;
}
const UF = /^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO|EX)$/;
/** erp_home.biz_seller */
const bizSeller = (body: unknown) => {
  const label = bizText(jp(body, "commercial", "seller_reference", "label"), 80);
  if (label !== null) return label;
  const id = jp(body, "commercial", "seller_reference", "source_id");
  return id === null ? null : "Vendedor " + pgLeft(id, 40);
};

class Panel {
  private orderCache = new Map<string, Order[]>();
  private linesCache = new Map<string, Line[]>();
  rate: bigint;
  ctx: RpcContext;
  constructor(ctx: RpcContext) {
    this.ctx = ctx;
    this.rate = taxRate(ctx.db);
  }
  get db() {
    return this.ctx.db;
  }
  /** erp_home.biz_orders */
  orders(from: string, to: string, statuses: string[]): Order[] {
    const key = `${from}|${to}|${statuses.join(",")}`;
    const hit = this.orderCache.get(key);
    if (hit) return hit;
    const out: Order[] = [];
    for (const d of this.db.exec(
      `SELECT d.id, d.number, d.status, d.contact_id, d.contact_snapshot, d.body, CAST(d.total AS TEXT) total, d.warehouse_id,
        (SELECT CAST(coalesce(sum(i.quantity),0) AS TEXT) FROM "erp_documents__item" i WHERE i.document_id=d.id) units
       FROM "erp_documents__document" d WHERE d.authority='brufap' AND d.kind='sales_orders' AND d.deleted_at IS NULL`,
    ).rows) {
      if (!statuses.includes(String(d.status))) continue;
      const body = parse(d.body);
      const date = jp(body, "date");
      if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
      const snap = parse(d.contact_snapshot);
      const st = pgBtrim(((jp(body, "delivery_address", "state") || null) ?? jp(snap, "state") ?? "").toUpperCase());
      out.push({
        id: String(d.id),
        number: Number(d.number),
        day: date,
        status: String(d.status),
        contact_id: (d.contact_id as string | null) ?? null,
        contact_name: bizText(jp(snap, "name"), 200) ?? "Contato sem nome",
        channel:
          bizText(jp(body, "commercial", "store_reference", "label"), 80) ??
          (jp(body, "commercial", "store_reference", "source_id") === null ? "Pedido Manual" : "Loja " + pgLeft(jp(body, "commercial", "store_reference", "source_id")!, 40)),
        seller: bizSeller(body),
        state: UF.test(st) ? st : null,
        total: fromColumn(d.total),
        freight: bizFreight(body),
        units: fromColumn(d.units),
        warehouse_id: (d.warehouse_id as string | null) ?? null,
      });
    }
    this.orderCache.set(key, out);
    return out;
  }
  /** erp_home.biz_lines */
  lines(from: string, to: string, statuses: string[]): Line[] {
    const key = `${from}|${to}|${statuses.join(",")}`;
    const hit = this.linesCache.get(key);
    if (hit) return hit;
    const out: Line[] = [];
    for (const o of this.orders(from, to, statuses))
      for (const i of this.db.exec(
        `SELECT i.id, i.product_id, i.product_snapshot, i.data, CAST(i.quantity AS TEXT) q, CAST(i.total AS TEXT) t, r.code, r.name, p.brand,
          (SELECT a.unit_cost FROM "erp_documents__item_cost_applied" a WHERE a.item_id=i.id) applied
         FROM "erp_documents__item" i LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
         WHERE i.document_id=?`,
        o.id,
      ).rows) {
        const data = parse(i.data);
        const desc = bizText(jp(data, "description"), 200);
        const product = (i.product_id as string | null) ?? null;
        let cost: string | null = null;
        if (product !== null)
          cost =
            (i.applied as string | null) ??
            productCostAt(this.db, product, o.day) ??
            // reportLastPurchaseUntil devolve bigint na escala 10 (Documentos); o texto sai pelo priceText do Estoque.
            priceText((reportLastPurchaseUntil(this.db, product, o.day, false) as unknown as bigint | null) ?? null);
        out.push({
          document_id: o.id,
          day: o.day,
          contact_id: o.contact_id,
          channel: o.channel,
          seller: o.seller,
          product_key: product ?? "d:" + pgLower(desc ?? ""),
          product_id: product,
          code: bizText(i.code as string | null, 60) ?? bizText(jp(parse(i.product_snapshot), "code"), 60),
          name: desc ?? bizText(i.name as string | null, 200) ?? "Item sem descrição",
          brand: bizText(i.brand as string | null, 100),
          quantity: fromColumn(i.q),
          total: fromColumn(i.t),
          unit_cost: cost,
        });
      }
    this.linesCache.set(key, out);
    return out;
  }
  envelope(panel: string, role: string, filters: Json) {
    return {
      scope: "business_dashboard",
      data_mode: "erp_native",
      panel,
      role,
      as_of: jsonTimestamp((BigInt(Date.now()) * 1000n).toString()),
      business_date: today(),
      cost_visible: costVisible(role),
      stock_visible: stockVisible(role),
      filters,
    };
  }
  kpis(from: string, to: string, s: string[]) {
    const o = this.orders(from, to, s);
    const total = o.reduce((a, x) => a + x.total, 0n);
    return { total: money(total), orders: o.length, units: qty(o.reduce((a, x) => a + x.units, 0n)), ticket: ratio(total, 2, BigInt(o.length), 0) };
  }
  daySeries(from: string, to: string, s: string[]) {
    const o = this.orders(from, to, s);
    return days(from, to).map((d) => {
      const hit = o.filter((x) => x.day === d);
      return { day: d, orders: hit.length, total: money(hit.length ? hit.reduce((a, x) => a + x.total, 0n) : null) };
    });
  }
  statusRows(rows: Order[], s: string[]) {
    return s.map((st) => {
      const hit = rows.filter((x) => x.status === st);
      return { status: st, orders: hit.length, total: money(hit.length ? hit.reduce((a, x) => a + x.total, 0n) : null) };
    });
  }
  indicators(from: string, to: string, s: string[], cost: boolean) {
    const o = this.orders(from, to, s);
    const revenue = o.reduce((a, x) => a + x.total - x.freight, 0n);
    const taxes = o.reduce((a, x) => a + bizTax(x.total - x.freight, this.rate), 0n);
    let c = 0n,
      missing = 0;
    if (cost)
      for (const l of this.lines(from, to, s)) {
        if (l.unit_cost === null) missing++;
        else c += lineCost(l.quantity, l.unit_cost);
      }
    return {
      revenue_without_freight: money(revenue),
      cost: cost ? money(c) : null,
      gross_margin: cost ? money(revenue - c) : null,
      gross_margin_pct: cost ? pct(revenue - c, revenue) : null,
      lines_without_cost: cost ? missing : null,
      taxes: money(taxes),
      fees: null,
      profit: cost ? money(revenue - c - taxes) : null,
    };
  }
  channels(from: string, to: string, s: string[]) {
    const g = new Map<string, { orders: number; total: bigint }>();
    for (const o of this.orders(from, to, s)) {
      const x = g.get(o.channel) ?? { orders: 0, total: 0n };
      x.orders++;
      x.total += o.total;
      g.set(o.channel, x);
    }
    return [...g.entries()]
      .sort((a, b) => cmpBig(b[1].total, a[1].total) || compareText(a[0], b[0]))
      .slice(0, 50)
      .map(([channel, x]) => ({ channel, orders: x.orders, total: money(x.total) }));
  }
  /** agrupa linhas por product_key (biz_products e os painéis por produto) */
  groupProducts(lines: Line[]) {
    const g = new Map<string, ProductGroup>();
    for (const l of lines) {
      const x = g.get(l.product_key) ?? { product_key: l.product_key, product_id: l.product_id, code: null, name: null, units: 0n, total: 0n, cost: null, missing: false };
      if (l.code !== null && (x.code === null || compareText(l.code, x.code) > 0)) x.code = l.code;
      if (x.name === null || compareText(l.name, x.name) > 0) x.name = l.name;
      x.units += l.quantity;
      x.total += l.total;
      if (l.unit_cost === null) x.missing = true;
      else x.cost = (x.cost ?? 0n) + lineCost(l.quantity, l.unit_cost);
      g.set(l.product_key, x);
    }
    return [...g.values()];
  }
  products(from: string, to: string, s: string[], cost: boolean, stock: boolean, limit: number, brand: string | null = null) {
    const b = brand === null ? null : pgBtrim(brand);
    const lines = this.lines(from, to, s).filter((l) => !b || pgLower(l.brand ?? "").includes(pgLower(b)));
    return this.groupProducts(lines)
      .sort(byProduct)
      .slice(0, limit)
      .map((x) => ({
        product_id: x.product_id,
        code: x.code,
        name: x.name,
        units: qty(x.units),
        total: money(x.total),
        cost: cost && !x.missing ? money(x.cost) : null,
        margin_pct: cost && !x.missing ? pct(x.total - (x.cost ?? 0n), x.total) : null,
        stock: stock && x.product_id !== null ? qty(fromColumn(countPhysical(this.db, x.product_id, null))) : null,
      }));
  }
  goalAchieved(g: Json) {
    return this.orders(String(g.start_on), String(g.end_on), bizFinished(this.db))
      .filter((o) => g.segment === "geral" || o.seller === g.seller)
      .reduce((a, o) => a + o.total, 0n);
  }
  goalDto(g: Json) {
    return {
      id: g.id,
      name: g.name,
      start_on: g.start_on,
      end_on: g.end_on,
      segment: g.segment,
      seller: g.seller,
      target: money(fromColumn(g.target)),
      achieved: money(this.goalAchieved(g)),
      active: Number(g.active) === 1,
      version: Number(g.version),
      updated_at: jsonTimestamp(String(g.updated_at)),
    };
  }
  goalsJson(running: boolean, limit: number) {
    const t = today();
    return this.db
      .exec('SELECT id, name, start_on, end_on, segment, seller, CAST(target AS TEXT) target, active, version, CAST(updated_at AS TEXT) updated_at FROM "erp_home__goal"')
      .rows.filter((g) => (Number(g.active) === 1 && String(g.end_on) >= t) === running)
      .sort(
        (x, y) =>
          compareText(String(x.end_on), String(y.end_on)) ||
          compareText(String(x.start_on), String(y.start_on)) ||
          compareText(String(x.name), String(y.name)) ||
          compareText(String(x.id), String(y.id)),
      )
      .slice(0, limit)
      .map((g) => this.goalDto(g));
  }
}

interface Line {
  document_id: string;
  day: string;
  contact_id: string | null;
  channel: string;
  seller: string | null;
  product_key: string;
  product_id: string | null;
  code: string | null;
  name: string;
  brand: string | null;
  quantity: bigint;
  total: bigint;
  unit_cost: string | null;
}
interface ProductGroup {
  product_key: string;
  product_id: string | null;
  code: string | null;
  name: string | null;
  units: bigint;
  total: bigint;
  cost: bigint | null;
  missing: boolean;
}
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const byProduct = (x: ProductGroup, y: ProductGroup) =>
  cmpBig(y.total, x.total) || cmpBig(y.units, x.units) || compareText(x.name ?? "", y.name ?? "") || compareText(x.product_key, y.product_key);
const sum = <T>(rows: T[], f: (r: T) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
const sumOrNull = <T>(rows: T[], f: (r: T) => bigint) => (rows.length ? sum(rows, f) : null);

/** erp_home.biz_fit: corta a lista quando o JSON passa do orçamento (bytes). */
function fit<T>(list: T[], budget: number): T[] {
  let acc = 0;
  const out: T[] = [];
  for (const v of list) {
    acc += Buffer.byteLength(jsonbText(v), "utf8") + 2;
    if (acc > budget) break;
    out.push(v);
  }
  return out;
}

function productRows(pn: Panel, lines: Line[], cost: boolean, limit: number) {
  return pn
    .groupProducts(lines)
    .sort(byProduct)
    .slice(0, limit)
    .map((x) => ({
      product_id: x.product_id,
      code: x.code,
      name: x.name,
      units: qty(x.units),
      total: money(x.total),
      cost: cost && !x.missing ? money(x.cost) : null,
      margin_pct: cost && !x.missing ? pct(x.total - (x.cost ?? 0n), x.total) : null,
      stock: null,
    }));
}

// ---------- painéis ----------
function monthly(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null, cf: string | null, ct: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(from, to, 366);
  if ((cf === null) !== (ct === null)) invalid();
  if (cf !== null) bizPeriod(cf, ct, 366);
  const cost = costVisible(role),
    stock = stockVisible(role);
  const year = `${to!.slice(0, 4)}-01-01`;
  const span = diff(from!, to!) + 1;
  const top = pn.products(from!, to!, s, false, stock, 10).map((x) => {
    let forecast: number | null = null;
    if (x.stock !== null && toScaled(x.units, 6) > 0n) {
      const st = toScaled(x.stock, 6);
      const v = ((st > 0n ? st : 0n) * BigInt(span)) / toScaled(x.units, 6);
      forecast = v > 2147483647n ? 2147483647 : Number(v);
    }
    return { ...x, forecast_days: forecast };
  });
  return {
    ...pn.envelope("mensal", role, { statuses: s, from, to, compare_from: cf, compare_to: ct }),
    kpis: { current: pn.kpis(from!, to!, s), previous: cf !== null ? pn.kpis(cf, ct!, s) : null },
    daily: { current: pn.daySeries(from!, to!, s), previous: cf !== null ? pn.daySeries(cf, ct!, s) : [] },
    statuses: pn.statusRows(pn.orders(from!, to!, s), s),
    indicators: pn.indicators(from!, to!, s, cost),
    channels: pn.channels(from!, to!, s),
    top_skus: top,
    months: months(addMonths(to!, -11), to!).map((m) => ({ month: m.slice(0, 7), total: money(sumOrNull(pn.orders(m, monthEnd(m), s), (o) => o.total)) })),
    annual: pn.kpis(year, `${to!.slice(0, 4)}-12-31`, s),
    goals: pn.goalsJson(true, 20),
    ...reportCoverage(),
  };
}

function daily(pn: Panel, user: string | null, statuses: unknown, day: string | null, compare: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(day, day, 1);
  if (compare !== null) bizPeriod(compare, compare, 1);
  const newCustomers = (d: string) => {
    const before = new Set(
      pn.db
        .exec(`SELECT contact_id, status, body FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`)
        .rows.filter((x) => {
          const date = jp(parse(x.body), "date");
          return s.includes(String(x.status)) && date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < d;
        })
        .map((x) => x.contact_id),
    );
    return new Set(pn.orders(d, d, s).filter((o) => !before.has(o.contact_id)).map((o) => o.contact_id)).size;
  };
  return {
    ...pn.envelope("diario", role, { statuses: s, day, compare_day: compare }),
    kpis: {
      current: { ...pn.kpis(day!, day!, s), new_customers: newCustomers(day!) },
      previous: compare !== null ? { ...pn.kpis(compare, compare, s), new_customers: newCustomers(compare) } : null,
    },
    statuses: pn.statusRows(pn.orders(day!, day!, s), s),
    indicators: pn.indicators(day!, day!, s, costVisible(role)),
    top_skus: pn.products(day!, day!, s, false, stockVisible(role), 10),
  };
}

function ordersPanel(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null, state: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(from, to);
  if (state !== null && !UF.test(state)) invalid();
  const cost = costVisible(role);
  const o = pn.orders(from!, to!, s).filter((x) => state === null || x.state === state);
  const ids = new Set(o.map((x) => x.id));
  const l = pn.lines(from!, to!, s).filter((x) => ids.has(x.document_id));
  const total = sum(o, (x) => x.total);
  const byState = new Map<string | null, Order[]>();
  for (const x of o) byState.set(x.state, [...(byState.get(x.state) ?? []), x]);
  const byChannel = new Map<string, Order[]>();
  for (const x of o) byChannel.set(x.channel, [...(byChannel.get(x.channel) ?? []), x]);
  return {
    ...pn.envelope("pedidos-venda", role, { statuses: s, from, to, state }),
    totals: {
      orders: o.length,
      units: qty(sumOrNull(o, (x) => x.units)),
      total: money(sumOrNull(o, (x) => x.total)),
      freight: money(sumOrNull(o, (x) => x.freight)),
      ticket: ratio(o.length ? total : null, 2, BigInt(o.length), 0),
    },
    statuses: pn.statusRows(o, s),
    by_state: [...byState.entries()]
      .map(([st, rows]) => ({ st, rows, total: sum(rows, (x) => x.total), freight: sum(rows, (x) => x.freight), units: sum(rows, (x) => x.units) }))
      .sort((a, b) => cmpBig(b.total, a.total) || (a.st === null ? (b.st === null ? 0 : 1) : b.st === null ? -1 : compareText(a.st, b.st)))
      .map((x) => ({
        state: x.st,
        orders: x.rows.length,
        units: qty(x.units),
        total: money(x.total),
        freight_avg: ratio(x.freight, 2, BigInt(x.rows.length), 0),
        ticket: ratio(x.total, 2, BigInt(x.rows.length), 0),
      })),
    by_product: fit(productRows(pn, l, cost, 300), 160000),
    by_channel: [...byChannel.entries()]
      .map(([channel, rows]) => {
        const cl = l.filter((x) => x.channel === channel);
        const total = sum(rows, (x) => x.total),
          freight = sum(rows, (x) => x.freight),
          units = sum(rows, (x) => x.units);
        const priced = cl.filter((x) => x.unit_cost !== null);
        const c = priced.length ? sum(priced, (x) => lineCost(x.quantity, x.unit_cost!)) : null;
        const missing = cl.some((x) => x.unit_cost === null);
        const taxes = sum(rows, (x) => bizTax(x.total - x.freight, pn.rate));
        return { channel, rows, total, freight, units, c, missing, taxes };
      })
      .sort((a, b) => cmpBig(b.total, a.total) || compareText(a.channel, b.channel))
      .map((c) => ({
        channel: c.channel,
        orders: c.rows.length,
        ticket: ratio(c.total, 2, BigInt(c.rows.length), 0),
        units: qty(c.units),
        cost: cost && !c.missing ? (c.c === null ? null : money(c.c)) : null,
        total: money(c.total),
        freight: money(c.freight),
        unit_value: ratio(c.total - c.freight, 2, c.units, 6),
        margin_pct: cost && !c.missing ? (c.c === null ? null : pct(c.total - c.freight - c.c, c.total - c.freight)) : null,
        taxes: money(c.taxes),
        fees: null,
        contribution_pct: cost && !c.missing ? pct(c.total - c.freight - (c.c ?? 0n) - c.taxes, c.total - c.freight) : null,
      })),
    ...reportCoverage(),
  };
}

function sellers(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null, seller: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(from, to);
  if (seller !== null && (pgLength(seller) > 80 || pgHasCntrl.test(seller))) invalid();
  const sel = seller === null || pgBtrim(seller) === "" ? null : pgBtrim(seller);
  const cost = costVisible(role);
  const span = diff(from!, to!) + 1;
  const all = pn.orders(from!, to!, s);
  const o = all.filter((x) => sel === null || x.seller === sel);
  const ids = new Set(o.map((x) => x.id));
  const l = pn.lines(from!, to!, s).filter((x) => ids.has(x.document_id));
  const bySeller = new Map<string | null, Order[]>();
  for (const x of o) bySeller.set(x.seller, [...(bySeller.get(x.seller) ?? []), x]);
  return {
    ...pn.envelope("vendas-vendedor", role, { statuses: s, from, to, seller: sel }),
    sellers: [...new Set(all.map((x) => x.seller).filter((x): x is string => x !== null))].sort(compareText).slice(0, 200),
    by_seller: [...bySeller.entries()]
      .map(([sv, rows]) => {
        const sl = l.filter((x) => x.seller === sv);
        const priced = sl.filter((x) => x.unit_cost !== null);
        return {
          sv,
          rows,
          total: sum(rows, (x) => x.total),
          freight: sum(rows, (x) => x.freight),
          units: sum(rows, (x) => x.units),
          c: sum(priced, (x) => lineCost(x.quantity, x.unit_cost!)),
          missing: sl.some((x) => x.unit_cost === null),
        };
      })
      .sort((a, b) => cmpBig(b.total, a.total) || (a.sv === null ? (b.sv === null ? 0 : 1) : b.sv === null ? -1 : compareText(a.sv, b.sv)))
      .map((x) => ({
        seller: x.sv,
        orders: x.rows.length,
        units: qty(x.units),
        freight: money(x.freight),
        total: money(x.total),
        ticket: ratio(x.total, 2, BigInt(x.rows.length), 0),
        margin_pct: cost && !x.missing ? pct(x.total - x.freight - x.c, x.total - x.freight) : null,
      })),
    by_product: fit(productRows(pn, l, cost, 300), 120000),
    evolution:
      span <= 62
        ? days(from!, to!).map((d) => ({ bucket: d, total: money(sumOrNull(o.filter((x) => x.day === d), (x) => x.total)) }))
        : months(from!, to!).map((m) => ({ bucket: m.slice(0, 7), total: money(sumOrNull(o.filter((x) => x.day.slice(0, 7) === m.slice(0, 7)), (x) => x.total)) })),
    statuses: pn.statusRows(o, s),
    ...reportCoverage(),
  };
}

function channelsPanel(pn: Panel, user: string | null) {
  const role = bizRole(pn.db, user);
  const s = bizFinished(pn.db);
  const end = monthStart(today());
  const start = addMonths(end, -23);
  const last = monthEnd(end);
  const o = pn.orders(start, last, s);
  const g = new Map<string, bigint>();
  for (const x of o) g.set(x.channel, (g.get(x.channel) ?? 0n) + x.total);
  const top = [...g.entries()].sort((a, b) => cmpBig(b[1], a[1]) || compareText(a[0], b[0])).slice(0, 20).map(([c]) => c);
  return {
    ...pn.envelope("venda-canal", role, { statuses: s, from: start, to: last }),
    channels: top,
    months: months(start, end).map((m) => ({
      month: m.slice(0, 7),
      values: top.map((c) => ({ channel: c, total: money(sumOrNull(o.filter((x) => x.channel === c && x.day.slice(0, 7) === m.slice(0, 7)), (x) => x.total)) })),
    })),
    ...reportCoverage(),
  };
}

/** composições vigentes (erp_stock.composition_current) */
function compositionItems(db: SqlDriver, product: string) {
  return db
    .exec(
      `SELECT i.component_id, CAST(i.quantity AS TEXT) q FROM "erp_stock__composition" c JOIN "erp_stock__composition_item" i ON i.product_id=c.product_id AND i.version=c.version
       WHERE c.product_id=?`,
      product,
    )
    .rows.map((r) => ({ component: String(r.component_id), quantity: fromColumn(r.q) }));
}

function forecast(pn: Panel, user: string | null, from: string | null, to: string | null, warehouse: string | null, reserve: boolean | null, mode: string | null, v2: boolean) {
  const role = bizRole(pn.db, user);
  if (!stockVisible(role)) denied();
  bizPeriod(from, to);
  if (reserve === null || (v2 && (mode === null || !["itens", "desmembrados"].includes(mode)))) invalid();
  if (warehouse !== null && !one(pn.db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_home_business_warehouse_not_found");
  const s = bizFinished(pn.db);
  const span = BigInt(diff(from!, to!) + 1);
  const o = pn.orders(from!, to!, s).filter((x) => warehouse === null || x.warehouse_id === warehouse);
  const ids = new Set(o.map((x) => x.id));
  const l = pn.lines(from!, to!, s).filter((x) => ids.has(x.document_id) && x.product_id !== null);
  // itens: cada produto vendido; desmembrados: a composição com estrutura conta como os componentes.
  const x: { product_id: string; code: string | null; name: string; quantity: bigint }[] = [];
  for (const line of l) {
    const items = v2 && mode === "desmembrados" ? compositionItems(pn.db, line.product_id!) : [];
    if (!v2 || mode === "itens" || items.length === 0) x.push({ product_id: line.product_id!, code: line.code, name: line.name, quantity: line.quantity });
    if (v2 && mode === "desmembrados")
      for (const c of items) {
        const r = one(pn.db, 'SELECT code, name FROM "erp_catalog__record" WHERE id=?', c.component);
        if (!r) continue;
        x.push({
          product_id: c.component,
          code: bizText(r.code as string | null, 60),
          name: bizText(r.name as string | null, 200) ?? "Componente sem descrição",
          quantity: divRound(line.quantity * c.quantity, 1000000n),
        });
      }
  }
  const g = new Map<string, { product_id: string; code: string | null; name: string; sold: bigint }>();
  for (const r of x) {
    const e = g.get(r.product_id) ?? { product_id: r.product_id, code: null, name: r.name, sold: 0n };
    if (r.code !== null && (e.code === null || compareText(r.code, e.code) > 0)) e.code = r.code;
    if (compareText(r.name, e.name) > 0) e.name = r.name;
    e.sold += r.quantity;
    g.set(r.product_id, e);
  }
  const p = [...g.values()].sort((a, b) => cmpBig(b.sold, a.sold) || compareText(a.name, b.name) || compareText(a.product_id, b.product_id)).slice(0, 300);
  const reserved = (product: string) =>
    !reserve
      ? 0n
      : sum(
          pn.db
            .exec(
              `SELECT i.warehouse_id, CAST(i.quantity AS TEXT) q FROM "erp_stock__reservation_item" i JOIN "erp_stock__reservation" r ON r.id=i.reservation_id
               WHERE r.state='active' AND i.product_id=?`,
              product,
            )
            .rows.filter((i) => (warehouse !== null ? i.warehouse_id === warehouse : !ignoredWarehouse(pn.db, String(i.warehouse_id)))),
          (i) => fromColumn(i.q),
        );
  const rows = p.map((e) => {
    let composition: string | null = null;
    if (v2) {
      const c = one(
        pn.db,
        `SELECT c.stock_type FROM "erp_stock__composition" c JOIN "erp_catalog__product" k ON k.record_id=c.product_id WHERE c.product_id=? AND k.format='E'`,
        e.product_id,
      );
      composition = c ? String(c.stock_type) : null;
    }
    // A composição Virtual não tem estoque próprio: o estoque é o das composições que os componentes permitem (222).
    const stock =
      composition === "virtual"
        ? (virtualQuantity(pn.db, e.product_id, warehouse) ?? 0n) * 1_000_000n // kits inteiros → escala 6
        : fromColumn(countPhysical(pn.db, e.product_id, warehouse)) - reserved(e.product_id);
    const coverage = e.sold <= 0n ? null : (((stock > 0n ? stock : 0n) * span) / e.sold > 2147483647n ? 2147483647 : Number(((stock > 0n ? stock : 0n) * span) / e.sold));
    return {
      product_id: e.product_id,
      code: e.code,
      name: e.name,
      sold: qty(e.sold),
      per_day: qty(divRound(e.sold, span)),
      stock: qty(stock),
      ...(v2 ? { composition } : {}),
      coverage_days: coverage,
    };
  });
  const byChannel = new Map<string, Order[]>();
  for (const r of o) byChannel.set(r.channel, [...(byChannel.get(r.channel) ?? []), r]);
  const lastDay = diff(from!, to!) > 365 ? addDays(from!, 365) : to!;
  return {
    ...pn.envelope("previsao-estoque", role, { statuses: s, from, to, warehouse_id: warehouse, reserve, ...(v2 ? { mode } : {}) }),
    turnover: fit(rows, 160000),
    by_channel: [...byChannel.entries()]
      .map(([channel, rs]) => ({ channel, orders: rs.length, units: sum(rs, (r) => r.units), total: sum(rs, (r) => r.total) }))
      .sort((a, b) => cmpBig(b.total, a.total) || compareText(a.channel, b.channel))
      .map((c) => ({ channel: c.channel, orders: c.orders, units: qty(c.units), total: money(c.total) })),
    by_day: days(from!, lastDay).map((d) => {
      const hit = o.filter((r) => r.day === d);
      return { day: d, units: qty(sumOrNull(hit, (r) => r.units)), total: money(sumOrNull(hit, (r) => r.total)) };
    }),
    ...reportCoverage(),
  };
}

function margin(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null, tab: string | null) {
  const role = bizRole(pn.db, user);
  if (!costVisible(role)) denied();
  const s = statusesJson(statuses);
  bizPeriod(from, to);
  if (tab === null || !["todos", "lucro", "prejuizo"].includes(tab)) invalid();
  const o = pn.orders(from!, to!, s);
  const lines = pn.lines(from!, to!, s);
  const k = o.map((x) => {
    const dl = lines.filter((l) => l.document_id === x.id);
    const priced = dl.filter((l) => l.unit_cost !== null);
    const cost = priced.length ? sum(priced, (l) => lineCost(l.quantity, l.unit_cost!)) : null;
    const missing = dl.some((l) => l.unit_cost === null);
    const fp = one(pn.db, 'SELECT CAST(amount AS TEXT) a FROM "erp_documents__freight_paid" WHERE document_id=?', x.id);
    const freightPaid = fp ? fromColumn(fp.a) : null;
    const revenue = x.total - x.freight;
    const tax = bizTax(revenue, pn.rate);
    return { ...x, cost, missing, revenue, tax, freightPaid, contribution: missing ? null : x.total - (cost ?? 0n) - (freightPaid ?? 0n) - tax };
  });
  const picked = k.filter((x) => tab === "todos" || (tab === "lucro" && x.contribution !== null && x.contribution >= 0n) || (tab === "prejuizo" && x.contribution !== null && x.contribution < 0n));
  const notMissing = k.filter((x) => !x.missing);
  const lastDay = diff(from!, to!) > 365 ? addDays(from!, 365) : to!;
  return {
    ...pn.envelope("margem-pedido", role, { statuses: s, from, to, tab }),
    indicators: {
      revenue: money(sumOrNull(k, (x) => x.total)),
      ticket: ratio(k.length ? sum(k, (x) => x.total) : null, 2, BigInt(k.length), 0),
      orders: k.length,
      freight_buyer: money(sumOrNull(k, (x) => x.freight)),
      freight_seller: money(sum(k.filter((x) => x.freightPaid !== null), (x) => x.freightPaid!)),
      freight_paid_pending: k.filter((x) => x.freightPaid === null).length,
      cost: money(notMissing.some((x) => x.cost !== null) ? sum(notMissing.filter((x) => x.cost !== null), (x) => x.cost!) : null),
      taxes: money(sumOrNull(k, (x) => x.tax)),
      fees: null,
      contribution: money(notMissing.length ? sum(notMissing, (x) => x.contribution!) : null),
      contribution_pct: pct(
        notMissing.length ? sum(notMissing, (x) => x.contribution!) : null,
        notMissing.length ? sum(notMissing, (x) => x.revenue) : null,
      ),
      orders_without_cost: k.filter((x) => x.missing).length,
    },
    progression: days(from!, lastDay).map((d) => {
      const hit = k.filter((x) => x.day === d);
      const c = hit.filter((x) => x.contribution !== null);
      return { day: d, revenue: money(sumOrNull(hit, (x) => x.revenue)), contribution: money(c.length ? sum(c, (x) => x.contribution!) : null) };
    }),
    total: picked.length,
    orders: fit(
      picked
        .sort((a, b) => compareText(b.day, a.day) || b.number - a.number)
        .slice(0, 500)
        .map((x) => ({
          id: x.id,
          number: String(x.number),
          day: x.day,
          contact: x.contact_name,
          channel: x.channel,
          total: money(x.total),
          freight: money(x.freight),
          freight_paid: x.freightPaid === null ? null : money(x.freightPaid),
          revenue: money(x.revenue),
          cost: x.missing ? null : money(x.cost),
          contribution: x.missing ? null : money(x.contribution),
          contribution_pct: x.missing ? null : pct(x.contribution, x.revenue),
        })),
      160000,
    ),
    ...reportCoverage(),
  };
}

function customers(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(from, to);
  const cost = costVisible(role);
  const earlier = new Set(
    pn.db
      .exec(`SELECT contact_id, status, body FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`)
      .rows.filter((x) => {
        const date = jp(parse(x.body), "date");
        return s.includes(String(x.status)) && date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < from!;
      })
      .map((x) => x.contact_id as string | null),
  );
  const o = pn.orders(from!, to!, s).map((x) => ({ ...x, is_new: !earlier.has(x.contact_id) }));
  const lines = pn.lines(from!, to!, s);
  const cu = new Map<string | null, (typeof o)[number][]>();
  for (const x of o) cu.set(x.contact_id, [...(cu.get(x.contact_id) ?? []), x]);
  const groups = [...cu.entries()].map(([contact, rows]) => {
    const ll = lines.filter((l) => l.contact_id === contact);
    const priced = ll.filter((l) => l.unit_cost !== null);
    const latest = [...rows].sort((a, b) => compareText(b.day, a.day) || b.number - a.number)[0];
    return {
      contact,
      is_new: rows.every((r) => r.is_new),
      name: rows.map((r) => r.contact_name).sort(compareText).at(-1)!,
      orders: rows.length,
      units: sum(rows, (r) => r.units),
      total: sum(rows, (r) => r.total),
      revenue: sum(rows, (r) => r.total - r.freight),
      channel: latest.channel,
      cost: priced.length ? sum(priced, (l) => lineCost(l.quantity, l.unit_cost!)) : null,
      missing: ll.length ? ll.some((l) => l.unit_cost === null) : null,
    };
  });
  const all = groups.length ? sum(groups, (g) => g.total) : null;
  const card = (isNew: boolean) => {
    const gs = groups.filter((g) => g.is_new === isNew);
    const total = gs.length ? sum(gs, (g) => g.total) : null;
    const orders = gs.reduce((a, g) => a + g.orders, 0);
    return {
      customers: gs.length,
      orders,
      total: money(total),
      units: qty(gs.length ? sum(gs, (g) => g.units) : null),
      ticket: ratio(total, 2, gs.length ? BigInt(orders) : null, 0),
      share_pct: pct(total, all),
    };
  };
  return {
    ...pn.envelope("novos-recorrentes", role, { statuses: s, from, to }),
    cards: { recorrentes: card(false), novos: card(true) },
    chart: months(from!, to!).map((m) => {
      const inMonth = o.filter((x) => x.day.slice(0, 7) === m.slice(0, 7));
      return {
        bucket: m.slice(0, 7),
        new: money(sumOrNull(inMonth.filter((x) => x.is_new), (x) => x.total)),
        recurring: money(sumOrNull(inMonth.filter((x) => !x.is_new), (x) => x.total)),
      };
    }),
    total: groups.length,
    customers: fit(
      groups
        .sort((a, b) => cmpBig(b.total, a.total) || compareText(a.name, b.name) || compareText(String(a.contact), String(b.contact)))
        .slice(0, 300)
        .map((g) => {
          const c = g.contact === null ? undefined : one(pn.db, 'SELECT mobile, phone FROM "erp_catalog__contact" WHERE record_id=?', g.contact);
          const mobile = (c?.mobile as string | null) || null;
          return {
            contact_id: g.contact,
            name: g.name,
            kind: g.is_new ? "novo" : "recorrente",
            channel: g.channel,
            orders: g.orders,
            units: qty(g.units),
            total: money(g.total),
            margin_pct: cost && g.missing === false ? pct(g.revenue - (g.cost ?? 0n), g.revenue) : null,
            profit: cost && g.missing === false ? money(g.revenue - (g.cost ?? 0n)) : null,
            mobile: bizText(mobile ?? ((c?.phone as string | null) ?? null), 40),
          };
        }),
      160000,
    ),
    ...reportCoverage(),
  };
}

function portfolio(pn: Panel, user: string | null, from: string | null, to: string | null, brand: string | null, minDays: number | null, keywords: unknown) {
  const role = bizRole(pn.db, user);
  const t = today();
  bizPeriod(from, to, 3661);
  if (keywords === null || keywords === undefined || jsonType(keywords) !== "array" || (keywords as unknown[]).length > 10 || (keywords as unknown[]).some((x) => jsonType(x) !== "string"))
    invalid();
  const kw = keywords as string[];
  if (
    (brand !== null && (pgLength(brand) > 100 || pgHasCntrl.test(brand))) ||
    (minDays !== null && (minDays < 0 || minDays > 36600)) ||
    kw.some((k) => pgLength(k) < 1 || pgLength(k) > 60 || k !== pgBtrim(k) || pgHasCntrl.test(k))
  )
    invalid();
  const s = bizFinished(pn.db);
  const b = brand === null || pgBtrim(brand) === "" ? null : pgBtrim(brand);
  const o = pn.orders(from!, to!, s).filter((x) => {
    if (b !== null) {
      const brands = pn.db
        .exec(`SELECT p.brand FROM "erp_documents__item" i JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.document_id=?`, x.id)
        .rows.map((r) => pgLower((r.brand as string | null) ?? ""));
      if (!brands.some((br) => br.includes(pgLower(b)))) return false;
    }
    if (kw.length === 0) return true;
    // 230: a palavra-chave é uma etiqueta do contato (mesmo nome, sem acento e caixa) ou parte do nome.
    const tags =
      x.contact_id === null
        ? []
        : pn.db
            .exec(`SELECT t.name FROM "erp_catalog__contact_tag" ct JOIN "erp_catalog__taxonomy" t ON t.id=ct.tag_id WHERE ct.record_id=?`, x.contact_id)
            .rows.map((r) => fold(String(r.name)));
    return kw.some((k) => pgLower(x.contact_name).includes(pgLower(k)) || tags.includes(fold(k)));
  });
  const cu = new Map<string | null, Order[]>();
  for (const x of o) cu.set(x.contact_id, [...(cu.get(x.contact_id) ?? []), x]);
  const f = [...cu.entries()]
    .map(([contact, rows]) => {
      const daysSet = [...new Set(rows.map((r) => r.day))].sort();
      return {
        contact,
        name: rows.map((r) => r.contact_name).sort(compareText).at(-1)!,
        orders: rows.length,
        total: sum(rows, (r) => r.total),
        first: daysSet[0],
        last: daysSet.at(-1)!,
        days: daysSet.length,
        idle: diff(daysSet.at(-1)!, t),
      };
    })
    .filter((x) => minDays === null || x.idle >= minDays);
  return {
    ...pn.envelope("atividade-carteira", role, { statuses: s, from, to, brand: b, min_days: minDays, keywords: kw }),
    total: f.length,
    sum: money(f.length ? sum(f, (x) => x.total) : null),
    customers: fit(
      f
        .sort((a, b) => cmpBig(b.total, a.total) || compareText(a.name, b.name) || compareText(String(a.contact), String(b.contact)))
        .slice(0, 500)
        .map((x) => {
          const c = x.contact === null ? undefined : one(pn.db, 'SELECT document, state, email, mobile, phone FROM "erp_catalog__contact" WHERE record_id=?', x.contact);
          return {
            contact_id: x.contact,
            name: x.name,
            orders: x.orders,
            total: money(x.total),
            first_purchase: x.first,
            last_purchase: x.last,
            cycle_days: x.days > 1 ? Number(divRound(BigInt(diff(x.first, x.last)), BigInt(x.days - 1))) : null,
            days_without: Math.max(x.idle, 0),
            document: bizText(c?.document as string | null, 20),
            state: bizText(c?.state as string | null, 2),
            email: bizText(c?.email as string | null, 254),
            mobile: bizText(((c?.mobile as string | null) || null) ?? ((c?.phone as string | null) ?? null), 40),
          };
        }),
      160000,
    ),
    ...reportCoverage(),
  };
}

function abc(pn: Panel, user: string | null, statuses: unknown, from: string | null, to: string | null, brand: string | null) {
  const role = bizRole(pn.db, user);
  const s = statusesJson(statuses);
  bizPeriod(from, to);
  if (brand !== null && (pgLength(brand) > 100 || pgHasCntrl.test(brand))) invalid();
  const b = brand === null || pgBtrim(brand) === "" ? null : pgBtrim(brand);
  const g = pn
    .groupProducts(pn.lines(from!, to!, s).filter((l) => b === null || pgLower(l.brand ?? "").includes(pgLower(b))))
    .sort(byProduct);
  const total = g.length ? sum(g, (x) => x.total) : null;
  let cum = 0n;
  const c = g.map((x, i) => {
    cum += x.total;
    const curve = (total ?? 0n) === 0n ? "C" : i === 0 || cum * 100n <= total! * 80n ? "A" : cum * 100n <= total! * 95n ? "B" : "C";
    return { ...x, cumulative: cum, curve };
  });
  return {
    ...pn.envelope("curva-abc", role, { statuses: s, from, to, brand: b }),
    total: money(total),
    counts: { A: c.filter((x) => x.curve === "A").length, B: c.filter((x) => x.curve === "B").length, C: c.filter((x) => x.curve === "C").length },
    products: fit(
      c.slice(0, 800).map((x) => ({
        product_id: x.product_id,
        code: x.code,
        name: x.name,
        units: qty(x.units),
        total: money(x.total),
        share_pct: pct(x.total, total),
        cumulative_pct: pct(x.cumulative, total),
        curve: x.curve,
      })),
      160000,
    ),
  };
}

function goals(pn: Panel, user: string | null, tab: string | null) {
  const role = bizRole(pn.db, user);
  if (tab === null || !["andamento", "inativas"].includes(tab)) invalid();
  const t = today();
  const running = tab === "andamento";
  const sellersList = [
    ...new Set(
      pn.db
        .exec(`SELECT body FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`)
        .rows.map((d) => bizSeller(parse(d.body)))
        .filter((x): x is string => x !== null),
    ),
  ]
    .sort(compareText)
    .slice(0, 200);
  return {
    scope: "business_goals",
    data_mode: "erp_native",
    role,
    tab,
    can_manage: role === "admin",
    business_date: t,
    statuses: bizFinished(pn.db),
    total: pn.db.exec('SELECT active, end_on FROM "erp_home__goal"').rows.filter((g) => (Number(g.active) === 1 && String(g.end_on) >= t) === running).length,
    items: pn.goalsJson(running, 200),
    sellers: sellersList,
    ...reportCoverage(),
  };
}

const GOAL_COLUMNS = 'id, name, start_on, end_on, segment, seller, CAST(target AS TEXT) target, active, version, CAST(updated_at AS TEXT) updated_at';
const isAdmin = (db: SqlDriver, user: string | null) => !!(user && one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user));
const withoutLive = (d: Json) => {
  const { achieved: _a, updated_at: _u, ...rest } = d;
  return rest;
};

function goalSave(pn: Panel, user: string | null, command: string | null, goalId: string | null, expected: number | null, data: unknown) {
  bizRole(pn.db, user);
  const d = data as Json;
  const keys = data !== null && jsonType(data) === "object" ? jsonbKeys(d).sort(compareText) : null;
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    (goalId === null) !== (expected === 0) ||
    keys === null ||
    keys.join(",") !== "active,end_on,name,segment,seller,start_on,target" ||
    jsonType(d.name) !== "string" ||
    jsonType(d.start_on) !== "string" ||
    jsonType(d.end_on) !== "string" ||
    jsonType(d.segment) !== "string" ||
    !["null", "string"].includes(jsonType(d.seller) ?? "") ||
    jsonType(d.target) !== "string" ||
    jsonType(d.active) !== "boolean" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.start_on as string) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.end_on as string) ||
    !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(d.target as string)
  )
    invalid();
  const name = d.name as string,
    segment = d.segment as string,
    seller = (d.seller as string | null) ?? null,
    target = toScaled(d.target as string, 2),
    active = d.active as boolean;
  const start = d.start_on as string,
    end = d.end_on as string;
  if (dateArgError(start) || dateArgError(end)) invalid();
  if (
    pgLength(name) < 1 ||
    pgLength(name) > 120 ||
    name !== pgBtrim(name) ||
    pgHasCntrl.test(name) ||
    !["geral", "vendedor"].includes(segment) ||
    (segment === "vendedor") !== (seller !== null) ||
    (seller !== null && (pgLength(seller) < 1 || pgLength(seller) > 80 || seller !== pgBtrim(seller) || pgHasCntrl.test(seller))) ||
    target <= 0n ||
    start > end ||
    diff(start, end) > 3660 ||
    start < "2000-01-01" ||
    end > "2100-12-31"
  )
    invalid();
  const db = pn.db;
  const hash = createHash("sha256")
    .update(jsonbText({ profile: "erp-home-goal-v1", actor: user, goal: goalId, version: expected, data }), "utf8")
    .digest("hex");
  const c = one(db, 'SELECT actor, request_hash, result FROM "erp_home__goal_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.request_hash !== hash) raise("40001", "erp_home_goal_command_conflict");
    if (!isAdmin(db, user)) denied();
    const result = JSON.parse(String(c.result)) as Json;
    const g = one(db, `SELECT ${GOAL_COLUMNS} FROM "erp_home__goal" WHERE id=?`, jp(result, "receipt", "goal_id"));
    return { ...result, goal: g ? pn.goalDto(g) : null, replayed: true };
  }
  if (!isAdmin(db, user)) denied();
  const at = pn.ctx.clock.next().toString();
  let id: string;
  let before: Json | null = null;
  if (goalId === null) id = crypto.randomUUID();
  else {
    const g = one(db, `SELECT ${GOAL_COLUMNS} FROM "erp_home__goal" WHERE id=?`, goalId);
    if (!g) raise("P0002", "erp_home_goal_not_found");
    if (Number(g.version) !== expected) raise("40001", "erp_home_goal_version_conflict");
    id = String(g.id);
    before = withoutLive(pn.goalDto(g));
    if (
      g.name === name &&
      g.start_on === start &&
      g.end_on === end &&
      g.segment === segment &&
      ((g.seller as string | null) ?? null) === seller &&
      fromColumn(g.target) === target &&
      (Number(g.active) === 1) === active
    )
      raise("22023", "erp_home_goal_unchanged");
  }
  const result = {
    scope: "business_goal_command",
    data_mode: "erp_native",
    receipt: { command_id: command, goal_id: id, changed_at: jsonTimestamp(at), from_version: expected, to_version: expected! + 1 },
  };
  db.exec('INSERT INTO "erp_home__goal_command"(id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)', command, user, hash, jsonbText(result), at);
  if (goalId === null)
    db.exec(
      `INSERT INTO "erp_home__goal"(id, name, start_on, end_on, segment, seller, target, active, version, created_by, created_at, updated_by, updated_at, command_id)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      id,
      name,
      start,
      end,
      segment,
      seller,
      target.toString(),
      active ? 1 : 0,
      user,
      at,
      user,
      at,
      command,
    );
  else
    db.exec(
      `UPDATE "erp_home__goal" SET name=?, start_on=?, end_on=?, segment=?, seller=?, target=?, active=?, version=version+1, updated_by=?, updated_at=?, command_id=?
       WHERE id=? AND version=?`,
      name,
      start,
      end,
      segment,
      seller,
      target.toString(),
      active ? 1 : 0,
      user,
      at,
      command,
      id,
      expected,
    );
  const g = one(db, `SELECT ${GOAL_COLUMNS} FROM "erp_home__goal" WHERE id=?`, id)!;
  const dto = pn.goalDto(g);
  db.exec(
    'INSERT INTO "erp_home__goal_audit"(command_id, actor, goal_id, before_data, after_data, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    id,
    before === null ? null : jsonbText(before),
    jsonbText(withoutLive(dto)),
    pn.ctx.clock.next().toString(),
  );
  return { ...result, goal: dto, replayed: false };
}

function goalCommand(pn: Panel, user: string | null, command: string | null) {
  bizRole(pn.db, user);
  if (command === null) invalid();
  const c = one(pn.db, 'SELECT actor, result FROM "erp_home__goal_command" WHERE id=?', command);
  if (!c) raise("P0002", "erp_home_goal_command_not_found");
  if (c.actor !== user) denied();
  const result = JSON.parse(String(c.result)) as Json;
  const g = one(pn.db, `SELECT ${GOAL_COLUMNS} FROM "erp_home__goal" WHERE id=?`, jp(result, "receipt", "goal_id"));
  return { ...result, goal: g ? pn.goalDto(g) : null, replayed: true };
}

// ---------- despacho ----------
const PANEL_KEY: Record<string, string> = {
  mensal: "mensal", diario: "diario", "pedidos-venda": "pedidos", "vendas-vendedor": "vendedor", "venda-canal": "canal", "previsao-estoque": "previsao_estoque",
  "margem-pedido": "margem_sku", "novos-recorrentes": "novos_recorrentes", "atividade-carteira": "carteira", "curva-abc": "curva_abc", metas: "metas",
  metas_save: "metas", metas_command: "metas",
};
function panelKeys(panel: string, args: Json): string[] | null {
  switch (panel) {
    case "mensal":
      return ["p_compare_from", "p_compare_to", "p_from", "p_statuses", "p_to"];
    case "diario":
      return ["p_compare_day", "p_day", "p_statuses"];
    case "pedidos-venda":
      return ["p_from", "p_state", "p_statuses", "p_to"];
    case "vendas-vendedor":
      return ["p_from", "p_seller", "p_statuses", "p_to"];
    case "venda-canal":
      return [];
    case "previsao-estoque":
      // 265: com p_mode o painel responde o Giro de Produto v2.
      return "p_mode" in args ? ["p_from", "p_mode", "p_reserve", "p_to", "p_warehouse_id"] : ["p_from", "p_reserve", "p_to", "p_warehouse_id"];
    case "margem-pedido":
      return ["p_from", "p_statuses", "p_tab", "p_to"];
    case "novos-recorrentes":
      return ["p_from", "p_statuses", "p_to"];
    case "atividade-carteira":
      return ["p_brand", "p_from", "p_keywords", "p_min_days", "p_to"];
    case "curva-abc":
      return ["p_brand", "p_from", "p_statuses", "p_to"];
    case "metas":
      return ["p_tab"];
    case "metas_save":
      return ["p_command_id", "p_data", "p_expected_version", "p_goal_id"];
    case "metas_command":
      return ["p_command_id"];
  }
  return null;
}

export function erpHomeBusinessPanel(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const panel = text(a, "p_panel");
  const args = json(a, "p_args") as Json | null;
  const key = panel === null ? undefined : PANEL_KEY[panel];
  const keys = panel === null || args === null || jsonType(args) !== "object" ? null : panelKeys(panel, args);
  if (key === undefined || keys === null || jsonbKeys(args!).sort(compareText).join(",") !== keys.join(",")) invalid();
  const db = ctx.db;
  if (user === null) raise("42501", "erp_access_permission_denied");
  requirePermission(db, user!, "meu_negocio.dashboard");
  requirePermission(db, user!, "meu_negocio.dashboard." + key);
  const pn = new Panel(ctx);
  const A = args!;
  switch (panel) {
    case "mensal":
      return monthly(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"), dateOf(A, "p_compare_from"), dateOf(A, "p_compare_to"));
    case "diario":
      return daily(pn, user, A.p_statuses, dateOf(A, "p_day"), dateOf(A, "p_compare_day"));
    case "pedidos-venda":
      return ordersPanel(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"), jp(A, "p_state"));
    case "vendas-vendedor":
      return sellers(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"), jp(A, "p_seller"));
    case "venda-canal":
      return channelsPanel(pn, user);
    case "previsao-estoque": {
      const v2 = "p_mode" in A;
      const from = dateOf(A, "p_from"),
        to = dateOf(A, "p_to"),
        wh = uuidOf(A, "p_warehouse_id"),
        reserve = boolOf(A, "p_reserve");
      return forecast(pn, user, from, to, wh, reserve, v2 ? jp(A, "p_mode") : null, v2);
    }
    case "margem-pedido":
      return margin(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"), jp(A, "p_tab"));
    case "novos-recorrentes":
      return customers(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"));
    case "atividade-carteira": {
      const from = dateOf(A, "p_from"),
        to = dateOf(A, "p_to");
      return portfolio(pn, user, from, to, jp(A, "p_brand"), intOf(A, "p_min_days"), A.p_keywords);
    }
    case "curva-abc":
      return abc(pn, user, A.p_statuses, dateOf(A, "p_from"), dateOf(A, "p_to"), jp(A, "p_brand"));
    case "metas":
      return goals(pn, user, jp(A, "p_tab"));
    case "metas_save": {
      const command = uuidOf(A, "p_command_id"),
        goal = uuidOf(A, "p_goal_id"),
        version = intOf(A, "p_expected_version");
      return goalSave(pn, user, command, goal, version, A.p_data === undefined ? null : A.p_data);
    }
    default:
      return goalCommand(pn, user, uuidOf(A, "p_command_id"));
  }
}

registerRpc("erp_home_business_panel", erpHomeBusinessPanel);
