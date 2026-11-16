// Teste de contrato do cliente NFapi. Falha quando a cópia versionada do
// contrato (src/erp/emissor/contract/openapi.json) muda e o resto não
// acompanha: tipos gerados, operações do cliente, situações e respostas.
// Para atualizar: node src/erp/emissor/contract/sync.mjs <openapi.json novo>.
import { describe, expect, it } from "vitest";
import contract from "../../../src/erp/emissor/contract/openapi.json";
import typesSource from "../../../src/erp/emissor/contract/types.generated.ts?raw";
import {
  compatibleVersion,
  contractDiff,
  generateTypes,
  operationsOf,
  type OpenApi,
} from "../../../src/erp/emissor/contract/generate.ts";
import { CONTRACT_OPERATIONS, CONTRACT_VERSION } from "../../../src/erp/emissor/contract/types.generated.ts";
import { CLIENT_OPERATIONS } from "../../../src/erp/emissor/nfapi.ts";
import { ERROR_MAP, KNOWN_SITUACOES } from "../../../src/erp/emissor/nfapi-provider.ts";
import { requestExample, requestSchema, validate } from "./schema";

const spec = contract as unknown as OpenApi;
const clone = () => structuredClone(spec) as OpenApi;

/** Contrato conhecido por este cliente. Mudou? Revise o cliente e atualize. */
const EXPECTED = {
  version: "0.3.1",
  operations: {
    "POST /v1/nfe": ["200", "201", "400", "401", "403", "409", "422", "502"],
    "GET /v1/nfe": ["200", "401"],
    "GET /v1/nfe/{id}": ["200", "401", "404"],
    "POST /v1/nfe/{id}/consultar": ["200", "401", "404", "409"],
    "GET /v1/nfe/{id}/xml": ["200", "401", "404"],
    "POST /v1/nfe/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "502"],
    "POST /v1/nfe/{id}/carta-correcao": ["200", "400", "401", "403", "404", "409", "422", "502"],
    "POST /v1/nfce": ["200", "201", "400", "401", "403", "409", "422", "502"],
    "GET /v1/nfce": ["200", "401"],
    "GET /v1/nfce/{id}": ["200", "401", "404"],
    "POST /v1/nfce/{id}/consultar": ["200", "401", "404", "409"],
    "GET /v1/nfce/{id}/xml": ["200", "401", "404"],
    "POST /v1/nfce/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "502"],
    "POST /v1/nfse": ["200", "201", "400", "401", "403", "409", "422", "502"],
    "GET /v1/nfse": ["200", "401"],
    "GET /v1/nfse/{id}": ["200", "401", "404"],
    "GET /v1/nfse/{id}/xml": ["200", "401", "404"],
    "POST /v1/nfse/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "502"],
    "POST /v1/inutilizacoes": ["201", "400", "401", "403", "409", "422", "502"],
    "GET /v1/series": ["200", "401"],
    "GET /v1/cofre": ["200", "401"],
    "GET /v1/sefaz/status": ["200", "400", "401", "403", "409", "422"],
    "GET /v1/openapi.json": ["200"],
  } as Record<string, string[]>,
  situacoes: {
    EmissaoNfe: ["processando", "autorizada", "rejeitada", "denegada", "erro", "indefinida", "cancelada"],
    EmissaoNfse: ["processando", "autorizada", "rejeitada", "erro", "indefinida", "cancelada"],
  },
  /** Campos de Erro que o cliente lê. */
  erro: ["erro", "campo", "nfe", "nfce", "nfse", "mensagens"],
  /** Campos de Cofre que o painel mostra. */
  cofre: ["versao", "atualizacao", "certificado", "producaoLiberada", "chave", "documentos"],
};

describe("contrato do cofre NFapi", () => {
  it("é a versão conhecida pelo cliente", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe(EXPECTED.version);
    expect(CONTRACT_VERSION).toBe(spec.info.version);
  });

  it("os tipos gerados estão em dia com a cópia versionada", () => {
    // CRLF do checkout no Windows não conta.
    expect(typesSource.replace(/\r\n/g, "\n")).toBe(generateTypes(spec));
  });

  it("operações e respostas são as conhecidas pelo cliente", () => {
    const ops = Object.fromEntries(operationsOf(spec).map((op) => [op.key, op.responses]));
    expect(ops).toEqual(EXPECTED.operations);
  });

  it("o cliente cobre todas as operações do contrato, e só elas", () => {
    expect([...CLIENT_OPERATIONS].sort()).toEqual([...CONTRACT_OPERATIONS].sort());
    expect(new Set(CLIENT_OPERATIONS).size).toBe(CLIENT_OPERATIONS.length);
  });

  it("toda situação de emissão do contrato tem tradução no provedor", () => {
    const schemas = spec.components.schemas;
    for (const [name, list] of Object.entries(EXPECTED.situacoes)) {
      expect(schemas[name].properties.situacao.enum).toEqual(list);
      for (const s of list) expect(KNOWN_SITUACOES).toContain(s);
    }
  });

  it("o corpo de erro e o estado do cofre têm os campos que o cliente lê", () => {
    const schemas = spec.components.schemas;
    expect(Object.keys(schemas.Erro.properties)).toEqual(EXPECTED.erro);
    expect(schemas.Erro.required).toEqual(["erro"]);
    expect(Object.keys(schemas.Cofre.properties)).toEqual(EXPECTED.cofre);
    expect(Object.keys(schemas.Cofre.properties.certificado.properties)).toEqual([
      "titular",
      "documento",
      "validoAte",
      "diasRestantes",
    ]);
  });

  it("os exemplos de pedido do contrato passam no próprio schema", () => {
    for (const [method, path] of [
      ["POST", "/v1/nfe"],
      ["POST", "/v1/nfce"],
      ["POST", "/v1/nfse"],
      ["POST", "/v1/inutilizacoes"],
      ["POST", "/v1/nfe/{id}/cancelar"],
      ["POST", "/v1/nfse/{id}/cancelar"],
      ["POST", "/v1/nfe/{id}/carta-correcao"],
    ]) {
      const example = requestExample(method, path);
      expect(example, `${method} ${path} sem exemplo`).toBeTruthy();
      expect(validate(requestSchema(method, path)!, example), `${method} ${path}`).toEqual([]);
    }
  });

  it("a referência derivada do documento cabe no padrão do contrato", () => {
    const pattern = new RegExp(spec.components.schemas.Cabecalho.properties.referencia.pattern);
    expect(pattern.test("wb.0b5c3f0e-3c6a-4bb0-9a1e-7d1f2b3c4d5e.v9999")).toBe(true);
  });

  it("os códigos de erro mapeados incluem os casos conhecidos", () => {
    for (const code of [
      "sem_resposta_conclusiva",
      "referencia_com_conteudo_diferente",
      "serie_nao_cadastrada",
      "inutilizacao_extinta",
      "uf_nao_suportada",
      "emissao_em_andamento",
      "requisicao_invalida",
    ])
      expect(ERROR_MAP[code], code).toBeTruthy();
  });
});

describe("comparação de contratos", () => {
  it("sem diferença contra si mesmo, mesmo com textos trocados", () => {
    const other = clone();
    other.info.description = "outro texto";
    other.paths["/v1/cofre"].get.summary = "Outro resumo";
    expect(contractDiff(spec, other)).toEqual([]);
  });

  it("aponta operação removida, nova e alterada", () => {
    const other = clone();
    delete other.paths["/v1/inutilizacoes"];
    other.paths["/v1/nfe/{id}/devolver"] = { post: { responses: { "200": { description: "ok" } } } };
    other.paths["/v1/nfe"].post.responses["429"] = { description: "limite" };
    expect(contractDiff(spec, other)).toEqual([
      "operação alterada: POST /v1/nfe",
      "operação removida: POST /v1/inutilizacoes",
      "operação nova: POST /v1/nfe/{id}/devolver",
    ]);
  });

  it("aponta schema alterado (campo novo, enum novo)", () => {
    const other = clone();
    other.components.schemas.EmissaoNfe.properties.situacao.enum.push("contingencia");
    other.components.schemas.Cofre.properties.novo = { type: "string" };
    // Schemas em ordem alfabética (a forma comparada ordena as chaves).
    expect(contractDiff(spec, other)).toEqual(["schema alterado: Cofre", "schema alterado: EmissaoNfe"]);
  });

  it("versões compatíveis antes da 1.0 só na mesma minor", () => {
    expect(compatibleVersion("0.3.1", "0.3.7")).toBe(true);
    expect(compatibleVersion("0.3.1", "0.3.0")).toBe(true);
    expect(compatibleVersion("0.3.1", "0.4.0")).toBe(false);
    expect(compatibleVersion("1.2.0", "1.3.0")).toBe(true);
    expect(compatibleVersion("1.2.0", "2.0.0")).toBe(false);
    expect(compatibleVersion("0.3.1", "lixo")).toBe(false);
  });
});
