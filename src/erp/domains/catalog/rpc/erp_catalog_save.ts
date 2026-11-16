// public.erp_catalog_save: o cadastro genérico (contatos, produtos e
// depósitos) sobre erp_catalog.mutate. Produto novo sem origem recebe a
// origem padrão (preferência produtos.origem_padrao); alteração de preço ou
// peso de componente recalcula os kits quando a composição está ligada.
import { one } from "../../../engine/driver.ts";
import { arrow, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import * as preferences from "../../preferences/public.ts";
import { requireAccess } from "../access.ts";
import { intArg, jsonArg, textArg, uuidArg } from "../args.ts";
import { compositionKits, compositionSync, compositionSyncOn } from "../composition.ts";
import { mutate } from "../record.ts";

export function erpCatalogSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const entity = textArg(a, "p_entity");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const input = jsonArg(a, "p_data");
  let v = input;
  if (entity === "products" && id === null && jsonType(input) === "object" && (arrow(input, "origin") ?? "") === "") {
    const done = command === null ? null : one(ctx.db, 'SELECT result FROM "erp_catalog__command" WHERE command_id=? AND actor=?', command, user);
    if (done) {
      // v_done #>> '{record,origin}'
      const origin = arrow((JSON.parse(String(done.result)) as { record?: unknown }).record ?? null, "origin");
      if (origin !== null && origin !== "") v = { ...(input as object), origin };
    } else {
      const pref = preferences.get(ctx.db, "produtos.origem_padrao");
      if (typeof pref === "string" && /^[0-8]$/.test(pref)) v = { ...(input as object), origin: pref };
    }
  }
  let kits: string[] = [];
  if (
    entity === "products" && id !== null && jsonType(input) === "object" &&
    ["price", "net_weight", "gross_weight"].some((k) => k in (input as object)) && compositionSyncOn(ctx)
  ) {
    requireAccess(ctx.db, user, "products", true);
    kits = compositionKits(ctx.db, [id]);
  }
  const result = mutate(ctx, { user, entity, id, expected, command, data: v, setActive: false, active: null });
  if (kits.length > 0 && result.replayed === false) compositionSync(ctx, user!, command!, compositionKits(ctx.db, [id!]));
  return result;
}

registerRpc("erp_catalog_save", erpCatalogSave);
