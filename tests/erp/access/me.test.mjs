// Acesso: erp_access_me, erp_access_permissions_me e as regras de horário e
// de permissões finas, nos dois motores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as access from "../../../src/erp/domains/access/internal.ts";

const f = await dualFixture();
test.after(() => f.close());
const { users } = f;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    return { error: e.code };
  }
};
const both = (label, sql, args, ts) =>
  f.dual(label, async () => (await f.db.query(sql, args)).rows[0]?.v ?? null, () => inTransaction(f.driver, (ctx) => ts(ctx.db), f.clock));

/** Instantes fixos (µs) cobrindo dias da semana e horas, em UTC. */
const instants = [
  Date.UTC(2026, 10, 16, 11, 0), Date.UTC(2026, 10, 16, 20, 59), Date.UTC(2026, 10, 16, 21, 0), Date.UTC(2026, 10, 15, 2, 30),
  Date.UTC(2026, 10, 21, 14, 0), Date.UTC(2018, 10, 4, 3, 30), Date.UTC(2026, 0, 1, 2, 59),
].map((ms) => BigInt(ms) * 1000n);
const W = [
  [{ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }],
  [{ start: "00:00", end: "23:59", days: [0, 6] }, { start: "17:00", end: "18:00", days: [1] }],
  [{ start: "23:00", end: "23:59", days: [3] }],
  [],
];
const at = (us) => `to_timestamp(${Number(us) / 1e6})`;

test("janelas: aberta, fim da janela, validação", async () => {
  for (const w of W)
    for (const us of instants) {
      await both("window_open", `select erp_access.window_open($1::jsonb, ${at(us)}) v`, [JSON.stringify(w)], () => access.windowOpen(w, us));
      await both(
        "window_until",
        `select (extract(epoch from erp_access.window_until($1::jsonb, ${at(us)}))*1000000)::bigint::text v`,
        [JSON.stringify(w)],
        () => access.windowUntil(w, us)?.toString() ?? null,
      );
    }
  const cases = [
    ...W, "x", [{ start: "8:00", end: "18:00", days: [1] }], [{ start: "18:00", end: "08:00", days: [1] }], [{ start: "08:00", end: "18:00", days: [] }],
    [{ start: "08:00", end: "18:00", days: [2, 1] }], [{ start: "08:00", end: "18:00", days: [7] }], [{ start: "08:00", end: "18:00", days: [1], x: 1 }],
    Array.from({ length: 11 }, () => W[0][0]), [{ start: "08:00", end: "18:00", days: ["1"] }],
  ];
  for (const c of cases) await both("windows_valid", "select erp_access.windows_valid($1::jsonb) v", [JSON.stringify(c)], () => access.windowsValid(c));
  for (const p of [null, [], ["suprimentos.controle_estoque"], ["suprimentos.controle_estoque.insercao"], ["suprimentos.controle_estoque", "suprimentos.controle_estoque.insercao"], ["x"], ["vendas.pedidos_venda", "vendas.pedidos_venda"], [null]])
    await both("permissions_valid", "select erp_access.permissions_valid($1::text[]) v", [p], () => access.permissionsValid(p));
});

test("me e permissions_me com horário, permissões finas e vendedor", async () => {
  const control = async (user, enabled, windows, permissions) => {
    await f.db.query(
      `insert into erp_access.user_control(user_id, user_type, schedule_enabled, windows, permissions, version, updated_by, updated_at) values($1,'normal',$2,$3,$4,1,$5,now())
       on conflict(user_id) do update set schedule_enabled=excluded.schedule_enabled, windows=excluded.windows, permissions=excluded.permissions, version=erp_access.user_control.version+1`,
      [user, enabled, JSON.stringify(windows), permissions, users.admin],
    );
    await f.sync();
  };
  const all = async () => {
    for (const user of Object.values(users)) {
      await outcome(f.rpc("erp_access_me", { p_user_id: user }));
      await outcome(f.rpc("erp_access_permissions_me", { p_user_id: user }));
      await both("schedule_allows", "select erp_access.schedule_allows($1) v", [user], (db) => access.scheduleAllows(db, user, f.clock.next()));
      await both("mfa_in_scope", "select erp_access.mfa_in_scope($1) v", [user], (db) => access.mfaInScope(db, user));
    }
  };
  await all();
  const always = [{ start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }];
  await control(users.vendas, true, always, ["vendas.pedidos_venda", "vendas.propostas", "financas.boletos"]);
  await control(users.estoque, true, [{ start: "00:00", end: "00:01", days: [0] }], null);
  await control(users.consulta, false, [], ["cadastros.produtos"]);
  await all();
});
