// Vendas e orçamento: catálogo de produtos com estoque e dados fiscais,
// orçamento enviado e aprovado pelo WhatsApp, venda com baixa de estoque e
// comprovante, e a nota fiscal atrás de um provedor. O Caixa (módulo "caixa")
// depende deste. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Código em ./vendas.ts; uso em docs/VENDAS.md.
import type { ModuleDefinition } from "../types";

export const vendasModule: ModuleDefinition = {
  id: "vendas",
  name: "Vendas e orçamento",
  version: "1.0.0",
  description:
    "Produtos com foto, código de barras, estoque e dados fiscais; orçamentos aprovados pelo WhatsApp; vendas com baixa de estoque, comprovante e a nota fiscal pelo emissor escolhido.",
  builtin: true,
  default_enabled: false,
  navigation: [
    { id: "vendas", label: "Vendas e orçamentos", place: "admin", admin: false },
    {
      id: "vendas-produtos",
      label: "Produtos e estoque",
      place: "admin",
      admin: false,
    },
    {
      id: "vendas-config",
      label: "Regras e nota fiscal",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "vendas_orcamentos",
      label: "Meus orçamentos",
      description:
        "Mostra ao cliente os orçamentos enviados a ele, com o total, a validade e a situação; os pendentes vêm com Aprovar e Recusar.",
    },
  ],
  events: [
    "vendas.product_changed",
    "vendas.stock_moved",
    "vendas.stock_low",
    "vendas.quote_saved",
    "vendas.quote_sent",
    "vendas.quote_approved",
    "vendas.quote_declined",
    "vendas.quote_expired",
    "vendas.quote_converted",
    "vendas.sale_created",
    "vendas.sale_paid",
    "vendas.sale_cancelled",
    "vendas.sale_returned",
    "vendas.fiscal_updated",
  ],
  settings: [
    {
      key: "vendas",
      description:
        "Validade do orçamento, formas de pagamento, limite de desconto, cancelamento pela equipe, rodapé do comprovante e dados fiscais do emitente.",
    },
  ],
  routes: ["vendas"],
  operations: ["vendas."],
  scopes: [],
};
