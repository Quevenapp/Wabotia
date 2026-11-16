// Acesso (núcleo transversal): as funções que outros domínios chamam
// (src/erp/domains/access/public.ts), comparadas com as do Fagoo no oráculo.
//   node --test tests/erp/access/public.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as access from "../../../src/erp/domains/access/public.ts";

const f = await dualFixture();
test.after(() => f.close());
const { users } = f;

/** A mesma função nos dois motores: SQL no oráculo, TS no motor. */
const both = (label, sql, args, ts) =>
  f.dual(label, async () => (await f.db.query(sql, args)).rows[0]?.v ?? null, () => inTransaction(f.driver, (ctx) => ts(ctx.db), f.clock));
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    return { error: [e.code, e.message] };
  }
};

test("permission_keys e resources_for_role", async () => {
  assert.equal((await both("permission_keys", "select erp_access.permission_keys() v", [], () => access.permissionKeys())).length, 208);
  for (const role of ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal", "outro", null])
    await both("resources_for_role", "select erp_access.resources_for_role($1) v", [role], () => access.resourcesForRole(role));
});

test("scalar_text e clean", async () => {
  const values = ["abc", "ação", 123, 1.5, -0.25, true, false, null, { a: 1 }, [1, 2], "x".repeat(300)];
  for (const v of values)
    for (const max of [3, 200, 0, null])
      await both("scalar_text", "select erp_access.scalar_text($1::jsonb, $2) v", [JSON.stringify(v), max], () => access.scalarText(v, max));
  await both("scalar_text padrão", "select erp_access.scalar_text($1::jsonb) v", [JSON.stringify("y".repeat(250))], () => access.scalarText("y".repeat(250)));
  for (const text of ["linha\nnova\ttab", "c1\u0085x", "ok", "", null]) {
    await both("clean", "select erp_activity.clean($1, $2) v", [text, 5], () => access.clean(text, 5));
    await both("clean", "select erp_activity.clean($1, $2) v", [text, 100], () => access.clean(text, 100));
  }
});

test("period: dias de São Paulo, limites e horário de verão", async () => {
  const sql =
    "select case when r is null then null else json_build_array((extract(epoch from lower(r))*1000000)::bigint::text, (extract(epoch from upper(r))*1000000)::bigint::text) end v from (select erp_activity.period($1::date,$2::date) r) x";
  const ts = (a, b) => () => {
    const p = access.period(a, b);
    return [p.from.toString(), p.to.toString()];
  };
  const pairs = [
    ["2026-01-01", "2026-01-31"],
    ["2026-11-16", "2026-11-16"],
    ["2018-11-03", "2018-11-05"], // início do horário de verão (fora do intervalo aceito: erro)
    ["2020-01-01", "2020-12-31"],
    ["2020-01-01", "2021-01-01"],
    ["2019-12-31", "2020-01-05"],
    ["2026-02-01", "2026-01-01"],
    ["2100-12-31", "2100-12-31"],
    [null, "2026-01-01"],
  ];
  const results = [];
  for (const [a, b] of pairs) results.push(await outcome(both("period", sql, [a, b], ts(a, b))));
  assert.ok(results.some((r) => r.ok) && results.some((r) => r.error), JSON.stringify(results));
});

test("guardas de papel: admin, histórico, permissão; gate e MFA", async () => {
  for (const user of [...Object.values(users), randomUUID(), null]) {
    await outcome(both("read_admin", "select erp_access.read_admin($1)::text v", [user], (db) => (access.readAdmin(db, user), "")));
    await outcome(both("require_admin", "select erp_access.require_admin($1, true)::text v", [user], (db) => (access.accessRequireAdmin(db, user, true), "")));
    await outcome(both("activity.require_admin", "select erp_activity.require_admin($1)::text v", [user], (db) => (access.activityRequireAdmin(db, user), "")));
    await outcome(both("require_history_role", "select erp_access.require_history_role($1) v", [user], (db) => access.requireHistoryRole(db, user)));
    if (user)
      for (const key of ["suprimentos.controle_estoque", "suprimentos.controle_estoque.insercao", "nao.existe"])
        await outcome(both("require_permission", "select erp_access.require_permission($1, $2)::text v", [user, key], (db) => (access.requirePermission(db, user, key), "")));
  }
  // Controle por usuário com permissões finas e horário; política de MFA.
  await f.db.query(
    `insert into erp_access.user_control(user_id, user_type, schedule_enabled, windows, permissions, version, updated_by, updated_at) values($1,'normal',true,'[{"days":[1],"start":"08:00","end":"18:00"}]','{suprimentos.controle_estoque}',1,$2,now())`,
    [users.estoque, users.admin],
  );
  await f.sync();
  for (const user of [users.estoque, users.vendas])
    await both("gate_required", "select erp_access.gate_required($1) v", [user], (db) => access.gateRequired(db, user));
  for (const key of ["suprimentos.controle_estoque", "suprimentos.controle_estoque.insercao"])
    await outcome(both("require_permission", "select erp_access.require_permission($1, $2)::text v", [users.estoque, key], (db) => (access.requirePermission(db, users.estoque, key), "")));
  await both("mfa_policy_on", "select erp_access.mfa_policy_on() v", [], (db) => access.mfaPolicyOn(db));
});

test("actor_label: nome do perfil; sem auth.users, o rótulo genérico", async () => {
  await f.db.query("insert into erp_access.profile(user_id, name, version, updated_by, updated_at) values($1, 'Ana Sintética', 1, $1, now())", [users.admin]);
  await f.sync();
  await both("actor_label", "select erp_activity.actor_label($1) v", [users.admin], (db) => access.actorLabel(db, users.admin));
  const stranger = randomUUID();
  await both("actor_label", "select erp_activity.actor_label($1) v", [stranger], (db) => access.actorLabel(db, stranger));
});
