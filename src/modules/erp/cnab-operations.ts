/** Contrato único das operações HTTP de cobrança usadas pelo painel.
 * Os adaptadores CNAB validam entrada/saída e o motor confere papel, partes,
 * versões e recibos. A exposição ao catálogo deve usar estas mesmas rotas.
 * `sensitive` solicita proposta/confirmação por padrão; a política do bot e
 * da pessoa continua sendo aplicada pelo executor comum.
 */
type Schema = Record<string, unknown>;
type Parameters = { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
export interface CnabOperation {
  id: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  description: string;
  params: Parameters;
  sensitive: boolean;
  result: string;
}
const uuid = { type: "string", format: "uuid" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const version = { type: "integer", minimum: 1, maximum: 2147483647 };
const day = { type: "string", format: "date", pattern: "^20[0-9]{2}-[0-9]{2}-[0-9]{2}$" };
const encoding = { type: "string", enum: ["itau109-no-charges-v1", "itau109-origin-observed-v1"] };
const params = (properties: Record<string, Schema> = {}, required: string[] = []): Parameters =>
  ({ type: "object", additionalProperties: false, properties, required });
const page = (max = 100) => params({ limit: { type: "integer", minimum: 1, maximum: max, default: 25 }, after: uuid });
const withId = (extra: Record<string, Schema> = {}, required: string[] = []) => params({ id: uuid, ...extra }, ["id", ...required]);
const cnabRoles = "Exige Base, Financeiro e Cobrança ativos. Leitura: administrador, financeiro ou consulta; escrita: administrador ou financeiro. A identidade vem da sessão, nunca dos parâmetros.";
const operation = (id: string, method: "GET" | "POST", path: string, summary: string, description: string,
  input: Parameters, result: string, sensitive = false): CnabOperation => ({
  id, method, path, summary, description: `${description} ${cnabRoles}`, params: input, result, sensitive,
});
const approval = (v2: boolean) => withId({
  command_id: uuid, expected_approval_version: { ...version, minimum: 0, maximum: 2147483646 },
  expected_profile_version: version, expected_identity_version: { anyOf: [version, { type: "null" }] },
  enabled: { type: "boolean" }, confirmed_on: day,
  reference: { type: "string", minLength: 3, maxLength: 200, description: "Referência da declaração conferida pelo administrador, sem caracteres de controle." },
  ...(v2 ? {
    allowed_encoding_profiles: { type: "array", items: encoding, uniqueItems: true, maxItems: 2, description: "Habilitado: um ou dois formatos. Desabilitado: lista vazia." },
    compatibility_confirmed: { type: "boolean", description: "Verdadeiro exatamente quando o formato de juros e multa foi escolhido." },
    permanent_instructions_acknowledged: { type: "boolean", description: "Mesmo valor de compatibility_confirmed." },
  } : {}),
}, ["command_id", "expected_approval_version", "expected_profile_version", "expected_identity_version", "enabled", "confirmed_on", "reference",
  ...(v2 ? ["allowed_encoding_profiles", "compatibility_confirmed", "permanent_instructions_acknowledged"] : [])]);
const remittance = (v2: boolean, preview: boolean) => params({
  command_id: uuid, profile_id: uuid, expected_version: version, expected_approval_version: version, generated_on: day,
  titles: { type: "array", minItems: 1, maxItems: 30, description: "Títulos distintos; na v2, números de documento também distintos.", items: params({
    title_id: uuid, expected_version: version, document_number: { type: "string", pattern: "^[A-Z0-9 .&/-]{1,10}$", description: "Sem espaços nas extremidades." },
    ...(!v2 ? { payment_limit_days: { type: "integer", minimum: 1, maximum: 60, description: "Prazo exigido pelo perfil Inter quando aplicável." } } : {}),
  }, ["title_id", "expected_version", "document_number"]) },
  confirm_operational: v2 || !preview ? { const: !preview, type: "boolean" } : { type: "boolean" },
  ...(!preview ? { preview_hash: hash } : {}),
  ...(v2 ? {
    encoding_profile: encoding, confirm_encoding_profile: { const: !preview, type: "boolean" },
    zero_daily_title_ids: { type: "array", items: uuid, uniqueItems: true, maxItems: 30, description: "Subconjunto dos títulos, para confirmar juros diários arredondados a zero. Vazio no formato sem encargos." },
  } : {}),
}, ["command_id", "profile_id", "expected_version", "expected_approval_version", "generated_on", "titles", "confirm_operational",
  ...(!preview ? ["preview_hash"] : []), ...(v2 ? ["encoding_profile", "confirm_encoding_profile", "zero_daily_title_ids"] : [])]);
const eventContext = { file_id: uuid, line: { type: "integer", minimum: 2, maximum: 9999 } };
const confirmedEvent = withId({ ...eventContext, command_id: uuid, expected_approval_version: version, context_hash: hash, confirm: { const: true, type: "boolean" } },
  ["file_id", "line", "command_id", "expected_approval_version", "context_hash", "confirm"]);

export const ERP_CNAB_OPERATIONS: readonly CnabOperation[] = [
  operation("erp_cnab_access", "GET", "/v1/cnab", "Consultar acesso à cobrança", "Informa as permissões da sessão para ler, escrever e configurar cobrança.", params(),
    "Permissões read, write e configure e sinalizadores do contrato."),
  ...([false, true] as const).flatMap(v2 => {
    const prefix = `/v1/cobranca-operacional${v2 ? "-v2" : ""}`, suffix = v2 ? "_v2" : "";
    return [
      operation(`erp_cnab_operational_index${suffix}`, "GET", prefix, "Consultar remessas operacionais", "Atalho para a listagem paginada de remessas; não gera arquivo nem transmite ao banco.", page(v2 ? 30 : 100), "Itens, limite, has_more e next_cursor."),
      operation(`erp_cnab_operational_profiles${suffix}`, "GET", `${prefix}/profiles`, "Listar perfis de cobrança operacional", v2 ? "Lista perfis Itaú carteira 109, formatos e situação da autorização atual." : "Lista perfis Itaú e Inter e situação da autorização operacional.", params(), "Perfis, versões, aprovação, impedimentos e formatos quando aplicáveis."),
      operation(`erp_cnab_operational_approve${suffix}`, "POST", `${prefix}/profiles/:id/approval`, "Registrar autorização operacional de cobrança", "Somente administrador. Grava declaração auditada, com versões esperadas e command_id idempotente. Categoria sensível: administração financeira; exige confirmação por padrão.", approval(v2), "Aprovação atual, versão e indicador de repetição.", true),
      operation(`erp_cnab_operational_files${suffix}`, "GET", `${prefix}/remittances`, "Listar arquivos de remessa", "Lista reservas e remessas prontas por cursor UUID crescente, com uma página limitada.", page(v2 ? 30 : 100), "Itens com estado, sequência, data, quantidade de títulos, tamanho e hash; cursor da próxima página."),
      operation(`erp_cnab_operational_preview${suffix}`, "POST", `${prefix}/remittances/preview`, "Pré-visualizar remessa operacional", "Confere títulos, perfil e aprovação, sem reservar numeração ou gravar arquivo. Exige papel de escrita. A geração posterior recebe o hash desta prévia.", remittance(v2, true), "Prévia com hash, valores, pagadores mascarados, avisos e impedimentos; persisted=false."),
      operation(`erp_cnab_operational_generate${suffix}`, "POST", `${prefix}/remittances`, "Gerar arquivo de remessa operacional", "Confirma a prévia, reserva a numeração, grava arquivo privado e finaliza recibo. Não transmite ao banco nem baixa títulos. Categoria sensível: documento financeiro; confirmação por padrão.", remittance(v2, false), "Remessa pronta, id, sequência, nome, tamanho, hash e recibo idempotente.", true),
      operation(`erp_cnab_operational_resume${suffix}`, "POST", `${prefix}/remittances/:id/resume`, "Retomar geração de remessa", "Retoma uma reserva preservada, conferindo novamente a autorização. Mantém os títulos e a numeração originais. Categoria sensível: documento financeiro.",
        withId({ expected_approval_version: version, ...(v2 ? { command_id: uuid, encoding_profile: encoding } : {}) }, ["expected_approval_version", ...(v2 ? ["command_id", "encoding_profile"] : [])]),
        "Arquivo pronto com o mesmo id da reserva; repetição não gera outra cobrança.", true),
      operation(`erp_cnab_operational_file${suffix}`, "GET", `${prefix}/files/remittance/:id`, "Baixar arquivo de remessa", "Lê o arquivo privado após conferir aprovação, tamanho e SHA-256; revalida o contexto antes de entregar. A entrega a destino novo é sensível e exige confirmação por padrão.", withId(), "Bytes application/octet-stream e nome de arquivo .REM.", true),
    ];
  }),
  operation("erp_cnab_operational_command_v2", "GET", "/v1/cobranca-operacional-v2/commands/:id", "Conferir resultado de comando de cobrança", "Consulta o recibo original e o estado atual de uma autorização ou remessa v2; não repete a escrita.", withId(), "Recibo, tipo do comando e estado atual, com read_only=true."),
  operation("erp_cnab_operational_returns_index", "GET", "/v1/retornos-operacionais", "Consultar retornos operacionais", "Atalho para a listagem paginada dos arquivos de retorno importados.", page(), "Arquivos, limite, has_more e next_cursor."),
  operation("erp_cnab_operational_return_files", "GET", "/v1/retornos-operacionais/files", "Listar arquivos de retorno operacional", "Lista arquivos privados por cursor UUID, sem consultar o banco externo ou aplicar baixas.", page(), "Arquivos, datas, perfis, quantidade de ocorrências, tamanho, hash e próximo cursor."),
  operation("erp_cnab_operational_return_import", "POST", "/v1/retornos-operacionais/files", "Importar arquivo de retorno operacional", "Recebe CNAB 400 obtido no banco, confere o perfil, grava evidência e ocorrências idempotentes. Não baixa títulos. Categoria sensível: documento financeiro recebido; confirmação por padrão.", params({
    profile_id: uuid, expected_approval_version: version, command_id: uuid,
    file_base64: { type: "string", contentEncoding: "base64", maxLength: 5360000, description: "Base64 canônico de 1 a 4.020.000 bytes de arquivo CNAB 400." },
    obtained_from_bank: { type: "boolean", const: true }, reference_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
  }, ["profile_id", "expected_approval_version", "command_id", "file_base64", "obtained_from_bank", "reference_id"]), "Id do arquivo, hash, quantidades de ocorrências novas e repetidas e indicador de replay.", true),
  operation("erp_cnab_operational_events", "GET", "/v1/retornos-operacionais/files/:id/events", "Listar ocorrências de retorno", "Pagina pelas linhas do arquivo indicado, preservando o vínculo da ocorrência com a evidência.", withId({ limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }, after: { type: "integer", minimum: 1, maximum: 9999, default: 1 } }), "Ocorrências, valores, comandos já aplicados e cursor da próxima linha."),
  operation("erp_cnab_operational_return_file", "GET", "/v1/retornos-operacionais/files/:id/download", "Baixar arquivo de retorno", "Entrega os bytes privados após conferir tamanho, hash, aprovação e contexto atual. A entrega a destino novo é sensível e exige confirmação por padrão.", withId(), "Bytes application/octet-stream e nome de arquivo .RET.", true),
  operation("erp_cnab_operational_event", "GET", "/v1/retornos-operacionais/events/:id", "Abrir detalhe de ocorrência de retorno", "Consulta o título, a conta, a evidência e os impedimentos para aplicar a ocorrência. A leitura ainda não confere os bytes do arquivo.", withId(eventContext, ["file_id", "line"]), "Contexto, hash, permissões de vínculo/liquidação e bytes_verified=false."),
  operation("erp_cnab_operational_return_preview", "POST", "/v1/retornos-operacionais/events/:id/preview", "Conferir ocorrência contra arquivo de retorno", "Relê o arquivo armazenado, confere bytes e vínculo, e atualiza o contexto; não lança valores financeiros.", withId(eventContext, ["file_id", "line"]), "Contexto conferido, hash e bytes_verified=true."),
  operation("erp_cnab_operational_bind", "POST", "/v1/retornos-operacionais/events/:id/bind", "Vincular nosso número recebido no retorno", "Confere novamente o arquivo e vincula o número Inter 112 à cobrança exata, sem baixa financeira. Usa hash de contexto e versões da prévia. Categoria sensível: cobrança; confirmação por padrão.", confirmedEvent, "Recibo do vínculo, número e indicador de repetição.", true),
  operation("erp_cnab_operational_settle", "POST", "/v1/retornos-operacionais/events/:id/settle", "Liquidar título pela ocorrência conferida", "Confere arquivo, contexto e aprovação e aplica pagamento integral exato. Valor, conta e data vêm da evidência, nunca do solicitante. Categoria sensível: dinheiro; confirmação por padrão.", confirmedEvent, "Recibo auditado de baixa, título, conta, data, valores e comando idempotente.", true),
  operation("erp_cnab_operational_settlement_get", "GET", "/v1/retornos-operacionais/settlements/:id", "Conferir liquidação registrada", "Lê o recibo da liquidação e o estado atual de título, conta e lançamento, sem repetir a baixa.", withId(), "Recibo e saldos atuais, com read_only=true."),
];
