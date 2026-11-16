// public.erp_pricing_list_delete: exclui a lista (produtos e vínculos vão
// junto pela cascata), com a versão esperada e a trilha.
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { intArg, uuidArg } from "../../args.ts";
import { requestHash } from "../../command.ts";
import { audit, header, loadList, replay, requirePricing, storeCommand } from "../pricing.ts";

export function erpPricingListDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const db = ctx.db;
  requirePricing(db, user, true);
  if (id === null || expected === null || expected < 1) raise("22023", "erp_pricing_invalid_data");
  const hash = requestHash({ actor: user, action: "delete", id, version: expected });
  const replayed = replay(ctx, user!, command, hash);
  if (replayed) return replayed;
  const row = loadList(db, id);
  if (!row) raise("P0002", "erp_pricing_not_found");
  if (row.version !== expected) raise("40001", "erp_pricing_version_conflict");
  const before = header(db, id);
  db.exec('DELETE FROM "erp_pricing__price_list" WHERE id=?', id);
  const result = { deleted: true, id, replayed: false, data_mode: "erp_native" };
  audit(ctx, { actor: user!, command: command!, list: id, action: "delete", before, after: null });
  storeCommand(ctx, user!, command!, hash, result);
  return result;
}

registerRpc("erp_pricing_list_delete", erpPricingListDelete);
