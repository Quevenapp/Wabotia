// Leituras do catálogo que outros domínios chamam: erp_catalog.can_read_stock
// e erp_catalog.product_cost_at.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { ErpError } from "../../engine/errors.ts";
import { saoPauloMidnight } from "../../engine/time.ts";
import * as stock from "../stock/public.ts";
import { registerBeforeRpc } from "../../engine/registry.ts";
import { normalizeErpParts, type ErpParts } from "../../parts.ts";
import { ErpPartDisabled } from "../../engine/parts-gate.ts";
import { jsonbText } from "../../engine/json.ts";

// Os leitores legados recebem SqlDriver, como as restrições de contato.
// Reiniciado antes de todo RPC (inclusive sem parts), sem alterar a identidade
// do driver usada pelo cadastro único. invokeRpc herda a fotografia síncrona.
const snapshots = new WeakMap<SqlDriver, Readonly<ErpParts>>();
const allParts = normalizeErpParts();
export const catalogParts = (db: SqlDriver) => snapshots.get(db) ?? allParts;
registerBeforeRpc(ctx => snapshots.set(ctx.db, ctx.parts));

/** Campos suspensos: omissão preserva; reenvio idêntico passa; limpeza não. */
export function preserveCatalogFields(
  enabled: boolean, input: Record<string, unknown>, before: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  if (enabled) return input;
  const out = { ...input };
  for (const [key, fallback] of Object.entries(defaults)) {
    const saved = before[key] === undefined ? fallback : before[key];
    if (Object.hasOwn(input, key) && jsonbText(input[key]) !== jsonbText(saved)) throw new ErpPartDisabled();
    out[key] = saved;
  }
  return out;
}

export const catalogUnavailable = (parts: Readonly<ErpParts>, keys: (keyof ErpParts)[]) => {
  const unavailable = keys.filter(key => !parts[key]);
  return unavailable.length ? { unavailable_parts: unavailable } : {};
};

/** erp_catalog.can_read_stock(p_user_id): o acesso de leitura do estoque, sem lançar. */
export function canReadStock(db: SqlDriver, user: string | null): boolean {
  if (!catalogParts(db).stock) return false;
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
