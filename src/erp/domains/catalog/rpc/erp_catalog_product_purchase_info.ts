// public.erp_catalog_product_purchase_info: dados de compra de até 100
// produtos (fornecedor padrão, o do pedido, última compra e o preço
// sugerido pela preferência de Compras). erp_catalog.purchase_price_mode.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { activeRole } from "../../access/public.ts";
import { allowed } from "../../documents/public.ts";
import * as preferences from "../../preferences/public.ts";
import { uuidArg } from "../pricing/args.ts";
import { unitPriceNumeric } from "../internal.ts";
import { uuidArrayArg } from "../pricing/args.ts";
import { requireAccess } from "../pricing/deps.ts";
import { num } from "../pricing/money.ts";
import { catalogUnavailable } from "../cost.ts";

/** erp_catalog.purchase_price_mode() */
export function purchasePriceMode(db: SqlDriver) {
  if ((preferences.get(db, "compras.preco_padrao") ?? false) !== true) return "last_purchase";
  return preferences.get(db, "compras.preco_padrao_tipo") === "compra" ? "purchase" : "cost";
}

/** nullif(x, 0) do numeric: zero (com qualquer escala) vira null. */
const nonZero = (v: unknown) => (v === null || v === undefined || num(String(v)).v === 0n ? null : String(v));

registerRpc("erp_catalog_product_purchase_info", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  const ids = uuidArrayArg(a, "p_product_ids");
  const supplier = uuidArg(a, "p_supplier_id");
  const db = ctx.db;
  const mode = purchasePriceMode(db);
  requireAccess(db, user, "products", false);
  if (ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_catalog_invalid_query");
  // A última compra vem dos pedidos de compra: só quem os lê a vê (Vendas lê produtos, não compras).
  const role = user === null ? null : activeRole(db, user);
  const orders = ctx.parts.purchases && role !== null && allowed(role, "purchase_orders", false);
  const items = [];
  for (const id of ids as string[]) {
    const r = one(
      db,
      `SELECT CAST(r.version AS TEXT) version, r.name, r.code, p.price, d.deleted_at FROM "erp_catalog__record" r
       JOIN "erp_catalog__product" p ON p.record_id=r.id LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id
       WHERE r.id=? AND r.entity='products'`,
      id,
    );
    if (!r) continue;
    const def = one(
      db,
      `SELECT s.supplier_id id, c.name FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" c ON c.id=s.supplier_id
       WHERE s.record_id=? AND s.is_default=1`,
      id,
    );
    const own =
      supplier === null
        ? null
        : one(
            db,
            'SELECT supplier_id, code, description, purchase_price, cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?',
            id,
            supplier,
          );
    // O fornecedor do pedido quando o produto o tem; senão o padrão do produto.
    const sp = own ?? one(db, 'SELECT purchase_price, cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1', id);
    // Última compra: o pedido de compra mais recente (qualquer fornecedor, não cancelado), pela data do pedido.
    const lp = !orders
      ? null
      : one(
          db,
          `SELECT i.unit_price FROM "erp_documents__item" i JOIN "erp_documents__document" o ON o.id=i.document_id
           WHERE o.authority='brufap' AND i.product_id=? AND o.kind='purchase_orders' AND o.status<>'cancelled'
           ORDER BY (o.body ->> '$.date') IS NULL, o.body ->> '$.date' DESC, o.created_at DESC, i.position LIMIT 1`,
          id,
        );
    const purchase = nonZero(sp?.purchase_price),
      cost = ctx.parts.stock && ctx.parts.purchases ? nonZero(sp?.cost_price) : null;
    const last = lp ? ((lp.unit_price as string | null) ?? null) : null;
    const suggested = mode === "cost" ? (cost ?? purchase) : mode === "purchase" ? (purchase ?? cost) : (last ?? purchase ?? cost);
    items.push({
      product_id: id,
      version: Number(r.version),
      name: r.name,
      code: r.code ?? null,
      price: unitPriceNumeric(r.price, 14),
      deleted: r.deleted_at !== null && r.deleted_at !== undefined,
      default_supplier: def ? { id: def.id, name: def.name } : null,
      supplier: own
        ? {
            id: own.supplier_id,
            code: own.code ?? null,
            description: own.description ?? null,
            purchase_price: unitPriceNumeric(own.purchase_price, 14),
            cost_price: ctx.parts.stock && ctx.parts.purchases ? unitPriceNumeric(own.cost_price, 14) : null,
          }
        : null,
      last_purchase_price: last === null ? null : unitPriceNumeric(last, 14),
      suggested_price: unitPriceNumeric(suggested, 14),
    });
  }
  return { entity: "products", data_mode: "erp_native", supplier_id: supplier, mode, items,
    ...catalogUnavailable(ctx.parts, ["purchases", "stock"]) };
});
