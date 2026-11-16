// Leituras compartilhadas do Estoque (sem escrita): ajustes do estoque
// (settings_dto, reserve_statuses, reserve_situation_ids), reservas por
// situação de venda (situation_reservations), componentes do item
// (item_component_rows), composição virtual (virtual_positions,
// virtual_quantity), hash das reservas de uma posição e a visão
// erp_stock.composition_current (a versão atual da estrutura).
// Quantidades exatas em escala 30 (EXACT) onde o Postgres multiplica ou soma
// sem escala fixa; a saída arredonda para 6 casas (::numeric(18,6)).
import { createHash } from "node:crypto";
import { exact, formatScaled, fromColumn, rescale, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { jsonbText } from "../../engine/json.ts";
import * as preferences from "../preferences/public.ts";
import { ignoredWarehouse } from "./home.ts";
import { QTY } from "./internal.ts";

export const EXACT = 30;
/** Quantidade numeric(18,6) (escala 6) → escala 30. */
export const q6to30 = (v: bigint) => rescale(v, QTY, EXACT);
/** Valor exato (escala 30) como numeric(18,6)::text. */
export const text6 = (v: bigint) => formatScaled(rescale(v, EXACT, QTY), QTY);

/** erp_stock.composition_current (visão): a estrutura na versão atual. */
export const COMPOSITION_CURRENT = `(SELECT i.product_id, i.position, i.component_id, i.quantity, c.stock_type, c.post_mode, c.version
  FROM "erp_stock__composition" c JOIN "erp_stock__composition_item" i ON i.product_id=c.product_id AND i.version=c.version)`;

const pref = (db: SqlDriver, key: string) => preferences.get(db, key);
/** jsonb #>> '{}': texto do valor (string sem aspas; o resto como jsonb::text). */
const asText = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v));

/** erp_stock.reserve_statuses(): situações nativas escolhidas na reserva por situação. */
export function reserveStatuses(db: SqlDriver): string[] {
  if (pref(db, "estoque.reserva_por_situacao") !== true) return [];
  const chosen = pref(db, "estoque.reserva_situacoes");
  const list = Array.isArray(chosen) ? chosen : [];
  const map: [string, string, number][] = [
    ["em_digitacao", "draft", 1], ["em_aberto", "open", 2], ["verificado", "verified", 3],
    ["em_andamento", "in_progress", 4], ["atendido", "fulfilled", 5], ["cancelado", "cancelled", 6],
  ];
  const out: [number, string][] = [];
  for (const x of list) {
    const t = asText(x);
    for (const [option, status, ord] of map) if (option === t) out.push([ord, status]);
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** erp_stock.reserve_situation_ids(): situações personalizadas de pedido escolhidas na reserva. */
export function reserveSituationIds(db: SqlDriver): string[] {
  if (pref(db, "estoque.reserva_por_situacao") !== true) return [];
  const chosen = pref(db, "estoque.reserva_situacoes");
  const list = (Array.isArray(chosen) ? chosen : []).map(asText).filter((t): t is string => t !== null && UUID_LOWER.test(t));
  const out: string[] = [];
  for (const id of list)
    if (one(db, `SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind='sales_orders'`, id)) out.push(id);
  return out.sort();
}

/** erp_stock.settings_dto() */
export function settingsDto(db: SqlDriver) {
  const priceType = pref(db, "estoque.tipo_preco_entrada");
  const byWarehouse = pref(db, "estoque.reserva_por_deposito");
  return {
    show_unit_price: pref(db, "estoque.exibir_preco_unitario") === true,
    price_type:
      typeof priceType === "string" && ["ultima_compra", "compra_fornecedor", "custo_fornecedor"].includes(priceType) ? priceType : "ultima_compra",
    consider_balances: pref(db, "estoque.considerar_balancos") === true,
    average_cost_base: asText(pref(db, "estoque.custo_medio_base")) === "custo_lancamento" ? "custo_lancamento" : "preco_compra",
    reserve_by_situation: pref(db, "estoque.reserva_por_situacao") === true,
    reserve_statuses: reserveStatuses(db),
    reserve_by_warehouse: byWarehouse === null || byWarehouse === undefined ? true : byWarehouse !== false,
  };
}

/** Linha de erp_stock.item_component_rows: componente, quantidade exata (escala 30), modo e posição. */
export interface ComponentRow {
  component_id: string;
  quantity: bigint;
  post_mode: string;
  position: number;
}

/**
 * erp_stock.item_component_rows(p_item, p_product): os componentes editados
 * do item (Componentes do item, kit) ou, sem edição, a estrutura atual.
 */
export function itemComponentRows(db: SqlDriver, item: string, product: string): ComponentRow[] {
  const edited = one(
    db,
    `SELECT k.components, c.post_mode FROM "erp_stock__item_component" k JOIN "erp_stock__composition" c ON c.product_id=k.product_id WHERE k.item_id=? AND k.product_id=?`,
    item,
    product,
  );
  if (edited) {
    const list = JSON.parse(String(edited.components)) as Record<string, unknown>[];
    return list.map((x, i) => ({
      component_id: String(x.component_id).toLowerCase(),
      quantity: toScaled(String(x.quantity), EXACT),
      post_mode: String(edited.post_mode),
      position: i + 1,
    }));
  }
  if (one(db, 'SELECT 1 x FROM "erp_stock__item_component" WHERE item_id=? AND product_id=?', item, product)) return [];
  return db
    .exec(`SELECT component_id, CAST(quantity AS TEXT) q, post_mode, position FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product)
    .rows.map((r) => ({ component_id: String(r.component_id), quantity: q6to30(fromColumn(r.q)), post_mode: String(r.post_mode), position: Number(r.position) }));
}

/** erp_stock.invoice_posted_for_document: a nota do pedido já lançou o estoque. */
export const invoicePostedForDocument = (db: SqlDriver, document: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_stock__invoice_posting" p ON p.invoice_id=o.invoice_id AND p.state='active' WHERE o.document_id=?`,
    document,
  );

/** Linha de erp_stock.situation_reservations. */
export interface SituationRow {
  document_id: string;
  number: unknown;
  status: string;
  contact_name: string | null;
  product_id: string;
  warehouse_id: string | null;
  quantity: bigint; // escala 30
  unit: string | null;
}

/**
 * erp_stock.situation_reservations(p_product): o que os pedidos nas situações
 * escolhidas (reserva por situação) reservam, por pedido, produto e depósito.
 */
export function situationReservations(db: SqlDriver, product: string | null): SituationRow[] {
  const statuses = reserveStatuses(db);
  const situations = reserveSituationIds(db);
  if (!statuses.length && !situations.length) return [];
  const byWarehouse = settingsDto(db).reserve_by_warehouse;
  const standard = (one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1')?.warehouse_id as string | null) ?? null;
  const items = db.exec(
    `SELECT d.id, d.number, d.status, d.contact_snapshot, d.warehouse_id, i.product_id, CAST(i.quantity AS TEXT) q, p.unit, p.format, i.id item_id, i.data
     FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id JOIN "erp_catalog__product" p ON p.record_id=i.product_id
     WHERE d.kind='sales_orders' AND p.kind='P' AND p.unit IS NOT NULL
      AND (d.status IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM "erp_documents__document_situation" ds WHERE ds.document_id=d.id AND ds.situation_id IN (SELECT value FROM json_each(?))))
      AND NOT EXISTS(SELECT 1 FROM "erp_stock__document_posting" x WHERE x.document_id=d.id AND x.state='active')
      AND NOT EXISTS(SELECT 1 FROM "erp_stock__reservation" r WHERE r.document_id=d.id AND r.state='active')`,
    JSON.stringify(statuses),
    JSON.stringify(situations),
  ).rows;
  const groups = new Map<string, SituationRow>();
  const add = (x: Record<string, unknown>, target: string, qty: bigint, unit: string | null) => {
    if (product !== null && target !== product) return;
    const docWarehouse = (x.warehouse_id as string | null) ?? null;
    const key = JSON.stringify([x.id, target, unit, docWarehouse]);
    const g = groups.get(key);
    if (g) g.quantity += qty;
    else
      groups.set(key, {
        document_id: String(x.id),
        number: x.number,
        status: String(x.status),
        contact_name: (JSON.parse(String(x.contact_snapshot ?? "null")) as { name?: unknown } | null)?.name?.toString() ?? null,
        product_id: target,
        warehouse_id: byWarehouse ? docWarehouse ?? standard : null,
        quantity: qty,
        unit,
      });
  };
  for (const x of items) {
    const itemUnit = (JSON.parse(String(x.data ?? "null")) as { unit?: unknown } | null)?.unit;
    const unitText = itemUnit === undefined || itemUnit === null ? null : typeof itemUnit === "string" ? itemUnit : jsonbText(itemUnit);
    if (unitText !== x.unit) continue;
    if (invoicePostedForDocument(db, String(x.id))) continue;
    const components = x.format === "E" ? itemComponentRows(db, String(x.item_id), String(x.product_id)) : [];
    if (product !== null && x.product_id !== product && !components.some((c) => c.component_id === product)) continue;
    const qty = q6to30(fromColumn(x.q));
    if (x.format !== "E") add(x, String(x.product_id), qty, x.unit as string);
    else {
      const mode = one(db, 'SELECT post_mode FROM "erp_stock__composition" WHERE product_id=?', x.product_id)?.post_mode;
      if (mode === "product" || mode === "both") add(x, String(x.product_id), qty, x.unit as string);
      for (const c of components) {
        if (c.post_mode !== "components" && c.post_mode !== "both") continue;
        const cp = one(db, 'SELECT kind, unit FROM "erp_catalog__product" WHERE record_id=?', c.component_id);
        if (!cp || cp.kind !== "P" || cp.unit === null) continue;
        add(x, c.component_id, rescale(qty * c.quantity, EXACT * 2, EXACT), cp.unit as string);
      }
    }
  }
  return [...groups.values()];
}

/**
 * erp_stock.virtual_positions(p_product): quantos kits cabem em cada depósito
 * onde há saldo de algum componente (trunc do menor saldo/quantidade).
 */
export function virtualPositions(db: SqlDriver, product: string): { warehouse_id: string; quantity: bigint }[] {
  const components = db
    .exec(`SELECT component_id, CAST(quantity AS TEXT) q FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product)
    .rows.map((r) => ({ id: String(r.component_id), q: fromColumn(r.q) }));
  const warehouses = db
    .exec(
      `SELECT DISTINCT b.warehouse_id FROM "erp_stock__balance" b JOIN ${COMPOSITION_CURRENT} i ON i.component_id=b.product_id WHERE i.product_id=?`,
      product,
    )
    .rows.map((r) => String(r.warehouse_id));
  return warehouses.map((w) => {
    let min: bigint | null = null;
    for (const c of components) {
      const b = fromColumn(
        one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', c.id, w)?.q ?? 0,
      );
      // Mesma escala (6) nos dois: o quociente é b/q; trunc é monótono, então trunc(min) = min(trunc).
      const t = b / c.q;
      if (min === null || t < min) min = t;
    }
    return { warehouse_id: w, quantity: min ?? 0n };
  });
}

/** erp_stock.virtual_quantity(p_product, p_warehouse): kits virtuais (inteiro), ou null sem estrutura. */
export function virtualQuantity(db: SqlDriver, product: string, warehouse: string | null): bigint | null {
  if (!one(db, `SELECT 1 x FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product)) return null;
  return virtualPositions(db, product)
    .filter((v) => (warehouse === null ? !ignoredWarehouse(db, v.warehouse_id) : v.warehouse_id === warehouse))
    .reduce((s, v) => s + v.quantity, 0n);
}

/** erp_stock.reservation_position_hash: as reservas ativas da posição (id, versão, quantidade, unidade). */
export function reservationPositionHash(db: SqlDriver, product: string, warehouse: string): string {
  const rows = db
    .exec(
      `SELECT r.id, r.version, CAST(i.quantity AS TEXT) q, i.unit FROM "erp_stock__reservation_item" i JOIN "erp_stock__reservation" r ON r.id=i.reservation_id
       WHERE r.state='active' AND i.product_id=? AND i.warehouse_id=? ORDER BY r.id`,
      product,
      warehouse,
    )
    .rows.map((r) => [r.id, Number(r.version), formatScaled(fromColumn(r.q), QTY), r.unit]);
  return createHash("sha256").update(jsonbText(rows), "utf8").digest("hex");
}

export { exact };
