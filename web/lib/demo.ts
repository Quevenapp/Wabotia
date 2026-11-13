// Modo de demonstração (/app?demo=1): telas de referência com dados
// fictícios, respondidas aqui mesmo. Nenhuma chamada sai do navegador e
// nenhuma escrita é aceita.
import type { Api, Row } from "./api";

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
  reply_mode: "command",
  capabilities: [],
  menus: [],
  apps: [],
  departments: [
    { id: "suporte", name: "Suporte", members: ["demo-user", "demo-ana"], enabled: true },
    { id: "financeiro", name: "Financeiro", members: ["demo-ana"], enabled: true },
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
    bot_id: "demo-bot",
    line_ids: null,
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
const menus: Row[] = [
  { id: "menu-sales", label: "Informações da loja", type: "submenu", enabled: true, line_ids: [], trigger: "automatic" },
  { id: "menu-person", label: "Conversar com uma pessoa", type: "human", parent_id: "menu-sales", enabled: true, line_ids: [], trigger: "automatic" },
];

const page = (data: Row[]) => ({ data, next_cursor: null });

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
      { id: "demo-bot", name: "Atendente", remote_profile: "atendente", enabled: 1, line_ids: null },
    ]);
  if (rest === "team") return { data: team };
  if (rest === "presence")
    return team
      .filter((item) => item.kind === "user")
      .map((item) => ({ actor: item.id, name: item.name, present: item.online ? 1 : 0, telegram_id: null }));
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
      ],
    };
  if (rest.startsWith("internal-chats/"))
    return { id: "demo-chat", peer: team[1], messages: internalMessages };
  if (rest === "menus") return { data: menus, revision: "demo" };
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
