// erp_finance_access nos dois motores: todos os papéis e permissões finas
// restritas (erp_access.user_control), com a lista na ordem de
// erp_access.permission_keys().
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { dualFixture, ROLES } from "./harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_access: papéis e permissões finas, iguais nos dois motores", async () => {
  const access = (user) => f.rpc("erp_finance_access", { p_user_id: user });
  for (const role of ROLES) {
    try {
      const r = await access(f.users[role]);
      assert.equal(r.read, true);
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.equal(e.code, "42501", role);
    }
  }
  const restricted = [
    ["financas", "financas.contas_receber", "financas.contas_receber.baixar", "vendas.comissoes"],
    ["financas.contas_pagar", "financas.contas_pagar.ie"],
    ["vendas", "vendas.pedidos_venda", "vendas.pedidos_venda.lancar_contas", "vendas.controle_caixa", "vendas.controle_caixa.ie"],
    [],
  ];
  for (const permissions of restricted) {
    await f.db.query(
      "insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,now(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1",
      [f.users.financeiro, permissions, f.users.admin],
    );
    await f.sync();
    const r = await access(f.users.financeiro);
    assert.ok(r.permitted.every((k) => permissions.includes(k)));
  }
});
