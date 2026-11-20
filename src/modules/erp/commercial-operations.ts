/** Contrato HTTP das telas comerciais. A tela, integrações e bots usam as mesmas
 * rotas: não há executor alternativo nem concessão de papel neste inventário.
 * Os validadores dos adaptadores continuam sendo a autoridade sobre os dados. */
import { ERP_CNAB_OPERATIONS } from "./cnab-operations.ts";

export interface ErpCommercialOperation {
  id: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  description: string;
  params: { type: "object"; properties: Record<string, any>; required: string[]; additionalProperties?: false };
  sensitive: boolean;
  result: string;
}
const string = { type: "string" };
const date = { type: "string", format: "date" };
const uuid = { type: "string", format: "uuid" };
const statuses = { type: "string", description: "Situações separadas por vírgula: draft,open,verified,in_progress,partially_fulfilled,fulfilled,cancelled." };
const period = { de: date, ate: date };
const sales = { ...period, situacoes: statuses };
const read = (id: string, path: string, summary: string, properties: Record<string, any>, required: string[], description: string, result: string, sensitive = false): ErpCommercialOperation =>
  ({ id, method: "GET", path, summary, description, params: { type: "object", properties, required }, sensitive, result });
const panels: [string, string, Record<string, any>, string[], string][] = [
  ["mensal", "Consultar vendas e indicadores por período", { ...sales, comparar_de: date, comparar_ate: date }, ["de", "ate", "situacoes"], "Até 366 dias; comparação opcional exige as duas datas."],
  ["diario", "Consultar vendas do dia", { dia: date, comparar: date, situacoes: statuses }, ["dia", "situacoes"], "Dia e comparação opcional."],
  ["pedidos-venda", "Consultar pedidos de venda por período e estado", { ...sales, uf: string }, ["de", "ate", "situacoes"], "Até 732 dias; UF opcional."],
  ["vendas-vendedor", "Consultar vendas por vendedor", { ...sales, vendedor: { ...string, minLength: 1, maxLength: 80 } }, ["de", "ate", "situacoes"], "Até 732 dias; vendedor opcional, sem controles ou espaços nas pontas."],
  ["venda-canal", "Consultar vendas por canal", {}, [], "Série dos últimos 24 meses, pelo relógio do servidor."],
  ["previsao-estoque", "Consultar previsão e giro de estoque", { ...period, deposito: uuid, reserva: { type: "string", enum: ["sim", "nao"] }, modo: { type: "string", enum: ["itens", "desmembrados"], default: "itens" } }, ["de", "ate", "reserva"], "Até 732 dias. Exige Vendas e Estoque."],
  ["margem-pedido", "Consultar margem por pedido", { ...sales, aba: { type: "string", enum: ["todos", "lucro", "prejuizo"], default: "todos" } }, ["de", "ate", "situacoes"], "Até 732 dias. Exige Vendas, Compras e Estoque e papel com acesso a custos."],
  ["novos-recorrentes", "Consultar clientes novos e recorrentes", sales, ["de", "ate", "situacoes"], "Até 732 dias."],
  ["atividade-carteira", "Consultar atividade da carteira de clientes", { ...period, marca: { ...string, minLength: 1, maxLength: 100 }, dias: { type: "integer", minimum: 0, maximum: 36600 }, palavras: { type: "string", description: "Até 10 palavras distintas separadas por vírgula, com até 60 caracteres cada, sem controles ou espaços nas pontas." } }, ["de", "ate"], "Até 3661 dias; filtros opcionais de marca, inatividade e palavras."],
  ["curva-abc", "Consultar curva ABC de produtos", { ...sales, marca: { ...string, minLength: 1, maxLength: 100 } }, ["de", "ate", "situacoes"], "Até 732 dias; marca opcional, sem controles ou espaços nas pontas."],
];
export const businessOperations: ErpCommercialOperation[] = [
  ...panels.map(([panel, summary, properties, required, detail]) => read(`erp.business.${panel}`, `/v1/meu-negocio/${panel}`, summary, properties, required,
    `Consulta sem escrita. ${detail} Contrato: business-dashboards.mjs (captureBusinessQuery/parseBusinessPanel).`, "business_dashboard com filtros, totais e séries; valores monetários decimais em texto.")),
  read("erp.business.goals", "/v1/meu-negocio/metas", "Listar metas comerciais", { aba: { type: "string", enum: ["andamento", "inativas"], default: "andamento" } }, [], "Até 200 metas da aba; sem escrita.", "business_goals com items, tab, total e permissão de edição."),
  {
    id: "erp.business.goal.save", method: "POST", path: "/v1/meu-negocio/metas", summary: "Criar ou alterar uma meta comercial",
    description: "Administrador. Comando auditado e idempotente; criação usa goal_id=null e expected_version=0, alteração exige a versão atual. Datas entre 2000-01-01 e 2100-12-31, início até fim e duração máxima de 3661 dias. Segmento geral exige seller=null; vendedor exige nome de vendedor. Textos sem controles ou espaços nas pontas. Contrato: business-dashboards.mjs (captureGoalSave/parseGoalResult).",
    sensitive: true,
    params: { type: "object", additionalProperties: false, required: ["command_id", "goal_id", "expected_version", "data"], properties: {
      command_id: uuid, goal_id: { type: ["string", "null"], format: "uuid" }, expected_version: { type: "integer", minimum: 0, maximum: 2147483646 },
      data: { type: "object", additionalProperties: false, required: ["name", "start_on", "end_on", "segment", "seller", "target", "active"], properties: {
        name: { ...string, minLength: 1, maxLength: 120 }, start_on: date, end_on: date, segment: { type: "string", enum: ["geral", "vendedor"] }, seller: { type: ["string", "null"], minLength: 1, maxLength: 80 },
        target: { type: "string", pattern: "^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,2})?$", not: { enum: ["0", "0.0", "0.00"] }, description: "Valor decimal positivo, até 999999999999.99 e duas casas; sem separador de milhares." }, active: { type: "boolean" },
      } },
    } },
    result: "business_goal_command: replayed, recibo com versões e a meta salva.",
  },
  read("erp.business.goal.command", "/v1/meu-negocio/metas/comandos/:command_id", "Conferir resultado de alteração de meta", { command_id: uuid }, ["command_id"], "Consulta o recibo do comando, sem repetir a escrita.", "business_goal_command: replayed, recibo e meta."),
  read("erp.business.preferences", "/v1/preferencias/meu-negocio", "Consultar ajustes de Meu negócio", {}, [], "Preferências de situações consideradas pelos painéis; exige Vendas.", "preferences_page com itens e versões."),
  read("erp.business.permissions", "/v1/sistema/permissoes", "Consultar permissões dos painéis da pessoa", {}, [], "Permissões efetivas da identidade autenticada; não aceita identidade escolhida pelo cliente.", "Permissões e recursos da pessoa autenticada."),
];
export const activityOperations: ErpCommercialOperation[] = [
  read("erp.activity.list", "/v1/registro-atividades", "Filtrar e paginar atividades ou exclusões", {
    ...period, modulo: string, operacao: { type: "string", description: "exclusao seleciona a consulta de exclusões." }, usuario: uuid, q: string,
    limit: { type: "integer", minimum: 1, maximum: 100, default: 100 }, offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
  }, ["de", "ate"], "Administrador, Base ligada. Período limitado pelo contrato activity.mjs; filtros não alteram registros. Dados de auditoria são sensíveis e sujeitos à configuração de dados do bot.", "activity com items, total, has_more, limit e offset.", true),
  read("erp.activity.detail", "/v1/registro-atividades/detalhe", "Abrir antes e depois de uma atividade", { origem: string, id: string }, ["origem", "id"],
    "Administrador, Base ligada. Fonte e identificador vêm da listagem. Contrato activity.mjs: captureActivityDetailQuery/parseActivityDetail; retorna available=false quando a origem não conserva detalhe.", "activity_detail com available, truncated, before e after.", true),
];
export const erpCommercialOperations: readonly ErpCommercialOperation[] = [
  ...businessOperations, ...activityOperations, ...ERP_CNAB_OPERATIONS,
];
