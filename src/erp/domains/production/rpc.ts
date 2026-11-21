// Produção (parte Produção, src/erp/parts.ts): a ordem de produção, sem
// função no oráculo (structural.ts, ordem-producao; tabelas da versão 23 em
// schema/engine-tables.ts).
//
// A ordem tem o produto acabado, a quantidade, o depósito dos insumos e o do
// acabado, a data prevista, o responsável e as observações; os insumos vêm da
// composição do produto (quantidade × fator) e podem ser trocados na ordem,
// com perda prevista. O apontamento (conclusão total ou parcial) dá baixa dos
// insumos e entrada do acabado na mesma transação, pelas rotinas do Estoque:
// a saída pelo erp_stock.post (um movimento com todos os insumos, lotes pelo
// vencimento mais próximo) e a entrada pelo erp_stock_launch (ou
// erp_stock_lot_launch com o lote do acabado), com o custo unitário = custo
// médio dos insumos consumidos + custo adicional, ÷ quantidade, que o custo
// médio do Estoque passa a considerar. O estorno usa o erp_stock_reverse nos
// dois movimentos (as guardas do Estoque valem) e não estorna se o acabado já
// saiu do depósito. O planejamento sugere ordens a partir dos pedidos de venda
// em aberto e monta a lista de compras dos insumos que faltam, que vira pedido
// de compra pelo erp_document_save quando Compras está ligado.
import { createHash } from "node:crypto";
import { jsonbArg } from "../../engine/args.ts";
import { fromColumn } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo, validDate } from "../../engine/time.ts";
import { fold } from "../catalog/public.ts";
import { allowed as documentsAllowed } from "../documents/public.ts";
import * as preferences from "../preferences/public.ts";
import * as stock from "../stock/public.ts";
import {
  OPEN_STATUSES, ORDER_STATUSES, STATUS_ACTIONS, STATUS_LABELS, completableStatus, consumption, costText, editableStatus,
  lineCost, parseMoney, parseQuantity, qtyText, shortage, statusAfter, unitCost, type OrderStatus,
} from "./model.ts";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_QTY = 999999999999999999n;
const MAX_VERSION = 2147483646;
const MAX_INPUTS = 100;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Comando derivado (determinístico) de um comando da produção: lançamentos do Estoque e lotes. */
export function derivedCommand(command: string, part: string): string {
  const h = sha256(`erp-production-23:${part}:${command}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : (raise("22023", "erp_production_invalid"), {}));
const args = (v: unknown): Row => (v === null || v === undefined ? {} : obj(jsonbArg(v)));
const has = (o: Row, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const onlyKeys = (o: Row, keys: readonly string[]) => {
  if (Object.keys(o).some((k) => !keys.includes(k))) raise("22023", "erp_production_invalid");
};
function uuidOf(v: unknown, optional = false): string | null {
  if ((v === null || v === undefined || v === "") && optional) return null;
  if (typeof v !== "string" || !UUID.test(v.toLowerCase())) raise("22023", "erp_production_invalid");
  return v.toLowerCase();
}
function textOf(v: unknown, max: number, optional = true): string | null {
  if (v === null || v === undefined) return optional ? null : raise("22023", "erp_production_invalid");
  if (typeof v !== "string" || pgLength(v) > max || pgHasCntrl.test(v.replace(/[\n\r\t]/g, " "))) raise("22023", "erp_production_invalid");
  const t = pgBtrim(v);
  return t === "" ? (optional ? null : raise("22023", "erp_production_invalid")) : t;
}
function dateOf(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "2000-01-01" || v > "2100-12-31") raise("22023", "erp_production_invalid_date");
  return v;
}
function versionOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_VERSION) raise("22023", "erp_production_invalid");
  return v;
}
function positiveQty(v: unknown, code = "erp_production_invalid_quantity"): bigint {
  const q = parseQuantity(v);
  if (q === null || q <= 0n || q > MAX_QTY) raise("22023", code);
  return q;
}
const qty = (v: unknown) => fromColumn(v ?? 0);
const qtyFromText = (v: unknown) => parseQuantity(String(v ?? "0")) ?? 0n;

// ---------------------------------------------------------------------------
// Acesso: o do Estoque (papéis administrador e estoque gravam; consulta,
// vendas e fiscal leem, com a permissão "Controle de estoque").

const requireAccess = (db: SqlDriver, user: string, write: boolean) => stock.requireAccess(db, user, write);
function role(db: SqlDriver, user: string): string | null {
  return (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
}
function canWrite(db: SqlDriver, user: string): boolean {
  try { stock.requireAccess(db, user, true); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Comandos: repetição devolve o mesmo resultado; outro pedido com o mesmo id recusa.

function replay(db: SqlDriver, command: string, user: string, action: string, hash: string): Row | null {
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_production__command" WHERE id=?', command);
  if (!c) {
    if (stock.commandTaken(db, command)) raise("40001", "erp_production_command_conflict");
    return null;
  }
  if (c.actor !== user || c.action !== action || c.request_hash !== hash) raise("40001", "erp_production_command_conflict");
  return { ...(JSON.parse(String(c.result)) as Row), replayed: true };
}
function remember(ctx: RpcContext, command: string, user: string, action: string, hash: string, result: Row) {
  ctx.db.exec('INSERT INTO "erp_production__command"(id, actor, action, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    command, user, action, hash, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
}
const hashOf = (action: string, user: string, data: unknown) => sha256(jsonbText({ profile: "erp-production-23", action, actor: user, data }));

// ---------------------------------------------------------------------------
// Produtos, composição, depósitos e saldos

interface ProductInfo {
  id: string; name: string; code: string | null; unit: string | null; kind: string; format: string; active: boolean; deleted: boolean;
  lot_control: boolean; composition: { stock_type: string; post_mode: string; version: number } | null;
}
function productInfo(db: SqlDriver, id: string): ProductInfo | null {
  const p = one(db,
    `SELECT r.id, r.name, r.code, r.active, p.unit, p.kind, p.format, d.lot_control, d.deleted_at, c.stock_type, c.post_mode, c.version cversion
       FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
       LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id LEFT JOIN "erp_stock__composition" c ON c.product_id=r.id
      WHERE r.id=? AND r.entity='products'`, id);
  if (!p) return null;
  return {
    id: String(p.id), name: String(p.name), code: (p.code as string | null) ?? null, unit: (p.unit as string | null) ?? null,
    kind: String(p.kind), format: String(p.format), active: !!p.active, deleted: p.deleted_at !== null && p.deleted_at !== undefined,
    lot_control: !!p.lot_control,
    composition: p.stock_type ? { stock_type: String(p.stock_type), post_mode: String(p.post_mode), version: Number(p.cversion) } : null,
  };
}
const productRef = (p: ProductInfo | null) => (p ? { id: p.id, name: p.name, code: p.code, unit: p.unit } : null);

/**
 * Por que o produto não pode ser fabricado (null: pode). Composição Virtual
 * não tem saldo próprio; a que lança estoque pelos componentes na venda
 * daria baixa dos insumos duas vezes (na produção e na venda).
 */
export function finishedProblem(p: ProductInfo | null): string | null {
  if (!p) return "not_found";
  if (p.deleted) return "deleted";
  if (p.kind !== "P") return "not_product";
  if (!p.active) return "inactive";
  if (p.unit === null) return "no_unit";
  if (p.format === "V") return "variations";
  if (p.format === "E") {
    if (!p.composition) return "no_composition";
    if (p.composition.stock_type !== "physical") return "virtual";
    if (p.composition.post_mode !== "product") return "kit_components";
  } else if (p.format !== "S") return "not_simple";
  return null;
}
function compositionItems(db: SqlDriver, product: string): { component_id: string; per_unit: bigint }[] {
  return db.exec(
    `SELECT i.component_id, CAST(i.quantity AS TEXT) q FROM "erp_stock__composition" c
       JOIN "erp_stock__composition_item" i ON i.product_id=c.product_id AND i.version=c.version WHERE c.product_id=? ORDER BY i.position`, product,
  ).rows.map((r) => ({ component_id: String(r.component_id), per_unit: fromColumn(r.q) }));
}
function warehouse(db: SqlDriver, id: string) {
  return one(db, `SELECT r.id, r.name, r.active FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id WHERE w.record_id=?`, id);
}
const warehouseRef = (db: SqlDriver, id: string) => {
  const w = warehouse(db, id);
  return w ? { id: w.id, name: w.name, active: !!w.active } : { id, name: null, active: false };
};
function defaultWarehouse(db: SqlDriver): string | null {
  return (one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" LIMIT 1')?.warehouse_id as string | undefined) ?? null;
}
function balance(db: SqlDriver, product: string, wh: string): { quantity: bigint; version: number } {
  const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, wh);
  return b ? { quantity: fromColumn(b.q), version: Number(b.version) } : { quantity: 0n, version: 0 };
}
/** Saldo de todos os depósitos considerados (os ignorados ficam de fora, como no Estoque). */
function totalBalance(db: SqlDriver, product: string): bigint {
  return db.exec('SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product)
    .rows.reduce((s, b) => s + (stock.ignoredWarehouse(db, String(b.warehouse_id)) ? 0n : fromColumn(b.q)), 0n);
}
const availableIn = (db: SqlDriver, product: string, wh: string) => balance(db, product, wh).quantity - stock.reservedQuantity(db, product, wh);
const entryDecimals = (db: SqlDriver) => {
  const v = preferences.get(db, "empresa.decimais_preco_entrada");
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10 ? v : 10;
};
function lotRules(db: SqlDriver) {
  return {
    require_expiry: preferences.get(db, "lotes.validade_obrigatoria") === true,
    require_manufacture: preferences.get(db, "lotes.fabricacao_obrigatoria") === true,
  };
}

// ---------------------------------------------------------------------------
// Ordem

function orderRow(db: SqlDriver, id: string): Row {
  const o = one(db, 'SELECT * FROM "erp_production__order" WHERE id=?', id);
  if (!o) raise("P0002", "erp_production_not_found");
  return o;
}
function inputRows(db: SqlDriver, order: string) {
  return db.exec('SELECT position, product_id, per_unit, loss_percent, from_composition FROM "erp_production__order_input" WHERE order_id=? ORDER BY position', order).rows;
}
const label = (n: unknown) => `OP ${n}`;

function completionDto(db: SqlDriver, c: Row, costs: boolean) {
  const lot = c.lot_id ? one(db, 'SELECT id, code, manufactured_on, expires_on FROM "erp_stock__lot" WHERE id=?', c.lot_id) : null;
  return {
    id: c.id, position: c.position, quantity: c.quantity, occurred_on: c.occurred_on, note: c.note ?? null,
    lot: lot ? { id: lot.id, code: lot.code, manufactured_on: lot.manufactured_on ?? null, expires_on: lot.expires_on ?? null } : null,
    inputs_cost: costs ? c.inputs_cost : null, extra_cost: costs ? c.extra_cost : null, unit_cost: costs ? c.unit_cost : null,
    issue_movement_id: c.issue_movement_id ?? null, receipt_movement_id: c.receipt_movement_id,
    state: c.state, reversed_at: c.reversed_at ? jsonTimestamp(c.reversed_at as number) : null, reverse_reason: c.reverse_reason ?? null,
    created_at: jsonTimestamp(c.created_at as number), actor: c.actor,
    inputs: db.exec('SELECT ci.position, ci.product_id, r.name, r.code, p.unit, ci.quantity, ci.unit_cost, ci.total_cost FROM "erp_production__completion_input" ci JOIN "erp_catalog__record" r ON r.id=ci.product_id JOIN "erp_catalog__product" p ON p.record_id=ci.product_id WHERE ci.completion_id=? ORDER BY ci.position', c.id)
      .rows.map((i) => ({ position: i.position, product_id: i.product_id, name: i.name, code: i.code ?? null, unit: i.unit ?? null, quantity: i.quantity,
        unit_cost: costs ? i.unit_cost ?? null : null, total_cost: costs ? i.total_cost : null })),
  };
}

function orderDto(db: SqlDriver, user: string, id: string) {
  const o = orderRow(db, id);
  const product = productInfo(db, String(o.product_id));
  const quantity = qtyFromText(o.quantity), produced = qtyFromText(o.produced);
  const remaining = quantity > produced ? quantity - produced : 0n;
  const source = String(o.source_warehouse_id);
  const costs = stock.costVisible(db, user);
  const inputs = inputRows(db, id).map((i) => {
    const p = productInfo(db, String(i.product_id));
    const perUnit = qtyFromText(i.per_unit), loss = qtyFromText(i.loss_percent);
    const planned = consumption(perUnit, quantity, loss), pending = consumption(perUnit, remaining, loss);
    const available = availableIn(db, String(i.product_id), source);
    return {
      position: i.position, product_id: i.product_id, name: p?.name ?? null, code: p?.code ?? null, unit: p?.unit ?? null,
      per_unit: i.per_unit, loss_percent: i.loss_percent, from_composition: !!i.from_composition,
      planned: qtyText(planned), pending: qtyText(pending), available: qtyText(available), missing: qtyText(shortage(pending, available)),
      problem: stock.componentProblem(db, String(i.product_id)),
    };
  });
  const completions = db.exec('SELECT * FROM "erp_production__completion" WHERE order_id=? ORDER BY position', id).rows.map((c) => completionDto(db, c, costs));
  return {
    id: o.id, number: o.number, label: label(o.number), status: o.status, status_label: STATUS_LABELS[o.status as OrderStatus] ?? String(o.status),
    product: product ? { ...productRef(product), format: product.format, lot_control: product.lot_control, problem: finishedProblem(product) } : null,
    quantity: o.quantity, produced: o.produced, remaining: qtyText(remaining), unit: o.unit ?? product?.unit ?? null,
    source_warehouse: warehouseRef(db, source), target_warehouse: warehouseRef(db, String(o.target_warehouse_id)),
    planned_on: o.planned_on ?? null, responsible: o.responsible ?? null, notes: o.notes ?? null, origin: o.origin,
    sales_orders: (JSON.parse(String(o.sales_order_ids)) as string[]).map((d) => {
      const doc = one(db, 'SELECT id, number, status FROM "erp_documents__document" WHERE id=?', d);
      return doc ? { id: doc.id, number: doc.number, status: doc.status } : { id: d, number: null, status: null };
    }),
    cancel_reason: o.cancel_reason ?? null, version: o.version,
    created_at: jsonTimestamp(o.created_at as number), updated_at: jsonTimestamp(o.updated_at as number),
    inputs, completions, costs_visible: costs, can_write: canWrite(db, user), negative_allowed: stock.negativeAllowed(db),
    lot_rules: lotRules(db),
  };
}

interface InputLine { product_id: string; per_unit: bigint; loss: bigint; from_composition: boolean }
/** Insumos informados (ou os da composição) conferidos: produto simples ativo com unidade, sem repetir, sem o próprio acabado. */
function readInputs(db: SqlDriver, product: string, value: unknown): InputLine[] {
  const fromComposition = new Map(compositionItems(db, product).map((c) => [c.component_id, c.per_unit]));
  let lines: InputLine[];
  if (value === undefined || value === null) lines = [...fromComposition].map(([id, perUnit]) => ({ product_id: id, per_unit: perUnit, loss: 0n, from_composition: true }));
  else {
    if (!Array.isArray(value) || value.length > MAX_INPUTS) raise("22023", "erp_production_invalid_inputs");
    lines = value.map((raw) => {
      const v = obj(raw);
      onlyKeys(v, ["product_id", "per_unit", "loss_percent"]);
      const id = uuidOf(v.product_id)!;
      const perUnit = positiveQty(v.per_unit, "erp_production_invalid_inputs");
      const loss = v.loss_percent === undefined || v.loss_percent === null || v.loss_percent === "" ? 0n : parseQuantity(v.loss_percent);
      if (loss === null || loss < 0n || loss > 1000n * 10n ** 6n) raise("22023", "erp_production_invalid_loss");
      return { product_id: id, per_unit: perUnit, loss, from_composition: fromComposition.get(id) === perUnit };
    });
  }
  if (new Set(lines.map((l) => l.product_id)).size !== lines.length) raise("22023", "erp_production_duplicate_input");
  for (const l of lines) {
    if (l.product_id === product) raise("22023", "erp_production_input_is_product");
    if (stock.componentProblem(db, l.product_id) !== null) raise("22023", "erp_production_input_unavailable");
  }
  return lines;
}
function writeInputs(ctx: RpcContext, order: string, lines: InputLine[]) {
  ctx.db.exec('DELETE FROM "erp_production__order_input" WHERE order_id=?', order);
  lines.forEach((l, i) => ctx.db.exec(
    'INSERT INTO "erp_production__order_input"(order_id, position, product_id, per_unit, loss_percent, from_composition) VALUES(?,?,?,?,?,?)',
    order, i + 1, l.product_id, qtyText(l.per_unit), qtyText(l.loss), l.from_composition ? 1 : 0,
  ));
}
function requireWarehouse(db: SqlDriver, id: string) {
  const w = warehouse(db, id);
  if (!w) raise("P0002", "erp_production_warehouse_not_found");
  if (!w.active) raise("22023", "erp_production_warehouse_inactive");
}
function requireFinished(db: SqlDriver, id: string): ProductInfo {
  const p = productInfo(db, id);
  const problem = finishedProblem(p);
  if (problem === "not_found") raise("P0002", "erp_production_product_not_found");
  if (problem) raise("22023", `erp_production_product_${problem}`);
  return p!;
}

/** Cria a ordem (já conferida) e devolve o id. */
function insertOrder(ctx: RpcContext, user: string, data: {
  product: ProductInfo; quantity: bigint; source: string; target: string; planned_on: string | null; responsible: string | null; notes: string | null;
  status: OrderStatus; origin: "manual" | "plan"; sales: string[]; inputs: InputLine[];
}) {
  const id = crypto.randomUUID();
  const number = Number(one(ctx.db, 'SELECT coalesce(max(number),0)+1 n FROM "erp_production__order"')!.n);
  const at = ctx.clock.next().toString();
  ctx.db.exec(
    `INSERT INTO "erp_production__order"(id, number, product_id, quantity, produced, unit, source_warehouse_id, target_warehouse_id, planned_on, responsible, notes, status, origin, sales_order_ids, version, created_at, created_by, updated_at, updated_by)
     VALUES(?,?,?,?, '0.000000', ?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
    id, number, data.product.id, qtyText(data.quantity), data.product.unit, data.source, data.target, data.planned_on, data.responsible, data.notes,
    data.status, data.origin, JSON.stringify(data.sales), at, user, at, user,
  );
  writeInputs(ctx, id, data.inputs);
  return id;
}
function bump(ctx: RpcContext, id: string, user: string, set: Row) {
  const keys = Object.keys(set);
  ctx.db.exec(`UPDATE "erp_production__order" SET ${keys.map((k) => `"${k}"=?`).join(", ")}${keys.length ? ", " : ""}version=version+1, updated_at=?, updated_by=? WHERE id=?`,
    ...keys.map((k) => set[k]), ctx.clock.next().toString(), user, id);
}
function lockOrder(db: SqlDriver, id: string, version: number): Row {
  const o = orderRow(db, id);
  if (Number(o.version) !== version) raise("40001", "erp_production_version_conflict");
  return o;
}

// ---------------------------------------------------------------------------
// Leituras

registerRpc("erp_production_options", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireAccess(db, user, false);
  const warehouses = db.exec(`SELECT r.id, r.name, r.active FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id`).rows
    .sort((x, y) => Number(y.active) - Number(x.active) || pgCompareText(fold(String(x.name)), fold(String(y.name))) || pgCompareText(String(x.id), String(y.id)));
  return {
    scope: "production_options", warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, active: !!w.active })),
    default_warehouse_id: defaultWarehouse(db), negative_allowed: stock.negativeAllowed(db), entry_decimals: entryDecimals(db),
    can_write: canWrite(db, user), costs_visible: stock.costVisible(db, user), lot_rules: lotRules(db),
    parts: { sales: ctx.parts.sales === true, purchases: ctx.parts.purchases === true },
    can_purchase: ctx.parts.purchases === true && documentsAllowed(role(db, user), "purchase_orders", true),
    statuses: ORDER_STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] })),
  };
});

registerRpc("erp_production_products", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, input = args(a.p_args);
  requireAccess(db, user, false);
  onlyKeys(input, ["q", "purpose", "exclude"]);
  const q = textOf(input.q, 120, false)!, purpose = input.purpose ?? "finished";
  if (!["finished", "input"].includes(String(purpose))) raise("22023", "erp_production_invalid_query");
  const exclude = uuidOf(input.exclude, true), key = fold(q)!;
  const rows = db.exec(
    `SELECT r.id, r.name, r.code, p.gtin FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
      WHERE r.entity='products' AND r.active=1 AND p.kind='P' AND p.unit IS NOT NULL AND p.format IN ('S','E')
        AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)`,
  ).rows.filter((r) => r.id !== exclude && (fold(String(r.name))!.includes(key) || fold(String(r.code ?? ""))!.includes(key) || r.gtin === q))
    .sort((x, y) => pgCompareText(fold(String(x.name)), fold(String(y.name))) || pgCompareText(String(x.id), String(y.id)));
  const items = rows.map((r) => productInfo(db, String(r.id))!).filter((p) => purpose === "finished" || stock.componentProblem(db, p.id) === null);
  return {
    scope: "production_products", purpose, total: items.length,
    items: items.slice(0, 20).map((p) => ({
      ...productRef(p), format: p.format, lot_control: p.lot_control, has_composition: !!p.composition,
      problem: purpose === "finished" ? finishedProblem(p) : null, stock: qtyText(totalBalance(db, p.id)),
    })),
  };
});

/** O que a ordem nova teria: o produto, se pode ser fabricado e os insumos da composição × quantidade. */
registerRpc("erp_production_composition", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, input = args(a.p_args);
  requireAccess(db, user, false);
  onlyKeys(input, ["product_id", "quantity", "source_warehouse_id"]);
  const id = uuidOf(input.product_id)!, quantity = input.quantity === undefined ? 10n ** 6n : positiveQty(input.quantity);
  const source = uuidOf(input.source_warehouse_id, true) ?? defaultWarehouse(db);
  const p = productInfo(db, id);
  if (!p) raise("P0002", "erp_production_product_not_found");
  return {
    scope: "production_composition", product: { ...productRef(p), format: p.format, lot_control: p.lot_control, composition: p.composition },
    problem: finishedProblem(p), quantity: qtyText(quantity), source_warehouse_id: source,
    inputs: compositionItems(db, id).map((c, i) => {
      const r = productInfo(db, c.component_id);
      const needed = consumption(c.per_unit, quantity, 0n), available = source ? availableIn(db, c.component_id, source) : totalBalance(db, c.component_id);
      return { position: i + 1, product_id: c.component_id, name: r?.name ?? null, code: r?.code ?? null, unit: r?.unit ?? null,
        per_unit: qtyText(c.per_unit), loss_percent: qtyText(0n), from_composition: true, planned: qtyText(needed), available: qtyText(available),
        missing: qtyText(shortage(needed, available)), problem: stock.componentProblem(db, c.component_id) };
    }),
  };
});

registerRpc("erp_production_list", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, input = args(a.p_args);
  requireAccess(db, user, false);
  onlyKeys(input, ["status", "q", "from", "to", "product_id", "page", "per_page"]);
  const status = input.status === undefined || input.status === null || input.status === "" || input.status === "all" ? null : String(input.status);
  if (status !== null && status !== "open" && !(ORDER_STATUSES as readonly string[]).includes(status)) raise("22023", "erp_production_invalid_query");
  const from = dateOf(input.from), to = dateOf(input.to), product = uuidOf(input.product_id, true);
  const q = input.q === undefined || input.q === null || input.q === "" ? null : textOf(input.q, 120, false);
  const page = input.page === undefined ? 1 : Number(input.page), perPage = input.per_page === undefined ? 30 : Number(input.per_page);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100 || (from && to && from > to))
    raise("22023", "erp_production_invalid_query");
  const key = q === null ? null : fold(q)!;
  const rows = db.exec(
    `SELECT o.*, r.name product_name, r.code product_code FROM "erp_production__order" o JOIN "erp_catalog__record" r ON r.id=o.product_id ORDER BY o.number DESC`,
  ).rows.filter((o) =>
    (status === null || (status === "open" ? (OPEN_STATUSES as readonly string[]).includes(String(o.status)) : o.status === status)) &&
    (product === null || o.product_id === product) &&
    (from === null || (o.planned_on !== null && String(o.planned_on) >= from)) && (to === null || (o.planned_on !== null && String(o.planned_on) <= to)) &&
    (key === null || fold(String(o.product_name))!.includes(key) || fold(String(o.product_code ?? ""))!.includes(key) || String(o.number) === q!.replace(/^op\s*/i, "") ||
      fold(String(o.responsible ?? ""))!.includes(key)));
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const o of db.exec('SELECT status, count(*) n FROM "erp_production__order" GROUP BY status').rows) counts[String(o.status)] = Number(o.n);
  return {
    scope: "production_list", total: rows.length, page, per_page: perPage, counts,
    items: rows.slice((page - 1) * perPage, page * perPage).map((o) => ({
      id: o.id, number: o.number, label: label(o.number), status: o.status, status_label: STATUS_LABELS[o.status as OrderStatus] ?? String(o.status),
      product: { id: o.product_id, name: o.product_name, code: o.product_code ?? null }, quantity: o.quantity, produced: o.produced, unit: o.unit ?? null,
      planned_on: o.planned_on ?? null, responsible: o.responsible ?? null, origin: o.origin,
      source_warehouse: warehouseRef(db, String(o.source_warehouse_id)), target_warehouse: warehouseRef(db, String(o.target_warehouse_id)),
      version: o.version, updated_at: jsonTimestamp(o.updated_at as number),
    })),
  };
});

registerRpc("erp_production_get", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, input = args(a.p_args);
  requireAccess(db, user, false);
  onlyKeys(input, ["id"]);
  return { scope: "production_order", order: orderDto(db, user, uuidOf(input.id)!) };
});

// ---------------------------------------------------------------------------
// Criar e editar

registerRpc("erp_production_save", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, true);
  onlyKeys(data, ["id", "expected_version", "product_id", "quantity", "source_warehouse_id", "target_warehouse_id", "planned_on", "responsible", "notes", "inputs", "status"]);
  const hash = hashOf("save", user, data);
  const replayed = replay(db, command, user, "save", hash);
  if (replayed) return replayed;
  const id = uuidOf(data.id, true);
  if (id === null) {
    const product = requireFinished(db, uuidOf(data.product_id)!);
    const quantity = positiveQty(data.quantity);
    const fallback = defaultWarehouse(db);
    const source = uuidOf(data.source_warehouse_id, true) ?? fallback, target = uuidOf(data.target_warehouse_id, true) ?? fallback;
    if (!source || !target) raise("22023", "erp_production_warehouse_required");
    requireWarehouse(db, source); requireWarehouse(db, target);
    const status = data.status === undefined || data.status === null ? "draft" : String(data.status);
    if (!["draft", "released"].includes(status)) raise("22023", "erp_production_invalid");
    const inputs = readInputs(db, product.id, data.inputs);
    const created = insertOrder(ctx, user, {
      product, quantity, source, target, planned_on: dateOf(data.planned_on), responsible: textOf(data.responsible, 120), notes: textOf(data.notes, 2000),
      status: status as OrderStatus, origin: "manual", sales: [], inputs,
    });
    return remember(ctx, command, user, "save", hash, { scope: "production_save", created: true, order: orderDto(db, user, created) });
  }
  const o = lockOrder(db, id, versionOf(data.expected_version));
  if (!editableStatus(String(o.status))) raise("22023", "erp_production_not_editable");
  if (has(data, "status")) raise("22023", "erp_production_invalid");
  const set: Row = {};
  const anyCompletion = !!one(db, 'SELECT 1 x FROM "erp_production__completion" WHERE order_id=? LIMIT 1', id);
  let product = String(o.product_id);
  if (has(data, "product_id") && uuidOf(data.product_id) !== product) {
    if (anyCompletion) raise("22023", "erp_production_product_locked");
    const p = requireFinished(db, uuidOf(data.product_id)!);
    product = p.id; set.product_id = p.id; set.unit = p.unit;
  }
  if (has(data, "quantity")) {
    const q = positiveQty(data.quantity);
    if (q < qtyFromText(o.produced)) raise("22023", "erp_production_quantity_below_produced");
    set.quantity = qtyText(q);
  }
  for (const k of ["source_warehouse_id", "target_warehouse_id"] as const) if (has(data, k)) {
    const w = uuidOf(data[k])!;
    if (w !== o[k]) {
      if (anyCompletion && one(db, `SELECT 1 x FROM "erp_production__completion" WHERE order_id=? AND state='active' LIMIT 1`, id)) raise("22023", "erp_production_warehouse_locked");
      requireWarehouse(db, w); set[k] = w;
    }
  }
  if (has(data, "planned_on")) set.planned_on = dateOf(data.planned_on);
  if (has(data, "responsible")) set.responsible = textOf(data.responsible, 120);
  if (has(data, "notes")) set.notes = textOf(data.notes, 2000);
  if (has(data, "inputs") || set.product_id) writeInputs(ctx, id, readInputs(db, product, has(data, "inputs") ? data.inputs : null));
  bump(ctx, id, user, set);
  return remember(ctx, command, user, "save", hash, { scope: "production_save", created: false, order: orderDto(db, user, id) });
});

registerRpc("erp_production_status", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, true);
  onlyKeys(data, ["id", "expected_version", "action", "reason"]);
  const hash = hashOf("status", user, data);
  const replayed = replay(db, command, user, "status", hash);
  if (replayed) return replayed;
  const id = uuidOf(data.id)!, o = lockOrder(db, id, versionOf(data.expected_version));
  const action = STATUS_ACTIONS[String(data.action)];
  if (!action) raise("22023", "erp_production_invalid");
  if (!action.from.includes(o.status as OrderStatus)) raise("22023", "erp_production_status_invalid");
  const set: Row = { status: action.to };
  if (data.action === "cancel") {
    const reason = textOf(data.reason, 500, false)!;
    if (pgLength(reason) < 3) raise("22023", "erp_production_reason_required");
    if (one(db, `SELECT 1 x FROM "erp_production__completion" WHERE order_id=? AND state='active' LIMIT 1`, id)) raise("22023", "erp_production_has_completions");
    set.cancel_reason = reason;
  }
  if (data.action === "finish" && qtyFromText(o.produced) <= 0n) raise("22023", "erp_production_nothing_produced");
  bump(ctx, id, user, set);
  return remember(ctx, command, user, "status", hash, { scope: "production_status", action: data.action, order: orderDto(db, user, id) });
});

// ---------------------------------------------------------------------------
// Apontamento: prévia e conclusão

interface PlanLine { product_id: string; name: string | null; code: string | null; unit: string | null; quantity: bigint; available: bigint; balance: bigint; cost: bigint | null; lot_control: boolean }

/** As linhas de consumo do apontamento: as da ordem (ou as quantidades informadas para elas), com saldo e custo médio. */
function consumptionLines(db: SqlDriver, o: Row, quantity: bigint, override: unknown): PlanLine[] {
  const source = String(o.source_warehouse_id);
  const inputs = inputRows(db, String(o.id));
  const given = new Map<string, bigint>();
  if (override !== undefined && override !== null) {
    if (!Array.isArray(override) || override.length > MAX_INPUTS) raise("22023", "erp_production_invalid_inputs");
    for (const raw of override) {
      const v = obj(raw);
      onlyKeys(v, ["product_id", "quantity"]);
      const id = uuidOf(v.product_id)!, q = parseQuantity(v.quantity);
      if (q === null || q > MAX_QTY || given.has(id) || !inputs.some((i) => i.product_id === id)) raise("22023", "erp_production_invalid_inputs");
      given.set(id, q);
    }
  }
  const costs = stock.averageCosts(db, inputs.map((i) => String(i.product_id)));
  return inputs.map((i) => {
    const id = String(i.product_id), p = productInfo(db, id);
    const q = given.get(id) ?? consumption(qtyFromText(i.per_unit), quantity, qtyFromText(i.loss_percent));
    const b = balance(db, id, source).quantity;
    return { product_id: id, name: p?.name ?? null, code: p?.code ?? null, unit: p?.unit ?? null, quantity: q, balance: b,
      available: b - stock.reservedQuantity(db, id, source), cost: costs.get(id) ?? null, lot_control: !!p?.lot_control && p.format === "S" };
  }).filter((l) => l.quantity > 0n);
}
function previewOf(db: SqlDriver, user: string, o: Row, quantity: bigint, override: unknown, extra: bigint) {
  const lines = consumptionLines(db, o, quantity, override);
  const negative = stock.negativeAllowed(db);
  const inputsCost = lines.reduce((s, l) => s + (l.cost === null ? 0n : lineCost(l.quantity, l.cost)), 0n);
  const priced = lines.some((l) => l.cost !== null) || extra > 0n;
  const unit = unitCost(inputsCost + extra, quantity, entryDecimals(db));
  const short = lines.filter((l) => l.quantity > l.available);
  const costs = stock.costVisible(db, user);
  const product = productInfo(db, String(o.product_id));
  return {
    lines, inputsCost, unit, priced, short, negative,
    dto: {
      scope: "production_complete_preview", order_id: o.id, quantity: qtyText(quantity), negative_allowed: negative,
      can_complete: short.length === 0 || negative, costs_visible: costs,
      finished: { ...productRef(product), lot_control: !!product?.lot_control && product.format === "S" }, lot_rules: lotRules(db),
      inputs: lines.map((l) => ({
        product_id: l.product_id, name: l.name, code: l.code, unit: l.unit, quantity: qtyText(l.quantity), balance: qtyText(l.balance),
        available: qtyText(l.available), missing: qtyText(shortage(l.quantity, l.available)), no_cost: l.cost === null,
        unit_cost: costs && l.cost !== null ? costText(l.cost) : null, total_cost: costs && l.cost !== null ? costText(lineCost(l.quantity, l.cost)) : null,
      })),
      inputs_cost: costs ? costText(inputsCost) : null, extra_cost: costs ? costText(extra) : null, unit_cost: costs ? costText(unit) : null,
      cost_known: priced,
    },
  };
}

registerRpc("erp_production_complete_preview", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, input = args(a.p_args);
  requireAccess(db, user, false);
  onlyKeys(input, ["id", "quantity", "inputs", "extra_cost"]);
  const o = orderRow(db, uuidOf(input.id)!);
  const quantity = input.quantity === undefined || input.quantity === null || input.quantity === ""
    ? (qtyFromText(o.quantity) > qtyFromText(o.produced) ? qtyFromText(o.quantity) - qtyFromText(o.produced) : 10n ** 6n) : positiveQty(input.quantity);
  const extra = input.extra_cost === undefined || input.extra_cost === null || input.extra_cost === "" ? 0n : parseMoney(input.extra_cost);
  if (extra === null) raise("22023", "erp_production_invalid_cost");
  return previewOf(db, user, o, quantity, input.inputs, extra).dto;
});

/** Saída dos insumos e os lotes deles (o vencimento mais próximo primeiro; primeiro o que está sem lote). */
function issueInputs(ctx: RpcContext, user: string, command: string, o: Row, lines: PlanLine[], reason: string, reference: string) {
  const db = ctx.db, source = String(o.source_warehouse_id);
  const before = new Map(lines.map((l) => [l.product_id, balance(db, l.product_id, source)]));
  const lotsBefore = new Map(lines.filter((l) => l.lot_control).map((l) => [l.product_id, db.exec(
    `SELECT l.id, CAST(b.quantity AS TEXT) q FROM "erp_stock__lot" l JOIN "erp_stock__lot_balance" b ON b.lot_id=l.id
      WHERE l.product_id=? AND b.warehouse_id=? AND b.quantity>0 ORDER BY (l.expires_on IS NULL), l.expires_on, lower(l.code), l.id`, l.product_id, source,
  ).rows.map((r) => ({ id: String(r.id), quantity: fromColumn(r.q) }))]));
  const posted = stock.post(ctx, {
    user, command: derivedCommand(command, "issue"), kind: "issue", occurredOn: todaySaoPaulo(), reason, reference,
    items: lines.map((l) => ({ product_id: l.product_id, warehouse_id: source, quantity: "-" + qtyText(l.quantity), expected_version: before.get(l.product_id)!.version })),
  }) as { movement: { id: string }; replayed: boolean };
  if (posted.replayed !== false) raise("40001", "erp_production_command_conflict");
  const movement = posted.movement.id;
  for (const l of lines.filter((x) => x.lot_control)) {
    const lots = lotsBefore.get(l.product_id)!;
    const assigned = lots.reduce((s, x) => s + x.quantity, 0n);
    let rest = l.quantity - (before.get(l.product_id)!.quantity - assigned > 0n ? before.get(l.product_id)!.quantity - assigned : 0n);
    for (const lot of lots) {
      if (rest <= 0n) break;
      const take = lot.quantity < rest ? lot.quantity : rest;
      stock.lotApply(ctx, movement, l.product_id, source, lot.id, -take);
      rest -= take;
    }
  }
  return movement;
}

registerRpc("erp_production_complete", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, true);
  onlyKeys(data, ["id", "expected_version", "quantity", "inputs", "extra_cost", "lot", "note", "finish"]);
  const hash = hashOf("complete", user, data);
  const replayed = replay(db, command, user, "complete", hash);
  if (replayed) return replayed;
  const id = uuidOf(data.id)!, o = lockOrder(db, id, versionOf(data.expected_version));
  if (!completableStatus(String(o.status))) raise("22023", "erp_production_not_completable");
  const product = requireFinished(db, String(o.product_id));
  requireWarehouse(db, String(o.source_warehouse_id)); requireWarehouse(db, String(o.target_warehouse_id));
  const quantity = positiveQty(data.quantity);
  const extra = data.extra_cost === undefined || data.extra_cost === null || data.extra_cost === "" ? 0n : parseMoney(data.extra_cost);
  if (extra === null) raise("22023", "erp_production_invalid_cost");
  const note = textOf(data.note, 500);
  if (data.finish !== undefined && typeof data.finish !== "boolean") raise("22023", "erp_production_invalid");
  // Lote do acabado: obrigatório quando o produto controla lote; recusado quando não controla.
  const lotControl = product.lot_control && product.format === "S";
  let lot: Row | null = null;
  if (data.lot !== undefined && data.lot !== null) {
    if (!lotControl) raise("22023", "erp_production_lot_not_controlled");
    lot = obj(data.lot);
    onlyKeys(lot, ["code", "manufactured_on", "expires_on"]);
    textOf(lot.code, 60, false);
    dateOf(lot.manufactured_on); dateOf(lot.expires_on);
  } else if (lotControl) raise("22023", "erp_production_lot_required");
  const plan = previewOf(db, user, o, quantity, data.inputs, extra);
  if (plan.short.length && !plan.negative) raise("22023", "erp_production_insufficient_stock");

  const number = String(o.number), reference = label(number);
  const issue = plan.lines.length ? issueInputs(ctx, user, command, o, plan.lines, `Produção ${reference}: insumos de ${product.name}`.slice(0, 500), reference) : null;
  // Entrada do acabado pelo lançamento do Estoque, com o custo (sem custo conhecido, sem preço: o custo médio não muda).
  const price = plan.priced ? costText(plan.unit) : null;
  const target = String(o.target_warehouse_id);
  const receiptCommand = derivedCommand(command, "receipt");
  const launchNote = `Produção ${reference}${note ? `: ${note}` : ""}`.slice(0, 500);
  let launched: Row;
  if (lotControl) {
    const code = pgBtrim(String(lot!.code));
    const existing = one(db, 'SELECT id, active FROM "erp_stock__lot" WHERE product_id=? AND code__fold=?', product.id, pgLower(code));
    if (existing && !existing.active) raise("22023", "erp_production_lot_inactive");
    launched = invokeRpc(ctx, "erp_stock_lot_launch", {
      p_user_id: user, p_command_id: receiptCommand, p_kind: "receipt", p_product_id: product.id, p_warehouse_id: target, p_quantity: qtyText(quantity),
      p_expected_version: balance(db, product.id, target).version, p_unit_price: price, p_unit_cost: price, p_note: launchNote,
      p_destination_id: null, p_destination_version: null,
      p_lot: existing ? { lot_id: existing.id } : { code, manufactured_on: lot!.manufactured_on ?? null, expires_on: lot!.expires_on ?? null },
    }) as Row;
  } else {
    launched = invokeRpc(ctx, "erp_stock_launch", {
      p_user_id: user, p_command_id: receiptCommand, p_kind: "receipt", p_product_id: product.id, p_warehouse_id: target, p_quantity: qtyText(quantity),
      p_expected_version: balance(db, product.id, target).version, p_unit_price: price, p_unit_cost: price, p_note: launchNote,
    }) as Row;
  }
  if (launched.replayed !== false) raise("40001", "erp_production_command_conflict");
  const receipt = String((launched.movement as Row).id);
  const lotId = lotControl ? String((launched.lot as Row).id) : null;

  const completion = crypto.randomUUID();
  const position = Number(one(db, 'SELECT coalesce(max(position),0)+1 n FROM "erp_production__completion" WHERE order_id=?', id)!.n);
  db.exec(
    `INSERT INTO "erp_production__completion"(id, order_id, position, quantity, occurred_on, lot_id, inputs_cost, extra_cost, unit_cost, note, issue_movement_id, receipt_movement_id, state, actor, command_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
    completion, id, position, qtyText(quantity), todaySaoPaulo(), lotId, costText(plan.inputsCost), costText(extra), costText(plan.unit), note, issue, receipt,
    user, command, ctx.clock.next().toString(),
  );
  plan.lines.forEach((l, i) => db.exec(
    'INSERT INTO "erp_production__completion_input"(completion_id, position, product_id, quantity, unit_cost, total_cost) VALUES(?,?,?,?,?,?)',
    completion, i + 1, l.product_id, qtyText(l.quantity), l.cost === null ? null : costText(l.cost), costText(l.cost === null ? 0n : lineCost(l.quantity, l.cost)),
  ));
  const produced = qtyFromText(o.produced) + quantity;
  bump(ctx, id, user, { produced: qtyText(produced), status: statusAfter(o.status as OrderStatus, produced, qtyFromText(o.quantity), data.finish === true) });
  return remember(ctx, command, user, "complete", hash, {
    scope: "production_complete", completion_id: completion, issue_movement_id: issue, receipt_movement_id: receipt, order: orderDto(db, user, id),
  });
});

// ---------------------------------------------------------------------------
// Estorno de um apontamento

registerRpc("erp_production_reverse", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, true);
  onlyKeys(data, ["completion_id", "expected_version", "reason"]);
  const hash = hashOf("reverse", user, data);
  const replayed = replay(db, command, user, "reverse", hash);
  if (replayed) return replayed;
  const c = one(db, 'SELECT * FROM "erp_production__completion" WHERE id=?', uuidOf(data.completion_id));
  if (!c) raise("P0002", "erp_production_completion_not_found");
  const o = lockOrder(db, String(c.order_id), versionOf(data.expected_version));
  if (c.state !== "active") raise("22023", "erp_production_already_reversed");
  const reason = textOf(data.reason, 400, false)!;
  if (pgLength(reason) < 3) raise("22023", "erp_production_reason_required");
  const product = String(o.product_id), target = String(o.target_warehouse_id), receipt = String(c.receipt_movement_id);
  const movements = [receipt, ...(c.issue_movement_id ? [String(c.issue_movement_id)] : [])];
  if (movements.some((m) => one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE reverses_id=?', m))) raise("22023", "erp_production_stock_reversed");
  // O acabado já saiu do depósito depois da entrada (venda, transferência, uso como insumo ou ajuste): não estorna.
  if (one(db,
    `SELECT 1 x FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id JOIN "erp_stock__movement" r ON r.id=?
      WHERE e.product_id=? AND e.warehouse_id=? AND e.quantity<0 AND m.kind<>'reversal' AND m.created_at>r.created_at
        AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" x WHERE x.reverses_id=m.id) LIMIT 1`, receipt, product, target))
    raise("22023", "erp_production_finished_moved");
  const reference = label(o.number);
  const stockReason = `Estorno da produção ${reference}: ${reason}`.slice(0, 500);
  const reversals: string[] = [];
  for (const [i, m] of movements.entries()) {
    const versions = db.exec('SELECT product_id, warehouse_id FROM "erp_stock__entry" WHERE movement_id=? ORDER BY ordinal', m).rows
      .map((e) => ({ product_id: e.product_id, warehouse_id: e.warehouse_id, expected_version: balance(db, String(e.product_id), String(e.warehouse_id)).version }));
    const r = invokeRpc(ctx, "erp_stock_reverse", {
      p_user_id: user, p_movement_id: m, p_command_id: derivedCommand(command, i === 0 ? "reverse-receipt" : "reverse-issue"),
      p_occurred_on: todaySaoPaulo(), p_reason: stockReason, p_versions: versions,
    }) as Row;
    reversals.push(String((r.movement as Row).id));
  }
  db.exec(`UPDATE "erp_production__completion" SET state='reversed', reversed_at=?, reversed_by=?, reverse_reason=? WHERE id=?`, ctx.clock.next().toString(), user, reason, c.id);
  const produced = qtyFromText(o.produced) - qtyFromText(c.quantity);
  const status = o.status === "cancelled" ? "cancelled" : statusAfter(o.status === "done" ? "in_progress" : (o.status as OrderStatus), produced > 0n ? produced : 0n, qtyFromText(o.quantity), false);
  bump(ctx, String(o.id), user, { produced: qtyText(produced > 0n ? produced : 0n), status });
  return remember(ctx, command, user, "reverse", hash, { scope: "production_reverse", completion_id: c.id, reversal_movement_ids: reversals, order: orderDto(db, user, String(o.id)) });
});

// ---------------------------------------------------------------------------
// Planejamento: pedidos de venda em aberto → ordens sugeridas e lista de compras

/** Pedidos de venda em aberto ainda sem baixa de estoque (em aberto, verificado ou em andamento). */
const OPEN_SALES = ["open", "verified", "in_progress"];

function planOf(ctx: RpcContext, user: string) {
  const db = ctx.db;
  const salesOn = ctx.parts.sales === true;
  const demand = new Map<string, { quantity: bigint; orders: Map<string, unknown> }>();
  if (salesOn)
    for (const r of db.exec(
      `SELECT i.product_id, d.id document_id, d.number, CAST(i.quantity AS TEXT) q FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id
        WHERE d.kind='sales_orders' AND d.deleted_at IS NULL AND d.status IN (SELECT value FROM json_each(?)) AND i.product_id IS NOT NULL AND i.quantity IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM "erp_stock__document_posting" x WHERE x.document_id=d.id AND x.state='active')`, JSON.stringify(OPEN_SALES),
    ).rows) {
      const entry = demand.get(String(r.product_id)) ?? { quantity: 0n, orders: new Map() };
      entry.quantity += fromColumn(r.q);
      entry.orders.set(String(r.document_id), r.number);
      demand.set(String(r.product_id), entry);
    }
  // Produção já prevista: o que falta produzir nas ordens abertas, e os insumos que elas ainda vão consumir.
  const planned = new Map<string, bigint>(), committed = new Map<string, bigint>();
  for (const o of db.exec(`SELECT id, product_id, quantity, produced FROM "erp_production__order" WHERE status IN ('draft','released','in_progress')`).rows) {
    const rest = qtyFromText(o.quantity) - qtyFromText(o.produced);
    if (rest <= 0n) continue;
    planned.set(String(o.product_id), (planned.get(String(o.product_id)) ?? 0n) + rest);
    for (const i of inputRows(db, String(o.id)))
      committed.set(String(i.product_id), (committed.get(String(i.product_id)) ?? 0n) + consumption(qtyFromText(i.per_unit), rest, qtyFromText(i.loss_percent)));
  }
  const free = (id: string) => totalBalance(db, id) - (committed.get(id) ?? 0n);
  const suggestions = [...demand].map(([id, d]) => {
    const p = productInfo(db, id);
    const onHand = totalBalance(db, id), coming = planned.get(id) ?? 0n;
    const missing = d.quantity - onHand - coming;
    return { p, id, d, onHand, coming, missing };
  }).filter((s) => s.missing > 0n && s.p && s.p.format === "E" && finishedProblem(s.p) === null)
    .sort((x, y) => pgCompareText(fold(x.p!.name), fold(y.p!.name)) || pgCompareText(x.id, y.id))
    .map((s) => ({
      product: { ...productRef(s.p), format: s.p!.format }, demand: qtyText(s.d.quantity), stock: qtyText(s.onHand), planned: qtyText(s.coming),
      quantity: qtyText(s.missing), sales_orders: [...s.d.orders].map(([doc, number]) => ({ id: doc, number })),
      inputs: compositionItems(db, s.id).map((c) => {
        const r = productInfo(db, c.component_id), needed = consumption(c.per_unit, s.missing, 0n), available = free(c.component_id);
        return { product_id: c.component_id, name: r?.name ?? null, code: r?.code ?? null, unit: r?.unit ?? null, per_unit: qtyText(c.per_unit),
          needed: qtyText(needed), available: qtyText(available > 0n ? available : 0n), missing: qtyText(shortage(needed, available)) };
      }),
    }));
  // Lista de compras: o que falta de cada insumo somando todas as sugestões.
  const need = new Map<string, bigint>();
  for (const s of suggestions) for (const i of s.inputs) need.set(i.product_id, (need.get(i.product_id) ?? 0n) + qtyFromText(i.needed));
  const costs = stock.costVisible(db, user);
  const shopping = [...need].map(([id, needed]) => ({ id, needed, missing: shortage(needed, free(id)) })).filter((x) => x.missing > 0n).map((x) => {
    const r = productInfo(db, x.id);
    const supplier = one(db, `SELECT s.supplier_id, c.name, s.cost_price FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id WHERE s.record_id=? AND s.is_default=1`, x.id);
    return { product_id: x.id, name: r?.name ?? null, code: r?.code ?? null, unit: r?.unit ?? null, needed: qtyText(x.needed), missing: qtyText(x.missing),
      supplier: supplier ? { id: supplier.supplier_id, name: supplier.name } : null,
      cost_price: costs && supplier?.cost_price !== null && supplier?.cost_price !== undefined ? costText(parseMoney(String(supplier.cost_price)) ?? 0n) : null };
  }).sort((x, y) => pgCompareText(fold(String(x.name)), fold(String(y.name))));
  return { suggestions, shopping, salesOn };
}

registerRpc("erp_production_plan", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireAccess(db, user, false);
  onlyKeys(args(a.p_args), []);
  const plan = planOf(ctx, user);
  return {
    scope: "production_plan", sales_on: plan.salesOn, purchases_on: ctx.parts.purchases === true,
    can_purchase: ctx.parts.purchases === true && documentsAllowed(role(db, user), "purchase_orders", true), can_write: canWrite(db, user),
    default_warehouse_id: defaultWarehouse(db), suggestions: plan.suggestions, shopping: plan.shopping,
  };
});

registerRpc("erp_production_plan_generate", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, true);
  onlyKeys(data, ["items", "source_warehouse_id", "target_warehouse_id"]);
  const hash = hashOf("plan_generate", user, data);
  const replayed = replay(db, command, user, "plan_generate", hash);
  if (replayed) return replayed;
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50) raise("22023", "erp_production_invalid");
  const fallback = defaultWarehouse(db);
  const source = uuidOf(data.source_warehouse_id, true) ?? fallback, target = uuidOf(data.target_warehouse_id, true) ?? fallback;
  if (!source || !target) raise("22023", "erp_production_warehouse_required");
  requireWarehouse(db, source); requireWarehouse(db, target);
  const seen = new Set<string>();
  const created = (data.items as unknown[]).map((raw) => {
    const v = obj(raw);
    onlyKeys(v, ["product_id", "quantity", "sales_order_ids"]);
    const product = requireFinished(db, uuidOf(v.product_id)!);
    if (seen.has(product.id)) raise("22023", "erp_production_invalid");
    seen.add(product.id);
    const sales = v.sales_order_ids === undefined || v.sales_order_ids === null ? [] : v.sales_order_ids;
    if (!Array.isArray(sales) || sales.length > 200) raise("22023", "erp_production_invalid");
    const ids = sales.map((s) => uuidOf(s)!);
    return insertOrder(ctx, user, {
      product, quantity: positiveQty(v.quantity), source, target, planned_on: null, responsible: null, notes: null,
      status: "draft", origin: "plan", sales: [...new Set(ids)], inputs: readInputs(db, product.id, null),
    });
  });
  return remember(ctx, command, user, "plan_generate", hash, {
    scope: "production_plan_generate",
    orders: created.map((id) => { const o = orderRow(db, id); return { id, number: o.number, label: label(o.number), product_id: o.product_id, quantity: o.quantity }; }),
  });
});

/** Lista de compras → pedidos de compra (um por fornecedor), pelo salvar de documento do Compras. */
registerRpc("erp_production_purchase", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = uuidOf(a.p_command_id)!, data = args(a.p_data);
  requireAccess(db, user, false);
  onlyKeys(data, ["items"]);
  const hash = hashOf("purchase", user, data);
  const replayed = replay(db, command, user, "purchase", hash);
  if (replayed) return replayed;
  if (!documentsAllowed(role(db, user), "purchase_orders", true)) raise("42501", "erp_production_purchase_denied");
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100) raise("22023", "erp_production_invalid");
  const groups = new Map<string, { product: ProductInfo; quantity: bigint; price: string | null }[]>();
  const seen = new Set<string>();
  for (const raw of data.items as unknown[]) {
    const v = obj(raw);
    onlyKeys(v, ["product_id", "quantity", "supplier_id"]);
    const id = uuidOf(v.product_id)!, quantity = positiveQty(v.quantity);
    if (seen.has(id)) raise("22023", "erp_production_invalid");
    seen.add(id);
    const product = productInfo(db, id);
    if (!product || stock.componentProblem(db, id) !== null) raise("22023", "erp_production_input_unavailable");
    const fallback = one(db, 'SELECT supplier_id, cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', id);
    const supplier = uuidOf(v.supplier_id, true) ?? ((fallback?.supplier_id as string | undefined) ?? null);
    if (!supplier) raise("22023", "erp_production_supplier_required");
    const own = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=? ORDER BY is_default DESC LIMIT 1', id, supplier);
    const price = own?.cost_price ?? null;
    groups.set(supplier, [...(groups.get(supplier) ?? []), { product, quantity, price: price === null || price === undefined ? null : String(price) }]);
  }
  const documents = [...groups].map(([supplier, lines], index) => {
    const saved = invokeRpc(ctx, "erp_document_save", {
      p_user_id: user, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: derivedCommand(command, `purchase-${index}`),
      p_body: {
        date: todaySaoPaulo(), contact_id: supplier,
        items: lines.map((l) => ({ product_id: l.product.id, description: l.product.name, unit: l.product.unit, quantity: qtyText(l.quantity), unit_price: l.price ?? "0", discount_percent: "0" })),
      },
    }) as Row;
    const doc = saved.document as Row;
    return { id: doc.id, number: doc.number ?? null, supplier_id: supplier, items: lines.length };
  });
  return remember(ctx, command, user, "purchase", hash, { scope: "production_purchase", documents });
});
