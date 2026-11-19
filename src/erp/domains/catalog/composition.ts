// Composição de kit vista do catálogo: erp_catalog.composition_sync_on,
// composition_kits e composition_sync. O cálculo dos kits é do Estoque
// (erp_stock.composition_settings, composition_apply_values).
import { type SqlDriver } from "../../engine/driver.ts";
import type { RpcContext } from "../../engine/registry.ts";
import * as stock from "../stock/public.ts";
import { compareText } from "./fields.ts";
import { requireErpParts } from "../../engine/parts-gate.ts";
import { erpRequirement } from "../../parts.ts";

/** erp_catalog.composition_sync_on(): fora de uma sincronização e com custo, peso ou preço ligado. */
export function compositionSyncOn(ctx: RpcContext): boolean {
  if (!ctx.parts.products || !ctx.parts.stock) return false;
  if (ctx.settings.get("erp_catalog.composition_sync") === "on") return false;
  const s = stock.compositionSettings(ctx.db) as { update_cost?: boolean; update_weight?: boolean; update_price?: boolean } | null;
  if (!ctx.parts.purchases && s?.update_cost) return false;
  return !!(s && (s.update_cost || s.update_weight || s.update_price));
}

/** erp_catalog.composition_kits(p_products): kits (formato E) que usam os produtos, sem eles. */
export function compositionKits(db: SqlDriver, products: string[]): string[] {
  const kits = db
    .exec(
      // erp_stock.composition_current é visão: item da versão vigente da composição.
      `SELECT DISTINCT i.product_id FROM "erp_stock__composition" c
       JOIN "erp_stock__composition_item" i ON i.product_id=c.product_id AND i.version=c.version
       JOIN "erp_catalog__product" k ON k.record_id=i.product_id
       WHERE i.component_id IN (SELECT value FROM json_each(?)) AND k.format='E' AND i.product_id NOT IN (SELECT value FROM json_each(?))`,
      JSON.stringify(products), JSON.stringify(products),
    )
    .rows.map((r) => String(r.product_id));
  return kits.sort(compareText);
}

/** erp_catalog.composition_sync(p_user_id, p_command_id, p_kits): quantos kits mudaram. */
export function compositionSync(ctx: RpcContext, user: string, command: string, kits: string[]): number {
  if (kits.length === 0) return 0;
  requireErpParts(ctx, erpRequirement("erp-produtos", "erp-estoque"));
  if (!ctx.parts.purchases && (stock.compositionSettings(ctx.db) as { update_cost?: boolean } | null)?.update_cost)
    requireErpParts(ctx, erpRequirement("erp-compras"));
  ctx.settings.set("erp_catalog.composition_sync", "on");
  let count = 0;
  for (const kit of kits) {
    const out = (stock.compositionApplyValues(ctx, user, command, kit) ?? {}) as Record<string, unknown>;
    const { skipped: _s, cost_skipped: _c, ...rest } = out;
    if (Object.keys(rest).length > 0) count++;
  }
  ctx.settings.set("erp_catalog.composition_sync", "");
  return count;
}
