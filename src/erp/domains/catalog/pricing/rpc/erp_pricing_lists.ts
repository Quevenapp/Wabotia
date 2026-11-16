// public.erp_pricing_lists: as listas (sem os vínculos), com filtro por tipo,
// categoria, nome, produto e "Cadastrada em" (datas de São Paulo).
import { one } from "../../../../engine/driver.ts";
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { textArg, uuidArg } from "../args.ts";
import { CNTRL, chars, matches, searchTerms } from "../../fields.ts";
import { fold } from "../../internal.ts";
import { dateOrInfinity } from "../args.ts";
import { allLists, byFoldedName, leanHeader, requirePricing, saoPauloMidnight } from "../pricing.ts";

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function erpPricingLists(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const listType = textArg(a, "p_list_type");
  const query = textArg(a, "p_query");
  const category = textArg(a, "p_category");
  const product = uuidArg(a, "p_product_id");
  const from = dateOrInfinity(a, "p_from");
  const to = dateOrInfinity(a, "p_to");
  const db = ctx.db;
  requirePricing(db, user, false);
  const badDate = (d: string | null) => d !== null && (d.endsWith("infinity") || d < "1900-01-01" || d > "2100-12-31");
  if (
    (listType !== null && !["rates", "period", "custom"].includes(listType)) ||
    (category !== null && !["other", "contact", "seller", "payment_method", "region"].includes(category)) ||
    (query !== null && (chars(query) > 120 || CNTRL.test(query))) ||
    badDate(from) ||
    badDate(to) ||
    (from !== null && to !== null && from > to)
  )
    raise("22023", "erp_pricing_invalid_query");
  const terms = searchTerms(query);
  const low = from === null ? null : saoPauloMidnight(from);
  const high = to === null ? null : saoPauloMidnight(nextDay(to));
  const items = allLists(db)
    .filter(
      (l) =>
        (listType === null || l.list_type === listType) &&
        (category === null || l.category === category) &&
        (terms === null || matches(terms, fold(l.name), "", "")) &&
        (product === null ||
          one(db, 'SELECT 1 x FROM "erp_pricing__price_list_item" WHERE list_id=? AND product_id=?', l.id, product) !== null) &&
        (low === null || BigInt(l.created_at) >= low) &&
        (high === null || BigInt(l.created_at) < high),
    )
    .sort(byFoldedName((l) => l.name, (l) => l.id))
    .map((l) => leanHeader(db, l.id));
  return { data_mode: "erp_native", items };
}

registerRpc("erp_pricing_lists", erpPricingLists);
