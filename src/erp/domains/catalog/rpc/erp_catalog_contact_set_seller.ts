// public.erp_catalog_contact_set_seller: ação em lote que troca só o vendedor
// do contato (contact_apply com {seller_id}); "Campos obrigatórios" não
// bloqueia (lista vazia), para contatos antigos continuarem vinculáveis.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactApply } from "../contact-core.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogContactSetSeller(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const seller = (a.p_seller_id ?? null) as string | null;
  requireAccess(ctx.db, user, "contacts", true);
  if (id === null || command === null || expected === null || expected < 1 || expected > MAX_VERSION)
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-seller-v1", actor: user, id, version: expected, seller });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const record = contactApply(ctx, user!, id, expected, command, { seller_id: seller }, null, "update", []);
  const result = { entity: "contacts", record, replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_set_seller", erpCatalogContactSetSeller);
