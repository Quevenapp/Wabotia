import { ApiError, type Env } from "./types";
import { CHANNEL_REGISTRY, assertChannelSend, channelWindow, SOCIAL_LOCAL_LIMITS } from "./channels";
import type { SocialTransportPort } from "./channel-ports";
import type {
  ChannelContextData, NormalizedSocialEvent, SendOrigin, SocialDelivery,
  SocialEventResult, SocialEventScope, SocialInboundMedia, SocialSendInput, SocialSendPlan,
} from "./channel-contracts";

/** Esquema do anexo e fixtures sintéticas: a conferir com a conta real.
 * Todos os nomes alternativos e códigos incertos ficam neste adaptador. */
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : {};
const opaque = (value: unknown): string | null => {
  const result = typeof value === "string" ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  if (!result || result.length > 1024 || /[\u0000-\u001f\u007f]/.test(result)) return null;
  try { encodeURIComponent(result); return result; } catch { return null; }
};
const label = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value.slice(0, 256) : undefined;
/** Escape delimitadores sem normalizar o sujeito como telefone. O prefixo e a
 * codificação tornam a chave composta da inbox inequívoca mesmo para IDs opacos. */
export const socialExternalId = (subjectId: string): string => `dm:${encodeURIComponent(subjectId)}`;
const timestamp = (value: unknown): number | null => {
  const time = typeof value === "string" ? Date.parse(value) : value;
  return typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time <= Date.now() ? time : null;
};
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Sem I/O. O escopo já foi autenticado e resolvido na mesma área pelo servidor. */
export async function normalizeSocialEvent(input: unknown, scope: SocialEventScope): Promise<SocialEventResult> {
  const ignored = (reason: Extract<SocialEventResult, { status: "ignored" }>["reason"]): SocialEventResult => ({ status: "ignored", reason });
  if (!["instagram", "facebook"].includes(scope.channel)) return ignored("channel_not_ready");
  const body = object(input), account = object(body.account), message = object(body.message),
    conversation = object(body.conversation), metadata = object(body.metadata), reaction = object(body.reaction);
  if (body.test === true || body.event === "webhook.test") return ignored("unsupported_event");
  if (account.platform !== scope.channel || opaque(account.accountId ?? account.id) !== scope.accountId ||
      (account.profileId != null && opaque(account.profileId) !== scope.providerProfileId) ||
      (message.platform != null && message.platform !== scope.channel) ||
      (conversation.accountId != null && opaque(conversation.accountId) !== scope.accountId) ||
      (conversation.platform != null && conversation.platform !== scope.channel)) return ignored("scope_mismatch");
  const type = body.event === "reaction.received" ? "message.reaction" : body.event;
  if (!["message.received", "message.sent", "message.edited", "message.deleted", "message.read", "message.delivered", "message.reaction"].includes(type))
    return ignored("unsupported_event");
  if (metadata.standby === true || conversation.type === "group" || conversation.type === "comment") return ignored("unsupported_event");
  if ((type === "message.received" && message.direction !== "incoming") ||
      (type === "message.sent" && message.direction !== "outgoing")) return ignored("invalid_event");
  const sender = object(message.sender), recipient = object(message.recipient);
  const subjectId = opaque(conversation.participantId) ?? (type === "message.received"
    ? opaque(sender.businessScopedUserId ?? sender.id) : opaque(recipient.businessScopedUserId ?? recipient.id));
  const threadId = opaque(message.conversationId ?? conversation.id);
  if (message.conversationId != null && conversation.id != null && opaque(message.conversationId) !== opaque(conversation.id))
    return ignored("scope_mismatch");
  const messageId = opaque(type === "message.reaction" ? reaction.platformMessageId ?? message.platformMessageId : message.platformMessageId);
  if (!subjectId || !threadId || !messageId) return ignored("invalid_event");
  const isMessage = ["message.received", "message.sent", "message.edited"].includes(type);
  const occurredAt = timestamp(type === "message.received" || type === "message.sent" ? message.sentAt
    : type === "message.edited" ? message.editedAt ?? body.timestamp
    : type === "message.reaction" ? reaction.reactedAt ?? body.timestamp : body.statusAt ?? body.timestamp);
  const subjectDetails = type === "message.received" ? sender : recipient;
  const eventId = opaque(body.id) ?? await digest(JSON.stringify([scope.connectionId, type, messageId, occurredAt,
    type === "message.reaction" ? [reaction.action, reaction.emoji] : type === "message.edited" ? message.text : null]));
  const base = { scope, eventId, messageId, threadId, occurredAt,
    subject: { namespace: "dm" as const, id: subjectId, displayName: label(subjectDetails.name), username: label(subjectDetails.username) } };
  if (isMessage) {
    const media: SocialInboundMedia[] = [];
    if (message.attachments != null && !Array.isArray(message.attachments)) return ignored("invalid_event");
    for (const raw of message.attachments ?? []) {
      const attachment = object(raw), payload = object(attachment.payload);
      const kind = attachment.type === "file" ? "document" : attachment.type;
      // Preserve an unsupported attachment as unavailable, never coerce it into text or a phone.
      media.push({ kind: ["image", "audio", "video", "document", "sticker"].includes(kind) ? kind : "document",
        mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : null,
        name: label(payload.filename ?? attachment.name) ?? null,
        sourceUrl: ["image", "audio", "video", "document"].includes(kind) && typeof attachment.url === "string" ? attachment.url : null,
        providerMediaId: opaque(attachment.id ?? attachment.mediaId) });
    }
    const context: ChannelContextData = { version: 1, context: "direct" };
    const story = object(metadata.story);
    const storyId = opaque(story.id);
    if (storyId) context.story = { id: storyId, ...(label(story.title) ? { title: label(story.title) } : {}) };
    // Echo correlation is established against the local outbox by the caller, never trusted from a webhook field.
    return { status: "accepted", event: { ...base, type, text: typeof message.text === "string" ? message.text : "", media, context } as NormalizedSocialEvent };
  }
  if (type === "message.reaction") {
    if (reaction.action !== "removed" && (typeof reaction.emoji !== "string" || reaction.emoji.length > 64)) return ignored("invalid_event");
    return { status: "accepted", event: { ...base, type, reaction: reaction.action === "removed" ? null : reaction.emoji } };
  }
  return { status: "accepted", event: { ...base, type } as NormalizedSocialEvent };
}

/** Produzido apenas pela operação humana autenticada de cn-servidor, depois de
 * remover os campos homônimos do cliente. Persistir na outbox, nunca no texto. */
export interface SocialSendProvenance {
  version: 1;
  origin: SendOrigin;
  actorId: string;
  conversationId: string;
  connectionId: string;
  commandId: string;
}
export function persistedSocialOrigin(row: any, payload: any, conversation: any, connection: any): SendOrigin {
  const proof = object(payload?.social_provenance);
  const actor = typeof row?.actor === "string" ? row.actor : "";
  if (proof.version !== 1 || !opaque(proof.commandId) || proof.actorId !== actor ||
      proof.conversationId !== conversation?.id || proof.connectionId !== connection?.id ||
      !actor || actor === "system" || actor.includes(":")) return "automation";
  if (row.kind !== "text" || payload.automation || payload.template || payload.template_message ||
      (payload.content?.type && !["text", "image", "video", "audio", "document"].includes(payload.content.type))) return "automation";
  if (proof.origin === "manual_text" && (payload.attachments?.length || payload.media_id)) return "automation";
  return proof.origin === "manual_text" || proof.origin === "human_media" ? proof.origin
    : proof.origin === "bot" ? "bot" : "automation";
}

export function socialRules(channel: "instagram" | "facebook") {
  // The concrete port is only called after channel-ports readiness validation.
  return { ...CHANNEL_REGISTRY[channel], enabled: true, context: "direct" as const };
}
export function splitSocialText(text: string): string[] {
  const points = Array.from(text), result: string[] = [];
  for (let start = 0; start < points.length; start += SOCIAL_LOCAL_LIMITS.textChars)
    result.push(points.slice(start, start + SOCIAL_LOCAL_LIMITS.textChars).join(""));
  return result;
}

/** Puro, sem upload/envio: cada item vira uma entrega própria da outbox. */
export async function prepareSocialSend(input: SocialSendInput): Promise<SocialSendPlan> {
  if (!["instagram", "facebook"].includes(input.scope.channel))
    throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
  if (!input.threadId) throw new ApiError(409, "cannot_initiate", "Aguarde uma mensagem do cliente neste canal.");
  if (!opaque(input.commandId) || !opaque(input.conversationId)) throw new ApiError(422, "unsupported_content", "Entrega sem identificação.");
  const rules = socialRules(input.scope.channel), window = channelWindow(rules, input.lastCustomer, input.serverNow);
  const contents: SocialDelivery["content"][] = [];
  let text = input.text;
  const menu = input.menu;
  if (menu?.length) {
    const compatible = menu.length <= rules.menu.quickReplies && !input.attachments.length &&
      Array.from(text).length <= SOCIAL_LOCAL_LIMITS.textChars && new Set(menu.map((option) => option.id)).size === menu.length &&
      menu.every((option) => typeof option.id === "string" && option.id.length > 0 && new TextEncoder().encode(option.id).length <= 256 &&
        typeof option.title === "string" && option.title.trim().length > 0 && Array.from(option.title).length <= 20 && !/[\u0000-\u001f\u007f]/.test(option.title));
    // Payload sizes for options are conservative local limits, a conferir com a conta real.
    if (compatible) contents.push({ type: menu.length <= rules.menu.buttons ? "buttons" : "quick_replies", text, options: menu });
    else text += `${text ? "\n\n" : ""}${menu.map((option, index) => `${index + 1}. ${option.title}`).join("\n")}`;
  }
  if (!contents.length && text) contents.push(...splitSocialText(text).map((part) => ({ type: "text" as const, text: part })));
  for (const attachment of input.attachments) {
    const rule = rules.media[attachment.kind], mime = attachment.mimeType.split(";")[0].trim().toLowerCase();
    if (!opaque(attachment.mediaId) || !rule?.send || !rule.mimeTypes.includes(mime) || !Number.isSafeInteger(attachment.bytes) ||
        attachment.bytes <= 0 || rule.maxSendBytes === null || attachment.bytes > rule.maxSendBytes)
      throw new ApiError(422, "unsupported_content", "Formato ou tamanho de anexo indisponível neste canal.");
    contents.push({ type: "media", attachment: { ...attachment, mimeType: mime } });
  }
  if (!contents.length) throw new ApiError(422, "unsupported_content", "Informe uma mensagem para enviar.");
  // A menu remains automation even when its text fallback resembles a human message.
  if (menu?.length && window.state !== "open")
    throw new ApiError(409, window.state === "closed" ? "window_closed" : "human_only", "Menus só podem ser enviados na janela de 24 horas.");
  const deliveries: SocialDelivery[] = [];
  for (let sequence = 0; sequence < contents.length; sequence++) {
    const content = contents[sequence];
    assertChannelSend({ rules, window, origin: input.origin,
      contentType: content.type === "media" ? content.attachment.kind : content.type, hasAttachments: content.type === "media" });
    const id = (await digest(JSON.stringify([input.scope.profileId, input.scope.connectionId, input.conversationId, input.commandId, sequence]))).slice(0, 32);
    deliveries.push({ id, idempotencyKey: `social:${id}`, sequence, content,
      ...(window.state === "human_text_only" ? { messageTag: "HUMAN_AGENT" as const } : {}) });
  }
  return { conversationId: input.conversationId, threadId: input.threadId, window, deliveries };
}

/** Adaptador único do formato de saída: a conferir com a conta real. Sem replyTo. */
export function socialDeliveryPayload(delivery: SocialDelivery, media?: { url: string; name?: string }): Record<string, unknown> {
  const content = delivery.content;
  const body: Record<string, unknown> = {};
  if (content.type === "media") {
    if (!media?.url) throw new ApiError(422, "unsupported_content", "Anexo ainda não preparado.");
    body.attachmentUrl = media.url;
    body.attachmentType = content.attachment.kind === "document" ? "file" : content.attachment.kind;
    body.attachmentName = media.name ?? content.attachment.name;
  } else {
    body.message = content.text;
    if (content.type === "buttons") body.buttons = content.options.map((option) => ({ type: "postback", title: option.title, payload: option.id }));
    if (content.type === "quick_replies") body.quickReplies = content.options.map((option) => ({ contentType: "text", title: option.title, payload: option.id }));
  }
  if (delivery.messageTag) body.messageTag = delivery.messageTag;
  return body;
}

export function socialProviderMessageId(result: unknown): string {
  const id = opaque(object(object(result).data).messageId);
  if (!id) throw new ApiError(502, "provider_unknown", "O provedor não confirmou a entrega. Confira a conversa antes de repetir.");
  return id;
}

/** Somente uma pista não autenticada. Confirmar outbox + conta + conversa antes
 * de promover este valor a localDeliveryId do evento normalizado. */
export function socialEchoHint(input: unknown): string | null {
  const metadata = object(object(input).metadata);
  return opaque(metadata.idempotencyKey ?? metadata.localDeliveryId);
}

/** Respostas a botões/respostas rápidas também ficam neste único leitor.
 * Formatos do anexo e nomes dos campos: a conferir com a conta real. */
export function socialInteractiveReplyId(input: unknown): string | null {
  const body = object(input), metadata = object(body.metadata), message = object(body.message);
  return opaque(metadata.interactiveId ?? object(metadata.postback).payload ??
    object(metadata.quickReply).payload ?? object(message.postback).payload ?? object(message.quickReply).payload);
}

/** Erros do transporte existente ficam mapeados aqui; nunca repetir escrita incerta. */
export function socialProviderError(error: unknown): ApiError {
  if (error instanceof ApiError && ["window_closed", "human_only", "cannot_initiate", "unsupported_content", "inbox_required", "channel_not_ready", "provider_unknown", "message_expired"].includes(error.code)) return error;
  if (error instanceof ApiError && error.code === "zernio_rejected")
    return new ApiError(422, "unsupported_content", "O provedor recusou este conteúdo. Confira os campos e permissões da integração.");
  return new ApiError(502, "provider_unknown", "O provedor não confirmou a entrega. Confira a conversa antes de repetir.");
}

export const zernioSocialTransport: SocialTransportPort = {
  channels: ["instagram", "facebook"],
  normalizeEvent: normalizeSocialEvent,
  prepareSend: (_env: Env, input: SocialSendInput) => prepareSocialSend(input),
};
