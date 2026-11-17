// Portão do motor para agente (aplicação com escopo do ERP): a regra
// erp_access.agent_allowed do Fagoo. Agente com papel admin/financeiro (ou
// permissão fina sensível, mfa_in_scope) é recusado a cada chamada, com a
// política de MFA desligada; agente de consulta, vendas, estoque ou fiscal
// passa; pessoa (não agente) admin passa com a política desligada.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { callRpc, ErpGateDenied } from "../../../src/erp/engine/registry.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const actor = (user, is_agent) => ({
  user_id: user, name: "Aplicação", email: null, aal: "aal1", verified_factor: false, is_agent, session_id: null,
});
const call = (user, is_agent) => {
  try {
    callRpc(f.driver, "erp_stock_policy_get", { p_user_id: user }, undefined, { gate: true, identity: { actor: actor(user, is_agent), people: null } });
    return "ok";
  } catch (e) {
    return e instanceof ErpGateDenied ? e.reason : `outro:${e.code}`;
  }
};

test("agente com papel no escopo do MFA é recusado; fora dele passa; pessoa admin passa", () => {
  assert.equal(call(f.users.admin, true), "agent_out_of_scope");
  assert.equal(call(f.users.financeiro, true), "agent_out_of_scope");
  assert.equal(call(f.users.estoque, true), "ok");
  assert.equal(call(f.users.admin, false), "ok");
});

test("sem o portão (identidade de sistema, chamada sem GATE_HEADER), a regra não roda", () => {
  const r = callRpc(f.driver, "erp_stock_policy_get", { p_user_id: f.users.admin }, undefined, { identity: { actor: actor(f.users.admin, true), people: null } });
  assert.ok(r);
});
