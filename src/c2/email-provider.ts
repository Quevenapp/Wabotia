/** Contrato REST do canal de e-mail, formato do plano; a conferir com a conta real.
 * O envio de MIME bruto (`raw`) e o retorno `result.id/status` são hipóteses
 * explícitas. A composição precisa confirmar este contrato; configuração
 * enviada pela UI nunca habilita uma hipótese de transporte. */
import { all, one } from "../db";
import { ApiError, json, now } from "../types";
import { canonical, sha } from "../security";
import { sendChannelEmail, type ChannelEmailMessage, type ChannelEmailTransport } from "../email";
import { normalizeEmailAddress as normalizeAddress } from "./email-mime";
import { mediaKind } from "../media";
import { validateMedia } from "../whatsapp";
import type { ChannelCompletionContext, ChannelDeliveryContext, ChannelDeliveryPlan, ChannelDeliveryResult,
  ChannelOperationContext, ChannelWritePlan, ServerChannelAction } from "../channel-c2-contracts";
import type { SocialSendAttachment } from "../channel-contracts";
import type { Statement } from "../customer/contracts";

export const EMAIL_SEND_MAX_BYTES = 26_214_400;
export const EMAIL_CHANNEL_QUOTAS = Object.freeze({ areaDaily: 200, senderHourly: 10, acknowledgementHourly: 1 });
export const EMAIL_PROVIDER_CONTRACT = Object.freeze({
  format: "cloudflare-email-raw-v1", confirmed: false,
  pending: ["raw: MIME completo em base64", "result.id: ID remoto", "result.status: accepted ou queued", "429: recusa sem aceitação"],
  note: "Formato do plano; a conferir com a conta real.",
});
export interface EmailProviderConfirmation {
  format: "cloudflare-email-raw-v1";
  raw: true;
  responseId: true;
}
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const fail = (code: string, message: string, status = 400): never => { throw new ApiError(status, code, message); };
function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== "string") return fail("email_address_invalid", "Informe um único endereço de e-mail válido.");
  return normalizeAddress(value);
}
const safeId = (value: unknown): value is string => typeof value === "string" && value.length <= 998 &&
  /^<[^<>\s\u0000-\u001f\u007f]+@[^<>\s\u0000-\u001f\u007f]+>$/.test(value);

export function emailSubject(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || /[\r\n\u0000]/.test(value))
    fail("subject_invalid", "O assunto aceita até 200 caracteres, sem quebras de linha.");
  return value as string;
}
function subjectKey(subject: string): string { return subject.replace(/^(?:\s*re\s*:\s*)+/i, "").trim().toLocaleLowerCase("pt-BR"); }
export function emailReplySubject(subject: string): string {
  const base = emailSubject(subject).replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return `Re: ${base}`.slice(0, 200);
}
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 24_576)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24_576))));
  return parts.join("");
}
const foldBase64 = (bytes: Uint8Array) => base64(bytes).match(/.{1,76}/g)?.join("\r\n") ?? "";
function encodedWords(text: string): string {
  // Cada palavra codificada tem no máximo 72 caracteres e não corta UTF-8.
  const words: string[] = []; let part = "";
  for (const character of text) {
    if (encoder.encode(part + character).byteLength > 42) { words.push(`=?UTF-8?B?${base64(encoder.encode(part))}?=`); part = ""; }
    part += character;
  }
  if (part) words.push(`=?UTF-8?B?${base64(encoder.encode(part))}?=`);
  return words.join("\r\n ");
}
function threading(message: Pick<ChannelEmailMessage, "messageId" | "inReplyTo" | "references">): string {
  const references = message.references ?? [];
  if (references.length > 50 || ![message.messageId, ...(message.inReplyTo ? [message.inReplyTo] : []), ...references].every(safeId))
    fail("invalid_request", "Cabeçalhos de encadeamento inválidos.");
  const headers = `Message-ID: ${message.messageId}\r\n` +
    (message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}\r\n` : "") +
    (references.length ? `References: ${references.join("\r\n ")}\r\n` : "");
  if (encoder.encode(headers).byteLength > 8192) fail("invalid_request", "Cabeçalhos de encadeamento excedem 8 KiB.");
  return headers;
}
/** Só cria texto MIME inerte; não gera HTML nem copia cabeçalhos do remetente. */
export async function encodeEmailMessage(message: ChannelEmailMessage & { from: string }): Promise<Uint8Array> {
  const from = normalizeEmailAddress(message.from), to = normalizeEmailAddress(message.to);
  const subject = emailSubject(message.subject);
  if (typeof message.text !== "string" || message.text.length > 50_000 || (!message.text.trim() && !message.attachments?.length))
    fail("unsupported_content", "Informe texto de até 50.000 caracteres ou um anexo.");
  const attachments = message.attachments ?? [];
  if (attachments.length > 32) fail("unsupported_content", "Use no máximo 32 anexos.");
  let estimate = encoder.encode(message.text).byteLength * 4 / 3 + 16_384;
  for (const attachment of attachments) {
    if (!attachment.name || attachment.name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(attachment.name) ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType) || !(attachment.bytes instanceof Uint8Array) || !attachment.bytes.length)
      fail("unsupported_content", "Anexo inválido.");
    estimate += Math.ceil(attachment.bytes.length / 3) * 4 * 78 / 76 + 2048;
    if (estimate > EMAIL_SEND_MAX_BYTES) fail("attachment_too_large", "O e-mail codificado excede 25 MiB.", 413);
  }
  const boundary = `wabotia_${(await sha(message.messageId)).slice(0, 40)}`;
  let mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${encodedWords(subject)}\r\n${threading(message)}` +
    (message.automatic ? "Auto-Submitted: auto-replied\r\n" : "") +
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(encoder.encode(message.text))}\r\n`;
  for (const attachment of attachments) {
    const filename = encodeURIComponent(attachment.name).replaceAll("'", "%27").replaceAll("*", "%2A");
    mime += `--${boundary}\r\nContent-Type: ${attachment.mimeType.toLowerCase()}\r\nContent-Disposition: attachment; filename*=UTF-8''${filename}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${foldBase64(attachment.bytes)}\r\n`;
  }
  const encoded = encoder.encode(`${mime}--${boundary}--\r\n`);
  if (encoded.byteLength > EMAIL_SEND_MAX_BYTES) fail("attachment_too_large", "O e-mail codificado excede 25 MiB.", 413);
  return encoded;
}
async function boundedResponse(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 65_536) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return null; } finally { reader.releaseLock(); }
}
export function createEmailProviderTransport(confirmation?: EmailProviderConfirmation, clock: () => number = now): ChannelEmailTransport {
  const confirmed = confirmation?.format === "cloudflare-email-raw-v1" && confirmation.raw === true && confirmation.responseId === true;
  return {
    async prepare(message) {
      if (!confirmed) fail("provider_contract_unverified", "Encadeamento e anexos aguardam confirmação do contrato do provedor.", 503);
      const encodedMessage = await encodeEmailMessage(message);
      // A fachada limita também o JSON REST a 25 MiB. Conferir a expansão
      // antes de alocar a segunda codificação evita uma cópia grande inútil.
      if (Math.ceil(encodedMessage.byteLength / 3) * 4 + 1024 > EMAIL_SEND_MAX_BYTES)
        fail("attachment_too_large", "O e-mail codificado excede o limite da requisição de envio.", 413);
      return { encodedMessage, body: { from: normalizeEmailAddress(message.from), to: normalizeEmailAddress(message.to), raw: base64(encodedMessage) } };
    },
    async read(response) {
      if (!confirmed) return { kind: "unknown", code: "provider_contract_unverified" };
      const body = await boundedResponse(response);
      const result = record(body?.result);
      if (response.ok && body?.success === true && ["accepted", "queued"].includes(String(result.status)) &&
          typeof result.id === "string" && /^[A-Za-z0-9._:@-]{1,200}$/.test(result.id))
        return { kind: "sent", externalId: result.id, context: { accepted: true, mailboxDeliveryConfirmed: false } };
      // Só uma recusa explícita, sem sucesso, permite repetir automaticamente.
      if (response.status === 429 && body?.success === false && result.id === undefined && result.status === undefined) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry && /^\d{1,6}$/.test(retry) ? Math.max(1, Math.min(86_400, Number(retry))) : 60;
        return { kind: "retry", notBefore: clock() + seconds * 1000, code: "rate_limited" };
      }
      if ([400, 401, 403, 413, 422].includes(response.status) && body?.success === false)
        return { kind: "failed", code: response.status === 413 ? "attachment_too_large" : "provider_rejected" };
      return { kind: "unknown", code: "provider_unknown" };
    },
  };
}
export const emailProviderTransport = createEmailProviderTransport();

interface StoredEmailDelivery {
  version: 1; to: string; from: string; subject: string; text: string; messageId: string;
  inReplyTo?: string; references: string[]; automatic: boolean; attachments: SocialSendAttachment[];
}
function deliveryPayload(ctx: ChannelDeliveryContext): StoredEmailDelivery {
  const value = record(record(json(ctx.outbox.payload).c2).delivery);
  if (value.version !== 1 || typeof value.to !== "string" || typeof value.from !== "string" || typeof value.subject !== "string" ||
      typeof value.text !== "string" || !safeId(value.messageId) || !Array.isArray(value.references) || !Array.isArray(value.attachments))
    fail("inbox_required", "Entrega de e-mail inválida.", 409);
  return value as unknown as StoredEmailDelivery;
}
function logKey(commandId: string, acknowledgement: boolean): string {
  return `channel.email:${acknowledgement ? "ack" : "send"}:${commandId}`;
}
async function assertRecipientUnblocked(ctx: Pick<ChannelOperationContext, "env" | "connection" | "authorization">, to: string): Promise<void> {
  if (await one(ctx.env, `SELECT 1 FROM email_channel_blocks WHERE profile_id=? AND connection_id=?
    AND ((kind='address' AND value=?) OR (kind='domain' AND value=?)) LIMIT 1`,
    ctx.authorization.profileId, ctx.connection.id, to, to.slice(to.lastIndexOf("@") + 1)))
    fail("recipient_blocked", "O destinatário está bloqueado nesta conexão.", 409);
}
export async function prepareEmailSend(ctx: ChannelOperationContext, action: ServerChannelAction, currentMessageId?: string): Promise<ChannelDeliveryPlan> {
  if (ctx.connection.channel !== "email" || ctx.connection.kind !== "email" || ctx.resource?.kind !== "conversation")
    fail("channel_not_ready", "Canal de e-mail indisponível.", 503);
  if (!["email.send", "email.auto-reply", "email.acknowledgement"].includes(action.type) || !("subject" in action) || !("text" in action))
    fail("unsupported_content", "Ação de e-mail obrigatória.");
  const input = action as Extract<ServerChannelAction, { type: "email.send" | "email.auto-reply" | "email.acknowledgement" }>;
  const config = record(json(ctx.connection.config));
  const automatic = input.type !== "email.send", acknowledgement = input.type === "email.acknowledgement";
  if (automatic ? ctx.authorization.origin !== "bot" || config[acknowledgement ? "auto_ack_enabled" : "bot_enabled"] !== true
    : ctx.authorization.origin !== "human" || ctx.authorization.actor.kind !== "user" || !!ctx.authorization.actor.via)
    fail("human_only", "A origem não permite esta resposta por e-mail.", 403);
  const conversation = ctx.resource!.kind === "conversation" ? ctx.resource!.conversation : fail("inbox_required", "Conversa obrigatória.", 409);
  const to = normalizeEmailAddress(conversation.channel_subject_id), from = normalizeEmailAddress(config.address);
  if (conversation.channel !== "email" || conversation.connection_id !== ctx.connection.id || conversation.channel_account_id !== from)
    fail("inbox_required", "O endereço da conversa mudou.", 409);
  await assertRecipientUnblocked(ctx, to);
  const subject = emailSubject(input.subject);
  if (input.text.length > 50_000 || (!input.text.trim() && !("attachments" in input && input.attachments?.length)))
    fail("unsupported_content", "Informe texto de até 50.000 caracteres ou um anexo.");
  const attachments = "attachments" in input ? [...(input.attachments ?? [])] : [];
  if (attachments.length > 32) fail("unsupported_content", "Use no máximo 32 anexos.");
  let encodedEstimate = encoder.encode(input.text).byteLength * 4 / 3 + 16_384;
  for (const attachment of attachments) {
    const media = await one<{ type: string; size: number; name: string }>(ctx.env,
      "SELECT type,size,name FROM media WHERE id=? AND profile_id=?", attachment.mediaId, ctx.authorization.profileId);
    if (!media || media.type !== attachment.mimeType || media.size !== attachment.bytes)
      fail("unsupported_content", "Anexo indisponível nesta área.");
    validateMedia({ type: media!.type, size: media!.size }, mediaKind(media!.type), ctx.connection);
    attachment.name = media!.name;
    encodedEstimate += Math.ceil(media!.size / 3) * 4 * 78 / 76 + 2048;
  }
  if (encodedEstimate > EMAIL_SEND_MAX_BYTES) fail("attachment_too_large", "O e-mail codificado excede 25 MiB.", 413);
  if (automatic && !currentMessageId) fail("sender_unverified", "A resposta automática exige a entrada corrente.", 403);
  // Respostas automáticas só recebem metadados da própria entrada. Nem sequer
  // leem assuntos anteriores da conversa operacional, que não autentica sessão.
  const received = await all<{ rfc_message_id: string | null; metadata: string }>(ctx.env,
    `SELECT rfc_message_id,metadata FROM email_channel_inbox WHERE profile_id=? AND connection_id=?
     AND conversation_id=? AND sender=? AND state='processed'${automatic ? " AND message_id=?" : ""}
     ORDER BY created DESC,id DESC LIMIT ${automatic ? "1" : "50"}`,
    ctx.authorization.profileId, ctx.connection.id, conversation.id, to, ...(automatic ? [currentMessageId] : []));
  if (automatic && !received.length) fail("sender_unverified", "A entrada corrente não permite resposta automática.", 403);
  const relevant = automatic ? received[0] : received.find(row => {
    const incomingSubject = String(record(json(row.metadata)).subject ?? "");
    return subjectKey(incomingSubject) === subjectKey(subject) || subjectKey(emailReplySubject(incomingSubject)) === subjectKey(subject);
  });
  const metadata = record(json(relevant?.metadata));
  const inReplyTo = safeId(relevant?.rfc_message_id) ? relevant.rfc_message_id : undefined;
  const references = Array.isArray(metadata.references) ? metadata.references.filter(safeId).slice(-49) : [];
  if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);
  // Cabeçalhos recebidos podem ser enormes: preserva os mais recentes dentro do teto.
  while (encoder.encode(references.join(" ")).byteLength > 6000) references.shift();
  const messageId = `<${await sha(canonical([ctx.authorization.profileId, ctx.connection.id, ctx.commandId]))}@${from.slice(from.lastIndexOf("@") + 1)}>`;
  threading({ messageId, inReplyTo, references });
  const toHash = await sha(to), key = logKey(ctx.commandId, acknowledgement), hour = ctx.now - 3_600_000, day = ctx.now - 86_400_000;
  const counts = await one<{ daily: number; hourly: number; acknowledgements: number }>(ctx.env,
    `SELECT count(*) daily,coalesce(sum(to_hash=? AND created>?),0) hourly,
      coalesce(sum(to_hash=? AND created>? AND key LIKE 'channel.email:ack:%'),0) acknowledgements
     FROM email_log WHERE profile_id=? AND purpose='channel.email' AND created>? AND key<>?`,
    toHash, hour, toHash, hour, ctx.authorization.profileId, day, key);
  if ((counts?.daily ?? 0) >= 200 || (counts?.hourly ?? 0) >= 10 || (acknowledgement && (counts?.acknowledgements ?? 0) >= 1))
    fail("quota_exhausted", "A cota local de e-mail foi atingida. Aguarde para enviar novamente.", 429);
  const payload: StoredEmailDelivery = { version: 1, to, from, subject, text: input.text, messageId, references, automatic, attachments,
    ...(inReplyTo ? { inReplyTo } : {}) };
  const requestHash = await sha(canonical(payload));
  return { resource: { kind: "conversation", id: conversation.id }, operation: input.type,
    orderKey: `conversation:${conversation.id}`, deliveries: [{ key: ctx.commandId, payload: { ...payload } }],
    reservations(deliveries): Statement[] {
      if (deliveries.length !== 1) fail("inbox_required", "Reserva de e-mail inválida.", 409);
      const id = deliveries[0].id;
      return [[`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN
        (SELECT count(*) FROM email_log WHERE profile_id=? AND purpose='channel.email' AND created>?)<200 AND
        (SELECT count(*) FROM email_log WHERE profile_id=? AND purpose='channel.email' AND to_hash=? AND created>?)<10 AND
        (?=0 OR (SELECT count(*) FROM email_log WHERE profile_id=? AND purpose='channel.email' AND to_hash=? AND created>?
          AND key LIKE 'channel.email:ack:%')<1)
        THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
      [`email-quota:${id}`, ctx.authorization.profileId, day, ctx.authorization.profileId, toHash, hour,
        acknowledgement ? 1 : 0, ctx.authorization.profileId, toHash, hour]],
      [`INSERT INTO email_log(id,profile_id,user_id,purpose,to_masked,to_hash,status,key,created,conversation_id,request_hash)
        VALUES(?,?,?,'channel.email',?,?,'reserved',?,?,?,?)`,
      [id, ctx.authorization.profileId, ctx.authorization.actor.id, `${to[0]}***@${to.slice(to.lastIndexOf("@") + 1)}`,
        toHash, key, ctx.now, conversation.id, requestHash]]];
    } };
}
export async function deliverEmail(ctx: ChannelDeliveryContext, transport: ChannelEmailTransport = emailProviderTransport): Promise<ChannelDeliveryResult> {
  if (ctx.connection.channel !== "email" || ctx.resource.kind !== "conversation")
    fail("channel_not_ready", "Canal de e-mail indisponível.", 503);
  const conversation = ctx.resource.kind === "conversation" ? ctx.resource.conversation : fail("inbox_required", "Conversa obrigatória.", 409);
  const payload = deliveryPayload(ctx), config = record(json(ctx.connection.config));
  if (normalizeEmailAddress(config.address) !== payload.from ||
      normalizeEmailAddress(conversation.channel_subject_id) !== payload.to)
    fail("inbox_required", "O endereço da entrega mudou.", 409);
  const reservation = await one(ctx.env, "SELECT id FROM email_log WHERE id=? AND profile_id=? AND purpose='channel.email'", ctx.outbox.id, ctx.outbox.profile_id);
  if (!reservation) fail("inbox_required", "A entrega não possui reserva de cota.", 409);
  const attachments: NonNullable<ChannelEmailMessage["attachments"]>[number][] = [];
  let total = 0;
  for (const attachment of payload.attachments) {
    const row = await one<{ object_key: string; type: string; size: number; name: string }>(ctx.env,
      "SELECT object_key,type,size,name FROM media WHERE id=? AND profile_id=?", attachment.mediaId, ctx.outbox.profile_id);
    if (!row || row.type !== attachment.mimeType || row.size !== attachment.bytes) fail("unsupported_content", "Anexo indisponível.");
    const object = await ctx.env.MEDIA.get(row!.object_key);
    if (!object || object.size !== row!.size || (total += object.size) > EMAIL_SEND_MAX_BYTES)
      fail("attachment_too_large", "Anexo indisponível ou acima do limite.", 413);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    if (bytes.length !== row!.size) fail("unsupported_content", "O anexo mudou antes do envio.");
    attachments.push({ name: row!.name, mimeType: row!.type, bytes });
  }
  return sendChannelEmail(ctx.env, ctx.connection, { ...payload, attachments }, async () => {
    await assertRecipientUnblocked({ env: ctx.env, connection: ctx.connection,
      authorization: { profileId: ctx.outbox.profile_id } as ChannelOperationContext["authorization"] }, payload.to);
    await ctx.beforeFetch();
  }, transport);
}
export async function completeEmail(ctx: ChannelCompletionContext): Promise<ChannelWritePlan> {
  if (ctx.resource.kind !== "conversation") fail("inbox_required", "Conclusão de e-mail exige conversa.", 409);
  const payload = deliveryPayload(ctx), sent = ctx.result.kind === "sent";
  const externalId = ctx.result.kind === "sent" ? ctx.result.externalId ?? null : null;
  const status = sent ? "accepted" : ctx.result.kind === "unknown" ? "unknown" : "failed";
  const statements: Statement[] = [[`UPDATE email_log SET status=?,error_code=?,provider_message_id=? WHERE id=? AND profile_id=? AND purpose='channel.email'`,
    [status, sent ? null : "code" in ctx.result ? ctx.result.code : null, externalId, ctx.outbox.id, ctx.outbox.profile_id]]];
  if (sent) statements.push([`INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,
      external_id,created,source_key,content,delivery_status) VALUES(?,?,?,'outbound',?,?,?,?,?,?,?,?)`,
    [`delivery:${ctx.outbox.id}`, ctx.outbox.profile_id, ctx.resource.id, ctx.outbox.actor, payload.text,
      JSON.stringify(payload.attachments.map(attachment => attachment.mediaId)), externalId, ctx.now,
      `delivery:${ctx.outbox.id}`, JSON.stringify({ version: 1, type: "email", email: { subject: payload.subject,
        messageId: payload.messageId, inReplyTo: payload.inReplyTo ?? null, references: payload.references,
        automatic: payload.automatic, accepted: true, mailboxDeliveryConfirmed: false } }), "sent"]]);
  return { statements, resource: { kind: "conversation", id: ctx.resource.id }, conversationId: ctx.resource.id, wake: false };
}
