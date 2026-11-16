// public.erp_pricing_list_clone: copia a lista (regra, produtos com o preço
// customizado e vínculos) com outro nome. Mais de 15.000 produtos ou nome
// repetido não gravam.
import { one } from "../../../../engine/driver.ts";
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { textArg, uuidArg } from "../args.ts";
import { requestHash } from "../../command.ts";
import { CNTRL, btrim, chars } from "../../fields.ts";
import { fold } from "../../internal.ts";
import { allLists, audit, header, loadList, replay, requirePricing, storeCommand } from "../pricing.ts";

export function erpPricingListClone(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const command = uuidArg(a, "p_command_id");
  const raw = textArg(a, "p_name");
  const db = ctx.db;
  requirePricing(db, user, true);
  const name = raw === null ? null : btrim(raw);
  if (id === null || name === null || name === "" || chars(name) > 120 || CNTRL.test(name))
    raise("22023", "erp_pricing_invalid_data");
  const hash = requestHash({ actor: user, action: "clone", id, name });
  const replayed = replay(ctx, user!, command, hash);
  if (replayed) return replayed;
  const source = loadList(db, id);
  if (!source) raise("P0002", "erp_pricing_not_found");
  const count = Number(one(db, 'SELECT count(*) n FROM "erp_pricing__price_list_item" WHERE list_id=?', id)!.n);
  if (count > 15000) return { saved: false, reason: "too_many_products", replayed: false, data_mode: "erp_native" };
  const folded = fold(name);
  if (allLists(db).some((l) => fold(l.name) === folded))
    return { saved: false, reason: "duplicate_name", replayed: false, data_mode: "erp_native" };
  const target = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  db.exec(
    `INSERT INTO "erp_pricing__price_list"(id, name, category, list_type, factor, factor_unit, direction, considers_datetime,
     starts_on, ends_on, start_time, end_time, version, created_by, updated_by, created_at, updated_at, name__fold)
     SELECT ?, ?, category, list_type, factor, factor_unit, direction, considers_datetime, starts_on, ends_on, start_time,
     end_time, 1, ?, ?, ?, ?, ? FROM "erp_pricing__price_list" WHERE id=?`,
    target,
    name,
    user,
    user,
    now,
    now,
    folded,
    id,
  );
  db.exec(
    `INSERT INTO "erp_pricing__price_list_item"(list_id, product_id, custom_price, added_at)
     SELECT ?, product_id, custom_price, ? FROM "erp_pricing__price_list_item" WHERE list_id=?`,
    target,
    ctx.clock.next().toString(),
    id,
  );
  for (const [t, c] of [
    ["contact", "contact_id"],
    ["region", "state"],
    ["seller", "seller_id"],
    ["payment_method", "payment_method_id"],
  ])
    db.exec(
      `INSERT INTO "erp_pricing__price_list_${t}"(list_id, ${c}) SELECT ?, ${c} FROM "erp_pricing__price_list_${t}" WHERE list_id=?`,
      target,
      id,
    );
  const list = header(db, target)!;
  const result = { saved: true, list, replayed: false, data_mode: "erp_native" };
  audit(ctx, { actor: user!, command: command!, list: target, action: "clone", before: { source: id }, after: list });
  storeCommand(ctx, user!, command!, hash, result);
  return result;
}

registerRpc("erp_pricing_list_clone", erpPricingListClone);
