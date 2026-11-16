// Servidor MCP (Model Context Protocol) em Streamable HTTP, sem sessão, para o
// Hermes Agent e outros clientes MCP. Cada ferramenta é traduzida para uma
// chamada interna à API v1 desta mesma instalação, com a chave de aplicação do
// cliente: permissões, namespaces, idempotência e limites continuam os da API.
import type { Hono } from "hono";
import { type Actor, type Bindings, type Env, ApiError } from "./types";
import { all } from "./db";
import { resolveStates } from "./modules/registry";
import { authenticate, canProfile } from "./security";
import { isBound } from "./visibility";
import { buildInfo } from "./build-info.generated";
import { ticketStatuses } from "./protocols";
import { moduleMcpTools } from "./modules/hooks";
import {
  BOT_TOOLS,
  RUN_HEADER,
  newToolState,
  proposalsOfRun,
  runBotTool,
  runFromHeader,
  type BotActionContext,
  type ToolState,
} from "./bot-actions/actions";

/** Chamadas de ferramenta por execução do Hermes (teto por turno). */
const personStates = new Map<string, ToolState>();

type Row = Record<string, any>;
export type Call = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Row;
  body?: Row;
};
type Tool = {
  name: string;
  description: string;
  input: Row;
  required?: string[];
  call: (a: Row, profile: string) => Call;
  shape?: (data: any, a: Row) => any;
};

export const MCP_PATH = "/api/mcp";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS =
  "Wabotia: atendimento WhatsApp com equipe humana, bots, protocolos e agenda de contatos. " +
  "IDs são opacos; datas são Unix em milissegundos; listas retornam {data,next_cursor}. " +
  "Antes de responder a um cliente, assuma a conversa (claim_conversation); responda com reply_conversation. " +
  "Notas internas não chegam ao cliente. Cada ferramenta de escrita aceita idempotency_key: " +
  "repita a mesma chave para reenviar a mesma intenção após falha de rede e nunca gere outra após timeout. " +
  "Erros trazem código, mensagem e request_id da API. Respeite 429 e aguarde antes de repetir. " +
  "Quando a chave acessa uma única área de atendimento, o parâmetro profile é opcional.";

const INTERNAL_HEADER = "X-Wabotia-Internal-Actor";
const internalActors = new Map<string, Actor>();
/** Consome o ator de uma chamada interna do MCP; pedidos externos nunca encontram o nonce. */
export function takeInternalActor(request: Request): Actor | null {
  const nonce = request.headers.get(INTERNAL_HEADER);
  if (!nonce) return null;
  const actor = internalActors.get(nonce) || null;
  internalActors.delete(nonce);
  return actor;
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: any,
  ) {
    super(message);
  }
}

const profile = {
  type: "string",
  description:
    "ID da área de atendimento (list_profiles). Opcional quando a chave acessa uma única área.",
};
const idempotency = {
  type: "string",
  maxLength: 200,
  description:
    "Opcional. Chave estável desta intenção; reutilize ao repetir após falha de rede. Omitida: gerada a cada chamada.",
};
const cursor = {
  type: "string",
  description: "next_cursor da consulta anterior, sem alterações.",
};
const limit = { type: "integer", minimum: 1, maximum: 100 };
const conversationId = {
  type: "string",
  description: "ID Wabotia da conversa.",
};
const contactFields = {
  name: { type: "string", maxLength: 120 },
  phone: {
    type: "string",
    maxLength: 40,
    description: "Com DDI e DDD; aceita +, espaços e pontuação.",
  },
  email: { type: "string", maxLength: 254 },
  company: { type: "string", maxLength: 160 },
  notes: { type: "string", maxLength: 2000 },
};
const content = {
  type: "object",
  description:
    "Conteúdo nativo opcional: {type: text|image|video|audio|voice|document|sticker|location|contacts, reply_to, mentions, location, contacts}.",
};
const p = (id: string, rest: string) => `/profiles/${id}${rest}`;
// Um message_id derivado da idempotency_key mantém o corpo idêntico ao repetir.
const messageId = (a: Row) =>
  a.message_id ||
  (a.idempotency_key ? `mcp-${a.idempotency_key}` : crypto.randomUUID());
const pick = (a: Row, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((k) => a[k] !== undefined && a[k] !== null)
      .map((k) => [k, a[k]]),
  );

export const tools: Tool[] = [
  {
    name: "list_profiles",
    description:
      "Lista as áreas de atendimento autorizadas à chave, com ID e nome.",
    input: {},
    call: () => ({ path: "/profiles" }),
  },
  {
    name: "list_conversations",
    description:
      "Lista conversas da área, da mais recente à mais antiga. state: ai (com a IA), waiting (na fila), human (com atendente) ou closed. q busca por identificador, telefone ou nome do contato. Requer conversations:read.",
    input: {
      profile,
      state: { type: "string", enum: ["ai", "waiting", "human", "closed"] },
      q: { type: "string", maxLength: 200 },
      department_id: { type: "string" },
      cursor,
      limit,
    },
    call: (a, id) => ({
      path: p(id, "/conversations"),
      query: pick(a, ["state", "q", "department_id", "cursor", "limit"]),
    }),
  },
  {
    name: "get_conversation",
    description:
      "Detalhes de uma conversa: estado, responsável, contato, capacidades do canal, mídias, entregas e as últimas mensagens (last_messages, padrão 40). Requer conversations:read; notas internas exigem notes:read.",
    input: {
      profile,
      conversation_id: conversationId,
      last_messages: { type: "integer", minimum: 1, maximum: 500 },
    },
    required: ["conversation_id"],
    call: (a, id) => ({ path: p(id, `/conversations/${a.conversation_id}`) }),
    shape: (data, a) => {
      const keep = Number(a.last_messages) || 40;
      if (Array.isArray(data?.messages) && data.messages.length > keep)
        return {
          ...data,
          messages_omitted: data.messages.length - keep,
          messages: data.messages.slice(-keep),
        };
      return data;
    },
  },
  {
    name: "start_conversation",
    description:
      "Cria uma conversa externa no namespace desta aplicação a partir de uma mensagem do cliente. external_id identifica o cliente no seu sistema. Retorna conversation_id. Requer conversations:write.",
    input: {
      profile,
      external_id: { type: "string", maxLength: 200 },
      text: { type: "string" },
      message_id: {
        type: "string",
        description: "ID da mensagem no sistema de origem; omitido: gerado.",
      },
      attachments: { type: "array", items: { type: "string" } },
      idempotency_key: idempotency,
    },
    required: ["external_id", "text"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/conversations"),
      body: {
        ...pick(a, ["external_id", "text", "attachments"]),
        message_id: messageId(a),
      },
    }),
  },
  {
    name: "receive_inbound_message",
    description:
      "Registra uma nova mensagem do cliente em uma conversa externa existente (mesmo external_id). Requer conversations:write.",
    input: {
      profile,
      external_id: { type: "string", maxLength: 200 },
      text: { type: "string" },
      message_id: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
      idempotency_key: idempotency,
    },
    required: ["external_id", "text"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/inbound"),
      body: {
        ...pick(a, ["external_id", "text", "attachments"]),
        message_id: messageId(a),
      },
    }),
  },
  {
    name: "claim_conversation",
    description:
      "Assume a conversa em nome desta aplicação. Obrigatório antes de responder. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "claim" },
    }),
  },
  {
    name: "reply_conversation",
    description:
      "Envia uma resposta ao cliente na conversa já assumida. attachments recebe IDs de mídias do Wabotia; content define tipo nativo, citação ou menções. Respeita janela de 24 horas, consentimentos e capacidades do canal. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      text: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
      content,
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "reply", ...pick(a, ["text", "attachments", "content"]) },
    }),
  },
  {
    name: "add_internal_note",
    description:
      "Registra uma nota interna na conversa, invisível ao cliente. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      text: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "text"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "note", text: a.text },
    }),
  },
  {
    name: "transfer_conversation",
    description:
      "Transfere a conversa para uma pessoa (ID de usuário) ou bot (bot:<id>) do diretório da área; department_id escolhe o setor humano. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      target: { type: "string" },
      department_id: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "target"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "transfer", ...pick(a, ["target", "department_id"]) },
    }),
  },
  {
    name: "resolve_conversation",
    description: "Conclui a conversa. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "resolve" },
    }),
  },
  {
    name: "resume_conversation",
    description: "Reabre uma conversa concluída. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "resume" },
    }),
  },
  {
    name: "tag_conversation",
    description:
      "Substitui as etiquetas da conversa pela lista informada. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      tags: { type: "array", items: { type: "string" } },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "tags"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "tags", tags: a.tags },
    }),
  },
  {
    name: "send_menu",
    description:
      "Envia ao cliente o menu da área (menu_id de um submenu ou omitido para o principal). Exige conversa assumida e janela válida. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      menu_id: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "menu", menu_id: a.menu_id ?? null },
    }),
  },
  {
    name: "list_forms",
    description:
      "Lista os formulários ativos da área (módulo Formulários), com ID, título e campos. Use o ID em send_form. Requer conversations:read.",
    input: { profile },
    call: (_a, id) => ({ path: p(id, "/forms") }),
  },
  {
    name: "send_form",
    description:
      "Envia ao cliente o link de um formulário (passo web). O cliente responde numa página e volta ao WhatsApp com a confirmação; as respostas vão para a conversa, o contato e o protocolo ativo. Exige conversa assumida e janela de 24 horas aberta. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      form_id: { type: "string", description: "ID de list_forms." },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "form_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "form", form_id: a.form_id },
    }),
  },
  {
    name: "list_web_steps",
    description:
      "Passos web da conversa e o estado de cada link: sent (enviado), opened (aberto), completed (concluído, com answers), expired ou cancelled. Requer conversations:read.",
    input: { profile, conversation_id: conversationId },
    required: ["conversation_id"],
    call: (a, id) => ({
      path: p(id, `/conversations/${a.conversation_id}/web-steps`),
    }),
  },
  {
    name: "lookup_conversation_protocols",
    description:
      "Lista os protocolos do telefone verificado desta conversa, ou confere um número exato de protocolo. Não consulta terceiros. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      number: {
        type: "string",
        description: "Número do protocolo, como 10001 (antigos: WA-…)",
      },
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/actions`),
      body: { action: "protocols", ...pick(a, ["number"]) },
    }),
  },
  {
    name: "message_action",
    description:
      "Reage (emoji; vazio remove), edita (text, até 15 minutos), apaga ou marca como lida uma mensagem da conversa. Sujeito às capacidades do canal. Requer conversations:write.",
    input: {
      profile,
      conversation_id: conversationId,
      action: { type: "string", enum: ["reaction", "edit", "delete", "read"] },
      message_id: { type: "string", description: "ID Wabotia da mensagem." },
      emoji: { type: "string" },
      text: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "action", "message_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/conversations/${a.conversation_id}/message-actions`),
      body: pick(a, ["action", "message_id", "emoji", "text"]),
    }),
  },
  {
    name: "list_tickets",
    description: `Lista protocolos. status: um dos estados (${ticketStatuses.join(", ")}) ou vários separados por vírgula; active=true filtra os não resolvidos/encerrados; category filtra pela categoria; overdue=true filtra prazos de primeira resposta vencidos; q busca por número ou telefone. Requer tickets:read.`,
    input: {
      profile,
      status: {
        type: "string",
        description: `Um ou mais de: ${ticketStatuses.join(", ")}, separados por vírgula.`,
      },
      active: { type: "boolean" },
      category: { type: "string", maxLength: 100 },
      q: { type: "string", maxLength: 200 },
      overdue: { type: "boolean" },
      cursor,
      limit,
    },
    call: (a, id) => ({
      path: p(id, "/tickets"),
      query: {
        ...pick(a, ["status", "category", "q", "cursor", "limit"]),
        ...(a.active ? { active: "1" } : {}),
        ...(a.overdue ? { overdue: "1" } : {}),
      },
    }),
  },
  {
    name: "get_ticket",
    description:
      "Protocolo com andamentos e resumo da conversa. Requer tickets:read.",
    input: { profile, ticket_id: { type: "string" } },
    required: ["ticket_id"],
    call: (a, id) => ({ path: p(id, `/tickets/${a.ticket_id}`) }),
  },
  {
    name: "create_ticket",
    description:
      "Abre um protocolo vinculado à conversa e retorna seu número público. Requer tickets:write.",
    input: {
      profile,
      conversation_id: conversationId,
      title: { type: "string", maxLength: 300 },
      idempotency_key: idempotency,
    },
    required: ["conversation_id", "title"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/tickets"),
      body: pick(a, ["conversation_id", "title"]),
    }),
  },
  {
    name: "update_ticket",
    description:
      "Atualiza um protocolo: andamento (text), status (open Recebido, in_progress Em análise, waiting_customer Aguardando cliente, waiting_third Aguardando terceiro, resolved Resolvido, closed Encerrado), categoria habilitada (category), responsável (owner) ou prazo da primeira resposta (response_due_at, Unix ms, somente antes da primeira resposta). Requer tickets:write.",
    input: {
      profile,
      ticket_id: { type: "string" },
      text: { type: "string" },
      status: { type: "string", enum: ticketStatuses },
      category: { type: "string", maxLength: 100 },
      owner: { type: "string" },
      response_due_at: { type: "integer" },
      idempotency_key: idempotency,
    },
    required: ["ticket_id"],
    call: (a, id) => ({
      method: "PATCH",
      path: p(id, `/tickets/${a.ticket_id}`),
      body: pick(a, ["text", "status", "category", "owner", "response_due_at"]),
    }),
  },
  {
    name: "list_contacts",
    description:
      "Busca na agenda de contatos desta aplicação (q por nome, telefone, e-mail ou empresa). Requer contacts:read.",
    input: { profile, q: { type: "string", maxLength: 200 }, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/contacts"),
      query: pick(a, ["q", "cursor", "limit"]),
    }),
  },
  {
    name: "get_contact",
    description:
      "Contato com até 50 conversas recentes (estas exigem também conversations:read). Requer contacts:read.",
    input: { profile, contact_id: { type: "string" } },
    required: ["contact_id"],
    call: (a, id) => ({ path: p(id, `/contacts/${a.contact_id}`) }),
  },
  {
    name: "create_contact",
    description:
      "Cadastra um contato na agenda desta aplicação. Não envia mensagens nem une cadastros pelo telefone. Requer contacts:write.",
    input: { profile, ...contactFields, idempotency_key: idempotency },
    required: ["name"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/contacts"),
      body: pick(a, Object.keys(contactFields)),
    }),
  },
  {
    name: "update_contact",
    description:
      "Atualiza campos de um contato. expected_version vem de get_contact; versão antiga retorna 409. Requer contacts:write.",
    input: {
      profile,
      contact_id: { type: "string" },
      expected_version: { type: "integer", minimum: 1 },
      ...contactFields,
      idempotency_key: idempotency,
    },
    required: ["contact_id", "expected_version"],
    call: (a, id) => ({
      method: "PATCH",
      path: p(id, `/contacts/${a.contact_id}`),
      body: pick(a, ["expected_version", ...Object.keys(contactFields)]),
    }),
  },
  {
    name: "link_conversation_contact",
    description:
      "Vincula um contato existente (contact_id) à conversa ou cria o contato com os campos informados. Requer contacts:write e conversations:read.",
    input: {
      profile,
      conversation_id: conversationId,
      contact_id: { type: "string" },
      ...contactFields,
      idempotency_key: idempotency,
    },
    required: ["conversation_id"],
    call: (a, id) => ({
      method: "PUT",
      path: p(id, `/conversations/${a.conversation_id}/contact`),
      body: a.contact_id
        ? { contact_id: a.contact_id }
        : pick(a, Object.keys(contactFields)),
    }),
  },
  {
    name: "list_knowledge",
    description:
      "Lista as fontes da base de conhecimento da área. Requer knowledge:read.",
    input: { profile, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/knowledge"),
      query: pick(a, ["cursor", "limit"]),
    }),
  },
  {
    name: "add_knowledge",
    description:
      "Cadastra conhecimento: kind text (com text), url ou youtube (com url). Importações de URL são assíncronas. Requer knowledge:write.",
    input: {
      profile,
      title: { type: "string" },
      kind: { type: "string", enum: ["text", "url", "youtube"] },
      text: { type: "string" },
      url: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["title", "kind"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/knowledge"),
      body: pick(a, ["title", "kind", "text", "url"]),
    }),
  },
  {
    name: "list_bots",
    description:
      "Lista os bots que esta aplicação pode executar. Requer bots:read.",
    input: { profile },
    call: (_a, id) => ({ path: p(id, "/bots") }),
  },
  {
    name: "run_bot",
    description:
      "Enfileira a execução de um bot autorizado com o texto de entrada e retorna {id,status:queued}. Acompanhe com get_bot_run. Requer bots:invoke.",
    input: {
      profile,
      bot_id: { type: "string" },
      input: { type: "string", maxLength: 60000 },
      idempotency_key: idempotency,
    },
    required: ["bot_id", "input"],
    call: (a, id) => ({
      method: "POST",
      path: "/bot-runs",
      body: { profile_id: id, bot_id: a.bot_id, input: a.input },
    }),
  },
  {
    name: "get_bot_run",
    description:
      "Estado e resultado de uma execução: queued, starting, running, cancelling, cancelled, completed, failed ou unknown. Requer bots:invoke.",
    input: { bot_run_id: { type: "string" } },
    required: ["bot_run_id"],
    call: (a) => ({ path: `/bot-runs/${a.bot_run_id}` }),
  },
  {
    name: "list_bot_runs",
    description: "Execuções desta aplicação na área. Requer bots:invoke.",
    input: { profile, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/bot-runs"),
      query: pick(a, ["cursor", "limit"]),
    }),
  },
  {
    name: "cancel_bot_run",
    description:
      "Solicita o cancelamento de uma execução; não desfaz efeitos já produzidos. Requer bots:invoke.",
    input: {
      profile,
      bot_run_id: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["bot_run_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/bot-runs/${a.bot_run_id}/cancel`),
      body: {},
    }),
  },
  {
    name: "list_presence",
    description:
      "Pessoas da área e se estão presentes para atendimento humano. Requer presence:read.",
    input: { profile },
    call: (_a, id) => ({ path: p(id, "/presence") }),
  },
  {
    name: "list_events",
    description:
      "Eventos incrementais da área (até 100) após o cursor numérico informado. Retorna {data,cursor}. Requer events:read.",
    input: { profile, after: { type: "integer", minimum: 0 } },
    call: (a, id) => ({ path: p(id, "/events"), query: pick(a, ["after"]) }),
  },
  {
    name: "get_report",
    description:
      "Relatório por seção (conversations, tickets, messages, deliveries, surveys, consents, runs, knowledge) e período start/end em YYYY-MM-DD (São Paulo). Requer reports:read.",
    input: {
      profile,
      section: {
        type: "string",
        enum: [
          "conversations",
          "tickets",
          "messages",
          "deliveries",
          "surveys",
          "consents",
          "runs",
          "knowledge",
        ],
      },
      start: { type: "string" },
      end: { type: "string" },
      cursor,
      limit,
    },
    required: ["section"],
    call: (a, id) => ({
      path: p(id, "/reports"),
      query: pick(a, ["section", "start", "end", "cursor", "limit"]),
    }),
  },
  {
    name: "list_consents",
    description:
      "Consentimentos registrados para templates e notificações. Requer conversations:read.",
    input: { profile, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/consents"),
      query: pick(a, ["cursor", "limit"]),
    }),
  },
  {
    name: "list_deliveries",
    description:
      "Fila de entregas aos canais com estado e erro. Requer conversations:read.",
    input: { profile, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/deliveries"),
      query: pick(a, ["cursor", "limit"]),
    }),
  },
  {
    name: "list_groups",
    description: "Conversas de grupo do WhatsApp. Requer conversations:read.",
    input: { profile, cursor, limit },
    call: (a, id) => ({
      path: p(id, "/groups"),
      query: pick(a, ["cursor", "limit"]),
    }),
  },
  {
    name: "get_connection_capabilities",
    description:
      "Recursos disponíveis em um canal (mídias, grupos, reações, edição). Consulte antes de oferecer uma função. Requer conversations:read.",
    input: { profile, connection_id: { type: "string" } },
    required: ["connection_id"],
    call: (a, id) => ({
      path: p(id, `/connections/${a.connection_id}/capabilities`),
    }),
  },
  {
    name: "router_overview",
    description:
      "Números e grupos de roteamento WhatsApp autorizados à aplicação, com políticas e uso mensal. Requer routing:read.",
    input: { profile },
    call: (_a, id) => ({ path: p(id, "/router") }),
  },
  {
    name: "send_router_message",
    description:
      "Envia texto ou um anexo pelo roteador WhatsApp (number_id ou pool_id) para um telefone, dentro da janela de 24 horas. external_id identifica o cliente e mantém o remetente. Retorna delivery_id; acompanhe com get_router_message. Templates pagos não estão disponíveis por esta ferramenta. Requer routing:send.",
    input: {
      profile,
      number_id: { type: "string" },
      pool_id: { type: "string" },
      to: {
        type: "string",
        description:
          "Telefone com DDI e DDD, somente dígitos. Obrigatório no primeiro envio.",
      },
      external_id: { type: "string", maxLength: 200 },
      conversation_id: { type: "string" },
      text: { type: "string", maxLength: 4096 },
      attachments: { type: "array", maxItems: 1, items: { type: "string" } },
      content,
      expires_at: { type: "integer" },
      idempotency_key: idempotency,
    },
    required: ["external_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, "/router/messages"),
      body: pick(a, [
        "number_id",
        "pool_id",
        "to",
        "external_id",
        "conversation_id",
        "text",
        "attachments",
        "content",
        "expires_at",
      ]),
    }),
  },
  {
    name: "get_router_message",
    description:
      "Estado de uma entrega do roteador (pending, sent, delivered, failed, cancelled ou unknown). Requer routing:read.",
    input: { profile, delivery_id: { type: "string" } },
    required: ["delivery_id"],
    call: (a, id) => ({ path: p(id, `/router/messages/${a.delivery_id}`) }),
  },
  {
    name: "cancel_router_message",
    description:
      "Cancela uma entrega ainda pendente no roteador. Requer routing:send.",
    input: {
      profile,
      delivery_id: { type: "string" },
      idempotency_key: idempotency,
    },
    required: ["delivery_id"],
    call: (a, id) => ({
      method: "POST",
      path: p(id, `/router/messages/${a.delivery_id}/cancel`),
      body: {},
    }),
  },
  {
    name: "list_router_templates",
    description:
      "Templates aprovados de um número WhatsApp conectado pela Zernio. Requer routing:read.",
    input: { profile, number_id: { type: "string" } },
    required: ["number_id"],
    call: (a, id) => ({
      path: p(id, `/router/numbers/${a.number_id}/templates`),
    }),
  },
];

/**
 * Ferramentas do núcleo e as declaradas pelos módulos (src/modules/api.ts,
 * onMcpTool). Chamadas a módulo desligado recebem o 409 da própria rota.
 */
const allTools = (enabled?: Set<string>): Tool[] => [
  ...tools,
  ...moduleMcpTools()
    // Módulo desligado em todas as áreas da credencial: a ferramenta some.
    .filter((t) => !enabled || enabled.has(t.module))
    .map((t): Tool => ({
      ...t,
      input: {
        profile,
        ...t.input,
        ...(t.write ? { idempotency_key: idempotency } : {}),
      },
    })),
];
const findTool = (name: string) => allTools().find((t) => t.name === name);

/** Módulos ligados em ao menos uma área que a credencial alcança. */
async function enabledModules(env: Env, actor: Actor) {
  const areas =
    actor.role === "admin"
      ? (await all(env, "SELECT id FROM profiles")).map((p) => p.id as string)
      : actor.profiles;
  const enabled = new Set<string>();
  const rows = areas.length
    ? await all(
        env,
        "SELECT profile_id,module_id,enabled FROM profile_modules WHERE profile_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(areas),
      )
    : [];
  for (const area of areas) {
    const states = resolveStates(
      Object.fromEntries(
        rows
          .filter((r) => r.profile_id === area)
          .map((r) => [r.module_id, r.enabled]),
      ),
    );
    for (const [id, on] of Object.entries(states)) if (on) enabled.add(id);
  }
  return enabled;
}

/**
 * Ferramentas de uma chave restrita ao atendimento (conversations:bound,
 * conferência A1): as da conversa em atendimento e catálogos. As de módulo
 * são todas de atendimento (só recebem conversation_id).
 */
const BOUND_CORE_TOOLS = new Set([
  "list_profiles",
  "get_conversation",
  "claim_conversation",
  "reply_conversation",
  "add_internal_note",
  "transfer_conversation",
  "resolve_conversation",
  "tag_conversation",
  "send_menu",
  "list_forms",
  "send_form",
  "list_web_steps",
  "lookup_conversation_protocols",
  "message_action",
  "create_ticket",
  "update_ticket",
  "list_knowledge",
]);
const toolAllowed = (actor: Actor, tool: Tool) =>
  !isBound(actor) ||
  BOUND_CORE_TOOLS.has(tool.name) ||
  !tools.some((t) => t.name === tool.name);

export const toolList = (enabled?: Set<string>, actor?: Actor) =>
  allTools(enabled)
    .filter((t) => !actor || toolAllowed(actor, t))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object",
        properties: t.input,
        ...(t.required?.length ? { required: t.required } : {}),
      },
    }));

function coerce(schema: Row, value: any) {
  if (
    schema.type === "integer" &&
    typeof value === "string" &&
    /^-?\d+$/.test(value)
  )
    return Number(value);
  if (schema.type === "boolean" && (value === "true" || value === "false"))
    return value === "true";
  return value;
}
function validate(tool: Tool, raw: any) {
  if (raw !== undefined && (typeof raw !== "object" || Array.isArray(raw)))
    throw new RpcError(-32602, "arguments deve ser um objeto.");
  const args: Row = {};
  for (const [key, schema] of Object.entries<Row>(tool.input)) {
    const value = coerce(schema, raw?.[key]);
    if (value === undefined || value === null) continue;
    const t = schema.type;
    const bad =
      (t === "string" && typeof value !== "string") ||
      (t === "integer" && !Number.isInteger(value)) ||
      (t === "boolean" && typeof value !== "boolean") ||
      (t === "array" && !Array.isArray(value)) ||
      (t === "object" && (typeof value !== "object" || Array.isArray(value)));
    if (bad) throw new RpcError(-32602, `Parâmetro ${key} deve ser ${t}.`);
    if (schema.enum && !schema.enum.includes(value))
      throw new RpcError(
        -32602,
        `Parâmetro ${key} deve ser um de: ${schema.enum.join(", ")}.`,
      );
    args[key] = value;
  }
  for (const key of tool.required || [])
    if (args[key] === undefined || args[key] === "")
      throw new RpcError(-32602, `Parâmetro obrigatório: ${key}.`);
  return args;
}
// Identificador que pode virar segmento de caminho: sem "/", "?", "#", "%",
// espaço, e nunca "." ou ".." sozinhos.
const PATH_ID = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$/;
const MARK = "~~";
function resolveProfile(tool: Tool, args: Row, actor: Actor) {
  if (!("profile" in tool.input)) return "";
  if (args.profile) {
    const id = String(args.profile);
    if (!PATH_ID.test(id) || !canProfile(actor, id))
      throw new RpcError(
        -32602,
        "profile inválido ou fora das áreas da chave.",
      );
    return id;
  }
  if (actor.profiles.length === 1) return actor.profiles[0];
  throw new RpcError(
    -32602,
    actor.profiles.length
      ? `Informe profile; a chave acessa várias áreas: ${actor.profiles.join(", ")}.`
      : "A chave não acessa nenhuma área de atendimento.",
  );
}

/**
 * Monta a chamada sem deixar argumento mudar a rota (revisão A1): o modelo do
 * caminho sai da própria ferramenta com marcadores no lugar dos argumentos;
 * cada argumento que cai no caminho precisa ser um identificador (PATH_ID) e
 * entra codificado. O caminho final tem de ser exatamente o modelo preenchido.
 */
export function checkedCall(tool: Tool, args: Row, profile: string): Call {
  const mark = (key: string) => `${MARK}${key}${MARK}`;
  const marked: Row = {};
  for (const [k, v] of Object.entries(args))
    marked[k] = typeof v === "string" && v !== "" ? mark(k) : v;
  const template = tool.call(marked, mark("profile")).path;
  const used = new Set<string>();
  const expected = template.replace(
    new RegExp(`${MARK}(\\w+)${MARK}`, "g"),
    (_m, key: string) => {
      const value = key === "profile" ? profile : String(args[key]);
      if (!PATH_ID.test(value))
        throw new RpcError(
          -32602,
          `Parâmetro ${key} inválido: use o identificador devolvido pela API.`,
        );
      used.add(key);
      return encodeURIComponent(value);
    },
  );
  if (expected.includes(MARK) || /[?#]/.test(expected))
    throw new RpcError(-32603, "Modelo de caminho inválido na ferramenta.");
  // Argumentos que caem no caminho, codificados; o resto da chamada (corpo e
  // consulta) usa os valores originais.
  const encoded: Row = { ...args };
  for (const key of used)
    if (key !== "profile") encoded[key] = encodeURIComponent(args[key]);
  const path = tool.call(encoded, encodeURIComponent(profile)).path;
  if (path !== expected)
    throw new RpcError(
      -32602,
      "Caminho da ferramenta não confere com o modelo.",
    );
  return { ...tool.call(args, profile), path };
}

let appRef: Hono<Bindings> | null = null;
/**
 * Chamada interna à API v1 com um ator já conferido, fora de uma requisição
 * (bot agindo pela pessoa, src/bot-actions). Passa pelos mesmos middlewares
 * de uma chamada HTTP: área, módulo desligado, acesso por pessoa, comando no
 * Coordinator com Idempotency-Key. Nunca grava a origem pública.
 */
export async function internalCall(
  env: Env,
  actor: Actor,
  call: Call,
  key?: string,
) {
  // A entrada do Worker monta o app (mountMcp) ao carregar; fora dela
  // (Coordinator, testes que importam o motor), carregar a entrada basta.
  if (!appRef) await import("./index");
  if (!appRef) throw new Error("API interna indisponível.");
  const url = new URL("/api/v1" + call.path, "https://wabotia.internal");
  if (url.pathname !== "/api/v1" + call.path || url.search || url.hash)
    throw new ApiError(400, "invalid_request", "Caminho inválido.");
  for (const [k, v] of Object.entries(call.query || {}))
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  const method = call.method || "GET";
  const nonce = crypto.randomUUID();
  const headers: Row = { [INTERNAL_HEADER]: nonce, Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = key || crypto.randomUUID();
  }
  internalActors.set(nonce, actor);
  try {
    return await appRef!.request(
      url.toString(),
      {
        method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      },
      env,
    );
  } finally {
    internalActors.delete(nonce);
  }
}

export function mountMcp(app: Hono<Bindings>) {
  appRef = app;
  async function dispatch(c: any, actor: Actor, call: Call, key?: string) {
    const url = new URL("/api/v1" + call.path, new URL(c.req.url).origin);
    // Nada de normalização ("..", "."), consulta ou fragmento vindos do caminho.
    if (url.pathname !== "/api/v1" + call.path || url.search || url.hash)
      throw new RpcError(-32602, "Caminho da ferramenta inválido.");
    for (const [k, v] of Object.entries(call.query || {}))
      if (v !== undefined && v !== null && v !== "")
        url.searchParams.set(k, String(v));
    const method = call.method || "GET";
    const nonce = crypto.randomUUID();
    const headers: Row = {
      [INTERNAL_HEADER]: nonce,
      Accept: "application/json",
    };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = key || crypto.randomUUID();
    }
    let ctx: any;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    internalActors.set(nonce, actor);
    try {
      return await app.request(
        url.toString(),
        {
          method,
          headers,
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
        },
        c.env,
        ctx,
      );
    } finally {
      internalActors.delete(nonce);
    }
  }
  async function callTool(c: any, actor: Actor, params: any) {
    const tool = findTool(String(params?.name || ""));
    if (!tool || !toolAllowed(actor, tool))
      throw new RpcError(-32602, `Ferramenta desconhecida: ${params?.name}`);
    const args = validate(tool, params?.arguments);
    const profile = resolveProfile(tool, args, actor);
    const response = await dispatch(
      c,
      actor,
      checkedCall(tool, args, profile),
      args.idempotency_key,
    );
    const text = await response.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* resposta não JSON permanece como texto */
    }
    if (!response.ok) {
      const error = data?.error || {};
      const retry = response.headers.get("Retry-After");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Erro HTTP ${response.status}` +
              (error.code ? ` ${error.code}` : "") +
              `: ${error.message || (typeof data === "string" ? data.slice(0, 500) : "Falha na API.")}` +
              (error.request_id ? ` (request_id ${error.request_id})` : "") +
              (retry ? ` Aguarde ${retry} s antes de repetir.` : ""),
          },
        ],
      };
    }
    const shaped = tool.shape ? tool.shape(data, args) : data;
    return {
      content: [
        {
          type: "text",
          text: typeof shaped === "string" ? shaped : JSON.stringify(shaped),
        },
      ],
      ...(shaped && typeof shaped === "object" && !Array.isArray(shaped)
        ? { structuredContent: shaped }
        : {}),
    };
  }
  // Ferramentas do bot agindo pela pessoa (src/bot-actions), só com o
  // cabeçalho assinado da execução que o plugin do Hermes repõe.
  async function personTool(person: BotActionContext, params: any) {
    const runId = person.run.id;
    const state = personStates.get(runId) || newToolState();
    state.proposals = (await proposalsOfRun(person.env, runId)).length;
    personStates.set(runId, state);
    const text = await runBotTool(
      person,
      state,
      String(params?.name || ""),
      params?.arguments,
    );
    const failed = /^\{"erro"/.test(text);
    return {
      ...(failed ? { isError: true } : {}),
      content: [{ type: "text", text }],
    };
  }
  async function handle(
    c: any,
    actor: Actor,
    message: any,
    person: BotActionContext | null = null,
  ) {
    const id = message?.id;
    const isRequest = id !== undefined && id !== null;
    const reply = (result: any) =>
      isRequest ? { jsonrpc: "2.0", id, result } : null;
    try {
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string"
      )
        throw new RpcError(-32600, "Requisição JSON-RPC inválida.");
      const { method, params } = message;
      if (method === "initialize") {
        const asked = String(params?.protocolVersion || "");
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "wabotia",
            title: c.env.APP_NAME || "Wabotia",
            version: buildInfo.version,
          },
          instructions: INSTRUCTIONS,
        });
      }
      if (method === "ping") return reply({});
      if (method === "tools/list")
        return reply({
          tools: [
            ...toolList(await enabledModules(c.env, actor), actor),
            ...(person
              ? BOT_TOOLS.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.schema,
                }))
              : []),
          ],
        });
      if (method === "tools/call") {
        if (person && BOT_TOOLS.some((t) => t.name === params?.name))
          return reply(await personTool(person, params));
        return reply(await callTool(c, actor, params));
      }
      if (method.startsWith("notifications/")) return null;
      throw new RpcError(-32601, `Método não suportado: ${method}`);
    } catch (error: any) {
      if (!isRequest) return null;
      const rpc = error instanceof RpcError;
      if (!rpc && !(error instanceof ApiError))
        console.error(
          JSON.stringify({
            request_id: c.get("requestId"),
            error: "mcp_internal_error",
          }),
        );
      return {
        jsonrpc: "2.0",
        id,
        error: rpc
          ? {
              code: error.code,
              message: error.message,
              ...(error.data ? { data: error.data } : {}),
            }
          : error instanceof ApiError
            ? {
                code: -32000,
                message: error.message,
                data: { code: error.code, status: error.status },
              }
            : {
                code: -32603,
                message: "Não foi possível concluir a operação.",
              },
      };
    }
  }
  app.on(["GET", "DELETE", "PUT", "PATCH"], MCP_PATH, (c) => {
    c.header("Allow", "POST");
    return c.json(
      {
        error: {
          code: "method_not_allowed",
          message:
            "Endpoint MCP Streamable HTTP sem sessão: use POST com JSON-RPC.",
        },
      },
      405,
    );
  });
  app.post(MCP_PATH, async (c) => {
    const actor = await authenticate(c.env, c.req.raw);
    if (actor.kind !== "app")
      throw new ApiError(
        403,
        "app_key_required",
        "O MCP aceita somente chaves de aplicação emitidas em API e integrações.",
      );
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "JSON inválido." },
        },
        400,
      );
    }
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length)
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Lote vazio." },
        },
        400,
      );
    // Execução de conversa interna de um bot desta chave, assinada pelo
    // Wabotia no job do plugin: as ferramentas da pessoa aparecem e rodam
    // como ela. Sem o cabeçalho, ou inválido, nada muda.
    const person = await runFromHeader(
      c.env,
      actor,
      c.req.header(RUN_HEADER) ?? null,
    );
    const responses = [];
    for (const message of messages) {
      const response = await handle(c, actor, message, person);
      if (response) responses.push(response);
    }
    if (!responses.length) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });
}
