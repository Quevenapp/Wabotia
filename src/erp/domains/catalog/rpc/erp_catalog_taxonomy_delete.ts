// public.erp_catalog_taxonomy_delete: exclui o item sem filhos (grupo de
// produto em uso não sai) e tira o vínculo de produtos, contatos ou notas.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { taxonomyItem } from "../taxonomy.ts";
import { requireTaxonomyAccess, requireTaxonomyReplayAccess, taxonomySpec } from "../taxonomy-access.ts";
import { taxonomyAudit, taxonomyDetach, taxonomyDetachContacts, taxonomyDetachInvoices } from "../taxonomy-write.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogTaxonomyDelete(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const kind = (a.p_kind ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const db = ctx.db;
  requireTaxonomyAccess(db, user, kind, null, true, ctx.modules);
  if (taxonomySpec(kind) === null || id === null || command === null || expected === null || expected < 1 || expected > MAX_VERSION)
    raise("22023", "erp_catalog_invalid_command");
  if (kind === "tag_groups" || kind === "tags") {
    const stored = one(db, 'SELECT tag_type FROM "erp_catalog__taxonomy" WHERE id=? AND kind=?', id, kind);
    requireTaxonomyAccess(db, user, kind, (stored?.tag_type as string | null | undefined) ?? "products", true, ctx.modules);
  }
  const hash = requestHash({ actor: user, action: "taxonomy_delete", kind, id, version: expected });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) {
    requireTaxonomyReplayAccess(ctx, user, kind, command, replayed);
    return replayed;
  }
  const row = one(db, 'SELECT id, kind, CAST(version AS TEXT) version, tag_type FROM "erp_catalog__taxonomy" WHERE id=? AND kind=?', id, kind);
  if (!row) raise("P0002", "erp_catalog_not_found");
  if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
  const before = taxonomyItem(db, id)!;
  if (Number(before.children) > 0) return { kind, id, deleted: false, reason: "has_children", replayed: false, data_mode: "erp_native" };
  if (kind === "product_groups" && Number(before.products) > 0)
    return { kind, id, deleted: false, reason: "in_use", replayed: false, data_mode: "erp_native" };
  let affected = 0;
  if (kind === "categories" || (kind === "tags" && row.tag_type === "products")) affected = taxonomyDetach(ctx, user!, command, { id, kind: kind! });
  if (kind === "tags" && row.tag_type === "contacts") affected = taxonomyDetachContacts(ctx, user!, command, id);
  if (kind === "tags" && row.tag_type === "invoices") affected = taxonomyDetachInvoices(ctx, user!, command, id);
  db.exec('DELETE FROM "erp_catalog__taxonomy" WHERE id=?', id);
  taxonomyAudit(ctx, user!, command, kind!, id, "delete", before, null);
  const result = { kind, id, deleted: true, products: affected, replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_taxonomy_delete", erpCatalogTaxonomyDelete);
