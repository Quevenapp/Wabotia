// Cenários sintéticos; não são capturas de contas reais nem fazem chamadas de rede.
// Abra /app?demo=1&channels=multichannel. Sem `channels`, a vitrine original continua intacta.
import type {
  ChannelId, ChannelView, TranscriptOptions, TranscriptPreview,
  TranscriptPreviewRequest, TranscriptSendRequest, TranscriptSendResult, WindowState,
} from "../../src/channel-contracts";
import type { Row } from "./api";
import { dispatchChannelDemo } from "../channel-extensions";

export const CHANNEL_DEMO_SCENARIOS = [
  "whatsapp", "multichannel", "legacy", "email-unavailable", "email-forbidden",
  "email-unknown", "email-failed", "email-queued",
] as const;
export type ChannelDemoScenario = typeof CHANNEL_DEMO_SCENARIOS[number];

/** Declarados, mas sem formulário, conexão, importação ou envio nesta leva. */
export const FUTURE_DEMO_CHANNELS = [
  { channel: "tiktok", context: "direct", enabled: false },
  { channel: "googlebusiness", context: "review", enabled: false },
  { channel: "telegram", context: "direct", enabled: false },
  { channel: "email", context: "direct", enabled: false },
  { channel: "instagram", context: "comment", enabled: false },
  { channel: "facebook", context: "comment", enabled: false },
] as const;

const HOUR = 3_600_000;
const limits: TranscriptOptions["limits"] = {
  maxMessages: 2000, maxTextChars: 50_000, maxHtmlChars: 200_000,
  actorPer24Hours: 10, profilePer24Hours: 50, previewTtlMs: 600_000,
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const fail = (code: string, message: string, status = 400): never => {
  throw Object.assign(new Error(message), { code, status });
};

export function demoTranscriptOptions(mode = "available"): TranscriptOptions {
  return {
    available: mode === "available",
    reason: mode === "forbidden" ? "Sem permissão para enviar conversas por e-mail."
      : mode === "unavailable" ? "Configure o envio em Gestão → Sistema → E-mail." : null,
    destinations: mode === "forbidden" ? [] : ["self", "contact", "custom"],
    ranges: ["session", "dates"], limits: { ...limits },
  };
}

/** Janela simulada de servidor, com os mesmos limites inclusivos de A5. */
export function demoChannelWindow(lastCustomer: number, now: number): WindowState {
  const valid = lastCustomer > 0 && lastCustomer <= now;
  const age = now - lastCustomer;
  const state = !valid || age >= 168 * HOUR ? "closed"
    : age >= 24 * HOUR ? "human_text_only" : "open";
  return {
    kind: "customer", state, serverNow: now,
    closesAt: valid ? lastCustomer + 24 * HOUR : null,
    humanTextClosesAt: valid ? lastCustomer + 168 * HOUR : null,
    remainingMessages: null, canHumanText: state !== "closed", canAutomation: state === "open",
    reason: state === "closed" ? "A janela terminou. Aguarde uma nova mensagem do contato."
      : state === "human_text_only" ? "Até 7 dias, somente texto escrito por uma pessoa. Mídia e automações estão bloqueadas." : null,
  };
}

export interface DemoChannelEvent {
  id: string;
  conversationId: string;
  messageId: string;
  text: string;
  created: number;
  mediaUnavailable?: boolean;
}
type DemoReply = { handled: false } | { handled: true; data: any };
type LegacyRead = (path: string, query: URLSearchParams) => any;

/** Instância isolada para testes e demonstração. As únicas escritas são recibos fictícios em memória. */
export function createChannelDemo(
  scenario: ChannelDemoScenario = "multichannel",
  clock: () => number = Date.now,
) {
  const started = clock();
  const rows: Row[] = [];
  const messages = new Map<string, Row[]>();
  const events: Row[] = [];
  const seenEvents = new Set<string>();
  const previews = new Map<string, {
    conversationId: string; preview: TranscriptPreview; body: TranscriptPreviewRequest;
  }>();
  const receipts = new Map<string, { body: string; result: TranscriptSendResult }>();
  let nextPreview = 0;

  function view(row: Row): ChannelView {
    const social = row.channel !== "whatsapp";
    return {
      channel: row.channel, account_label: row.account_label, multichannel: true,
      window: social ? demoChannelWindow(row.last_customer, clock()) : {
        ...demoChannelWindow(row.last_customer, clock()), humanTextClosesAt: null,
      },
      templates: !social, menu: { buttons: 3, quickReplies: social ? 13 : 3, listItems: social ? 0 : 10, fallback: "numbered_text" },
      subject: false, public_reply: false, modules: !social, can_initiate: !social,
    };
  }

  function add(id: string, channel: ChannelId, name: string, ageHours: number, extra: Row = {}) {
    const row: Row = {
      id, profile_id: "demo", chat_type: "direct", state: "human", owner: "demo-user",
      channel, account_label: channel === "instagram" ? "@loja_demo" : channel === "facebook" ? "Loja Demonstração" : "WhatsApp Oficial",
      connection_id: "demo-cn-line-" + channel, external_namespace: "channel:demo-cn-line-" + channel,
      external_id: "synthetic-subject:" + id, phone: channel === "whatsapp" ? "5511999990100" : null,
      contact_name: name, contact_id: "demo-cn-contact-" + id,
      channel_context: JSON.stringify({ version: 1, context: "direct", multichannel: true }),
      tags: "[]", department_id: null, assigned_bot_id: null,
      created: started - 200 * HOUR, updated: started - ageHours * HOUR,
      last_customer: started - ageHours * HOUR, ...extra,
    };
    rows.push(row);
    messages.set(id, []);
    applyEvent({ id: "synthetic-event:" + id, conversationId: id, messageId: id + "-m1",
      text: ageHours >= 168 ? "Conversa há 7 dias; aguardando nova mensagem."
        : ageHours >= 24 ? "Esta conversa demonstra a extensão de texto humano." : "Olá! Preciso de ajuda com meu pedido.",
      created: row.last_customer,
    });
  }

  function applyEvent(event: DemoChannelEvent) {
    const row = rows.find((item) => item.id === event.conversationId);
    if (!row) return fail("not_found", "Conversa sintética não encontrada.", 404);
    const key = event.conversationId + ":" + event.id;
    const list = messages.get(row.id)!;
    if (seenEvents.has(key) || list.some((message) => message.id === event.messageId))
      return { duplicate: true, messageId: event.messageId };
    seenEvents.add(key);
    const text = event.text + (event.mediaUnavailable ? "\n[Anexo indisponível: não foi possível copiar a mídia.]" : "");
    const message = {
      id: event.messageId, conversation_id: row.id, external_id: "synthetic:" + event.messageId,
      author: "customer", direction: "customer", text, created: event.created,
      attachments: "[]", content: JSON.stringify({ customerSession: "session:" + row.id,
        ...(event.mediaUnavailable ? { media_unavailable: true } : {}) }), delivery_status: null,
    };
    list.push(message);
    list.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    row.updated = Math.max(row.updated, event.created);
    if (Number.isFinite(event.created) && event.created > 0 && event.created <= clock())
      row.last_customer = Math.max(row.last_customer, event.created);
    const last = list[list.length - 1];
    row.last_message = { text: last.text, direction: last.direction, created: last.created, attachments: 0, kind: "text" };
    events.push({ id: events.length + 1, kind: "message.created", resource_id: row.id,
      payload: { conversation_id: row.id, channel: row.channel, multichannel: true, direction: "customer", text }, created: event.created });
    return { duplicate: false, messageId: event.messageId };
  }

  add("demo-cn-wa", "whatsapp", "Marina Silva", 2, { contact_id: "demo-cn-marina" });
  add("demo-cn-ig-open", "instagram", "Marina Silva", 1, { contact_id: "demo-cn-marina" });
  add("demo-cn-ig-human", "instagram", "Camila Rodrigues", 25);
  add("demo-cn-fb-closed", "facebook", "Rafael Souza", 168);
  add("demo-cn-fb-media", "facebook", "Paulo Santos", 3);
  add("demo-cn-email-unavailable", "instagram", "E-mail sem configuração", 4);
  add("demo-cn-email-forbidden", "facebook", "E-mail sem permissão", 5);
  add("demo-cn-email-dates", "instagram", "Histórico sem sessão delimitada", 6, { session_unavailable: true });
  messages.get("demo-cn-email-dates")![0].content = "{}";
  const mediaEvent: DemoChannelEvent = { id: "synthetic-media-repeated", conversationId: "demo-cn-fb-media",
    messageId: "demo-cn-unavailable-media", text: "Enviei uma imagem com o problema.", created: started - 2 * HOUR, mediaUnavailable: true };
  applyEvent(mediaEvent);
  applyEvent(mediaEvent);
  messages.get("demo-cn-ig-open")!.push({ id: "demo-cn-note", conversation_id: "demo-cn-ig-open",
    direction: "note", author: "demo-user", text: "Nota interna: nunca entra no e-mail.",
    created: started - 0.5 * HOUR, attachments: "[]", content: "{}" });

  function options(row: Row): TranscriptOptions {
    const allowed = demoTranscriptOptions(scenario === "email-forbidden" || row.id === "demo-cn-email-forbidden" ? "forbidden"
      : scenario === "email-unavailable" || row.id === "demo-cn-email-unavailable" ? "unavailable" : "available");
    return row.session_unavailable ? { ...allowed, ranges: ["dates"] } : allowed;
  }

  function capabilities(row: Row) {
    const social = row.channel !== "whatsapp";
    return { ...view(row), text: true, document: true, image: true, video: true, audio: true,
      voice: !social, sticker: false, reply: !social, reaction: !social, location: !social, contacts: !social,
      edit: !social, delete: !social, read: true, mentions: !social, groups: !social, group_manage: !social,
      calls: false, video_calls: false, upgrade_required: false };
  }

  function detail(row: Row) {
    const related = rows.filter((other) => other.id !== row.id && other.contact_id === row.contact_id);
    return {
      ...view(row), conversation: { ...row, ...view(row) }, connection_kind: "zernio", server_now: clock(),
      capabilities: capabilities(row), media: [], group: null, deliveries: [],
      contact: { id: row.contact_id, name: row.contact_name, phone: row.phone, email: "marina@example.test", version: 1 },
      messages: messages.get(row.id), email_transcript: options(row),
      other_conversations: related.map((other) => ({ id: other.id, channel: other.channel, account_label: other.account_label,
        title: other.contact_name, state: other.state, updated: other.updated })),
    };
  }

  function preview(row: Row, body: TranscriptPreviewRequest): TranscriptPreview {
    const allowed = options(row);
    if (!allowed.available) return fail(allowed.destinations.length ? "email_not_configured" : "forbidden", allowed.reason!, 403);
    if (!body?.destination || !allowed.destinations.includes(body.destination.kind))
      return fail("invalid_destination", "Selecione um destino permitido.");
    const recipient = body.destination.kind === "self" ? "equipe@example.test"
      : body.destination.kind === "contact" ? "marina@example.test"
        : typeof body.destination.address === "string" ? body.destination.address.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return fail("invalid_email", "Informe um e-mail válido.");
    if (!body.range || !allowed.ranges.includes(body.range.kind)) return fail("invalid_range", "Escolha o intervalo.");
    const period = body.range.kind === "dates" ? { from: body.range.from, to: body.range.to }
      : { from: row.last_customer, to: clock() };
    if (!Number.isFinite(period.from) || !Number.isFinite(period.to) || period.from > period.to)
      return fail("invalid_range", "O início deve ser anterior ao fim do intervalo.");
    const selected = messages.get(row.id)!.filter((message) => ["customer", "outbound"].includes(message.direction)
      && message.created >= period.from && message.created <= period.to
      && (body.range.kind !== "session" || JSON.parse(message.content).customerSession === "session:" + row.id));
    const chars = selected.reduce((sum, message) => sum + message.text.length, 0);
    if (!selected.length) return fail("empty_range", "Nenhuma mensagem pública neste intervalo.");
    if (selected.length > limits.maxMessages || chars > limits.maxTextChars)
      return fail("range_too_large", "Escolha um intervalo menor; nenhuma mensagem será cortada.");
    const result: TranscriptPreview = {
      recipient, period, messageCount: selected.length, size: { textChars: chars, htmlChars: chars * 2 },
      warnings: ["Demonstração: nenhum e-mail real será enviado.", "Notas internas e arquivos não são incluídos.",
        ...(body.destination.kind === "custom" ? ["CPF e CNPJ serão mascarados para o destino digitado."] : [])],
      requiresConfirmation: body.destination.kind !== "self", requiresCustomerRequest: body.destination.kind === "contact",
      previewToken: "synthetic-preview-" + ++nextPreview, expiresAt: clock() + limits.previewTtlMs,
    };
    previews.set(result.previewToken, { conversationId: row.id, preview: result, body: clone(body) });
    return clone(result);
  }

  function send(row: Row, body: TranscriptSendRequest, key?: string): TranscriptSendResult {
    const allowed = options(row);
    if (!allowed.available) return fail(allowed.destinations.length ? "email_not_configured" : "forbidden", allowed.reason!, 403);
    if (!key) return fail("idempotency_required", "A chave de envio é obrigatória.");
    const stored = previews.get(body?.previewToken);
    if (!stored || stored.conversationId !== row.id) return fail("invalid_preview", "Gere uma nova prévia.");
    const signature = JSON.stringify({ conversationId: row.id, previewToken: body.previewToken,
      confirmedRecipient: body.confirmedRecipient || "", customerRequested: body.customerRequested === true });
    const existing = receipts.get(key);
    if (existing) {
      if (existing.body !== signature) return fail("idempotency_conflict", "Esta chave já foi usada com outro envio.", 409);
      return { ...existing.result, duplicate: true };
    }
    const approved = stored.preview;
    if (approved.expiresAt <= clock()) return fail("preview_expired", "A prévia expirou. Confira o destinatário novamente.", 409);
    if (approved.requiresConfirmation && body.confirmedRecipient !== approved.recipient)
      return fail("recipient_confirmation_required", "Confirme exatamente o endereço exibido.");
    if (approved.requiresCustomerRequest && body.customerRequested !== true)
      return fail("customer_request_required", "Confirme que o contato solicitou esta cópia.");
    if (receipts.size >= limits.actorPer24Hours) return fail("email_quota", "Limite diário de demonstração atingido.", 429);
    const status = scenario === "email-unknown" ? "unknown" : scenario === "email-failed" ? "failed"
      : scenario === "email-queued" ? "queued" : "sent";
    const result: TranscriptSendResult = { id: "synthetic-email-" + (receipts.size + 1), status,
      to_masked: approved.recipient[0] + "***@" + approved.recipient.split("@")[1], duplicate: false };
    receipts.set(key, { body: signature, result });
    return { ...result };
  }

  function request(path: string, method = "GET", body?: any, key?: string, legacy?: LegacyRead): DemoReply {
    if (scenario === "whatsapp" || scenario === "legacy") return { handled: false };
    const [pathname, search = ""] = path.split("?");
    const query = new URLSearchParams(search);
    const rest = pathname.replace(/^v1\/profiles\/demo\/?/, "");
    const result = (data: any): DemoReply => ({ handled: true, data: clone(data) });
    if (method === "GET" && rest === "status") {
      const previous = legacy?.(pathname, query) || {};
      const oldCounts = new Map((previous.conversations || []).map((item: Row) => [item.state, item.count]));
      return result({ ...previous, multichannel: true,
        connected_channels: ["whatsapp", "instagram", "facebook"], conversation_channels: ["whatsapp", "instagram", "facebook"],
        email_transcript: demoTranscriptOptions(scenario === "email-forbidden" ? "forbidden" : scenario === "email-unavailable" ? "unavailable" : "available"),
        conversations: ["waiting", "ai", "human", "closed"].map((state) => ({ state,
          count: Number(oldCounts.get(state) || 0) + rows.filter((row) => row.state === state).length })),
        connections: [...(previous.connections || []), ...["whatsapp", "instagram", "facebook"].map((channel) => ({
          id: "demo-cn-line-" + channel, name: channel === "instagram" ? "Instagram · @loja_demo" : channel === "facebook" ? "Facebook · Loja Demonstração" : "WhatsApp Oficial",
          kind: "zernio", channel, status: "active", account_label: rows.find((row) => row.channel === channel)?.account_label,
        }))],
      });
    }
    if (method === "GET" && rest === "conversations") {
      const channel = query.get("channel");
      if (channel && !["whatsapp", "instagram", "facebook"].includes(channel)) return fail("invalid_channel", "Canal não habilitado na demonstração.");
      const previous = legacy?.(pathname, new URLSearchParams())?.data || [];
      const q = (query.get("q") || "").toLocaleLowerCase("pt-BR");
      const selected = [...previous, ...rows.map((row) => ({ ...row, ...view(row) }))]
        .filter((row) => (!channel || (row.channel || "whatsapp") === channel)
          && (!query.get("state") || row.state === query.get("state"))
          && (!query.get("department_id") || row.department_id === query.get("department_id"))
          && (!q || `${row.contact_name || ""} ${row.phone || ""}`.toLocaleLowerCase("pt-BR").includes(q)))
        .sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id));
      const limit = Math.max(1, Math.min(50, Number(query.get("limit")) || 50));
      const scope = [channel || "", query.get("state") || "", query.get("department_id") || "", q].join("|");
      let offset = 0;
      if (query.get("cursor")) {
        try {
          const cursor = JSON.parse(query.get("cursor")!);
          if (cursor.scope !== scope || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw Error();
          offset = cursor.offset;
        } catch { return fail("invalid_cursor", "A paginação pertence a outro filtro."); }
      }
      return result({ data: selected.slice(offset, offset + limit),
        next_cursor: selected.length > offset + limit ? JSON.stringify({ scope, offset: offset + limit }) : null });
    }
    const match = rest.match(/^conversations\/([^/]+)(?:\/(email(?:\/preview)?))?$/);
    if (match) {
      const row = rows.find((item) => item.id === match[1]);
      if (!row) return { handled: false };
      if (method === "GET" && !match[2]) return result(detail(row));
      if (method === "POST" && match[2] === "email/preview") return result(preview(row, body));
      if (method === "POST" && match[2] === "email") return result(send(row, body, key));
    }
    const capabilityMatch = rest.match(/^connections\/(demo-cn-line-[^/]+)\/capabilities$/);
    if (method === "GET" && capabilityMatch) {
      const row = rows.find((item) => item.connection_id === capabilityMatch[1]);
      if (row) return result(capabilities(row));
    }
    return { handled: false };
  }

  return {
    request, applyEvent, mediaEvent: clone(mediaEvent),
    snapshot: () => clone({ conversations: rows.map((row) => ({ ...row, ...view(row) })),
      messages: Object.fromEntries(messages), events, receipts: [...receipts.values()].map((item) => item.result),
      futureChannels: FUTURE_DEMO_CHANNELS }),
  };
}

const browserDemos = new Map<ChannelDemoScenario, ReturnType<typeof createChannelDemo>>();
/** Encaixe único em demo.ts; cenários dos módulos passam pelo leitor original. */
export function demoChannelRequest(path: string, method: string, body: any, key: string | undefined, legacy: LegacyRead): DemoReply {
  const extension = dispatchChannelDemo({ path, method, body, key, legacy,
    query: new URLSearchParams(typeof location === "undefined" ? "" : location.search) });
  if (extension.handled) return extension;
  const selected = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("channels");
  if (!CHANNEL_DEMO_SCENARIOS.includes(selected as ChannelDemoScenario)) return { handled: false };
  const scenario = selected as ChannelDemoScenario;
  if (!browserDemos.has(scenario)) browserDemos.set(scenario, createChannelDemo(scenario));
  return browserDemos.get(scenario)!.request(path, method, body, key, legacy);
}
