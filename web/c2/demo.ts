/** Cenários sintéticos, sem conta real, credencial, rede ou persistência.
 * Entrada: /app?demo=1&canais=2; cenário opcional: &cenario=email-unknown.
 * Formato do plano; a conferir com a conta real. */
import type { ChannelDemoHandler, ChannelDemoReply, ChannelDemoRequest, ChannelUiData } from "../channel-extension-contracts";
import type { ChannelAction, ChannelExtensionView } from "../../src/channel-c2-contracts";

export const C2_DEMO_FIXTURE_NOTE = "Formato do plano; a conferir com a conta real. Nenhuma mensagem real é enviada.";
export const C2_DEMO_SCENARIOS = [
  "all", "none", "comments-two-authors", "comments-two-posts", "comment-hidden", "comment-private-sent",
  "comment-private-failed", "comment-private-expired", "telegram-expired-button", "telegram-phone-self",
  "telegram-phone-third-party", "telegram-large-media", "telegram-blocked", "telegram-rate-limited",
  "google-disabled", "google-only", "google-new", "google-replaced", "google-deleted", "google-restored",
  "google-partial", "google-forbidden", "google-pending", "google-failed", "google-unknown",
  "email-text", "email-hostile-html", "email-subject-changed", "email-attachments", "email-unverified",
  "email-forged-auth", "email-automatic", "email-bounce", "email-blocked", "email-quarantine", "email-test-received",
  "email-test-inconclusive", "email-quota", "email-unknown", "tiktok-nine", "tiktok-two-slots",
  "tiktok-tenth", "tiktok-eleventh", "tiktok-echo", "tiktok-external", "tiktok-two-deliveries",
] as const;
export type C2DemoScenario = typeof C2_DEMO_SCENARIOS[number];
type Row = Record<string, unknown>;
type Conversation = Row & { id: string; channel: string; contact_id: string; connection_id: string;
  channel_extension: ChannelExtensionView; updated: number; state: string };
export interface C2DemoEvent {
  id: string; conversationId: string; messageId: string; text: string; created: number;
  content?: ChannelUiData; external?: boolean;
}
const HOUR = 3_600_000;
const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const fail = (code: string, message: string, status = 400): never => { throw Object.assign(new Error(message), { code, status }); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(record(value)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Estado de demonstração isolado. A autorização é parte do cenário, nunca do corpo recebido. */
export function createC2Demo(scenario: C2DemoScenario = "all", clock: () => number = Date.now) {
  const started = clock();
  const conversations: Conversation[] = [];
  const messages = new Map<string, Row[]>();
  const reviews: Row[] = [];
  const inbox: Row[] = [];
  const events = new Set<string>();
  const receipts = new Map<string, { signature: string; result: Row }>();
  const connections = new Map<string, Row>();
  const publishers = new Set<string>();
  const blocks = new Map<string, Row>();
  const deliveries = new Map<string, Row[]>();
  let canReply = scenario !== "google-forbidden";
  let isAdmin = scenario !== "google-forbidden";
  const enabled = (name: C2DemoScenario) => scenario === "all" || scenario === name;
  function connection(channel: string): string {
    const id = `demo-c2-connection-${channel}`;
    if (!connections.has(id)) connections.set(id, { id, name: `${channel === "email" ? "E-mail" : channel === "googlebusiness" ? "Google" : channel} · Demonstração`,
      channel, kind: channel === "email" ? "email" : channel === "telegram" ? "telegram_bot" : "zernio",
      status: "active", configured: true, credential: "configurado", send_ready: channel === "email",
      config: channel === "email" ? { address: "atendimento@example.test", bot_enabled: false, auto_ack_enabled: false }
        : channel === "telegram" ? { username: "vinki_demo_bot", webhook_configured: true }
          : { comments_enabled: channel === "instagram" || channel === "facebook" } });
    return id;
  }
  function add(name: C2DemoScenario, channel: string, title: string, metadata: ChannelExtensionView["metadata"], text: string,
    extra: Row = {}): Conversation {
    const id = `demo-c2-${name}`;
    const comment = !!metadata.comment;
    const row: Conversation = { id, profile_id: "demo", channel, connection_id: connection(channel),
      contact_id: `demo-c2-contact-${name}`, contact_name: title, phone: null, state: "human", owner: "demo-user",
      chat_type: comment ? "comment" : "direct", account_label: "Conta sintética", external_id: `synthetic:${name}`,
      channel_context: JSON.stringify({ version: 1, context: comment ? "comment" : "direct", multichannel: true }),
      tags: "[]", created: started - 2 * HOUR, updated: started - HOUR, last_customer: started - HOUR,
      department_id: null, assigned_bot_id: null,
      channel_extension: { capabilities: {}, metadata }, ...extra };
    conversations.push(row); messages.set(row.id, []); deliveries.set(row.id, []);
    if (text) applyEvent({ id: `event:${row.id}`, conversationId: row.id, messageId: `${row.id}:received`, text, created: started - HOUR,
      content: metadata.email ? { email: metadata.email } : metadata.comment ? { comment: metadata.comment } : {} });
    return row;
  }
  function applyEvent(event: C2DemoEvent) {
    const row = conversations.find(item => item.id === event.conversationId);
    if (!row || scenario === "none" || scenario === "google-disabled") return { ignored: true, duplicate: false };
    const target = messages.get(row.id)!;
    if (events.has(event.id) || target.some(message => message.id === event.messageId)) return { duplicate: true };
    events.add(event.id);
    target.push({ id: event.messageId, profile_id: "demo", conversation_id: row.id,
      direction: event.external ? "outbound" : "customer", kind: "text", text: event.text,
      created: event.created, attachments: "[]", content: JSON.stringify(event.content ?? {}),
      ...(event.external ? { actor: "external", origin: "external" } : {}) });
    row.updated = Math.max(row.updated, event.created);
    if (event.external && row.channel_extension.metadata.tiktok) {
      const quota = row.channel_extension.metadata.tiktok;
      quota.remainingMessages = Math.max(0, quota.remainingMessages - 1);
    }
    return { duplicate: false };
  }
  for (const name of C2_DEMO_SCENARIOS.filter(name => name.startsWith("comment"))) if (enabled(name)) {
    const expired = name === "comment-private-expired";
    const privateState = name === "comment-private-sent" ? "sent" : name === "comment-private-failed" ? "failed" : "available";
    const row = add(name, name === "comment-hidden" ? "facebook" : "instagram", "Ana · comentário", {
      identityTrust: "channel", comment: { id: `comment:${name}`, postId: "post:verao", text: "Qual é o horário?",
        postText: "Novidades de verão na loja", hidden: name === "comment-hidden", version: 1,
        privateState, privateExpiresAt: expired ? started - HOUR : started + 167 * HOUR,
        privateLinkPending: privateState === "sent", permalink: name === "comment-hidden"
          ? "https://www.facebook.com/demo-c2-sintetico/posts/1" : "https://www.instagram.com/p/demo-c2-sintetico/" },
    }, "Qual é o horário?", { contact_id: "demo-c2-contact-ana" });
    if (name === "comments-two-authors") add("comments-two-posts", "instagram", "Bruno · comentário", {
      identityTrust: "channel", comment: { ...row.channel_extension.metadata.comment!, id: "comment:bruno", text: "Vocês entregam?" },
    }, "Vocês entregam?", { id: "demo-c2-comment-bruno", contact_id: "demo-c2-contact-bruno" });
    if (name === "comments-two-posts") {
      row.channel_extension.metadata.comment!.postId = "post:inverno";
      row.channel_extension.metadata.comment!.postText = "Novidades de inverno";
      if (scenario !== "all") add("comments-two-authors", "instagram", "Ana · outra publicação", {
        identityTrust: "channel", comment: { ...row.channel_extension.metadata.comment!, id: "comment:ana-verao", postId: "post:verao" },
      }, "Também gostei da coleção de verão.", { contact_id: "demo-c2-contact-ana" });
    }
  }
  for (const name of C2_DEMO_SCENARIOS.filter(name => name.startsWith("telegram"))) if (enabled(name)) {
    const telegram = { username: "vinki_demo_bot", botUrl: "https://t.me/vinki_demo_bot",
      blocked: name === "telegram-blocked", webhookConfigured: true,
      ...(name === "telegram-phone-self" ? { phoneSuggestion: { masked: "+55 •• •••••-1234", confirmedByHuman: false as const } } : {}) };
    const code = name === "telegram-expired-button" ? "callback_expired" : name === "telegram-phone-third-party" ? "contact_not_self"
      : name === "telegram-large-media" ? "attachment_too_large" : name === "telegram-blocked" ? "blocked"
        : name === "telegram-rate-limited" ? "rate_limited" : undefined;
    const row = add(name, "telegram", "Pessoa do Telegram", { identityTrust: "channel", telegram,
      ...(name === "telegram-rate-limited" ? { state: "retry" } : {}) }, "Olá! Preciso de atendimento.");
    const message = messages.get(row.id)![0];
    message.content = JSON.stringify({ telegram: { ...telegram, warning: code,
      callbackState: name === "telegram-expired-button" ? "expired" : undefined,
      contactState: name === "telegram-phone-third-party" ? "not_self" : name === "telegram-phone-self" ? "suggested" : undefined } });
    if (name === "telegram-rate-limited") deliveries.get(row.id)!.push({ id: "telegram:429", status: "retry", error: "rate_limited", not_before: started + 30_000 });
  }
  const googleScenarios = C2_DEMO_SCENARIOS.filter(name => name.startsWith("google") && !["google-disabled", "google-only"].includes(name));
  for (const name of googleScenarios) if (enabled(name) || (scenario === "google-only" && name === "google-new")) {
    const id = `demo-c2-${name}`;
    reviews.push({ id, profile_id: "demo", connection_id: connection("googlebusiness"), account_id: "google:loja",
      account_label: "Loja Demonstração", remote_id: id, rating: name === "google-new" ? 5 : 3,
      text: "Atendimento atencioso. Café excelente!", author_name: "Pessoa sintética", author_picture: "", permalink: "",
      state: name === "google-deleted" ? "deleted" : "active", restored: name === "google-restored",
      version: name === "google-restored" ? 3 : 1, reply_text: name === "google-replaced" ? "Obrigada! Atualizamos nossa resposta." : "",
      reply_at: name === "google-replaced" ? started : null, published_at: started - HOUR,
      provider_updated_at: started, created: started - HOUR, updated: started,
      reply_state: name === "google-pending" ? "pending" : name === "google-failed" ? "failed" : name === "google-unknown" ? "unknown"
        : name === "google-replaced" ? "sent" : undefined });
  }
  for (const name of C2_DEMO_SCENARIOS.filter(name => name.startsWith("email"))) if (enabled(name)) {
    connection("email");
    if (["email-automatic", "email-bounce", "email-blocked", "email-quarantine"].includes(name)) {
      inbox.push({ id: `inbox:${name}`, sender: name === "email-bounce" ? "" : "remetente@example.test",
        subject: name === "email-bounce" ? "Aviso de devolução" : name === "email-quarantine" ? "Mensagem em quarentena" : "Resposta automática", state: name === "email-blocked" ? "blocked" : name === "email-quarantine" ? "quarantine" : "automatic",
        reason: name === "email-bounce" ? "delivery_report" : name === "email-blocked" ? "address_blocked" : "auto_submitted" });
      continue;
    }
    if (name === "email-test-received" || name === "email-test-inconclusive") continue;
    const email = { subject: name === "email-subject-changed" ? "Pedido 123 · https://example.test/pedido/123" : "Informações sobre o café",
      sender: "cliente+loja@example.test", from: name === "email-forged-auth" ? "outra-pessoa@example.test" : "cliente+loja@example.test",
      replyTo: name === "email-forged-auth" ? "destino-diferente@example.test" : "cliente+loja@example.test",
      identityTrust: "unverified_sender" as const,
      authentication: name === "email-forged-auth" ? [{ method: "dmarc", result: "pass" }, { method: "spf", result: "pass" }] : [],
      attachmentWarnings: name === "email-attachments" ? ["Anexo recusado: tipo não permitido."] : [] };
    const row = add(name, "email", "Remetente não confirmado", { identityTrust: "unverified_sender", email, subject: email.subject,
      ...(name === "email-unknown" ? { state: "unknown" } : name === "email-quota" ? { state: "quota_exhausted" } : {}) },
    name === "email-hostile-html" ? "Olá, equipe! Conteúdo convertido em texto. Nenhum recurso remoto foi carregado." : "Olá! Gostaria de informações sobre preços e horários.");
    if (name === "email-attachments") messages.get(row.id)![0].content = JSON.stringify({ email,
      safeAttachments: [{ name: "cardápio.pdf", state: "accepted" }, { name: "arquivo.exe", state: "rejected" }] });
    if (name === "email-subject-changed") {
      applyEvent({ id: "email:subject-changed", conversationId: row.id,
        messageId: `${row.id}:changed`, text: "Mudei o assunto para identificar o pedido.", created: started,
        content: { email: { ...email, subject: "Entrega do pedido 123" } } });
      row.channel_extension.metadata.email = { ...email, subject: "Entrega do pedido 123" };
      row.channel_extension.metadata.subject = "Entrega do pedido 123";
    }
  }
  for (const name of C2_DEMO_SCENARIOS.filter(name => name.startsWith("tiktok"))) if (enabled(name)) {
    const row = add(name, "tiktok", "Pessoa do TikTok", { identityTrust: "channel",
      tiktok: { remainingMessages: name === "tiktok-eleventh" ? 0 : name === "tiktok-two-deliveries" ? 2 : 1,
        closesAt: started + 47 * HOUR, conservativeQuota: true } },
    "Olá! Gostaria de conhecer a loja.");
    if (name === "tiktok-external") applyEvent({ id: "tiktok:external", conversationId: row.id,
      messageId: "tiktok:external:message", text: "Resposta enviada pelo aplicativo.", created: started, external: true });
  }

  function googleView() {
    return { data: clone(reviews), next_cursor: scenario === "google-partial" ? "synthetic:page:2" : null,
      partial: scenario === "google-partial", permissions: { can_read: true, can_reply: canReply, is_admin: isAdmin },
      publishers: [...publishers].map(user_id => ({ user_id, permission: "google.reply" })) };
  }
  function view(row: Conversation) {
    const metadata = row.channel_extension.metadata;
    const blocked = metadata.telegram?.blocked === true;
    return { channel: row.channel, multichannel: true, account_label: row.account_label, subject: row.channel === "email",
      public_reply: !!metadata.comment, modules: false, can_initiate: row.channel === "email", templates: false,
      menu: { buttons: row.channel === "telegram" ? 8 : 0, quickReplies: 0, listItems: 0, fallback: "numbered_text" },
      window: { kind: row.channel === "tiktok" ? "customer" : "none", state: blocked ? "closed" : "open", serverNow: clock(),
        closesAt: metadata.tiktok?.closesAt ?? null, humanTextClosesAt: null,
        remainingMessages: metadata.tiktok?.remainingMessages ?? null, canHumanText: !blocked,
        canAutomation: !blocked && !metadata.comment && row.channel !== "email", reason: blocked ? "O bot foi bloqueado pelo cliente." : null } };
  }
  function detail(row: Conversation) {
    return { ...view(row), conversation: { ...row, ...view(row) }, channel_extension: row.channel_extension,
      connection_kind: row.channel === "telegram" ? "telegram_bot" : row.channel === "email" ? "email" : "zernio",
      server_now: clock(), messages: messages.get(row.id), media: [], group: null, deliveries: deliveries.get(row.id),
      comments: row.channel_extension.metadata.comment ? [row.channel_extension.metadata.comment] : [],
      can_reply: true, capabilities: { ...view(row), text: true, image: row.channel !== "email", document: row.channel === "email",
        audio: row.channel === "telegram", video: row.channel === "telegram", contacts: false, location: false,
        reply: false, edit: false, delete: false, reaction: false, read: true, groups: false, group_manage: false, calls: false },
      contact: { id: row.contact_id, name: row.contact_name, email: "cliente+loja@example.test", phone: null, version: 1,
        channel_status: { can_reply: true, connections: [...connections.values()],
          channel_extensions: [...connections.values()].filter(item => ["email", "telegram", "tiktok"].includes(String(item.channel))).map(item => `${item.channel}/direct`) } },
      other_conversations: conversations.filter(other => other.id !== row.id && other.contact_id === row.contact_id)
        .map(other => ({ id: other.id, channel: other.channel, title: other.contact_name, state: other.state, updated: other.updated })) };
  }
  function mutate(path: string, method: string, body: unknown, key: string | undefined, change: () => Row) {
    if (!key) return fail("idempotency_required", "Informe a chave idempotente.");
    const signature = canonical({ path, method, body });
    const old = receipts.get(key);
    if (old) {
      if (old.signature !== signature) return fail("idempotency_conflict", "Esta chave pertence a outro pedido.", 409);
      return { ...clone(old.result), duplicate: true };
    }
    const result = change();
    receipts.set(key, { signature, result: clone(result) });
    return result;
  }
  function action(row: Conversation, input: Row): Row {
    const rawAction = record(input.channel_action);
    const value = rawAction as unknown as ChannelAction;
    const metadata = row.channel_extension.metadata;
    if (input.action !== "channel" || typeof value.type !== "string") return fail("invalid_action", "Selecione uma ação do canal.");
    if (["message.send", "email.send", "comment.reply", "comment.private", "comment.suggest"].includes(value.type) && typeof rawAction.text !== "string")
      return fail("invalid_text", "Informe o texto da ação.");
    if (rawAction.attachments !== undefined && (!Array.isArray(rawAction.attachments) || rawAction.attachments.some(item => {
      const attachment = record(item);
      return typeof attachment.mediaId !== "string" || !attachment.mediaId || typeof attachment.mimeType !== "string"
        || typeof attachment.bytes !== "number" || !Number.isFinite(attachment.bytes) || attachment.bytes < 0;
    }))) return fail("invalid_attachment", "Revise os anexos da mensagem.");
    if (metadata.comment) {
      if (!("commentId" in value) || value.commentId !== metadata.comment.id || !value.type.startsWith("comment.")) return fail("invalid_target", "Selecione o comentário alvo.");
      if (value.type === "comment.suggest") return { status: "suggestion", suggestion: "Olá! Nossa equipe pode ajudar. Revise antes de publicar." };
      if (value.type === "comment.visibility") {
        if (typeof value.hidden !== "boolean") return fail("invalid_action", "Informe a situação de ocultação.");
        metadata.comment.hidden = value.hidden; metadata.comment.version++; return { status: "sent" };
      }
      if (value.type === "comment.private") {
        if (metadata.comment.privateState !== "available") return fail("private_reply_used", "A tentativa privada já foi consumida.", 409);
        if (!metadata.comment.privateExpiresAt || metadata.comment.privateExpiresAt <= clock()) return fail("private_reply_expired", "O prazo para a resposta privada terminou.", 409);
        metadata.comment.privateState = "sent"; metadata.comment.privateLinkPending = true;
        return { status: "sent", privateLinkPending: true };
      }
      if (value.type !== "comment.reply") return fail("invalid_action", "A publicação exige uma ação humana explícita.");
    } else if (row.channel === "email") {
      if (value.type !== "email.send" || typeof value.subject !== "string" || value.subject.length > 200 || /[\r\n\0]/.test(value.subject)) return fail("subject_invalid", "Revise o assunto do e-mail.");
      if (metadata.state === "quota_exhausted") return fail("quota_exhausted", "O limite de envio foi atingido.", 429);
      if (metadata.state === "unknown") return { status: "unknown", code: "delivery_unknown" };
    } else if (row.channel === "telegram") {
      if (metadata.telegram?.blocked) return fail("blocked", "O cliente bloqueou o bot.", 409);
      if (value.type === "telegram.request-contact") return { status: "pending" };
      if (value.type !== "message.send") return fail("invalid_action", "Ação incompatível com o canal.");
      if (metadata.state === "retry") return { status: "retry", code: "rate_limited", not_before: clock() + 30_000 };
    } else if (row.channel === "tiktok") {
      if (value.type !== "message.send") return fail("invalid_action", "Ação incompatível com o canal.");
      if (value.text.length > 6000) return fail("invalid_text", "Use até 6.000 caracteres.");
      if ((value.attachments?.length ?? 0) > 1 || value.attachments?.some(attachment => attachment.kind !== "image" || !["image/jpeg", "image/png"].includes(attachment.mimeType) || attachment.bytes < 1 || attachment.bytes > 3_000_000))
        return fail("invalid_attachment", "Use uma imagem JPG ou PNG de até 3.000.000 bytes.");
      const slots = (value.text ? 1 : 0) + (value.attachments?.length ?? 0);
      const quota = metadata.tiktok!;
      if (!quota.closesAt || quota.closesAt <= clock()) return fail("window_closed", "A janela de 48 horas terminou.", 409);
      if (!slots || slots > quota.remainingMessages) return fail("quota_exhausted", "Não há vagas para todas as entregas.", 429);
      quota.remainingMessages -= slots;
    }
    const id = `demo-c2-output:${receipts.size + 1}`;
    if (row.channel === "tiktok" && value.type === "message.send") {
      const parts: { kind: string; text: string; attachments: string[] }[] = [
        ...(value.text ? [{ kind: "text", text: value.text, attachments: [] }] : []),
        ...(value.attachments ?? []).map(attachment => ({ kind: "image", text: "", attachments: [attachment.mediaId] })),
      ];
      const ids = parts.map((part, index) => {
        const partId = `${id}:${index + 1}`;
        messages.get(row.id)!.push({ id: partId, direction: "outbound", kind: part.kind, text: part.text,
          created: clock() + index, actor: "demo-user", attachments: JSON.stringify(part.attachments),
          content: JSON.stringify({ tiktok: { deliveryIndex: index + 1, deliveryCount: parts.length } }) });
        return partId;
      });
      return { status: "sent", delivery_id: ids[0], provider_message_id: ids[0], delivery_ids: ids, provider_message_ids: ids };
    }
    messages.get(row.id)!.push({ id, direction: "outbound", kind: "text", text: "text" in value ? value.text : "",
      created: clock(), actor: "demo-user", attachments: "[]", content: JSON.stringify(value.type === "email.send" ? { email: { subject: value.subject } } : {}) });
    return { status: "sent", delivery_id: id, provider_message_id: id };
  }
  function request(path: string, method = "GET", body?: unknown, key?: string, legacy?: ChannelDemoRequest["legacy"]): ChannelDemoReply {
    if (scenario === "none" || scenario === "google-disabled") return { handled: false };
    const [pathname, search = ""] = path.split("?");
    const query = new URLSearchParams(search);
    const rest = pathname.replace(/^\/?(?:api\/)?v1\/profiles\/[^/]+\/?/, "");
    const result = (data: unknown): ChannelDemoReply => ({ handled: true, data: clone(data) });
    const input = record(body);
    if (method === "GET" && rest === "status") {
      const previous = record(legacy?.(pathname, query));
      const newChannels = [...new Set([...connections.values()].map(row => String(row.channel)).filter(channel => channel !== "googlebusiness"))];
      const connected = [...new Set([...list(previous.connections).map(row => row.channel), ...connections.values()].map(value => typeof value === "string" ? value : record(value).channel).filter(Boolean))];
      return result({ ...previous, c2_active: true, can_reply: true,
        connected_channels: [...new Set([...(Array.isArray(previous.connected_channels) ? previous.connected_channels : []), ...connected])],
        conversation_channels: [...new Set([...(Array.isArray(previous.conversation_channels) ? previous.conversation_channels : ["whatsapp"]), ...newChannels])],
        ...(newChannels.length ? { multichannel: true } : {}),
        channel_extensions: [...new Set([...conversations.map(row => `${row.channel}/${row.chat_type}`),
          ...newChannels.filter(channel => ["email", "telegram", "tiktok"].includes(channel)).map(channel => `${channel}/direct`)]), ...(reviews.length ? ["googlebusiness/review"] : [])],
        connections: [...list(previous.connections), ...connections.values()],
        conversations: ["waiting", "ai", "human", "closed"].map(state => ({ state,
          count: Number(list(previous.conversations).find(row => row.state === state)?.count ?? 0) + conversations.filter(row => row.state === state).length })),
        google_reviews: googleView(), fixture_note: C2_DEMO_FIXTURE_NOTE });
    }
    if (method === "GET" && rest === "connections") return result({ data: [...connections.values()] });
    if (method === "POST" && rest === "connections" && ["email", "telegram_bot"].includes(String(input.kind))) {
      if (!isAdmin) return fail("forbidden", "Ação administrativa.", 403);
      return result(mutate(rest, method, body, key, () => {
        const channel = input.kind === "email" ? "email" : "telegram";
        const id = connection(channel), row = connections.get(id)!;
        const config = record(input.config);
        // Lista permitida: o token informado nunca entra na projeção ou no recibo.
        row.config = channel === "email" ? { address: typeof config.address === "string" ? config.address.toLowerCase() : "atendimento@example.test",
          bot_enabled: config.bot_enabled === true, auto_ack_enabled: config.auto_ack_enabled === true }
          : { username: "vinki_demo_bot", webhook_configured: false };
        row.status = "pending";
        return { id, channel, status: "pending", configured: true };
      }));
    }
    if (method === "GET" && rest === "conversations") {
      const previous = record(legacy?.(pathname, new URLSearchParams()));
      const channel = query.get("channel"), state = query.get("state"), q = (query.get("q") ?? "").toLocaleLowerCase("pt-BR");
      const combined: Row[] = [...list(previous.data), ...conversations.map(row => ({ ...row, ...view(row) }))];
      const rows = combined.filter(row => (!channel || (row.channel ?? "whatsapp") === channel) && (!state || row.state === state)
          && (!q || String(row.contact_name ?? "").toLocaleLowerCase("pt-BR").includes(q)))
        .sort((a, b) => Number(b.updated) - Number(a.updated) || String(b.id).localeCompare(String(a.id)));
      const limit = Math.min(50, Math.max(1, Number(query.get("limit")) || 50));
      const scope = [channel, state, q].join("|");
      let offset = 0;
      if (query.has("cursor")) {
        try { const cursor = record(JSON.parse(query.get("cursor")!)); if (cursor.scope !== scope || !Number.isInteger(cursor.offset) || Number(cursor.offset) < 0) throw Error(); offset = Number(cursor.offset); }
        catch { return fail("invalid_cursor", "A página pertence a outro filtro."); }
      }
      return result({ data: rows.slice(offset, offset + limit), next_cursor: offset + limit < rows.length ? JSON.stringify({ scope, offset: offset + limit }) : null });
    }
    const conversation = /^conversations\/([^/]+)(?:\/(message-actions))?$/.exec(rest);
    if (conversation) {
      const row = conversations.find(item => item.id === conversation[1]);
      if (!row) return { handled: false };
      if (method === "GET" && !conversation[2]) return result(detail(row));
      if (method === "POST" && conversation[2]) return result(mutate(rest, method, body, key, () => action(row, input)));
    }
    if (method === "GET" && rest === "c2/reviews") return result(googleView());
    const reviewRoute = /^c2\/reviews\/([^/]+)(?:\/(reply|suggestion))?$/.exec(rest);
    if (reviewRoute && reviewRoute[1] !== "sync") {
      const row = reviews.find(item => item.id === reviewRoute[1]);
      if (!row) return fail("not_found", "Avaliação não encontrada.", 404);
      if (method === "GET") return result(row);
      if (!canReply) return fail("forbidden", "Sem permissão para publicar no Google.", 403);
      if (row.state === "deleted") return fail("review_deleted", "A avaliação foi excluída.", 409);
      return result(mutate(rest, method, body, key, () => {
        if (input.version !== row.version) return fail("resource_changed", "A avaliação mudou. Atualize antes de publicar.", 409);
        if (reviewRoute[2] === "suggestion" && method === "POST") return { suggestion: "Obrigada pela avaliação! Revise antes de publicar.", status: "suggestion" };
        if (reviewRoute[2] !== "reply" || !["PUT", "DELETE"].includes(method)) return fail("invalid_action", "Ação inválida.");
        if (row.reply_state === "pending" || row.reply_state === "unknown") return fail("delivery_pending", "Aguarde a conclusão ou reconciliação da resposta anterior.", 409);
        if (method === "PUT" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000)) return fail("invalid_text", "Use até 4.000 caracteres.");
        row.reply_state = "pending";
        return { status: "pending", delivery_id: `demo-review:${receipts.size + 1}` };
      }));
    }
    if (rest === "c2/reviews/sync" && method === "POST") {
      if (!isAdmin) return fail("forbidden", "Ação administrativa.", 403);
      return result(mutate(rest, method, body, key, () => ({ status: "pending", historical_import: false })));
    }
    const grant = /^c2\/review-publishers\/([^/]+)$/.exec(rest);
    if (grant && ["PUT", "DELETE"].includes(method)) {
      if (!isAdmin) return fail("forbidden", "Ação administrativa.", 403);
      return result(mutate(rest, method, body, key, () => { method === "PUT" ? publishers.add(grant[1]) : publishers.delete(grant[1]); return { status: "saved" }; }));
    }
    const setup = /^c2\/connections\/([^/]+)\/(setup|email-test|email-inbox|email-blocks)$/.exec(rest);
    if (setup) {
      if (!isAdmin) return fail("forbidden", "Ação administrativa.", 403);
      const row = connections.get(setup[1]);
      if (!row) return fail("not_found", "Conexão não encontrada.", 404);
      if (method === "GET" && setup[2] === "setup") return result({ ...row, ...record(row.config),
        test_state: scenario === "email-test-received" ? "received" : scenario === "email-test-inconclusive" ? "expired" : "pending" });
      if (method === "GET" && setup[2] === "email-inbox") return result({ data: inbox.filter(item => !query.get("state") || item.state === query.get("state")), next_cursor: null });
      if (method === "GET" && setup[2] === "email-blocks") return result({ data: [...blocks.values()] });
      return result(mutate(rest, method, body, key, () => {
        if (setup[2] === "email-test" && method === "POST") return { status: "pending", state: "pending", expires_at: clock() + 600_000 };
        if (setup[2] === "email-blocks" && ["PUT", "DELETE"].includes(method)) {
          if (!["address", "domain"].includes(String(input.kind)) || typeof input.value !== "string" || !input.value.trim()) return fail("invalid_block", "Informe endereço ou domínio.");
          const blockKey = `${input.kind}:${input.value.trim().toLowerCase()}`;
          method === "PUT" ? blocks.set(blockKey, { kind: input.kind, value: input.value.trim().toLowerCase() }) : blocks.delete(blockKey);
          return { status: "saved" };
        }
        if (setup[2] === "setup" && method === "POST") return { status: "pending", configured: true };
        return fail("invalid_action", "Ação inválida.");
      }));
    }
    if (rest === "c2/conversations/email" && method === "POST") return result(mutate(rest, method, body, key, () => {
      const row = connections.get(String(input.connectionId));
      if (!row || row.channel !== "email" || !row.send_ready || !input.contactId) return fail("email_not_ready", "Selecione uma conexão de envio pronta.");
      if (input.confirmed !== true || typeof input.address !== "string" || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(input.address)) return fail("recipient_confirmation_required", "Confirme o endereço de destino.");
      const address = input.address.toLowerCase();
      let conversation = conversations.find(item => item.channel_extension.metadata.email?.sender === address);
      if (!conversation) conversation = add("email-text", "email", "Novo e-mail", { identityTrust: "unverified_sender",
        email: { subject: "", sender: address, identityTrust: "unverified_sender" } }, "", { id: `demo-c2-new-email:${receipts.size + 1}`, contact_id: `operational:${address}` });
      return { conversation_id: conversation.id, status: "pending" };
    }));
    return { handled: false };
  }
  return { request, applyEvent,
    setPublishAllowed(value: boolean) { canReply = value; if (!value) isAdmin = false; },
    snapshot: () => clone({ conversations, messages: Object.fromEntries(messages), reviews, inbox,
      connections: [...connections.values()], events: [...events], receipts: [...receipts.values()].map(item => item.result) }) };
}

const browserDemos = new Map<C2DemoScenario, ReturnType<typeof createC2Demo>>();
/** A base chama este handler somente após opt-in. Importar não instala o registro. */
export const c2DemoHandler: ChannelDemoHandler = request => {
  const selected = request.query.get("cenario") ?? "all";
  const scenario = C2_DEMO_SCENARIOS.includes(selected as C2DemoScenario) ? selected as C2DemoScenario : "all";
  if (!browserDemos.has(scenario)) browserDemos.set(scenario, createC2Demo(scenario));
  return browserDemos.get(scenario)!.request(request.path, request.method, request.body, request.key, request.legacy);
};
export function resetC2Demo(): void { browserDemos.clear(); }
