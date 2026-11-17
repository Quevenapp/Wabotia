// Instalação nova: toda página de Preferências lida pelo administrador passa
// pelo validador da resposta (parsePreferencesPage), nos dois motores. Achado
// da M: o desvio telas-2-casas (schema/deviations.ts) pôs 2 casas de padrão e
// a página empresa-geral só aceitava o padrão do oráculo (502 na erp-api).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { STORED_PREFERENCE_PAGES } from "../../../src/erp/fagoo/packages/erp-domain/src/preferences/catalog.mjs";
import { parsePreferencesPage } from "../../../src/erp/fagoo/packages/erp-domain/src/preferences/dto.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

test("instalação nova: todas as páginas de Preferências passam pelo validador da resposta", async () => {
  for (const page of STORED_PREFERENCE_PAGES) {
    const raw = await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page.id });
    assert.doesNotThrow(() => parsePreferencesPage(raw, page.id), page.id);
  }
});

test("empresa-geral: 2 casas de padrão no motor; o valor do oráculo segue aceito na versão 0", async () => {
  const raw = await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: "empresa-geral" });
  const value = (key) => raw.items.find((i) => i.key === key);
  for (const key of ["empresa.decimais_preco_saida", "empresa.decimais_preco_entrada", "empresa.decimais_quantidade"])
    assert.deepEqual([value(key).value, value(key).version], [2, 0], key);
  const oracle = structuredClone(raw);
  for (const [key, v] of [["empresa.decimais_preco_saida", 10], ["empresa.decimais_preco_entrada", 10], ["empresa.decimais_quantidade", 6]])
    oracle.items.find((i) => i.key === key).value = v;
  assert.doesNotThrow(() => parsePreferencesPage(oracle, "empresa-geral"));
  const other = structuredClone(raw);
  other.items.find((i) => i.key === "empresa.decimais_quantidade").value = 4;
  assert.throws(() => parsePreferencesPage(other, "empresa-geral"), "versão 0 só aceita os padrões declarados");
});
