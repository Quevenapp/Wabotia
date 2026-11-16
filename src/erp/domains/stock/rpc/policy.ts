// Política de saldo negativo do Estoque: public.erp_stock_policy_get,
// erp_stock_policy_set e erp_stock_policy_command; erp_stock.policy_access,
// policy_dto. Os advisory locks do Postgres não existem no escritor único.
// O gatilho erp_stock.guard_policy (só muda por comando, versão +1, valor
// diferente) é garantido aqui: este é o único escritor da tabela.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { commandTaken, requireAccess, sha256 } from "../internal.ts";

/** erp_stock.policy_access: só administrador ativo. */
function policyAccess(db: SqlDriver, actor: string) {
  if (!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, actor))
    raise("42501", "erp_stock_policy_access_denied");
}

/** erp_stock.policy_dto */
export function policyDto(db: SqlDriver) {
  const p = one(db, 'SELECT allow_negative, version, updated_at FROM "erp_stock__policy" WHERE singleton=1');
  if (!p) return null;
  return {
    allow_negative: p.allow_negative === 1,
    version: Number(p.version),
    updated_at: p.updated_at === null ? null : jsonTimestamp(p.updated_at as number),
  };
}

registerRpc("erp_stock_policy_get", (ctx: RpcContext, a: RpcArgs) => {
  const user = a.p_user_id as string;
  requireAccess(ctx.db, user, false);
  return {
    scope: "stock_policy",
    policy: policyDto(ctx.db),
    can_manage: !!one(ctx.db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user),
    data_mode: "erp_native",
  };
});

/** A resposta gravada no recibo, com a política atual por cima. */
const withPolicy = (db: SqlDriver, result: unknown, replayed: boolean) => ({
  ...(typeof result === "string" ? JSON.parse(result) : (result as object)),
  policy: policyDto(db),
  replayed,
});

registerRpc("erp_stock_policy_set", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = a.p_command_id as string | null;
  const expected = a.p_expected_version as number | null;
  const allow = a.p_allow_negative as boolean | null;
  const reason = a.p_reason as string | null;
  policyAccess(db, user);
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    allow === null ||
    reason === null ||
    pgLength(pgBtrim(reason)) < 3 ||
    pgLength(pgBtrim(reason)) > 500 ||
    pgHasCntrl.test(reason) ||
    a.p_confirmed !== true
  )
    raise("22023", "erp_stock_policy_input_invalid");
  const hash = sha256(
    jsonbText({ profile: "stock-negative-policy-v1", actor: user, expected_version: expected, allow_negative: allow, reason, confirmed: true }),
  );
  const previous = one(db, 'SELECT actor, request_hash, result FROM "erp_stock__policy_command" WHERE id=?', command);
  if (previous) {
    policyAccess(db, user);
    if (previous.actor !== user || previous.request_hash !== hash) raise("40001", "erp_stock_policy_command_conflict");
    return withPolicy(db, previous.result, true);
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_policy_command_conflict");
  const p = one(db, 'SELECT allow_negative, version FROM "erp_stock__policy" WHERE singleton=1');
  if (!p || Number(p.version) !== expected) raise("40001", "erp_stock_policy_version_conflict");
  const from = p.allow_negative === 1;
  if (from === allow) raise("22023", "erp_stock_policy_unchanged");
  const at = ctx.clock.next();
  const version = Number(p.version);
  const result = {
    scope: "stock_policy",
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      from: { allow_negative: from, version },
      to: { allow_negative: allow, version: version + 1 },
      reason: pgBtrim(reason),
      changed_at: jsonTimestamp(at),
    },
  };
  db.exec(
    'INSERT INTO "erp_stock__policy_command"(id, actor, request_hash, from_version, to_version, from_allow, to_allow, reason, result, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    command, user, hash, version, version + 1, from ? 1 : 0, allow ? 1 : 0, pgBtrim(reason), JSON.stringify(result), at.toString(),
  );
  db.exec(
    'UPDATE "erp_stock__policy" SET allow_negative=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE singleton=1',
    allow ? 1 : 0, at.toString(), user, command,
  );
  policyAccess(db, user);
  return withPolicy(db, result, false);
});

registerRpc("erp_stock_policy_command", (ctx: RpcContext, a: RpcArgs) => {
  const user = a.p_user_id as string;
  const command = a.p_command_id as string | null;
  policyAccess(ctx.db, user);
  if (command === null) raise("22023", "erp_stock_policy_input_invalid");
  const c = one(ctx.db, 'SELECT actor, result FROM "erp_stock__policy_command" WHERE id=?', command);
  if (!c) raise("P0002", "erp_stock_policy_command_not_found");
  if (c.actor !== user) raise("42501", "erp_stock_policy_access_denied");
  return withPolicy(ctx.db, c.result, true);
});
