// CNAB atrás do bloco erp-cobranca (pedido da orquestração): toda rota da
// erp-api que chama um RPC do CNAB cai no bloco erp-cobranca, e todo RPC do
// CNAB portado só é alcançado por essas rotas. Com o módulo desligado, o
// portão de src/erp/api/local-fetch.ts recusa antes do objeto (409; o teste
// de Workers tests/erp-do-cnab-gate.test.ts confere a resposta).
// A exceção é a rota do legado Itaú (erp_itau_legacy_readiness), que depende
// do Origin e é externa (404): fora do porte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import "../../../src/erp/domains/index.ts";
import { erpBlockOf } from "../../../src/erp/blocks.ts";
import { portedRpcs } from "../../../src/erp/engine/registry.ts";

const { routes } = JSON.parse(readFileSync("tests/erp/fixtures/route-blocks.json", "utf8"));
const sample = (path) => path.replace(/\(([^)|]+)(\|[^)]*)?\)/g, "$1").replace(/:([a-z_]+)/gi, "x1");
const cnab = (name) => /^erp_(cnab|itau)_/.test(name);

test("toda rota que chama um RPC do CNAB cai no bloco erp-cobranca (o legado Itaú é externo)", () => {
  const reached = routes.filter((r) => r.rpcs.some(cnab));
  assert.equal(reached.length, 54);
  const wrong = reached.filter((r) => erpBlockOf(sample(r.path)) !== (r.path === "/v1/cobrancas-legadas-itau" ? "externo" : "erp-cobranca"));
  assert.deepEqual(wrong.map((r) => `${r.method} ${r.path} → ${erpBlockOf(sample(r.path))}`), []);
  // Nenhuma rota de outro bloco chama RPC do CNAB.
  assert.deepEqual(routes.filter((r) => r.block !== "cobranca" && r.block !== "externo" && r.rpcs.some(cnab)).map((r) => r.path), []);
});

test("todo RPC do CNAB portado tem rota, e só rotas do erp-cobranca", () => {
  const ported = [...portedRpcs()].filter(cnab).sort();
  assert.ok(ported.length >= 23, String(ported.length));
  for (const name of ported) {
    const via = routes.filter((r) => r.rpcs.includes(name));
    assert.ok(via.length > 0, `${name} sem rota`);
    assert.deepEqual([...new Set(via.map((r) => erpBlockOf(sample(r.path))))], ["erp-cobranca"], name);
  }
  assert.equal(ported.includes("erp_itau_legacy_readiness"), false);
});
