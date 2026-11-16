// public.erp_pricing_list_prices: o preço da lista para um conjunto de
// produtos (até 100), na ordem pedida, para os documentos.
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { one } from "../../../../engine/driver.ts";
import { uuidArrayArg } from "../args.ts";
import { listPrice, loadList, requirePricing, ruleText, validNow } from "../pricing.ts";

export function erpPricingListPrices(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const ids = uuidArrayArg(a, "p_product_ids");
  const db = ctx.db;
  requirePricing(db, user, false);
  if (id === null || ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_pricing_invalid_query");
  const list = loadList(db, id);
  if (!list) raise("P0002", "erp_pricing_not_found");
  const items = [];
  for (const product of ids as string[]) {
    const p = one(db, 'SELECT price FROM "erp_catalog__product" WHERE record_id=?', product);
    if (!p) continue;
    const item = one(db, 'SELECT custom_price FROM "erp_pricing__price_list_item" WHERE list_id=? AND product_id=?', id, product);
    items.push({
      product_id: product,
      in_list: item !== null,
      list_price:
        item === null ? null : listPrice(list, (p.price as string | null) ?? null, (item.custom_price as string | null) ?? null),
    });
  }
  return {
    data_mode: "erp_native",
    list: { id: list.id, name: list.name, list_type: list.list_type, rule: ruleText(list), valid_now: validNow(list), version: list.version },
    items,
  };
}

registerRpc("erp_pricing_list_prices", erpPricingListPrices);
