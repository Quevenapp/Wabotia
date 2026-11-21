/** Limites conservadores do plano; a conferir com a conta real. Não há antivírus
 * nem detecção universal por assinatura: tipo/MIME e bytes são limitados. */
import { one } from "../db";
import { sha } from "../security";
import { ApiError, type Env } from "../types";
import type { ChannelSpec, MediaKind, SocialSendAttachment } from "../channel-contracts";
import type { Statement } from "../customer/contracts";
import { fetchTelegramFile, redactTelegramText, telegramCall, type TelegramCallOptions, type TelegramInboundMedia, type TelegramMethod } from "./telegram-provider";

export const TELEGRAM_DOWNLOAD_MAX = 20_000_000;
export const TELEGRAM_PHOTO_MAX = 10_000_000;
export const TELEGRAM_SEND_MAX = 50_000_000;
const MiB = 1024 * 1024;
const rule = (maxSendBytes: number, mimeTypes: readonly string[]) => ({ receive: true, send: true, maxSendBytes, mimeTypes });
/** Política local conservadora compatível com formatos já aceitos pelo Vinki. */
export const TELEGRAM_MEDIA_POLICY: ChannelSpec["media"] = Object.freeze({
  image: rule(Math.min(TELEGRAM_PHOTO_MAX, 5 * MiB), ["image/jpeg", "image/png"]),
  video: rule(16 * MiB, ["video/mp4"]),
  audio: rule(16 * MiB, ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"]),
  document: rule(TELEGRAM_SEND_MAX, ["text/plain", "application/pdf", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
});
export const TELEGRAM_MEDIA_UNAVAILABLE = "[Anexo indisponível. Solicite o reenvio em um formato ou tamanho permitido.]";
const mime = (value: string | null | undefined) => (value ?? "").split(";")[0].trim().toLowerCase();
export function telegramMediaName(value: string | null | undefined): string {
  return redactTelegramText(value ?? "anexo").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/^\.+/, "").slice(0, 200) || "anexo";
}
export async function telegramMediaId(connectionId: string, remoteId: string, index: number, fileId?: string): Promise<string> {
  return `tg-${(await sha(JSON.stringify([connectionId, remoteId, index, fileId ?? null]))).slice(0, 40)}`;
}
function mediaLimit(kind: MediaKind, direction: "receive" | "send", declaredMime: string, bytes: number | null): number {
  const policy = TELEGRAM_MEDIA_POLICY[kind];
  if (!policy?.[direction] || (declaredMime && !policy.mimeTypes.includes(declaredMime)))
    throw new ApiError(422, "unsupported_content", "Formato de anexo não permitido no Telegram.");
  const limit = Math.min(policy.maxSendBytes ?? 0, direction === "receive" ? TELEGRAM_DOWNLOAD_MAX : kind === "image" ? TELEGRAM_PHOTO_MAX : TELEGRAM_SEND_MAX);
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit))
    throw new ApiError(422, "attachment_too_large", "O anexo excede o limite permitido.");
  return limit;
}
export function validateTelegramAttachment(attachment: SocialSendAttachment): void {
  if (!attachment.mediaId || !mime(attachment.mimeType) || attachment.bytes <= 0)
    throw new ApiError(422, "unsupported_content", "Anexo inválido.");
  mediaLimit(attachment.kind, "send", mime(attachment.mimeType), attachment.bytes);
}
async function limitedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new ApiError(422, "unsupported_content", "Anexo indisponível.");
  const lengthHeader = response.headers.get("Content-Length"), length = lengthHeader === null ? null : Number(lengthHeader);
  if (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > limit)) {
    void response.body.cancel().catch(() => {});
    throw new ApiError(422, "attachment_too_large", "O anexo excede o limite permitido.");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("telegram_file_unavailable");
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new ApiError(422, "attachment_too_large", "O anexo excede o limite permitido.");
      chunks.push(part.value);
    }
    if (signal.aborted || !size || (length !== null && length !== size)) throw new Error("telegram_file_incomplete");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}
export interface TelegramMediaCopyOptions extends TelegramCallOptions { deadline?: number }
/** Somente após deduplicação central. O caller junta os statements ao lote da
 * identidade/mensagem. Uma falha após R2 reutiliza o mesmo ID determinístico. */
export async function copyTelegramMedia(env: Env, scope: { profileId: string; connectionId: string }, remoteId: string,
  media: readonly TelegramInboundMedia[], token: string, options: TelegramMediaCopyOptions = {}): Promise<{
    attachments: string[]; statements: Statement[]; unavailable: boolean; warnings: string[];
  }> {
  const attachments: string[] = [], statements: Statement[] = [], warnings: string[] = [];
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 30_000);
  for (let index = 0; index < media.length; index++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const attachment = media[index], declaredMime = mime(attachment.mimeType);
      const limit = mediaLimit(attachment.kind, "receive", declaredMime, attachment.bytes);
      if (index >= 10 || Date.now() >= deadline) throw new Error("telegram_file_unavailable");
      const id = await telegramMediaId(scope.connectionId, remoteId, index, attachment.fileId);
      const existing = await one<{ id: string }>(env, "SELECT id FROM media WHERE id=? AND profile_id=?", id, scope.profileId);
      if (existing) { attachments.push(id); continue; }
      const resolved = await telegramCall(token, "getFile", { file_id: attachment.fileId }, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
      if (resolved.kind !== "ok" || typeof resolved.result.file_path !== "string") throw new Error("telegram_file_unavailable");
      mediaLimit(attachment.kind, "receive", declaredMime, typeof resolved.result.file_size === "number" ? resolved.result.file_size : null);
      const response = await fetchTelegramFile(token, resolved.result.file_path, { ...options, signal: controller.signal });
      const responseMime = mime(response.headers.get("Content-Type"));
      if (!responseMime || (declaredMime && responseMime !== declaredMime) || !TELEGRAM_MEDIA_POLICY[attachment.kind]?.mimeTypes.includes(responseMime)) {
        void response.body?.cancel().catch(() => {}); throw new Error("telegram_file_type_invalid");
      }
      const bytes = await limitedBody(response, limit, controller.signal);
      const expectedSize = typeof resolved.result.file_size === "number" ? resolved.result.file_size : attachment.bytes;
      if (expectedSize !== null && expectedSize !== bytes.byteLength) throw new Error("telegram_file_incomplete");
      const objectKey = `${scope.profileId}/${id}`;
      await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType: responseMime } });
      statements.push(["INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        [id, scope.profileId, telegramMediaName(attachment.name), responseMime, bytes.byteLength, objectKey, `transport:${scope.connectionId}`, options.now ?? Date.now()]]);
      attachments.push(id);
    } catch (error) {
      warnings.push(error instanceof ApiError && error.code === "attachment_too_large" ? "attachment_too_large" : "attachment_unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { attachments, statements, unavailable: warnings.length > 0, warnings };
}
/** Lê exclusivamente o objeto privado da mesma área; não aceita URL remota. */
export async function prepareTelegramUpload(env: Env, profileId: string, attachment: SocialSendAttachment): Promise<{ method: TelegramMethod; formData: FormData }> {
  validateTelegramAttachment(attachment);
  const row = await one<{ size: number; type: string; name: string; object_key: string }>(env,
    "SELECT size,type,name,object_key FROM media WHERE id=? AND profile_id=?", attachment.mediaId, profileId);
  if (!row || row.size !== attachment.bytes || mime(row.type) !== mime(attachment.mimeType) || !row.object_key.startsWith(`${profileId}/`))
    throw new ApiError(422, "unsupported_content", "Anexo indisponível nesta área.");
  const object = await env.MEDIA.get(row.object_key);
  if (!object || object.size !== row.size) throw new ApiError(422, "unsupported_content", "Anexo incompleto.");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== row.size) throw new ApiError(422, "unsupported_content", "Anexo incompleto.");
  const fields: Record<MediaKind, [TelegramMethod, string]> = { image: ["sendPhoto", "photo"], video: ["sendVideo", "video"], audio: ["sendAudio", "audio"], document: ["sendDocument", "document"], sticker: ["sendSticker", "sticker"] };
  const [method, field] = fields[attachment.kind], formData = new FormData();
  formData.append(field, new Blob([bytes], { type: mime(row.type) }), telegramMediaName(row.name));
  return { method, formData };
}
