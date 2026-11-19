// Acesso: portão por chamada, política de MFA do ERP, permissões finas e
// horário por pessoa, perfil próprio e uso do armazenamento.
// public.erp_access_gate_v2, erp_access_security_policy_get/save,
// erp_access_user_controls_get/save, erp_access_profile_me, erp_access_storage.
// Identidade (auth.*) pela porta do envelope: access/identity.ts.
import { createHash } from "node:crypto";
import { systemScope } from "../../../engine/module-origin.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerGate, registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLower, pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import * as preferences from "../../preferences/public.ts";
import { accessRequireAdmin, gateRequired, memberRole, mfaPolicyOn, readAdmin } from "../public.ts";
import { hasVerifiedFactor, personEmail, personExists, sessionAal2 } from "../identity.ts";
import { mfaInScope, mfaRequired, orderedPermissions, permissionsValid, scheduleAllows, scheduleUntil, windowsValid } from "../internal.ts";

const s = (v: unknown) => (v === undefined ? null : (v as string | null));
const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const sha = (v: unknown) => createHash("sha256").update(jsonbText(v), "utf8").digest("hex");
const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));
const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as number));
const MAX = 2147483647;

registerRpc("erp_access_gate_v2", (ctx: RpcContext, a: RpcArgs) => {
  const user = s(a.p_user_id);
  if (!user || !one(ctx.db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', user)) raise("42501", "erp_access_denied");
  const required = mfaRequired(ctx.db, user);
  const now = ctx.clock.next();
  const until = scheduleUntil(ctx.db, user, now);
  return {
    scope: "access_gate",
    data_mode: "erp_native",
    user_id: user,
    open: scheduleAllows(ctx.db, user, now),
    until: until === null ? null : jsonTimestamp(until),
    mfa_required: required,
    mfa_ok: !required || sessionAal2(ctx, user, s(a.p_session_id)),
  };
});

/**
 * Portão por requisição da erp-api (accessGate do Fagoo) dentro do objeto,
 * antes do RPC: só para quem o Fagoo marcaria (gate_required: horário ou
 * política de MFA) e é membro ativo; o resto o próprio RPC decide.
 */
registerGate((ctx) => {
  if (systemScope(ctx)) return null;
  const user = ctx.identity.actor?.user_id ?? null;
  if (!user || !one(ctx.db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', user)) return null;
  // erp_access.agent_allowed: agente (aplicação) com papel admin/financeiro ou
  // permissão fina sensível (mfa_in_scope) é recusado a cada chamada, com a
  // política de MFA ligada ou não. No Fagoo a recusa vem na resolução do
  // token do agente; aqui, no portão. Identidade de sistema não passa pelo
  // portão (chama o objeto sem GATE_HEADER).
  if (ctx.identity.actor?.is_agent && mfaInScope(ctx.db, user)) return "agent_out_of_scope";
  if (!gateRequired(ctx.db, user)) return null;
  const now = ctx.clock.next();
  if (!scheduleAllows(ctx.db, user, now)) return "outside_schedule";
  if (mfaRequired(ctx.db, user) && !sessionAal2(ctx, user, ctx.identity.actor?.session_id ?? null)) return "mfa_required";
  return null;
});

/** erp_access.security_policy_dto */
function policyDto(ctx: RpcContext) {
  const db = ctx.db;
  const row = one(db, 'SELECT version, updated_at FROM "erp_access__security_policy" WHERE singleton=1');
  const members = db
    .exec('SELECT m.user_id, m.role, p.name FROM "erp_access__membership" m LEFT JOIN "erp_access__profile" p ON p.user_id=m.user_id WHERE m.active=1')
    .rows.filter((m) => personExists(ctx, String(m.user_id)) && mfaInScope(db, String(m.user_id)))
    .map((m) => {
      const id = String(m.user_id);
      const name = (m.name as string | null) ?? personEmail(ctx, id);
      return { user_id: id, name, role: m.role, factor: hasVerifiedFactor(ctx, id), key: name === null ? null : pgLower(name) };
    })
    .sort((x, y) => (x.key === y.key ? (x.user_id < y.user_id ? -1 : 1) : x.key === null ? 1 : y.key === null ? -1 : x.key < y.key ? -1 : 1))
    .map(({ key: _key, ...m }) => m);
  return { mfa_required: mfaPolicyOn(db), version: (row?.version as number) ?? 0, updated_at: ts(row?.updated_at), members };
}

/** erp_access.security_gates */
const securityGates = (ctx: RpcContext) =>
  ctx.db
    .exec('SELECT user_id FROM "erp_access__membership" ORDER BY user_id')
    .rows.map((m) => ({ user_id: m.user_id, gate_required: gateRequired(ctx.db, String(m.user_id)) }));

registerRpc("erp_access_security_policy_get", (ctx: RpcContext, a: RpcArgs) => {
  const user = s(a.p_user_id);
  readAdmin(ctx.db, user);
  return {
    scope: "access_security_policy",
    data_mode: "erp_native",
    policy: policyDto(ctx),
    self: { factor: hasVerifiedFactor(ctx, user), aal2: sessionAal2(ctx, user, s(a.p_session_id)) },
  };
});

registerRpc("erp_access_security_policy_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id);
  const cmd = s(a.p_command_id);
  const version = n(a.p_expected_version);
  const required = a.p_mfa_required === undefined ? null : (a.p_mfa_required as boolean | null);
  readAdmin(db, user);
  if (cmd === null || version === null || version < 0 || required === null) raise("22023", "erp_access_security_input_invalid");
  const hash = sha({ kind: "policy", expected_version: version, mfa_required: required });
  const stored = one(db, 'SELECT actor, kind, request_hash, result FROM "erp_access__security_command" WHERE id=?', cmd);
  if (stored) {
    if (stored.actor !== user || stored.kind !== "policy" || stored.request_hash !== hash) raise("40001", "erp_access_security_command_conflict");
    return { ...parse(stored.result), replayed: true, gates: securityGates(ctx) };
  }
  if (!sessionAal2(ctx, user, s(a.p_session_id))) raise("28000", "erp_access_mfa_required");
  const row = one(db, 'SELECT mfa_required, version FROM "erp_access__security_policy" WHERE singleton=1');
  if (((row?.version as number) ?? 0) !== version) raise("40001", "erp_access_security_version_conflict");
  if (!!row?.mfa_required === required) raise("22023", "erp_access_security_unchanged");
  const at = ctx.clock.next();
  if (!row)
    db.exec('INSERT INTO "erp_access__security_policy"(singleton, mfa_required, version, updated_at, updated_by) VALUES(1,?,1,?,?)', required ? 1 : 0, at.toString(), user);
  else db.exec('UPDATE "erp_access__security_policy" SET mfa_required=?, version=version+1, updated_at=?, updated_by=? WHERE singleton=1', required ? 1 : 0, at.toString(), user);
  const result = {
    scope: "access_security_command",
    data_mode: "erp_native",
    receipt: { command_id: cmd, from_version: version, to_version: version + 1, changed_at: jsonTimestamp(at) },
    policy: policyDto(ctx),
  };
  db.exec(
    'INSERT INTO "erp_access__security_command"(id, actor, kind, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    cmd, user, "policy", hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_access__security_event"(command_id, actor, action, detail, created_at) VALUES(?,?,?,?,?)',
    cmd, user, required ? "mfa_policy_on" : "mfa_policy_off", JSON.stringify({ from_version: version, to_version: version + 1 }), ctx.clock.next().toString(),
  );
  return { ...result, replayed: false, gates: securityGates(ctx) };
});

/** erp_access.controls_dto(p_target) */
function controlsDto(ctx: RpcContext, target: string) {
  const db = ctx.db;
  const c = one(db, 'SELECT user_type, schedule_enabled, windows, permissions, version, updated_at FROM "erp_access__user_control" WHERE user_id=?', target);
  const m = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=?', target);
  const role = (m?.role as string | null) ?? null;
  const seller = one(
    db,
    'SELECT r.name, s.access_hours_enabled, s.access_windows FROM "erp_catalog__seller" s LEFT JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.user_id=? LIMIT 1',
    target,
  );
  return {
    scope: "access_user_controls",
    data_mode: "erp_native",
    target,
    role,
    version: (c?.version as number) ?? 0,
    user_type: (c?.user_type as string) ?? "normal",
    schedule: { enabled: !!c?.schedule_enabled && role !== "admin", windows: parse(c?.windows) ?? [] },
    permissions: orderedPermissions(role, parse(c?.permissions)),
    seller: seller
      ? { name: pgLeft((seller.name as string | null) ?? "Vendedor", 200), enabled: !!seller.access_hours_enabled, windows: parse(seller.access_windows) }
      : null,
    updated_at: ts(c?.updated_at),
    gate_required: gateRequired(db, target),
  };
}

registerRpc("erp_access_user_controls_get", (ctx: RpcContext, a: RpcArgs) => {
  readAdmin(ctx.db, s(a.p_user_id));
  const target = s(a.p_target);
  if (target === null || !personExists(ctx, target)) raise("P0002", "erp_access_user_not_found");
  return controlsDto(ctx, target);
});

registerRpc("erp_access_user_controls_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id);
  const cmd = s(a.p_command_id);
  const target = s(a.p_target);
  const version = n(a.p_expected_version);
  const data = a.p_data === undefined ? null : (a.p_data as any);
  readAdmin(db, user);
  const keys = (o: object) => jsonbKeys(o).sort().join(",");
  if (
    cmd === null || target === null || version === null || version < 0 || data === null || jsonType(data) !== "object" ||
    keys(data) !== "permissions,schedule,user_type" ||
    jsonType(data.user_type) !== "string" || !["normal", "contador"].includes(data.user_type) ||
    jsonType(data.schedule) !== "object" || keys(data.schedule) !== "enabled,windows" ||
    jsonType(data.schedule.enabled) !== "boolean" || !windowsValid(data.schedule.windows) ||
    !["null", "array"].includes(jsonType(data.permissions) as string) ||
    (jsonType(data.permissions) === "array" && data.permissions.some((k: unknown) => jsonType(k) !== "string"))
  )
    raise("22023", "erp_access_controls_input_invalid");
  const type = data.user_type as string;
  const enabled = data.schedule.enabled as boolean;
  const windows = data.schedule.windows as unknown[];
  const permissions = jsonType(data.permissions) === "array" ? (data.permissions as string[]) : null;
  if ((enabled && windows.length === 0) || !permissionsValid(permissions)) raise("22023", "erp_access_controls_input_invalid");
  const hash = sha({ profile: "erp-access-controls-v1", actor: user, target, version, data });
  const c = one(db, 'SELECT actor, kind, target, request_hash, result FROM "erp_access__user_command" WHERE id=?', cmd);
  if (c) {
    accessRequireAdmin(db, user, true);
    if (c.actor !== user || c.kind !== "controls" || c.request_hash !== hash) raise("40001", "erp_access_users_command_conflict");
    return { ...parse(c.result), controls: controlsDto(ctx, String(c.target)), replayed: true };
  }
  accessRequireAdmin(db, user, true);
  if (!personExists(ctx, target)) raise("P0002", "erp_access_user_not_found");
  const m = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=?', target);
  // O administrador tem todas as permissões e nunca é barrado pelo horário.
  if (m?.role === "admin" && (enabled || permissions !== null)) raise("22023", "erp_access_controls_admin");
  const v = one(db, 'SELECT user_type, schedule_enabled, windows, permissions, version FROM "erp_access__user_control" WHERE user_id=?', target);
  if (((v?.version as number) ?? 0) !== version) raise("40001", "erp_access_users_version_conflict");
  const before = {
    user_type: (v?.user_type as string) ?? "normal",
    schedule: { enabled: !!v?.schedule_enabled, windows: parse(v?.windows) ?? [] },
    permissions: parse(v?.permissions),
  };
  const after = { user_type: type, schedule: { enabled, windows }, permissions };
  if (jsonbText(before) === jsonbText(after)) raise("22023", "erp_access_users_unchanged");
  if (v?.version === MAX) raise("40001", "erp_access_users_version_conflict");
  const at = ctx.clock.next();
  if (!v)
    db.exec(
      'INSERT INTO "erp_access__user_control"(user_id, user_type, schedule_enabled, windows, permissions, version, updated_at, updated_by) VALUES(?,?,?,?,?,1,?,?)',
      target, type, enabled ? 1 : 0, JSON.stringify(windows), permissions === null ? null : JSON.stringify(permissions), at.toString(), user,
    );
  else
    db.exec(
      'UPDATE "erp_access__user_control" SET user_type=?, schedule_enabled=?, windows=?, permissions=?, version=version+1, updated_at=?, updated_by=? WHERE user_id=?',
      type, enabled ? 1 : 0, JSON.stringify(windows), permissions === null ? null : JSON.stringify(permissions), at.toString(), user, target,
    );
  const result = { scope: "access_controls_command", data_mode: "erp_native", receipt: { command_id: cmd, target, changed_at: jsonTimestamp(at) } };
  db.exec(
    'INSERT INTO "erp_access__user_command"(id, actor, kind, target, request_hash, state, result, created_at, completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
    cmd, user, "controls", target, hash, "done", JSON.stringify(result), ctx.clock.next().toString(), at.toString(),
  );
  db.exec(
    'INSERT INTO "erp_access__user_audit"(command_id, actor, target, before_data, after_data, created_at) VALUES(?,?,?,?,?,?)',
    cmd, user, target, JSON.stringify(before), JSON.stringify(after), ctx.clock.next().toString(),
  );
  accessRequireAdmin(db, user, true);
  return { ...result, controls: controlsDto(ctx, target), replayed: false };
});

registerRpc("erp_access_profile_me", (ctx: RpcContext, a: RpcArgs) => {
  const user = s(a.p_user_id);
  const role = memberRole(ctx.db, user);
  const raw = personEmail(ctx, user!);
  const email = raw === null ? null : pgLower(raw);
  const p = one(ctx.db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', user);
  const i = one(ctx.db, 'SELECT data FROM "erp_company__identity" WHERE singleton=1');
  const data = parse(i?.data);
  const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v));
  return {
    scope: "access_profile",
    data_mode: "erp_native",
    user_id: user,
    role,
    name: (p?.name as string | null) ?? null,
    email: email !== null && /^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(email) && [...email].length <= 254 ? email : null,
    company: i ? { legal_name: text(data?.legal_name) === null ? null : pgLeft(text(data.legal_name)!, 200), trade_name: text(data?.trade_name) === null ? null : pgLeft(text(data.trade_name)!, 200) } : null,
  };
});

/** erp_access.storage_group(bucket) */
const storageGroup = (bucket: string) =>
  ({
    "erp-attachments": "anexos", "origin-fiscal-xml": "fiscal", "brufap-fiscal-artifacts": "fiscal", "brufap-received-dfe": "fiscal",
    "brufap-cnab": "cobranca", "origin-backups": "backup", "brufap-a1-vault": "certificado",
  })[bucket] ?? "outros";
const GROUPS = ["anexos", "fiscal", "cobranca", "backup", "certificado", "outros"];

registerRpc(
  "erp_access_storage",
  (ctx: RpcContext, a: RpcArgs) => {
    const role = memberRole(ctx.db, s(a.p_user_id));
    const objects = ctx.listing().map((o) => ({ group: storageGroup(o.bucket), bytes: Number.isSafeInteger(o.size) && o.size >= 0 && o.size < 1e15 ? BigInt(o.size) : 0n }));
    const total = objects.reduce((t, o) => t + o.bytes, 0n);
    const groups = GROUPS.map((g) => {
      const list = objects.filter((o) => o.group === g);
      return { group: g, bytes: list.reduce((t, o) => t + o.bytes, 0n).toString(), objects: list.length };
    });
    const limit = preferences.get(ctx.db, "armazenamento.limite_gb");
    return {
      scope: "storage_usage",
      data_mode: "erp_native",
      total_bytes: total.toString(),
      objects: objects.length,
      limit_bytes: jsonType(limit) === "number" && /^[1-9][0-9]{0,5}$/.test(jsonbText(limit)) ? (BigInt(jsonbText(limit)) * 1073741824n).toString() : null,
      groups: role === "admin" ? groups : null,
      as_of: jsonTimestamp(ctx.clock.next()),
    };
  },
  { listing: true },
);
