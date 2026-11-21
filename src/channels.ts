import { ApiError } from "./types";
import { channelImplementationReady } from "./channel-ports";
import { channelExtension, channelExtensionReady, extensionKey } from "./channel-extension-registry";
import type {
  ChannelCapabilities, ChannelConnection, ChannelContext, ChannelId,
  ChannelSpec, MediaKind, SendOrigin, WindowState,
} from "./channel-contracts";

export type {
  ChannelConnection, ChannelContext, ChannelId, ChannelSpec, ChannelView,
  MediaKind, SendOrigin, WindowState,
} from "./channel-contracts";

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

/** Limites LOCAIS do Vinki, incluindo assinatura no texto. Formatos, limites
 * remotos e interpretações do fornecedor: a conferir com a conta real.
 * O adaptador deve recusar MIME não validado e separar texto em entregas
 * ordenadas, cada qual com chave própria; nunca truncar silenciosamente. */
export const SOCIAL_LOCAL_LIMITS = Object.freeze({
  textChars: 640,
  imageBytes: 3 * MiB,
  audioBytes: 8 * MiB,
  videoBytes: 8 * MiB,
  documentBytes: 8 * MiB,
});

const noMenu: ChannelSpec["menu"] = {
  buttons: 0, quickReplies: 0, listItems: 0, fallback: "numbered_text",
};
const direct = { enabled: true, bot: true, publicReply: false };
const publicDisabled = { enabled: false, bot: false, publicReply: true };
const media = (maxSendBytes: number | null, mimeTypes: readonly string[]) => ({
  receive: true, send: true, maxSendBytes, mimeTypes,
});
const officialMedia: ChannelSpec["media"] = {
  image: media(5 * MiB, ["image/jpeg", "image/png"]),
  video: media(16 * MiB, ["video/mp4", "video/3gpp"]),
  audio: media(16 * MiB, ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"]),
  document: media(100 * MiB, [
    "text/plain", "application/pdf", "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]),
  sticker: { ...media(0.5 * MiB, ["image/webp"]), receive: false, send: false },
};
const socialMedia: ChannelSpec["media"] = {
  image: media(SOCIAL_LOCAL_LIMITS.imageBytes, ["image/jpeg", "image/png"]),
  video: media(SOCIAL_LOCAL_LIMITS.videoBytes, ["video/mp4"]),
  audio: media(SOCIAL_LOCAL_LIMITS.audioBytes, ["audio/mpeg", "audio/mp4"]),
  document: media(SOCIAL_LOCAL_LIMITS.documentBytes, ["application/pdf"]),
};
const social = (id: "instagram" | "facebook", label: string): ChannelSpec => ({
  id, label, enabled: false, transport: "zernio", serviceLine: true,
  contexts: { direct, comment: publicDisabled },
  text: { enabled: true, maxChars: SOCIAL_LOCAL_LIMITS.textChars },
  // Facebook pode admitir outros documentos após validação explícita no adaptador.
  media: socialMedia,
  menu: { buttons: 3, quickReplies: 13, listItems: 0, fallback: "numbered_text" },
  window: { kind: "customer", hours: 24, humanTextHours: 168, after: "human_text" },
  initiation: "customer_first", templates: false, subject: false, replyTo: false, bold: "none",
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Registro declarativo. enabled social só é resolvido por channelRules após
 * composição completa dos ports. Não é uma configuração enviada pelo cliente. */
export const CHANNEL_REGISTRY: Readonly<Record<ChannelId, ChannelSpec>> = freeze({
  whatsapp: {
    id: "whatsapp", label: "WhatsApp", enabled: true, transport: "zernio", serviceLine: true,
    contexts: { direct, group: direct }, text: { enabled: true, maxChars: 3800 },
    media: officialMedia,
    voice: { receive: true, send: true, maxSendBytes: 16 * MiB, mimeTypes: ["audio/ogg"] },
    menu: { buttons: 3, quickReplies: 0, listItems: 10, fallback: "numbered_text" },
    window: { kind: "customer", hours: 24, after: "template" },
    initiation: "template", templates: true, subject: false, replyTo: true, bold: "whatsapp",
  },
  instagram: social("instagram", "Instagram"),
  facebook: social("facebook", "Facebook"),
  telegram: {
    id: "telegram", label: "Telegram", enabled: false, transport: "telegram_bot", serviceLine: true,
    contexts: { direct: { ...direct, enabled: false } },
    text: { enabled: true, maxChars: 4096 },
    // Vazio significa formato ainda não validado, nunca permissão irrestrita.
    media: { image: media(null, []), video: media(null, []), audio: media(null, []), document: media(null, []) },
    menu: noMenu, window: { kind: "none" }, initiation: "customer_first",
    templates: false, subject: false, replyTo: true, bold: "telegram",
  },
  googlebusiness: {
    id: "googlebusiness", label: "Google Business", enabled: false, transport: "zernio", serviceLine: false,
    contexts: { review: publicDisabled }, text: { enabled: true, maxChars: null }, media: {},
    menu: noMenu, window: { kind: "none" }, initiation: "customer_first",
    templates: false, subject: false, replyTo: false, bold: "none",
  },
  email: {
    id: "email", label: "E-mail", enabled: false, transport: "email", serviceLine: true,
    contexts: { direct: { enabled: false, bot: false, publicReply: false } },
    text: { enabled: true, maxChars: null }, media: { document: media(null, []) },
    menu: noMenu, window: { kind: "none" }, initiation: "business",
    templates: false, subject: true, replyTo: true, bold: "html",
  },
  tiktok: {
    id: "tiktok", label: "TikTok", enabled: false, transport: "zernio", serviceLine: true,
    contexts: { direct: { ...direct, enabled: false } },
    text: { enabled: true, maxChars: 6000 }, media: { image: media(null, []) },
    menu: noMenu, window: { kind: "customer", hours: 48, maxMessages: 10, after: "blocked" },
    initiation: "customer_first", templates: false, subject: false, replyTo: false, bold: "none",
  },
});

/** Encaixes futuros do anexo, desligados; a conferir com a conta real.
 * Não usar estes metadados como autorização de envio. */
export const FUTURE_CHANNEL_CONTRACTS = freeze({
  comment: { enabled: false, publicHumanReply: true, privateReplyCount: 1, privateReplyHours: 168 },
  review: { enabled: false, humanReply: true, replace: true, delete: true },
  telegram: { enabled: false, buttons: true, callbackMaxBytes: 64 },
  tiktok: { enabled: false, content: "text_or_image" },
});

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHANNEL_REGISTRY, value);
}

function configOf(connection: ChannelConnection | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(connection?.config || "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function connectionChannel(connection: ChannelConnection | null): ChannelId | null {
  if (!connection || ["ai", "app", "internal", "team"].includes(connection.kind)) return null;
  if (connection.channel != null) return isChannelId(connection.channel) ? connection.channel : null;
  return ["zernio", "qr", "meta"].includes(connection.kind) ? "whatsapp" : null;
}

/** Não infere canal por ausência de outro: aplicação, equipe e IA não são WhatsApp.
 * Não consulta conexões; o chamador fornece a origem já autenticada/carregada. */
export function conversationChannel(conversation: {
  channel?: ChannelId | string | null;
  connection_id?: string | null;
  external_namespace: string;
  chat_type?: string;
}, connection: ChannelConnection | null): ChannelId | null {
  if (connection?.kind === "ai" || conversation.external_namespace.startsWith("app:") ||
      conversation.chat_type === "team" || conversation.chat_type === "internal") return null;
  if (conversation.channel != null) return isChannelId(conversation.channel) ? conversation.channel : null;
  if (!connection || conversation.connection_id !== connection.id ||
      conversation.external_namespace !== `channel:${connection.id}`) return null;
  return connectionChannel(connection);
}

/** Mantém a validação específica de upload do transporte: por exemplo, Zernio
 * sem presign limita upload direto a 25 MiB; WebP/Opus exigem inspeção do arquivo.
 * maxSendBytes não substitui essas verificações existentes de whatsapp.ts. */
export function channelRules(connection: ChannelConnection | null, context: ChannelContext = "direct", projection?: Partial<ChannelSpec>): ChannelSpec | null {
  const channel = connectionChannel(connection);
  if (!channel || !connection) return null;
  const key = extensionKey(channel, context);
  if (key) {
    const extension = channelExtension(key);
    const spec = structuredClone({ ...extension.spec, ...projection,
      id: extension.spec.id, transport: extension.spec.transport, serviceLine: extension.spec.serviceLine });
    spec.context = context;
    if (channel === "googlebusiness") spec.serviceLine = false;
    spec.enabled = channelExtensionReady(key) && extension.spec.enabled && spec.enabled && extension.enabled?.(connection) === true && spec.contexts[context]?.enabled === true;
    if (context === "comment" || context === "review") {
      spec.contexts[context] = { ...spec.contexts[context]!, bot: false };
      spec.menu = { ...noMenu }; spec.window = { kind: "none" };
    }
    return spec;
  }
  const rules: ChannelSpec = structuredClone(CHANNEL_REGISTRY[channel]);
  rules.context = context;
  if (channel === "whatsapp") {
    if (!["zernio", "qr", "meta"].includes(connection.kind)) return null;
    const cfg = configOf(connection);
    const official = ["zernio", "meta"].includes(connection.kind) || cfg.platform === "whatsapp_cloud";
    const caps = whatsappCapabilities(connection, context);
    rules.legacyCapabilities = caps;
    rules.voice = { receive: caps.voice, send: caps.voice, maxSendBytes: 16 * MiB, mimeTypes: ["audio/ogg"] };
    rules.templates = official;
    rules.replyTo = caps.reply;
    rules.initiation = official ? "template" : "business";
    if (!official || context === "group") rules.window = { kind: "none" };
    if (connection.kind === "qr" || context === "group") rules.menu = { ...noMenu };
    const limits = { image: 20, video: 100, audio: 100, document: 100, sticker: 1 };
    for (const kind of Object.keys(limits) as MediaKind[]) {
      const item = rules.media[kind]!;
      item.receive = item.send = caps[kind];
      if (!official) {
        item.maxSendBytes = limits[kind] * MiB;
        item.mimeTypes = kind === "sticker" ? ["image/webp"] : kind === "document" ? [] : [`${kind}/*`];
      }
    }
    rules.contexts.group = { ...direct, enabled: caps.groups };
  } else if (channel === "instagram" || channel === "facebook") {
    rules.enabled = connection.kind === "zernio" && channelImplementationReady(channel);
  }
  if (context === "comment" || context === "review") {
    rules.window = { kind: "none" };
    rules.menu = { ...noMenu };
  }
  rules.enabled = rules.enabled && rules.contexts[context]?.enabled === true;
  return rules;
}

/** Datas são milissegundos UTC. Zero, futuro e valores inválidos não abrem janela.
 * Esta função não consulta relógio, banco, outra conversa ou ficha juntada. */
export function channelWindow(rules: ChannelSpec, lastCustomer: number, now: number, sentInWindow = 0): WindowState {
  const bot = rules.contexts[rules.context ?? "direct"]?.bot === true;
  const base: WindowState = {
    kind: rules.window.kind, state: "closed", serverNow: now,
    closesAt: null, humanTextClosesAt: null, remainingMessages: null,
    canHumanText: false, canAutomation: false, reason: "window_closed",
  };
  if (rules.window.kind === "none")
    return { ...base, state: "open", canHumanText: true, canAutomation: bot, reason: null };
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lastCustomer) ||
      lastCustomer <= 0 || now < lastCustomer) return base;
  const closesAt = lastCustomer + rules.window.hours * HOUR;
  const humanClosesAt = rules.window.humanTextHours === undefined ? null
    : lastCustomer + rules.window.humanTextHours * HOUR;
  if (!Number.isSafeInteger(closesAt) || (humanClosesAt !== null && !Number.isSafeInteger(humanClosesAt))) return base;
  base.closesAt = closesAt;
  base.humanTextClosesAt = humanClosesAt;
  if (rules.window.maxMessages !== undefined) {
    base.remainingMessages = Number.isSafeInteger(sentInWindow) && sentInWindow >= 0
      ? Math.max(0, rules.window.maxMessages - sentInWindow) : 0;
    if (!base.remainingMessages) return base;
  }
  if (now < closesAt)
    return { ...base, state: "open", canHumanText: true, canAutomation: bot, reason: null };
  if (humanClosesAt !== null && now < humanClosesAt)
    return { ...base, state: "human_text_only", canHumanText: true, reason: "human_only" };
  return base;
}

/** origin e window vêm do servidor. A extensão humana exige a operação humana
 * autenticada, nunca actor/via/human/messageTag enviados pelo cliente.
 * Reconferir a janela imediatamente antes de cada entrega ao fornecedor. */
export function assertChannelSend(input: {
  rules: ChannelSpec; window: WindowState; origin: SendOrigin; contentType: string; hasAttachments: boolean;
}): void {
  const { rules, window, origin, contentType, hasAttachments } = input;
  if (!rules.enabled || !rules.contexts[rules.context ?? "direct"]?.enabled)
    throw new ApiError(503, "channel_not_ready", "Canal ou modo ainda indisponível.");
  if (!["manual_text", "human_media", "bot", "automation"].includes(origin))
    throw new ApiError(422, "unsupported_content", "Origem de envio inválida.");
  const template = rules.templates && contentType === "template";
  const read = rules.id === "whatsapp" && contentType === "read";
  if (window.state === "closed" && !template && !read)
    throw new ApiError(409, "window_closed", "Janela de atendimento encerrada. Aguarde uma mensagem do cliente.");
  if (window.state === "human_text_only" &&
      (origin !== "manual_text" || contentType !== "text" || hasAttachments))
    throw new ApiError(409, "human_only", "Neste período, somente texto escrito por uma pessoa pode ser enviado.");
  if ((origin === "bot" || origin === "automation") && !window.canAutomation && !template && !read)
    throw new ApiError(409, "human_only", "A automação não pode responder neste período.");
  const mediaRule = contentType === "voice" && rules.id === "whatsapp"
    ? rules.voice : rules.media[contentType as MediaKind];
  const legacyFeature = rules.id === "whatsapp" &&
    ["read", "reaction", "location", "contacts", "edit", "delete"].includes(contentType) &&
    rules.legacyCapabilities?.[contentType as keyof NonNullable<ChannelSpec["legacyCapabilities"]>] === true;
  const supported = contentType === "text" ? rules.text.enabled
    : mediaRule ? mediaRule.send
    : contentType === "buttons" ? rules.menu.buttons > 0
    : contentType === "quick_replies" ? rules.menu.quickReplies > 0
    : contentType === "list" ? rules.menu.listItems > 0
    : template || legacyFeature || (rules.id === "whatsapp" && contentType === "interactive");
  if (!supported || (rules.id !== "whatsapp" && contentType === "text" && hasAttachments) ||
      (mediaRule && !hasAttachments))
    throw new ApiError(422, "unsupported_content", "Conteúdo ou formato indisponível neste canal.");
}

export function allowsModules(channel: ChannelId | null): boolean {
  return channel === "whatsapp";
}

/** Módulos numa conversa. `channel` é o canal que o chamador já resolveu
 * (conversationChannel ou equivalente). As conversas anteriores aos canais
 * novos (aplicação de integração, equipe, interna e conexão de IA) não têm
 * canal resolvido, mas tinham módulos na 0.23.0 e continuam tendo enquanto não
 * gravarem canal novo. Canal novo ou inválido gravado nunca libera.
 * Não consulta banco nem conexões. */
export function conversationAllowsModules(conversation: {
  channel?: ChannelId | string | null;
  external_namespace?: string | null;
  chat_type?: string | null;
}, channel: ChannelId | null, connection: ChannelConnection | null = null): boolean {
  if (allowsModules(channel)) return true;
  const legacy = connection?.kind === "ai" || !!conversation.external_namespace?.startsWith("app:") ||
    conversation.chat_type === "team" || conversation.chat_type === "internal";
  return legacy && (conversation.channel == null || conversation.channel === "whatsapp");
}

/** Canais com conversa direta em que o menu de atendimento, a fila de senhas e
 * os itens de módulo do menu funcionam (pedido do dono de 21/11: "entrar na
 * fila por todos os canais"). E-mail tem entrada própria, sem menu; Google
 * Business e comentários são públicos e nunca recebem menu. */
export const MENU_MODULE_CHANNELS: readonly ChannelId[] = Object.freeze([
  "whatsapp", "instagram", "facebook", "telegram", "tiktok",
]);

export function channelAllowsMenuModules(channel: ChannelId | null): boolean {
  return channel != null && MENU_MODULE_CHANNELS.includes(channel);
}

function conversationContext(conversation: { chat_type?: string | null; channel_context?: string | null }) {
  if (conversation.chat_type === "comment" || conversation.chat_type === "review") return conversation.chat_type;
  try {
    const value = JSON.parse(conversation.channel_context || "{}");
    return typeof value?.context === "string" ? value.context : "direct";
  } catch { return "direct"; }
}

/** Menu, fila de senhas e itens de módulo do menu numa conversa. Vale tudo o
 * que conversationAllowsModules já libera e, além disso, a conversa direta de
 * cada canal de MENU_MODULE_CHANNELS. Canal gravado diferente do resolvido,
 * aplicação com canal social gravado, comentário e avaliação nunca liberam.
 * Não consulta banco nem conexões. */
export function conversationAllowsMenuModules(conversation: {
  channel?: ChannelId | string | null;
  external_namespace?: string | null;
  chat_type?: string | null;
  channel_context?: string | null;
}, channel: ChannelId | null, connection: ChannelConnection | null = null): boolean {
  if (conversationAllowsModules(conversation, channel, connection)) return true;
  if (!channelAllowsMenuModules(channel)) return false;
  if (conversation.channel != null && conversation.channel !== channel) return false;
  if (conversation.external_namespace?.startsWith("app:")) return false;
  if (conversation.chat_type != null && conversation.chat_type !== "direct") return false;
  return conversationContext(conversation) === "direct";
}

/** Nome do canal da conversa para o cliente e para a equipe ("pelo Instagram").
 * Conversa aberta por aplicação de integração (chat do site) é "site". */
export function conversationChannelLabel(conversation: {
  channel?: ChannelId | string | null;
  external_namespace?: string | null;
}): string {
  if (conversation.channel != null && isChannelId(conversation.channel))
    return CHANNEL_REGISTRY[conversation.channel].label;
  if (conversation.external_namespace?.startsWith("app:")) return "site";
  return "WhatsApp";
}

const CHANNEL_REFUSALS = new Set(["unsupported_content", "channel_not_ready", "cannot_initiate", "window_closed", "human_only"]);

/** Resposta em palavras quando uma ação do menu esbarra num limite do canal. */
export function channelRefusalText(conversation: {
  channel?: ChannelId | string | null;
  external_namespace?: string | null;
}, error: { code?: string; message?: string }): string {
  const label = conversationChannelLabel(conversation);
  if (error.code === "window_closed" || error.code === "human_only")
    return `Pelo ${label}, as respostas automáticas só podem ser enviadas por um tempo depois da sua última mensagem. Envie MENU para ver as opções de novo.`;
  if (CHANNEL_REFUSALS.has(error.code || ""))
    return `Esta opção ainda não funciona pelo ${label}. Envie MENU para ver as outras opções ou fale com a gente pelo WhatsApp.`;
  return `${error.message || "Esta opção não está disponível agora."} Envie MENU para ver as opções.`;
}

/** Projeção das chaves legadas: não importa transporte, não lê D1 e não muda
 * a seleção de recursos de QR v1/v2 ou da conexão oficial existente. */
function whatsappCapabilities(conn: ChannelConnection, context: ChannelContext) {
  const cfg = configOf(conn), group = context === "group";
  if (conn.kind === "zernio") return {
    text: true, document: true, image: true, video: true, audio: true, voice: true,
    sticker: false, reply: true, reaction: !group, location: !group, contacts: !group,
    edit: false, delete: false, read: true, mentions: false,
    groups: cfg.groups_enabled === true, group_manage: cfg.groups_enabled === true,
    calls: false, video_calls: false, upgrade_required: false,
  };
  const qr = conn.kind === "qr", modern = Number(cfg.protocol_version) >= 2;
  const advertised = Array.isArray(cfg.features) ? cfg.features : [];
  const has = (feature: string) => (qr && modern) || advertised.includes(feature);
  return {
    text: true, document: has("document"), image: has("image"), video: has("video"),
    audio: has("audio"), voice: has("voice"), sticker: has("sticker"), reply: has("reply"),
    reaction: (!group && has("reaction")) || (qr && modern),
    location: (!group && has("location")) || (qr && modern),
    contacts: (!group && has("contacts")) || (qr && modern), edit: has("edit"), delete: has("delete"),
    read: has("read"), mentions: qr && modern, groups: (qr && modern) || advertised.includes("groups"),
    group_manage: qr && modern, calls: false, video_calls: false, upgrade_required: !modern,
  };
}

/** Window e multichannel só são preenchidos pela leitura autorizada da conversa.
 * Não contar conexões por mensagem: usar o resumo calculado pelo servidor. */
export function channelCapabilities(connection: ChannelConnection | null, context: ChannelContext = "direct", projection?: Partial<ChannelSpec>): ChannelCapabilities {
  const rules = channelRules(connection, context, projection);
  const active = rules?.enabled === true;
  const legacy = rules?.legacyCapabilities ?? {
    text: active && rules!.text.enabled,
    document: active && rules!.media.document?.send === true,
    image: active && rules!.media.image?.send === true,
    video: active && rules!.media.video?.send === true,
    audio: active && rules!.media.audio?.send === true,
    voice: false, sticker: false, reply: active && rules!.replyTo,
    reaction: false, location: false, contacts: false, edit: false, delete: false,
    read: false, mentions: false, groups: false, group_manage: false, calls: false,
    video_calls: false, upgrade_required: false,
  };
  return {
    ...legacy, channel: rules?.id ?? null, account_label: connection?.account_label ?? "",
    multichannel: false, window: null, templates: active && rules!.templates,
    menu: rules?.menu ?? null, subject: active && rules!.subject,
    public_reply: active && rules!.contexts[context]?.publicReply === true,
    modules: active && allowsModules(rules!.id),
    can_initiate: active && rules!.initiation !== "customer_first",
  };
}
