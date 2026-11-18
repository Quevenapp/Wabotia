// Leituras do espelho do Origin no Catálogo (regra "Origin fora": leitura de
// tabela do Origin se porta como leitura; sem espelho, o mesmo vazio):
// public.erp_catalog_origin_mirror_get (o espelho de um contato ou produto e os
// complementos locais), erp_catalog_origin_categories (categorias da fonte) e
// erp_catalog_origin_deletions (produtos apagados ou restaurados na fonte).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { ERP_TABLES } from "../../../schema/columns.generated.ts";
import { requireAccess } from "../access.ts";
import { contactScope } from "../contact.ts";
import { compareText } from "../fields.ts";

const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));

/**
 * Chaves de to_jsonb(linha) - excluídas cujo valor não é null, "", false, []
 * nem {} (as colunas do Postgres; as calculadas do SQLite ficam fora).
 */
function filledKeys(db: SqlDriver, table: string, key: string, id: string, skip: string[]): string[] {
  const row = one(db, `SELECT * FROM "${table}" WHERE ${key}=?`, id);
  if (!row) return [];
  const cols = ERP_TABLES[table as keyof typeof ERP_TABLES].columns as Record<string, { codec: string }>;
  return Object.entries(cols)
    .filter(([name, c]) => !skip.includes(name) && c.codec !== "computed" && !name.endsWith("__fold"))
    .filter(([name, c]) => {
      const v = row[name];
      if (v === null || v === undefined) return false;
      if (c.codec === "bool") return !!Number(v);
      if (c.codec === "json") return !["[]", "{}", "null", '""'].includes(JSON.stringify(JSON.parse(String(v))));
      if (c.codec === "text") return v !== "";
      return true;
    })
    .map(([name]) => name)
    .sort(compareText);
}

export function erpCatalogOriginMirrorGet(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const entity = (a.p_entity ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const db = ctx.db;
  if (entity === null || !["contacts", "products"].includes(entity) || id === null) raise("22023", "erp_catalog_invalid_query");
  requireAccess(db, user, entity, false);
  let found: unknown;
  if (entity === "contacts") {
    const scope = contactScope(db, user);
    found = one(
      db,
      `SELECT 1 x FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id
       WHERE r.id=? AND r.entity='contacts' AND (? IS NULL OR cp.seller_id=?)`,
      id, scope, scope,
    );
  } else found = one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='products'`, id);
  if (!found) raise("P0002", "erp_catalog_not_found");
  const o = one(db, 'SELECT source_id, state, applied_hash, latest_hash FROM "erp_catalog__origin" WHERE record_id=?', id);
  const m = one(db, 'SELECT fields, CAST(synced_at AS TEXT) synced_at, CAST(source_updated_at AS TEXT) source_updated_at FROM "erp_catalog__origin_mirror" WHERE record_id=?', id);
  const raw =
    o?.source_id === null || o?.source_id === undefined
      ? null
      : one(db, 'SELECT version_hash, CAST(last_seen_at AS TEXT) last_seen_at FROM "origin_sync__raw_record" WHERE entity=? AND source_id=?', entity, o.source_id);
  let local: string[];
  if (entity === "contacts") {
    local = filledKeys(db, "erp_catalog__contact_profile", "record_id", id!, ["record_id", "version", "updated_at", "updated_by", "created_at", "created_by"]);
    if (one(db, 'SELECT 1 x FROM "erp_catalog__contact_role_complement" WHERE record_id=?', id)) local = [...local, "carrier_complement"];
  } else
    local = filledKeys(db, "erp_catalog__product_detail", "record_id", id!, ["record_id", "category_kind", "product_group_kind", "deleted_at", "deleted_by"]);
  const linked = o?.source_id !== null && o?.source_id !== undefined;
  const pending =
    linked &&
    (o!.applied_hash !== o!.latest_hash ||
      (raw !== null && raw !== undefined && raw.version_hash !== null && raw.version_hash !== o!.applied_hash));
  return {
    scope: "origin_mirror",
    entity,
    id,
    data_mode: "erp_native",
    system: "origin",
    linked,
    source_id: o?.source_id ?? null,
    state: o?.state ?? null,
    synced_at: ts(m?.synced_at),
    source_updated_at: ts(m?.source_updated_at),
    source_seen_at: ts(raw?.last_seen_at),
    pending,
    fields: m ? JSON.parse(String(m.fields)) : {},
    local_complements: local,
  };
}

export function erpCatalogOriginCategories(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "products", false);
  const raw = db
    .exec(`SELECT source_id, version_hash, CAST(last_seen_at AS TEXT) last_seen_at FROM "origin_sync__raw_record" WHERE entity='product_categories'`)
    .rows;
  const seen = raw.map((r) => BigInt(String(r.last_seen_at)));
  const pending = raw.filter(
    (r) =>
      !one(
        db,
        `SELECT 1 x FROM "erp_catalog__taxonomy_source" WHERE kind='categories' AND system='origin' AND source_id=? AND source_hash=?`,
        r.source_id, r.version_hash,
      ),
  ).length;
  const items = db
    .exec(
      `SELECT s.source_id, s.taxonomy_id, t.name, s.source_name, s.source_parent_id, t.parent_id, s.inactive, s.issue,
       CAST(s.synced_at AS TEXT) synced_at FROM "erp_catalog__taxonomy_source" s LEFT JOIN "erp_catalog__taxonomy" t ON t.id=s.taxonomy_id
       WHERE s.kind='categories' AND s.system='origin'`,
    )
    .rows.sort((x, y) => compareText(String(x.source_id), String(y.source_id)))
    .map((s) => ({
      source_id: s.source_id,
      taxonomy_id: s.taxonomy_id ?? null,
      name: s.name ?? null,
      source_name: s.source_name,
      source_parent_id: s.source_parent_id ?? null,
      parent_id: s.parent_id ?? null,
      inactive: !!Number(s.inactive),
      issue: s.issue ?? null,
      synced_at: ts(s.synced_at),
      removed_locally: s.taxonomy_id === null || s.taxonomy_id === undefined,
    }));
  return {
    scope: "origin_categories",
    data_mode: "erp_native",
    system: "origin",
    source_count: raw.length,
    source_seen_at: seen.length ? jsonTimestamp(seen.reduce((x, y) => (y > x ? y : x)).toString()) : null,
    pending,
    items,
  };
}

/** erp_catalog.origin_text(p_value, p_max): texto, número ou booleano, sem espaços nas pontas, até p_max. */
export function originText(value: unknown, max: number): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const t = pgBtrim(String(value));
  return t === "" ? null : pgLeft(t, max);
}

/** erp_catalog.origin_product_status(p_payload): 'E' se apagado na fonte; senão a situação A/I/E. */
export function originProductStatus(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  const source = p?._brufap_source as Record<string, unknown> | null | undefined;
  if (source !== null && typeof source === "object" && !Array.isArray(source) && source.deleted === true) return "E";
  const s = p !== null && typeof p === "object" && !Array.isArray(p) ? originText(p.situacao, 2) : null;
  return s !== null && ["A", "I", "E"].includes(s) ? s : null;
}

/** erp_catalog.origin_deletion_rows(): produtos a excluir (apagados na fonte) ou a restaurar. */
function originDeletionRows(db: SqlDriver) {
  return db
    .exec(
      `SELECT r.id, CAST(r.version AS TEXT) version, r.name, r.code, o.source_id, x.payload, CAST(d.deleted_at AS TEXT) deleted_at,
       (SELECT 1 FROM "erp_catalog__product_source_deletion" s WHERE s.record_id=r.id AND s.restored_at IS NULL LIMIT 1) pending
       FROM "erp_catalog__origin" o JOIN "erp_catalog__record" r ON r.id=o.record_id
       JOIN "origin_sync__raw_record" x ON x.entity='products' AND x.source_id=o.source_id
       LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE o.entity='products'`,
    )
    .rows.map((x): Record<string, unknown> & { status: string | null } => ({
      ...(x as Record<string, unknown>),
      status: originProductStatus(JSON.parse(String(x.payload))),
    }))
    .filter((x) =>
      x.deleted_at === null || x.deleted_at === undefined
        ? x.status === "E"
        : x.pending !== null && x.pending !== undefined && (x.status === "A" || x.status === "I"),
    );
}

export function erpCatalogOriginDeletions(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const limit = (a.p_limit ?? null) as number | null;
  const after = (a.p_after ?? null) as string | null;
  const db = ctx.db;
  const role = requireAccess(db, user, "products", false);
  if (limit === null || limit < 1 || limit > 100) raise("22023", "erp_catalog_invalid_query");
  const page = originDeletionRows(db)
    .filter((x) => after === null || String(x.id) > after)
    .sort((x, y) => compareText(String(x.id), String(y.id)))
    .slice(0, limit + 1);
  const seen = db.exec(`SELECT CAST(max(last_seen_at) AS TEXT) v FROM "origin_sync__raw_record" WHERE entity='products'`).rows[0]?.v;
  return {
    scope: "origin_deletions",
    data_mode: "erp_native",
    system: "origin",
    limit,
    has_more: page.length > limit,
    writable: role === "admin",
    items: page.slice(0, limit).map((p) => ({
      id: p.id,
      version: Number(p.version),
      name: p.name,
      code: p.code ?? null,
      source_id: p.source_id,
      source_status: p.status,
      action: p.deleted_at === null || p.deleted_at === undefined ? "delete" : "restore",
      deleted_at: ts(p.deleted_at),
    })),
    source_seen_at: ts(seen),
  };
}

registerRpc("erp_catalog_origin_mirror_get", erpCatalogOriginMirrorGet);
registerRpc("erp_catalog_origin_deletions", erpCatalogOriginDeletions);
registerRpc("erp_catalog_origin_categories", erpCatalogOriginCategories);
