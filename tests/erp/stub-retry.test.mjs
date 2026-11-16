// Nova tentativa na chamada Worker → objeto erp: (src/erp/api/retry.ts):
// uma só, com stub novo, só para erro `retryable` e não `overloaded`, só para
// leitura ou comando com p_command_id; o resto é 503 (ErpUnavailable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "./harness/node-driver.mjs";
import "../../src/erp/domains/index.ts";
import { callRpc } from "../../src/erp/engine/registry.ts";
import { Clock } from "../../src/erp/engine/time.ts";
import { ErpUnavailable, rpcHasCommand, withStubRetry } from "../../src/erp/api/retry.ts";

const stubError = (marks) => Object.assign(new Error("Durable Object reset"), marks);
const quiet = { wait: async () => {} };

/** Tentativas que falham com os erros dados e depois respondem. */
function script(...failures) {
  let calls = 0;
  const attempt = async () => {
    const f = failures[calls++];
    if (f) throw stubError(f);
    return Response.json({ ok: true, calls });
  };
  return { attempt, calls: () => calls };
}

test("leitura: erro repetível repete uma vez, com log sem dados", async () => {
  const s = script({ retryable: true });
  const logs = [];
  const r = await withStubRetry(s.attempt, { idempotent: true, route: "/erp-rpc/erp_access_me", ...quiet, log: (l) => logs.push(l) });
  assert.deepEqual(await r.json(), { ok: true, calls: 2 });
  assert.deepEqual(logs.map((l) => JSON.parse(l)), [{ event: "erp_stub_retry", route: "/erp-rpc/erp_access_me", retryable: true, overloaded: false, remote: false }]);
  // Uma só: dois erros seguidos dão 503.
  const twice = script({ retryable: true }, { retryable: true });
  await assert.rejects(withStubRetry(twice.attempt, { idempotent: true, route: "/x", ...quiet, log: () => {} }), ErpUnavailable);
  assert.equal(twice.calls(), 2);
});

test("sobrecarga e erro não repetível: sem nova tentativa, 503", async () => {
  for (const marks of [{ retryable: true, overloaded: true }, { overloaded: true }, {}, { remote: true }]) {
    const s = script(marks);
    const e = await withStubRetry(s.attempt, { idempotent: true, route: "/x", ...quiet, log: () => assert.fail("não devia repetir") }).catch((x) => x);
    assert.ok(e instanceof ErpUnavailable);
    assert.equal(e.status, 503);
    assert.equal(s.calls(), 1, JSON.stringify(marks));
  }
});

test("escrita sem p_command_id: 503, sem nova tentativa", async () => {
  const body = JSON.stringify({ p_user_id: randomUUID(), p_data: {} });
  assert.equal(rpcHasCommand(body), false);
  const s = script({ retryable: true });
  await assert.rejects(withStubRetry(s.attempt, { idempotent: rpcHasCommand(body), route: "/x", ...quiet, log: () => {} }), (e) => e instanceof ErpUnavailable && e.status === 503);
  assert.equal(s.calls(), 1);
});

test("escrita com p_command_id: o erro depois de aplicar repete e o efeito vale uma vez (recibo)", async () => {
  const lite = freshLite();
  const db = nodeDriver(lite);
  const clock = new Clock();
  const admin = randomUUID(),
    seller = randomUUID();
  const person = (user_id, erp_role, name) => ({ user_id, name, email: `${name}@exemplo.invalid`, erp_role, verified_factor: false });
  const people = [person(admin, "admin", "Ana"), person(seller, "vendas", "Bia")];
  const identity = { actor: { ...people[0], session_id: randomUUID(), aal: "aal1", is_agent: false }, people };
  const args = {
    p_user_id: admin,
    p_command_id: randomUUID(),
    p_target: seller,
    p_expected_version: 0,
    p_data: { user_type: "normal", schedule: { enabled: true, windows: [{ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }] }, permissions: ["vendas.pedidos_venda"] },
  };
  const body = JSON.stringify(args);
  assert.equal(rpcHasCommand(body), true);
  // O objeto aplica o comando e a resposta se perde (erro de stub depois de chegar ao objeto).
  let calls = 0;
  const attempt = async () => {
    const value = callRpc(db, "erp_access_user_controls_save", JSON.parse(body), clock, { identity });
    if (++calls === 1) throw stubError({ retryable: true });
    return Response.json(value);
  };
  const r = await withStubRetry(attempt, { idempotent: rpcHasCommand(body), route: "/erp-rpc/erp_access_user_controls_save", ...quiet, log: () => {} });
  assert.equal(calls, 2);
  const value = await r.json();
  // Aplicado uma vez: versão 1, e a segunda chamada devolveu a resposta do recibo.
  assert.equal(lite.prepare(`SELECT version FROM "erp_access__user_control" WHERE user_id=?`).get(seller).version, 1);
  const direct = callRpc(db, "erp_access_user_controls_save", JSON.parse(body), clock, { identity });
  assert.deepEqual(value, JSON.parse(JSON.stringify(direct)));
  lite.close();
});
