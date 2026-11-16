// Preferências de lista (migração 116): colunas e filtros padrão de cada
// usuário por lista, versionados, com recibo do comando e trilha.
// public.erp_list_preferences_get, _save e _command; internas reader,
// member, list_valid, valid e dto. Os gatilhos guard_preference e
// immutable_history são cumpridos aqui: as linhas só mudam por comando.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { int, json, text, uuid } from "../args.ts";

const invalid = (): never => raise("22023", "erp_list_preferences_input_invalid");
const isNull = (v: unknown) => v === null || v === undefined;
const CONTROL = /[\x01-\x1f\x7f]/;

/** erp_list_preferences.reader / member: membro ativo, senão 42501. */
function member(db: SqlDriver, actor: string | null) {
  if (actor === null || !one(db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', actor))
    raise("42501", "erp_list_preferences_access_denied");
}

/** erp_list_preferences.list_valid */
const listValid = (list: string | null) =>
  list !== null && pgLength(list) <= 60 && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(list);

/** erp_list_preferences.valid(p_columns, p_filters): SQL NULL e null do JSON são "sem valor salvo". */
export function listPreferenceValid(columns: unknown, filters: unknown): boolean {
  if (!isNull(columns)) {
    const c = columns as unknown[];
    if (
      jsonType(columns) !== "array" ||
      c.length < 1 ||
      c.length > 60 ||
      c.some((x) => jsonType(x) !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(x as string)) ||
      new Set(c).size !== c.length
    )
      return false;
  }
  if (!isNull(filters)) {
    const f = filters as Record<string, unknown>;
    if (jsonType(filters) !== "object" || Object.keys(f).length > 20 || new TextEncoder().encode(jsonbText(f)).length > 8192) return false;
    for (const k of jsonbKeys(f)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return false;
      const v = f[k];
      switch (jsonType(v)) {
        case "string":
          if (pgLength(v as string) > 200 || CONTROL.test(v as string)) return false;
          break;
        case "boolean":
          break;
        case "number":
          if (!/^-?(0|[1-9][0-9]{0,8})$/.test(jsonbText(v))) return false;
          break;
        case "array":
          if (
            (v as unknown[]).length > 50 ||
            (v as unknown[]).some((e) => jsonType(e) !== "string" || pgLength(e as string) > 100 || CONTROL.test(e as string))
          )
            return false;
          break;
        default:
          return false;
      }
    }
  }
  return true;
}

interface Row {
  columns: string[] | null;
  filters: unknown;
  version: number;
  updated_at: string;
}
function row(db: SqlDriver, user: string, list: string): Row | null {
  const r = one(
    db,
    `SELECT columns, filters, CAST(version AS TEXT) version, CAST(updated_at AS TEXT) updated_at
     FROM "erp_list_preferences__preference" WHERE user_id=? AND list_id=?`,
    user,
    list,
  );
  if (!r) return null;
  return {
    columns: r.columns === null ? null : (JSON.parse(String(r.columns)) as string[]),
    filters: r.filters === null ? null : JSON.parse(String(r.filters)),
    version: Number(r.version),
    updated_at: String(r.updated_at),
  };
}

/** erp_list_preferences.dto(p_user, p_list) */
function dto(db: SqlDriver, user: string, list: string) {
  const p = row(db, user, list);
  return {
    scope: "list_preferences",
    data_mode: "erp_native",
    list_id: list,
    version: p?.version ?? 0,
    columns: p?.columns ?? null,
    filters: p?.filters ?? null,
    updated_at: p ? jsonTimestamp(p.updated_at) : null,
  };
}

const parsed = (v: string) => JSON.parse(v) as Record<string, unknown>;

/** public.erp_list_preferences_get */
export function erpListPreferencesGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const list = text(a, "p_list_id");
  member(ctx.db, user);
  if (!listValid(list)) invalid();
  return dto(ctx.db, user!, list!);
}

/** public.erp_list_preferences_command: o recibo de um comando (só do autor). */
export function erpListPreferencesCommand(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const db = ctx.db;
  member(db, user);
  if (command === null) invalid();
  const c = one(db, 'SELECT actor, list_id, result FROM "erp_list_preferences__command" WHERE id=?', command);
  if (!c) raise("P0002", "erp_list_preferences_command_not_found");
  if (c.actor !== user) raise("42501", "erp_list_preferences_access_denied");
  return { ...parsed(String(c.result)), preference: dto(db, user!, String(c.list_id)), replayed: true };
}

/** public.erp_list_preferences_save */
export function erpListPreferencesSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const list = text(a, "p_list_id");
  const expected = int(a, "p_expected_version");
  const columns = json(a, "p_columns");
  const filters = json(a, "p_filters");
  const db = ctx.db;
  member(db, user);
  if (command === null || !listValid(list) || expected === null || expected < 0 || expected > 2147483646 || !listPreferenceValid(columns, filters))
    invalid();
  const hash = createHash("sha256")
    .update(
      jsonbText({ profile: "erp-list-preferences-v1", actor: user, list, version: expected, columns: columns ?? null, filters: filters ?? null }),
      "utf8",
    )
    .digest("hex");
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_list_preferences__command" WHERE id=?', command);
  if (stored) {
    member(db, user);
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_list_preferences_command_conflict");
    return { ...parsed(String(stored.result)), preference: dto(db, user!, list!), replayed: true };
  }
  member(db, user);
  const current = row(db, user!, list!);
  if ((current?.version ?? 0) !== expected) raise("40001", "erp_list_preferences_version_conflict");
  const nextColumns = isNull(columns) ? null : (columns as string[]).map(String);
  const nextFilters = isNull(filters) ? null : filters;
  const before = { columns: current?.columns ?? null, filters: current?.filters ?? null };
  const after = { columns: nextColumns, filters: nextFilters };
  if (jsonbText(before) === jsonbText(after)) raise("22023", "erp_list_preferences_unchanged");
  if (!current && Number(one(db, 'SELECT count(*) n FROM "erp_list_preferences__preference" WHERE user_id=?', user)!.n) >= 200)
    raise("22023", "erp_list_preferences_limit");
  const version = expected! + 1;
  const at = ctx.clock.next();
  const result = {
    scope: "list_preferences_command",
    data_mode: "erp_native",
    receipt: { command_id: command, list_id: list, from_version: expected, to_version: version, changed_at: jsonTimestamp(at) },
  };
  db.exec(
    'INSERT INTO "erp_list_preferences__command"(id, actor, list_id, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    list,
    hash,
    jsonbText(result),
    at.toString(),
  );
  const columnsText = nextColumns === null ? null : JSON.stringify(nextColumns);
  const filtersText = nextFilters === null ? null : jsonbText(nextFilters);
  if (!current)
    db.exec(
      `INSERT INTO "erp_list_preferences__preference"(user_id, list_id, columns, filters, version, updated_at, command_id)
       VALUES (?,?,?,?,1,?,?)`,
      user,
      list,
      columnsText,
      filtersText,
      at.toString(),
      command,
    );
  else
    db.exec(
      `UPDATE "erp_list_preferences__preference" SET columns=?, filters=?, version=?, updated_at=?, command_id=?
       WHERE user_id=? AND list_id=?`,
      columnsText,
      filtersText,
      version,
      at.toString(),
      command,
      user,
      list,
    );
  db.exec(
    `INSERT INTO "erp_list_preferences__audit"(command_id, actor, list_id, from_version, to_version, before_data, after_data, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    command,
    user,
    list,
    expected,
    version,
    jsonbText(before),
    jsonbText(after),
    ctx.clock.next().toString(),
  );
  return { ...result, preference: dto(db, user!, list!), replayed: false };
}

registerRpc("erp_list_preferences_get", erpListPreferencesGet);
registerRpc("erp_list_preferences_command", erpListPreferencesCommand);
registerRpc("erp_list_preferences_save", erpListPreferencesSave);
