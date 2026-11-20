import { COM1_MODULE_CONTRACT } from "../../erp/commercial-nfe/metadata.ts";
import { ERP_MANAGEMENT_ITEMS } from "./panel-menu";
import type { ModuleDefinition } from "../types";
import { ERP_PART_DEPENDENCIES, ERP_PART_NAMES, type ErpModuleId } from "../../erp/parts.ts";

const common = {
  version: "0.1.0", builtin: true, default_enabled: false,
  navigation: [], menu_item_types: [], events: [], settings: [],
  routes: [], operations: [], scopes: [],
} satisfies Partial<ModuleDefinition>;
// O nome de exibição vem de src/erp/parts.ts; o identificador não muda.
const definition = (id: ErpModuleId, description: string): ModuleDefinition => ({
  ...common, id, name: ERP_PART_NAMES[id], description, requires: [...ERP_PART_DEPENDENCIES[id]],
  management: ERP_MANAGEMENT_ITEMS.filter(item => item.module === id),
});
export const erpModule: ModuleDefinition = {
  ...definition("erp","Clientes, fornecedores, vendedores, funcionários, contatos, dados da empresa e configurações comuns da área."),
  navigation: [{ id: "erp", label: "ERP", place: "rail", admin: false }],
  routes: ["erp"],
  grants: [
    {
      id: "admin",
      label: "ERP: administrador",
      description:
        "Tudo no ERP, inclusive empresa, usuários do ERP, preferências e política de segurança.",
    },
    {
      id: "consulta",
      label: "ERP: consulta",
      description: "Só leitura: cadastros, documentos, estoque e relatórios.",
    },
    {
      id: "vendas",
      label: "ERP: vendas",
      description:
        "Clientes, produtos, propostas e pedidos de venda, e o caixa quando ligado.",
    },
    {
      id: "financeiro",
      label: "ERP: financeiro",
      description: "Contas a pagar e a receber, caixa, conciliação e cobrança.",
    },
    {
      id: "estoque",
      label: "ERP: estoque",
      description:
        "Entradas, saídas, transferências, inventário e pedidos de compra.",
    },
    {
      id: "fiscal",
      label: "ERP: fiscal",
      description:
        "Notas fiscais, naturezas de operação e numeração, quando o Fiscal está ligado.",
    },
  ],
};
export const erpProdutosModule = definition("erp-produtos", "Catálogo de produtos e serviços, preços, categorias e listas de preços.");
export const erpVendasModule = definition("erp-vendas", "Propostas, pedidos de venda e ordens de serviço comerciais, com integrações opcionais de estoque e financeiro.");
export const erpComprasModule = definition("erp-compras", "Pedidos de compra e acompanhamento comercial; recebimento físico quando o Estoque estiver ligado.");
export const erpEstoqueModule = definition("erp-estoque", "Depósitos, saldos, movimentos, reservas, lotes, composições físicas e inventário.");
export const erpFinanceiroModule = definition("erp-financeiro", "Contas a pagar e receber, baixas, caixa, conciliação e comissões.");
export const erpFiscalModule: ModuleDefinition = {
  ...definition("erp-fiscal", "Documentos fiscais, naturezas, numeração e configuração do emissor, conforme as funcionalidades disponíveis."),
  routes: ["erp-emissor", "erp-fiscal-cofre", ...COM1_MODULE_CONTRACT.routes],
  operations: COM1_MODULE_CONTRACT.operations,
  bot: COM1_MODULE_CONTRACT.definition.bot,
};
export const erpCobrancaModule = definition("erp-cobranca", "Boletos, remessas, retornos e liquidação bancária de títulos do Financeiro.");
export const erpPdvModule = definition("erp-pdv", "Venda no balcão e devolução, integradas a vendas, estoque e caixa financeiro.");
