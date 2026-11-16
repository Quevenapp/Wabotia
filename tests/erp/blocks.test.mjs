// Portão por bloco do ERP (src/erp/blocks.ts) contra o inventário das rotas
// da erp-api (tests/erp/fixtures/route-blocks.json, 764 entradas): cada rota
// cai no bloco classificado pelo RPC que chama.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { erpBlockOf } from "../../src/erp/blocks.ts";

const { routes } = JSON.parse(readFileSync("tests/erp/fixtures/route-blocks.json", "utf8"));
const NAME = { nucleo: "erp", fiscal: "erp-fiscal", cobranca: "erp-cobranca", pdv: "erp-pdv", externo: "externo" };
/** Caminho concreto a partir do padrão: (a|b) → a, :id → x1, .xml etc. ficam. */
const sample = (path) => path.replace(/\(([^)|]+)(\|[^)]*)?\)/g, "$1").replace(/:([a-z_]+)/gi, "x1");

test("toda rota da erp-api cai no bloco do inventário", () => {
  const wrong = routes.filter((r) => erpBlockOf(sample(r.path)) !== NAME[r.block]);
  assert.deepEqual(wrong.map((r) => `${r.method} ${r.path}: ${r.block} → ${erpBlockOf(sample(r.path))}`), []);
  const count = (b) => routes.filter((r) => r.block === b).length;
  assert.equal(routes.length, 764);
  assert.deepEqual([count("nucleo"), count("fiscal"), count("cobranca"), count("pdv"), count("externo")], [499, 118, 53, 16, 78]);
});

test("nomes enganosos: nativos com 'origin' ficam no núcleo; prefixo não pega vizinho", () => {
  assert.equal(erpBlockOf("/v1/estoque/lotes/origem"), "erp");
  assert.equal(erpBlockOf("/v1/notas-fiscais-x"), "erp");
  assert.equal(erpBlockOf("/v1/notas-fiscais/origin/abc"), "externo");
  assert.equal(erpBlockOf("/v1/financeiro/borderos"), "erp");
  assert.equal(erpBlockOf("/v1/financeiro/remessas/1"), "erp-cobranca");
});
