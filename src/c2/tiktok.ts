/** TikTok DM pela Zernio. Instalação explícita, sem I/O na avaliação do módulo. */
import type { ChannelConnection, ChannelSpec } from "../channel-contracts";
import type { ChannelConnectionContext, ChannelConnectionDriver, ChannelConnectionResult, ChannelDeliveryContext,
  ChannelDeliveryPlan, ChannelExtension, ChannelOperationContext, ChannelWritePlan, NormalizedChannelEvent,
  ServerChannelAction } from "../channel-c2-contracts";
import type { Statement } from "../customer/contracts";
import { prepareChannelInbound } from "../customer/channel-identity";
import { assertVerifiedIngress } from "../channel-extension-kernel";
import { one, exec } from "../db";
import { eventStatement } from "../events";
import { lineService } from "../line-service";
import { sha } from "../security";
import { signedPayload } from "../signature";
import { ApiError, json, now, type Conversation } from "../types";
import { copyTikTokMedia, matchesTikTokEvent, normalizeTikTokEvent, probeTikTokAccount, sendTikTokDelivery,
  type TikTokDeliveryPayload } from "./tiktok-provider";

export const TIKTOK_WINDOW_MS = 48 * 60 * 60 * 1000;
export const TIKTOK_MAX_MESSAGES = 10;
export const tiktokSpec: ChannelSpec = {
  id: "tiktok", label: "TikTok", enabled: true, transport: "zernio", serviceLine: true, context: "direct",
  contexts: { direct: { enabled: true, bot: true, publicReply: false } },
  text: { enabled: true, maxChars: 6000 },
  media: { image: { receive: true, send: true, maxSendBytes: 3_000_000, mimeTypes: ["image/jpeg", "image/png"] } },
  menu: { buttons: 0, quickReplies: 0, listItems: 0, fallback: "numbered_text" },
  window: { kind: "customer", hours: 48, maxMessages: 10, after: "blocked" },
  initiation: "customer_first", templates: false, subject: false, replyTo: false, bold: "none",
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : "";
const error = (code: string, message: string) => new ApiError(409, code, message);
const emptyPlan = (): ChannelWritePlan => ({ statements: [], wake: false });
const quotaReason = "O TikTok permite até dez mensagens ou tentativas em 48 horas corridas. Aguarde uma vaga; nova entrada não zera o contador.";
const windowReason = "A janela de 48 horas do TikTok terminou. Aguarde uma nova mensagem do cliente.";

/** A própria importação é opt-in. A desativação explícita conserva o histórico. */
function enabled(connection: ChannelConnection): boolean {
  return connection.channel === "tiktok" && connection.kind === "zernio" &&
    json(connection.config).c2_enabled !== false && !json(connection.config).remove_pending;
}
function conversation(ctx: ChannelOperationContext): Conversation {
  const c = ctx.resource?.kind === "conversation" ? ctx.resource.conversation : null;
  if (!c || !enabled(ctx.connection) || ctx.connection.status !== "active" || c.channel !== "tiktok" ||
      c.profile_id !== ctx.authorization.profileId || c.profile_id !== ctx.connection.profile_id ||
      c.connection_id !== ctx.connection.id || c.external_namespace !== `channel:${ctx.connection.id}` ||
      c.chat_type !== "direct" || c.channel_account_id !== json(ctx.connection.config).account_id || !identifier(c.channel_subject_id))
    throw error("channel_not_ready", "Esta conversa não está disponível para envio pelo TikTok.");
  return c;
}
function windowBlock(last: number, time: number): string | null {
  if (!Number.isSafeInteger(last) || last <= 0 || last > time) return "cannot_initiate";
  return time - last >= TIKTOK_WINDOW_MS ? "window_closed" : null;
}
// Reserva pendente não perde a vaga com a idade: é liberada na conclusão local
// ou atualiza counted_at ao tentar. Isso fecha o intervalo entre reserva e envio.
const counted = "(state='reserved' OR (state IN ('attempted','sent','unknown','external') AND counted_at>?))";
async function usedSlots(ctx: Pick<ChannelOperationContext, "env" | "connection">, c: Conversation, time: number): Promise<number> {
  return (await one<{ used: number }>(ctx.env,
    `SELECT count(*) used FROM tiktok_send_slots WHERE profile_id=? AND connection_id=? AND conversation_id=? AND ${counted}`,
    c.profile_id, ctx.connection.id, c.id, time - TIKTOK_WINDOW_MS))?.used ?? 0;
}
function eligibility(config: string): string | null {
  return json(config).tiktok_error_code === "tiktok_account_ineligible" ? "tiktok_account_ineligible" : null;
}
function blocked(code: string) {
  return { code, reason: code === "quota_exhausted" ? quotaReason : code === "window_closed" ? windowReason
    : code === "tiktok_account_ineligible" ? "A conta não está elegível para mensagens do TikTok. Confira a integração na Zernio."
    : "O cliente precisa iniciar a conversa pelo TikTok com uma mensagem de data válida." };
}

async function prepareSend(ctx: ChannelOperationContext, action: ServerChannelAction): Promise<ChannelDeliveryPlan> {
  const c = conversation(ctx);
  if (action.type !== "message.send") throw error("unsupported_content", "O TikTok aceita texto ou imagem por entrega.");
  if (Array.from(action.text).length > 6000) throw error("unsupported_content", "O texto do TikTok pode ter até 6.000 caracteres, incluindo a assinatura.");
  if ((action.attachments?.length ?? 0) > 1) throw error("unsupported_content", "Selecione uma imagem por mensagem no TikTok.");
  const thread = await one<{ conversation_id: string }>(ctx.env,
    "SELECT conversation_id FROM zernio_conversations WHERE connection_id=? AND external_id=?", ctx.connection.id, c.external_id);
  if (!thread || !identifier(thread.conversation_id)) throw error("cannot_initiate", "Aguarde uma mensagem do cliente pelo TikTok.");
  const deliveries: ChannelDeliveryPlan["deliveries"][number][] = [];
  // Ordem explícita e estável: texto primeiro, depois imagem. Nunca há legenda oculta.
  if (action.text.trim()) deliveries.push({ key: "text", payload: { kind: "text", text: action.text, threadId: thread.conversation_id } });
  for (const attachment of action.attachments ?? []) {
    if (attachment.kind !== "image" || !["image/jpeg", "image/png"].includes(attachment.mimeType) ||
        !identifier(attachment.mediaId) || !Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0)
      throw error("unsupported_content", "O TikTok aceita somente imagens JPG ou PNG.");
    if (attachment.bytes > 3_000_000) throw error("attachment_too_large", "A imagem do TikTok pode ter até 3.000.000 bytes.");
    deliveries.push({ key: "image", payload: { kind: "image", attachment: { ...attachment }, threadId: thread.conversation_id } });
  }
  if (!deliveries.length) throw error("unsupported_content", "Informe um texto ou uma imagem.");
  const replay = await one(ctx.env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe=? AND connection_id=? AND conversation_id=? AND kind='channel'",
    c.profile_id, `c2:${c.profile_id}:${ctx.commandId}`, ctx.connection.id, c.id);
  if (!replay) {
    const code = eligibility(ctx.connection.config) ?? windowBlock(c.last_customer, ctx.now);
    if (code) throw error(code, blocked(code).reason);
    if (await usedSlots(ctx, c, ctx.now) + deliveries.length > TIKTOK_MAX_MESSAGES) throw error("quota_exhausted", quotaReason);
  }
  return {
    resource: { kind: "conversation", id: c.id }, operation: "message.send", orderKey: `conversation:${c.id}`, deliveries,
    reservations(ids) {
      const time = now();
      const writes: Statement[] = [[
        `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN
          (SELECT count(*) FROM tiktok_send_slots WHERE profile_id=? AND connection_id=? AND conversation_id=? AND ${counted})+?<=10
          AND EXISTS(SELECT 1 FROM conversations c JOIN connections k ON k.id=c.connection_id AND k.profile_id=c.profile_id
            WHERE c.id=? AND c.profile_id=? AND c.connection_id=? AND c.channel='tiktok' AND c.chat_type='direct'
            AND c.epoch=? AND c.last_customer>? AND c.last_customer<=? AND k.status='active'
            AND coalesce(json_extract(k.config,'$.c2_enabled'),1)<>0 AND coalesce(json_extract(k.config,'$.remove_pending'),0)=0
            AND coalesce(json_extract(k.config,'$.tiktok_error_code'),'')<>'tiktok_account_ineligible')
          THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
        [`tiktok-quota:${ids[0].id}`, c.profile_id, ctx.connection.id, c.id, time - TIKTOK_WINDOW_MS, ids.length,
          c.id, c.profile_id, ctx.connection.id, c.epoch, time - TIKTOK_WINDOW_MS, time],
      ]];
      for (const { id } of ids) writes.push([
        `INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,outbox_id,state,counted_at,created,updated)
          VALUES(?,?,?,?,?,'reserved',?,?,?)`, [`tiktok:${id}`, c.profile_id, ctx.connection.id, c.id, id, time, time, time],
      ]);
      return writes;
    },
  };
}

interface Slot { id: string; outbox_id: string | null; provider_message_id: string | null; state: string; counted_at: number }
/** A mesma vaga converge por ID remoto, inclusive quando o eco vence a resposta HTTP. */
function confirmSlot(profile: string, connection: string, conversationId: string, id: string, remote: string | null, time: number): Statement[] {
  const writes: Statement[] = [];
  if (remote) writes.push([
    `UPDATE tiktok_send_slots SET counted_at=max(counted_at,coalesce((SELECT counted_at FROM tiktok_send_slots
      WHERE connection_id=? AND conversation_id=? AND provider_message_id=? AND outbox_id IS NULL),counted_at)) WHERE outbox_id=? AND profile_id=?`,
    [connection, conversationId, remote, id, profile],
  ], ["DELETE FROM tiktok_send_slots WHERE connection_id=? AND conversation_id=? AND provider_message_id=? AND outbox_id IS NULL AND profile_id=?",
    [connection, conversationId, remote, profile]]);
  writes.push(["UPDATE tiktok_send_slots SET state='sent',provider_message_id=coalesce(?,provider_message_id),updated=? WHERE outbox_id=? AND profile_id=?",
    [remote, time, id, profile]]);
  return writes;
}
async function outboundMessage(profile: string, c: Conversation, remote: string | null, local: string | null,
  author: string, text: string, attachments: readonly string[], time: number, unavailable = false): Promise<Statement[]> {
  const id = local ? `delivery:${local}` : `tiktok-out:${await sha(JSON.stringify([c.connection_id, remote]))}`;
  const content = JSON.stringify({ version: 1, channel: "tiktok", context: "direct", external: !local,
    ...(unavailable ? { unavailable: true, attachmentWarnings: ["Uma mídia não está disponível neste canal."] } : {}) });
  const writes: Statement[] = [];
  // Um balão externo já conhecido pode passar a ser a entrega local confirmada.
  if (local && remote) writes.push([
    "DELETE FROM messages WHERE profile_id=? AND conversation_id=? AND direction='outbound' AND external_id=? AND id<>? AND json_extract(content,'$.external')=1",
    [profile, c.id, remote, id],
  ]);
  writes.push([
    `INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status)
      VALUES(?,?,?,'outbound',?,?,?,?,?,?,?,'sent') ON CONFLICT(id) DO UPDATE SET
      external_id=coalesce(excluded.external_id,messages.external_id),delivery_status='sent'`,
    [id, profile, c.id, author, text, JSON.stringify(attachments), remote, time, id, content],
  ], eventStatement(profile, "message.sent", id, { conversation_id: c.id, message_id: id, text, attachments }),
  ["UPDATE conversations SET updated=max(updated,?) WHERE id=? AND profile_id=?", [time, c.id, profile]]);
  return writes;
}

async function prepareInbound(ctx: ChannelOperationContext, event: NormalizedChannelEvent): Promise<ChannelWritePlan> {
  const scope = ctx.ingress;
  if (!scope) throw error("invalid_channel_evidence", "A origem do evento não foi confirmada.");
  assertVerifiedIngress(scope);
  const config = json(ctx.connection.config), profile = ctx.authorization.profileId, connection = ctx.connection.id;
  if (!enabled(ctx.connection)) return emptyPlan();
  if (scope.channel !== "tiktok" || scope.context !== "direct" || scope.source !== "zernio_hmac" ||
      scope.profileId !== profile || scope.connectionId !== connection || scope.accountId !== config.account_id ||
      event.context.providerProfileId !== config.zernio_profile_id || !identifier(event.subjectId) || event.subjectNamespace !== "dm" ||
      !identifier(event.context.threadId) || !["message.received", "message.sent"].includes(event.kind))
    throw new ApiError(403, "invalid_channel_evidence", "A origem do evento não corresponde à conta importada.");
  const received = event.kind === "message.received", externalId = `dm:${encodeURIComponent(event.subjectId)}`, namespace = `channel:${connection}`;
  let c = await one<Conversation>(ctx.env,
    "SELECT * FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?", profile, namespace, externalId);
  const fresh = !c;
  const id = c?.id ?? `tiktok-conversation:${await sha(JSON.stringify([profile, connection, event.subjectId]))}`;
  const time = ctx.now;
  const customerAt = Number.isSafeInteger(event.occurredAt) && Number(event.occurredAt) > 0 && Number(event.occurredAt) <= time
    ? Number(event.occurredAt) : 0;
  const context = JSON.stringify({ version: 1, context: "direct", multichannel: config._channel_summary?.multichannel === true });
  const writes: Statement[] = [];
  if (!c) {
    c = { id, profile_id: profile, connection_id: connection, external_namespace: namespace, external_id: externalId,
      channel: "tiktok", channel_account_id: scope.accountId, channel_subject_id: event.subjectId, channel_context: context,
      account_label: ctx.connection.account_label || "", phone: null, verified_phone: null, customer_link_state: "pending",
      chat_type: "direct", title: label(event.context.displayName) || "Contato do TikTok", bot_policy: "mentions",
      state: received ? "ai" : "waiting", owner: null, epoch: 1,
      session: id, topic: null, tags: "[]", last_customer: 0, created: time, updated: time };
    writes.push([
      `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,
        channel,account_label,channel_account_id,channel_subject_id,channel_context,title,state,epoch,chat_type)
        VALUES(?,?,?,?,?,?,0,?,?,'tiktok',?,?,?,?,?,?,1,'direct')`,
      [id, profile, connection, namespace, externalId, c.session, time, time, c.account_label, scope.accountId,
        event.subjectId, context, c.title, c.state],
    ]);
  }
  if (c.channel !== "tiktok" || c.connection_id !== connection || c.channel_account_id !== scope.accountId ||
      c.channel_subject_id !== event.subjectId || c.chat_type !== "direct") throw error("invalid_channel_evidence", "O evento pertence a outra origem.");
  writes.push([
    `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM zernio_conversations
      WHERE connection_id=? AND conversation_id=? AND external_id<>?) THEN 1 ELSE 0 END
      ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`, [`tiktok-thread:${id}`, connection, event.context.threadId, externalId],
  ], [`INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?) ON CONFLICT(connection_id,external_id)
    ${received && customerAt > 0 && customerAt >= c.last_customer ? "DO UPDATE SET conversation_id=excluded.conversation_id" : "DO NOTHING"}`,
    [connection, externalId, event.context.threadId]]);
  const text = typeof event.content.text === "string" ? event.content.text.slice(0, 50_000) : "";
  if (!received) {
    const known = await one<Slot>(ctx.env, "SELECT * FROM tiktok_send_slots WHERE profile_id=? AND connection_id=? AND conversation_id=? AND provider_message_id=?",
      profile, connection, id, event.remoteId);
    const local = await one<{ id: string; actor: string; payload: string }>(ctx.env,
      `SELECT o.id,o.actor,o.payload FROM outbox o JOIN channel_delivery_state s ON s.outbox_id=o.id
        JOIN tiktok_send_slots t ON t.outbox_id=o.id WHERE o.profile_id=? AND o.connection_id=? AND o.conversation_id=? AND o.kind='channel'
        AND (t.provider_message_id IS NULL OR t.provider_message_id=?)
        AND (o.external_id=? OR t.provider_message_id=? OR (o.id=? AND s.attempted_at IS NOT NULL))
        AND json_extract(o.payload,'$.c2.delivery.threadId')=? LIMIT 1`,
      profile, connection, id, event.remoteId, event.remoteId, event.remoteId,
      identifier(event.context.localDeliveryId) ? event.context.localDeliveryId : "", event.context.threadId);
    if (local) {
      const payload = record(record(json(local.payload).c2).delivery), attachment = record(payload.attachment);
      writes.push(...confirmSlot(profile, connection, id, local.id, event.remoteId, time),
        ["UPDATE outbox SET status='sent',external_id=?,error=NULL,completion_handled=0,updated=? WHERE id=? AND profile_id=?",
          [event.remoteId, time, local.id, profile]],
        ...await outboundMessage(profile, c, event.remoteId, local.id, local.actor,
          typeof payload.text === "string" ? payload.text : "", identifier(attachment.mediaId) ? [attachment.mediaId] : [], time));
      return { conversationId: id, resource: { kind: "conversation", id }, statements: writes, wake: true };
    }
    if (known) return { conversationId: id, resource: { kind: "conversation", id }, statements: writes, wake: false };
    const media = await copyTikTokMedia(ctx, event);
    writes.push(...media.statements, [
      `INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,provider_message_id,state,counted_at,created,updated)
        VALUES(?,?,?,?,?,'external',?,?,?)`,
      [`tiktok-external:${await sha(JSON.stringify([connection, event.remoteId]))}`, profile, connection, id, event.remoteId, customerAt || time, time, time],
    ], ...await outboundMessage(profile, c, event.remoteId, null, "external:tiktok", text, media.attachments, time, media.unavailable));
    return { conversationId: id, resource: { kind: "conversation", id }, statements: writes, wake: false };
  }
  // Uma saída no aplicativo pode ter criado apenas o histórico operacional.
  // A primeira entrada real passa a obedecer à configuração de atendimento.
  if (!fresh && c.last_customer === 0 && !c.channel_identity_id && c.state === "waiting" && !c.owner)
    c = { ...c, state: "ai" };
  if (c.state === "closed") c = { ...c, state: "ai", owner: null,
    session: `tiktok-session:${await sha(JSON.stringify([id, event.remoteId]))}`, epoch: c.epoch + 1 };
  const queuedByLine = lineService(config).mode === "human" && c.state === "ai" && !c.assigned_bot_id;
  if (queuedByLine) c = { ...c, state: "waiting", owner: null, epoch: c.epoch + 1 };
  if (!fresh && c.state === "ai") c = { ...c, epoch: c.epoch + 1 };
  const identity = await prepareChannelInbound(ctx.env, c, { provider: "zernio", channel: "tiktok", accountId: scope.accountId,
    subjectId: event.subjectId, subjectNamespace: "dm", ingress: scope,
    ...(typeof event.context.displayName === "string" ? { displayName: label(event.context.displayName) } : {}),
    ...(typeof event.context.username === "string" ? { username: label(event.context.username) } : {}) });
  const media = await copyTikTokMedia(ctx, event);
  const messageId = `tiktok-in:${await sha(JSON.stringify([connection, event.remoteId]))}`;
  const content = { version: 1, context: "direct", channel: "tiktok", customerSession: c.session,
    ...(media.unavailable ? { unavailable: true, attachmentWarnings: ["Uma mídia não está disponível neste canal."] } : {}) };
  writes.push(["UPDATE conversations SET state=?,owner=?,session=?,epoch=?,last_customer=max(last_customer,?),updated=? WHERE id=? AND profile_id=?",
    [c.state, c.owner, c.session, c.epoch, customerAt, time, id, profile]], ...identity.statements, ...media.statements,
  ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content) VALUES(?,?,?,'customer',?,?,?,?,?,?)",
    [messageId, profile, id, `customer:${namespace}:${event.subjectId}`, text, JSON.stringify(media.attachments), event.remoteId, time, JSON.stringify(content)]],
  ["INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
    [messageId, profile, messageId, id, JSON.stringify({ text, attachments: media.attachments, content, message_id: event.remoteId,
      message_record_id: messageId, epoch: c.epoch, session: c.session, ...(queuedByLine ? { queued_by_line: true } : {}) }), time]]);
  return { conversationId: id, resource: { kind: "conversation", id }, statements: writes, wake: true };
}

async function deliver(ctx: ChannelDeliveryContext) {
  if (ctx.resource.kind !== "conversation" || ctx.resource.conversation.channel !== "tiktok")
    return { kind: "failed" as const, code: "channel_not_ready" };
  const stored = record(record(json(ctx.outbox.payload).c2).delivery);
  const slot = await one<Slot>(ctx.env, "SELECT * FROM tiktok_send_slots WHERE outbox_id=? AND profile_id=? AND connection_id=? AND conversation_id=?",
    ctx.outbox.id, ctx.outbox.profile_id, ctx.connection.id, ctx.resource.id);
  if (!slot) return { kind: "failed" as const, code: "quota_exhausted" };
  if (slot.state === "sent") return { kind: "sent" as const, ...(slot.provider_message_id ? { externalId: slot.provider_message_id } : {}) };
  if (slot.state === "attempted" || slot.state === "unknown") return { kind: "unknown" as const, code: "provider_unknown" };
  if (slot.state !== "reserved") return { kind: "failed" as const, code: "quota_exhausted" };
  let remoteStarted = false;
  const guarded: ChannelDeliveryContext = { ...ctx, beforeFetch: async () => {
    // Reautorização pode aguardar D1: prazo e quota são conferidos DEPOIS dela.
    // Se a recusa ainda for local, complete libera a vaga que continua reserved.
    await ctx.beforeFetch();
    const current = await one<Conversation & { config: string; thread_id: string | null }>(ctx.env,
      `SELECT c.*,k.config,(SELECT z.conversation_id FROM zernio_conversations z
        WHERE z.connection_id=c.connection_id AND z.external_id=c.external_id) thread_id
        FROM conversations c JOIN connections k ON k.id=c.connection_id AND k.profile_id=c.profile_id
        WHERE c.id=? AND c.profile_id=? AND c.connection_id=? AND k.status='active'`,
      ctx.resource.id, ctx.outbox.profile_id, ctx.connection.id);
    if (!current) throw error("channel_not_ready", "A conexão não está ativa.");
    if (current.thread_id !== stored.threadId) throw error("resource_changed", "A conversa do TikTok mudou. Prepare uma nova resposta.");
    const time = now();
    const code = eligibility(current.config) ?? windowBlock(current.last_customer, time);
    if (code) throw error(code, blocked(code).reason);
    const claim = await exec(ctx.env,
      `UPDATE tiktok_send_slots SET state='attempted',counted_at=?,updated=? WHERE id=? AND profile_id=? AND state=?
        AND (SELECT count(*) FROM tiktok_send_slots WHERE profile_id=? AND connection_id=? AND conversation_id=? AND id<>? AND ${counted})<10
        AND EXISTS(SELECT 1 FROM conversations c JOIN connections k ON k.id=c.connection_id AND k.profile_id=c.profile_id
          WHERE c.id=? AND c.profile_id=? AND c.connection_id=? AND c.epoch=? AND c.last_customer>? AND c.last_customer<=?
          AND c.channel='tiktok' AND k.status='active' AND coalesce(json_extract(k.config,'$.c2_enabled'),1)<>0
          AND coalesce(json_extract(k.config,'$.remove_pending'),0)=0
          AND coalesce(json_extract(k.config,'$.tiktok_error_code'),'')<>'tiktok_account_ineligible'
          AND EXISTS(SELECT 1 FROM zernio_conversations z WHERE z.connection_id=k.id AND z.external_id=c.external_id AND z.conversation_id=?))`,
      time, time, slot.id, ctx.outbox.profile_id, remoteStarted ? "attempted" : "reserved",
      ctx.outbox.profile_id, ctx.connection.id, ctx.resource.id, slot.id, time - TIKTOK_WINDOW_MS,
      ctx.resource.id, ctx.outbox.profile_id, ctx.connection.id, ctx.outbox.epoch, time - TIKTOK_WINDOW_MS, time, stored.threadId);
    if (!claim.meta.changes) throw error("quota_exhausted", quotaReason);
    if (windowBlock(current.last_customer, now())) {
      if (!remoteStarted) await exec(ctx.env, "UPDATE tiktok_send_slots SET state='reserved',updated=? WHERE id=? AND state='attempted'", now(), slot.id);
      throw error("window_closed", windowReason);
    }
    remoteStarted = true;
  } };
  try {
    const result = await sendTikTokDelivery(guarded, stored as unknown as TikTokDeliveryPayload);
    // Toda tentativa continua contada. Nunca repetir um POST TikTok, nem após 429.
    return result.kind === "retry" ? { kind: "failed" as const, code: result.code } : result;
  } catch (cause) {
    return { kind: remoteStarted ? "unknown" as const : "failed" as const,
      code: cause instanceof ApiError && /^[a-z_]{1,64}$/.test(cause.code) ? cause.code : "provider_unknown" };
  }
}

async function connectionResult(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult> {
  const config = json(ctx.connection.config);
  const linked = await one(ctx.env, `SELECT 1 FROM zernio_channel_accounts a JOIN meta_accounts m ON m.id=a.integration_id AND m.profile_id=a.profile_id
    WHERE a.profile_id=? AND a.connection_id=? AND a.channel='tiktok' AND a.account_id=? AND a.integration_id=? AND a.provider_profile_id=? AND m.provider='zernio'`,
    ctx.profileId, ctx.connection.id, config.account_id ?? "", config.zernio_workspace_id ?? "", config.zernio_profile_id ?? "");
  if (!linked) return { status: "pending", configured: false, code: "channel_import_required" };
  const code = eligibility(ctx.connection.config);
  return { status: code ? "pending" : "active", configured: true, ...(code ? { code } : {}) };
}
async function probeConnection(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult> {
  const local = await connectionResult(ctx);
  if (!local.configured) return local;
  const checked = await probeTikTokAccount(ctx);
  if (!checked.ready) return { status: "pending", configured: true, code: checked.code ?? "channel_not_ready" };
  // Reconectar e conferir o Inbox permite uma nova tentativa, sujeita à mesma
  // quota. O probe não classifica conta por região nem promete elegibilidade.
  await exec(ctx.env, "UPDATE connections SET config=json_remove(config,'$.tiktok_error_code') WHERE id=? AND profile_id=? AND channel='tiktok'",
    ctx.connection.id, ctx.profileId);
  return { status: "active", configured: true, configuration: { tiktok_error_code: null } };
}
export const tiktokConnectionDriver: ChannelConnectionDriver = {
  channel: "tiktok",
  validate(input) {
    const value = record(input), config = record(value.config);
    if (value.kind !== "zernio" || (value.channel !== undefined && value.channel !== "tiktok"))
      throw error("channel_import_required", "Importe a conta do TikTok pela integração Zernio.");
    if (config.c2_enabled !== undefined && typeof config.c2_enabled !== "boolean")
      throw error("invalid_request", "A ativação do TikTok deve ser explícita.");
    // Só ativação é editável. Conta, região e elegibilidade não vêm da tela.
    return { channel: "tiktok", config: { c2_enabled: config.c2_enabled !== false } };
  },
  async configure(ctx) {
    const validated = tiktokConnectionDriver.validate(ctx.input);
    const result = validated.config.c2_enabled !== false && eligibility(ctx.connection.config)
      ? await probeConnection(ctx) : await connectionResult(ctx);
    return { ...result, status: validated.config.c2_enabled === false ? "paused" : result.status,
      configuration: { ...validated.config, ...result.configuration } };
  },
  probe: probeConnection,
  async remove() { return { status: "paused", configured: false }; },
};

export const tiktokExtension: ChannelExtension = {
  key: "tiktok/direct", spec: tiktokSpec, enabled, connectionDriver: tiktokConnectionDriver,
  account: { importable: true, serviceLine: true },
  routes: [{ method: "GET", path: "/connections/:id/setup", authorization: "admin", async handler(ctx) {
    const connection = await one<{ id: string; status: string; config: string }>(ctx.env,
      "SELECT id,status,config FROM connections WHERE id=? AND profile_id=? AND channel='tiktok' AND kind='zernio'", ctx.params.id, ctx.profileId);
    if (!connection) throw new ApiError(404, "not_found", "Conexão não encontrada.");
    // A credencial pertence à integração Zernio, não ao cofre da conexão.
    const configured = !!await one(ctx.env, `SELECT 1 FROM zernio_channel_accounts a JOIN secrets s ON s.id='zernio-account:'||a.integration_id
      WHERE a.connection_id=? AND a.profile_id=? AND a.channel='tiktok'`, connection.id, ctx.profileId);
    const code = eligibility(connection.config);
    return { id: connection.id, channel: "tiktok", status: connection.status, configured,
      credential: configured ? "configurado" : null, ...(code ? { code, reason: blocked(code).reason } : {}),
      conservativeQuota: true, instructions: [quotaReason, "Requisitos da conta e região: a conferir com a conta real na Zernio."] };
  } }],
  ingress: { zernio: { matches: matchesTikTokEvent } }, normalize: normalizeTikTokEvent, prepareInbound, prepareSend, deliver,
  async complete(ctx) {
    if (ctx.resource.kind !== "conversation") return emptyPlan();
    const c = ctx.resource.conversation, profile = ctx.outbox.profile_id, id = ctx.outbox.id;
    const payload = record(record(json(ctx.outbox.payload).c2).delivery), attachment = record(payload.attachment);
    const writes: Statement[] = [];
    if (ctx.result.kind === "sent") {
      const remote = ctx.result.externalId || null;
      if (remote) writes.push([
        `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM tiktok_send_slots
          WHERE connection_id=? AND provider_message_id=? AND (profile_id<>? OR conversation_id<>?)) THEN 1 ELSE 0 END
          ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`, [`tiktok-confirm:${id}`, ctx.connection.id, remote, profile, c.id],
      ]);
      const slot = await one<Slot>(ctx.env, "SELECT * FROM tiktok_send_slots WHERE outbox_id=? AND profile_id=?", id, profile);
      const conflictingId = remote && slot?.provider_message_id && slot.provider_message_id !== remote;
      if (conflictingId) writes.push([
        `INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,provider_message_id,state,counted_at,created,updated)
          VALUES(?,?,?,?,?,'external',?,?,?) ON CONFLICT(connection_id,provider_message_id)
          WHERE provider_message_id IS NOT NULL DO NOTHING`,
        [`tiktok-external:${await sha(JSON.stringify([ctx.connection.id, remote]))}`, profile, ctx.connection.id, c.id, remote, ctx.now, ctx.now, ctx.now],
      ]);
      else writes.push(...confirmSlot(profile, ctx.connection.id, c.id, id, remote, ctx.now));
      // IDs remotos diferentes nunca são deduzidos como a mesma mensagem,
      // mesmo se o fornecedor repetir a dica de idempotência de uma entrega.
      writes.push(...await outboundMessage(profile, c, remote, conflictingId ? null : id, ctx.outbox.actor,
        typeof payload.text === "string" ? payload.text : "", identifier(attachment.mediaId) ? [attachment.mediaId] : [], ctx.now));
    } else {
      // Recusa local libera; tentativa, crash/unknown e reconciliação negativa não liberam.
      writes.push([`UPDATE tiktok_send_slots SET state=CASE
        WHEN state IN ('sent','external') THEN state
        WHEN state IN ('attempted','unknown') OR ?=1 THEN 'unknown' ELSE 'released' END,
        counted_at=CASE WHEN state='reserved' AND ?=1 THEN max(counted_at,?) ELSE counted_at END,updated=?
        WHERE outbox_id=? AND profile_id=?`, [ctx.result.kind === "unknown" ? 1 : 0, ctx.result.kind === "unknown" ? 1 : 0,
          ctx.sidecar.attempted_at ?? ctx.now, ctx.now, id, profile]]);
      if (ctx.result.code === "tiktok_account_ineligible") writes.push([
        "UPDATE connections SET config=json_set(config,'$.tiktok_error_code','tiktok_account_ineligible') WHERE id=? AND profile_id=? AND channel='tiktok'",
        [ctx.connection.id, profile],
      ]);
    }
    return { resource: { kind: "conversation", id: c.id }, conversationId: c.id, statements: writes, wake: false };
  },
  async automationBlock(ctx) {
    // A guarda em memória assegura custo zero quando este canal não é usado.
    if (ctx.connection.channel !== "tiktok") return null;
    const c = conversation(ctx), code = eligibility(ctx.connection.config) ?? windowBlock(c.last_customer, ctx.now);
    if (code) return blocked(code);
    return await usedSlots(ctx, c, ctx.now) >= TIKTOK_MAX_MESSAGES ? blocked("quota_exhausted") : null;
  },
  async view(ctx) {
    if (ctx.connection.channel !== "tiktok") return { capabilities: {}, metadata: {} };
    const c = ctx.resource?.kind === "conversation" ? ctx.resource.conversation : null;
    const remainingMessages = c ? Math.max(0, TIKTOK_MAX_MESSAGES - await usedSlots(ctx, c, ctx.now)) : TIKTOK_MAX_MESSAGES;
    const closesAt = c && Number.isSafeInteger(c.last_customer) && c.last_customer > 0 && c.last_customer <= ctx.now
      ? c.last_customer + TIKTOK_WINDOW_MS : null;
    const state = eligibility(ctx.connection.config) ?? (ctx.connection.status !== "active" || !enabled(ctx.connection) ? "channel_not_ready"
      : c ? windowBlock(c.last_customer, ctx.now) ?? (remainingMessages === 0 ? "quota_exhausted" : "open") : "cannot_initiate");
    return { capabilities: tiktokSpec, metadata: { identityTrust: "channel", remainingMessages, closesAt, state,
      configured: enabled(ctx.connection), accountLabel: ctx.connection.account_label || "TikTok",
      tiktok: { remainingMessages, closesAt, conservativeQuota: true } } };
  },
  async prepareMenu(ctx, input) {
    // line-service já fornece texto numerado; o hook também atende chamada direta.
    const numbered = input.items.map((item, index) => `${index + 1}. ${item.title}`).join("\n");
    const text = numbered && !input.title.includes(numbered) ? `${input.title}\n\n${numbered}` : input.title;
    const profile = await one<{ settings: string }>(ctx.env, "SELECT settings FROM profiles WHERE id=?", ctx.authorization.profileId);
    const actor = ctx.authorization.actor;
    const signer = actor.kind === "user" ? actor.id : actor.bots[0] ? `bot:${actor.bots[0]}` : "system";
    const signed = await signedPayload(ctx.env, json(profile?.settings), { kind: "text", actor: signer }, { text }, "tiktok");
    return prepareSend(ctx, { type: "message.send", text: String(signed.text) });
  },
};
