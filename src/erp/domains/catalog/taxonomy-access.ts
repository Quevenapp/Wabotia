// Acesso e regras da taxonomia (erp_catalog.taxonomy_spec, tag_entity,
// invoice_tags_allowed, tag_types_readable e require_taxonomy_access).
// Base de erp_catalog_taxonomy_list/save/delete (sessão P), sobre o
// taxonomy.ts da B (taxonomy_item e o gatilho do tipo).
import type { SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { activeRole, permitted } from "../access/public.ts";
import { allowed, requireAccess } from "./access.ts";

/** erp_catalog.taxonomy_spec(p_kind): tamanho do nome e o tipo do pai. */
export function taxonomySpec(kind: string | null): { name: number; parent: string | null } | null {
  switch (kind) {
    case "categories":
      return { name: 50, parent: "categories" };
    case "product_groups":
      return { name: 100, parent: "product_groups" };
    case "tag_groups":
      return { name: 60, parent: null };
    case "tags":
      return { name: 60, parent: "tag_groups" };
    default:
      return null;
  }
}

/** erp_catalog.tag_entity(p_tag_type) */
export const tagEntity = (type: string | null) => (type === "products" ? "products" : type === "contacts" ? "contacts" : null);

/** erp_catalog.invoice_tags_allowed(p_role, p_write) */
export const invoiceTagsAllowed = (role: string | null, write: boolean | null) =>
  role !== null && (["admin", "fiscal"].includes(role) || (write !== true && role === "consulta"));

/** erp_catalog.tag_types_readable(p_user_id): tipos de etiqueta que o papel lê, em ordem. */
export function tagTypesReadable(db: SqlDriver, user: string | null): string[] {
  const role = user === null ? null : activeRole(db, user);
  if (role === null) return [];
  return ["contacts", "invoices", "products"].filter((t) =>
    t === "invoices" ? invoiceTagsAllowed(role, false) : allowed(role, tagEntity(t), false),
  );
}

/** erp_catalog.require_taxonomy_access(p_user_id, p_kind, p_tag_type, p_write) */
export function requireTaxonomyAccess(db: SqlDriver, user: string | null, kind: string | null, type: string | null, write: boolean) {
  if (kind === "tag_groups" || kind === "tags") {
    const role = user === null ? null : activeRole(db, user);
    if (type === "invoices") {
      if (!invoiceTagsAllowed(role, write)) raise("42501", "erp_catalog_access_denied");
    } else if (type !== null) requireAccess(db, user, tagEntity(type), write);
    else if (role === null || !(allowed(role, "products", write) || allowed(role, "contacts", write) || invoiceTagsAllowed(role, write)))
      raise("42501", "erp_catalog_access_denied");
    // 282: Sistema › Usuários › Permissões › Outros › Cadastro de grupos de tags / Cadastro de tags.
    if (write && !permitted(db, user!, kind === "tags" ? "outros.tags" : "outros.grupos_tags"))
      raise("42501", "erp_catalog_permission_denied");
  } else requireAccess(db, user, "products", write);
}
