// PDV atrás do bloco erp-pdv (pedido da orquestração, P1): toda rota da erp-api
// que chama um RPC do PDV cai no bloco erp-pdv, e todo RPC do PDV portado só é
// alcançado por essas rotas. Com o módulo desligado, o portão de
// src/erp/api/local-fetch.ts recusa antes do objeto (409; o teste de Workers
// tests/erp-do-pdv-gate.test.ts confere a resposta).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import "../../../src/erp/domains/index.ts";
import { erpBlockOf } from "../../../src/erp/blocks.ts";
import { portedRpcs } from "../../../src/erp/engine/registry.ts";

const { routes } = JSON.parse(readFileSync("tests/erp/fixtures/route-blocks.json", "utf8"));
const sample = (path) => path.replace(/\(([^)|]+)(\|[^)]*)?\)/g, "$1").replace(/:([a-z_]+)/gi, "x1");
const pos = (name) => name.startsWith("erp_pos_");

test("toda rota que chama um RPC do PDV cai no bloco erp-pdv", () => {
  const reached = routes.filter((r) => r.rpcs.some(pos));
  assert.equal(reached.length, 14);
  const wrong = reached.filter((r) => erpBlockOf(sample(r.path)) !== "erp-pdv");
  assert.deepEqual(wrong.map((r) => `${r.method} ${r.path} → ${erpBlockOf(sample(r.path))}`), []);
  // Nenhuma rota de outro bloco chama RPC do PDV.
  assert.deepEqual(routes.filter((r) => r.block !== "pdv" && r.rpcs.some(pos)).map((r) => r.path), []);
});

test("todo RPC do PDV portado tem rota, e só rotas do erp-pdv", () => {
  const ported = [...portedRpcs()].filter(pos).sort();
  assert.deepEqual(ported, [
    "erp_pos_cash_summary",
    "erp_pos_context",
    "erp_pos_favorites",
    "erp_pos_order",
    "erp_pos_sale_execute",
    "erp_pos_sale_get",
    "erp_pos_sales",
    "erp_pos_settings_execute",
  ]);
  for (const name of ported) {
    const via = routes.filter((r) => r.rpcs.includes(name));
    assert.ok(via.length > 0, `${name} sem rota`);
    assert.deepEqual([...new Set(via.map((r) => erpBlockOf(sample(r.path))))], ["erp-pdv"], name);
  }
});
