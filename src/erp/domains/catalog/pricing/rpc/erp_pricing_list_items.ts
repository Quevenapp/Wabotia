// public.erp_pricing_list_items: inclui e retira produtos da lista e, só na
// lista customizada, grava preços e faz o reajuste em massa
// (acréscimo, desconto ou valor fixo, sobre o preço da lista ou do produto).
import { one } from "../../../../engine/driver.ts";
import { raise } from "../../../../engine/errors.ts";
import { arrow, jsonbKeys, jsonType } from "../../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { intArg, jsonArg, uuidArg } from "../../args.ts";
import { requestHash } from "../../command.ts";
import { unitPrice } from "../../internal.ts";
import { detailUuid } from "../deps.ts";
import { compareNum, num, text } from "../money.ts";
import {
  adjusted,
  audit,
  bumpVersion,
  checkViolation,
  header,
  liveProduct,
  loadList,
  replay,
  requirePricing,
  storeCommand,
} from "../pricing.ts";

const VALUE = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$/;
const MAX_VERSION = 2147483647;
const invalid = (): never => raise("22023", "erp_pricing_invalid_data");
const arr = (v: unknown) => (v === undefined ? [] : v);

export function erpPricingListItems(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const change = jsonArg(a, "p_change") as Record<string, unknown> | null;
  const db = ctx.db;
  requirePricing(db, user, true);
  if (
    change === null ||
    jsonType(change) !== "object" ||
    expected === null ||
    expected < 1 ||
    id === null ||
    jsonbKeys(change).some((k) => !["add", "remove", "prices", "adjust"].includes(k)) ||
    jsonType(arr(change.add)) !== "array" ||
    jsonType(arr(change.remove)) !== "array" ||
    jsonType(arr(change.prices)) !== "array" ||
    (arr(change.add) as unknown[]).length + (arr(change.remove) as unknown[]).length + (arr(change.prices) as unknown[]).length >
      500
  )
    invalid();
  const add = [...new Set((arr(change!.add) as unknown[]).map(detailUuid))];
  const remove = [...new Set((arr(change!.remove) as unknown[]).map(detailUuid))];
  const prices = arr(change!.prices) as unknown[];
  // p_change->'adjust' com null em JSON não é nulo: cai na validação.
  const adjust = change!.adjust === undefined ? null : (change!.adjust as Record<string, unknown>);
  const badPrice = (x: unknown) => {
    if (jsonType(x) !== "object") return true;
    const o = x as Record<string, unknown>;
    if (jsonbKeys(o).some((k) => !["product_id", "custom_price"].includes(k))) return true;
    if (detailUuid(o.product_id) === null) return true;
    const t = jsonType(o.custom_price);
    return t !== null && t !== "string" && t !== "null";
  };
  const badAdjust = () => {
    if (!("adjust" in change!)) return false;
    if (adjust === null || jsonType(adjust) !== "object") return true;
    if (jsonbKeys(adjust).some((k) => !["action", "unit", "value", "products"].includes(k))) return true;
    const action = arrow(adjust, "action") ?? "";
    const unit = arrow(adjust, "unit") ?? "";
    const value = arrow(adjust, "value") ?? "";
    if (!["increase", "discount", "fix"].includes(action) || !["amount", "percent"].includes(unit) || !VALUE.test(value))
      return true;
    if (action === "fix" && unit !== "amount") return true;
    if (action === "discount" && unit === "percent" && compareNum(num(value), num("100")) > 0) return true;
    return "products" in adjust && jsonType(adjust.products) !== "array";
  };
  if (prices.some(badPrice) || badAdjust()) invalid();
  const hash = requestHash({ actor: user, action: "items", id, version: expected, change });
  const replayed = replay(ctx, user!, command, hash);
  if (replayed) return replayed;
  const row = loadList(db, id);
  if (!row) raise("P0002", "erp_pricing_not_found");
  if (row.version !== expected) raise("40001", "erp_pricing_version_conflict");
  if (add.some((p) => p === null || !liveProduct(db, p)) || ((prices.length > 0 || adjust !== null) && row.list_type !== "custom"))
    invalid();
  const count = () => Number(one(db, 'SELECT count(*) n FROM "erp_pricing__price_list_item" WHERE list_id=?', id)!.n);
  const before = count();
  if (before + add.length > 15000) raise("22023", "erp_pricing_item_limit");
  for (const p of add)
    db.exec(
      'INSERT INTO "erp_pricing__price_list_item"(list_id, product_id, custom_price, added_at) VALUES (?,?,NULL,?) ON CONFLICT DO NOTHING',
      id,
      p,
      ctx.clock.next().toString(),
    );
  for (const p of remove)
    if (p !== null) db.exec('DELETE FROM "erp_pricing__price_list_item" WHERE list_id=? AND product_id=?', id, p);
  // UPDATE … FROM jsonb_array_elements: cada item da lista uma vez (o primeiro par).
  const priced = new Set<string>();
  for (const x of prices as Record<string, unknown>[]) {
    const product = detailUuid(x.product_id)!;
    if (priced.has(product)) continue;
    const inList = one(db, 'SELECT 1 x FROM "erp_pricing__price_list_item" WHERE list_id=? AND product_id=?', id, product);
    if (!inList) continue;
    priced.add(product);
    const value = arrow(x, "custom_price") === null ? null : unitPrice(x.custom_price, 14);
    db.exec('UPDATE "erp_pricing__price_list_item" SET custom_price=? WHERE list_id=? AND product_id=?', value, id, product);
  }
  if (adjust !== null) {
    const value = num(arrow(adjust, "value")!);
    const action = arrow(adjust, "action")!;
    const unit = arrow(adjust, "unit")!;
    const target =
      jsonType(adjust.products) === "array" ? new Set((adjust.products as unknown[]).map(detailUuid)) : null;
    const rows = db.exec(
      `SELECT i.product_id, i.custom_price, p.price FROM "erp_pricing__price_list_item" i
       JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.list_id=?`,
      id,
    ).rows;
    for (const r of rows) {
      const product = String(r.product_id);
      if (target !== null && !target.has(product)) continue;
      const base = num(String(r.custom_price ?? r.price ?? "0"));
      const price = adjusted(base, action, unit, value);
      // CHECK price_list_item_custom_price_check: o reajuste pode passar de 10^14.
      if (compareNum(price, num("100000000000000")) >= 0)
        checkViolation("price_list_item", "price_list_item_custom_price_check");
      db.exec(
        'UPDATE "erp_pricing__price_list_item" SET custom_price=? WHERE list_id=? AND product_id=?',
        text(price),
        id,
        product,
      );
    }
  }
  if (row.version === MAX_VERSION) raise("40001", "erp_pricing_version_exhausted");
  bumpVersion(ctx, id!, user!);
  const list = header(db, id!)!;
  const result = { saved: true, list, replayed: false, data_mode: "erp_native" };
  audit(ctx, {
    actor: user!,
    command: command!,
    list: id!,
    action: adjust === null ? "items" : "adjust",
    before: { products: before },
    after: { change, products: list.products },
  });
  storeCommand(ctx, user!, command!, hash, result);
  return result;
}

registerRpc("erp_pricing_list_items", erpPricingListItems);
