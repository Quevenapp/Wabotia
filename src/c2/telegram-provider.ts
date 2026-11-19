/** Contrato do plano; a conferir com a conta real. Este é o único leitor do
 * formato Telegram. URLs com token existem somente durante a chamada privada. */
import type { ChannelDeliveryResult } from "../channel-c2-contracts";
import type { MediaKind } from "../channel-contracts";

export const TELEGRAM_ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"] as const;
export type TelegramMethod = "getMe" | "setWebhook" | "deleteWebhook" | "getFile" | "sendMessage" |
  "sendPhoto" | "sendVideo" | "sendAudio" | "sendDocument" | "sendSticker" | "answerCallbackQuery" | "sendChatAction";
export interface TelegramCallOptions {
  beforeFetch?: () => Promise<void>;
  fetcher?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}
export type TelegramResult = { kind: "ok"; result: Record<string, unknown> } |
  Exclude<ChannelDeliveryResult, { kind: "sent" }>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function telegramIdentifier(value: unknown, signed = false): string | null {
  const string = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  return (signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/).test(string) ? string : null;
}
export function validTelegramToken(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}:[A-Za-z0-9_-]{8,200}$/.test(value);
}
/** Não propaga URL privada nem conteúdo de erro remoto para logs ou API. */
export function redactTelegramText(value: string): string {
  return value.replace(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^\s<>"']+/gi, "[endereço privado do Telegram]")
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{8,200}\b/g, "[credencial do Telegram]");
}
function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? redactTelegramText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";
}
function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000
    ? value * 1000 : null;
}
export interface TelegramInboundMedia {
  kind: MediaKind; fileId: string; bytes: number | null; mimeType: string | null; name: string | null;
}
export interface TelegramUpdate {
  key: string;
  kind: "message.received" | "message.edited" | "callback" | "membership" | "group.ignored";
  occurredAt: number | null; chatId: string; subjectId?: string; remoteId: string;
  displayName: string; username: string; text: string; media: TelegramInboundMedia[];
  contact?: { userId: string | null; phone: string; name: string };
  location?: { latitude: number; longitude: number };
  callback?: { id: string; data: string; messageId: string | null };
  blocked?: boolean;
  botId?: string;
  unsupported?: boolean;
}
function file(value: unknown, kind: MediaKind, defaultMime?: string): TelegramInboundMedia | null {
  const item = record(value);
  if (typeof item.file_id !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(item.file_id)) return null;
  const bytes = Number.isSafeInteger(item.file_size) && Number(item.file_size) >= 0 ? Number(item.file_size) : null;
  const mimeType = typeof item.mime_type === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mime_type)
    ? item.mime_type.toLowerCase() : defaultMime ?? null;
  return { kind, fileId: item.file_id, bytes, mimeType, name: safeText(item.file_name, 200) || null };
}
/** Puro: sem credencial, D1, download ou ack. O descritor exige VerifiedIngress. */
export function readTelegramUpdate(input: unknown): TelegramUpdate | null {
  const body = record(input);
  if (!Number.isSafeInteger(body.update_id) || Number(body.update_id) < 0) return null;
  const callback = record(body.callback_query), membership = record(body.my_chat_member);
  const ackOnly = (): TelegramUpdate | null => typeof callback.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(callback.id)
    ? { key: String(body.update_id), kind: "callback", occurredAt: null, chatId: "", remoteId: callback.id,
      displayName: "", username: "", text: "", media: [], unsupported: true,
      callback: { id: callback.id, data: "", messageId: null } } : null;
  if (body.business_connection || body.business_message || body.edited_business_message) return ackOnly();
  const kind: TelegramUpdate["kind"] = body.callback_query ? "callback" : body.my_chat_member ? "membership"
    : body.edited_message ? "message.edited" : "message.received";
  const message = record(body.callback_query ? callback.message : body.my_chat_member ? membership : body.edited_message ?? body.message);
  if (!Object.keys(message).length || message.business_connection_id) return ackOnly();
  const chat = record(message.chat), from = record(body.callback_query ? callback.from : message.from);
  const chatId = telegramIdentifier(chat.id, true), subjectId = telegramIdentifier(from.id);
  if (!chatId || !["private", "group", "supergroup", "channel"].includes(String(chat.type))) return ackOnly();
  const messageId = telegramIdentifier(message.message_id);
  const base: TelegramUpdate = { key: String(body.update_id), kind, occurredAt: timestamp(message.edit_date ?? message.date), chatId,
    remoteId: `${chatId}:${messageId ?? body.update_id}`, displayName: "", username: "", text: "", media: [] };
  if (chat.type !== "private") return { ...base, kind: "group.ignored", remoteId: chatId,
    ...(typeof callback.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(callback.id) ? { callback: { id: callback.id, data: "", messageId: null } } : {}) };
  if (!subjectId || (kind !== "membership" && chatId !== subjectId) || from.is_bot === true) return ackOnly();
  base.subjectId = subjectId;
  base.displayName = [safeText(from.first_name, 80), safeText(from.last_name, 80)].filter(Boolean).join(" ");
  base.username = typeof from.username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(from.username) ? from.username : "";
  if (kind === "callback") {
    if (typeof callback.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(callback.id)) return null;
    // Mesmo dado inválido/vencido recebe ack; nunca se torna ação de atendimento.
    base.callback = { id: callback.id, data: typeof callback.data === "string" && new TextEncoder().encode(callback.data).length <= 64 ? callback.data : "", messageId };
    base.remoteId = callback.id;
    return base;
  }
  if (kind === "membership") {
    const member = record(membership.new_chat_member), user = record(member.user);
    if (user.is_bot !== true || !["member", "kicked", "left"].includes(String(member.status))) return null;
    base.blocked = member.status !== "member";
    base.botId = telegramIdentifier(user.id) ?? undefined;
    return base;
  }
  if (!messageId) return null;
  base.text = safeText(message.text ?? message.caption, 50_000);
  const photos = Array.isArray(message.photo) ? message.photo.map(value => file(value, "image", "image/jpeg")).filter((value): value is TelegramInboundMedia => !!value) : [];
  if (photos.length) base.media.push(photos.reduce((best, next) => (next.bytes ?? 0) >= (best.bytes ?? 0) ? next : best));
  for (const [field, kind, mime] of [["video", "video", "video/mp4"], ["audio", "audio", null], ["voice", "audio", "audio/ogg"], ["document", "document", null], ["sticker", "sticker", "image/webp"]] as const) {
    if (message[field]) { const attachment = file(message[field], kind, mime ?? undefined); if (attachment) base.media.push(attachment); else base.unsupported = true; }
  }
  if (base.media.length > 1) { base.media = base.media.slice(0, 1); base.unsupported = true; }
  const contact = record(message.contact);
  if (message.contact) {
    const phone = typeof contact.phone_number === "string" && /^\+?[\d\s().-]{8,40}$/.test(contact.phone_number)
      ? contact.phone_number.replace(/[\s().-]/g, "") : "";
    base.contact = { userId: telegramIdentifier(contact.user_id), phone: /^\+?\d{8,15}$/.test(phone) ? phone : "",
      name: [safeText(contact.first_name, 80), safeText(contact.last_name, 80)].filter(Boolean).join(" ") };
  }
  const location = record(message.location);
  if (typeof location.latitude === "number" && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 &&
      typeof location.longitude === "number" && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180)
    base.location = { latitude: location.latitude, longitude: location.longitude };
  if (!base.text && !base.media.length && !base.contact && !base.location) base.unsupported = true;
  return base;
}

const methods: readonly TelegramMethod[] = ["getMe", "setWebhook", "deleteWebhook", "getFile", "sendMessage", "sendPhoto", "sendVideo", "sendAudio", "sendDocument", "sendSticker", "answerCallbackQuery", "sendChatAction"];
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 262_144) throw new Error("provider_response_invalid");
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return record(JSON.parse(new TextDecoder().decode(bytes)));
}
export async function telegramCall(token: string, method: TelegramMethod, payload: Record<string, unknown> | FormData = {}, options: TelegramCallOptions = {}): Promise<TelegramResult> {
  if (!validTelegramToken(token)) return { kind: "failed", code: "channel_not_ready" };
  if (!methods.includes(method)) return { kind: "failed", code: "unsupported_content" };
  const mutatingSend = /^send(?:Message|Photo|Video|Audio|Document|Sticker)$/.test(method);
  const controller = new AbortController(), timeout = Math.min(30_000, Math.max(1, options.timeoutMs ?? 15_000));
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request: RequestInit = { method: "POST", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
      ...(payload instanceof FormData ? { body: payload } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) };
    await options.beforeFetch?.();
    timer = setTimeout(() => controller.abort(), timeout);
    started = true;
    const response = await (options.fetcher ?? fetch)(`https://api.telegram.org/bot${token}/${method}`, request);
    const body = await boundedJson(response);
    if (response.status === 429 && body.ok === false && body.error_code === 429) {
      const delay = record(body.parameters).retry_after;
      if (typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0 && delay <= 604_800)
        return { kind: "retry", code: "rate_limited", notBefore: Math.max(options.now ?? 0, Date.now()) + delay * 1000 };
      return { kind: "retry", code: "rate_limited", notBefore: Math.max(options.now ?? 0, Date.now()) + 60_000 };
    }
    if (!response.ok || body.ok !== true) {
      if (body.ok === false && [400, 401, 403, 404].includes(Number(body.error_code)) && (response.status === body.error_code || response.status === 200))
        return { kind: "failed", code: body.error_code === 403 ? "bot_blocked" : body.error_code === 401 ? "channel_not_ready" : "provider_rejected" };
      return { kind: mutatingSend ? "unknown" : "failed", code: "provider_unavailable" };
    }
    const result = record(body.result);
    if (method === "getMe") {
      const id = telegramIdentifier(result.id), username = typeof result.username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(result.username) ? result.username : null;
      return id && result.is_bot === true && username ? { kind: "ok", result: { id, username, is_bot: true } } : { kind: "failed", code: "provider_contract_unverified" };
    }
    if (method === "getFile") {
      const path = typeof result.file_path === "string" && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(result.file_path) && !result.file_path.split("/").some(part => part === "." || part === "..") ? result.file_path : null;
      const size = Number.isSafeInteger(result.file_size) && Number(result.file_size) >= 0 ? Number(result.file_size) : null;
      return path && path.length <= 1024 ? { kind: "ok", result: { file_path: path, file_size: size } } : { kind: "failed", code: "provider_contract_unverified" };
    }
    if (mutatingSend) {
      const id = telegramIdentifier(result.message_id);
      return id ? { kind: "ok", result: { message_id: id } } : { kind: "unknown", code: "provider_contract_unverified" };
    }
    return body.result === true ? { kind: "ok", result: { ok: true } } : { kind: "failed", code: "provider_contract_unverified" };
  } catch (error) {
    if (!started) throw error;
    return { kind: mutatingSend ? "unknown" : "failed", code: "provider_unavailable" };
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
export const telegramGetMe = (token: string, options?: TelegramCallOptions) => telegramCall(token, "getMe", {}, options);
export const telegramSetWebhook = (token: string, url: string, webhookSecret: string, options?: TelegramCallOptions) =>
  telegramCall(token, "setWebhook", { url, secret_token: webhookSecret, allowed_updates: TELEGRAM_ALLOWED_UPDATES, drop_pending_updates: false }, options);
export const telegramDeleteWebhook = (token: string, options?: TelegramCallOptions) => telegramCall(token, "deleteWebhook", { drop_pending_updates: false }, options);
export function telegramDeliveryResult(result: TelegramResult): ChannelDeliveryResult {
  return result.kind === "ok" ? { kind: "sent", ...(typeof result.result.message_id === "string" ? { externalId: result.result.message_id } : {}) } : result;
}
/** Privado ao copiador. O Response nunca é projetado, persistido ou registrado. */
export async function fetchTelegramFile(token: string, path: string, options: TelegramCallOptions & { signal: AbortSignal }): Promise<Response> {
  if (!validTelegramToken(token) || path.length > 1024 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some(part => part === "." || part === ".."))
    throw new Error("telegram_file_invalid");
  await options.beforeFetch?.();
  try {
    return await (options.fetcher ?? fetch)(`https://api.telegram.org/file/bot${token}/${path}`, {
      method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: options.signal,
    });
  } catch { throw new Error("telegram_file_unavailable"); }
}

/** Fixtures exclusivamente sintéticas; formato do plano, a conferir com a conta real. */
export const telegramPresentation = Object.freeze({
  channel: "telegram", kind: "telegram_bot", label: "Telegram", credentialLabel: "configurado",
  setupTitle: "Conectar bot do Telegram", tokenLabel: "Token do BotFather", botFatherUrl: "https://t.me/BotFather",
  instructions: "Crie um bot no BotFather e informe o token ao salvar. O cliente precisa iniciar a conversa com o bot. Use somente conversas privadas.",
  contactNotice: "O telefone compartilhado gera apenas uma sugestão para conferência humana. Ele não comprova identidade nem junta contatos automaticamente.",
  mediaNotice: "Anexos são copiados para armazenamento privado e ficam sujeitos aos limites locais de tamanho e formato.",
  contractNotice: "Formato do plano; a conferir com a conta real.",
  states: { blocked: "O cliente bloqueou o bot.", callbackExpired: "Este botão venceu. Solicite um novo menu.",
    rateLimited: "Aguardando o intervalo permitido pelo Telegram.", phoneSuggested: "Telefone compartilhado: sugestão pendente de conferência humana.",
    thirdPartyContact: "Contato de terceiro: não comprova a identidade de quem enviou.", mediaTooLarge: "Anexo acima do tamanho permitido." },
});
export const TELEGRAM_FIXTURES = Object.freeze({
  message: { update_id: 101, message: { message_id: 11, date: 1_800_000_000, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética", username: "pessoa_sintetica" }, text: "Olá, preciso de atendimento." } },
  edited: { update_id: 102, edited_message: { message_id: 11, date: 1_800_000_000, edit_date: 1_800_000_030, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética" }, text: "Olá, corrigi a mensagem." } },
  callback: { update_id: 103, callback_query: { id: "query-sintetica", data: "callback-sintetico", from: { id: 700001, first_name: "Pessoa sintética" }, message: { message_id: 12, date: 1_800_000_000, chat: { id: 700001, type: "private" } } } },
  ownContact: { update_id: 104, message: { message_id: 13, date: 1_800_000_030, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética" }, contact: { user_id: 700001, first_name: "Pessoa sintética", phone_number: "+55 (11) 99999-0000" } } },
  thirdPartyContact: { update_id: 105, message: { message_id: 14, date: 1_800_000_040, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética" }, contact: { user_id: 700002, first_name: "Terceiro sintético", phone_number: "+5511999990001" } } },
  oversized: { update_id: 106, message: { message_id: 15, date: 1_800_000_050, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética" }, caption: "Documento grande", document: { file_id: "arquivo_grande_sintetico", file_size: 20_000_001, mime_type: "application/pdf", file_name: "grande.pdf" } } },
  blocked: { update_id: 107, my_chat_member: { date: 1_800_000_060, chat: { id: 700001, type: "private" }, from: { id: 700001, first_name: "Pessoa sintética" }, new_chat_member: { status: "kicked", user: { id: 900001, is_bot: true, username: "bot_sintetico" } } } },
  rateLimited: { ok: false, error_code: 429, parameters: { retry_after: 7 } },
});
