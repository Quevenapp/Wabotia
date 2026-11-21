// Catálogo puro: não importar preferências, telas, registro de módulos ou motor ERP.
import type { ManagementItem, PanelErpRole } from "../panel-contract.ts";

export type MenuGroupName = 'Meu Negócio' | 'Cadastros' | 'Vendas' | 'Estoque' | 'Financeiro' | 'Sistema';
export type CompanyRole = PanelErpRole;

export interface RealTarget { to: string; roles?: readonly CompanyRole[]; resource?: string }
export interface MenuItemDefinition { label: string; real?: RealTarget; /** Destino ainda fora do contrato persistido de favoritos. */ homeShortcut?: false }
export interface MenuColumnDefinition { title: string; items: readonly MenuItemDefinition[] }
export interface MenuGroupDefinition { name: MenuGroupName; columns: readonly MenuColumnDefinition[]; footer?: MenuItemDefinition }

export type ErpPart =
  | "cadastro" | "catalogo" | "vendas" | "compras" | "estoque"
  | "financeiro" | "fiscal" | "cobranca" | "pdv" | "servicos" | "expedicao"
  | "resultados" | "sistema" | "producao";

export interface ErpManagementItem extends ManagementItem {
  part: ErpPart;
  target: { kind: "ported"; to: string };
  permission: { kind: "erp"; roles?: readonly PanelErpRole[]; resource?: string };
}

/** Ordem e ícones atuais do menu portado, sem dependência de textos para classificar. */
export const ERP_MENU_GROUPS = {
  resultados: { group: "resultados", groupLabel: "Resultados", groupOrder: 10, icon: "chart-line" },
  comercial: { group: "comercial", groupLabel: "Comercial", groupOrder: 20, icon: "receipt" },
  compras: { group: "compras", groupLabel: "Compras", groupOrder: 30, icon: "cart-shopping" },
  catalogo: { group: "catalogo", groupLabel: "Catálogo", groupOrder: 40, icon: "box" },
  estoque: { group: "estoque", groupLabel: "Estoque", groupOrder: 50, icon: "warehouse" },
  financeiro: { group: "financeiro", groupLabel: "Financeiro", groupOrder: 60, icon: "building-columns" },
  fiscal: { group: "fiscal", groupLabel: "Fiscal", groupOrder: 70, icon: "file-invoice" },
  pessoas: { group: "pessoas", groupLabel: "Pessoas", groupOrder: 80, icon: "users" },
  sistema: { group: "sistema", groupLabel: "Sistema", groupOrder: 90, icon: "rotate-left" },
} as const;

/** Proprietários por parte; exceções do contrato identificadas por ID. */
export const ERP_MANAGEMENT_ITEMS: readonly ErpManagementItem[] = [
  {
    id: "erp.overview", module: "erp", part: "sistema",
    ...ERP_MENU_GROUPS.resultados, order: 10,
    label: "Dashboard geral", primary: true,
    target: { kind: "ported", to: "/visao-geral" },
    permission: { kind: "erp" },
  },
  {
    id: "erp.sales-dashboard", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.resultados, order: 20,
    label: "Dashboard vendas",
    target: { kind: "ported", to: "/meu-negocio?painel=mensal" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.order-margin", module: "erp-vendas", part: "vendas", requires: ["erp-compras", "erp-estoque"],
    ...ERP_MENU_GROUPS.resultados, order: 30,
    label: "Dashboard margem por pedido",
    target: { kind: "ported", to: "/meu-negocio?painel=margem-pedido" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.products-dashboard", module: "erp-estoque", part: "estoque",
    ...ERP_MENU_GROUPS.resultados, order: 40,
    label: "Dashboard produtos",
    target: { kind: "ported", to: "/painel-produtos-empresa" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.customers-dashboard", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.resultados, order: 50,
    label: "Dashboard clientes",
    target: { kind: "ported", to: "/meu-negocio?painel=novos-recorrentes" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.abc-curve", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.resultados, order: 60,
    label: "Curva ABC",
    target: { kind: "ported", to: "/meu-negocio?painel=curva-abc" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.goals", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.resultados, order: 70,
    label: "Metas",
    target: { kind: "ported", to: "/meu-negocio?painel=metas" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro","estoque","fiscal"] },
  },  // Relatórios do ERP: relatórios em gráfico (cada um aparece com a parte dele ligada).
  {
    id: "erp.report-charts", module: "erp", part: "sistema",
    shownWithAny: ["erp-vendas", "erp-financeiro", "erp-estoque"],
    ...ERP_MENU_GROUPS.resultados, order: 75,
    label: "Relatórios em gráfico",
    target: { kind: "ported", to: "/relatorios-graficos" },
    permission: { kind: "erp" },
  },

  {
    id: "erp.products", module: "erp-produtos", part: "catalogo",
    primary: true,
    ...ERP_MENU_GROUPS.catalogo, order: 80,
    label: "Produtos",
    target: { kind: "ported", to: "/cadastros-reais?cadastro=products" },
    permission: { kind: "erp", resource: "products" },
  },
  {
    id: "erp.customers", module: "erp", part: "cadastro",
    ...ERP_MENU_GROUPS.pessoas, order: 90,
    label: "Clientes e fornecedores", labelKey: "customers",
    target: { kind: "ported", to: "/cadastros-reais?cadastro=contacts" },
    permission: { kind: "erp", resource: "contacts" },
  },
  {
    id: "erp.sellers", module: "erp", part: "cadastro",
    ...ERP_MENU_GROUPS.pessoas, order: 100,
    label: "Vendedores",
    target: { kind: "ported", to: "/vendedores-empresa" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro"] },
  },
  // Lojas e filiais (cadastro da Base): o cadastro é do administrador; a comparação entre lojas, de quem vê cada parte.
  {
    id: "erp.stores", module: "erp", part: "cadastro",
    ...ERP_MENU_GROUPS.pessoas, order: 105,
    label: "Lojas e filiais",
    target: { kind: "ported", to: "/lojas" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.employees", module: "erp", part: "cadastro",
    ...ERP_MENU_GROUPS.pessoas, order: 110,
    label: "Funcionários",
    target: { kind: "ported", to: "/funcionarios-empresa" },
    permission: { kind: "erp", roles: ["admin"] },
  },
  {
    id: "erp.financial-accounts", module: "erp-financeiro", part: "financeiro",
    primary: true,
    ...ERP_MENU_GROUPS.financeiro, order: 120,
    label: "Contas Financeiras",
    target: { kind: "ported", to: "/financeiro-empresa?area=contas-financeiras" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.financial-categories", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 130,
    label: "Categorias Financeiras",
    target: { kind: "ported", to: "/financeiro-empresa?area=categories" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.payment-methods", module: "erp", part: "cadastro",
    // A rota continua da Base; no menu só aparece com quem usa as formas de pagamento.
    shownWithAny: ["erp-vendas", "erp-financeiro", "erp-pdv"],
    ...ERP_MENU_GROUPS.financeiro, order: 140,
    label: "Formas de pagamento",
    target: { kind: "ported", to: "/formas-pagamento-empresa" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas"] },
  },
  {
    id: "erp.product-categories", module: "erp-produtos", part: "catalogo",
    ...ERP_MENU_GROUPS.catalogo, order: 150,
    label: "Categorias de produtos",
    target: { kind: "ported", to: "/categorias-produtos" },
    permission: { kind: "erp", resource: "products" },
  },
  {
    id: "erp.price-lists", module: "erp-produtos", part: "catalogo",
    ...ERP_MENU_GROUPS.catalogo, order: 160,
    label: "Listas de preços",
    target: { kind: "ported", to: "/listas-precos" },
    permission: { kind: "erp", resource: "products" },
  },
  {
    id: "erp.sales-orders", module: "erp-vendas", part: "vendas",
    primary: true,
    ...ERP_MENU_GROUPS.comercial, order: 170,
    label: "Pedidos de venda",
    target: { kind: "ported", to: "/documentos-empresa?tipo=sales_orders" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.outgoing-invoices", module: "erp-fiscal", part: "fiscal",
    primary: true,
    ...ERP_MENU_GROUPS.fiscal, order: 180,
    label: "Notas fiscais de saída",
    target: { kind: "ported", to: "/historico-fiscal?modelo=55" },
    permission: { kind: "erp", roles: ["admin","consulta","fiscal"] },
  },
  {
    id: "erp.consumer-invoices", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 190,
    label: "NFC-e",
    target: { kind: "ported", to: "/historico-fiscal?modelo=65" },
    permission: { kind: "erp", roles: ["admin","consulta","fiscal"] },
  },
  {
    // Receber o Bling, fatia C: notas emitidas no Bling, só consulta (administrador).
    id: "erp.bling-invoices", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 195,
    label: "Notas emitidas no Bling",
    target: { kind: "ported", to: "/notas-bling" },
    permission: { kind: "erp", roles: ["admin"] },
  },
  {
    // Para o contador (src/erp/contador): pacote do período, relatórios fiscais e envio ao contador.
    id: "erp.accountant", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 196,
    label: "Para o contador",
    target: { kind: "ported", to: "/contador-fiscal" },
    permission: { kind: "erp", roles: ["admin","consulta","fiscal"] },
  },
  {
    // Obrigações em arquivo (src/erp/sped): SPED Fiscal, EFD-Contribuições e SINTEGRA do mês, com a conferência antes de gerar.
    id: "erp.sped", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 196,
    label: "SPED e SINTEGRA",
    target: { kind: "ported", to: "/sped-fiscal" },
    permission: { kind: "erp", roles: ["admin","consulta","fiscal"] },
  },
  {
    // Reforma tributária (src/erp/reforma): alíquotas por ano, Simples, classificações e o relatório de IBS, CBS e IS.
    id: "erp.tax-reform", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 197,
    label: "Reforma tributária (IBS, CBS e IS)",
    target: { kind: "ported", to: "/reforma-tributaria" },
    permission: { kind: "erp", roles: ["admin","consulta","fiscal"] },
  },
  {
    id: "erp.pos", module: "erp-pdv", part: "pdv",
    primary: true,
    ...ERP_MENU_GROUPS.comercial, order: 200,
    label: "Frente de caixa",
    target: { kind: "ported", to: "/frente-caixa-empresa" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","financeiro"] },
  },
  {
    id: "erp.sales-proposals", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.comercial, order: 210,
    label: "Propostas comerciais",
    target: { kind: "ported", to: "/documentos-empresa?tipo=sales_proposals" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas"] },
  },
  {
    id: "erp.service-orders", module: "erp-vendas", part: "servicos",
    hidden_when_modules_enabled: ["os"],
    ...ERP_MENU_GROUPS.comercial, order: 220,
    label: "Ordens de serviço",
    target: { kind: "ported", to: "/documentos-empresa?tipo=service_orders" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas"] },
  },
  {
    id: "erp.service-reports", module: "erp-vendas", part: "servicos",
    ...ERP_MENU_GROUPS.comercial, order: 230,
    label: "Relatórios de serviço",
    target: { kind: "ported", to: "/documentos-empresa?tipo=service_orders&acao=relatorios" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas"] },
  },
  {
    id: "erp.order-checkout", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.comercial, order: 240,
    label: "Checkout de pedidos",
    target: { kind: "ported", to: "/documentos-empresa?tipo=sales_orders&acao=checkout" },
    permission: { kind: "erp", roles: ["admin","vendas"] },
  },
  // Expedição (parte erp-expedicao, com Vendas e Estoque): separação, volumes, etiquetas, romaneio e devolução física.
  {
    id: "erp.shipping", module: "erp-expedicao", part: "expedicao", primary: true,
    ...ERP_MENU_GROUPS.comercial, order: 245,
    label: "Expedição",
    target: { kind: "ported", to: "/expedicao" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","estoque","financeiro","fiscal"] },
  },
  {
    id: "erp.sales-reports", module: "erp-vendas", part: "vendas",
    ...ERP_MENU_GROUPS.comercial, order: 250,
    label: "Ver relatórios de vendas",
    target: { kind: "ported", to: "/documentos-empresa?tipo=sales_orders&acao=relatorios" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.purchase-orders", module: "erp-compras", part: "compras",
    primary: true,
    ...ERP_MENU_GROUPS.compras, order: 260,
    label: "Pedidos de compra",
    target: { kind: "ported", to: "/documentos-empresa?tipo=purchase_orders" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro","estoque","fiscal"] },
  },
  {
    id: "erp.received-invoices", module: "erp-compras", part: "compras",
    ...ERP_MENU_GROUPS.compras, order: 265,
    label: "Notas recebidas",
    target: { kind: "ported", to: "/notas-recebidas-compras" },
    permission: { kind: "erp", roles: ["admin","consulta","estoque","financeiro","fiscal"] },
  },
  {
    id: "erp.incoming-invoices", module: "erp-fiscal", part: "fiscal",
    ...ERP_MENU_GROUPS.fiscal, order: 270,
    label: "Notas fiscais de entrada",
    target: { kind: "ported", to: "/notas-entrada" },
    permission: { kind: "erp", roles: ["admin","fiscal","consulta"] },
  },
  {
    id: "erp.suppliers", module: "erp", part: "cadastro",
    ...ERP_MENU_GROUPS.pessoas, order: 280,
    label: "Fornecedores",
    target: { kind: "ported", to: "/cadastros-reais?cadastro=contacts&contato=fornecedor" },
    permission: { kind: "erp", resource: "contacts" },
  },
  {
    id: "erp.purchase-suggestions", module: "erp-compras", part: "compras", requires: ["erp-estoque"],
    ...ERP_MENU_GROUPS.compras, order: 290,
    label: "Sugestão de Compras",
    target: { kind: "ported", to: "/painel-produtos-empresa?painel=sugestao" },
    permission: { kind: "erp", roles: ["admin","consulta","estoque","fiscal"] },
  },
  {
    id: "erp.receiving-checkin", module: "erp-fiscal", part: "fiscal", requires: ["erp-estoque"],
    ...ERP_MENU_GROUPS.compras, order: 300,
    label: "Check-in de Recebimentos",
    target: { kind: "ported", to: "/checkin-recebimentos" },
    permission: { kind: "erp", roles: ["admin","estoque","fiscal"] },
  },
  {
    id: "erp.stock-movements", module: "erp-estoque", part: "estoque",
    primary: true,
    ...ERP_MENU_GROUPS.estoque, order: 310,
    label: "Lançamentos de estoque",
    target: { kind: "ported", to: "/estoque-empresa" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.stock-count", module: "erp-estoque", part: "estoque",
    ...ERP_MENU_GROUPS.estoque, order: 320,
    label: "Conferência de estoque",
    target: { kind: "ported", to: "/conferencia-estoque-empresa" },
    permission: { kind: "erp", roles: ["admin","estoque"] },
  },
  {
    id: "erp.warehouses", module: "erp-estoque", part: "estoque",
    ...ERP_MENU_GROUPS.estoque, order: 330,
    label: "Depósitos",
    target: { kind: "ported", to: "/cadastros-reais?cadastro=warehouses" },
    permission: { kind: "erp", roles: ["admin","consulta","estoque"] },
  },
  // Produção (parte Produção, que depende de Estoque e Produtos): ordens de produção e planejamento.
  {
    id: "erp.production-orders", module: "erp-producao", part: "producao",
    primary: true,
    ...ERP_MENU_GROUPS.estoque, order: 335,
    label: "Ordens de produção",
    target: { kind: "ported", to: "/producao" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.stock-reports", module: "erp-estoque", part: "estoque",
    ...ERP_MENU_GROUPS.estoque, order: 340,
    label: "Ver relatórios de compras e estoque",
    target: { kind: "ported", to: "/relatorios-estoque" },
    permission: { kind: "erp", roles: ["admin","consulta","vendas","estoque","fiscal"] },
  },
  {
    id: "erp.cash-and-banks", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 350,
    label: "Caixas e bancos",
    target: { kind: "ported", to: "/financeiro-empresa?area=accounts" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.payables", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 360,
    label: "Contas a pagar",
    target: { kind: "ported", to: "/financeiro-empresa?area=payable" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.receivables", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 370,
    label: "Contas a receber",
    target: { kind: "ported", to: "/financeiro-empresa?area=receivable" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.bank-remittances", module: "erp-cobranca", part: "cobranca",
    primary: true,
    ...ERP_MENU_GROUPS.financeiro, order: 380,
    label: "Remessas e retornos",
    target: { kind: "ported", to: "/financeiro-empresa?area=remessas" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.operational-billing", module: "erp-cobranca", part: "cobranca",
    ...ERP_MENU_GROUPS.financeiro, order: 381,
    label: "Cobrança operacional",
    target: { kind: "ported", to: "/cobranca-operacional" },
    permission: { kind: "erp", roles: ["admin", "consulta", "financeiro"] },
  },
  {
    id: "erp.operational-returns", module: "erp-cobranca", part: "cobranca",
    ...ERP_MENU_GROUPS.financeiro, order: 382,
    label: "Retornos operacionais",
    target: { kind: "ported", to: "/retornos-operacionais" },
    permission: { kind: "erp", roles: ["admin", "consulta", "financeiro"] },
  },
  {
    id: "erp.financial-statement", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 390,
    label: "Ficha Financeira",
    target: { kind: "ported", to: "/financeiro-empresa?area=ficha" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  // Conciliação: extrato do banco (OFX ou planilha) e vendas de cartão com a adquirente (src/erp/conciliacao).
  {
    id: "erp.bank-reconciliation", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 391,
    label: "Conciliação bancária",
    target: { kind: "ported", to: "/conciliacao-bancaria" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.card-reconciliation", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 392,
    label: "Conciliação de cartões",
    target: { kind: "ported", to: "/conciliacao-cartoes" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.commissions", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 400,
    label: "Comissões",
    target: { kind: "ported", to: "/financeiro-empresa?area=comissoes" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.cash-control", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 410,
    label: "Controle de caixa",
    target: { kind: "ported", to: "/financeiro-empresa?area=controle-caixa" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.grouped-billing", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 420,
    label: "Faturamento agrupado",
    target: { kind: "ported", to: "/financeiro-empresa?area=faturamento-agrupado" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  // Relatórios do ERP: DRE gerencial e pagamento da equipe (Financeiro); relatórios em gráfico (cada um com a parte dele).
  {
    id: "erp.dre", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 431,
    label: "DRE gerencial",
    target: { kind: "ported", to: "/financeiro-empresa?area=dre" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.team-payments", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 432,
    label: "Pagamento da equipe",
    target: { kind: "ported", to: "/financeiro-empresa?area=equipe" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.financial-reports", module: "erp-financeiro", part: "financeiro",
    ...ERP_MENU_GROUPS.financeiro, order: 430,
    label: "Ver relatórios financeiros",
    target: { kind: "ported", to: "/financeiro-empresa?area=relatorios" },
    permission: { kind: "erp", roles: ["admin","consulta","financeiro"] },
  },
  {
    id: "erp.effect-maintenance", module: "erp", part: "sistema",
    // Só há efeitos a desfazer com Estoque ou Financeiro ligado.
    shownWithAny: ["erp-estoque", "erp-financeiro"],
    ...ERP_MENU_GROUPS.sistema, order: 440,
    label: "Manutenção de efeitos",
    target: { kind: "ported", to: "/manutencao-efeitos" }, permission: { kind: "erp" },
  },
  {
    id: "erp.activity", module: "erp", part: "sistema",
    ...ERP_MENU_GROUPS.sistema, icon: "list", order: 450,
    label: "Registro de atividades",
    target: { kind: "ported", to: "/preferencias/sistema/registro-atividades" },
    permission: { kind: "erp", roles: ["admin"] },
  },
  {
    id: "erp.deletions", module: "erp", part: "sistema",
    ...ERP_MENU_GROUPS.sistema, icon: "list", order: 460,
    label: "Consulta de exclusões",
    target: { kind: "ported", to: "/preferencias/sistema/consulta-exclusoes" },
    permission: { kind: "erp", roles: ["admin"] },
  },
  {
    id: "erp.receive-bling", module: "erp", part: "sistema",
    ...ERP_MENU_GROUPS.sistema, icon: "download", order: 470,
    label: "Receber dados do Bling",
    target: { kind: "ported", to: "/receber-bling" }, permission: { kind: "erp" },
  },
];

// Projeção de compatibilidade: conserva forma, rótulos, ordem, colunas e rodapés.
const legacyItems: Record<string, MenuItemDefinition> = Object.fromEntries(
  ERP_MANAGEMENT_ITEMS.map(({ id, label, target, permission }) => [id, {
    label,
    // O menu legado conserva seu alias; a casa publica o destino canônico.
    real: { to: id === "erp.overview" ? "/acesso" : target.to,
      ...(permission.roles ? { roles: permission.roles } : {}),
      ...(permission.resource ? { resource: permission.resource } : {}),
    },
  }]),
);

export const ORIGIN_MENU: readonly MenuGroupDefinition[] = [
  { name: 'Meu Negócio', columns: [{ title: 'Dashboards', items: [
    legacyItems["erp.overview"],
    // Preferências lane (migration 150): Meu Negócio dashboards on /meu-negocio; cost needs purchase orders (margem).
    legacyItems["erp.sales-dashboard"],
    legacyItems["erp.order-margin"],
    legacyItems["erp.products-dashboard"],
    legacyItems["erp.customers-dashboard"],
    legacyItems["erp.abc-curve"],
    legacyItems["erp.goals"],
    { ...legacyItems["erp.report-charts"], homeShortcut: false },
  ] }] },
  { name: 'Cadastros', columns: [
    { title: 'Cadastros', items: [
      legacyItems["erp.products"],
      legacyItems["erp.customers"],
      legacyItems["erp.sellers"],
      { ...legacyItems["erp.stores"], homeShortcut: false },
      legacyItems["erp.employees"],
      legacyItems["erp.financial-accounts"],
      legacyItems["erp.financial-categories"],
      legacyItems["erp.payment-methods"],
    ] },
    { title: 'Ferramentas', items: [
      legacyItems["erp.product-categories"],
      legacyItems["erp.price-lists"],
    ] },
  ], footer: { label: 'Ver relatórios de cadastros' } },
  { name: 'Vendas', columns: [
    { title: 'Gestão', items: [
      legacyItems["erp.sales-orders"],
      legacyItems["erp.outgoing-invoices"],
      legacyItems["erp.consumer-invoices"],
      legacyItems["erp.bling-invoices"],
      legacyItems["erp.accountant"],
      // Reforma tributária: IBS, CBS e IS (configuração, classificações e relatório).
      legacyItems["erp.tax-reform"],
      legacyItems["erp.pos"],
      legacyItems["erp.sales-proposals"],
    ] },
    { title: 'Serviços', items: [
      legacyItems["erp.service-orders"],
      legacyItems["erp.service-reports"],
    ] },
    // Logística: only Checkout de pedidos is in scope (objetos de postagem, logística reversa and Origin Envios are out).
    { title: 'Logística', items: [
      legacyItems["erp.order-checkout"],
      { ...legacyItems["erp.shipping"], homeShortcut: false },
    ] },
  ], footer: legacyItems["erp.sales-reports"] },
  { name: 'Estoque', columns: [
    { title: 'Compras', items: [
      legacyItems["erp.purchase-orders"],
      // Compra pela nota recebida: notas do fornecedor, conferência e entrada.
      legacyItems["erp.received-invoices"],
      legacyItems["erp.incoming-invoices"],
      legacyItems["erp.suppliers"],
      legacyItems["erp.purchase-suggestions"],
      legacyItems["erp.receiving-checkin"],
    ] },
    { title: 'Estoque', items: [
      legacyItems["erp.stock-movements"],
      legacyItems["erp.stock-count"],
      legacyItems["erp.warehouses"],
      { ...legacyItems["erp.production-orders"], homeShortcut: false },
    ] },
  ], footer: legacyItems["erp.stock-reports"] },
  { name: 'Financeiro', columns: [
    { title: 'Gestão financeira', items: [
      legacyItems["erp.cash-and-banks"],
      legacyItems["erp.payables"],
      legacyItems["erp.receivables"],
      legacyItems["erp.bank-remittances"],
      { ...legacyItems["erp.operational-billing"], homeShortcut: false },
      { ...legacyItems["erp.operational-returns"], homeShortcut: false },
      legacyItems["erp.financial-statement"],
      { ...legacyItems["erp.bank-reconciliation"], homeShortcut: false },
      { ...legacyItems["erp.card-reconciliation"], homeShortcut: false },
      legacyItems["erp.commissions"],
      legacyItems["erp.cash-control"],
      legacyItems["erp.grouped-billing"],
    ] },
    { title: 'Relatórios e equipe', items: [
      { ...legacyItems["erp.dre"], homeShortcut: false },
      { ...legacyItems["erp.team-payments"], homeShortcut: false },
    ] },
  ], footer: legacyItems["erp.financial-reports"] },
  { name: 'Sistema', columns: [
    { title: 'Auditoria', items: [
      { ...legacyItems["erp.activity"], homeShortcut: false },
      { ...legacyItems["erp.deletions"], homeShortcut: false },
    ] },
    { title: 'Integrações', items: [
      { ...legacyItems["erp.receive-bling"], homeShortcut: false },
    ] },
  ] },
];

