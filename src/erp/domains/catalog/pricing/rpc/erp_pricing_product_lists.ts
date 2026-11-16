// public.erp_pricing_product_lists: as listas em que o produto está, com a
// regra e o preço da lista.
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { byFoldedName, listPrice, loadList, requirePricing, ruleText } from "../pricing.ts";

export function erpPricingProductLists(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const db = ctx.db;
  requirePricing(db, user, false);
  if (product === null) raise("22023", "erp_pricing_invalid_query");
  const items = db
    .exec(
      `SELECT i.list_id, i.custom_price, p.price FROM "erp_pricing__price_list_item" i
       JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.product_id=?`,
      product,
    )
    .rows.map((r) => ({ list: loadList(db, String(r.list_id))!, custom: r.custom_price as string | null, price: r.price as string | null }))
    .sort(byFoldedName((x) => x.list.name, (x) => x.list.id))
    .map((x) => ({
      id: x.list.id,
      name: x.list.name,
      list_type: x.list.list_type,
      rule: ruleText(x.list),
      list_price: listPrice(x.list, x.price ?? null, x.custom ?? null),
    }));
  return { data_mode: "erp_native", product_id: product, items };
}

registerRpc("erp_pricing_product_lists", erpPricingProductLists);
