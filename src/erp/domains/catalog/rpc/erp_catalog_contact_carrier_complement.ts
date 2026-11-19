// public.erp_catalog_contact_carrier_complement: marca ou desmarca o contato
// como transportadora local (complemento do papel, sem mexer em roles).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactCarrierMatch } from "../carrier.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactScope, contactRequirePrivacy } from "../contact.ts";

export function erpCatalogContactCarrierComplement(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_contact_id ?? null) as string | null;
  const carrier = (a.p_carrier ?? null) as boolean | null;
  const command = (a.p_command_id ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  if (id === null || carrier === null || command === null) raise("22023", "erp_catalog_invalid_command");
  contactRequirePrivacy(db, id);
  const hash = requestHash({ actor: user, action: "contact_carrier_complement", id, carrier });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const scope = contactScope(db, user);
  const found = one(
    db,
    `SELECT 1 x FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id
     WHERE r.id=? AND r.entity='contacts' AND (? IS NULL OR cp.seller_id=?)`,
    id, scope, scope,
  );
  if (!found) raise("P0002", "erp_catalog_not_found");
  const before = !!one(db, `SELECT 1 x FROM "erp_catalog__contact_role_complement" WHERE record_id=? AND role='carrier'`, id);
  if (carrier && !before)
    db.exec(
      `INSERT INTO "erp_catalog__contact_role_complement"(record_id, role, created_by, created_at) VALUES(?,'carrier',?,?)`,
      id, user, ctx.clock.next().toString(),
    );
  else if (!carrier && before) db.exec(`DELETE FROM "erp_catalog__contact_role_complement" WHERE record_id=? AND role='carrier'`, id);
  if (carrier !== before)
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,'contacts',?,'carrier_complement',?,?,?)`,
      user, command, id, jsonbText({ carrier_complement: before }), jsonbText({ carrier_complement: carrier }), ctx.clock.next().toString(),
    );
  const result = {
    scope: "contact_carrier_complement",
    id,
    carrier_complement: carrier,
    carrier_match: contactCarrierMatch(db, id!),
    changed: carrier !== before,
    replayed: false,
    data_mode: "erp_native",
  };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_carrier_complement", erpCatalogContactCarrierComplement);
