// Leituras do catálogo que outros domínios chamam: erp_catalog.can_read_stock
// e erp_catalog.product_cost_at.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { ErpError } from "../../engine/errors.ts";
import { saoPauloMidnight } from "../../engine/time.ts";
import * as stock from "../stock/public.ts";

/** erp_catalog.can_read_stock(p_user_id): o acesso de leitura do estoque, sem lançar. */
export function canReadStock(db: SqlDriver, user: string | null): boolean {
  try {
    stock.requireAccess(db, user as string, false);
    return true;
  } catch (error) {
    if (error instanceof ErpError && error.code === "42501") return false;
    throw error;
  }
}

/** (p_day + 1) para date AAAA-MM-DD. */
function nextDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * erp_catalog.product_cost_at(p_product, p_day): o custo vigente no fim do dia
 * em São Paulo (último valid_from antes da meia-noite seguinte; empate por id).
 */
export function productCostAt(db: SqlDriver, product: string | null, day: string | null): string | null {
  if (product === null || day === null) return null;
  const h = one(
    db,
    `SELECT cost_price FROM "erp_catalog__product_cost_history" WHERE product_id=? AND valid_from<?
     ORDER BY valid_from DESC, id DESC LIMIT 1`,
    product,
    saoPauloMidnight(nextDay(day)).toString(),
  );
  return h ? ((h.cost_price as string | null) ?? null) : null;
}
