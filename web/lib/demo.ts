// Modo de demonstração (/app?demo=1): telas de referência com dados
// fictícios, respondidas aqui mesmo. Nenhuma chamada sai do navegador e
// nenhuma escrita é aceita.
import type { Api, Row } from "./api";
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

export const demoMe = { id: "demo-user", name: "Administrador", role: "admin" };
export const demoProfile = {
  id: "demo",
  name: "Atendimento Queven",
};

const settings: Row = {
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
    { id: "fagoo-erp", name: "Fagoo ERP", enabled: true },
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
    connection_kind: "hermes",
    does: "Bot do Hermes: responde aqui com as ferramentas e permissões configuradas no Hermes.",
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
      { id: "service-orders", label: "Ordens de serviço", place: "admin", admin: false },
      { id: "service-orders-settings", label: "Ordem de serviço", place: "admin", admin: true },
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
const osLabels: Row = {
  received: "Recebida",
  analyzing: "Em análise",
  quoted: "Orçamento enviado",
  approved: "Aprovada",
  in_progress: "Em execução",
  ready: "Pronta",
  delivered: "Entregue",
};
const osNext: Row = {
  received: ["analyzing", "in_progress", "cancelled"],
  analyzing: ["in_progress", "cancelled", "quoted"],
  quoted: ["analyzing", "cancelled", "quoted", "approved", "declined"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready: ["delivered", "in_progress", "cancelled"],
  delivered: [],
};
const osOrder = (
  number: number,
  status: string,
  name: string,
  phone: string,
  item: string,
  problem: string,
  age: number,
  quote: [string, number][] | null = null,
): Row => ({
  id: "os-" + number,
  number,
  status,
  status_label: osLabels[status],
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
const osOrders: Row[] = [
  osOrder(15, "received", "Carla Mendes", "5511987650001", "Notebook Lenovo IdeaPad", "Não liga depois de uma queda.", 2 * H),
  osOrder(14, "quoted", "Mariana Costa", "5511987650002", "Celular Moto G84", "Tela trincada e touch falhando no canto.", 26 * H, [["Troca de tela", 38000], ["Película", 2500]]),
  osOrder(13, "in_progress", "Rafael Lima", "5511987650003", "Bicicleta aro 29", "Freio traseiro sem pressão.", 3 * 24 * H, [["Sangria do freio", 9000], ["Pastilhas", 6500]]),
  osOrder(12, "ready", "Patrícia Souza", "5511987650004", "Terno azul-marinho", "Ajustar barra e cintura.", 4 * 24 * H, [["Ajuste de barra", 4000], ["Ajuste de cintura", 5000]]),
  osOrder(11, "delivered", "João Pereira", "5511987650005", "Máquina de lavar Brastemp", "Vazamento na lateral.", 9 * 24 * H, [["Mangueira", 4500], ["Mão de obra", 12000]]),
];
const osHistory = (order: Row): Row[] => [
  { id: order.id + "-h1", kind: "opened", from_status: null, to_status: "received", actor: order.source === "customer" ? "customer" : "demo-user", note: "", created: order.created },
  ...(order.status !== "received"
    ? [{ id: order.id + "-h2", kind: "status", from_status: "received", to_status: order.status, actor: "demo-user", note: "", created: order.updated }]
    : []),
];

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
  if (rest === "status")
    return {
      settings,
      enabled: 0,
      // ERP na vitrine: núcleo e Caixa/PDV ligados; os demais opcionais, não.
      modules: {
        erp: true,
        "erp-pdv": true,
        "erp-fiscal": false,
        "erp-cobranca": false,
      },
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
      { id: "demo-bot", name: "Atendente", remote_profile: "atendente", enabled: 1, line_ids: null, connection_kind: "hermes" },
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
  if (rest === "service-orders") {
    const status = (query.get("status") || "").split(",").filter(Boolean),
      q = (query.get("q") || "").toLowerCase();
    const counts: Row = {};
    for (const order of osOrders) counts[order.status] = (counts[order.status] || 0) + 1;
    return {
      data: osOrders.filter(
        (order) =>
          (!status.length || status.includes(order.status)) &&
          (query.get("open") !== "1" || !["delivered", "cancelled"].includes(order.status)) &&
          (!q ||
            String(order.number) === q ||
            `${order.item} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(q)),
      ),
      next_cursor: null,
      counts,
    };
  }
  const osMatch = rest.match(/^service-orders\/([^/]+)$/);
  if (osMatch) {
    const order = osOrders.find((item) => item.id === osMatch[1]) || osOrders[0];
    return { ...order, history: osHistory(order) };
  }
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

/** API de demonstração: leituras com dados fictícios; escritas são recusadas. */
export const demoApi: Api = async (path, method = "GET") => {
  const [pathname, search = ""] = path.split("?");
  if (method !== "GET")
    throw Object.assign(
      new Error(
        "Estas são telas de referência com dados fictícios. Entre na sua instalação para salvar alterações.",
      ),
      { status: 400, code: "demo" },
    );
  return read(pathname, new URLSearchParams(search));
};
