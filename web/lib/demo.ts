// Modo de demonstração (/app?demo=1): telas de referência com dados
// fictícios, respondidas aqui mesmo. Nenhuma chamada sai do navegador e
// operações da OS2 são simuladas em memória; nenhuma escrita chega ao servidor.
import type { Api, Row } from "./api";
import { demoChannelRequest } from "./demo-channels";
import type { BaseStatus, CustomWorkType, ExtraValues, FieldFilteredOrderList, ObjectOpeningRequest, Order, OrderFieldFilter, OrderHistory, OrderList, OrderRequirements, Page, PrivateFields, ServiceObjectSnapshotView, ServiceObjectType, ServiceObjectView, WorkField, WorkTypeCatalog, WorkTypeView } from "../modules/os/work-contracts";
import { demoMe, demoProfile } from "./demo-entry";
export { demoMe, demoProfile } from "./demo-entry";
import * as erpDefinitions from "../../src/modules/erp/definition";
import { oficinaMecanicaTemplate } from "../../src/area-templates/models/oficina-mecanica";
import { agendaDemo, agendaDemoModule } from "../modules/agenda/demo";
import { reservaDemo, reservaDemoModule } from "../modules/reserva/demo";
import {
  pedidoDemo,
  pedidoDemoConfig,
  pedidoDemoModule,
} from "../modules/pedido/demo";
import {
  mesasDemo,
  mesasDemoConfig,
  mesasDemoModule,
} from "../modules/mesas/demo";

const M = 60_000,
  H = 60 * M;
const t = (ago: number) => Date.now() - ago;
const workshopType: CustomWorkType = {
  ...structuredClone(oficinaMecanicaTemplate.work_types[0]),
  id: "area_oficina_mecanica__at_veiculos",
  object_type_id: "demo_veiculo",
  revision: 2,
  fields: [...oficinaMecanicaTemplate.work_types[0].fields.filter(field => !["placa", "marca_modelo", "ano", "cor", "servico_executado"].includes(field.id)),
    { id: "servico_executado", label: "Serviço executado", help: "Descreva o que foi realizado antes de concluir.", kind: "text", multiline: true, max_length: 2000, required: false, sensitive: false, client_visible: true }],
  retired_field_ids: ["placa", "marca_modelo", "ano", "cor"],
  stage_field_rules: [{ field_id: "quilometragem", required_on_exit: ["recebido"] }, { field_id: "servico_executado", required_from_stage: "pronto" }],
  list_fields: [{ ref: { scope: "object", field_id: "placa" }, column: true, filter: true }, { ref: { scope: "order", field_id: "quilometragem" }, column: true, filter: true }],
};
const demoObjectTypes: ServiceObjectType[] = [{
  schema_version: 1, id: "demo_veiculo", revision: 2, archived: false,
  labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", retired_field_ids: [],
  fields: [
    { id: "placa", label: "Placa", help: "Identificação do veículo; não comprova propriedade.", kind: "text", multiline: false, max_length: 10, required: false, sensitive: false, client_visible: true },
    { id: "marca_modelo", label: "Marca e modelo", help: "", kind: "text", multiline: false, max_length: 240, required: false, sensitive: false, client_visible: true },
    { id: "ano", label: "Ano", help: "", kind: "integer", min: 1900, max: 2100, required: false, sensitive: false, client_visible: true },
    { id: "cor", label: "Cor", help: "", kind: "text", multiline: false, max_length: 80, required: false, sensitive: false, client_visible: true },
    { id: "tipo_combustivel", label: "Tipo de combustível", help: "", kind: "choice", options: [{ id: "flex", label: "Flex" }, { id: "diesel", label: "Diesel" }, { id: "eletrico", label: "Elétrico" }], required: false, sensitive: false, client_visible: true }],
}, {
  schema_version: 1, id: "demo_evento", revision: 1, archived: false,
  labels: { singular: "Evento", plural: "Eventos" }, identifier_field_id: "nome", retired_field_ids: [],
  fields: [
    { id: "nome", label: "Identificação administrativa", help: "Não precisa conter o nome de uma criança.", kind: "text", max_length: 120, multiline: false, required: true, sensitive: false, client_visible: true },
    { id: "data", label: "Data da festa", help: "Data declarada; não reserva agenda.", kind: "date", min: null, max: null, required: true, sensitive: false, client_visible: true },
    { id: "tema", label: "Tema", help: "", kind: "text", max_length: 120, multiline: false, required: false, sensitive: false, client_visible: true },
    { id: "local", label: "Local", help: "", kind: "text", max_length: 240, multiline: false, required: false, sensitive: false, client_visible: true },
  ],
}];
function demoServiceType(id: string, event: boolean): CustomWorkType {
  return {
    schema_version: 1, kind: "custom", id, revision: 1, archived: false,
    labels: { singular: event ? "Decoração de evento" : "Consultoria", plural: event ? "Decorações de eventos" : "Consultorias", item: event ? "Serviço contratado" : "Assunto", problem: "Solicitação", customer_singular: "Cliente", customer_plural: "Clientes" },
    number_prefix: event ? "FES-" : "CONSU-", terms: null,
    fields: [{ id: "escopo", label: "Escopo solicitado", help: "", kind: "text", multiline: true, max_length: 2000, required: false, sensitive: false, client_visible: true },
      ...(event ? ["objetos_extras", "decoracao_extra"].map((id, index) => ({ id, label: index ? "Decoração extra" : "Objetos extras", help: "Não reserva materiais.", kind: "text" as const, multiline: true, max_length: 2000, required: false, sensitive: false, client_visible: true })) : []),
      { id: "servico_executado", label: "Serviço executado", help: "", kind: "text", multiline: true, max_length: 2000, required: false, sensitive: false, client_visible: true }],
    retired_field_ids: [], retired_stage_ids: [], initial_stage: "solicitacao",
    stages: [{ id: "solicitacao", label: "Solicitação", base_status: "received", message: "" }, { id: "definicao", label: "Definição", base_status: "analyzing", message: "" }, { id: "execucao", label: "Execução", base_status: "in_progress", message: "" }, { id: "conclusao", label: "Conclusão", base_status: "delivered", message: "" }, { id: "cancelamento", label: "Cancelamento", base_status: "cancelled", message: "" }],
    transitions: [{ id: "definir", from: "solicitacao", to: "definicao", label: "Definir escopo", kind: "manual" }, { id: "executar", from: "definicao", to: "execucao", label: "Iniciar execução", kind: "manual" }, { id: "concluir", from: "execucao", to: "conclusao", label: "Concluir serviço", kind: "manual" },
      ...["solicitacao", "definicao", "execucao"].map(from => ({ id: "cancelar_" + from, from, to: "cancelamento", label: "Cancelar", kind: "manual" as const }))],
    features: { customer_open: true, tasks: true, people: false, documents: false, entries: false, quote: null, warranty_days: 0, pickup_reminder_days: 0, stale_days: 0 }, pickup_reminder_text: "",
    ...(event ? { object_type_id: "demo_evento", stage_field_rules: [{ field_id: "servico_executado", required_from_stage: "conclusao" }] } : {}),
  };
}
const eventType = demoServiceType("demo_festas_eventos", true);
const consultancyType = demoServiceType("demo_consultoria", false);

const settings: Row = {
  os_work_types: [workshopType, eventType, consultancyType],
  os_object_types: demoObjectTypes,
  os_vocabulary: { collection_label: "Ordens de serviço", customer_singular: "Cliente", customer_plural: "Clientes" },
  attendant_bot: "demo-bot",
  instructions: "Acolha o cliente e responda com clareza.",
  protocol_response_hours: 24,
  protocol_response_unit: "business_days",
  protocol_response_days: 3,
  business_hours: {
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
    holidays: [],
  },
  ticket_categories: [
    { id: "printher", name: "Printher", enabled: true },
    { id: "fagoo-erp", name: "ERP", enabled: true },
    { id: "outro", name: "Outro ou não sei", enabled: true },
  ],
  capabilities: [],
  menus: [],
  apps: [],
  pedido: pedidoDemoConfig,
  mesas: mesasDemoConfig,
  departments: [
    { id: "suporte", name: "Suporte", members: ["demo-user", "demo-ana"], enabled: true },
    { id: "financeiro", name: "Financeiro", members: ["demo-ana"], enabled: true },
  ],
  forms: [
    {
      id: "cadastro",
      name: "Cadastro de cliente",
      title: "Cadastro",
      intro: "Leva menos de um minuto.",
      fields: [
        { id: "nome", type: "text", label: "Nome completo", required: true },
        { id: "plano", type: "choice", label: "Plano", required: true, options: ["Mensal", "Anual"] },
        { id: "nascimento", type: "date", label: "Data de nascimento", required: true },
        { id: "termos", type: "accept", label: "Li e aceito os termos de uso", required: true },
      ],
      ticket: "attach",
      expires_hours: 24,
      enabled: true,
    },
  ],
};

const conversation = (row: Row): Row => ({
  profile_id: "demo",
  external_id: row.phone,
  chat_type: "direct",
  connection_id: "demo-line",
  owner: null,
  tags: "[]",
  department_id: null,
  assigned_bot_id: null,
  contact_name: null,
  created: t(3 * 24 * H),
  ...row,
});
const conversations: Row[] = [
  conversation({
    id: "demo-1",
    phone: "5511987650001",
    contact_name: "Mariana Albuquerque",
    state: "human",
    owner: "demo-user",
    tags: '["VIP","Financeiro"]',
    updated: t(4 * M),
    last_customer: t(46 * M),
    last_message: {
      text: "Perfeito, muito obrigada!",
      direction: "customer",
      created: t(4 * M),
      delivery_status: null,
      attachments: 0,
      kind: "text",
    },
  }),
  conversation({
    id: "demo-2",
    phone: "5521998760002",
    contact_name: "João Pedro Santos",
    state: "waiting",
    department_id: "suporte",
    updated: t(12 * M),
    last_customer: t(12 * M),
    last_message: {
      text: "Preciso falar com uma pessoa, por favor.",
      direction: "customer",
      created: t(12 * M),
      delivery_status: null,
      attachments: 0,
      kind: "text",
    },
  }),
  conversation({
    id: "demo-3",
    phone: "5531997000003",
    state: "ai",
    assigned_bot_id: "demo-bot",
    updated: t(35 * M),
    last_customer: t(19 * H),
    last_message: {
      text: "Posso ajudar com mais alguma coisa?",
      direction: "outbound",
      created: t(35 * M),
      delivery_status: "read",
      attachments: 0,
      kind: "text",
    },
  }),
  conversation({
    id: "demo-4",
    phone: "5541996000004",
    contact_name: "Lucas Ferreira",
    state: "human",
    owner: "demo-ana",
    tags: '["Fiscal"]',
    updated: t(2 * H),
    last_customer: t(23.4 * H),
    last_message: {
      text: "",
      direction: "customer",
      created: t(2 * H),
      delivery_status: null,
      attachments: 1,
      kind: "image",
    },
  }),
  conversation({
    id: "demo-5",
    phone: "5551995000005",
    contact_name: "Fernanda Rocha",
    state: "closed",
    updated: t(2 * 24 * H),
    last_customer: t(2 * 24 * H),
    last_message: {
      text: "Atendimento concluído. Obrigada pelo contato!",
      direction: "outbound",
      created: t(2 * 24 * H),
      delivery_status: "delivered",
      attachments: 0,
      kind: "text",
    },
  }),
];

const message = (row: Row): Row => ({
  conversation_id: "demo-1",
  author: "customer",
  attachments: "[]",
  content: "{}",
  external_id: "wamid." + row.id,
  delivery_status: null,
  ...row,
});
const messages: Row[] = [
  message({
    id: "m1",
    direction: "customer",
    text: "Olá! Preciso de ajuda com a segunda via do boleto.",
    created: t(26 * H),
  }),
  message({
    id: "m2",
    direction: "outbound",
    author: "bot:demo-bot",
    text: "Claro! Vou encaminhar sua solicitação para nossa equipe.",
    created: t(26 * H - M),
    delivery_status: "read",
  }),
  message({
    id: "m3",
    direction: "note",
    author: "demo-user",
    text: "Cliente VIP. Conferir desconto de pontualidade.",
    created: t(50 * M),
    external_id: null,
  }),
  message({
    id: "m4",
    direction: "customer",
    text: "Consegue me enviar hoje?",
    created: t(46 * M),
  }),
  message({
    id: "m5",
    direction: "outbound",
    author: "demo-user",
    text: "Consigo sim. Segue o boleto atualizado, com vencimento para sexta.",
    content: JSON.stringify({ reply_to: "m4", reply_text: "Consegue me enviar hoje?" }),
    created: t(20 * M),
    delivery_status: "delivered",
  }),
  message({
    id: "m6",
    direction: "customer",
    text: "Perfeito, muito obrigada!",
    content: JSON.stringify({ reactions: { "demo-user": { emoji: "🙏" } } }),
    created: t(4 * M),
  }),
];

const team: Row[] = [
  { id: "demo-user", kind: "user", name: "Administrador", online: true },
  { id: "demo-ana", kind: "user", name: "Ana Beatriz", online: true },
  { id: "demo-bruno", kind: "user", name: "Bruno Carvalho", online: false },
  {
    id: "bot:demo-bot",
    kind: "bot",
    name: "Atendente",
    online: true,
    enabled: true,
    bot_id: "demo-bot",
    line_ids: null,
    connection_kind: "ai",
    does: "Bot interno: consulta o Wabotia e propõe ações com o acesso de quem pede.",
  },
  {
    id: "bot:demo-ia",
    kind: "bot",
    name: "Bia (IA)",
    online: false,
    enabled: false,
    bot_id: "demo-ia",
    line_ids: [],
    connection_kind: "ai",
    connection_status: "active",
    does: "Consulta o Wabotia e propõe ações em seu nome, com o seu acesso; nada muda antes de você tocar em Confirmar.",
  },
];
const tickets: Row[] = [
  {
    id: "ticket-1",
    number: "WA-EXEMPLO-1",
    title: "Dúvida sobre pedido",
    status: "open",
    category: "printher",
    owner: null,
    conversation_id: "demo-2",
    created: t(5 * H),
    updated: t(5 * H),
    response_due_at: Date.now() + 40 * M,
    first_response_at: null,
  },
  {
    id: "ticket-2",
    number: "WA-EXEMPLO-2",
    title: "Nota fiscal não foi emitida",
    status: "in_progress",
    category: "fagoo-erp",
    owner: "demo-user",
    conversation_id: "demo-1",
    created: t(30 * H),
    updated: t(2 * H),
    response_due_at: t(-20 * H),
    first_response_at: t(28 * H),
  },
  {
    id: "ticket-3",
    number: "WA-EXEMPLO-3",
    title: "Liberação de compra",
    status: "waiting_customer",
    category: null,
    owner: "demo-ana",
    conversation_id: "demo-4",
    created: t(50 * H),
    updated: t(20 * H),
    response_due_at: t(3 * H),
    first_response_at: null,
  },
  {
    id: "ticket-4",
    number: "WA-EXEMPLO-4",
    title: "Troca de titularidade",
    status: "resolved",
    category: "outro",
    owner: "demo-user",
    conversation_id: "demo-5",
    created: t(4 * 24 * H),
    updated: t(2 * 24 * H),
    response_due_at: t(3 * 24 * H),
    first_response_at: t(3.5 * 24 * H),
  },
];
const ticketUpdates: Row[] = [
  {
    id: "u1",
    ticket_id: "ticket-2",
    actor: "demo-user",
    text: "Recebemos sua solicitação e estamos conferindo a emissão.",
    internal: 0,
    created: t(28 * H),
  },
  {
    id: "u2",
    ticket_id: "ticket-2",
    actor: "demo-ana",
    text: "Aguardando retorno da contabilidade.",
    internal: 1,
    created: t(2 * H),
  },
];
const internalMessages: Row[] = [
  {
    id: "i1",
    author: "demo-ana",
    text: "Esta conversa acontece dentro do Wabotia. As mensagens não são enviadas ao cliente no WhatsApp.",
    created: t(30 * M),
    status: null,
  },
  {
    id: "i2",
    author: "demo-user",
    text: "Combinado. Assumo a Mariana agora.",
    created: t(28 * M),
    status: null,
  },
];
// Conversa interna com o bot: ele consulta e propõe; a pessoa confirma
// (src/bot-actions, mensagens kind "proposal" e "result").
const botChatMessages: Row[] = [
  {
    id: "b1",
    author: "demo-user",
    kind: "text",
    text: "Abre uma OS para o notebook da Mariana, que não liga.",
    created: t(6 * M),
    status: "completed",
  },
  {
    id: "proposal:demo",
    author: "bot:demo-bot",
    kind: "proposal",
    text: "Proposta do bot: Abrir OS do notebook da Mariana que não liga",
    payload: {
      operation_summary: "Abrir ordem de serviço",
      module: "os",
      actions: ["confirm", "cancel"],
      proposal: {
        id: "demo",
        status: "pending",
        operation: "os.create",
        summary: "Abrir OS do notebook da Mariana que não liga",
        params: { item: "Notebook", problem: "Não liga", customer_name: "Mariana Costa" },
        sensitive: false,
        expires_at: t(-6 * M),
      },
    },
    created: t(5 * M),
    status: "sent",
  },
  {
    id: "b2",
    author: "bot:demo-bot",
    kind: "text",
    text: "Preparei a abertura da OS. Toque em Confirmar para eu abrir em seu nome.",
    created: t(5 * M),
    status: null,
  },
  {
    id: "approval:demo",
    author: "bot:demo-bot",
    kind: "approval",
    text: "Pedido de aprovação: Desconto de 10% para Mariana Costa.",
    payload: {
      approval: {
        id: "demo-approval",
        module_id: "pedido",
        kind: "desconto",
        conversation_id: "demo-1",
        title: "Desconto de 10% no pedido nº 128 de Mariana Costa",
        status: "pending",
        fields: [
          { key: "itens", label: "Itens", value: "2× X-Burger, 1× Suco" },
          { key: "total", label: "Total de tabela", value: "R$ 62,00" },
          { key: "pedido", label: "Cliente pediu", value: "10% (R$ 6,20)" },
          { key: "ultimas", label: "Últimas compras", value: "5 pedidos em 30 dias, média R$ 58,00" },
        ],
        hidden_fields: 1,
        model_summary: "Cliente frequente; diz que o concorrente cobra menos.",
        adjust: { label: "Desconto concedido (R$)", type: "money", min: 0, max: 6.2 },
        can_decide: true,
        value: null,
        reason: null,
        decided_by: null,
        decided_at: null,
        expires_at: t(-25 * M),
        created: t(2 * M),
      },
    },
    created: t(2 * M),
    status: "sent",
  },
];
const menus: Row[] = [
  { id: "menu-sales", label: "Informações da loja", type: "submenu", enabled: true, line_ids: [], trigger: "automatic" },
  { id: "menu-person", label: "Conversar com uma pessoa", type: "human", parent_id: "menu-sales", enabled: true, line_ids: [], trigger: "automatic" },
];

const page = (data: Row[]) => ({ data, next_cursor: null });

// Gestão → Módulos (src/modules: a mesma declaração do servidor, resumida).
const demoModules: Row[] = [
  ...Object.values(erpDefinitions).map(({ id, name, description, requires, navigation, version }) => ({
    id, name, description, requires, navigation, version,
    builtin: true, default_enabled: false, menu_item_types: [],
    enabled: !["erp-fiscal", "erp-cobranca"].includes(id),
  })),
  {
    id: "queue",
    name: "Fila presencial",
    version: "1.0.0",
    description:
      "Senhas com guichês, painel de TV, totem Senhapp e entrada na fila pelo WhatsApp.",
    builtin: true,
    enabled: true,
    default_enabled: true,
    navigation: [
      { id: "queue", label: "Fila", place: "rail", admin: false },
      { id: "queue-settings", label: "Filas e guichês", place: "admin", admin: true },
    ],
    menu_item_types: [{ type: "queue", label: "Entrar na fila de espera" }],
  },
  {
    id: "forms",
    name: "Formulários",
    version: "1.0.0",
    description:
      "Formulários do administrador (texto, escolha, data, aceite) respondidos numa página leve aberta pelo WhatsApp; as respostas vão para o contato e o protocolo.",
    builtin: true,
    enabled: true,
    default_enabled: true,
    navigation: [{ id: "forms", label: "Formulários", place: "admin", admin: true }],
    menu_item_types: [{ type: "form", label: "Responder formulário" }],
  },
  agendaDemoModule,
  {
    id: "payments",
    name: "Cobrança",
    version: "1.0.0",
    description:
      "Pix e link de pagamento pelo Mercado Pago, enviados na conversa e confirmados pelo webhook do provedor.",
    builtin: true,
    enabled: true,
    default_enabled: true,
    navigation: [{ id: "payments", label: "Cobrança", place: "admin", admin: true }],
    menu_item_types: [],
  },
  {
    id: "os",
    name: "Ordem de Serviço",
    version: "1.0.0",
    description:
      "Ordens de serviço numeradas com orçamento, aprovação pelo WhatsApp, acompanhamento pelo cliente e retirada.",
    builtin: true,
    enabled: true,
    default_enabled: false,
    navigation: [
      { id: "work", label: "Ordens de serviço", place: "admin", admin: false },
      { id: "work-types", label: "Configurar", place: "admin", admin: true },
    ],
    menu_item_types: [
      { type: "os_open", label: "Abrir ordem de serviço" },
      { type: "os_track", label: "Acompanhar ordem de serviço" },
    ],
  },
  reservaDemoModule,
  pedidoDemoModule,
  mesasDemoModule,
  {
    id: "mensalidade",
    name: "Mensalidade",
    version: "1.0.0",
    description:
      "Planos, assinaturas e parcelas com cobrança por Pix ou link antes do vencimento, avisos de atraso e comprovante pelo WhatsApp.",
    builtin: true,
    enabled: true,
    default_enabled: false,
    navigation: [
      { id: "mensalidades", label: "Mensalidades", place: "admin", admin: false },
      { id: "mensalidade-settings", label: "Planos e regras", place: "admin", admin: true },
    ],
    menu_item_types: [
      { type: "mensalidade_list", label: "Minhas mensalidades" },
      { type: "mensalidade_copy", label: "Segunda via" },
    ],
  },
  {
    id: "suporte",
    name: "Suporte pago",
    version: "1.0.0",
    description:
      "Atendimento humano liberado para quem paga: identifica pelo telefone ou CPF/CNPJ, confere a mensalidade e vende suporte avulso ou plano mensal por Pix ou link.",
    builtin: true,
    enabled: true,
    default_enabled: false,
    navigation: [
      { id: "suporte", label: "Suporte pago", place: "admin", admin: false },
      { id: "suporte-settings", label: "Regras do suporte", place: "admin", admin: true },
    ],
    menu_item_types: [{ type: "suporte_humano", label: "Atendimento humano (pago)" }],
  },
];

// Suporte pago (módulo "suporte"): empresa de suporte técnico de TI, nos
// formatos de GET /suporte/releases, /purchases, /offers e /conversations/{id}.
const spPackages: Row[] = [
  { id: "avulso", name: "Chamado avulso", price_cents: 8900, mode: "ticket", active: true, validity: "até o fim deste atendimento" },
  { id: "dia", name: "Suporte 24 horas", price_cents: 14900, mode: "hours", hours: 24, active: true, validity: "24 horas de atendimento" },
];
const spRelease = (
  n: number,
  kind: string,
  phone: string,
  payer: string,
  age: number,
  extra: Row = {},
): Row => ({
  id: "rel-" + n,
  conversation_id: n === 1 ? "demo-1" : "demo-" + (n + 1),
  phone,
  payer_id: payer ? "payer-" + n : null,
  payer_name: payer,
  kind,
  kind_label: ({ subscription: "Assinatura em dia", installment: "Mensalidade paga", package: "Suporte avulso", courtesy: "Cortesia", team: "Confirmado pela equipe" } as Row)[kind],
  ref_id: null,
  phone_linked: true,
  valid_until: null,
  until_ticket: true,
  ticket_id: "ticket-demo-" + n,
  expires_at: t(age) + 7 * 24 * H,
  reason: "",
  summary: "",
  actor: kind === "courtesy" ? "demo-user" : kind === "subscription" ? "system" : "provider",
  status: "active",
  ended_at: null,
  ended_by: null,
  created: t(age),
  ...extra,
});
const spReleases: Row[] = [
  spRelease(1, "subscription", "5511988001001", "Contabilidade Silva Ltda", 40 * M),
  spRelease(2, "package", "5511988001002", "Padaria Pão Quente", 2 * H, { valid_until: t(2 * H - 24 * H), until_ticket: false }),
  spRelease(3, "subscription", "5511988001003", "Clínica Sorriso", 5 * H, { phone_linked: false }),
  spRelease(4, "installment", "5511988001004", "Escritório Moura", 26 * H),
  spRelease(5, "courtesy", "5511988001005", "", 3 * 24 * H, { reason: "Falha no nosso servidor de backup", until_ticket: false, valid_until: t(3 * 24 * H - 4 * H), status: "ended" }),
];
const spPurchases: Row[] = [
  { id: "buy-1", conversation_id: "demo-3", payer_id: "payer-2", document: "11222333000181", name: "Padaria Pão Quente", phone: "5511988001002", package_id: "dia", package_name: "Suporte 24 horas", price_cents: 14900, mode: "hours", hours: 24, validity: "24 horas de atendimento", method: "pix", payment: null, status: "paid", status_label: "Paga", paid_at: t(2 * H), created: t(2 * H + 6 * M), updated: t(2 * H) },
  { id: "buy-2", conversation_id: "demo-7", payer_id: null, document: "52998224725", name: "João Pereira", phone: "5511988001007", package_id: "avulso", package_name: "Chamado avulso", price_cents: 8900, mode: "ticket", hours: null, validity: "até o fim deste atendimento", method: "link", payment: null, status: "pending", status_label: "Aguardando pagamento", paid_at: null, created: t(12 * M), updated: t(12 * M) },
  { id: "buy-3", conversation_id: "demo-8", payer_id: null, document: "11144477735", name: "Ana Prado", phone: "5511988001008", package_id: "avulso", package_name: "Chamado avulso", price_cents: 8900, mode: "ticket", hours: null, validity: "até o fim deste atendimento", method: "pix", payment: null, status: "expired", status_label: "Expirada", paid_at: null, created: t(30 * H), updated: t(6 * H) },
];

// Fila de senhas (módulo "queue"): os formatos de GET /queue e
// /queue/tickets (docs/FILA-SENHAS.md). Sem eles, Fila e Filas e guichês
// não abriam na demonstração.
const qTicket = (code: string, queue: Row, status: string, age: number, extra: Row = {}): Row => ({
  id: "qt-" + code, queue_id: queue.id, queue_name: queue.name, code, preferential: code.startsWith("P"), source: "kiosk", status,
  counter_id: null, counter_name: null, target_counter_id: null, call_count: 0, ahead: 0, wait_minutes: null, phone: null,
  conversation_id: null, window_open: false, created_at: t(age), called_at: null, started_at: null, finished_at: null, ...extra,
});
const qGeral: Row = { id: "q-geral", name: "Atendimento geral", prefix_normal: "N", prefix_preferential: "P", normals_per_preferential: 2, priority: 0, wait_mode: "average", service_minutes: 8, channels: ["whatsapp", "kiosk"], enabled: true, preferential_notice: "Idosos (60+), gestantes, lactantes e pessoas com deficiência." };
const qCaixa: Row = { id: "q-caixa", name: "Caixa", prefix_normal: "C", prefix_preferential: "D", normals_per_preferential: 3, priority: 1, wait_mode: "fixed", service_minutes: 5, channels: ["kiosk"], enabled: true, preferential_notice: "" };
const qServing = qTicket("N021", qGeral, "serving", 18 * M, { counter_id: "counter-1", counter_name: "Guichê 1", call_count: 1, called_at: t(6 * M), started_at: t(5 * M) });
const qTickets: Row[] = [
  qServing,
  qTicket("P007", qGeral, "waiting", 9 * M, { ahead: 0, wait_minutes: 4 }),
  qTicket("N022", qGeral, "waiting", 14 * M, { ahead: 1, wait_minutes: 12, source: "whatsapp", phone: "5511988776655", window_open: true }),
  qTicket("N023", qGeral, "waiting", 7 * M, { ahead: 2, wait_minutes: 20, source: "staff" }),
  qTicket("C014", qCaixa, "waiting", 3 * M, { ahead: 0, wait_minutes: 5 }),
  qTicket("N020", qGeral, "done", 40 * M, { counter_id: "counter-1", counter_name: "Guichê 1", call_count: 1, finished_at: t(19 * M) }),
  qTicket("C013", qCaixa, "done", 35 * M, { counter_id: "counter-2", counter_name: "Guichê 2", call_count: 2, finished_at: t(25 * M) }),
];
const queueOverview = () => ({
  day: new Date().toISOString().slice(0, 10),
  settings: { front_door: true, notify_ahead: 2 },
  queues: [
    { ...qGeral, waiting: { normal: 2, preferential: 1 }, wait_minutes: { normal: 20, preferential: 4 }, open_counters: 1 },
    { ...qCaixa, waiting: { normal: 1, preferential: 0 }, wait_minutes: { normal: 5, preferential: 5 }, open_counters: 0 },
  ],
  counters: [
    { id: "counter-1", name: "Guichê 1", queue_ids: ["q-geral"], status: "open", user_id: "demo-user", user_name: "Administrador", current: qServing },
    { id: "counter-2", name: "Guichê 2", queue_ids: ["q-geral", "q-caixa"], status: "paused", user_id: "demo-ana", user_name: "Ana", current: null },
  ],
  recent_calls: [],
});

// Ordem de Serviço (módulo "os"): o mesmo formato de GET /service-orders.
const osLabels: Record<BaseStatus, string> = {
  received: "Recebida",
  analyzing: "Em análise",
  quoted: "Orçamento enviado",
  approved: "Aprovada",
  declined: "Recusada",
  in_progress: "Em execução",
  ready: "Pronta",
  delivered: "Entregue",
  cancelled: "Cancelada",
};
const osNext: Record<BaseStatus, BaseStatus[]> = {
  received: ["analyzing", "in_progress", "cancelled"],
  analyzing: ["in_progress", "cancelled", "quoted"],
  quoted: ["analyzing", "cancelled", "quoted", "approved", "declined"],
  approved: ["in_progress", "cancelled"],
  declined: ["analyzing", "ready", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready: ["delivered", "in_progress", "cancelled"],
  delivered: [],
  cancelled: [],
};
// A OS embutida usa o contrato atual, inclusive as transições manuais
// separadas das ações de orçamento. Coleções opcionais ficam vazias nela.
const osType: WorkTypeView = {
  schema_version: 1, kind: "builtin", id: "service_order", revision: 1, archived: false,
  labels: { singular: "Ordem de serviço", plural: "Ordens de serviço", item: "Item", problem: "Problema", customer_singular: "Cliente", customer_plural: "Clientes" },
  number_prefix: "", terms: "Autorizo a análise do item informado.",
  fields: [], retired_field_ids: [], retired_stage_ids: [], initial_stage: "received",
  stages: (Object.keys(osLabels) as BaseStatus[]).map(id => ({ id, label: osLabels[id], base_status: id, message: "" })),
  transitions: (Object.keys(osNext) as BaseStatus[]).flatMap(from =>
    (from === "analyzing" || from === "quoted" ? osNext[from].filter(to => !["quoted", "approved", "declined"].includes(to)) : osNext[from])
      .map(to => ({ id: `${from}_${to}`, from, to, label: osLabels[to], kind: "manual" as const }))),
  features: {
    customer_open: true, tasks: false, people: false, documents: false, entries: false,
    quote: { default_valid_days: 7, source_stages: ["received", "analyzing", "quoted", "declined"], sent_stage: "quoted", approved_stage: "approved", declined_stage: "declined", edited_stage: "analyzing" },
    warranty_days: 90, pickup_reminder_days: 3, stale_days: 7,
  },
  pickup_reminder_text: "Seu item está pronto para retirada.",
};
const osOrder = (
  number: number,
  status: BaseStatus,
  name: string,
  phone: string,
  item: string,
  problem: string,
  age: number,
  quote: [string, number][] | null = null,
): Order => ({
  id: "os-" + number,
  number,
  status,
  status_label: osLabels[status],
  type_id: osType.id, type_revision: osType.revision, type_number: number,
  type_label: osType.labels.singular, type_plural_label: osType.labels.plural,
  display_number: String(number), stage: status, stage_label: osLabels[status],
  labels: { ...osType.labels }, fields: [], extra: {}, version: 1,
  features: structuredClone(osType.features), next_task: null, stage_approval: null,
  next_stages: osType.transitions.filter(transition => transition.from === status).map(transition => ({
    transition_id: transition.id, stage: transition.to, stage_label: transition.label,
    base_status: transition.to as BaseStatus, kind: transition.kind,
  })),
  customer: { name, phone, contact_id: null, conversation_id: number === 14 ? "demo-1" : null },
  item,
  problem,
  notes: number === 14 ? "Deixou a capinha. Senha anotada na etiqueta." : "",
  assignee: "demo-user",
  due_at: t(-2 * 24 * H),
  source: number === 14 ? "customer" : "panel",
  terms: number === 14 ? { text: "Autorizo a análise do item informado.", accepted_at: t(age) } : null,
  quote: quote
    ? {
        items: quote.map(([description, unit_cents]) => ({ description, quantity: 1, unit_cents })),
        total_cents: quote.reduce((sum, [, value]) => sum + value, 0),
        note: "",
        valid_days: 7,
        valid_until: t(-5 * 24 * H),
        sent_at: status === "analyzing" ? null : t(age - H),
        version: status === "analyzing" ? 0 : 1,
        expired: false,
      }
    : null,
  decision: ["approved", "in_progress", "ready", "delivered"].includes(status) && quote
    ? { decision: "approved", at: t(age - 2 * H), by: "customer:" + phone, via: "whatsapp" }
    : null,
  ready_at: ["ready", "delivered"].includes(status) ? t(3 * H) : null,
  delivered_at: status === "delivered" ? t(H) : null,
  warranty_until: status === "delivered" ? t(-90 * 24 * H) : null,
  next_statuses: osNext[status],
  created_by: "demo-user",
  created: t(age),
  updated: t(Math.min(age, 3 * H)),
});
function workshopOrder(number: number, stageId: string, name: string, item: string): Order {
  const stage = workshopType.stages.find(entry => entry.id === stageId)!;
  const base = osOrder(number, stage.base_status, name, "5511987650010", item, "Revisão preventiva e verificação dos freios.", 3 * 24 * H, [["Revisão", 25000]]);
  return {
    ...base, type_id: workshopType.id, type_revision: workshopType.revision, type_number: number - 15,
    type_label: workshopType.labels.singular, type_plural_label: workshopType.labels.plural,
    display_number: workshopType.number_prefix + (number - 15), labels: workshopType.labels,
    fields: workshopType.fields, features: workshopType.features, stage: stage.id, stage_label: stage.label,
    extra: { placa: "ABC1D23", marca_modelo: item, ano: 2021, cor: "Prata", ultima_manutencao: "2026-05-15", quilometragem: 42500, combustivel: "metade" },
    notes: "", due_at: number === 17 ? t(24 * H) : t(-2 * 24 * H),
    next_stages: workshopType.transitions.filter(transition => transition.from === stage.id).map(transition => {
      const target = workshopType.stages.find(entry => entry.id === transition.to)!;
      return { transition_id: transition.id, stage: target.id, stage_label: target.label, base_status: target.base_status, kind: transition.kind };
    }),
  };
}
const osOrders: Order[] = [
  workshopOrder(17, "execucao", "Fernanda Alves", "Fiat Argo 1.0"),
  workshopOrder(16, "recebido", "Pedro Santos", "Volkswagen Polo"),
  osOrder(15, "received", "Carla Mendes", "5511987650001", "Notebook Lenovo IdeaPad", "Não liga depois de uma queda.", 2 * H),
  osOrder(14, "quoted", "Mariana Costa", "5511987650002", "Celular Moto G84", "Tela trincada e touch falhando no canto.", 26 * H, [["Troca de tela", 38000], ["Película", 2500]]),
  osOrder(13, "in_progress", "Rafael Lima", "5511987650003", "Bicicleta aro 29", "Freio traseiro sem pressão.", 3 * 24 * H, [["Sangria do freio", 9000], ["Pastilhas", 6500]]),
  osOrder(12, "ready", "Patrícia Souza", "5511987650004", "Terno azul-marinho", "Ajustar barra e cintura.", 4 * 24 * H, [["Ajuste de barra", 4000], ["Ajuste de cintura", 5000]]),
  osOrder(11, "delivered", "João Pereira", "5511987650005", "Máquina de lavar Brastemp", "Vazamento na lateral.", 9 * 24 * H, [["Mangueira", 4500], ["Mão de obra", 12000]]),
];
const osHistory = (order: Order): OrderHistory[] => [
  { id: order.id + "-h1", kind: "opened", from_status: null, to_status: "received", from_stage: null, to_stage: "received", actor: order.source === "customer" ? "customer" : "demo-user", note: "", created: order.created },
  ...(order.status !== "received"
    ? [{ id: order.id + "-h2", kind: "status", from_status: "received" as const, to_status: order.status, from_stage: "received", to_stage: order.stage, actor: "demo-user", note: "", created: order.updated }]
    : []),
];

function workNotFound(): never {
  throw Object.assign(new Error("Trabalho ou recurso não encontrado na demonstração."), { status: 404, code: "demo_not_found" });
}
function workPage<T>(rows: T[], query: URLSearchParams): Page<T> {
  const start = Math.max(0, Number(query.get("cursor")) || 0);
  const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 50));
  return { data: rows.slice(start, start + limit), next_cursor: start + limit < rows.length ? String(start + limit) : null };
}
function workDemo(rest: string, query: URLSearchParams) {
  // Rotas reservadas sempre precedem o identificador do trabalho.
  if (rest === "service-orders/types") return { data: [osType, workshopType], settings_revision: "demo" } satisfies WorkTypeCatalog;
  if (rest.startsWith("service-orders/types/")) {
    return [osType, workshopType].find(type => rest === "service-orders/types/" + type.id) || workNotFound();
  }
  if (rest === "service-orders/my-tasks") return workPage([], query);
  if (rest === "service-orders") {
    const statuses = (query.get("status") || "").split(",").filter(Boolean);
    const stages = (query.get("stage") || "").split(",").filter(Boolean);
    const q = (query.get("q") || "").toLocaleLowerCase("pt-BR"), assignee = query.get("assignee");
    const base = osOrders.filter(order =>
      (!query.get("type_id") || query.get("type_id") === order.type_id) &&
      (!query.get("type_ids") || query.get("type_ids")!.split(",").includes(order.type_id)) &&
      (!query.get("conversation_id") || query.get("conversation_id") === order.customer.conversation_id) &&
      (!query.get("phone") || query.get("phone") === order.customer.phone) &&
      (!assignee || (assignee === "unassigned" ? !order.assignee : order.assignee === (assignee === "me" ? demoMe.id : assignee))) &&
      (!query.get("due_from") || order.due_at !== null && order.due_at >= Number(query.get("due_from"))) &&
      (!query.get("due_to") || order.due_at !== null && order.due_at <= Number(query.get("due_to"))) &&
      (!q || `${order.display_number} ${order.item} ${order.customer.name} ${order.customer.phone}`.toLocaleLowerCase("pt-BR").includes(q)));
    const counts: OrderList["counts"] = {}, types: Record<string, number> = {}, stageCounts: Record<string, number> = {};
    for (const order of osOrders)
      counts[order.status] = (counts[order.status] || 0) + 1;
    for (const order of base) {
      types[order.type_id] = (types[order.type_id] || 0) + 1;
      stageCounts[order.stage] = (stageCounts[order.stage] || 0) + 1;
    }
    return {
      ...workPage(base.filter(order => (!statuses.length || statuses.includes(order.status)) &&
        (!stages.length || stages.includes(order.stage)) &&
        (query.get("open") !== "1" || !["delivered", "cancelled"].includes(order.status))), query),
      counts, ...(query.get("facets") === "1" ? { facets: { types, stages: stageCounts } } : {}),
    } satisfies OrderList;
  }
  const match = rest.match(/^service-orders\/([^/]+)(?:\/([^/]+))?$/);
  const order = match && osOrders.find(item => item.id === match[1]);
  if (!order) return workNotFound();
  const collection = match![2];
  if (!collection) return { ...order, ...(query.get("history") === "none" ? {} : { history: osHistory(order) }) } satisfies Order;
  if (collection === "history") return workPage(osHistory(order), query);
  if (collection === "private-fields") return { id: order.id, version: order.version, fields: [], extra: {} } satisfies PrivateFields;
  if (["tasks", "private-tasks", "people", "documents", "private-documents", "entries"].includes(collection)) return workPage([], query);
  return workNotFound();
}

/** Cenário operacional isolado: somente dados fictícios, perdidos ao recarregar. */
export function createOs2DemoApi(): Api {
  const types: WorkTypeView[] = structuredClone([osType, workshopType, eventType, consultancyType]);
  const objectTypes = structuredClone(demoObjectTypes);
  const contacts = [
    { id: "contact-demo-1", name: "Fernanda Alves", phone: "5511987650010", namespace: "team", active: true, version: 1 },
    { id: "contact-demo-2", name: "Pedro Santos", phone: "5511987650011", namespace: "team", active: true, version: 1 },
  ];
  const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }); };
  const notFound = (): never => fail("demo_not_found", "Registro não encontrado nesta área ou para este cliente.", 404);
  const contact = (id: unknown) => contacts.find(row => row.id === id) || notFound();
  const objectType = (id: string) => objectTypes.find(row => row.id === id) || notFound();
  const type = (id: string) => types.find(row => row.id === id) || notFound();
  const objects: ServiceObjectView[] = [{
    id: "demo-vehicle-1", contact_id: contacts[0].id, type_id: "demo_veiculo", type_revision: 1,
    type: { ...structuredClone(objectType("demo_veiculo")), revision: 1 },
    values: { placa: "ABC1D23", marca_modelo: "Fiat Argo 1.0", ano: 2021, cor: "Azul", tipo_combustivel: "flex" },
    archived: false, version: 2, identifier: "ABC1D23", created: t(120 * 24 * H), updated: t(H),
  }, {
    id: "demo-vehicle-archived", contact_id: contacts[0].id, type_id: "demo_veiculo", type_revision: 2,
    type: structuredClone(objectType("demo_veiculo")), values: { placa: "XYZ9A87", marca_modelo: "Veículo anterior", cor: "Branco" },
    archived: true, version: 2, identifier: "XYZ9A87", created: t(200 * 24 * H), updated: t(90 * 24 * H),
  }, {
    id: "demo-event-1", contact_id: contacts[1].id, type_id: "demo_evento", type_revision: 1,
    type: structuredClone(objectType("demo_evento")), values: { nome: "Festa de primavera", data: "2026-12-12", tema: "Jardim", local: "Salão Primavera" },
    archived: false, version: 1, identifier: "Festa de primavera", created: t(5 * 24 * H), updated: t(5 * 24 * H),
  }];
  const snapshot = (row: ServiceObjectView, origin: ServiceObjectSnapshotView["origin"] = "opening"): ServiceObjectSnapshotView => ({
    schema_version: 1, object_id: row.id, object_version: row.version, captured_at: Date.now(), origin,
    type: structuredClone(row.type), values: structuredClone(row.values), identifier: row.identifier,
  });
  const setStage = (order: Order, stageId: string) => {
    const current = type(order.type_id), stage = current.stages.find(row => row.id === stageId) || notFound();
    order.stage = stage.id; order.stage_label = stage.label; order.status = stage.base_status; order.status_label = osLabels[stage.base_status];
    order.next_stages = current.transitions.filter(row => row.from === stage.id).map(row => {
      const target = current.stages.find(stage => stage.id === row.to)!;
      return { transition_id: row.id, stage: target.id, stage_label: target.label, base_status: target.base_status, kind: row.kind };
    });
    order.next_statuses = order.next_stages.map(row => row.base_status);
  };
  const custom = (number: number, model: WorkTypeView, owner = contacts[0]): Order => {
    const result: Order = { ...osOrder(number, "received", owner.name, owner.phone, model.labels.item, "Atendimento demonstrativo", 3 * 24 * H),
      type_id: model.id, type_revision: model.revision, type_number: number, type_label: model.labels.singular,
      type_plural_label: model.labels.plural, display_number: model.number_prefix + number, labels: structuredClone(model.labels),
      fields: structuredClone(model.fields), features: structuredClone(model.features), extra: {},
      customer: { name: owner.name, phone: owner.phone, contact_id: owner.id, conversation_id: owner.id === contacts[0].id ? "demo-1" : "demo-2" } };
    setStage(result, model.initial_stage);
    return result;
  };
  const visit = custom(17, workshopType); setStage(visit, "execucao");
  visit.item = "Fiat Argo 1.0"; visit.extra = { quilometragem: 65000, combustivel: "metade", ultima_manutencao: "2026-05-15" };
  visit.object = { ...snapshot(objects[0]), object_version: 1, captured_at: visit.created, values: { ...objects[0].values, cor: "Prata" } };
  const previous = custom(18, workshopType); setStage(previous, "entregue");
  previous.created = t(60 * 24 * H); previous.delivered_at = t(58 * 24 * H); previous.updated = previous.delivered_at;
  previous.item = "Fiat Argo 1.0"; previous.extra = { quilometragem: 60000, combustivel: "um_quarto", servico_executado: "Troca de óleo e filtros." };
  previous.object = { ...snapshot(objects[0]), object_version: 1, captured_at: previous.created, values: { ...objects[0].values, cor: "Prata" } };
  const decoration = custom(19, eventType, contacts[1]); setStage(decoration, "execucao");
  decoration.item = "Decoração do salão"; decoration.extra = { escopo: "Mesa principal e painel floral.", objetos_extras: "Dois vasos", decoracao_extra: "Iluminação do painel" }; decoration.object = snapshot(objects[2]);
  const consultancy = custom(20, consultancyType); consultancy.extra = { escopo: "Revisão dos processos de atendimento." };
  const legacy = workshopOrder(16, "recebido", contacts[0].name, "Fiat Argo 1.0");
  legacy.type_revision = 1; legacy.fields = structuredClone([...workshopType.fields.filter(field => field.id !== "servico_executado"), ...demoObjectTypes[0].fields.filter(field => field.id !== "tipo_combustivel")]);
  legacy.customer.contact_id = contacts[0].id;
  const orders = [consultancy, decoration, visit, previous, legacy, ...structuredClone(osOrders.filter(row => row.type_id === osType.id))];
  const activeRequirements = new Map<string, Set<string>>();
  const receipts = new Map<string, { payload: string; result: unknown }>();
  const privateValues = new Map<string, ExtraValues>();
  const history = new Map(orders.map(row => [row.id, osHistory(row)]));
  const object = (id: string) => objects.find(row => row.id === id) || notFound();
  const order = (id: string) => orders.find(row => row.id === id) || notFound();
  const latestObject = (row: ServiceObjectView): ServiceObjectView => {
    const completed = orders.filter(entry => entry.object?.object_id === row.id && entry.status === "delivered")
      .sort((a, b) => (b.delivered_at ?? -Infinity) - (a.delivered_at ?? -Infinity) || b.number - a.number || b.id.localeCompare(a.id))[0];
    return { ...row, latest_completed: completed ? { id: completed.id, number: completed.number, delivered_at: completed.delivered_at } : null };
  };
  const publicFields = (fields: WorkField[], values: ExtraValues) => {
    const visible = fields.filter(field => field.client_visible && !field.sensitive);
    return { fields: visible, values: Object.fromEntries(visible.filter(field => values[field.id] !== undefined).map(field => [field.id, values[field.id]])) };
  };
  const publicObject = (row: ServiceObjectView): ServiceObjectView => {
    const result = structuredClone(latestObject(row)), visible = publicFields(result.type.fields, result.values);
    delete result.contact_id; result.type.fields = visible.fields; result.values = visible.values;
    if (!visible.fields.some(field => field.id === result.type.identifier_field_id)) { delete result.type.identifier_field_id; result.identifier = result.type.labels.singular + " · " + result.id.slice(-6).toUpperCase(); }
    return result;
  };
  const publicOrder = (row: Order): Order => {
    const result = structuredClone(row), visible = publicFields(row.fields, row.extra);
    delete result.notes; delete result.assignee; delete result.created_by; result.fields = visible.fields; result.extra = visible.values;
    if (result.object) { const captured = publicFields(result.object.type.fields, result.object.values); result.object.type.fields = captured.fields; result.object.values = captured.values;
      if (!captured.fields.some(field => field.id === result.object!.type.identifier_field_id)) { delete result.object.type.identifier_field_id; result.object.identifier = result.object.type.labels.singular + " · " + result.object.object_id.slice(-6).toUpperCase(); }
    }
    return result;
  };
  const filled = (value: unknown) => value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");
  const validate = (fields: WorkField[], values: ExtraValues): ExtraValues => {
    for (const key of Object.keys(values)) if (!fields.some(field => field.id === key && !field.sensitive)) fail("invalid_fields", "Há campos indisponíveis neste formulário.", 400);
    for (const field of fields.filter(field => !field.sensitive)) {
      const value = values[field.id];
      if (!filled(value)) { if (field.required) fail("invalid_fields", "Preencha " + field.label + ".", 400); continue; }
      const valid = field.kind === "text" ? typeof value === "string" && value.length <= field.max_length && (field.multiline || !/[\r\n]/.test(value))
        : field.kind === "choice" ? field.options.some(option => option.id === value)
          : field.kind === "boolean" ? typeof value === "boolean"
            : field.kind === "date" ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && (!field.min || value >= field.min) && (!field.max || value <= field.max)
              : typeof value === "number" && Number.isFinite(value) && value >= field.min && value <= field.max && (field.kind !== "integer" || Number.isInteger(value));
      if (!valid) fail("invalid_fields", "Confira " + field.label + ".", 400);
    }
    return structuredClone(values);
  };
  const version = (actual: number, expected: unknown) => { if (actual !== expected) fail("version_conflict", "O registro mudou. Recarregue a versão atual e revise o preenchimento."); };
  const requirements = (row: Order, transitionId?: string, values = row.extra): OrderRequirements => {
    const model = type(row.type_id), transition = transitionId ? model.transitions.find(entry => entry.id === transitionId && entry.from === row.stage) : undefined;
    if (transitionId && !transition) fail("invalid_fields", "A transição não está disponível nesta etapa.", 400);
    const cancelled = transition && model.stages.find(stage => stage.id === transition.to)?.base_status === "cancelled";
    const ids = cancelled ? new Set<string>() : new Set(activeRequirements.get(row.id) || []);
    if (!cancelled) for (const rule of model.stage_field_rules || []) if (rule.required_from_stage === row.stage || transition && (rule.required_from_stage === transition.to || rule.required_on_exit?.includes(row.stage))) ids.add(rule.field_id);
    const required = row.fields.filter(field => !field.sensitive && (field.required || ids.has(field.id))).map(field => ({ field_id: field.id, label: field.label }));
    return { id: row.id, version: row.version, ...(transitionId ? { transition_id: transitionId } : {}), required: cancelled ? [] : required, missing: cancelled ? [] : required.filter(field => !filled(values[field.field_id])), internal_missing: false };
  };
  const assertRequirements = (result: OrderRequirements) => { if (result.missing.length) fail("missing_fields", "Complete os campos necessários antes de avançar."); };
  const prepareObject = (ownerId: string, expectedType: string, input: ObjectOpeningRequest | undefined) => {
    contact(ownerId);
    if (!input) fail("object_required", "Selecione ou cadastre o objeto do serviço.");
    if (input!.mode === "existing") {
      const row = object(input!.id);
      if (row.contact_id !== ownerId || row.type_id !== expectedType) notFound();
      if (row.archived) fail("object_archived", "Este objeto está arquivado. Escolha outro cadastro ativo.");
      version(row.version, input!.version);
      return { row, isNew: false };
    }
    if (input!.mode !== "new" || input!.type_id !== expectedType) fail("invalid_fields", "O tipo do objeto não corresponde ao modelo.", 400);
    const definition = objectType(expectedType);
    if (definition.archived) fail("object_archived", "O tipo de objeto está arquivado.");
    if (objects.filter(row => row.contact_id === ownerId).length >= 100 || objects.filter(row => row.contact_id === ownerId && row.type_id === expectedType && !row.archived).length >= 30) fail("object_limit", "Este cliente atingiu o limite de objetos. Arquive um cadastro ativo antes de adicionar outro.");
    const values = validate(definition.fields, input!.values), id = "demo-object-" + crypto.randomUUID();
    const row: ServiceObjectView = { id, contact_id: ownerId, type_id: definition.id, type_revision: definition.revision, type: structuredClone(definition), values, archived: false, version: 1,
      identifier: String(values[definition.identifier_field_id] || definition.labels.singular + " · " + id.slice(-6).toUpperCase()), created: Date.now(), updated: Date.now() };
    return { row, isNew: true };
  };
  const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(entry => JSON.parse(canonical(entry))) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, JSON.parse(canonical(entry))])) : value ?? null);
  const paged = <T,>(rows: T[], query: URLSearchParams, context: string): Page<T> => {
    const encoded = query.get("cursor"); let start = 0;
    if (encoded) { try { const cursor = JSON.parse(decodeURIComponent(encoded)); if (cursor.context !== context || !Number.isInteger(cursor.start) || cursor.start < 0) throw new Error(); start = cursor.start; } catch { fail("invalid_fields", "A página não pertence a esta consulta. Reinicie a lista.", 400); } }
    const limit = Math.min(50, Math.max(1, Number(query.get("limit")) || 50));
    return { data: rows.slice(start, start + limit), next_cursor: start + limit < rows.length ? encodeURIComponent(JSON.stringify({ context, start: start + limit })) : null };
  };
  const commonFilter = (rows: Order[], query: URLSearchParams) => rows.filter(row =>
    (!query.get("type_id") || row.type_id === query.get("type_id")) && (!query.get("type_ids") || query.get("type_ids")!.split(",").includes(row.type_id)) &&
    (!query.get("status") || query.get("status")!.split(",").includes(row.status)) && (!query.get("stage") || query.get("stage")!.split(",").includes(row.stage)) &&
    (!query.get("contact_id") || row.customer.contact_id === query.get("contact_id")) && (!query.get("conversation_id") || row.customer.conversation_id === query.get("conversation_id")) &&
    (!query.get("phone") || row.customer.phone === query.get("phone")) && (query.get("open") !== "1" || !["delivered", "cancelled"].includes(row.status)) &&
    (!query.get("assignee") || row.assignee === (query.get("assignee") === "me" ? demoMe.id : query.get("assignee") === "unassigned" ? null : query.get("assignee"))) &&
    (!query.get("due_from") || row.due_at !== null && row.due_at >= Number(query.get("due_from"))) && (!query.get("due_to") || row.due_at !== null && row.due_at <= Number(query.get("due_to"))) &&
    (!query.get("q") || `${row.display_number} ${row.item} ${row.customer.name} ${row.customer.phone || ""}`.toLocaleLowerCase("pt-BR").includes(query.get("q")!.toLocaleLowerCase("pt-BR"))));
  const normalized = (value: unknown) => typeof value === "string" ? value.trim().normalize("NFC").toLocaleLowerCase("pt-BR") : value;
  const readWork = (rest: string, query: URLSearchParams): unknown => {
    const context = rest + "?" + [...query.entries()].filter(([key]) => key !== "cursor").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("&");
    if (rest === "service-orders/types") return { data: types, settings_revision: "demo" } satisfies WorkTypeCatalog;
    if (rest === "service-orders/object-types") return { data: objectTypes.filter(row => !row.archived || query.get("include_archived") === "1"), settings_revision: "demo" };
    const typeMatch = rest.match(/^service-orders\/types\/([^/]+)(?:\/(field-index))?$/);
    if (typeMatch) { const model = type(decodeURIComponent(typeMatch[1])); return typeMatch[2] ? { type_id: model.id, generation: "demo-ready", status: "ready", cursor_number: 20, ceiling_number: 20, excluded_count: 1, updated: Date.now() } : model; }
    if (rest === "service-orders/objects") { const owner = contact(query.get("contact_id")); return paged(objects.filter(row => row.contact_id === owner.id && (!query.get("type_id") || row.type_id === query.get("type_id")) && (!row.archived || query.get("include_archived") === "1")).map(latestObject), query, context); }
    const objectMatch = rest.match(/^service-orders\/objects\/([^/]+)(?:\/(orders|private-fields))?$/);
    if (objectMatch) { const row = object(decodeURIComponent(objectMatch[1]));
      if (objectMatch[2] === "orders") return paged(orders.filter(entry => entry.object?.object_id === row.id).sort((a, b) => b.created - a.created || b.number - a.number), query, context);
      if (objectMatch[2] === "private-fields") return { id: row.id, version: row.version, fields: row.type.fields.filter(field => field.sensitive), values: privateValues.get(row.id) || {} };
      return latestObject(row);
    }
    const conversationMatch = rest.match(/^service-orders\/conversation\/([^/]+)(?:\/objects(?:\/([^/]+))?)?$/);
    if (conversationMatch) { const owner = contacts.find((_row, index) => conversationMatch[1] === "demo-" + (index + 1)); if (!owner) return notFound();
      if (!rest.includes("/objects")) return paged(orders.filter(row => row.customer.contact_id === owner.id).map(publicOrder), query, context);
      if (conversationMatch[2]) { const row = object(conversationMatch[2]); if (row.contact_id !== owner.id) notFound(); return { ...publicObject(row), orders: paged(orders.filter(entry => entry.object?.object_id === row.id).sort((a, b) => b.created - a.created || b.number - a.number).map(publicOrder), query, context) }; }
      return paged(objects.filter(row => row.contact_id === owner.id && !row.archived).map(publicObject), query, context);
    }
    if (rest === "service-orders/my-tasks") return { data: [], next_cursor: null };
    if (rest === "service-orders") {
      let rows = commonFilter(orders, query).sort((a, b) => b.number - a.number);
      if (query.has("field_filter")) {
        let filter: OrderFieldFilter; try { filter = JSON.parse(query.get("field_filter")!); } catch { return fail("invalid_fields", "Filtro inválido.", 400); }
        const model = type(query.get("type_id") || ""), rule = model.list_fields?.find(row => row.filter && row.ref.scope === filter?.ref?.scope && row.ref.field_id === filter?.ref?.field_id);
        if (!rule) return fail("invalid_fields", "Escolha um filtro publicado neste modelo.", 400);
        const definition = (rule.ref.scope === "order" ? model.fields : objectType(model.object_type_id!).fields).find(field => field.id === rule.ref.field_id);
        if (!definition || definition.sensitive || !["eq", "range"].includes(filter.operator) || filter.operator === "range" && !["integer", "decimal", "date"].includes(definition.kind)) return fail("invalid_fields", "Este campo não permite o filtro solicitado.", 400);
        const value = (row: Order) => { const captured = (rule.ref.scope === "order" ? row.fields : row.object?.type.fields)?.find(field => field.id === rule.ref.field_id); return captured && !captured.sensitive && captured.kind === definition.kind ? rule.ref.scope === "order" ? row.extra[rule.ref.field_id] : row.object?.values[rule.ref.field_id] : undefined; };
        rows = rows.filter(row => { const actual = value(row); return filled(actual) && (filter.operator === "eq" ? normalized(actual) === normalized(filter.value) : actual! >= filter.from && actual! <= filter.to); });
        if (filter.operator === "range") rows.sort((a, b) => { const x = value(a)!, y = value(b)!; return (x < y ? -1 : x > y ? 1 : 0) || b.number - a.number; });
        return { ...paged(rows, query, context), counts: null, counts_scope: "not_computed", order_by: filter.operator === "range" ? "field_value_asc" : "number_desc" } satisfies FieldFilteredOrderList;
      }
      const counts: OrderList["counts"] = {}, facets = { types: {} as Record<string, number>, stages: {} as Record<string, number> };
      for (const row of orders) counts[row.status] = (counts[row.status] || 0) + 1;
      for (const row of rows) { facets.types[row.type_id] = (facets.types[row.type_id] || 0) + 1; facets.stages[row.stage] = (facets.stages[row.stage] || 0) + 1; }
      return { ...paged(rows, query, context), counts, ...(query.get("facets") === "1" ? { facets } : {}) } satisfies OrderList;
    }
    const match = rest.match(/^service-orders\/([^/]+)(?:\/([^/]+))?$/); if (!match) return notFound();
    const row = order(decodeURIComponent(match[1]));
    if (!match[2]) return { ...row, ...(query.get("history") === "none" ? {} : { history: history.get(row.id) }) };
    if (match[2] === "requirements") return requirements(row, query.get("transition_id") || undefined);
    if (match[2] === "history") return paged(history.get(row.id) || [], query, context);
    if (match[2] === "private-fields") return { id: row.id, version: row.version, fields: [], extra: {} };
    if (["tasks", "private-tasks", "people", "documents", "private-documents", "entries"].includes(match[2])) return { data: [], next_cursor: null };
    return notFound();
  };
  const mutate = (rest: string, method: string, body: Row): unknown => {
    if (rest === "service-orders" && method === "POST") {
      const model = type(body.type_id || "service_order");
      if (model.archived) fail("invalid_fields", "O modelo está arquivado.", 400);
      if (!filled(body.item) || !filled(body.problem)) fail("invalid_fields", "Informe o item e a solicitação.", 400);
      if (model.object_type_id && !body.contact_id) fail("customer_required", "Selecione um contato cadastrado para o objeto.");
      if (!model.object_type_id && body.object) fail("invalid_fields", "Este modelo não usa objeto do serviço.", 400);
      const owner = body.contact_id ? contact(body.contact_id) : undefined;
      const prepared = model.object_type_id ? prepareObject(owner!.id, model.object_type_id, body.object) : undefined;
      const result = custom(Math.max(...orders.map(row => row.number)) + 1, model, owner);
      result.id = "os-demo-" + crypto.randomUUID(); result.item = body.item; result.problem = body.problem; result.notes = body.notes || "";
      result.extra = validate(model.fields, body.extra || {}); result.assignee = body.assignee ?? null; result.due_at = body.due_at ?? null; result.created = result.updated = Date.now();
      result.customer = owner ? { name: owner.name, phone: owner.phone, contact_id: owner.id, conversation_id: body.conversation_id || null } : { name: body.customer_name || "", phone: body.phone || "", contact_id: null, conversation_id: body.conversation_id || null };
      assertRequirements(requirements(result));
      if (prepared) { result.object = snapshot(prepared.row); if (prepared.isNew) objects.push(prepared.row); }
      orders.unshift(result); history.set(result.id, osHistory(result)); return result;
    }
    if (rest === "service-orders/objects" && method === "POST") { const prepared = prepareObject(body.contact_id, body.type_id, { mode: "new", type_id: body.type_id, values: body.values || {} }); objects.push(prepared.row); return latestObject(prepared.row); }
    const objectMatch = rest.match(/^service-orders\/objects\/([^/]+)(?:\/(archive|private-fields))?$/);
    if (objectMatch) {
      const row = object(objectMatch[1]); version(row.version, body.version);
      if (!objectMatch[2] && method === "PATCH") {
        const definition = body.adopt_revision ? objectType(row.type_id) : row.type;
        if (body.adopt_revision && definition.revision !== body.adopt_revision) fail("object_definition_conflict", "A definição mudou. Confira a nova revisão.");
        const values = validate(definition.fields, { ...row.values, ...(body.values || {}) });
        row.type = structuredClone(definition); row.type_revision = definition.revision; row.values = values;
        row.identifier = String(values[definition.identifier_field_id || ""] || definition.labels.singular + " · " + row.id.slice(-6).toUpperCase());
      } else if (objectMatch[2] === "archive" && method === "POST") {
        if (typeof body.archived !== "boolean") fail("invalid_fields", "Informe a situação de arquivamento.", 400);
        if (!body.archived && row.archived && objects.filter(entry => entry.contact_id === row.contact_id && entry.type_id === row.type_id && !entry.archived).length >= 30) fail("object_limit", "Arquive outro cadastro antes de reativar este objeto.");
        row.archived = body.archived;
      } else if (objectMatch[2] === "private-fields" && method === "PATCH") { if (Object.keys(body.values || {}).length) fail("invalid_fields", "Não há campos privados configurados neste objeto.", 400); privateValues.set(row.id, {}); }
      else return notFound();
      row.version++; row.updated = Date.now(); return objectMatch[2] === "private-fields" ? { id: row.id, version: row.version } : latestObject(row);
    }
    if (/^service-orders\/types\/[^/]+\/field-index\/rebuild$/.test(rest) && method === "POST") return readWork(rest.replace(/\/rebuild$/, ""), new URLSearchParams());
    const match = rest.match(/^service-orders\/([^/]+)(?:\/(object-link|stage|stage-approval))?$/); if (!match) return notFound();
    const row = order(match[1]); version(row.version, body.version);
    if (match[2] === "object-link" && method === "POST") {
      if (row.type_id === "service_order" || row.object) fail("object_definition_conflict", "Esta ordem não permite outro vínculo.");
      const model = type(row.type_id); if (!model.object_type_id) fail("object_definition_conflict", "O modelo atual não usa objeto.");
      if (!row.customer.contact_id) fail("customer_required", "Confirme o contato canônico antes de vincular.");
      const prepared = prepareObject(row.customer.contact_id!, model.object_type_id!, body.object);
      if (prepared.isNew) objects.push(prepared.row); row.object = snapshot(prepared.row, "legacy_link");
    } else if (!match[2] && method === "PATCH") {
      const closed = ["delivered", "cancelled"].includes(row.status);
      if (closed && Object.keys(body).some(key => !["version", "notes"].includes(key))) fail("invalid_fields", "A ordem encerrada aceita somente observações.", 400);
      const extra = body.extra ? validate(row.fields, { ...row.extra, ...body.extra }) : row.extra; assertRequirements(requirements(row, undefined, extra));
      for (const key of ["item", "problem", "notes", "assignee", "due_at"] as const) if (body[key] !== undefined) Object.assign(row, { [key]: body[key] }); row.extra = extra;
    } else if (["stage", "stage-approval"].includes(match[2]) && method === "POST") {
      const result = requirements(row, body.transition_id); assertRequirements(result);
      const transition = type(row.type_id).transitions.find(entry => entry.id === body.transition_id && entry.from === row.stage)!;
      activeRequirements.set(row.id, new Set(result.required.map(field => field.field_id))); setStage(row, transition.to);
      if (row.status === "delivered") row.delivered_at = Date.now();
    } else return notFound();
    row.version++; row.updated = Date.now(); history.set(row.id, [...(history.get(row.id) || []), { id: crypto.randomUUID(), kind: match[2] || "updated", from_status: null, to_status: row.status, from_stage: null, to_stage: row.stage, actor: demoMe.id, note: "Demonstração", created: row.updated }]); return row;
  };
  return async (path, method = "GET", body, _signal, key) => {
    const [pathname, search = ""] = path.split("?"), query = new URLSearchParams(search);
    const match = pathname.match(/^v1\/profiles\/([^/]+)\/(.*)$/), rest = match?.[2] || "";
    if (rest.startsWith("service-orders") || rest === "contacts" || rest.startsWith("contacts/")) {
      if (match?.[1] !== "demo") return notFound();
      if (method === "GET" && rest === "contacts") { const q = (query.get("q") || query.get("search") || "").toLocaleLowerCase("pt-BR"); return structuredClone(paged(contacts.filter(row => (!query.get("namespace") || query.get("namespace") === "team") && `${row.name} ${row.phone}`.toLocaleLowerCase("pt-BR").includes(q)), query, "contacts:" + q)); }
      const contactMatch = rest.match(/^contacts\/([^/]+)(?:\/(profile|modules\/os\/collections\/(?:objects|orders|works)))?$/);
      if (method === "GET" && contactMatch) {
        const owner = contact(contactMatch[1]);
        if (!contactMatch[2]) return { contact: structuredClone(owner), phones: [{ phone: owner.phone, label: "WhatsApp" }] };
        if (contactMatch[2] === "profile") return { profileId: "demo", contactId: owner.id, erpContactId: null, depth: "simple", vocabulary: { singular: "Cliente", plural: "Clientes" }, writable: false, namespace: "team", contributions: [
          { id: "objects", kind: "collection", title: "Objetos do cliente", component: "table", source: "os", policy: "contacts:read", moduleId: "os", writable: false, columns: [{ key: "identifier", label: "Identificação", format: "text" }, { key: "type", label: "Tipo", format: "text" }, { key: "status", label: "Situação", format: "status" }] },
          { id: "orders", kind: "collection", title: "Ordens de serviço", component: "table", source: "os", policy: "contacts:read", moduleId: "os", writable: false, columns: [{ key: "number", label: "Número", format: "text" }, { key: "stage", label: "Etapa", format: "text" }] },
        ] };
        const rows = contactMatch[2].endsWith("objects") ? objects.filter(row => row.contact_id === owner.id).map(row => ({ id: row.id, cells: { identifier: row.identifier, type: row.type.labels.singular, status: row.archived ? "Arquivado" : "Ativo" }, target: { module: "os", resource: "objects", id: row.id } }))
          : orders.filter(row => row.customer.contact_id === owner.id).map(row => ({ id: row.id, cells: { number: row.display_number, stage: row.stage_label }, target: { module: "os", resource: "orders", id: row.id } }));
        const page = paged<import("../../src/customer/profile-contracts").ContactPage["items"][number]>(rows, query, rest); return { items: page.data, nextCursor: page.next_cursor, incomplete: false };
      }
      if (rest.startsWith("contacts")) return notFound();
      if (method === "GET") return structuredClone(readWork(rest, query));
      const receiptId = method + ":" + rest + ":" + (key || crypto.randomUUID()), payload = canonical(body || {}), receipt = receipts.get(receiptId);
      if (receipt) { if (receipt.payload !== payload) fail("idempotency_conflict", "Esta intenção já foi usada com outro preenchimento."); return structuredClone(receipt.result); }
      const result = structuredClone(mutate(rest, method, body || {})); receipts.set(receiptId, { payload, result }); return structuredClone(result);
    }
    if (method !== "GET") fail("demo", "Estas são telas de referência com dados fictícios. Entre na sua instalação para salvar alterações.", 400);
    return read(pathname, query);
  };
}

// Mensalidade (módulo "mensalidade"): escola de idiomas, nos formatos de
// GET /mensalidade/plans, /subscriptions, /installments, /summary e /delinquents.
const msPlans: Row[] = [
  { id: "plan-kids", name: "Inglês Kids", amount_cents: 18000, period: "monthly", period_label: "Mensal", due_day: 10, active: true, subscriptions: 3 },
  { id: "plan-teens", name: "Inglês Teens", amount_cents: 21000, period: "monthly", period_label: "Mensal", due_day: 10, active: true, subscriptions: 3 },
  { id: "plan-esp", name: "Espanhol Adulto", amount_cents: 24000, period: "monthly", period_label: "Mensal", due_day: 5, active: true, subscriptions: 1 },
  { id: "plan-intensivo", name: "Conversação intensiva", amount_cents: 60000, period: "quarterly", period_label: "Trimestral", due_day: 15, active: true, subscriptions: 1 },
];
const msMonth = new Date(Date.now() - 3 * H).toISOString().slice(0, 7);
const msToday = new Date(Date.now() - 3 * H).toISOString().slice(0, 10);
const msMonthNames = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const msPrevMonth = (() => {
  const [y, m] = msMonth.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
})();
const msSub = (
  n: number,
  name: string,
  phone: string,
  plan: string,
  discount: number,
  status = "active",
): Row => {
  const p = msPlans.find((item) => item.id === plan)!;
  return {
    id: "sub-" + n,
    plan_id: plan,
    plan_name: p.name,
    customer: { name, phone, contact_id: null, conversation_id: n <= 4 ? "demo-1" : null },
    period: p.period,
    period_label: p.period_label,
    amount_cents: p.amount_cents,
    discount_cents: discount,
    charge_cents: p.amount_cents - discount,
    due_day: p.due_day,
    start_date: "2026-02-01",
    end_date: null,
    status,
    status_label: status === "active" ? "Ativa" : "Pausada",
    notes: n === 2 ? "Irmã do Lucas: 15% de desconto." : "",
    paused_at: status === "paused" ? t(20 * 24 * H) : null,
    ended_at: null,
    created_by: "demo-user",
    created: t(200 * 24 * H),
    updated: t(5 * 24 * H),
  };
};
const msSubs: Row[] = [
  msSub(1, "Lucas Ferreira", "5511987001001", "plan-kids", 0),
  msSub(2, "Sofia Ferreira", "5511987001001", "plan-kids", 2700),
  msSub(3, "Gabriel Rocha", "5511987001003", "plan-teens", 0),
  msSub(4, "Helena Martins", "5511987001004", "plan-teens", 0),
  msSub(5, "Davi Nogueira", "5511987001005", "plan-teens", 3000),
  msSub(6, "Laura Pires", "5511987001006", "plan-esp", 0),
  msSub(7, "Marcos Tavares", "5511987001007", "plan-intensivo", 0),
  msSub(8, "Isabela Duarte", "5511987001008", "plan-kids", 0, "paused"),
];
const msInstallment = (sub: Row, month: string, status: string, paid?: "pix" | "manual"): Row => {
  const due = `${month}-${String(sub.due_day).padStart(2, "0")}`;
  const [y, m] = month.split("-").map(Number);
  const labels: Row = { open: "Aberta", paid: "Paga", overdue: "Vencida", waived: "Isenta" };
  return {
    id: `inst-${sub.id}-${month}`,
    subscription_id: sub.id,
    period_key: month,
    period_label: `${msMonthNames[m - 1]}/${y}`,
    due_date: due,
    amount_cents: sub.charge_cents,
    status,
    status_label: labels[status],
    customer: { name: sub.customer.name, phone: sub.customer.phone },
    plan_name: sub.plan_name,
    payment: status === "open" || status === "overdue" ? { id: "pay-" + sub.id, status: "created", pix_code: "00020126580014BR.GOV.BCB.PIX…", url: null } : null,
    notices: { before_at: t(3 * 24 * H), due_at: null, overdue: status === "overdue" ? 2 : 0, overdue_at: null, error: null },
    paid_at: paid ? t(6 * 24 * H) : null,
    paid_via: paid === "manual" ? "manual" : paid ? "pix" : null,
    paid_by: paid === "manual" ? "demo-user" : paid ? "provider" : null,
    paid_note: paid === "manual" ? "Pagou em dinheiro na secretaria" : "",
    created: t(30 * 24 * H),
    updated: t(2 * 24 * H),
  };
};
const msLate = (sub: Row) => `${msMonth}-${String(sub.due_day).padStart(2, "0")}` < msToday;
const msInstallments: Row[] = [
  ...msSubs.slice(0, 7).map((sub, index) =>
    msInstallment(
      sub,
      msMonth,
      index < 3 ? "paid" : index === 5 ? "waived" : msLate(sub) ? "overdue" : "open",
      index === 1 ? "manual" : index < 3 ? "pix" : undefined,
    ),
  ),
  ...msSubs.slice(0, 7).map((sub, index) =>
    msInstallment(sub, msPrevMonth, index === 4 ? "overdue" : "paid", index === 2 ? "manual" : "pix"),
  ),
];
// Pagadores: um por telefone (a família Ferreira paga duas assinaturas).
function msPayers(): Row[] {
  const byPhone = new Map<string, Row>();
  msSubs.forEach((sub, index) => {
    const id = `payer-${sub.customer.phone}`;
    const found = byPhone.get(id);
    if (found) {
      found.subscriptions++;
      return;
    }
    byPhone.set(id, {
      id,
      name: index < 2 ? "Rita Ferreira" : sub.customer.name,
      document: index < 2 ? "52998224725" : null,
      document_type: index < 2 ? "cpf" : null,
      document_display: index < 2 ? "529.982.247-25" : null,
      email: "",
      notes: "",
      phones: [{ phone: sub.customer.phone, label: index < 2 ? "Mãe" : "", created: t(200 * 24 * H) }],
      subscriptions: 1,
      created: t(200 * 24 * H),
      updated: t(5 * 24 * H),
    });
  });
  return [...byPhone.values()];
}
function msSummary(month: string) {
  const rows = msInstallments.filter((row) => row.period_key === month);
  const sum = (status: string) =>
    rows.filter((row) => row.status === status).reduce((total, row) => total + row.amount_cents, 0);
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const overdue = msInstallments.filter((row) => row.status === "overdue");
  return {
    month,
    expected_cents: sum("open") + sum("paid") + sum("overdue"),
    received_cents: sum("paid"),
    overdue_cents: sum("overdue"),
    open_cents: sum("open"),
    waived_cents: sum("waived"),
    counts: { open: count("open"), paid: count("paid"), overdue: count("overdue"), cancelled: 0, waived: count("waived") },
    received_in_month: { count: count("paid"), cents: sum("paid") },
    overdue_total: {
      count: overdue.length,
      cents: overdue.reduce((total, row) => total + row.amount_cents, 0),
      subscriptions: new Set(overdue.map((row) => row.subscription_id)).size,
    },
    payments_ready: true,
  };
}

function read(path: string, query: URLSearchParams): any {
  if (path === "v1/me") return demoMe;
  if (path === "v1/profiles") return [demoProfile];
  if (path === "v1/users") return [];
  if (path === "v1/applications") return { applications: [], keys: [], scopes: [] };
  if (path === "v1/service-templates") return { data: [] };
  const rest = path.replace(/^v1\/profiles\/[^/]+\/?/, "");
  if (rest === "area-templates" || rest.startsWith("area-templates/"))
    return import("../../src/area-templates/catalog").then(({ areaTemplates }) => {
      if (rest === "area-templates") return { data: areaTemplates.map(({ id, version, name, description }) => ({ id, version, name, description })) };
      return structuredClone(areaTemplates.find(template => rest === "area-templates/" + template.id) || workNotFound());
    });
  if (rest === "status")
    return {
      settings,
      settings_revision: "demo",
      enabled: 0,
      // Estado explícito de cada módulo da vitrine, como o servidor manda: a
      // casa de gestão (web/management/registry.ts) só mostra módulo com
      // `true`, e sem isto Agenda, Pedidos, Mesas e os outros somem do ERP.
      // A mesma lista alimenta Módulos e o menu: ERP completo com PDV,
      // mantendo Fiscal e Cobrança desligados na vitrine.
      modules: Object.fromEntries(demoModules.map((m) => [m.id, m.enabled !== false])),
      conversations: ["waiting", "ai", "human", "closed"].map((state) => ({
        state,
        count: conversations.filter((item) => item.state === state).length,
      })),
      deliveries: [],
      connections: [
        { id: "demo-line", name: "WhatsApp Oficial", kind: "zernio", status: "active", last_seen: t(M) },
      ],
    };
  if (rest === "bots")
    return page([
      { id: "demo-bot", name: "Atendente", remote_profile: "atendente", enabled: 1, line_ids: null, connection_kind: "ai" },
      { id: "demo-ia", name: "Bia (IA)", remote_profile: "default", enabled: 0, line_ids: [], connection_kind: "ai", provider: "anthropic", model: "claude-haiku-5-5" },
    ]);
  if (rest === "team") return { data: team };
  if (rest === "presence")
    return team
      .filter((item) => item.kind === "user")
      .map((item) => ({ actor: item.id, name: item.name, present: item.online ? 1 : 0 }));
  if (rest === "conversations") {
    const q = (query.get("q") || "").toLowerCase(),
      state = query.get("state") || "";
    return page(
      conversations.filter(
        (item) =>
          (!state || item.state === state) &&
          (!q ||
            String(item.contact_name || "").toLowerCase().includes(q) ||
            item.phone.includes(q)),
      ),
    );
  }
  const conversationMatch = rest.match(/^conversations\/([^/]+)$/);
  if (conversationMatch) {
    const found =
      conversations.find((item) => item.id === conversationMatch[1]) ||
      conversations[0];
    return {
      conversation: found,
      connection_kind: "zernio",
      server_now: Date.now(),
      media: [],
      capabilities: { reply: true, reaction: true, edit: true, delete: true, read: true, voice: true, location: true, contacts: true },
      group: null,
      contact: found.contact_name
        ? { id: "contact-" + found.id, name: found.contact_name, phone: found.phone, version: 1 }
        : null,
      messages:
        found.id === "demo-1"
          ? messages
          : found.last_message
            ? [
                message({
                  id: found.id + "-m",
                  conversation_id: found.id,
                  direction: found.last_message.direction,
                  text: found.last_message.text || "Foto",
                  created: found.last_message.created,
                  delivery_status: found.last_message.delivery_status,
                }),
              ]
            : [],
      deliveries: [],
    };
  }
  if (rest === "tickets") {
    const status = (query.get("status") || "").split(",").filter(Boolean),
      q = (query.get("q") || "").toLowerCase();
    return page(
      tickets.filter(
        (item) =>
          (!status.length || status.includes(item.status)) &&
          (query.get("active") !== "1" || !["resolved", "closed"].includes(item.status)) &&
          (!query.get("category") || item.category === query.get("category")) &&
          (query.get("overdue") !== "1" ||
            (item.response_due_at < Date.now() &&
              !item.first_response_at &&
              !["resolved", "closed"].includes(item.status))) &&
          (!q || item.number.toLowerCase().includes(q)),
      ),
    );
  }
  const ticketMatch = rest.match(/^tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticket = tickets.find((item) => item.id === ticketMatch[1]) || tickets[0];
    const linked = conversations.find((item) => item.id === ticket.conversation_id)!;
    return {
      ticket,
      updates: ticketUpdates.filter((item) => item.ticket_id === ticket.id),
      conversation: {
        id: linked.id,
        phone: linked.phone,
        external_id: linked.external_id,
        title: null,
        state: linked.state,
        owner: linked.owner,
        contact_name: linked.contact_name,
      },
    };
  }
  if (rest === "internal-chats")
    return {
      data: [
        {
          id: "demo-chat",
          profile_id: "demo",
          member_a: "demo-user",
          member_b: "demo-ana",
          created: t(2 * H),
          updated: t(28 * M),
          peer: team[1],
        },
        {
          id: "demo-bot-chat",
          profile_id: "demo",
          member_a: "bot:demo-bot",
          member_b: "demo-user",
          created: t(3 * H),
          updated: t(4 * M),
          peer: team[3],
        },
      ],
    };
  if (rest === "internal-chats/demo-bot-chat")
    return { id: "demo-bot-chat", peer: team[3], messages: botChatMessages };
  if (rest.startsWith("internal-chats/"))
    return { id: "demo-chat", peer: team[1], messages: internalMessages };
  if (rest === "menus") return { data: menus, revision: "demo" };
  if (rest === "modules") return { data: demoModules };
  if (rest === "agenda" || rest.startsWith("agenda/")) return agendaDemo(rest, query);
  if (rest === "pedido" || rest.startsWith("pedido/")) return pedidoDemo(rest, query);
  if (rest === "mesas" || rest.startsWith("mesas/")) return mesasDemo(rest, query);
  if (rest === "service-orders" || rest.startsWith("service-orders/")) return workDemo(rest, query);
  if (rest === "establishment")
    return {
      name: "Assistência Exemplo",
      document: "11222333000181",
      document_type: "cnpj",
      document_display: "11.222.333/0001-81",
      address: "Rua das Flores, 120 — Centro, Campinas/SP",
      phone: "(19) 3333-4444",
      footer: "Garantia de 90 dias nos serviços. Obrigado pela preferência!",
      configured: true,
    };
  if (rest === "reserva" || rest.startsWith("reserva/")) return reservaDemo(rest, query);
  if (rest === "payments/account")
    return {
      configured: true,
      id: "demo-pay",
      provider: "mercadopago",
      enabled: true,
      payer_email: "pagamentos@exemplo.com.br",
      access_token_set: true,
      webhook_secret_set: true,
      checked: { id: "1", name: "LOJA_EXEMPLO" },
      webhook_url: location.origin + "/webhooks/payments/mercadopago/demo-pay",
      providers: [{ id: "mercadopago", name: "Mercado Pago", methods: ["pix", "link"] }],
      updated: t(H),
    };
  if (rest === "mensalidade/plans") return { data: msPlans };
  if (rest === "mensalidade/summary") return msSummary(query.get("month") || msMonth);
  if (rest === "mensalidade/subscriptions") {
    const status = (query.get("status") || "").split(",").filter(Boolean),
      q = (query.get("q") || "").toLowerCase();
    const counts: Row = {};
    for (const sub of msSubs) counts[sub.status] = (counts[sub.status] || 0) + 1;
    return {
      data: msSubs
        .filter((sub) => !status.length || status.includes(sub.status))
        .filter((sub) => !q || `${sub.customer.name} ${sub.customer.phone}`.toLowerCase().includes(q))
        .map((sub) => {
          const late = msInstallments.filter((row) => row.subscription_id === sub.id && row.status === "overdue");
          return {
            ...sub,
            open_count: msInstallments.filter((row) => row.subscription_id === sub.id && row.status === "open").length,
            overdue_count: late.length,
            overdue_cents: late.reduce((total, row) => total + row.amount_cents, 0),
          };
        }),
      next_cursor: null,
      counts,
    };
  }
  const msMatch = rest.match(/^mensalidade\/subscriptions\/([^/]+)$/);
  if (msMatch) {
    const sub = msSubs.find((item) => item.id === msMatch[1]) || msSubs[0];
    return {
      ...sub,
      installments: msInstallments
        .filter((row) => row.subscription_id === sub.id)
        .sort((a, b) => (a.due_date < b.due_date ? 1 : -1)),
    };
  }
  if (rest === "mensalidade/installments") {
    const month = query.get("month") || msMonth,
      status = (query.get("status") || "").split(",").filter(Boolean);
    const rows = msInstallments.filter((row) => row.period_key === month);
    const counts: Row = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    return {
      month,
      data: rows.filter((row) => !status.length || status.includes(row.status)),
      next_cursor: null,
      counts,
    };
  }
  if (rest === "suporte/releases") {
    const kind = query.get("kind");
    const counts: Row = {};
    for (const row of spReleases) counts[row.kind] = (counts[row.kind] || 0) + 1;
    return { data: spReleases.filter((row) => !kind || row.kind === kind), next_cursor: null, counts };
  }
  if (rest === "suporte/purchases") {
    const status = query.get("status");
    const counts: Row = {};
    for (const row of spPurchases) counts[row.status] = (counts[row.status] || 0) + 1;
    return {
      data: spPurchases.filter((row) => !status || row.status === status),
      next_cursor: null,
      counts,
      paid_cents: spPurchases.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.price_cents, 0),
    };
  }
  if (rest === "suporte/offers")
    return { payments_ready: true, mensalidade: true, methods: ["pix", "link"], packages: spPackages, plans: [] };
  if (rest === "suporte/pending")
    return {
      data: [
        {
          session_id: "sp-pend-1",
          conversation_id: "conv-demo-sp-9",
          phone: "5511988009009",
          payer_id: "payer-demo-sp-1",
          payer_name: "Escritório Contábil Beta",
          created: Date.now() - 25 * 60_000,
        },
      ],
    };
  if (rest.startsWith("suporte/conversations/"))
    return {
      conversation_id: rest.split("/")[2],
      phone: "5511988001001",
      allowed: true,
      reason: "released",
      release: spReleases[0],
      session: null,
      awaiting_team: false,
      unlinked_phone: null,
      purchases: [],
    };
  if (rest === "mensalidade/payers") {
    const q = (query.get("q") || "").toLowerCase();
    return {
      data: msPayers().filter(
        (payer) => !q || `${payer.name} ${payer.document || ""}`.toLowerCase().includes(q),
      ),
      next_cursor: null,
    };
  }
  const msPayerMatch = rest.match(/^mensalidade\/payers\/([^/]+)$/);
  if (msPayerMatch) {
    const payer = msPayers().find((item) => item.id === msPayerMatch[1]) || msPayers()[0];
    const subs = msSubs.filter((sub) => `payer-${sub.customer.phone}` === payer.id);
    const late = msInstallments.find(
      (row) => row.status === "overdue" && subs.some((sub) => sub.id === row.subscription_id),
    );
    return {
      ...payer,
      subscriptions: subs,
      situation: { status: late ? "em_atraso" : "em_dia", open_installment: late || null, grace_days: 3 },
    };
  }
  if (rest === "mensalidade/delinquents") {
    const late = msInstallments.filter((row) => row.status === "overdue");
    return {
      data: msSubs
        .filter((sub) => late.some((row) => row.subscription_id === sub.id))
        .map((sub) => {
          const mine = late.filter((row) => row.subscription_id === sub.id);
          return {
            subscription_id: sub.id,
            customer: sub.customer,
            plan_name: sub.plan_name,
            subscription_status: sub.status,
            overdue_count: mine.length,
            overdue_cents: mine.reduce((total, row) => total + row.amount_cents, 0),
            oldest_due_date: mine.map((row) => row.due_date).sort()[0],
            notices_sent: 2,
          };
        }),
    };
  }
  if (rest === "queue") return queueOverview();
  if (rest === "queue/tickets") return { data: qTickets };
  if (rest === "lines") return { data: [] };
  if (rest === "calls")
    return page([
      { id: "call-1", conversation_id: "demo-1", direction: "inbound", status: "completed", duration: 184, created: t(26 * H), actor: "demo-user" },
      { id: "call-2", conversation_id: "demo-2", direction: "inbound", status: "missed", duration: 0, created: t(3 * H), actor: null },
    ]);
  if (rest === "events") return { data: [], cursor: Number(query.get("after")) || 0 };
  if (rest === "reports") return { data: [], count: 0 };
  if (rest === "connections") return [];
  if (rest === "router") return { numbers: [], pools: [], accounts: [] };
  return page([]);
}

const os2DemoApi = createOs2DemoApi();
/** Únicas escritas da ordem de serviço simuladas em memória na demonstração:
 *  objetos do serviço e a abertura com objeto. As demais continuam recusadas. */
export const DEMO_SIMULATED_WRITES = [
  { name: "abrir ordem com objeto", method: "POST", path: /^service-orders$/, object: true },
  { name: "cadastrar objeto", method: "POST", path: /^service-orders\/objects$/ },
  { name: "editar objeto", method: "PATCH", path: /^service-orders\/objects\/[^/]+$/ },
  { name: "arquivar objeto", method: "POST", path: /^service-orders\/objects\/[^/]+\/archive$/ },
  { name: "campos privados do objeto", method: "PATCH", path: /^service-orders\/objects\/[^/]+\/private-fields$/ },
  { name: "vincular objeto a ordem antiga", method: "POST", path: /^service-orders\/[^/]+\/object-link$/ },
] as const;
const simulatedWrite = (path: string, method: string, body: unknown) => {
  const rest = path.split("?")[0].match(/^v1\/profiles\/demo\/(.*)$/)?.[1];
  return rest !== undefined && DEMO_SIMULATED_WRITES.some(write => write.method === method && write.path.test(rest) &&
    (!("object" in write) || !!(body as { object?: unknown } | undefined)?.object));
};
/** API de demonstração: OS2 e canais simulam operações somente em memória. */
export const demoApi: Api = async (path, method = "GET", body, _signal, idempotencyKey) => {
  const channel = demoChannelRequest(path, method, body, idempotencyKey, read);
  if (channel.handled) return channel.data;
  if (method !== "GET" && !simulatedWrite(path, method, body))
    throw Object.assign(new Error("Estas são telas de referência com dados fictícios. Entre na sua instalação para salvar alterações."), { status: 400, code: "demo" });
  return os2DemoApi(path, method, body, _signal, idempotencyKey);
};
