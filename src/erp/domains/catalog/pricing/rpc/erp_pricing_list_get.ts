// public.erp_pricing_list_get: a lista com os produtos (busca por nome,
// código e GTIN), o preço do produto, o customizado e o da lista.
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { intArg, textArg, uuidArg } from "../args.ts";
import { CNTRL, chars, matches, searchTerms } from "../../fields.ts";
import { fold, unitPriceNumeric } from "../../internal.ts";
import { byFoldedName, header, listPrice, loadList, requirePricing } from "../pricing.ts";

export function erpPricingListGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const query = textArg(a, "p_query");
  const offset = intArg(a, "p_offset", 0);
  const limit = intArg(a, "p_limit", 100);
  const db = ctx.db;
  requirePricing(db, user, false);
  if (
    offset === null ||
    offset < 0 ||
    offset > 1000000 ||
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    (query !== null && (chars(query) > 120 || CNTRL.test(query)))
  )
    raise("22023", "erp_pricing_invalid_query");
  const list = id === null ? null : loadList(db, id);
  if (!list) raise("P0002", "erp_pricing_not_found");
  const terms = searchTerms(query);
  const rows = db
    .exec(
      `SELECT i.product_id, i.custom_price, r.name, r.code, p.gtin, p.price FROM "erp_pricing__price_list_item" i
       JOIN "erp_catalog__record" r ON r.id=i.product_id JOIN "erp_catalog__product" p ON p.record_id=i.product_id
       WHERE i.list_id=?`,
      id,
    )
    .rows.map((r) => ({
      id: String(r.product_id),
      name: String(r.name),
      code: (r.code as string | null) ?? null,
      gtin: (r.gtin as string | null) ?? null,
      price: (r.price as string | null) ?? null,
      custom: (r.custom_price as string | null) ?? null,
    }))
    .filter(
      (x) => terms === null || matches(terms, fold([x.name, x.code, x.gtin].filter((v) => v !== null).join(" ")), "", ""),
    )
    .sort(byFoldedName((x) => x.name, (x) => x.id));
  const items = rows.slice(offset, offset + limit).map((x) => ({
    product_id: x.id,
    name: x.name,
    code: x.code,
    gtin: x.gtin,
    product_price: unitPriceNumeric(x.price, 14),
    custom_price: unitPriceNumeric(x.custom, 14),
    list_price: listPrice(list, x.price, x.custom),
  }));
  return { data_mode: "erp_native", list: header(db, id!), items, total: rows.length, offset, limit };
}

registerRpc("erp_pricing_list_get", erpPricingListGet);
