import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { erpBlockOf, erpRouteExists } from "../../src/erp/blocks.ts";
import { erpRouteRequirement } from "../../src/erp/parts-requirements.ts";
import { erpRequirement } from "../../src/erp/parts.ts";
const { routes, discriminators } = JSON.parse(readFileSync("tests/erp/fixtures/route-blocks.json", "utf8"));
function expand(path) {
  path = path.replaceAll(":list_id", "(cadastros.contatos|cadastros.produtos|documentos.sales_orders|documentos.sales_proposals|documentos.service_orders|documentos.purchase_orders|financeiro.contas_receber|financeiro.contas_pagar|fiscal.nfe|fiscal.nfce|fiscal.entrada)");
  path = path.replaceAll(":kind", "(sales_orders|sales_proposals|purchase_orders|service_orders)").replaceAll(":tipo", "(categorias-produtos|grupos-produtos|tags|grupos-tags)");
  const match = /\(([^()]+)\)/.exec(path);
  if (match) return match[1].split("|").flatMap(value => expand(path.slice(0, match.index) + value + path.slice(match.index + match[0].length)));
  return [path.replace(/:[a-z_]+/g, "11111111-1111-4111-8111-111111111111")];
}

test("764 entradas preservadas; todas as alternativas, métodos, discriminadores e RPCs", () => {
  assert.equal(routes.length, 764);
  let total = 0;
  for (const route of routes) {
    assert.ok(Array.isArray(route.rpcs));
    const expected = route.method.split("|").flatMap(method => expand(route.path).map(path => `${method} ${path}`));
    assert.deepEqual(route.cases.map(c => `${c.method} ${c.path}`), expected);
    for (const c of route.cases) {
      total++;
      const label = `${c.method} ${c.path}`;
      assert.equal(erpBlockOf(c.path), c.owner, label);
      assert.ok(erpRouteExists(c.method, c.path), label);
      const r = erpRouteRequirement(c.method, new URL(c.path, "https://erp.invalid"));
      if (c.owner === "externo") assert.equal(r, "externo", label);
      else assert.deepEqual([...r?.all ?? []].sort(), [...erpRequirement(c.owner, ...c.additional).all].sort(), label);
    }
  }
  assert.equal(total, 983);
});

test("prefixo respeita segmentos, e não transforma caminho inexistente em operação", () => {
  assert.equal(erpBlockOf("/v1/estoque/lotes/origem"), "erp-estoque");
  assert.equal(erpBlockOf("/v1/notas-fiscais-x"), null);
  assert.equal(erpBlockOf("/v1/notas-fiscais/origin/abc"), "externo");
  assert.equal(erpBlockOf("/v1/financeiro/borderos"), "erp-financeiro");
  assert.equal(erpBlockOf("/v1/financeiro/remessas/1"), "erp-cobranca");
  assert.equal(erpRouteRequirement("GET", new URL("https://erp.invalid/v1/financeiro/nao-existe/rota")), null);
});


test("discriminadores de corpo e consulta acrescentam os requisitos da operação", () => {
  for (const c of discriminators) {
    const r = erpRouteRequirement(c.method, new URL(c.path, "https://erp.invalid"), c.body);
    assert.deepEqual([...r?.all ?? []].sort(), [...erpRequirement(c.owner, ...c.additional).all].sort(), `${c.method} ${c.path}`);
  }
});
