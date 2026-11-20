import type { AreaTemplate } from "../validation";

// Loja sem ordem de serviço: vendas, estoque, caixa e financeiro pelo ERP.
// O ERP não oferece item de menu de WhatsApp; os menus encaminham à equipe.
export const comercioTemplate: AreaTemplate = {
  schema_version: 1,
  id: "comercio",
  version: 1,
  name: "Comércio",
  description: "Loja com cadastro de produtos, vendas, estoque, caixa (PDV) e financeiro. Pedidos, trocas e pagamentos pelo WhatsApp são tratados pela equipe.",
  work_types: [],
  modules: {
    erp: true,
    "erp-produtos": true,
    "erp-vendas": true,
    "erp-estoque": true,
    "erp-financeiro": true,
    "erp-pdv": true,
    "erp-compras": false,
    "erp-fiscal": false,
    "erp-cobranca": false,
  },
  vocabulary: { collection_label: "Pedidos", customer_singular: "Cliente", customer_plural: "Clientes" },
  departments: [
    { id: "vendas", name: "Vendas", members: [], enabled: true },
    { id: "pedidos", name: "Pedidos e entregas", members: [], enabled: true },
    { id: "financeiro", name: "Financeiro", members: [], enabled: true },
  ],
  ticket_categories: [
    { id: "orcamento", name: "Orçamento ou disponibilidade", enabled: true },
    { id: "pedido", name: "Andamento do pedido", enabled: true },
    { id: "entrega", name: "Entrega ou retirada", enabled: true },
    { id: "troca", name: "Troca ou devolução", enabled: true },
    { id: "pagamento", name: "Pagamento", enabled: true },
    { id: "nota", name: "Nota ou comprovante", enabled: true },
    { id: "reclamacao", name: "Reclamação", enabled: true },
  ],
  menus: [
    { id: "consultar_pedido", label: "Consultar meu pedido com a equipe", type: "human", department_id: "pedidos" },
    { id: "vendedor", label: "Falar com um vendedor", type: "human", department_id: "vendas" },
    { id: "troca", label: "Trocas e devoluções", type: "human", department_id: "pedidos" },
    { id: "pagamento", label: "Pagamento", type: "human", department_id: "financeiro" },
  ],
  texts: {
    menu_greeting: "Olá! Como podemos ajudar? Escolha uma opção para falar com a equipe da loja.",
    instructions: "Informe o número do pedido ou o produto de interesse. Preço, disponibilidade e prazo de entrega são confirmados pela equipe. Não envie senhas nem dados completos de cartão.",
    protocol_confirmation: "Recebemos sua mensagem. Um atendente da loja dará continuidade.",
  },
  bot: {
    instructions: "Você atende uma loja. Ajude o cliente a encontrar o setor certo e encaminhe à equipe. Não consulte pedidos, estoque ou preços sem ferramenta autorizada e não invente disponibilidade, preço, prazo de entrega ou condição de pagamento. Não confirme pagamento por comprovante, não aprove troca, devolução, desconto ou reembolso e não prometa emissão de nota fiscal. Não peça senhas nem dados completos de cartão.",
    allowed_operations: [],
    denied_operations: [],
    suggested_roles: [],
  },
  manual_steps: [
    "Revisar na prévia Cadastros, Produtos e serviços, Vendas, Estoque, Financeiro e Caixa (PDV). O modelo apenas configura módulos; não concede papéis nem segundo fator de autenticação.",
    "Cadastrar produtos, preços, unidades, depósitos e saldo inicial de estoque; configurar formas de pagamento, contas e caixa do PDV antes de vender.",
    "Compras, Fiscal e Cobrança bancária são opções declaradas e desligadas na proposta padrão. Ligar Fiscal somente após configurar empresa, certificado, emissor, numeração e tributos; ligar não garante emissão automática de NFC-e nem capacidades fiscais ausentes.",
    "Os menus de WhatsApp encaminham à equipe: o ERP não oferece consulta automática de pedidos pelo atendimento. Consultar o pedido no ERP e responder ao cliente, sem expor dados de outros clientes.",
    "Associar pessoas aos setores Vendas, Pedidos e entregas e Financeiro e revisar seus acessos no ERP. Definir política de trocas, devoluções e prazos de entrega e publicá-la antes de ativar o atendimento.",
    "Conferir recebimentos no Financeiro; comprovante enviado pelo cliente não confirma pagamento. Revisar ferramentas do bot sem conceder papéis automaticamente.",
  ],
};
