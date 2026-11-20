// Teste de contrato do cliente NFapi. Falha quando a cópia versionada do
// contrato (src/erp/emissor/contract/openapi.json) muda e o resto não
// acompanha: tipos gerados, operações do cliente, situações e respostas.
// Para atualizar: node src/erp/emissor/contract/sync.mjs <openapi.json novo>.
import { describe, expect, expectTypeOf, it } from "vitest";
import contract from "../../../src/erp/emissor/contract/openapi.json";
import typesSource from "../../../src/erp/emissor/contract/types.generated.ts?raw";
import {
  compatibleVersion,
  contractDiff,
  errorCodesOf,
  generateTypes,
  operationsOf,
  type OpenApi,
} from "../../../src/erp/emissor/contract/generate.ts";
import {
  CONTRACT_ERROR_CODES,
  CONTRACT_OPERATIONS,
  CONTRACT_VERSION,
  type EmissaoNfse,
} from "../../../src/erp/emissor/contract/types.generated.ts";
import { BROWSER_ONLY_OPERATIONS, CLIENT_OPERATIONS, OPERATION_MIN_VERSION, olderThan, type NfapiClient, type NfapiResponse } from "../../../src/erp/emissor/nfapi.ts";
import { ERROR_MAP, KNOWN_SITUACOES } from "../../../src/erp/emissor/nfapi-provider.ts";
import { requestExample, requestSchema, validate } from "./schema";

const spec = contract as unknown as OpenApi;
const clone = () => structuredClone(spec) as OpenApi;

/** Contrato conhecido por este cliente. Mudou? Revise o cliente e atualize. */
const EXPECTED = {
  version: "0.12.0",
  operations: {
    "POST /v1/nfe": ["200", "201", "400", "401", "403", "409", "422", "500", "502", "503"],
    "GET /v1/nfe": ["200", "401", "500", "503"],
    "GET /v1/nfe/{id}": ["200", "401", "404", "500", "503"],
    "POST /v1/nfe/{id}/consultar": ["200", "401", "404", "409", "500", "503"],
    "GET /v1/nfe/{id}/xml": ["200", "401", "404", "500", "503"],
    "POST /v1/nfe/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "500", "502", "503"],
    "GET /v1/nfe/{id}/cancelamento/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/nfe/{id}/danfe": ["200", "401", "404", "409", "500", "503"],
    "GET /v1/nfe/{id}/carta-correcao/{sequencia}/xml": ["200", "401", "404", "500", "503"],
    "POST /v1/nfe/{id}/carta-correcao": ["200", "400", "401", "403", "404", "409", "422", "500", "502", "503"],
    "POST /v1/nfce": ["200", "201", "400", "401", "403", "409", "422", "500", "502", "503"],
    "GET /v1/nfce": ["200", "401", "500", "503"],
    "GET /v1/nfce/{id}": ["200", "401", "404", "500", "503"],
    "POST /v1/nfce/{id}/consultar": ["200", "401", "404", "409", "500", "503"],
    "GET /v1/nfce/{id}/xml": ["200", "401", "404", "500", "503"],
    "POST /v1/nfce/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "500", "502", "503"],
    "GET /v1/nfce/{id}/cancelamento/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/nfce/{id}/cupom": ["200", "400", "401", "404", "409", "500", "503"],
    "GET /v1/nfce/{id}/danfce": ["200", "400", "401", "404", "409", "500", "503"],
    "GET /v1/nfe-recebidas": ["200", "400", "401", "500", "503"],
    "POST /v1/nfe-recebidas/manifestar": ["200", "400", "401", "403", "409", "422", "500", "502", "503"],
    "GET /v1/nfe-recebidas/{id}": ["200", "401", "404", "500", "503"],
    "GET /v1/nfe-recebidas/{id}/xml": ["200", "401", "404", "409", "500", "503"],
    "GET /v1/nfe-recebidas/{id}/danfe": ["200", "401", "404", "409", "500", "503"],
    "POST /v1/nfe-recebidas/{id}/manifestar": ["200", "400", "401", "403", "404", "409", "422", "500", "502", "503"],
    "GET /v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/distribuicao": ["200", "401", "500", "503"],
    "POST /v1/distribuicao/sincronizar": ["200", "400", "401", "403", "409", "422", "500", "503"],
    "POST /v1/distribuicao/consultar-chave": ["200", "400", "401", "403", "409", "422", "429", "500", "502", "503"],
    "GET /v1/distribuicao/documentos": ["200", "400", "401", "500", "503"],
    "GET /v1/distribuicao/documentos/{sequencia}/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/notas": ["200", "400", "401", "500", "503"],
    "GET /v1/relatorios/notas": ["200", "400", "401", "403", "500", "503"],
    "POST /v1/exportacoes": ["201", "400", "401", "403", "500", "503"],
    "GET /v1/exportacoes": ["200", "401", "500", "503"],
    "GET /v1/exportacoes/{id}": ["200", "401", "404", "500", "503"],
    "GET /exportacoes/{id}/{arquivo}": ["200", "403"],
    "POST /v1/nfse": ["200", "201", "400", "401", "403", "409", "422", "500", "502", "503"],
    "GET /v1/nfse": ["200", "401", "500", "503"],
    "GET /v1/nfse/{id}": ["200", "401", "404", "500", "503"],
    "GET /v1/nfse/{id}/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/nfse/{id}/cancelamento/xml": ["200", "401", "404", "500", "503"],
    "POST /v1/nfse/{id}/cancelar": ["200", "400", "401", "403", "404", "409", "422", "500", "502", "503"],
    "POST /v1/nfse/{id}/conferir": ["200", "401", "403", "404", "409", "500", "502", "503"],
    "POST /v1/inutilizacoes": ["200", "201", "400", "401", "403", "409", "422", "500", "502", "503"],
    "GET /v1/inutilizacoes": ["200", "400", "401", "500", "503"],
    "GET /v1/inutilizacoes/{id}": ["200", "401", "404", "500", "503"],
    "GET /v1/inutilizacoes/{id}/xml": ["200", "401", "404", "500", "503"],
    "GET /v1/series": ["200", "401", "500", "503"],
    "GET /v1/cofre": ["200", "401", "500", "503"],
    "GET /v1/cofre/logotipo": ["200", "401", "404", "500", "503"],
    "GET /v1/sefaz/status": ["200", "400", "401", "403", "409", "422", "500", "503"],
    "GET /v1/openapi.json": ["200"],
  } as Record<string, string[]>,
  situacoes: {
    EmissaoNfe: ["processando", "autorizada", "contingencia", "rejeitada", "denegada", "erro", "indefinida", "cancelada"],
    EmissaoNfse: ["processando", "autorizada", "rejeitada", "erro", "indefinida", "cancelada"],
  },
  /** Tabela x-codigos: código → status. Código novo ou removido falha aqui. */
  errors: {
    requisicao_invalida: 400,
    nao_autenticado: 401,
    chave_somente_homologacao: 403,
    nao_encontrado: 404,
    certificado_ausente: 409,
    certificado_vencido: 409,
    emissao_em_andamento: 409,
    referencia_com_conteudo_diferente: 409,
    numero_ja_utilizado: 409,
    nfe_nao_autorizada: 409,
    nfse_nao_autorizada: 409,
    faixa_em_uso: 409,
    serie_nao_cadastrada: 422,
    serie_obrigatoria: 422,
    uf_nao_suportada: 422,
    emitente_divergente: 422,
    producao_bloqueada: 422,
    nfe_rejeitada: 422,
    nfe_denegada: 422,
    nfse_rejeitada: 422,
    cancelamento_rejeitado: 422,
    carta_rejeitada: 422,
    carta_nao_se_aplica: 422,
    limite_de_cartas: 422,
    inutilizacao_rejeitada: 422,
    inutilizacao_extinta: 422,
    host_nao_permitido: 422,
    certificado_do_cliente_invalido: 422,
    distribuicao_nao_configurada: 409,
    xml_indisponivel: 409,
    manifestacao_ja_registrada: 409,
    chave_de_acesso_invalida: 422,
    justificativa_obrigatoria: 422,
    limite_de_manifestacoes: 422,
    manifestacao_rejeitada: 422,
    nota_nao_localizada: 422,
    consulta_rejeitada: 422,
    consumo_indevido: 429,
    link_invalido: 403,
    limite_de_consultas: 429,
    sem_resposta_conclusiva: 502,
    sem_conexao: 200,
    erro_interno: 500,
    cofre_nao_configurado: 503,
  } as Record<string, number>,
  /** Campos de Erro que o cliente lê. */
  erro: ["erro", "campo", "nfe", "nfce", "nfse", "mensagens"],
  /** Campos de Cofre que o painel mostra. */
  cofre: ["versao", "atualizacao", "certificado", "producaoLiberada", "contingencia", "logotipo", "chave", "documentos"],
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
    expect(Object.keys(ops)).toHaveLength(53);
    expect(ops).toEqual(EXPECTED.operations);
  });

  it("conferir NFS-e não recebe cancelamento novo e informa alteração na emissão", () => {
    const operation = spec.paths["/v1/nfse/{id}/conferir"].post;
    expect(operation.requestBody).toBeUndefined();
    expect(operation.parameters).toEqual([{
      name: "id", in: "path", required: true, schema: { type: "string" }, description: "Id da emissão no cofre.",
    }]);
    expect(operation.responses["200"].content["application/json"].schema).toEqual({
      allOf: [
        { $ref: "#/components/schemas/EmissaoNfse" },
        { type: "object", properties: { alterada: { type: "boolean" } } },
      ],
    });
    expect(OPERATION_MIN_VERSION["POST /v1/nfse/{id}/conferir"]).toBe("0.12.0");
    expectTypeOf<Awaited<ReturnType<NfapiClient["conferir"]>>>()
      .toEqualTypeOf<NfapiResponse<EmissaoNfse & { alterada?: boolean }>>();
  });

  it("o cliente cobre todas as operações do contrato, e só elas", () => {
    // O download da exportação é do navegador (link assinado), nunca do cliente.
    expect([...CLIENT_OPERATIONS, ...BROWSER_ONLY_OPERATIONS].sort()).toEqual([...CONTRACT_OPERATIONS].sort());
    for (const op of BROWSER_ONLY_OPERATIONS) expect(CLIENT_OPERATIONS).not.toContain(op);
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
      ["POST", "/v1/nfe-recebidas/{id}/manifestar"],
      ["POST", "/v1/nfe-recebidas/manifestar"],
      ["POST", "/v1/distribuicao/consultar-chave"],
      ["POST", "/v1/distribuicao/sincronizar"],
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

  it("a tabela de códigos de erro (x-codigos) é a conhecida e o provedor mapeia todos", () => {
    expect(errorCodesOf(spec)).toEqual(EXPECTED.errors);
    expect(CONTRACT_ERROR_CODES).toEqual(EXPECTED.errors);
    expect(Object.keys(ERROR_MAP).sort()).toEqual(Object.keys(EXPECTED.errors).sort());
  });

  it("listas filtram por referência e ambiente; eventos dizem se já existiam", () => {
    for (const doc of ["nfe", "nfce", "nfse"]) {
      const params = spec.paths[`/v1/${doc}`].get.parameters.map((p: any) => p.name);
      expect(params, doc).toEqual(["referencia", "ambiente", "limite"]);
    }
    for (const path of ["/v1/nfe/{id}/cancelar", "/v1/nfce/{id}/cancelar", "/v1/nfse/{id}/cancelar", "/v1/nfe/{id}/carta-correcao"]) {
      const schema = spec.paths[path].post.responses["200"].content["application/json"].schema;
      expect(schema.allOf[1].required, path).toEqual(["repetido"]);
    }
  });

  it("contingência, inutilização repetida, notas recebidas e versão mínima por operação", () => {
    const schemas = spec.components.schemas;
    // A NFC-e pede a contingência; a emissão diz se saiu nela.
    expect(schemas.OpcoesNfce.properties.contingencia.enum).toEqual(["nunca", "automatica", "forcada"]);
    expect(Object.keys(schemas.EmissaoNfe.properties.contingencia.anyOf?.[0]?.properties ?? schemas.EmissaoNfe.properties.contingencia.properties ?? {})).toEqual(
      expect.arrayContaining(["pendente", "desde", "motivo"]),
    );
    expect(Object.keys(schemas.InutilizacaoRegistrada.properties)).toEqual(expect.arrayContaining(["justificativa", "xmlDisponivel", "repetido"]));
    // A lista de recebidas é lida por cursor.
    expect(spec.paths["/v1/nfe-recebidas"].get.parameters.map((p: any) => p.name)).toEqual(["depois", "limite", "ambiente", "chaveAcesso"]);
    expect(Object.keys(spec.paths["/v1/nfe-recebidas"].get.responses["200"].content["application/json"].schema.properties)).toEqual([
      "recebidas",
      "ultimaSequencia",
      "haMais",
    ]);
    expect(schemas.NotaRecebida.properties.papel.enum).toEqual(["destinatario", "terceiro"]);
    // Toda operação com versão mínima existe no contrato, e a mínima nunca passa a do contrato.
    for (const [op, min] of Object.entries(OPERATION_MIN_VERSION)) {
      expect(CONTRACT_OPERATIONS, op).toContain(op);
      expect(olderThan(CONTRACT_VERSION, min!), op).toBe(false);
    }
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
      "operação removida: GET /v1/inutilizacoes",
      "operação removida: POST /v1/inutilizacoes",
      "operação nova: POST /v1/nfe/{id}/devolver",
    ]);
  });

  it("aponta schema alterado (campo novo, enum novo)", () => {
    const other = clone();
    other.components.schemas.EmissaoNfe.properties.situacao.enum.push("suspensa");
    other.components.schemas.Cofre.properties.novo = { type: "string" };
    // Schemas em ordem alfabética (a forma comparada ordena as chaves).
    expect(contractDiff(spec, other)).toEqual(["schema alterado: Cofre", "schema alterado: EmissaoNfe"]);
  });

  it("mesma major aceita minor mais nova; mínimos pertencem a cada recurso", () => {
    expect(compatibleVersion("0.3.1", "0.3.7")).toBe(true);
    expect(compatibleVersion("0.3.1", "0.3.0")).toBe(true);
    expect(compatibleVersion("0.3.1", "0.4.0")).toBe(true);
    expect(compatibleVersion("0.12.0", "0.13.0")).toBe(true);
    expect(compatibleVersion("0.12.0", "0.8.0")).toBe(true);
    expect(compatibleVersion("0.12.0", "1.0.0")).toBe(false);
    expect(compatibleVersion("1.2.0", "1.3.0")).toBe(true);
    expect(compatibleVersion("1.2.0", "2.0.0")).toBe(false);
    expect(compatibleVersion("0.3.1", "lixo")).toBe(false);
    for (const invalid of ["0.12", "0.12.0lixo", "0.12.0.1", "v0.12.0", " 0.12.0", "0.12.0 ", "00.12.0"])
      expect(compatibleVersion("0.12.0", invalid), invalid).toBe(false);
  });
});
