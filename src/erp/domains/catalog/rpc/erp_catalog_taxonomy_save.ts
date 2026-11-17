// public.erp_catalog_taxonomy_save: cria ou renomeia categoria, grupo de
// produto, grupo de etiquetas ou etiqueta; a categoria também liga os campos
// personalizados (custom_field_ids).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonArg } from "../args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { requireCustomFieldPermission } from "../custom-fields.ts";
import { CNTRL, btrim, chars, foldedKey } from "../fields.ts";
import { fold } from "../internal.ts";
import { taxonomyItem, taxonomyTypeGuard } from "../taxonomy.ts";
import { requireTaxonomyAccess, taxonomySpec } from "../taxonomy-access.ts";
import { categoryCustomFieldsSet, taxonomyAudit } from "../taxonomy-write.ts";

const MAX_VERSION = 2147483647;
const UUID_ANY = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function erpCatalogTaxonomySave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const kind = (a.p_kind ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const data = jsonArg(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  const spec = taxonomySpec(kind);
  const tagged = kind === "tag_groups" || kind === "tags";
  requireTaxonomyAccess(db, user, kind, null, true);
  const has = (k: string) => data !== null && typeof data === "object" && k in data;
  const ids = has("custom_field_ids") ? (data!.custom_field_ids as unknown[]) : null;
  if (
    spec === null || command === null || expected === null || data === null || jsonType(data) !== "object" ||
    (id === null && expected !== 0) || (id !== null && (expected < 1 || expected > MAX_VERSION)) ||
    Object.keys(data).some((k) => !["name", "parent_id", "tag_type", "custom_field_ids"].includes(k)) ||
    jsonType(data.name) !== "string" ||
    (has("parent_id") && !["string", "null"].includes(jsonType(data.parent_id)!)) ||
    (typeof data.parent_id === "string" && !UUID_ANY.test(data.parent_id)) ||
    (has("tag_type") && (!tagged || jsonType(data.tag_type) !== "string" || !["products", "contacts", "invoices"].includes(data.tag_type as string))) ||
    (ids !== null &&
      (kind !== "categories" || jsonType(ids) !== "array" || ids.length > 60 ||
        ids.some((x) => jsonType(x) !== "string" || !UUID_LOWER.test(x as string)) || new Set(ids).size !== ids.length))
  )
    raise("22023", "erp_catalog_invalid_command");
  const name = btrim(data.name as string);
  let parent = typeof data.parent_id === "string" ? data.parent_id.toLowerCase() : null;
  let type: string | null = null;
  if (tagged) {
    if (id !== null) {
      const stored = one(db, 'SELECT tag_type FROM "erp_catalog__taxonomy" WHERE id=? AND kind=?', id, kind);
      type = (stored?.tag_type as string | null | undefined) ?? null;
      if (type !== null && has("tag_type") && data.tag_type !== type) raise("22023", "erp_catalog_taxonomy_type_fixed");
    } else {
      const parentType = parent === null ? null : ((one(db, 'SELECT tag_type FROM "erp_catalog__taxonomy" WHERE id=?', parent)?.tag_type as string | null | undefined) ?? null);
      type = (data.tag_type as string | undefined) ?? parentType ?? "products";
    }
    requireTaxonomyAccess(db, user, kind, type ?? (data.tag_type as string | undefined) ?? "products", true);
  }
  if (ids !== null) requireCustomFieldPermission(db, user, "ie");
  if (name === "" || chars(name) > spec!.name || CNTRL.test(name)) raise("22023", "erp_catalog_invalid_text");
  const hash = requestHash({ actor: user, action: "taxonomy_save", kind, id, version: expected, data });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  let row: { name: string; version: number; parent_id: string | null; tag_type: string | null } | null = null;
  if (id === null) {
    if (parent !== null) {
      const p = one(db, 'SELECT kind, tag_type FROM "erp_catalog__taxonomy" WHERE id=?', parent);
      if (((p?.kind as string | undefined) ?? null) !== spec!.parent || (tagged && ((p?.tag_type as string | null | undefined) ?? null) !== type))
        raise("22023", "erp_catalog_taxonomy_parent_invalid");
    }
    if (Number(one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__taxonomy" WHERE kind=?', kind)!.n) >= 2000)
      raise("22023", "erp_catalog_taxonomy_limit");
  } else {
    const r = one(db, 'SELECT name, CAST(version AS TEXT) version, parent_id, tag_type FROM "erp_catalog__taxonomy" WHERE id=? AND kind=?', id, kind);
    if (!r) raise("P0002", "erp_catalog_not_found");
    row = { name: String(r.name), version: Number(r.version), parent_id: (r.parent_id as string | null) ?? null, tag_type: (r.tag_type as string | null) ?? null };
    if (row.version !== expected) raise("40001", "erp_catalog_version_conflict");
    if (has("parent_id") && parent !== row.parent_id) raise("22023", "erp_catalog_taxonomy_parent_fixed");
    parent = row.parent_id;
    type = row.tag_type;
  }
  const key = fold(name);
  const twin = db
    .exec('SELECT id, name, name__fold, parent_id, tag_type FROM "erp_catalog__taxonomy" WHERE kind=?', kind)
    .rows.some(
      (t) => ((t.parent_id as string | null) ?? null) === parent && ((t.tag_type as string | null) ?? null) === type &&
        foldedKey(t, "name") === key && t.id !== id,
    );
  if (twin) return { kind, saved: false, reason: "duplicate_name", replayed: false, data_mode: "erp_native" };
  let target: string;
  if (id === null) {
    target = crypto.randomUUID();
    const tagType = tagged ? type : null;
    taxonomyTypeGuard(db, null, { kind: kind!, parent_id: parent, tag_type: tagType });
    const now = ctx.clock.next().toString();
    db.exec(
      `INSERT INTO "erp_catalog__taxonomy"(id, kind, parent_id, name, version, created_by, updated_by, created_at, updated_at, tag_type, name__fold)
       VALUES(?,?,?,?,1,?,?,?,?,?,?)`,
      target, kind, parent, name, user, user, now, now, tagType, key,
    );
    taxonomyAudit(ctx, user!, command!, kind!, target, "create", null, taxonomyItem(db, target));
  } else {
    target = id;
    if (row!.name !== name) {
      if (row!.version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
      const before = taxonomyItem(db, id);
      taxonomyTypeGuard(db, { tag_type: row!.tag_type }, { kind: kind!, parent_id: row!.parent_id, tag_type: row!.tag_type });
      db.exec(
        'UPDATE "erp_catalog__taxonomy" SET name=?, name__fold=?, version=version+1, updated_by=?, updated_at=? WHERE id=?',
        name, key, user, ctx.clock.next().toString(), id,
      );
      taxonomyAudit(ctx, user!, command!, kind!, id, "update", before, taxonomyItem(db, id));
    }
  }
  const fields = ids === null ? null : (ids as string[]);
  const linked = fields === null ? 0 : categoryCustomFieldsSet(ctx, user!, command!, target, fields);
  if (linked > 0 && id !== null && row!.name === name) {
    if (row!.version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    const before = taxonomyItem(db, id);
    db.exec('UPDATE "erp_catalog__taxonomy" SET version=version+1, updated_by=?, updated_at=? WHERE id=?', user, ctx.clock.next().toString(), id);
    taxonomyAudit(ctx, user!, command!, kind!, id, "update", before, { ...taxonomyItem(db, id)!, custom_field_ids: fields });
  }
  const result = { kind, saved: true, item: taxonomyItem(db, target), replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_taxonomy_save", erpCatalogTaxonomySave);
