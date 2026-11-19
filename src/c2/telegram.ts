/** Bot próprio de atendimento. Instalação explícita, sem efeitos ao importar.
 * Formato do plano e limites conservadores: a conferir com a conta real. */
import type { ChannelConnection, ChannelSpec, SocialSendAttachment } from "../channel-contracts";
import type { ChannelConnectionContext, ChannelConnectionDriver, ChannelConnectionResult, ChannelDeliveryContext, ChannelDeliveryPlan, ChannelDeliveryResult, ChannelExtension, ChannelOperationContext, ChannelWritePlan, NormalizedChannelEvent } from "../channel-c2-contracts";
import type { Statement } from "../customer/contracts";
import { prepareChannelInbound } from "../customer/channel-identity";
import { assertVerifiedIngress } from "../channel-extension-kernel";
import { batch, exec, one } from "../db";
import { eventStatement } from "../events";
import { secret, setSecret, sha } from "../security";
import { ApiError, json, type Conversation } from "../types";
import { publicOrigin } from "../web-steps";
import { readTelegramUpdate, telegramCall, telegramDeleteWebhook, telegramDeliveryResult, telegramGetMe, telegramSetWebhook, type TelegramUpdate } from "./telegram-provider";
import { copyTelegramMedia, prepareTelegramUpload, TELEGRAM_MEDIA_POLICY, validateTelegramAttachment } from "./telegram-media";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const data = (value: string | undefined) => object(json(value));
const decimal = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,15}$/.test(value);
const emptyPlan = (): ChannelWritePlan => ({ statements: [], wake: false });
function unavailable(code = "channel_not_ready"): never { throw new ApiError(409, code, "O Telegram não está disponível para esta operação."); }
const blocked = (c: Conversation) => object(data(c.channel_context).telegram).blocked === true;

export { telegramPresentation } from "./telegram-provider";

export const telegramSpec: ChannelSpec = {
  id: "telegram", label: "Telegram", enabled: true, transport: "telegram_bot", serviceLine: true,
  context: "direct", contexts: { direct: { enabled: true, bot: true, publicReply: false } },
  text: { enabled: true, maxChars: 4096 },
  media: TELEGRAM_MEDIA_POLICY,
  menu: { buttons: 8, quickReplies: 0, listItems: 100, fallback: "numbered_text" },
  window: { kind: "none" }, initiation: "customer_first", templates: false, subject: false, replyTo: false, bold: "none",
};

function enabled(connection: ChannelConnection): boolean {
  return connection.kind === "telegram_bot" && connection.channel === "telegram" && data(connection.config).c2_enabled === true;
}
async function assertConnection(ctx: ChannelConnectionContext) {
  if (ctx.connection.profile_id !== ctx.profileId || ctx.connection.kind !== "telegram_bot" || ctx.connection.channel !== "telegram" ||
      !await one(ctx.env, "SELECT 1 FROM connections WHERE id=? AND profile_id=? AND kind='telegram_bot' AND channel='telegram'", ctx.connection.id, ctx.profileId)) unavailable();
}
async function credentials(ctx: Pick<ChannelOperationContext, "env" | "connection">): Promise<{ bot_token?: string; webhook_secret?: string }> {
  const value: unknown = await secret(ctx.env, `connection:${ctx.connection.id}`);
  const row = object(value);
  return { bot_token: typeof row.bot_token === "string" ? row.bot_token : undefined,
    webhook_secret: typeof row.webhook_secret === "string" ? row.webhook_secret : undefined };
}
const validToken = (value: unknown): value is string => typeof value === "string" && /^\d{5,16}:[A-Za-z0-9_-]{16,200}$/.test(value);
function publicConfiguration(config: Record<string, unknown>, id?: string, username?: string) {
  return { c2_enabled: true, ...(id ? { bot_id: id, account_id: id } : {}),
    ...(username ? { username } : {}), webhook_configured: true,
    // Service configuration is owned by the base; no credential or arbitrary input is copied.
    ...(config.service ? { service: config.service } : {}) };
}
async function configure(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult> {
  await assertConnection(ctx);
  const config = data(ctx.connection.config), input = object(ctx.input);
  if (config.remove_pending) unavailable("connection_removing");
  const previous = await credentials(ctx);
  const token = input.bot_token === undefined ? previous.bot_token : input.bot_token;
  if (!validToken(token)) return { status: "paused", configured: !!previous.bot_token, code: "credential_required" };
  // A troca pausa o transporte antes da primeira chamada; falha nunca o reativa.
  await exec(ctx.env, "UPDATE connections SET status='paused' WHERE id=? AND profile_id=?", ctx.connection.id, ctx.profileId);
  const options = { now: ctx.now, beforeFetch: () => assertConnection(ctx) };
  const me = await telegramGetMe(token, options);
  if (me.kind !== "ok") return { status: "paused", configured: !!previous.bot_token, code: me.code };
  const bot = object(me.result), id = String(bot.id ?? ""), username = typeof bot.username === "string" && /^[A-Za-z0-9_]{5,64}$/.test(bot.username) ? bot.username : "";
  if (!decimal(id) || bot.is_bot !== true || !username) return { status: "paused", configured: !!previous.bot_token, code: "provider_contract_unverified" };
  if (config.bot_id && String(config.bot_id) !== id)
    return { status: "paused", configured: !!previous.bot_token, code: "bot_identity_changed" };
  const origin = await publicOrigin(ctx.env);
  let url: URL;
  try { url = new URL(origin ?? ""); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
  catch { return { status: "pending", configured: !!previous.bot_token, code: "public_origin_required" }; }
  const webhookSecret = previous.webhook_secret || crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await setSecret(ctx.env, `connection:${ctx.connection.id}`, { bot_token: token, webhook_secret: webhookSecret });
  const publicConfig = publicConfiguration(config, id, username);
  // Identidade reconfirmada fica durável mesmo se setWebhook for indeterminado.
  await exec(ctx.env, "UPDATE connections SET config=?,status='paused' WHERE id=? AND profile_id=?",
    JSON.stringify({ ...config, ...publicConfig, webhook_configured: false }), ctx.connection.id, ctx.profileId);
  const result = await telegramSetWebhook(token, `${url.origin}/webhooks/telegram-bot/${encodeURIComponent(ctx.connection.id)}`, webhookSecret, options);
  return result.kind === "ok"
    ? { status: "active", configured: true, configuration: publicConfig }
    : { status: "pending", configured: true, code: result.code, configuration: { ...publicConfig, webhook_configured: false } };
}

export const telegramConnectionDriver: ChannelConnectionDriver = {
  channel: "telegram",
  validate(input) {
    const row = object(input);
    if (row.bot_token !== undefined && !validToken(row.bot_token))
      throw new ApiError(400, "invalid_request", "Informe um token válido do BotFather.");
    return { channel: "telegram", config: { c2_enabled: true } };
  },
  configure,
  async probe(ctx) {
    await assertConnection(ctx);
    const stored = await credentials(ctx), config = data(ctx.connection.config);
    if (!stored.bot_token) return { status: "paused", configured: false, code: "credential_required" };
    const me = await telegramGetMe(stored.bot_token, { now: ctx.now, beforeFetch: () => assertConnection(ctx) });
    if (me.kind !== "ok") return { status: "paused", configured: true, code: me.code };
    if (String(object(me.result).id ?? "") !== String(config.bot_id ?? ""))
      return { status: "paused", configured: true, code: "bot_identity_changed" };
    return { status: config.webhook_configured === true && !config.remove_pending ? "active" : "paused", configured: true };
  },
  async remove(ctx) {
    await assertConnection(ctx);
    await exec(ctx.env, "UPDATE connections SET status='paused',config=json_set(config,'$.remove_pending',1,'$.webhook_configured',json('false')) WHERE id=? AND profile_id=?", ctx.connection.id, ctx.profileId);
    const stored = await credentials(ctx);
    if (stored.bot_token) {
      const result = await telegramDeleteWebhook(stored.bot_token, { now: ctx.now, beforeFetch: () => assertConnection(ctx) });
      if (result.kind !== "ok") return { status: "removal_pending", configured: true, code: result.code };
    }
    await batch(ctx.env, [
      ["DELETE FROM telegram_callbacks WHERE connection_id=? AND profile_id=?", [ctx.connection.id, ctx.profileId]],
      ["DELETE FROM secrets WHERE id=?", [`connection:${ctx.connection.id}`]],
    ]);
    return { status: "paused", configured: false };
  },
};

function assertIngress(ctx: ChannelOperationContext) {
  if (!ctx.ingress) unavailable("invalid_channel_evidence");
  assertVerifiedIngress(ctx.ingress);
  if (ctx.authorization.origin !== "ingress" || ctx.ingress.profileId !== ctx.authorization.profileId ||
      ctx.connection.profile_id !== ctx.authorization.profileId || ctx.ingress.connectionId !== ctx.connection.id ||
      ctx.ingress.channel !== "telegram" || ctx.ingress.context !== "direct" || ctx.ingress.source !== "telegram_secret" ||
      String(data(ctx.connection.config).bot_id ?? data(ctx.connection.config).account_id ?? "") !== ctx.ingress.accountId) unavailable("invalid_channel_evidence");
}
async function inboundConnection(ctx: ChannelOperationContext) {
  assertIngress(ctx);
  if (!await one(ctx.env, "SELECT 1 FROM connections WHERE id=? AND profile_id=? AND status='active' AND config=?", ctx.connection.id, ctx.authorization.profileId, ctx.connection.config)) unavailable();
}
async function conversationFor(ctx: ChannelOperationContext, subjectId: string) {
  return one<Conversation>(ctx.env, `SELECT * FROM conversations WHERE profile_id=? AND connection_id=?
    AND external_namespace=? AND external_id=? AND channel='telegram' AND channel_account_id=? AND channel_subject_id=?`,
  ctx.authorization.profileId, ctx.connection.id, `channel:${ctx.connection.id}`, `telegram:${subjectId}`, ctx.ingress!.accountId, subjectId);
}
const resourcePlan = (c: Conversation, statements: Statement[], wake = false): ChannelWritePlan => ({
  conversationId: c.id, resource: { kind: "conversation", id: c.id }, statements, wake,
});

async function prepareInbound(ctx: ChannelOperationContext, event: NormalizedChannelEvent): Promise<ChannelWritePlan> {
  assertIngress(ctx);
  const update = event.content as unknown as TelegramUpdate;
  const profile = ctx.authorization.profileId;
  if (event.kind === "group.ignored") {
    // Um aviso por conexão, sem nome, ID do grupo ou conteúdo de terceiros.
    return { statements: [eventStatement(profile, "connection.warning", ctx.connection.id,
      { code: "telegram_groups_unsupported", message: "Remova o bot dos grupos; este canal atende somente conversas privadas." }, `telegram-group:${ctx.connection.id}`)], wake: false };
  }
  if (!event.subjectId || !decimal(event.subjectId) || update.chatId !== event.subjectId) return emptyPlan();
  let c = await conversationFor(ctx, event.subjectId);
  if (event.kind === "membership") {
    if (!c || update.botId !== ctx.ingress!.accountId || !event.occurredAt) return emptyPlan();
    return resourcePlan(c, [[`UPDATE conversations SET epoch=epoch+1,channel_context=json_set(channel_context,'$.telegram.blocked',json(?),
      '$.telegram.blockedAt',?),updated=? WHERE id=? AND profile_id=? AND coalesce(json_extract(channel_context,'$.telegram.blockedAt'),0)<?`,
    [update.blocked === true ? "true" : "false", event.occurredAt, ctx.now, c.id, profile, event.occurredAt]]]);
  }
  if (event.kind === "callback") return c ? callbackInbound(ctx, c, event, update) : emptyPlan();
  if (!["message.received", "message.edited"].includes(event.kind)) return emptyPlan();
  const messageId = `telegram-message:${await sha(JSON.stringify([profile, ctx.connection.id, event.remoteId]))}`;
  const previous = await one<{ content: string; conversation_id: string }>(ctx.env, "SELECT content,conversation_id FROM messages WHERE id=? AND profile_id=?", messageId, profile);
  if (previous && (event.kind !== "message.edited" || !c || previous.conversation_id !== c.id)) return emptyPlan();
  if (event.kind === "message.edited" && (!previous || !c || !event.occurredAt || Number(object(data(previous.content).telegram).updatedAt ?? 0) >= event.occurredAt)) return emptyPlan();
  if (c && blocked(c) && event.kind !== "message.edited") return emptyPlan();
  const created = !c;
  if (!c) {
    if (event.kind !== "message.received") return emptyPlan();
    c = { id: `telegram:${await sha(JSON.stringify([profile, ctx.connection.id, event.subjectId]))}`, profile_id: profile,
      connection_id: ctx.connection.id, external_namespace: `channel:${ctx.connection.id}`, external_id: `telegram:${event.subjectId}`,
      channel: "telegram", channel_account_id: ctx.ingress!.accountId, channel_subject_id: event.subjectId,
      channel_context: JSON.stringify({ version: 1, context: "direct", telegram: { blocked: false }, multichannel: object(data(ctx.connection.config)._channel_summary).multichannel === true }),
      account_label: ctx.connection.account_label || "", title: update.displayName || "Contato do Telegram", phone: null, verified_phone: null,
      customer_link_state: "pending", chat_type: "direct", bot_policy: "mentions", state: "ai", owner: null,
      epoch: 1, session: `telegram-session:${await sha(messageId)}`, topic: null, tags: "[]", last_customer: 0, created: ctx.now, updated: ctx.now };
  }
  const media = update.media.length ? await copyTelegramMedia(ctx.env, { profileId: profile, connectionId: ctx.connection.id }, event.remoteId,
    update.media, (await credentials(ctx)).bot_token ?? "", { now: ctx.now, beforeFetch: () => inboundConnection(ctx) })
    : { attachments: [], warnings: [], statements: [] };
  const content: Record<string, unknown> = { version: 1, customerSession: c.session,
    telegram: { updatedAt: event.occurredAt ?? 0 }, ...(media.warnings.length ? { attachmentWarnings: media.warnings } : {}) };
  let text = update.text;
  if (update.location) { content.type = "location"; content.location = update.location; text ||= "Localização compartilhada."; }
  const writes: Statement[] = [...media.statements];
  if (update.contact) {
    const request = object(object(data(c.channel_context).telegram).contactRequest);
    const inboundMessage = event.remoteId.split(":").at(-1), requestedMessage = request.providerMessageId;
    const followsRequest = decimal(inboundMessage) && decimal(requestedMessage) && BigInt(inboundMessage) > BigInt(requestedMessage);
    const eligible = event.kind === "message.received" && followsRequest && request.state === "sent" && request.subjectId === event.subjectId &&
      request.epoch === c.epoch && Number(request.expiresAt) > ctx.now && event.occurredAt !== null &&
      event.occurredAt >= Math.floor(Number(request.sentAt) / 1000) * 1000 && update.contact.userId === event.subjectId;
    const phone = update.contact.phone;
    const suggestion = eligible && /^\+?\d{7,15}$/.test(phone);
    // O mascarador estrutural existente reconhece subject_id, inclusive para
    // telefone internacional que não combina com a heurística brasileira.
    content.telegram = { ...object(content.telegram), contact: { subject_id: phone, own: update.contact.userId === event.subjectId,
      eligible: suggestion, confirmedByHuman: false, ...(suggestion ? { requestId: request.id } : {}) } };
    text ||= suggestion ? "Telefone compartilhado para revisão humana." : "Contato compartilhado sem confirmação de identidade.";
    if (suggestion) writes.push([`UPDATE conversations SET channel_context=json_set(channel_context,
      '$.telegram.contactRequest.state','consumed','$.telegram.phoneSuggestion',json(?)) WHERE id=? AND profile_id=?`,
    [JSON.stringify({ masked: `•••• ${phone.slice(-4)}`, requestId: request.id, messageId, confirmedByHuman: false }), c.id, profile]]);
  }
  if (!text && !media.attachments.length) text = media.warnings.length ? "Mídia indisponível." : "Mensagem não suportada.";
  if (event.kind === "message.edited") {
    if (object(object(data(c.channel_context).telegram).phoneSuggestion).messageId === messageId)
      writes.push(["UPDATE conversations SET channel_context=json_remove(channel_context,'$.telegram.phoneSuggestion') WHERE id=? AND profile_id=?", [c.id, profile]]);
    writes.push(["UPDATE messages SET text=?,attachments=?,content=? WHERE id=? AND profile_id=? AND conversation_id=?",
      [text, JSON.stringify(media.attachments), JSON.stringify({ ...content, edited: true }), messageId, profile, c.id]],
    eventStatement(profile, "message.edited", messageId, { conversation_id: c.id, message_id: messageId }, `telegram-edit:${ctx.connection.id}:${event.key}`));
    return resourcePlan(c, writes);
  }
  const initial = c;
  if (c.state === "closed") c = { ...c, state: "ai", owner: null, epoch: c.epoch + 1, session: `telegram-session:${await sha(messageId)}` };
  const queued = object(data(ctx.connection.config).service).mode === "human" && c.state === "ai" && !c.assigned_bot_id;
  if (queued) c = { ...c, state: "waiting", owner: null, epoch: c.epoch + 1 };
  else if (c.state === "ai") c = { ...c, epoch: c.epoch + 1 };
  content.customerSession = c.session;
  if (created) writes.unshift([`INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,
    epoch,session,last_customer,created,updated,channel,account_label,channel_account_id,channel_subject_id,channel_context,title)
    VALUES(?,?,?,?,?,NULL,?,?,?,?,?,'telegram',?,?,?,?,?)`,
  [initial.id, profile, ctx.connection.id, initial.external_namespace, initial.external_id, initial.epoch, initial.session, 0, ctx.now, ctx.now,
    initial.account_label, initial.channel_account_id, initial.channel_subject_id, initial.channel_context, initial.title]]);
  const identity = await prepareChannelInbound(ctx.env, c, { provider: "telegram_bot", channel: "telegram", accountId: ctx.ingress!.accountId,
    subjectId: event.subjectId, subjectNamespace: "telegram-user", displayName: update.displayName, username: update.username, ingress: ctx.ingress });
  writes.push(["UPDATE conversations SET state=?,owner=?,epoch=?,session=?,last_customer=max(last_customer,?),updated=? WHERE id=? AND profile_id=?",
    [c.state, c.owner, c.epoch, c.session, event.occurredAt ?? 0, ctx.now, c.id, profile]], ...identity.statements,
  ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content) VALUES(?,?,?,'customer',?,?,?,?,?,?)",
    [messageId, profile, c.id, `customer:telegram:${event.subjectId}`, text, JSON.stringify(media.attachments), event.remoteId, ctx.now, JSON.stringify(content)]],
  ["INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
    [messageId, profile, messageId, c.id, JSON.stringify({ text, content, attachments: media.attachments, message_record_id: messageId,
      message_id: event.remoteId, epoch: c.epoch, session: c.session, ...(queued ? { queued_by_line: true } : {}) }), ctx.now]]);
  return resourcePlan(c, writes, true);
}

async function callbackInbound(ctx: ChannelOperationContext, c: Conversation, event: NormalizedChannelEvent, update: TelegramUpdate): Promise<ChannelWritePlan> {
  if (!update.callback || blocked(c)) return emptyPlan();
  const hash = await sha(update.callback.data);
  const row = await one<{ token_hash: string; menu_token: string; option_id: string; epoch: number; expires: number; used_query_id: string | null }>(ctx.env,
    `SELECT * FROM telegram_callbacks WHERE token_hash=? AND profile_id=? AND connection_id=? AND conversation_id=? AND subject_id=?`,
    hash, ctx.authorization.profileId, ctx.connection.id, c.id, event.subjectId);
  if (!row || row.used_query_id || row.expires <= ctx.now || row.epoch !== c.epoch || !c.menu_active || row.menu_token !== c.menu_token) return emptyPlan();
  const messageId = `telegram-callback:${hash}`, content = { interactive_reply_id: `wmenu:${row.menu_token}:${row.option_id}`, customerSession: c.session };
  const statements: Statement[] = [
    [`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM telegram_callbacks t
      JOIN conversations c ON c.id=t.conversation_id AND c.profile_id=t.profile_id
      WHERE t.token_hash=? AND t.used_query_id IS NULL AND t.expires>? AND t.epoch=?
        AND c.epoch=t.epoch AND c.menu_token=t.menu_token AND c.menu_active=1)
      THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`, [messageId, hash, ctx.now, c.epoch]],
    ["UPDATE telegram_callbacks SET used_query_id=?,used_at=? WHERE conversation_id=? AND profile_id=? AND menu_token=? AND used_query_id IS NULL",
      [update.callback.id, ctx.now, c.id, ctx.authorization.profileId, row.menu_token]],
    ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,created,content) VALUES(?,?,?,'customer',?,?,?,?,?)",
      [messageId, ctx.authorization.profileId, c.id, `customer:telegram:${event.subjectId}`, "Opção selecionada no menu.", `callback:${update.callback.id}`, ctx.now, JSON.stringify(content)]],
    ["INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
      [messageId, ctx.authorization.profileId, messageId, c.id, JSON.stringify({ text: "", content, message_record_id: messageId,
        message_id: `callback:${update.callback.id}`, attachments: [], epoch: c.epoch, session: c.session }), ctx.now]],
  ];
  return resourcePlan(c, statements, true);
}

function sendConversation(ctx: ChannelOperationContext): Conversation {
  if (!enabled(ctx.connection) || ctx.connection.profile_id !== ctx.authorization.profileId || ctx.connection.status !== "active" || ctx.resource?.kind !== "conversation") unavailable();
  const c = ctx.resource.conversation;
  if (c.connection_id !== ctx.connection.id || c.profile_id !== ctx.authorization.profileId || c.channel !== "telegram" || c.chat_type !== "direct" ||
      c.external_namespace !== `channel:${ctx.connection.id}` || !decimal(c.channel_subject_id) ||
      c.external_id !== `telegram:${c.channel_subject_id}` || c.channel_account_id !== String(data(ctx.connection.config).bot_id ?? "")) unavailable("cannot_initiate");
  if (blocked(c)) unavailable("bot_blocked");
  return c;
}
const planFor = (c: Conversation, operation: string): ChannelDeliveryPlan => ({ resource: { kind: "conversation", id: c.id }, operation, orderKey: `conversation:${c.id}`, deliveries: [] });
export function splitTelegramText(text: string): string[] {
  // UTF-16 bound is conservative and avoids splitting a surrogate pair.
  const result: string[] = []; let part = "";
  for (const point of text) { if (part.length + point.length > 4096) { result.push(part); part = ""; } part += point; }
  if (part) result.push(part);
  return result;
}

/** Persistido no D1: o limite continua válido entre isolates e após reinício.
 * Espaçamento de 34 ms é conservador: no máximo 30 mensagens/s por bot. */
async function reserveRate(ctx: ChannelDeliveryContext, c: Conversation): Promise<number | null> {
  const at = Math.max(ctx.now, Date.now());
  for (const key of [`telegram:conversation:${c.id}`, `telegram:bot:${c.channel_account_id}`]) {
    const claimed = await one<{ expires: number }>(ctx.env, `INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=1,expires=excluded.expires WHERE rate_limits.expires<=? RETURNING expires`, key, at + 60_000, at);
    if (!claimed) {
      if (key.startsWith("telegram:bot:")) await exec(ctx.env, "UPDATE rate_limits SET expires=? WHERE key=?", at + 1000, `telegram:conversation:${c.id}`);
      return (await one<{ expires: number }>(ctx.env, "SELECT expires FROM rate_limits WHERE key=?", key))?.expires ?? at + 1000;
    }
  }
  return null;
}

export const telegramExtension: ChannelExtension = {
  key: "telegram/direct", spec: telegramSpec, enabled, connectionDriver: telegramConnectionDriver,
  account: { importable: false, serviceLine: true }, routes: [],
  async normalize(input, scope) {
    assertVerifiedIngress(scope);
    if (scope.channel !== "telegram" || scope.context !== "direct" || scope.source !== "telegram_secret") return null;
    const update = readTelegramUpdate(input);
    if (!update) return null;
    return { key: update.key, kind: update.kind, occurredAt: update.occurredAt, remoteId: update.remoteId,
      subjectId: update.subjectId, subjectNamespace: "telegram-user", context: { version: 1, context: "direct" },
      content: { ...update } };
  },
  async acknowledge(ctx, event) {
    assertIngress(ctx);
    const update = event.content as unknown as TelegramUpdate;
    if (!update.callback?.id) return;
    const token = (await credentials(ctx)).bot_token;
    if (!token) unavailable("credential_required");
    const result = await telegramCall(token, "answerCallbackQuery", { callback_query_id: update.callback.id }, { now: ctx.now, beforeFetch: () => inboundConnection(ctx) });
    // Não confirmar o webhook quando o ack falhou: a repetição tenta o ack,
    // enquanto a deduplicação impede executar novamente a opção.
    if (result.kind !== "ok" && !(result.kind === "failed" && result.code === "provider_rejected"))
      throw new ApiError(503, "telegram_ack_pending", "Não foi possível confirmar o botão agora.");
  },
  prepareInbound,
  async prepareSend(ctx, action) {
    const c = sendConversation(ctx), plan = planFor(c, action.type);
    if (action.type === "telegram.request-contact") {
      if (ctx.authorization.origin !== "human" || ctx.authorization.actor.kind !== "user" || ctx.authorization.actor.via) unavailable("human_only");
      const request = { id: ctx.commandId, subjectId: c.channel_subject_id, epoch: c.epoch, expiresAt: ctx.now + 600_000, state: "pending" };
      return { ...plan, deliveries: [{ key: ctx.commandId, payload: { method: "sendMessage", request,
        body: { text: "Se desejar, compartilhe seu telefone para revisão pela equipe.", reply_markup: { keyboard: [[{ text: "Compartilhar meu telefone", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } } } }],
      statements: [["UPDATE conversations SET channel_context=json_set(channel_context,'$.telegram.contactRequest',json(?)) WHERE id=? AND profile_id=?", [JSON.stringify(request), c.id, ctx.authorization.profileId]]] };
    }
    if (action.type !== "message.send") unavailable("unsupported_content");
    const deliveries: { key: string; payload: Record<string, unknown> }[] = splitTelegramText(action.text).map((text, index) => ({ key: `${ctx.commandId}:text:${index}`, payload: { method: "sendMessage", body: { text } } }));
    for (const attachment of action.attachments ?? []) { validateTelegramAttachment(attachment); deliveries.push({ key: `${ctx.commandId}:media:${deliveries.length}`, payload: { attachment } }); }
    if (!deliveries.length || deliveries.length > 100) unavailable("unsupported_content");
    return { ...plan, deliveries };
  },
  async prepareMenu(ctx, input) {
    const c = sendConversation(ctx);
    if (!input.token || input.token.length > 300 || input.items.length < 1 || input.items.length > 100 || input.expiresAt <= ctx.now ||
        new Set(input.items.map(item => item.id)).size !== input.items.length || input.items.some(item => !item.id || item.id.length > 200 || !item.title.trim())) unavailable("unsupported_content");
    const expires = Math.min(input.expiresAt, ctx.now + 900_000), statements: Statement[] = [];
    const buttons = [];
    for (const item of input.items) {
      const token = crypto.randomUUID().replaceAll("-", ""), hash = await sha(token);
      statements.push([`INSERT INTO telegram_callbacks(token_hash,profile_id,connection_id,conversation_id,subject_id,menu_token,option_id,epoch,expires,created)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [hash, ctx.authorization.profileId, ctx.connection.id, c.id, c.channel_subject_id, input.token, item.id, c.epoch, expires, ctx.now]]);
      buttons.push({ text: Array.from(item.title).slice(0, 64).join(""), callback_data: token });
    }
    const pages = Math.ceil(buttons.length / 8), deliveries = [];
    for (let page = 0; page < pages; page++) deliveries.push({ key: `${ctx.commandId}:page:${page}`, payload: { method: "sendMessage", menuToken: input.token, expiresAt: expires,
      body: { text: `${input.title.slice(0, 4000)}${pages > 1 ? `\n\nPágina ${page + 1} de ${pages}` : ""}`,
        reply_markup: { inline_keyboard: buttons.slice(page * 8, (page + 1) * 8).map(button => [button]) } } } });
    statements.push(["UPDATE conversations SET menu_active=1,menu_token=?,menu_expires_at=?,menu_items=? WHERE id=? AND profile_id=?",
      [input.token, expires, JSON.stringify(input.items.map(item => item.id)), c.id, ctx.authorization.profileId]]);
    return { ...planFor(c, "telegram.menu"), deliveries, statements };
  },
  async deliver(ctx): Promise<ChannelDeliveryResult> {
    if (ctx.resource.kind !== "conversation") return { kind: "failed", code: "cannot_initiate" };
    const c = ctx.resource.conversation;
    if (!enabled(ctx.connection) || ctx.connection.status !== "active" || c.channel !== "telegram" || c.chat_type !== "direct" ||
        c.connection_id !== ctx.connection.id || c.profile_id !== ctx.connection.profile_id || !decimal(c.channel_subject_id)) return { kind: "failed", code: "channel_not_ready" };
    if (blocked(c)) return { kind: "failed", code: "bot_blocked" };
    const payload = object(object(data(ctx.outbox.payload).c2).delivery), body = object(payload.body);
    if (payload.menuToken && (payload.menuToken !== c.menu_token || !c.menu_active || Number(payload.expiresAt) <= ctx.now || (c.menu_expires_at ?? 0) <= ctx.now)) return { kind: "failed", code: "message_expired" };
    if (payload.request && Number(object(payload.request).expiresAt) <= ctx.now) return { kind: "failed", code: "message_expired" };
    const token = (await credentials(ctx)).bot_token;
    if (!token) return { kind: "failed", code: "credential_required" };
    const attachment = payload.attachment as SocialSendAttachment | undefined;
    let upload: Awaited<ReturnType<typeof prepareTelegramUpload>> | undefined;
    if (attachment) { validateTelegramAttachment(attachment); upload = await prepareTelegramUpload(ctx.env, c.profile_id, attachment); upload.formData.set("chat_id", c.channel_subject_id); }
    const next = await reserveRate(ctx, c);
    if (next !== null) return { kind: "retry", notBefore: Math.max(ctx.now + 1, next), code: "rate_limited" };
    // Falha da reautorização conserva o lease curto; não abre corrida entre isolates.
    const result = telegramDeliveryResult(await telegramCall(token, upload?.method ?? "sendMessage", upload?.formData ?? { ...body, chat_id: c.channel_subject_id }, { now: ctx.now, beforeFetch: ctx.beforeFetch }));
    const finished = Math.max(ctx.now, Date.now());
    await batch(ctx.env, [
      ["UPDATE rate_limits SET expires=? WHERE key=?", [finished + 1000, `telegram:conversation:${c.id}`]],
      ["UPDATE rate_limits SET expires=? WHERE key=?", [result.kind === "retry" ? Math.max(finished + 34, result.notBefore) : finished + 34, `telegram:bot:${c.channel_account_id}`]],
    ]);
    return result;
  },
  async complete(ctx) {
    if (ctx.resource.kind !== "conversation") return emptyPlan();
    const c = ctx.resource.conversation, payload = object(object(data(ctx.outbox.payload).c2).delivery);
    const statements: Statement[] = [];
    if (ctx.result.kind === "failed" && ctx.result.code === "bot_blocked") statements.push(["UPDATE conversations SET epoch=epoch+1,channel_context=json_set(channel_context,'$.telegram.blocked',json('true'),'$.telegram.blockedAt',?) WHERE id=? AND profile_id=?", [ctx.now, c.id, c.profile_id]]);
    if (ctx.result.kind !== "sent") return resourcePlan(c, statements);
    const request = object(payload.request), body = object(payload.body), attachment = object(payload.attachment);
    if (request.id) statements.push([`UPDATE conversations SET channel_context=json_set(channel_context,
      '$.telegram.contactRequest.state','sent','$.telegram.contactRequest.sentAt',?,'$.telegram.contactRequest.providerMessageId',?) WHERE id=? AND profile_id=?
      AND json_extract(channel_context,'$.telegram.contactRequest.id')=? AND epoch=?`, [ctx.now, ctx.result.externalId ?? null, c.id, c.profile_id, request.id, ctx.outbox.epoch]]);
    const messageId = `delivery:${ctx.outbox.id}`, attachments = attachment.mediaId ? [attachment.mediaId] : [];
    statements.push([`INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status)
      VALUES(?,?,?,'outbound',?,?,?,?,?,?,?,'sent')`, [messageId, c.profile_id, c.id, ctx.outbox.actor,
      typeof body.text === "string" ? body.text : "", JSON.stringify(attachments), ctx.result.externalId ?? null, ctx.now, messageId,
      JSON.stringify({ version: 1, telegram: { ...(request.id ? { contactRequested: true } : {}), ...(payload.menuToken ? { menu: true } : {}) } })]],
    eventStatement(c.profile_id, "message.sent", messageId, { conversation_id: c.id, message_id: messageId, text: typeof body.text === "string" ? body.text : "", attachments }));
    return resourcePlan(c, statements);
  },
  async view(ctx) {
    const config = data(ctx.connection.config), c = ctx.resource?.kind === "conversation" ? ctx.resource.conversation : null;
    const telegram = c ? object(data(c.channel_context).telegram) : {}, suggestion = object(telegram.phoneSuggestion);
    const username = typeof config.username === "string" && /^[A-Za-z0-9_]{5,64}$/.test(config.username) ? config.username : undefined;
    return { capabilities: telegramSpec, metadata: { identityTrust: "channel", configured: !!config.bot_id,
      state: telegram.blocked === true ? "blocked" : ctx.connection.status,
      telegram: { ...(username ? { username, botUrl: `https://t.me/${username}` } : {}), blocked: telegram.blocked === true,
        webhookConfigured: config.webhook_configured === true,
        ...(typeof suggestion.masked === "string" ? { phoneSuggestion: { masked: suggestion.masked, confirmedByHuman: false as const } } : {}) } } };
  },
  async automationBlock(ctx) {
    if (ctx.resource?.kind === "conversation" && blocked(ctx.resource.conversation)) return { code: "bot_blocked", reason: "O cliente bloqueou o bot no Telegram." };
    return null;
  },
};
