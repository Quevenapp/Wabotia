// public.erp_catalog_contact_types: tipos ativos, por posição e slug, com o
// número de contatos (papéis em contact.roles ou vínculos em contact_type_link).
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { allowed, requireAccess } from "../access.ts";
import { compareText } from "../fields.ts";

export function erpCatalogContactTypes(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const role = requireAccess(ctx.db, user, "contacts", false);
  const items = ctx.db
    .exec(
      `SELECT t.id, t.slug, t.label, t.system, t.deletable, t.position,
       CASE WHEN t.role_backed THEN (SELECT count(*) FROM "erp_catalog__contact" c WHERE EXISTS (SELECT 1 FROM json_each(c.roles) r WHERE r.value=t.slug))
       ELSE (SELECT count(*) FROM "erp_catalog__contact_type_link" l WHERE l.type_id=t.id) END contacts
       FROM "erp_catalog__contact_type" t WHERE t.active=1`,
    )
    .rows.sort((x, y) => Number(x.position) - Number(y.position) || compareText(String(x.slug), String(y.slug)))
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      label: t.label,
      system: !!Number(t.system),
      deletable: !!Number(t.deletable),
      position: Number(t.position),
      contacts: Number(t.contacts),
    }));
  return {
    scope: "contact_types",
    data_mode: "erp_native",
    can_create: allowed(role, "contacts", true),
    can_delete: role === "admin",
    items,
  };
}

registerRpc("erp_catalog_contact_types", erpCatalogContactTypes);
