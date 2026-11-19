/** Fronteira Zernio/TikTok. Envelope, códigos remotos, CDN e respostas abaixo
 * são o formato do plano; a conferir com a conta real. Nenhum alias do
 * fornecedor deve escapar deste arquivo. Importar este módulo não faz I/O. */
import type { ChannelConnectionContext, ChannelDeliveryContext, ChannelDeliveryResult, ChannelOperationContext, NormalizedChannelEvent, VerifiedIngress } from "../channel-c2-contracts";
import type { SocialSendAttachment } from "../channel-contracts";
import type { Statement } from "../customer/contracts";
import { assertVerifiedIngress } from "../channel-extension-kernel";
import { probeZernioChannelAccount } from "../channel-accounts";
import { one } from "../db";
import { publicUrl, sha } from "../security";
import { ApiError, json } from "../types";
import { zernioCredentials } from "../zernio";
import { socialMediaUrl } from "../zernio-social-media";

export const TIKTOK_TEXT_LIMIT = 6000;
export const TIKTOK_IMAGE_LIMIT = 3_000_000;
export type TikTokDeliveryPayload =
  | { kind: "text"; text: string; threadId: string }
  | { kind: "image"; attachment: SocialSendAttachment; threadId: string };

/** Revalida o vínculo e o Inbox pelo leitor de contas já existente na base.
 * O sucesso autoriza uma nova tentativa sujeita à mesma quota; não é uma
 * classificação de país/região nem uma promessa de elegibilidade do TikTok.
 * O chamador persiste a remoção do bloqueio apenas depois deste sucesso. */
export async function probeTikTokAccount(ctx: ChannelConnectionContext): Promise<{ ready: boolean; code?: string }> {
  if (ctx.connection.channel !== "tiktok" || ctx.connection.kind !== "zernio" || ctx.profileId !== ctx.connection.profile_id)
    return { ready: false, code: "channel_import_required" };
  try {
    await probeZernioChannelAccount(ctx.env, ctx.connection);
    return { ready: true };
  } catch (error) {
    // O transporte comum já saneia erros, mas o driver nunca expõe nem mesmo
    // esse texto remoto: a projeção contém somente códigos locais estáveis.
    const code = error instanceof ApiError ? error.code : "";
    return { ready: false, code: code === "inbox_required" ? "inbox_required"
      : code === "channel_not_ready" ? "channel_not_ready"
      : code === "not_found" ? "channel_import_required"
      : code === "zernio_rejected" ? "provider_authorization_failed"
      : "provider_unknown" };
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const opaque = (value: unknown): string | null => {
  const id = typeof value === "string" ? value : "";
  if (!id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  try { encodeURIComponent(id); return id; } catch { return null; }
};
const label = (value: unknown): string | undefined => typeof value === "string" && value
  ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) : undefined;
const timestamp = (value: unknown): number | null => {
  // Numeric values mean epoch milliseconds, never seconds or arrival time.
  // The documented fixture uses ISO UTC; reject rolled-over dates and local
  // date strings instead of allowing Date.parse to repair an invalid window.
  let time: unknown = value;
  if (typeof value === "string") {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
    time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(Number(time)).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  }
  return typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time <= Date.now() ? time : null;
};
const imageMime = (value: unknown): value is "image/jpeg" | "image/png" => value === "image/jpeg" || value === "image/png";

export function matchesTikTokEvent(input: unknown): boolean {
  const body = record(input);
  return body.event === "message.received" || body.event === "message.sent";
}

/** Somente leitura. A deduplicação do Coordinator acontece antes da mídia. */
export async function normalizeTikTokEvent(input: unknown, scope: VerifiedIngress): Promise<NormalizedChannelEvent | null> {
  assertVerifiedIngress(scope);
  if (scope.channel !== "tiktok" || scope.context !== "direct" || scope.source !== "zernio_hmac") return null;
  const body = record(input), account = record(body.account), message = record(body.message),
    conversation = record(body.conversation), metadata = record(body.metadata);
  if (!matchesTikTokEvent(input) || body.test === true || metadata.standby === true ||
      account.platform !== "tiktok" || opaque(account.accountId ?? account.id) !== scope.accountId ||
      !opaque(account.profileId) ||
      (message.platform !== undefined && message.platform !== "tiktok") ||
      (conversation.platform !== undefined && conversation.platform !== "tiktok") ||
      (conversation.accountId !== undefined && opaque(conversation.accountId) !== scope.accountId) ||
      (conversation.type !== undefined && conversation.type !== "direct")) return null;
  const incoming = body.event === "message.received";
  if (message.direction !== (incoming ? "incoming" : "outgoing")) return null;
  const peer = record(incoming ? message.sender : message.recipient);
  const peerId = opaque(peer.businessScopedUserId ?? peer.id), participant = opaque(conversation.participantId);
  if (peerId && participant && peerId !== participant) return null;
  const subjectId = participant ?? peerId, threadId = opaque(message.conversationId ?? conversation.id),
    remoteId = opaque(message.platformMessageId);
  if (!subjectId || !threadId || !remoteId ||
      (message.conversationId !== undefined && conversation.id !== undefined && message.conversationId !== conversation.id) ||
      (message.attachments !== undefined && !Array.isArray(message.attachments))) return null;
  const media = (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 32).map(raw => {
    const attachment = record(raw);
    return { kind: attachment.type === "image" ? "image" : "unsupported",
      mimeType: imageMime(attachment.mimeType) ? attachment.mimeType : null,
      sourceUrl: attachment.type === "image" && typeof attachment.url === "string" ? attachment.url : null,
      name: label(attachment.name ?? record(attachment.payload).filename) ?? null };
  });
  // A hint is not proof. The extension must join it against an attempted local
  // outbox belonging to this exact account, conversation and thread.
  const localDeliveryId = !incoming ? opaque(message.idempotencyKey ?? metadata.idempotencyKey) : null;
  return {
    // A later authenticated echo may add the local correlation missing from
    // an earlier external event. Let that enrichment reach reconciliation;
    // the same remote ID plus the same hint remains an exact replay.
    key: `${String(body.event)}:${await sha(incoming ? remoteId : JSON.stringify([remoteId, localDeliveryId]))}`,
    kind: String(body.event), occurredAt: timestamp(message.sentAt),
    subjectId, subjectNamespace: "dm", remoteId,
    context: { version: 1, context: "direct", threadId, providerProfileId: account.profileId,
      ...(label(peer.name) ? { displayName: label(peer.name) } : {}),
      ...(label(peer.username) ? { username: label(peer.username) } : {}),
      ...(localDeliveryId ? { localDeliveryId } : {}) },
    content: { text: typeof message.text === "string" ? message.text.slice(0, 50_000) : "", media,
      ...(Array.isArray(message.attachments) && message.attachments.length > 32 ? { mediaTruncated: true } : {}) },
  };
}

/** CDs aceitas apenas por política do servidor; a conferir com a conta real. */
const MEDIA_POLICY = Object.freeze({ exactOrigins: [], hostSuffixes: ["tiktokcdn.com", "tiktokcdn-us.com"] });

async function boundedImage(response: Response, declaredMime: unknown): Promise<{ bytes: Uint8Array; mime: string }> {
  const mime = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  const lengthHeader = response.headers.get("Content-Length"), length = lengthHeader === null ? null : Number(lengthHeader);
  if (!response.ok || !response.body || !imageMime(mime) || (declaredMime !== null && declaredMime !== mime) ||
      (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > TIKTOK_IMAGE_LIMIT))) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError(422, "unsupported_content", "Imagem indisponível ou fora dos limites do TikTok.");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > TIKTOK_IMAGE_LIMIT) throw new ApiError(413, "attachment_too_large", "A imagem excede 3.000.000 bytes.");
      chunks.push(chunk.value);
    }
    if (!size || (length !== null && size !== length)) throw new ApiError(422, "unsupported_content", "Imagem incompleta.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mime };
  } finally { await reader.cancel().catch(() => {}); }
}

/** Chamar exclusivamente em prepareInbound, depois da deduplicação central.
 * R2 é privado; nomes/URLs remotos não entram no conteúdo persistido. O lote
 * do chamador confirma metadados de mídia junto à identidade e à mensagem. */
export async function copyTikTokMedia(ctx: ChannelOperationContext, event: NormalizedChannelEvent): Promise<{
  attachments: string[]; unavailable: boolean; statements: Statement[];
}> {
  if (!ctx.ingress) throw new ApiError(403, "invalid_channel_evidence", "A origem do evento não foi confirmada.");
  assertVerifiedIngress(ctx.ingress);
  const attachments: string[] = [], statements: Statement[] = [];
  let unavailable = event.content.mediaTruncated === true;
  const media = Array.isArray(event.content.media) ? event.content.media : [];
  const deadline = Date.now() + 15_000;
  for (let index = 0; index < media.length; index++) {
    const item = record(media[index]);
    try {
      if (Date.now() >= deadline) throw new ApiError(408, "unsupported_content", "Prazo de cópia do anexo encerrado.");
      if (item.kind !== "image" || typeof item.sourceUrl !== "string" || (item.mimeType !== null && !imageMime(item.mimeType)))
        throw new ApiError(422, "unsupported_content", "Formato de anexo indisponível.");
      const id = `tiktok-media:${await sha(JSON.stringify([ctx.connection.id, event.remoteId, index]))}`;
      if (await one(ctx.env, "SELECT id FROM media WHERE id=? AND profile_id=?", id, ctx.authorization.profileId)) {
        attachments.push(id); continue;
      }
      const source = socialMediaUrl(item.sourceUrl, MEDIA_POLICY);
      // Recheck the authenticated binding immediately before external download.
      // Operation contexts have no beforeFetch hook (only delivery contexts do).
      if (!await one(ctx.env, `SELECT 1 FROM connections c JOIN zernio_channel_accounts a ON a.connection_id=c.id
        AND a.profile_id=c.profile_id WHERE c.id=? AND c.profile_id=? AND c.channel='tiktok' AND c.kind='zernio'
        AND c.status='active' AND a.channel='tiktok' AND a.account_id=? AND a.provider_profile_id=?`,
        ctx.connection.id, ctx.authorization.profileId, ctx.ingress.accountId, event.context.providerProfileId))
        throw new ApiError(403, "invalid_channel_evidence", "A origem do evento não foi confirmada.");
      const response = await fetch(source, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      const image = await boundedImage(response, item.mimeType);
      const objectKey = `${ctx.authorization.profileId}/${id}`;
      await ctx.env.MEDIA.put(objectKey, image.bytes, { httpMetadata: { contentType: image.mime } });
      const name = (label(item.name) ?? `Imagem TikTok ${index + 1}`).replace(/[\\/]/g, "_");
      statements.push(["INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        [id, ctx.authorization.profileId, name, image.mime, image.bytes.byteLength, objectKey, `transport:${ctx.connection.id}`, ctx.now]]);
      attachments.push(id);
    } catch { unavailable = true; }
  }
  return { attachments, unavailable, statements };
}

/** Somente códigos conhecidos, nunca mensagem, URL ou corpo do fornecedor. */
function responseFailure(status: number, raw: unknown): ChannelDeliveryResult {
  const body = record(raw), code = typeof body.code === "string" ? body.code.toLowerCase() : "";
  if (status >= 500 || body.unconfirmedWrite === true) return { kind: "unknown", code: "provider_unknown" };
  if (["account_ineligible", "tiktok_account_ineligible", "region_not_supported", "account_not_eligible"].includes(code))
    return { kind: "failed", code: "tiktok_account_ineligible" };
  if (status === 429) return { kind: "failed", code: "rate_limited" };
  return { kind: "failed", code: status === 401 || status === 403 ? "provider_authorization_failed" : "unsupported_content" };
}

class ProviderFailure extends Error {
  constructor(readonly result: ChannelDeliveryResult) { super("O fornecedor não confirmou esta operação."); }
}

async function readProviderResponse(response: Response): Promise<unknown> {
  const maxBytes = 262_144;
  if (!response.body) return null;
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > maxBytes)) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

async function request(ctx: ChannelDeliveryContext, path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const keys = record(await zernioCredentials(ctx.env, ctx.connection));
  if (typeof keys.api_key !== "string" || !keys.api_key) throw new ApiError(503, "channel_not_ready", "Configure a integração Zernio.");
  // No remote call may hide a missing/revoked reservation behind a catch.
  await ctx.beforeFetch();
  let response: Response;
  try {
    response = await fetch(`https://zernio.com/api/v1/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${keys.api_key}`, "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new ProviderFailure({ kind: "unknown", code: "provider_unknown" }); }
  const raw = await readProviderResponse(response);
  if (!response.ok || record(raw).success === false) throw new ProviderFailure(responseFailure(response.status, raw));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderFailure({ kind: "unknown", code: "provider_unknown" });
  return record(raw);
}

function mediaAddress(value: unknown): string {
  if (typeof value !== "string") throw new ProviderFailure({ kind: "failed", code: "provider_contract_unverified" });
  try {
    const safe = publicUrl(value), url = new URL(safe);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("url");
    return safe;
  } catch { throw new ProviderFailure({ kind: "failed", code: "provider_contract_unverified" }); }
}

/** Há exatamente um POST de mensagem. Presign/PUT transferem somente a imagem
 * e também passam pela guarda de janela/reserva, sem usar zernioUpload (que
 * não expõe essa guarda). Nunca faz divisão, retry ou fallback de conteúdo. */
export async function sendTikTokDelivery(ctx: ChannelDeliveryContext, payload: TikTokDeliveryPayload): Promise<ChannelDeliveryResult> {
  if (!payload || (payload.kind !== "text" && payload.kind !== "image"))
    throw new ApiError(422, "unsupported_content", "O TikTok aceita texto ou imagem por entrega.");
  if (!opaque(payload.threadId)) throw new ApiError(409, "cannot_initiate", "Aguarde uma mensagem do cliente no TikTok.");
  const accountId = json(ctx.connection.config).account_id;
  if (ctx.connection.channel !== "tiktok" || typeof accountId !== "string") throw new ApiError(503, "channel_not_ready", "Este canal não está disponível.");
  let body: Record<string, unknown>;
  try {
    if (payload.kind === "text") {
      if (!payload.text || [...payload.text].length > TIKTOK_TEXT_LIMIT) throw new ApiError(422, "unsupported_content", "O texto do TikTok aceita até 6.000 caracteres.");
      body = { accountId, text: payload.text };
    } else {
      const attachment = payload.attachment;
      if (attachment.kind !== "image" || !imageMime(attachment.mimeType) || !Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0 || attachment.bytes > TIKTOK_IMAGE_LIMIT)
        throw new ApiError(422, "unsupported_content", "Envie uma imagem JPG ou PNG de até 3.000.000 bytes.");
      const media = await one<{ size: number; type: string; object_key: string; name: string }>(ctx.env,
        "SELECT size,type,object_key,name FROM media WHERE id=? AND profile_id=?", attachment.mediaId, ctx.outbox.profile_id);
      if (!media || media.size !== attachment.bytes || media.type !== attachment.mimeType)
        throw new ApiError(422, "unsupported_content", "A imagem não pertence à área ou foi alterada.");
      const object = await ctx.env.MEDIA.get(media.object_key);
      if (!object || object.size !== attachment.bytes) throw new ApiError(422, "unsupported_content", "A imagem está indisponível.");
      const presign = await request(ctx, "media/presign", { filename: media.name, contentType: media.type, size: media.size });
      const uploadUrl = mediaAddress(presign.uploadUrl), url = mediaAddress(presign.publicUrl);
      await ctx.beforeFetch();
      let uploaded: Response;
      try {
        uploaded = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": media.type, "Content-Length": String(media.size) },
          body: object.body, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15_000) });
      } catch { throw new ProviderFailure({ kind: "unknown", code: "provider_unknown" }); }
      if (!uploaded.ok) throw new ProviderFailure({ kind: "failed", code: "provider_media_failed" });
      body = { accountId, attachments: [{ type: "image", payload: { url } }] };
    }
    const result = await request(ctx, `inbox/conversations/${encodeURIComponent(payload.threadId)}/messages`, body, ctx.outbox.id);
    const message = record(result.message), data = record(result.data);
    const externalId = opaque(message.platformMessageId ?? result.platformMessageId ?? record(data.message).platformMessageId);
    if (!externalId) return { kind: "unknown", code: "provider_contract_unverified" };
    return { kind: "sent", externalId };
  } catch (error) {
    if (error instanceof ProviderFailure) return error.result;
    throw error;
  }
}
