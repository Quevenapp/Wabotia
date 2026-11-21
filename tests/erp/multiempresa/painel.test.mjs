// Seletor "Empresa" do painel (web/app/company-switch.ts): o rótulo é o nome
// fantasia com o CNPJ, e trocar de empresa abre a mesma tela na outra empresa,
// sem o registro aberto (que é da empresa anterior). Sem rede nem React.
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyLabel, companySwitchRoute, formatCnpj } from "../../../web/app/company-switch.ts";

test("rótulo: nome fantasia e CNPJ com pontuação; sem CNPJ, só o nome", () => {
  assert.equal(formatCnpj("45723174000110"), "45.723.174/0001-10");
  assert.equal(formatCnpj("12.abc.345/01de-35"), "12.ABC.345/01DE-35");
  assert.equal(companyLabel({ nome_fantasia: "Loja Praia", cnpj: "45723174000110" }), "Loja Praia · 45.723.174/0001-10");
  assert.equal(companyLabel({ nome_fantasia: "Loja Centro", cnpj: null }), "Loja Centro");
});

test("troca: mesma tela, sem o registro aberto nem os filtros", () => {
  const id = "5a1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
  assert.deepEqual(companySwitchRoute({ area: "erp", erpPath: `/vendas/pedidos/${id}/editar`, search: "?q=x" }), { area: "erp", erpPath: "/vendas/pedidos" });
  assert.deepEqual(companySwitchRoute({ area: "erp", erpPath: "/financeiro/contas-a-receber" }), { area: "erp", erpPath: "/financeiro/contas-a-receber" });
  assert.deepEqual(companySwitchRoute({ area: "erp", erpPath: "/cadastros/produtos/123" }), { area: "erp", erpPath: "/cadastros/produtos" });
  assert.deepEqual(companySwitchRoute({ area: "erp" }), { area: "erp" });
  assert.deepEqual(companySwitchRoute({ area: "erp", page: "work", typeId: "obra", id }), { area: "erp", page: "work", typeId: "obra" });
  assert.deepEqual(companySwitchRoute({ area: "admin", page: "companies", hash: "#x" }), { area: "admin", page: "companies" });
  assert.deepEqual(companySwitchRoute({ area: "conversations", id }), { area: "conversations" });
  assert.deepEqual(companySwitchRoute({ area: "team", sub: "pessoas", id }), { area: "team", sub: "pessoas" });
});
