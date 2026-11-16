// Centro de preferências: public.erp_preferences_page, _save e _command.
// Os gatilhos guard_company_value, guard_user_value e immutable_history são
// cumpridos aqui: os valores e a trilha só mudam pelo comando.
import { createHash } from "node:crypto";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { json, text, uuid } from "../args.ts";
import { definition, pageDefinitions, pageDto, pageRow, readerRole, storedValue, valueValid, writeAccess } from "../center.ts";
import { compareText } from "../order.ts";

const invalid = (): never => raise("22023", "erp_preferences_input_invalid");
const parsed = (v: unknown) => JSON.parse(String(v)) as Record<string, unknown>;

export function erpPreferencesPage(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const id = text(a, "p_page");
  const role = readerRole(ctx.db, user);
  if (id === null) invalid();
  const page = pageRow(ctx.db, id);
  if (!page) raise("P0002", "erp_preferences_page_not_found");
  if (!page.read_roles.includes(role)) raise("42501", "erp_preferences_access_denied");
  return pageDto(ctx, page, role, user!);
}

export function erpPreferencesCommand(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const db = ctx.db;
  const role = readerRole(db, user);
  if (command === null) invalid();
  const c = one(db, 'SELECT actor, page_id, result FROM "erp_preferences__command" WHERE id=?', command);
  if (!c) raise("P0002", "erp_preferences_command_not_found");
  if (c.actor !== user) raise("42501", "erp_preferences_access_denied");
  const page = pageRow(db, String(c.page_id))!;
  if (!page.read_roles.includes(role)) raise("42501", "erp_preferences_access_denied");
  return { ...parsed(c.result), page: pageDto(ctx, page, role, user!), replayed: true };
}

interface Change {
  key: string;
  expected_version: number;
  value: unknown;
}

export function erpPreferencesSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const id = text(a, "p_page");
  const changes = json(a, "p_changes") as Record<string, unknown>[] | null;
  const db = ctx.db;
  const role = readerRole(db, user);
  if (command === null || id === null || changes === null || jsonType(changes) !== "array" || changes.length === 0) invalid();
  const page = pageRow(db, id);
  if (!page) raise("P0002", "erp_preferences_page_not_found");
  if (!page.read_roles.includes(role) || (page.scope === "company" && role !== "admin")) raise("42501", "erp_preferences_access_denied");
  const defs = pageDefinitions(db, page.id);
  const bad = (c: Record<string, unknown>) =>
    jsonType(c) !== "object" ||
    Object.keys(c).length !== 3 ||
    !("key" in c && "expected_version" in c && "value" in c) ||
    jsonType(c.key) !== "string" ||
    jsonType(c.expected_version) !== "number" ||
    !/^(0|[1-9][0-9]{0,9})$/.test(jsonbText(c.expected_version)) ||
    BigInt(jsonbText(c.expected_version)) > 2147483646n ||
    !defs.some((d) => d.key === c.key) ||
    !valueValid(definition(db, c.key as string), c.value);
  if (changes!.length > defs.length || changes!.some(bad) || new Set(changes!.map((c) => c.key)).size !== changes!.length) invalid();
  const owner = page.scope === "user" ? user : null;
  const canonical: Change[] = changes!
    .map((c) => ({ key: c.key as string, expected_version: Number(c.expected_version), value: c.value }))
    .sort((x, y) => compareText(x.key, y.key));
  const hash = createHash("sha256")
    .update(jsonbText({ profile: "erp-preferences-v1", actor: user, page: page.id, changes: canonical }), "utf8")
    .digest("hex");
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_preferences__command" WHERE id=?', command);
  if (stored) {
    const r = writeAccess(db, user, page);
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_preferences_command_conflict");
    return { ...parsed(stored.result), page: pageDto(ctx, page, r, user!), replayed: true };
  }
  writeAccess(db, user, page);
  const receipt: { key: string; from_version: number; to_version: number; before: unknown; after: unknown }[] = [];
  for (const change of canonical) {
    const def = definition(db, change.key)!;
    const v = storedValue(db, page, def.key, user!);
    const current = v ? v.value : def.default_value;
    const version = v ? v.version : 0;
    if (version !== change.expected_version) raise("40001", "erp_preferences_version_conflict");
    if (jsonbText(current) === jsonbText(change.value)) raise("22023", "erp_preferences_unchanged");
    const before = Array.isArray(current) ? (current as unknown[]) : [];
    // Campo "users": quem entra agora precisa ser membro ativo; quem já estava e foi desligado pode ficar.
    if (
      def.kind === "users" &&
      (change.value as string[]).some(
        (u) => !before.includes(u) && !one(db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', u),
      )
    )
      raise("22023", "erp_preferences_user_invalid");
    // 299: a situação personalizada que entra agora precisa ser ativa e do tipo.
    if (
      def.situation_kind !== null &&
      (change.value as string[]).some(
        (x) =>
          !(Array.isArray(def.options) && def.options.includes(x)) &&
          !before.includes(x) &&
          !one(db, 'SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind=? AND active=1', x, def.situation_kind),
      )
    )
      raise("22023", "erp_preferences_situation_invalid");
    receipt.push({ key: def.key, from_version: version, to_version: version + 1, before: current, after: change.value });
  }
  const at = ctx.clock.next();
  const result = {
    scope: "preferences_command",
    data_mode: "erp_native",
    receipt: { command_id: command, page: page.id, changed_at: jsonTimestamp(at.toString()), changes: receipt },
  };
  db.exec(
    'INSERT INTO "erp_preferences__command"(id, actor, page_id, owner, request_hash, result, created_at) VALUES (?,?,?,?,?,?,?)',
    command,
    user,
    page.id,
    owner,
    hash,
    jsonbText(result),
    at.toString(),
  );
  for (const c of receipt) {
    const after = jsonbText(c.after);
    if (page.scope === "company") {
      if (c.from_version === 0)
        db.exec(
          'INSERT INTO "erp_preferences__company_value"(key, value, version, updated_at, updated_by, command_id) VALUES (?,?,1,?,?,?)',
          c.key,
          after,
          at.toString(),
          user,
          command,
        );
      else
        db.exec(
          'UPDATE "erp_preferences__company_value" SET value=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE key=? AND version=?',
          after,
          at.toString(),
          user,
          command,
          c.key,
          c.from_version,
        );
    } else if (c.from_version === 0)
      db.exec(
        'INSERT INTO "erp_preferences__user_value"(key, user_id, value, version, updated_at, command_id) VALUES (?,?,?,1,?,?)',
        c.key,
        user,
        after,
        at.toString(),
        command,
      );
    else
      db.exec(
        'UPDATE "erp_preferences__user_value" SET value=?, version=version+1, updated_at=?, command_id=? WHERE key=? AND user_id=? AND version=?',
        after,
        at.toString(),
        command,
        c.key,
        user,
        c.from_version,
      );
    db.exec(
      `INSERT INTO "erp_preferences__audit"(command_id, actor, key, owner, from_version, to_version, before_value, after_value, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      command,
      user,
      c.key,
      owner,
      c.from_version,
      c.to_version,
      jsonbText(c.before),
      after,
      ctx.clock.next().toString(),
    );
  }
  const r = writeAccess(db, user, page);
  return { ...result, page: pageDto(ctx, page, r, user!), replayed: false };
}

registerRpc("erp_preferences_page", erpPreferencesPage);
registerRpc("erp_preferences_command", erpPreferencesCommand);
registerRpc("erp_preferences_save", erpPreferencesSave);
