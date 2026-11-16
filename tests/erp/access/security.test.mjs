// Acesso com a porta de identidade: portão (gate_v2), política de MFA do ERP,
// permissões finas e horário (user_controls), perfil próprio e uso do
// armazenamento, nos dois motores. A identidade (pessoas, sessão, fator) vem
// do auth.* do oráculo (identity-helper.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { rpcAs } from "./identity-helper.mjs";

const f = await dualFixture();
test.after(() => f.close());
const { users } = f;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    return { error: e.code, message: e.message };
  }
};
const session1 = randomUUID(),
  session2 = randomUUID();

test("portão, política de MFA com sessão aal2 e fator verificado", async () => {
  await f.db.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1'),($3,$2,'aal2')", [session1, users.admin, session2]);
  await f.db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at) values($1,$2,'totp','verified',now())", [randomUUID(), users.admin]);
  const gates = async () => {
    for (const user of [...Object.values(users), randomUUID()])
      for (const s of [null, session1, session2]) await outcome(rpcAs(f, "erp_access_gate_v2", { p_user_id: user, p_session_id: s }));
  };
  await gates();
  for (const user of [users.admin, users.vendas]) await outcome(rpcAs(f, "erp_access_security_policy_get", { p_user_id: user, p_session_id: session2 }));
  const save = (version, on, session, command = randomUUID()) =>
    outcome(rpcAs(f, "erp_access_security_policy_save", { p_user_id: users.admin, p_session_id: session, p_command_id: command, p_expected_version: version, p_mfa_required: on }));
  assert.equal((await save(0, true, session1)).error, "28000");
  const cmd = randomUUID();
  assert.ok((await save(0, true, session2, cmd)).ok);
  assert.equal((await save(0, true, session2, cmd)).ok.replayed, true);
  assert.equal((await save(1, true, session2)).error, "22023");
  assert.equal((await save(0, false, session2)).error, "40001");
  await gates(); // com a política ligada: admin e financeiro só com aal2
  for (const user of [users.admin, users.vendas]) await outcome(rpcAs(f, "erp_access_security_policy_get", { p_user_id: user, p_session_id: session1 }));
  assert.ok((await save(1, false, session2)).ok);
});

test("permissões finas e horário por pessoa (user_controls)", async () => {
  const get = (target, user = users.admin) => outcome(rpcAs(f, "erp_access_user_controls_get", { p_user_id: user, p_target: target }));
  for (const t of [users.vendas, users.admin, randomUUID(), null]) await get(t);
  assert.equal((await get(users.vendas, users.vendas)).error, "42501");
  const data = (o = {}) => ({ user_type: "normal", schedule: { enabled: true, windows: [{ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }] }, permissions: ["vendas.pedidos_venda", "vendas.pedidos_venda.ie"], ...o });
  const save = (target, version, d, command = randomUUID()) =>
    outcome(rpcAs(f, "erp_access_user_controls_save", { p_user_id: users.admin, p_command_id: command, p_target: target, p_expected_version: version, p_data: d }));
  for (const bad of [{ user_type: "x" }, { permissions: ["nao.existe"] }, { permissions: ["vendas.pedidos_venda.ie"] }, { schedule: { enabled: true, windows: [] } }, { extra: 1 }])
    assert.equal((await save(users.vendas, 0, data(bad))).error, "22023");
  assert.equal((await save(users.admin, 0, data())).error, "22023"); // o administrador não tem horário nem permissões finas
  assert.equal((await save(randomUUID(), 0, data())).error, "P0002");
  const cmd = randomUUID();
  assert.ok((await save(users.vendas, 0, data(), cmd)).ok);
  assert.equal((await save(users.vendas, 0, data(), cmd)).ok.replayed, true);
  assert.equal((await save(users.vendas, 1, data())).error, "22023"); // sem mudança
  assert.equal((await save(users.vendas, 0, data({ user_type: "contador" }))).error, "40001");
  assert.ok((await save(users.vendas, 1, data({ permissions: null, schedule: { enabled: false, windows: [] } }))).ok);
  await get(users.vendas);
  await outcome(rpcAs(f, "erp_access_permissions_me", { p_user_id: users.vendas }));
});

test("perfil próprio e uso do armazenamento", async () => {
  for (const user of [users.admin, users.vendas, users.inactive, randomUUID()]) await outcome(rpcAs(f, "erp_access_profile_me", { p_user_id: user }));
  await f.rpc("erp_company_save_identity", {
    p_user_id: users.admin, p_expected_version: 0, p_command_id: randomUUID(), p_reason: null,
    p_data: { legal_name: "Empresa do perfil", trade_name: "Marca", cnpj: "11222333000181", ie: null, postal_code: "13400000", street: "Rua A", number: "1", complement: null, district: "Centro", city: "Piracicaba", municipality_code: "3538709", state: "SP", phone: null, email: null },
  });
  await outcome(rpcAs(f, "erp_access_profile_me", { p_user_id: users.admin }));
  await f.putObject("erp-attachments", "company/files/a/b", 1500, "application/pdf");
  await f.putObject("brufap-cnab", "remessa/1.rem", 300, "text/plain");
  await f.putObject("outro-bucket", "x", 7, "text/plain");
  for (const user of [users.admin, users.vendas, users.inactive]) await outcome(rpcAs(f, "erp_access_storage", { p_user_id: user }));
});
