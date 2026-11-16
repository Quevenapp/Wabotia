// public.erp_catalog_product_price_preview: o resultado do reajuste de preço
// de venda (acréscimo, desconto ou valor fixo) para até 100 produtos, sem
// gravar. erp_catalog.price_rule_valid e price_rule_result.
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbKeys, jsonType } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { one } from "../../../engine/driver.ts";
import { jsonArg, uuidArg } from "../args.ts";
import { unitPriceNumeric } from "../internal.ts";
import { uuidArrayArg } from "../pricing/args.ts";
import { requireAccess } from "../pricing/deps.ts";
import { add, compareNum, mul, neg, num, round, shift, text, type Num } from "../pricing/money.ts";

const VALUE = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,4})?$/;

/** erp_catalog.price_rule_valid(p_rule jsonb) */
export function priceRuleValid(rule: unknown): boolean {
  if (jsonType(rule) !== "object") return false;
  const r = rule as Record<string, unknown>;
  if (jsonbKeys(r).some((k) => !["action", "unit", "value"].includes(k))) return false;
  const action = arrow(r, "action"),
    unit = arrow(r, "unit");
  if (action === null || !["increase", "discount", "fix"].includes(action)) return false;
  if (unit === null || !["amount", "percent"].includes(unit)) return false;
  if (jsonType(r.value) !== "string" || !VALUE.test(r.value as string)) return false;
  if (action === "fix" && unit !== "amount") return false;
  return !(action === "discount" && unit === "percent" && compareNum(num(r.value as string), num("100")) > 0);
}

/** Casas além de 10 (r <> trunc(r, 10)). */
function tooFine(r: Num) {
  if (r.s <= 10) return false;
  return r.v % 10n ** BigInt(r.s - 10) !== 0n;
}

/** erp_catalog.price_rule_result(p_price, p_rule) */
export function priceRuleResult(price: string | null, rule: Record<string, unknown>): Record<string, unknown> {
  const v = num(rule.value as string);
  const action = rule.action as string;
  const signed = action === "discount" ? neg(v) : v;
  let r: Num;
  if (action === "fix") r = v;
  else if (price === null) return { status: "no_price" };
  else if (rule.unit === "percent") {
    const base = num(price);
    r = round(add(base, shift(mul(base, signed), 2)), 2);
  } else r = add(num(price), signed);
  if (r.v < 0n) return { status: "negative" };
  if (compareNum(r, num("100000000000000")) >= 0 || tooFine(r)) return { status: "too_large" };
  return {
    status: price !== null && compareNum(r, num(price)) === 0 ? "unchanged" : "ok",
    price: unitPriceNumeric(text(r), 14),
  };
}

registerRpc("erp_catalog_product_price_preview", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  const rule = jsonArg(a, "p_rule");
  const ids = uuidArrayArg(a, "p_ids");
  const db = ctx.db;
  requireAccess(db, user, "products", false);
  if (!priceRuleValid(rule) || ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_catalog_invalid_query");
  const items = [];
  for (const id of ids as string[]) {
    const p = one(
      db,
      `SELECT p.price, d.deleted_at FROM "erp_catalog__product" p LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=p.record_id
       WHERE p.record_id=?`,
      id,
    );
    if (!p) continue;
    const price = (p.price as string | null) ?? null;
    const r = p.deleted_at !== null && p.deleted_at !== undefined ? { status: "deleted" } : priceRuleResult(price, rule as Record<string, unknown>);
    items.push({ id, price: unitPriceNumeric(price, 14), status: r.status, new_price: (r as { price?: string }).price ?? null });
  }
  return { entity: "products", data_mode: "erp_native", items };
});
