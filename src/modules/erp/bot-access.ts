// Concessão nominal nas opções já existentes do bot. Não concede papel ERP:
// o envelope conserva a pessoa e o motor revalida papel, horário e MFA.
import { one } from "../../db";
import { ApiError, json, type Actor, type Env } from "../../types";
import { COM1_OPERATIONS } from "../../erp/commercial-nfe/metadata.ts";
import { NFCE_OPERATIONS } from "../../erp/commercial-nfe/nfce-metadata.ts";
import { OS_NOTE_OPERATIONS } from "../../erp/commercial-nfe/os-notes-metadata.ts";
import { NFE_EVENT_OPERATIONS, NFE_EVENT_PROPERTIES } from "../../erp/commercial-nfe/events-metadata.ts";
import { BLING_MODULE_CONTRACT, BLING_OPERATIONS } from "../../erp/bling/schema.ts";
import { ERP_IMPORT_KINDS, erpRouteRequirement } from "../../erp/parts-requirements.ts";
import { ERP_PART_NAMES, erpRequirement, type ErpModuleId } from "../../erp/parts.ts";
import { BLING_ADOPTION_OPERATIONS, BLING_ADOPTION_PARAMS } from "../../erp/bling/adoption-contracts.ts";
import { erpCommercialOperations } from "./commercial-operations.ts";
import { ERP_BACKUP_OPERATIONS } from "../../erp/engine/backup-operations.ts";
import { ERP_CHARGE_OPERATIONS, ERP_CONVERSA_OPERATIONS, ERP_CONVERSA_ROUTE, erpConversaParams } from "../../erp/conversa/contract.ts";
import { RECEBIDAS_OPERATIONS, RECEBIDAS_ROUTE } from "../../erp/recebidas/operations.ts";
import { ERP_CONTACT_FIELD_OPERATIONS, ERP_CONTACT_FIELDS_ROUTE } from "../../erp/contact-fields/contract.ts";
import { ERP_RELATORIOS_ROUTE, ERP_REPORT_OPERATIONS, erpReportParams } from "../../erp/relatorios/contract.ts";
import { ERP_CONTADOR_OPERATIONS, ERP_CONTADOR_ROUTE, erpContadorParams } from "../../erp/contador/contract.ts";
import { ERP_SPED_OPERATIONS, ERP_SPED_ROUTE, erpSpedParams } from "../../erp/sped/contract.ts";
import { ERP_PRODUCAO_ROUTE, ERP_PRODUCTION_OPERATIONS, erpProductionParams } from "../../erp/production/contract.ts";
import { ERP_EXPEDICAO_PART, ERP_EXPEDICAO_ROUTE, ERP_SHIPPING_OPERATIONS, erpShippingParams } from "../../erp/expedicao/contract.ts";
import { ERP_FREIGHT_OPERATIONS, erpFreightParams } from "../../erp/frete/contract.ts";
import { ERP_LOJAS_PART, ERP_LOJAS_ROUTE, ERP_STORE_OPERATIONS, erpStoreParams } from "../../erp/lojas/contract.ts";
import { ERP_BOLETO_OPERATIONS, ERP_BOLETO_PART, ERP_BOLETO_ROUTE, erpBoletoParams } from "../../erp/boleto-api/contract.ts";
import { ERP_CONCILIACAO_PART, ERP_CONCILIACAO_ROUTE, ERP_RECONCILIATION_OPERATIONS, erpReconciliationParams } from "../../erp/conciliacao/contract.ts";
import { ERP_CONTRACT_OPERATIONS, ERP_CONTRATOS_PART, ERP_CONTRATOS_ROUTE, erpContractParams } from "../../erp/contratos/contract.ts";
import { ERP_TERMINAL_OPERATIONS, ERP_TERMINAL_PART, ERP_TERMINAL_ROUTE, erpTerminalParams } from "../../erp/terminal/contract.ts";
import { ERP_COMPANY_OPERATIONS, ERP_EMPRESAS_PART, ERP_EMPRESAS_ROUTE, erpCompanyParams } from "../../erp/multiempresa/contract.ts";

type Params = { type: "object"; properties: Record<string, any>; required: string[] };
/** Assunto da operação, na ordem da tela de concessões do bot. */
export const ERP_BOT_GROUPS: readonly { id: string; title: string }[] = [
  { id: "negocio", title: "Meu negócio" },
  { id: "financeiro", title: "Financeiro" },
  { id: "cobranca", title: "Cobrança no banco (remessa e retorno)" },
  { id: "nfe", title: "Nota fiscal (NF-e)" },
  { id: "importacao", title: "Importação por planilha" },
  { id: "atividades", title: "Registro de atividades" },
  { id: "bling", title: "Receber dados do Bling" },
  { id: "backup", title: "Backup do ERP" },
  { id: "conversa", title: "Enviar documentos pelo WhatsApp" },
  { id: "producao", title: "Produção (ordens de produção)" },
  { id: "expedicao", title: "Expedição" },
  { id: "frete", title: "Frete e rastreio" },
  { id: "lojas", title: "Lojas e filiais" },
  { id: "conciliacao", title: "Conciliação bancária e de cartões" },
  { id: "contratos", title: "Contratos de serviço" },
  { id: "multiempresa", title: "Várias empresas (CNPJs)" },
];
export interface ErpBotOperation {
  id: string; method: string; path: string; summary: string; sensitive: boolean;
  /** Assunto (ERP_BOT_GROUPS) e explicação em português para a tela e o bot. */
  group: string; description: string;
  /** Parâmetros (caminho, consulta e corpo) num objeto; $ref em ERP_BOT_SCHEMAS. */
  params: Params;
}
/** Esquemas citados pelos parâmetros do Receber dados do Bling. */
export const ERP_BOT_SCHEMAS: Record<string, any> = BLING_MODULE_CONTRACT.openapi.components.schemas as Record<string, any>;
// Tira das descrições as frases que só citam o contrato interno.
const plain = (text: string) => text.split(/(?<=\.)\s+/).filter(sentence => !/^Contrato\b|\.mjs\b/.test(sentence)).join(" ").trim();
function blingParams(name: string): Params {
  const params: Params = { type: "object", properties: {}, required: [] };
  for (const item of Object.values<any>(BLING_MODULE_CONTRACT.openapi.paths)) for (const entry of Object.values<any>(item)) {
    if (entry.operationId !== name) continue;
    for (const p of entry.parameters ?? []) {
      if (p.name === "profile") continue;
      params.properties[p.name] = p.schema;
      if (p.required) params.required.push(p.name);
    }
    const ref = entry.requestBody?.content?.["application/json"]?.schema?.$ref;
    const body = ref ? ERP_BOT_SCHEMAS[String(ref).split("/").pop()!] : undefined;
    Object.assign(params.properties, body?.properties ?? {});
    params.required.push(...(body?.required ?? []).filter((key: string) => !params.required.includes(key)));
  }
  return params;
}
const commercialGroup = (id: string) => id.startsWith("erp.business.") ? "negocio" : id.startsWith("erp.activity.") ? "atividades"
  : id.startsWith("erp_cnab_") ? "cobranca" : "financeiro";
const uuid = { type: "string", format: "uuid" };

/** `sensitive` vem da definição de cada operação: leitura sensível (arquivo de
 * cobrança, registro de atividades) segue o mesmo caminho de proposta da escrita.
 * É o inventário único das concessões: a tela do bot e o catálogo saem daqui. */
export const ERP_BOT_OPERATIONS: readonly ErpBotOperation[] = [
  ...Object.values(BLING_OPERATIONS).filter(op => op.name !== "erp_bling_oauth_callback").map(op => ({
    id: op.name, method: op.method, path: `erp/v1/receber-bling${op.path === "/" ? "" : op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "bling", description: op.description, params: blingParams(op.name),
  })),
  // Adoção do Bling (cadastros, documentos, contas e histórico): o bot propõe, a pessoa confirma.
  ...Object.values(BLING_ADOPTION_OPERATIONS).map(op => ({
    id: op.name, method: op.method, path: `erp/v1/receber-bling${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "bling", description: op.description, params: { type: "object" as const, properties: { ...BLING_ADOPTION_PARAMS[op.name].properties }, required: [...BLING_ADOPTION_PARAMS[op.name].required] },
  })),
  ...erpCommercialOperations.map(op => ({ id: op.id, method: op.method, path: `erp${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: commercialGroup(op.id), description: plain(op.description), params: op.params })),
  ...COM1_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "nfe", description: `${op.summary}.${op.sensitive ? " Mexe na nota fiscal: a pessoa com o papel fiscal confirma." : " Só consulta, sem mudar a nota."}`,
    params: { type: "object" as const, properties: {}, required: [] } })),
  // Cupom fiscal do balcão (NFC-e): emitir, consultar e cancelar mexem na nota (sensíveis).
  ...NFCE_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "nfe", description: `${op.summary}. Exige Caixa / PDV e Fiscal ligados.${op.sensitive ? " Mexe no cupom fiscal: a pessoa com o papel confirma." : " Só consulta, sem mudar o cupom."}`,
    params: { type: "object" as const, properties: {}, required: [] } })),
  // Depois da NF-e autorizada: carta de correção, inutilização e devolução mexem na nota (sensíveis, categoria nota fiscal).
  ...NFE_EVENT_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "nfe", description: `${op.summary}. Exige a parte Fiscal ligada e o cofre configurado.${op.sensitive ? " Mexe na nota fiscal: o bot propõe e a pessoa com o papel fiscal confirma." : " Só consulta, sem mudar a nota."}`,
    params: { type: "object" as const, properties: Object.fromEntries([...(op.path.includes(":id") ? ["id"] : []), ...(op.query ?? []), ...op.body]
      .map(key => [key, key === "id" ? uuid : NFE_EVENT_PROPERTIES[key] ?? { type: "string" }])), required: [...(op.path.includes(":id") ? ["id"] : []), ...op.required] } })),
  // Notas da ordem de serviço (NFS-e e NF-e das peças): emitir, consultar, cancelar e configurar mexem na nota (sensíveis).
  ...OS_NOTE_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary, sensitive: op.sensitive,
    group: "nfe", description: `${op.summary}. Exige a parte Fiscal ligada e o cofre configurado (a nota de peças também Vendas e Produtos).${op.sensitive ? " Mexe na nota fiscal: a pessoa com o papel fiscal confirma." : " Só consulta, sem mudar a nota."}`,
    params: { type: "object" as const, properties: {}, required: [] } })),
  { id: "erp_preferences_import_jobs", method: "GET", path: "erp/v1/importacoes", summary: "Consultar importações por planilha", sensitive: false, group: "importacao",
    description: "Lista as importações por planilha da área, com situação e contagem de linhas criadas, alteradas e recusadas. Só consulta.",
    params: { type: "object", properties: {}, required: [] } },
  { id: "erp_preferences_import_job", method: "GET", path: "erp/v1/importacoes/:id", summary: "Consultar resultado de uma importação", sensitive: false, group: "importacao",
    description: "Mostra o resultado de uma importação por planilha, linha a linha, com o motivo das recusas. Só consulta.",
    params: { type: "object", properties: { id: uuid }, required: ["id"] } },
  { id: "erp_preferences_import_batch", method: "POST", path: "erp/v1/importacoes/:tipo/lote", summary: "Simular ou confirmar um lote de importação por planilha", sensitive: true, group: "importacao",
    description: "Grava (ou só simula, com dry_run) um lote de até mil linhas de planilha no cadastro escolhido, inclusive os dados fiscais dos produtos, as naturezas de operação com as regras fiscais e os saldos iniciais das contas financeiras. Só do administrador do ERP; exige a parte do ERP do cadastro ligada. Sensível: o bot propõe e a pessoa confirma antes de gravar.",
    params: { type: "object", required: ["tipo", "command_id", "job_id", "file_name", "total_rows", "dry_run", "items"], properties: {
      tipo: { type: "string", enum: Object.keys(ERP_IMPORT_KINDS) }, command_id: uuid, job_id: uuid,
      file_name: { type: "string", minLength: 1, maxLength: 200 }, total_rows: { type: "integer", minimum: 1, maximum: 10000 }, dry_run: { type: "boolean" },
      items: { type: "array", maxItems: 1000, items: { type: "object", required: ["row", "lines", "data"], properties: {
        row: { type: "integer", minimum: 2 }, lines: { type: "array", items: { type: "integer", minimum: 2 } }, data: { type: "object" } } } },
    } } },
  // Backup e restauração do ERP: fazer, restaurar e apagar são sensíveis; progresso e lista são leitura comum.
  ...ERP_BACKUP_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "backup", description: (op as { description?: string }).description ?? op.summary, params: { type: "object" as const, properties: {}, required: [] } })),
  // Documento do ERP ao próprio cliente pelo WhatsApp: enviar é sensível (o bot propõe, a pessoa confirma).
  // Cobrança de conta a receber (gerar e confirmar a sugestão de baixa) fica no assunto Financeiro.
  ...[...ERP_CHARGE_OPERATIONS, ...ERP_CONVERSA_OPERATIONS].filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: op.group ?? "conversa", description: op.description, params: erpConversaParams(op) })),
  // Compra pela nota recebida: buscar, importar, cadastrar fornecedor, dar entrada, estornar e manifestar gravam (sensíveis: o bot propõe, a pessoa confirma).
  ...RECEBIDAS_OPERATIONS.filter(op => op.bot).map(op => ({ id: op.name, method: op.method, path: `${RECEBIDAS_ROUTE}/${op.path}`, summary: op.summary,
    sensitive: op.sensitive, group: "nfe", description: op.description, params: { type: "object" as const, properties: {
      ...(op.path.includes(":id") ? { id: uuid } : {}),
      ...Object.fromEntries([...op.body, ...op.query].map(key => [key, key === "command_id" ? uuid : key === "escolhas" ? { type: "object" } : key.startsWith("autorizacao") || key === "reenviar" ? { type: "boolean" } : { type: "string" }])),
    }, required: [...(op.path.includes(":id") ? ["id"] : []), ...op.body.filter(key => key === "command_id" || key === "xml" || key === "tipo" || key === "motivo")] } })),
  // Campos próprios de contato (Cadastros): ler é consulta comum; gravar, o bot propõe e a pessoa confirma.
  // Campo sensível nunca chega ao bot sem a liberação do administrador naquele campo.
  ...ERP_CONTACT_FIELD_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "negocio", description: op.description, params: { type: "object" as const, properties: { ...op.params.properties }, required: [...op.params.required] } })),
  // Relatórios do ERP: DRE, gráficos e lotes vencendo são leitura comum; lançar pagamento da equipe é sensível.
  ...ERP_REPORT_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: op.group, description: op.description, params: erpReportParams(op) })),
  // Para o contador (assunto NF-e): montar o pacote e consultar são operações comuns; enviar ao contador é sensível.
  ...ERP_CONTADOR_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: op.group, description: op.description, params: erpContadorParams(op) })),
  // Obrigações em arquivo (assunto NF-e): conferir, gerar e consultar são operações comuns; enviar ao contador é sensível.
  ...ERP_SPED_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: op.group, description: op.description, params: erpSpedParams(op) })),
  // Produção: consultar ordens e sugestões é leitura; criar, concluir e estornar são sensíveis (o bot propõe, a pessoa confirma).
  ...ERP_PRODUCTION_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "producao", description: op.description, params: erpProductionParams(op) })),
  // Expedição: consultar é leitura comum; gerar separação, marcar expedido e registrar devolução são sensíveis.
  ...ERP_SHIPPING_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "expedicao", description: op.description, params: erpShippingParams(op) })),
  // Frete da Expedição: ver o frete, cotar e consultar o rastreio são leitura; contratar e cancelar o envio são sensíveis.
  ...ERP_FREIGHT_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "frete", description: op.description, params: erpFreightParams(op) })),
  // Lojas: ver as lojas e comparar as lojas é leitura comum; a lista de operações de uma loja é leitura sensível.
  ...ERP_STORE_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "lojas", description: op.description, params: erpStoreParams(op) })),
  // Boleto pela API do banco (assunto Cobrança no banco): consultar o boleto e a situação no banco são leitura;
  // registrar, alterar o vencimento, baixar e confirmar a baixa são sensíveis. PDF, interruptores e conta financeira, só pela tela.
  ...ERP_BOLETO_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "cobranca", description: op.description, params: erpBoletoParams(op) })),
  // Conciliação: consultar as pendências é leitura comum; conciliar uma linha do extrato e receber o cartão na conta (baixas) são sensíveis.
  ...ERP_RECONCILIATION_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "conciliacao", description: op.description, params: erpReconciliationParams(op) })),
  // Contratos de serviço: consultar contratos, faturas, avisos, índices e a prévia do reajuste é leitura;
  // ativar, suspender, reajustar e encerrar são sensíveis (o bot propõe, a pessoa confirma).
  ...ERP_CONTRACT_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "contratos", description: op.description, params: erpContractParams(op) })),
  // Maquininha integrada ao caixa (assunto Conciliação de cartões): só consultar os pagamentos da maquininha.
  // Enviar a cobrança ao terminal, cancelar, reenviar e configurar ficam fora (exigem pessoa no caixa).
  ...ERP_TERMINAL_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "conciliacao", description: op.description, params: erpTerminalParams(op) })),
  // Várias empresas: ver as empresas e o consolidado é leitura comum; a prévia da cópia (nomes de clientes) e copiar cadastros são sensíveis.
  ...ERP_COMPANY_OPERATIONS.filter(op => op.bot !== false).map(op => ({ id: op.name, method: op.method, path: op.path, summary: op.summary, sensitive: op.sensitive,
    group: "multiempresa", description: op.description, params: erpCompanyParams(op) })),
];

/** Leituras sensíveis que o administrador pode deixar o bot executar sozinho. */
export const ERP_BOT_SENSITIVE_READS: readonly string[] = ERP_BOT_OPERATIONS.filter(op => op.sensitive && op.method === "GET").map(op => op.id);

/** Partes do ERP que a rota exige antes do objeto (o motor revalida). */
export function erpBotModules(op: Pick<ErpBotOperation, "method" | "path">): readonly ErpModuleId[] {
  if (op.path.startsWith("erp-comercial-nfe/nfce/")) return erpRequirement("erp-fiscal", "erp-pdv").all;
  if (op.path.startsWith("erp-comercial-nfe/")) return erpRequirement("erp-fiscal").all;
  if (op.path.startsWith(`${ERP_CONTADOR_ROUTE}/`)) return erpRequirement("erp-fiscal").all;
  if (op.path.startsWith(`${ERP_SPED_ROUTE}/`)) return erpRequirement("erp-fiscal").all;
  if (op.path.startsWith(`${RECEBIDAS_ROUTE}/`)) return RECEBIDAS_OPERATIONS.find(item => `${RECEBIDAS_ROUTE}/${item.path}` === op.path && item.method === op.method)?.parts ?? erpRequirement("erp-compras").all;
  // A parte de cada documento é conferida na rota (proposta e pedido: Vendas; nota: Fiscal; conta: Financeiro).
  if (op.path.startsWith(`${ERP_CONVERSA_ROUTE}/conta/:id/cobranca`)) return erpRequirement("erp-financeiro").all;
  if (op.path === ERP_CONVERSA_ROUTE || op.path.startsWith(`${ERP_CONVERSA_ROUTE}/`)) return erpRequirement("erp").all;
  // Campos próprios de contato: só a parte Cadastros.
  if (op.path === ERP_CONTACT_FIELDS_ROUTE || op.path.startsWith(`${ERP_CONTACT_FIELDS_ROUTE}/`)) return erpRequirement("erp").all;
  const report = op.path.startsWith(`${ERP_RELATORIOS_ROUTE}/`) ? ERP_REPORT_OPERATIONS.find(item => item.method === op.method && item.path === op.path) : undefined;
  if (report) return erpRequirement(...report.parts).all;
  const production = op.path.startsWith(`${ERP_PRODUCAO_ROUTE}/`) ? ERP_PRODUCTION_OPERATIONS.find(item => item.method === op.method && item.path === op.path) : undefined;
  if (production) return erpRequirement(...production.parts).all;
  // Expedição: a parte dela, com Vendas e Estoque.
  if (op.path === ERP_EXPEDICAO_ROUTE || op.path.startsWith(`${ERP_EXPEDICAO_ROUTE}/`)) return erpRequirement(ERP_EXPEDICAO_PART).all;
  // Lojas: cadastro da Base (cada seção do relatório confere a parte dela no motor).
  if (op.path === ERP_LOJAS_ROUTE || op.path.startsWith(`${ERP_LOJAS_ROUTE}/`)) return erpRequirement(ERP_LOJAS_PART).all;
  // Boleto pela API do banco: a Cobrança bancária (com o Financeiro).
  if (op.path.startsWith(`${ERP_BOLETO_ROUTE}/`)) return erpRequirement(ERP_BOLETO_PART).all;
  // Maquininha integrada ao caixa: o Caixa / PDV (com Vendas, Financeiro e Estoque).
  if (op.path.startsWith(`${ERP_TERMINAL_ROUTE}/`)) return erpRequirement(ERP_TERMINAL_PART).all;
  // Conciliação: a parte Financeiro.
  if (op.path.startsWith(`${ERP_CONCILIACAO_ROUTE}/`)) return erpRequirement(ERP_CONCILIACAO_PART).all;
  // Contratos de serviço: a parte Contratos, com o Financeiro.
  if (op.path === ERP_CONTRATOS_ROUTE || op.path.startsWith(`${ERP_CONTRATOS_ROUTE}/`)) return erpRequirement(ERP_CONTRATOS_PART).all;
  // Várias empresas: a Base do ERP (a cópia confere a parte de cada cadastro nas duas empresas).
  if (op.path === ERP_EMPRESAS_ROUTE || op.path.startsWith(`${ERP_EMPRESAS_ROUTE}/`)) return erpRequirement(ERP_EMPRESAS_PART).all;
  const requirement = erpRouteRequirement(op.method, new URL(`https://erp.invalid/${op.path.slice("erp/".length).replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "x")}`));
  return requirement && requirement !== "externo" ? requirement.all : erpRequirement("erp").all;
}

/** Inventário para a tela de concessões do bot (só administrador), por assunto. */
export function erpBotInventory(states: Readonly<Record<string, boolean>>) {
  return { groups: ERP_BOT_GROUPS.map(group => ({ ...group, operations: ERP_BOT_OPERATIONS.filter(op => op.group === group.id).map(op => ({
    id: op.id, title: op.summary, description: op.description, kind: op.method === "GET" ? "read" as const : "write" as const,
    sensitive: op.sensitive, autonomous: ERP_BOT_SENSITIVE_READS.includes(op.id),
    modules: erpBotModules(op).map(id => ({ id, title: ERP_PART_NAMES[id], enabled: !!states[id] })),
  })) })) };
}

export function erpBotOperationsInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ERP_BOT_OPERATIONS.length ||
      value.some(id => typeof id !== "string" || !ERP_BOT_OPERATIONS.some(op => op.id === id)) ||
      new Set(value).size !== value.length)
    throw new ApiError(400, "invalid_request", "Escolha operações conhecidas do ERP, sem repetições.");
  return value;
}

/** Opção do administrador, desligada por padrão: leituras sensíveis que este
 * bot executa sem proposta. Só vale junto da concessão nominal da operação. */
export function erpBotAutonomousInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ERP_BOT_SENSITIVE_READS.length ||
      value.some(id => typeof id !== "string" || !ERP_BOT_SENSITIVE_READS.includes(id)) || new Set(value).size !== value.length)
    throw new ApiError(400, "invalid_request", "Escolha leituras sensíveis conhecidas do ERP, sem repetições.");
  return value;
}

/** Lida de novo em cada chamada/confirmação; nunca aceita concessão em `via`. */
export async function erpBotGrantedOperations(env: Env, actor: Actor, profile: string): Promise<readonly string[]> {
  return (await erpBotOptions(env, actor, profile)).operations;
}

/** Concessões e leituras autônomas deste bot na área, relidas do banco. */
export const erpBotGrants = (env: Env, actor: Actor, profile: string) => erpBotOptions(env, actor, profile);

/** Lojas do ERP a que o bot fica limitado (opção do administrador): ids únicos; vazio = sem limite do bot. */
export function erpBotStoresInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length ||
      value.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))
    throw new ApiError(400, "invalid_request", "Escolha lojas do ERP pela lista, sem repetições.");
  return value;
}

/** Envelope do motor: o limite de lojas do bot por quem a pessoa age (a pessoa continua com o limite dela; o motor cruza os dois). */
export async function erpBotStoreScope(env: Env, actor: Actor, profile: string): Promise<{ store_scope?: string[] }> {
  if (actor.kind !== "user" || !actor.via) return {};
  const stores = (await erpBotOptions(env, actor, profile)).stores;
  return stores.length ? { store_scope: [...stores] } : {};
}

const names = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
async function erpBotOptions(env: Env, actor: Actor, profile: string): Promise<{ operations: readonly string[]; autonomous: readonly string[]; stores: readonly string[] }> {
  if (actor.kind !== "user" || !actor.via) return { operations: [], autonomous: [], stores: [] };
  const row = await one(env, `SELECT b.remote_profile,c.config FROM bots b
    JOIN connections c ON c.id=b.connection_id AND c.profile_id=b.profile_id
    JOIN bot_runs r ON r.bot_id=b.id AND r.profile_id=b.profile_id
    JOIN internal_chats h ON h.id=json_extract(r.context,'$.internal_chat_id') AND h.profile_id=r.profile_id
    WHERE b.id=? AND b.profile_id=? AND b.enabled=1 AND c.status='active' AND r.id=? AND r.actor=? AND r.conversation_id IS NULL
      AND ((h.member_a=? AND h.member_b=?) OR (h.member_b=? AND h.member_a=?))`,
    actor.via.bot_id, profile, actor.via.run_id, actor.id,
    actor.id, `bot:${actor.via.bot_id}`, actor.id, `bot:${actor.via.bot_id}`);
  const options = row && json(row.config).bot_options?.[row.remote_profile];
  const operations = names(options?.erp_operations);
  return { operations, autonomous: names(options?.erp_autonomous_operations).filter(id => operations.includes(id)), stores: names(options?.erp_stores) };
}

export async function erpBotOperationGranted(env: Env, actor: Actor, profile: string, operation: string): Promise<boolean> {
  return (await erpBotGrantedOperations(env, actor, profile)).includes(operation);
}

/** Somente a rota nominal liberada; escrita e leitura sensível usam a proposta
 * já reclamada pela confirmação humana. Um id de proposta solto não é prova de
 * confirmação. A leitura sensível dispensa a proposta só quando o
 * administrador marcou aquela operação como autônoma para aquele bot. */
export function erpBotOperation(profile: string, method: string, path?: string) {
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/`;
  if (!path?.startsWith(prefix)) return undefined;
  const route = path.slice(prefix.length), verb = method.toUpperCase();
  return ERP_BOT_OPERATIONS.find(op => op.method === (verb === "HEAD" ? "GET" : verb) &&
    new RegExp(`^${op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+")}/?$`).test(route));
}

export async function erpBotDelegation(env: Env, actor: Actor, profile: string, method: string, path?: string, body?: unknown): Promise<boolean> {
  if (!actor.via || !path) return false;
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/`;
  if (!path.startsWith(prefix)) return false;
  const route = path.slice(prefix.length), verb = method.toUpperCase();
  const operation = erpBotOperation(profile, verb, path);
  if (!operation) return false;
  const options = await erpBotOptions(env, actor, profile);
  if (!options.operations.includes(operation.id)) return false;
  const reading = verb === "GET" || verb === "HEAD";
  if (reading && (!operation.sensitive || options.autonomous.includes(operation.id))) return true;
  if (!actor.sessionId || !actor.via.proposal_id) return false;
  const proposal = await one(env, `SELECT path,params FROM bot_proposals WHERE id=? AND profile_id=?
    AND actor=? AND bot_id=? AND run_id=? AND mode='team' AND status='running' AND method=? AND decided_at IS NOT NULL`,
    actor.via.proposal_id, profile, actor.id, actor.via.bot_id, actor.via.run_id, reading ? "GET" : verb);
  if (!proposal) return false;
  const params = json(proposal.params);
  const keys = new Set<string>();
  const resolved = proposal.path.replace(/:(\w+)/g, (_: string, key: string) => { keys.add(key); return encodeURIComponent(String(params[key] ?? "")); });
  if (resolved !== route.replace(/\/$/, "")) return false;
  if (body === undefined) return true;
  const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return canonical(body) === canonical(Object.fromEntries(Object.entries(params).filter(([key]) => !keys.has(key))));
}
