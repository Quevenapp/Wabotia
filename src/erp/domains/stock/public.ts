// Estoque (erp_stock, erp_purchase_receipts): o que outros domínios chamam
// (docs/ERP-PORTE.md). Porte a função aqui com o nome do stub; o stub sai na
// próxima geração (scripts/erp/gen-ownership.mjs).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import * as preferences from "../preferences/public.ts";

export * from "./stubs.generated.ts";
export { movementDto, requireAccess, reservedQuantity } from "./internal.ts";
export { erpStockPost } from "./rpc/erp_stock_post.ts";
export { countPhysical, ignoredWarehouse, lotQuantity, lotsExpiring } from "./home.ts";

// ---------------------------------------------------------------------------
// compositionSettings, protectProductUnit e protectDefaultWarehouse: escritas
// pela P para o Catálogo; dono: Estoque (sessão N). Só leitura; as guardas são
// os gatilhos do Postgres chamados pela escrita do catálogo (record.ts).

/** erp_stock.composition_settings(): o que a composição de kit recalcula. */
export function compositionSettings(db: SqlDriver): { update_cost: boolean; update_weight: boolean; update_price: boolean } {
  const on = (key: string) => preferences.get(db, key) === true;
  return {
    update_cost: on("produtos.composicao_custo"),
    update_weight: on("produtos.composicao_peso"),
    update_price: on("produtos.composicao_preco"),
  };
}

/**
 * erp_stock.protect_product_unit (BEFORE UPDATE de erp_catalog.product):
 * unidade ou tipo não mudam depois de um lançamento de estoque do produto.
 */
export function protectProductUnit(
  db: SqlDriver,
  old: { record_id: string; unit: unknown; kind: unknown },
  next: { unit: unknown; kind: unknown },
) {
  if (
    ((next.unit ?? null) !== (old.unit ?? null) || (next.kind ?? null) !== (old.kind ?? null)) &&
    one(db, 'SELECT 1 x FROM "erp_stock__entry" WHERE product_id=? LIMIT 1', old.record_id)
  )
    raise("40001", "erp_stock_product_unit_locked");
}

/**
 * erp_stock.protect_default_warehouse (BEFORE UPDATE OF active de
 * erp_catalog.record): o depósito padrão não é inativado.
 */
export function protectDefaultWarehouse(
  db: SqlDriver,
  old: { id: string; entity: string; active: boolean },
  nextActive: boolean,
) {
  if (
    old.entity === "warehouses" && old.active && !nextActive &&
    one(db, 'SELECT 1 x FROM "erp_stock__warehouse_default" WHERE warehouse_id=?', old.id)
  )
    raise("22023", "erp_stock_default_warehouse_inactive");
}
