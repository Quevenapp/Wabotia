// public.erp_catalog_seller_from_contact ("Tornar vendedor"): o contato ganha
// o tipo Vendedor (sem os campos obrigatórios, porque o formulário não aparece)
// e uma configuração de vendedor com os valores padrão.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactApply, contactData, contactDto } from "../contact-core.ts";
import { sellerAccess, sellerDto, sellerSettings, sellerWrite } from "../seller.ts";
import { jsonbHas } from "./erp_catalog_seller_save.ts";

const DEFAULTS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};

export function erpCatalogSellerFromContact(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const command = (a.p_command_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  const db = ctx.db;
  sellerAccess(db, user, true);
  requireAccess(db, user, "contacts", true);
  if (command === null || contact === null) raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-seller-from-contact-v1", actor: user, contact });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const row = one(db, `SELECT CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, contact);
  if (!row) raise("P0002", "erp_catalog_not_found");
  if (one(db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE contact_id=?', contact)) raise("23505", "erp_catalog_seller_exists");
  const types = (contactData(db, contact)?.types as unknown[] | undefined) ?? [];
  // Só o tipo muda: "Campos obrigatórios" não bloqueia (o formulário não aparece).
  if (!jsonbHas(types, "seller")) contactApply(ctx, user!, contact, Number(row.version), command, { types: [...types, "seller"] }, null, "update", []);
  const id = sellerWrite(ctx, user!, null, contact, sellerSettings(DEFAULTS));
  auxiliaryAudit(ctx, { actor: user!, command, subject: "seller", subjectId: id, action: "create", after: sellerDto(db, id) });
  const result = { entity: "sellers", data_mode: "erp_native", replayed: false, seller: sellerDto(db, id), contact: contactDto(db, contact) };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_seller_from_contact", erpCatalogSellerFromContact);
