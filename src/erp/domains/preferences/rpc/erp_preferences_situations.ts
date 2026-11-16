// Situações personalizadas e transições (migração 148): public.erp_preferences_situations,
// _situation_save, _transition_save e _transitions_delete.
// A sequência erp_preferences.transition_version (a única do Fagoo) não existe
// no motor: o próximo valor é o maior já emitido mais um, lido da trilha
// (framework_audit, imutável; cada transition_save grava a versão emitida em
// after_data). Os dois só divergiriam se o Postgres consumisse um valor numa
// transação desfeita depois do nextval, o que o corpo não faz. Declarado em
// src/erp/schema/structural.ts, diferença "sequencias".
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { accessRequireAdmin, readAdmin } from "../../access/public.ts";
import { int, json, text, uuid } from "../args.ts";
import { situationBases } from "../center.ts";
import {
  frameworkHash,
  frameworkKeys,
  frameworkReplay,
  frameworkText,
  frameworkVersion,
  SITUATION_KINDS,
  situationOf,
  situationsPage,
  transitionAllowed,
} from "../framework.ts";
import { compareText } from "../order.ts";

const kindOk = (kind: string | null) => kind !== null && SITUATION_KINDS.includes(kind);

export function erpPreferencesSituations(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const kind = text(a, "p_kind");
  readAdmin(ctx.db, user);
  if (!kindOk(kind)) raise("22023", "erp_preferences_situation_kind_invalid");
  return situationsPage(ctx.db, kind!);
}

const situationDto = (s: Record<string, unknown>) => ({
  key: s.id,
  base_status: s.base_status,
  name: s.name,
  color: s.color,
  active: Number(s.active) === 1,
  version: Number(s.version),
});

export function erpPreferencesSituationSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const kind = text(a, "p_kind");
  const situation = uuid(a, "p_situation");
  const expected = int(a, "p_expected_version");
  const data = json(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  const invalid = (): never => raise("22023", "erp_preferences_situation_input_invalid");
  if (
    command === null ||
    !kindOk(kind) ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    (situation === null) !== (expected === 0) ||
    !frameworkKeys(data, ["active", "base_status", "color", "name"]) ||
    jsonType(data!.active) !== "boolean" ||
    jsonType(data!.base_status) !== "string" ||
    jsonType(data!.color) !== "string"
  )
    invalid();
  const name = frameworkText(data!.name, 40);
  const color = data!.color as string;
  const base = data!.base_status as string;
  const active = data!.active as boolean;
  if (!/^#[0-9a-f]{6}$/.test(color) || !situationBases(kind!).some((b) => b.status === base) || (situation === null && !active)) invalid();
  const hash = frameworkHash({ op: "situation_save", actor: user, kind, id: situation, version: expected, data });
  const replay = frameworkReplay(db, command!, user!, "situations", hash);
  if (replay) return replay;
  if (
    db
      .exec('SELECT id, name FROM "erp_preferences__situation" WHERE kind=?', kind)
      .rows.some((s) => pgLower(String(s.name)) === pgLower(name) && s.id !== situation) ||
    situationBases(kind!).some((b) => pgLower(b.label) === pgLower(name))
  )
    raise("23505", "erp_preferences_situation_name_taken");
  const at = ctx.clock.next();
  let id: string;
  let before: unknown = null;
  if (situation === null) {
    if (Number(one(db, 'SELECT count(*) n FROM "erp_preferences__situation" WHERE kind=?', kind)!.n) >= 30) raise("22023", "erp_preferences_situation_limit");
    id = crypto.randomUUID();
  } else {
    const row = one(db, 'SELECT * FROM "erp_preferences__situation" WHERE id=? AND kind=?', situation, kind);
    if (!row) raise("P0002", "erp_preferences_situation_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_preferences_situation_version_conflict");
    if (row.base_status !== base) raise("22023", "erp_preferences_situation_base_fixed");
    if (row.name === name && row.color === color && (Number(row.active) === 1) === active) raise("22023", "erp_preferences_situation_unchanged");
    id = situation;
    before = situationDto(row);
  }
  const result = {
    scope: "situations_command",
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      action: situation === null ? "situation_create" : "situation_update",
      kind,
      target: id,
      count: 1,
      changed_at: jsonTimestamp(at.toString()),
    },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    "situations",
    hash,
    jsonbText(result),
    at.toString(),
  );
  if (situation === null)
    db.exec(
      `INSERT INTO "erp_preferences__situation"(id, kind, base_status, name, color, active, version, created_at, created_by, updated_at, updated_by, command_id, name__fold)
       VALUES (?,?,?,?,?,1,1,?,?,?,?,?,?)`,
      id,
      kind,
      base,
      name,
      color,
      at.toString(),
      user,
      at.toString(),
      user,
      command,
      pgLower(name),
    );
  else
    db.exec(
      'UPDATE "erp_preferences__situation" SET name=?, color=?, active=?, version=version+1, updated_at=?, updated_by=?, command_id=?, name__fold=? WHERE id=?',
      name,
      color,
      active ? 1 : 0,
      at.toString(),
      user,
      command,
      pgLower(name),
      id,
    );
  const after = one(db, 'SELECT * FROM "erp_preferences__situation" WHERE id=?', id)!;
  db.exec(
    `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data)
     VALUES (?,?,?,?,?,?,?,?)`,
    at.toString(),
    user,
    command,
    "situations",
    result.receipt.action,
    `${kind}:${id}`,
    before === null ? null : jsonbText(before),
    jsonbText(situationDto(after)),
  );
  return { ...result, replayed: false };
}

const ACTIONS = ["post_finance", "post_stock", "reverse_finance", "reverse_stock"];

/** nextval('erp_preferences.transition_version'): ver o cabeçalho. */
function nextTransitionVersion(ctx: RpcContext) {
  const r = one(
    ctx.db,
    `SELECT max(CAST(json_extract(after_data, '$.version') AS INTEGER)) v FROM "erp_preferences__framework_audit"
     WHERE area='situations' AND action='transition_save'`,
  );
  return r && r.v !== null ? Number(r.v) + 1 : 1;
}

export function erpPreferencesTransitionSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const kind = text(a, "p_kind");
  const from = text(a, "p_from");
  const to = text(a, "p_to");
  const expected = int(a, "p_expected_version");
  const data = json(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  const invalid = (): never => raise("22023", "erp_preferences_transition_input_invalid");
  if (
    command === null ||
    !kindOk(kind) ||
    from === null ||
    to === null ||
    from === to ||
    expected === null ||
    expected < 0 ||
    expected > 2147483647 ||
    !frameworkKeys(data, ["actions", "active"]) ||
    jsonType(data!.active) !== "boolean" ||
    jsonType(data!.actions) !== "array" ||
    (data!.actions as unknown[]).length > 2 ||
    (data!.actions as unknown[]).some((x) => jsonType(x) !== "string" || !ACTIONS.includes(x as string))
  )
    invalid();
  const given = data!.actions as string[];
  const actions = [...new Set(given)].sort(compareText);
  const active = data!.active as boolean;
  if (
    actions.length !== given.length ||
    (actions.includes("post_stock") && actions.includes("reverse_stock")) ||
    (actions.includes("post_finance") && actions.includes("reverse_finance"))
  )
    invalid();
  const hash = frameworkHash({ op: "transition_save", actor: user, kind, from, to, version: expected, data });
  const replay = frameworkReplay(db, command!, user!, "situations", hash);
  if (replay) return replay;
  if (actions.length > 0 && !one(db, 'SELECT 1 x FROM "erp_preferences__situation_adoption" WHERE kind=?', kind))
    raise("22023", "erp_preferences_transition_actions_unavailable");
  const vFrom = situationOf(db, kind!, from);
  const vTo = situationOf(db, kind!, to);
  if (!vFrom || !vTo) raise("P0002", "erp_preferences_situation_not_found");
  if (!transitionAllowed(kind!, vFrom.base_status, vTo.base_status)) raise("22023", "erp_preferences_transition_not_allowed");
  const isDefault = vFrom.default && vTo.default;
  const row = one(db, 'SELECT * FROM "erp_preferences__transition" WHERE kind=? AND from_key=? AND to_key=?', kind, from, to);
  const rowActions = row ? (JSON.parse(String(row.actions)) as string[]) : [];
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_preferences_transition_version_conflict");
  if ((row || isDefault) && (row ? Number(row.active) === 1 : true) === active && jsonbText(rowActions) === jsonbText(actions))
    raise("22023", "erp_preferences_transition_unchanged");
  if (!row && !isDefault && Number(one(db, 'SELECT count(*) n FROM "erp_preferences__transition" WHERE kind=?', kind)!.n) >= 400)
    raise("22023", "erp_preferences_transition_limit");
  const before = row
    ? { active: Number(row.active) === 1, actions: rowActions, version: Number(row.version) }
    : isDefault
      ? { active: true, actions: [], version: 0 }
      : null;
  const version = nextTransitionVersion(ctx);
  const at = ctx.clock.next();
  const result = {
    scope: "situations_command",
    data_mode: "erp_native",
    receipt: { command_id: command, action: "transition_save", kind, target: `${from}>${to}`, count: 1, changed_at: jsonTimestamp(at.toString()) },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    "situations",
    hash,
    jsonbText(result),
    at.toString(),
  );
  if (row)
    db.exec(
      'UPDATE "erp_preferences__transition" SET active=?, actions=?, version=?, updated_at=?, updated_by=?, command_id=? WHERE kind=? AND from_key=? AND to_key=?',
      active ? 1 : 0,
      JSON.stringify(actions),
      version,
      at.toString(),
      user,
      command,
      kind,
      from,
      to,
    );
  else
    db.exec(
      `INSERT INTO "erp_preferences__transition"(kind, from_key, to_key, active, actions, version, updated_at, updated_by, command_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      kind,
      from,
      to,
      active ? 1 : 0,
      JSON.stringify(actions),
      version,
      at.toString(),
      user,
      command,
    );
  db.exec(
    `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data)
     VALUES (?,?,?,?,?,?,?,?)`,
    at.toString(),
    user,
    command,
    "situations",
    "transition_save",
    `${kind}:${from}>${to}`,
    before === null ? null : jsonbText(before),
    jsonbText({ active, actions, version }),
  );
  return { ...result, replayed: false };
}

export function erpPreferencesTransitionsDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const kind = text(a, "p_kind");
  const items = json(a, "p_items") as Record<string, unknown>[] | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  // NULL em p_items: como no Postgres, nenhuma das condições é verdadeira e o comando passa com count nulo.
  if (
    command === null ||
    !kindOk(kind) ||
    (items !== null &&
      (jsonType(items) !== "array" ||
        items.length < 1 ||
        items.length > 100 ||
        items.some(
          (x) =>
            !frameworkKeys(x, ["expected_version", "from", "to"]) || jsonType(x.from) !== "string" || jsonType(x.to) !== "string" || frameworkVersion(x.expected_version) === null,
        ) ||
        new Set(items.map((x) => `${x.from}\u0000${x.to}`)).size !== items.length))
  )
    raise("22023", "erp_preferences_transition_input_invalid");
  const hash = frameworkHash({ op: "transitions_delete", actor: user, kind, items });
  const replay = frameworkReplay(db, command!, user!, "situations", hash);
  if (replay) return replay;
  const at = ctx.clock.next();
  const result = {
    scope: "situations_command",
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      action: "transitions_delete",
      kind,
      target: null,
      count: items === null ? null : items.length,
      changed_at: jsonTimestamp(at.toString()),
    },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    "situations",
    hash,
    jsonbText(result),
    at.toString(),
  );
  const ordered = [...(items ?? [])].sort(
    (x, y) => compareText(x.from as string, y.from as string) || compareText(x.to as string, y.to as string),
  );
  for (const i of ordered) {
    const vFrom = situationOf(db, kind!, i.from as string);
    const vTo = situationOf(db, kind!, i.to as string);
    if (vFrom && vTo && vFrom.default && vTo.default) raise("22023", "erp_preferences_transition_default");
    const row = one(db, 'SELECT * FROM "erp_preferences__transition" WHERE kind=? AND from_key=? AND to_key=?', kind, i.from, i.to);
    if (!row) raise("P0002", "erp_preferences_transition_not_found");
    if (Number(row.version) !== frameworkVersion(i.expected_version)) raise("40001", "erp_preferences_transition_version_conflict");
    db.exec('DELETE FROM "erp_preferences__transition" WHERE kind=? AND from_key=? AND to_key=?', kind, row.from_key, row.to_key);
    db.exec(
      `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data)
       VALUES (?,?,?,?,?,?,?,NULL)`,
      at.toString(),
      user,
      command,
      "situations",
      "transition_delete",
      `${kind}:${row.from_key}>${row.to_key}`,
      jsonbText({ active: Number(row.active) === 1, actions: JSON.parse(String(row.actions)), version: Number(row.version) }),
    );
  }
  return { ...result, replayed: false };
}

registerRpc("erp_preferences_situations", erpPreferencesSituations);
registerRpc("erp_preferences_situation_save", erpPreferencesSituationSave);
registerRpc("erp_preferences_transition_save", erpPreferencesTransitionSave);
registerRpc("erp_preferences_transitions_delete", erpPreferencesTransitionsDelete);
