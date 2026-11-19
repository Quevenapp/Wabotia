// Composição de kit (formato E): erp_stock.composition_totals,
// composition_dto e composition_apply_values (o kit acompanha preço, peso e
// custo dos componentes, com as opções de Preferências › Produtos).
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
// Escalas: preço e custo são numeric livre (texto, até 10 casas); peso e
// quantidade da estrutura, escala 6; a quantidade do p_items é exata (30).
import { formatScaled, fromColumn, rescale, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { type RpcContext } from "../../engine/registry.ts";
import { requireRpcParts } from "../../engine/parts-gate.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { erpCatalogProductSave, erpCatalogProductPricesUpdate } from "../catalog/public.ts";
import { QTY, supplyPart } from "./internal.ts";
import { COMPOSITION_CURRENT, EXACT, q6to30 } from "./read.ts";
import { compositionSettings } from "./public.ts";

const PRICE = 10;
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** erp_stock.composition_totals(p_product, p_items): venda, custo e pesos do kit pelos componentes. */
export function compositionTotals(db: SqlDriver, product: string, items: { component_id: string; quantity: string }[] | null = null) {
  const list =
    items === null
      ? db
          .exec(`SELECT component_id, CAST(quantity AS TEXT) q FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product)
          .rows.map((r) => ({ component: String(r.component_id), quantity: q6to30(fromColumn(r.q)) }))
      : items.map((j) => ({ component: String(j.component_id).toLowerCase(), quantity: toScaled(String(j.quantity), EXACT) }));
  let count = 0,
    unpriced = 0,
    uncosted = 0,
    weighted = 0;
  let sale = 0n,
    cost = 0n,
    net = 0n,
    gross = 0n; // escala PRICE+EXACT e QTY+EXACT
  for (const i of list) {
    const p = one(db, 'SELECT price, CAST(net_weight AS TEXT) nw, CAST(gross_weight AS TEXT) gw FROM "erp_catalog__product" WHERE record_id=?', i.component);
    if (!p) continue;
    count++;
    const c = text(one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', i.component)?.cost_price);
    if (p.price === null) unpriced++;
    else sale += toScaled(String(p.price), PRICE) * i.quantity;
    if (c === null) uncosted++;
    else cost += toScaled(c, PRICE) * i.quantity;
    if (p.nw !== null) net += fromColumn(p.nw) * i.quantity;
    if (p.gw !== null) gross += fromColumn(p.gw) * i.quantity;
    if (p.nw !== null || p.gw !== null) weighted++;
  }
  return {
    items: count,
    sale: formatScaled(rescale(sale, PRICE + EXACT, PRICE), PRICE),
    unpriced,
    cost: formatScaled(rescale(cost, PRICE + EXACT, PRICE), PRICE),
    uncosted,
    net_weight: formatScaled(rescale(net, QTY + EXACT, QTY), QTY),
    gross_weight: formatScaled(rescale(gross, QTY + EXACT, QTY), QTY),
    weighted,
  };
}

/** erp_stock.composition_dto(p_product): a estrutura vigente (null sem composição). */
export function compositionDto(db: SqlDriver, product: string) {
  const c = one(db, 'SELECT stock_type, post_mode, version, updated_at FROM "erp_stock__composition" WHERE product_id=?', product);
  if (!c) return null;
  return {
    stock_type: c.stock_type,
    post_mode: c.post_mode,
    version: c.version,
    updated_at: c.updated_at === null || c.updated_at === undefined ? null : jsonTimestamp(c.updated_at as number),
    items: db
      .exec(`SELECT position, component_id, CAST(quantity AS TEXT) q FROM ${COMPOSITION_CURRENT} WHERE product_id=? ORDER BY position`, product)
      .rows.map((i) => ({ position: i.position, component_id: i.component_id, quantity: formatScaled(fromColumn(i.q), QTY) })),
  };
}

/** numeric IS DISTINCT FROM: null só é igual a null; o resto pelo valor. */
const distinctDec = (a: string | null, b: string, scale: number) => a === null || toScaled(a, scale) !== toScaled(b, scale);

/**
 * erp_stock.composition_apply_values(p_user_id, p_command_id, p_product,
 * p_skip_base): o kit recebe o preço e os pesos somados (pelo
 * erp_catalog_product_save) e o custo (pelo erp_catalog_product_prices_update
 * do fornecedor padrão), conforme as opções ligadas. Devolve o que mudou.
 */
export function compositionApplyValues(ctx: RpcContext, user: string, command: string, product: string, skipBase = false): Record<string, unknown> {
  requireRpcParts(ctx, "erp_stock_composition_get", { p_product_id: product });
  const db = ctx.db;
  const s = compositionSettings(db);
  const out: Record<string, unknown> = {};
  if (!(s.update_cost || s.update_weight || s.update_price)) return out;
  const p = one(db, 'SELECT format, price, CAST(net_weight AS TEXT) nw, CAST(gross_weight AS TEXT) gw FROM "erp_catalog__product" WHERE record_id=?', product);
  if (
    p?.format !== "E" ||
    !one(db, `SELECT 1 x FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product) ||
    one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', product)
  )
    return { skipped: "not_applicable" };
  const t = compositionTotals(db, product);
  if (!skipBase) {
    const patch: Record<string, string> = {};
    if (s.update_price && distinctDec(text(p.price), t.sale, PRICE)) patch.price = t.sale;
    if (s.update_weight && t.weighted > 0) {
      const nw = p.nw === null ? null : formatScaled(fromColumn(p.nw), QTY);
      const gw = p.gw === null ? null : formatScaled(fromColumn(p.gw), QTY);
      if (distinctDec(nw, t.net_weight, QTY)) patch.net_weight = t.net_weight;
      if (distinctDec(gw, t.gross_weight, QTY)) patch.gross_weight = t.gross_weight;
    }
    if (Object.keys(patch).length) {
      const version = one(db, 'SELECT version FROM "erp_catalog__record" WHERE id=?', product)?.version ?? null;
      erpCatalogProductSave(ctx, {
        p_user_id: user,
        p_id: product,
        p_expected_version: version,
        p_command_id: supplyPart(command, `composition-values:${product}`),
        p_data: patch,
        p_acknowledged: null,
      });
      Object.assign(out, patch);
    }
  }
  if (s.update_cost && !ctx.parts.purchases) out.cost_skipped = "part_disabled";
  if (s.update_cost && ctx.parts.purchases) {
    const sup = one(db, 'SELECT supplier_id, cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', product);
    if (!sup?.supplier_id) out.cost_skipped = "no_default_supplier";
    else if (distinctDec(text(sup.cost_price), t.cost, PRICE)) {
      const version = one(db, 'SELECT version FROM "erp_catalog__record" WHERE id=?', product)?.version ?? null;
      erpCatalogProductPricesUpdate(ctx, {
        p_user_id: user,
        p_command_id: supplyPart(command, `composition-cost:${product}`),
        p_supplier_id: sup.supplier_id,
        p_items: [{ product_id: product, expected_version: version, cost_price: t.cost }],
      });
      out.cost_price = t.cost;
    }
  }
  return out;
}
