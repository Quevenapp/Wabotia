// Consulta de CNPJ do cadastro de contato (src/erp/cnpj/lookup.ts): validação, mapeamento das duas bases e a ordem de consulta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validCnpjDigits, fromBrasilApi, fromCnpjWs, lookupCnpj } from "../../src/erp/cnpj/lookup.ts";
import { cnpjFormValues, searchableCnpj } from "../../web/erp/app/lib/cnpj-lookup.ts";

const CNPJ = "11222333000181"; // número de exemplo com dígitos certos

const brasil = {
  razao_social: "EMPRESA EXEMPLO LTDA", nome_fantasia: "EXEMPLO", descricao_situacao_cadastral: "ATIVA", data_inicio_atividade: "2010-05-03",
  cep: "01310100", uf: "sp", municipio: "SAO PAULO", bairro: "BELA VISTA", descricao_tipo_de_logradouro: "AVENIDA", logradouro: "PAULISTA",
  numero: "1000", complemento: "SALA 1", ddd_telefone_1: "1133334444", email: "CONTATO@EXEMPLO.COM.BR", opcao_pelo_simples: true, opcao_pelo_mei: false,
  cnae_fiscal_descricao: "Comércio varejista",
};
const ws = {
  razao_social: "EMPRESA EXEMPLO LTDA", simples: { simples: "Sim", mei: "Não" },
  estabelecimento: { nome_fantasia: "EXEMPLO", situacao_cadastral: "Ativa", cep: "01310-100", tipo_logradouro: "Avenida", logradouro: "Paulista", numero: "1000",
    complemento: null, bairro: "Bela Vista", cidade: { nome: "São Paulo" }, estado: { sigla: "SP" }, ddd1: "11", telefone1: "33334444", email: null,
    inscricoes_estaduais: [{ inscricao_estadual: "110042490114", ativo: true, estado: { sigla: "SP" } }, { inscricao_estadual: "999", ativo: true, estado: { sigla: "RJ" } }] },
};

test("valida os dígitos do CNPJ numérico", () => {
  assert.equal(validCnpjDigits(CNPJ), true);
  assert.equal(validCnpjDigits("11222333000182"), false);
  assert.equal(validCnpjDigits("00000000000000"), false);
  assert.equal(searchableCnpj("11.222.333/0001-81"), true);
  assert.equal(searchableCnpj("12.ABC.345/01DE-35"), false);
});

test("mapeia a BrasilAPI e a CNPJá para o mesmo formato", () => {
  const a = fromBrasilApi(CNPJ, brasil);
  assert.deepEqual([a.cep, a.uf, a.endereco, a.telefone, a.email, a.ativa, a.simples], ["01310-100", "SP", "AVENIDA PAULISTA", "(11) 3333-4444", "contato@exemplo.com.br", true, true]);
  const b = fromCnpjWs(CNPJ, ws);
  assert.deepEqual([b.cep, b.uf, b.endereco, b.telefone, b.inscricao_estadual, b.simples, b.mei], ["01310-100", "SP", "Avenida Paulista", "(11) 3333-4444", "110042490114", true, false]);
});

test("consulta a BrasilAPI primeiro, completa a IE pela CNPJá e cai para a CNPJá quando a primeira falha", async () => {
  const calls = [];
  const ok = await lookupCnpj(CNPJ, async (url) => { calls.push(url); return url.includes("brasilapi") ? { status: 200, body: brasil } : { status: 200, body: ws }; });
  assert.equal(ok.data.fonte, "brasilapi"); assert.equal(ok.data.inscricao_estadual, "110042490114"); assert.equal(calls.length, 2);
  const fallback = await lookupCnpj(CNPJ, async (url) => (url.includes("brasilapi") ? null : { status: 200, body: ws }));
  assert.equal(fallback.data.fonte, "cnpj.ws");
  assert.deepEqual(await lookupCnpj(CNPJ, async () => ({ status: 404, body: {} })), { notFound: true });
  assert.deepEqual(await lookupCnpj(CNPJ, async () => null), { failed: "unavailable" });
  assert.deepEqual(await lookupCnpj(CNPJ, async (url) => ({ status: url.includes("brasilapi") ? 500 : 429, body: {} })), { failed: "busy" });
});

test("o formulário recebe só os campos vazios, ou tudo quando a pessoa pede", () => {
  const data = fromCnpjWs(CNPJ, ws);
  const empty = cnpjFormValues(data, { document: CNPJ }, false);
  assert.equal(empty.name, "EMPRESA EXEMPLO LTDA"); assert.equal(empty.person_type, "J"); assert.equal(empty.crt, "1"); assert.equal(empty.ie, "110042490114"); assert.equal(empty.taxpayer, "1");
  const kept = cnpjFormValues(data, { name: "Meu nome", city: "Campinas", ie_exempt: "true" }, false);
  assert.equal(kept.name, undefined); assert.equal(kept.city, undefined); assert.equal(kept.ie, undefined);
  assert.equal(cnpjFormValues(data, { name: "Meu nome" }, true).name, "EMPRESA EXEMPLO LTDA");
});
