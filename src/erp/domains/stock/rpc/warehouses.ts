// Depósitos no Estoque: public.erp_stock_warehouses, erp_stock_warehouse_options,
// erp_stock_warehouse_set_default, erp_stock_position_warehouses e
// erp_stock_product_locations; erp_stock.warehouse_access e warehouse_dto.
// A ordem por erp_catalog.fold(name) usa a coluna name__fold no SQL: a ordem
// BINARY do SQLite (bytes UTF-8) é a da collation C do oráculo.
// O gatilho guard_stock_warehouse_default (só por comando 'default', versão
// +1) é garantido aqui: este é o único escritor da tabela.
import { jsonbArg } from "../../../engine/args.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { allowed, fold, mutate } from "../../catalog/public.ts";
import { ignoredWarehouse } from "../home.ts";
import { commandTaken, requireAccess, sha256 } from "../internal.ts";

/** erp_stock.warehouse_access: papel ativo com acesso a depósitos (leitura ou escrita). */
export function warehouseAccess(db: SqlDriver, actor: string, write: boolean): string {
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor)?.role as string | undefined) ?? null;
  if (role === null || !allowed(role, "warehouses", write)) raise("42501", "erp_stock_warehouse_access_denied");
  return role;
}

/** erp_stock.warehouse_dto(p_id); null se não é depósito. */
export function warehouseDto(db: SqlDriver, id: string) {
  const r = one(
    db,
    `SELECT r.id, r.name, r.active, r.version, d.warehouse_id default_id, s.ignore_balance, s.version setting_version
     FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id CROSS JOIN "erp_stock__warehouse_default" d
     LEFT JOIN "erp_stock__warehouse_setting" s ON s.warehouse_id=r.id WHERE r.id=? AND r.entity='warehouses'`,
    id,
  );
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    active: r.active === 1,
    version: Number(r.version),
    is_default: r.default_id === r.id,
    ignore_balance: r.ignore_balance === 1,
    setting_version: r.setting_version === null || r.setting_version === undefined ? 0 : Number(r.setting_version),
  };
}

const defaultRow = (db: SqlDriver) => one(db, 'SELECT warehouse_id, version FROM "erp_stock__warehouse_default" WHERE singleton=1');

// warehouse_setting só é alterada depois do recibo 'save', com versão +1;
// a camada de tabela do Catálogo executa os gatilhos do cadastro.
registerRpc("erp_stock_warehouse_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string, command = a.p_command_id as string | null,
    warehouse = a.p_warehouse_id as string | null, expected = a.p_expected_version as number | null,
    settingVersion = a.p_expected_setting_version as number | null, name = a.p_name as string | null,
    ignore = a.p_ignore_balance as boolean | null;
  warehouseAccess(db, user, true);
  if (command === null || expected === null || settingVersion === null || ignore === null ||
    expected < 0 || expected > 2147483646 || settingVersion < 0 || settingVersion > 2147483646 ||
    (warehouse === null) !== (expected === 0) || (warehouse === null && settingVersion !== 0) ||
    name === null || name !== pgBtrim(name) || pgLength(name) < 1 || pgLength(name) > 200 || pgHasCntrl.test(name))
    raise("22023", "erp_stock_warehouse_input_invalid");
  const hash = sha256(jsonbText({ profile: "stock-warehouse-save-105", actor: user, warehouse_id: warehouse,
    expected_version: expected, expected_setting_version: settingVersion, name, ignore_balance: ignore }));
  const c = one(db, 'SELECT * FROM "erp_stock__warehouse_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "save" || c.request_hash !== hash) raise("40001", "erp_stock_warehouse_command_conflict");
    return { ...JSON.parse(String(c.result)), warehouse: warehouseDto(db, String(c.warehouse_id)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, 'SELECT 1 x FROM "erp_catalog__command" WHERE command_id=?', command))
    raise("40001", "erp_stock_warehouse_command_conflict");
  const catalog = mutate(ctx, user, "warehouses", warehouse, expected, command, { name }, false, null);
  const record = catalog.record as { id: string; version: number };
  const s = one(db, 'SELECT * FROM "erp_stock__warehouse_setting" WHERE warehouse_id=?', record.id);
  if (Number(s?.version ?? 0) !== settingVersion || Number(s?.version ?? 0) === 2147483647)
    raise("40001", "erp_stock_warehouse_version_conflict");
  const changed = (s?.ignore_balance === 1) !== ignore, at = ctx.clock.next();
  const result = { scope: "stock_warehouse", data_mode: "erp_native", receipt: {
    command_id: command, action: "save", created: warehouse === null,
    catalog_changed: warehouse === null || Number(record.version) !== expected, setting_changed: changed,
    from: { ignore_balance: s?.ignore_balance === 1 }, to: { ignore_balance: ignore }, saved_at: jsonTimestamp(at),
  } };
  db.exec('INSERT INTO "erp_stock__warehouse_command"(id,actor,action,warehouse_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "save", record.id, hash, JSON.stringify(result), ctx.clock.next().toString());
  if (changed) db.exec(`INSERT INTO "erp_stock__warehouse_setting"(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id)
    VALUES(?,?,1,?,?,?) ON CONFLICT(warehouse_id) DO UPDATE SET ignore_balance=excluded.ignore_balance,
    version=version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by,command_id=excluded.command_id`,
    record.id, ignore ? 1 : 0, at.toString(), user, command);
  warehouseAccess(db, user, true);
  return { ...result, warehouse: warehouseDto(db, record.id), replayed: false };
});

registerRpc("erp_stock_warehouses", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const role = warehouseAccess(db, a.p_user_id as string, false);
  const page = a.p_page as number | null,
    size = a.p_size as number | null,
    query = a.p_query as string | null,
    active = a.p_active as boolean | null;
  if (
    page === null || page < 1 || page > 100000 || size === null || size < 1 || size > 100 ||
    (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query)))
  )
    raise("22023", "erp_stock_invalid_query");
  const term = query === null || pgBtrim(query) === "" ? null : fold(pgBtrim(query));
  const where = `WHERE (? IS NULL OR r.active=?) AND (? IS NULL OR instr(r.name__fold, ?)>0)`;
  const params = [active === null ? null : active ? 1 : 0, active === null ? null : active ? 1 : 0, term, term];
  const from = `FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id ${where}`;
  const ids = db.exec(`SELECT r.id ${from} ORDER BY r.name__fold, r.id LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size).rows;
  const total = Number(one(db, `SELECT count(*) n ${from}`, ...params)!.n);
  const d = defaultRow(db);
  return {
    items: ids.map((r) => warehouseDto(db, String(r.id))),
    page,
    size,
    total,
    default: d ? { warehouse_id: d.warehouse_id, version: Number(d.version) } : null,
    can_manage: allowed(role, "warehouses", true),
    scope: "stock_warehouses",
    data_mode: "erp_native",
  };
});

registerRpc("erp_stock_warehouse_options", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const from = `FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id CROSS JOIN "erp_stock__warehouse_default" d`;
  const rows = db.exec(
    `SELECT * FROM (SELECT r.id, r.name, r.active, r.name__fold f, d.warehouse_id default_id ${from} ORDER BY r.active DESC, r.name__fold, r.id LIMIT 500) ORDER BY f, id`,
  ).rows;
  return {
    scope: "stock_warehouse_options",
    data_mode: "erp_native",
    total: Number(one(db, `SELECT count(*) n ${from}`)!.n),
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active === 1,
      is_default: r.default_id === r.id,
      ignore_balance: ignoredWarehouse(db, String(r.id)),
    })),
  };
});

registerRpc("erp_stock_warehouse_set_default", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string,
    command = a.p_command_id as string | null,
    warehouse = a.p_warehouse_id as string | null,
    expected = a.p_expected_version as number | null;
  warehouseAccess(db, user, true);
  if (command === null || warehouse === null || expected === null || expected < 0 || expected > 2147483646)
    raise("22023", "erp_stock_warehouse_input_invalid");
  const hash = sha256(jsonbText({ profile: "stock-warehouse-default-105", actor: user, warehouse_id: warehouse, expected_version: expected }));
  const c = one(db, 'SELECT actor, action, warehouse_id, request_hash, result FROM "erp_stock__warehouse_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "default" || c.request_hash !== hash) raise("40001", "erp_stock_warehouse_command_conflict");
    return { ...JSON.parse(String(c.result)), warehouse: warehouseDto(db, String(c.warehouse_id)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, 'SELECT 1 x FROM "erp_catalog__command" WHERE command_id=?', command))
    raise("40001", "erp_stock_warehouse_command_conflict");
  const r = one(
    db,
    `SELECT x.active FROM "erp_catalog__record" x JOIN "erp_catalog__warehouse" w ON w.record_id=x.id WHERE x.id=? AND x.entity='warehouses'`,
    warehouse,
  );
  if (!r) raise("P0002", "erp_stock_warehouse_not_found");
  if (r.active !== 1) raise("22023", "erp_stock_default_warehouse_inactive");
  const d = defaultRow(db)!;
  const version = Number(d.version);
  if (version !== expected || version === 2147483647) raise("40001", "erp_stock_warehouse_version_conflict");
  if (d.warehouse_id === warehouse) raise("22023", "erp_stock_warehouse_default_unchanged");
  const at = ctx.clock.next();
  const result = {
    scope: "stock_warehouse",
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      action: "default",
      from: { warehouse_id: d.warehouse_id ?? null, version },
      to: { warehouse_id: warehouse, version: version + 1 },
      saved_at: jsonTimestamp(at),
    },
  };
  db.exec(
    'INSERT INTO "erp_stock__warehouse_command"(id, actor, action, warehouse_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "default", warehouse, hash, JSON.stringify(result), at.toString(),
  );
  db.exec(
    'UPDATE "erp_stock__warehouse_default" SET warehouse_id=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE singleton=1',
    warehouse, at.toString(), user, command,
  );
  warehouseAccess(db, user, true);
  return { ...result, warehouse: warehouseDto(db, warehouse), replayed: false };
});

registerRpc("erp_stock_position_warehouses", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const limit = a.p_limit as number | null,
    after = a.p_after as string | null;
  if (limit === null || limit < 1 || limit > 100) raise("22023", "erp_stock_invalid_query");
  const ids = db.exec(
    `SELECT r.id, r.name, r.active FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id WHERE ? IS NULL OR r.id>? ORDER BY r.id LIMIT ?`,
    after, after, limit + 1,
  ).rows;
  const more = ids.length > limit;
  const page = ids.slice(0, limit);
  return {
    items: page.map((r) => ({ id: r.id, name: r.name, active: r.active === 1 })),
    limit,
    has_more: more,
    next_cursor: more ? page[page.length - 1].id : null,
    data_mode: "erp_native",
    scope: "stock_warehouse_options",
  };
});

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CNTRL_RUN = new RegExp(`(?:${PG_CNTRL})+`, "gu");

registerRpc("erp_stock_product_locations", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const ids = jsonbArg(a.p_ids) as any;
  if (
    ids === null || ids === undefined || jsonType(ids) !== "array" || ids.length < 1 || ids.length > 500 ||
    ids.some((x: unknown) => typeof x !== "string" || !UUID_LOWER.test(x)) ||
    new Set(ids).size !== ids.length
  )
    raise("22023", "erp_stock_invalid_query");
  const rows = db.exec(
    `SELECT p.record_id, p.location FROM "erp_catalog__product" p WHERE p.record_id IN (SELECT value FROM json_each(?)) ORDER BY p.record_id`,
    JSON.stringify(ids),
  ).rows;
  return {
    scope: "stock_product_locations",
    data_mode: "erp_native",
    items: rows.map((r) => {
      const location = r.location === null ? null : pgBtrim(String(r.location).replace(CNTRL_RUN, " "));
      return { product_id: r.record_id, location: location === "" ? null : location };
    }),
  };
});
