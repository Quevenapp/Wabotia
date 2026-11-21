// Relatórios do ERP: DRE gerencial, relatórios em gráfico, lotes vencendo e
// pagamento da equipe, em /api/v1/profiles/:profile/erp-relatorios.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP, para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts), nos assuntos Meu negócio e Financeiro.
// Ler é leitura comum; lançar pagamento da equipe é sensível (o bot propõe e
// a pessoa confirma). As rotas do Worker ficam em ./routes.ts; cada operação
// exige as partes do ERP dela (desligada: 409 module_disabled e qual ligar).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp: desligado, 409 module_disabled). */
export const ERP_RELATORIOS_ROUTE = "erp-relatorios";

export interface ErpReportOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  group: "negocio" | "financeiro";
  /** Partes do ERP que a operação exige (a dona primeiro). */
  parts: readonly ErpModuleId[];
  /** O RPC do motor que a operação chama. */
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_RELATORIOS_ROUTE;
export const ERP_REPORT_OPERATIONS: readonly ErpReportOperation[] = Object.freeze([
  {
    name: "erp.financeiro.dre", method: "GET", path: `${R}/dre`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_dre",
    summary: "Ver o DRE gerencial",
    description: "Mostra o DRE gerencial do período (mês, trimestre, ano ou intervalo) pelo regime de caixa ou de competência: receita bruta, deduções, custos, despesas e resultado, pelas categorias financeiras, comparado com o período anterior. Categorias sem grupo de DRE aparecem em Sem classificação. Só consulta.",
    query: ["de", "ate", "regime", "comparar"], body: [], required: ["de", "ate"],
  },
  {
    name: "erp.financeiro.dre.categoria", method: "GET", path: `${R}/dre/categoria/:id`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_dre",
    summary: "Ver o detalhe de uma categoria no DRE",
    description: "Lista as baixas, contas e lançamentos de caixa que formaram o valor de uma categoria financeira no DRE do período (use \"sem\" para os valores sem categoria). Só consulta.",
    query: ["de", "ate", "regime", "pagina"], body: [], required: ["id", "de", "ate"],
  },
  {
    name: "erp.financeiro.dre.custos", method: "POST", path: `${R}/dre/custos`, sensitive: true, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_dre_cost_set",
    summary: "Marcar uma categoria de despesa como Custos no DRE",
    description: "Marca ou desmarca uma categoria de despesa do primeiro nível para aparecer em Custos no DRE gerencial (ela fica com o grupo Despesas Operacionais nas outras telas). Pela tela de categorias.",
    query: [], body: ["categoria", "custos", "comando"], required: ["categoria", "custos"], bot: false,
  },
  {
    name: "erp.financeiro.dre.custos.ver", method: "GET", path: `${R}/dre/custos`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_dre",
    summary: "Ver as categorias de despesa que vão para Custos no DRE",
    description: "Lista as categorias de despesa do primeiro nível marcadas para aparecer em Custos no DRE gerencial. Só consulta, pela tela de categorias.",
    query: [], body: [], required: [], bot: false,
  },
  {
    name: "erp.negocio.vendas", method: "GET", path: `${R}/graficos/vendas`, sensitive: false, group: "negocio", parts: ["erp-vendas"], rpc: "erp_report_sales_chart",
    summary: "Ver vendas por período, por vendedor ou por produto",
    description: "Mostra os pedidos de venda do período por dia, semana ou mês, por vendedor ou os produtos que mais venderam (relatorio: periodo, vendedor ou produto), sem os cancelados. Só consulta.",
    query: ["relatorio", "de", "ate", "agrupar"], body: [], required: ["relatorio", "de", "ate"],
  },
  {
    name: "erp.financeiro.graficos", method: "GET", path: `${R}/graficos/financeiro`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_chart",
    summary: "Ver o fluxo de caixa ou as contas por vencimento",
    description: "Mostra o fluxo de caixa previsto (contas pelo vencimento) e realizado (entradas e saídas das contas financeiras) por dia, semana ou mês, ou as contas a receber e a pagar em aberto por faixa de vencimento (relatorio: fluxo ou vencimentos). Só consulta.",
    query: ["relatorio", "de", "ate", "agrupar"], body: [], required: ["relatorio"],
  },
  {
    name: "erp.negocio.estoque", method: "GET", path: `${R}/graficos/estoque`, sensitive: false, group: "negocio", parts: ["erp-estoque"], rpc: "erp_stock_chart",
    summary: "Ver o estoque por depósito ou o giro dos produtos",
    description: "Mostra os produtos com saldo e a quantidade em cada depósito, ou o giro dos produtos no período (saídas divididas pelo saldo médio) e quantos dias o saldo dura (relatorio: depositos ou giro). Só consulta.",
    query: ["relatorio", "de", "ate", "deposito"], body: [], required: ["relatorio"],
  },
  {
    name: "erp.negocio.lotes_vencendo", method: "GET", path: `${R}/lotes-vencendo`, sensitive: false, group: "negocio", parts: ["erp-estoque"], rpc: "erp_stock_lots_expiring",
    summary: "Ver os lotes que vencem logo e os já vencidos",
    description: "Lista os lotes com saldo que vencem nos próximos dias (o padrão vem de Preferências › Cadastros › Controle de lotes, ou 30 dias) e, à parte, os já vencidos, por depósito. Só consulta.",
    query: ["dias", "deposito"], body: [], required: [],
  },
  {
    name: "erp.financeiro.equipe.pessoas", method: "GET", path: `${R}/equipe/pessoas`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_team_people",
    summary: "Ver as pessoas da equipe para pagamento",
    description: "Lista os funcionários do cadastro e os vendedores, com o contato que recebe a conta a pagar (o funcionário precisa de um contato com o mesmo CPF) e o percentual de comissão do vendedor. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.financeiro.equipe.pagamentos", method: "GET", path: `${R}/equipe/pagamentos`, sensitive: false, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_team_report",
    summary: "Ver os pagamentos da equipe por pessoa e período",
    description: "Mostra os salários, comissões, adiantamentos e vales lançados no período, por pessoa, com o que já foi pago e o que está em aberto. Só consulta.",
    query: ["de", "ate", "pessoa_tipo", "pessoa", "tipo"], body: [], required: ["de", "ate"],
  },
  {
    name: "erp.financeiro.equipe.comissoes", method: "GET", path: `${R}/equipe/comissoes`, sensitive: false, group: "financeiro", parts: ["erp-financeiro", "erp-vendas"], rpc: "erp_finance_team_commission",
    summary: "Calcular a comissão dos vendedores no período",
    description: "Calcula a comissão de cada vendedor pelas vendas faturadas no período (pedidos atendidos ou com nota fiscal, pela soma dos itens, sem frete) e o percentual do cadastro do vendedor, e mostra as comissões já lançadas. Só consulta.",
    query: ["de", "ate", "vendedor"], body: [], required: ["de", "ate"],
  },
  {
    name: "erp.financeiro.equipe.lancar", method: "POST", path: `${R}/equipe/pagamentos`, sensitive: true, group: "financeiro", parts: ["erp-financeiro"], rpc: "erp_finance_team_pay",
    summary: "Lançar pagamento da equipe como conta a pagar",
    description: "Lança salário, comissão, adiantamento ou vale de um funcionário ou vendedor como conta a pagar, na categoria Pessoal e equipe, com a pessoa e o período ligados. A comissão confere de novo as vendas do período. Mexe no Financeiro: o bot propõe e a pessoa confirma.",
    query: [], body: ["pessoa_tipo", "pessoa", "tipo", "valor", "emissao", "vencimento", "competencia", "periodo_de", "periodo_ate", "descricao", "categoria", "conta_financeira", "comando"],
    required: ["pessoa_tipo", "pessoa", "tipo", "valor", "vencimento", "periodo_de", "periodo_ate"],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpReportOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_REPORT_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const date = { type: "string", format: "date" };
const uuid = { type: "string", format: "uuid" };
/** Esquema de cada parâmetro (consulta, caminho e corpo). */
export const ERP_REPORT_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  de: date, ate: date, emissao: date, vencimento: date, competencia: date, periodo_de: date, periodo_ate: date,
  regime: { type: "string", enum: ["caixa", "competencia"] }, comparar: { type: "string", enum: ["1", "0"] },
  pagina: { type: "integer", minimum: 1 }, id: { type: "string", description: "Categoria financeira (uuid) ou \"sem\"." },
  relatorio: { type: "string", enum: ["periodo", "vendedor", "produto", "fluxo", "vencimentos", "depositos", "giro"] },
  agrupar: { type: "string", enum: ["dia", "semana", "mes"] }, deposito: uuid, dias: { type: "integer", minimum: 0, maximum: 3650 },
  pessoa_tipo: { type: "string", enum: ["funcionario", "vendedor"] }, pessoa: uuid, vendedor: uuid,
  tipo: { type: "string", enum: ["salario", "comissao", "adiantamento", "vale"] },
  valor: { type: "string", pattern: "^[0-9]{1,13}([.,][0-9]{1,2})?$", description: "Valor em reais, como 1500.00." },
  descricao: { type: "string", maxLength: 240 }, categoria: uuid, conta_financeira: uuid, custos: { type: "boolean" }, comando: uuid,
});

/** Parâmetros (caminho, consulta e corpo) num objeto, para o inventário dos bots. */
export function erpReportParams(operation: ErpReportOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_REPORT_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_RELATORIOS_MODULE_CONTRACT = {
  routes: [ERP_RELATORIOS_ROUTE], operations: ["erp.negocio.", "erp.financeiro.dre", "erp.financeiro.graficos", "erp.financeiro.equipe."],
  definition: { bot: { sensitive: ERP_REPORT_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_REPORT_OPERATIONS.map((op) => [op.name, op.summary])) } },
};
