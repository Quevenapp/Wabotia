// public.erp_catalog_custom_fields_screen: a tela de campos customizados (as
// definições e o que a pessoa pode fazer: incluir/editar e excluir).
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { allowed, requireAccess } from "../access.ts";
import { customFieldPermitted, requireCustomFieldPermission } from "../custom-fields.ts";
import { customFields } from "./erp_catalog_custom_fields.ts";

export function erpCatalogCustomFieldsScreen(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const db = ctx.db;
  const role = requireAccess(db, user, "products", false);
  requireCustomFieldPermission(db, user, "view");
  const write = allowed(role, "products", true);
  return {
    ...customFields(db, user, "products"),
    permissions: {
      insert_edit: write && customFieldPermitted(db, user, "ie"),
      delete: write && customFieldPermitted(db, user, "ex"),
    },
  };
}

registerRpc("erp_catalog_custom_fields_screen", erpCatalogCustomFieldsScreen);
