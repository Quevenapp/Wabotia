import { batch, one } from "./db";
import { access, admin, equal, hmac, sha } from "./security";
import { requireAccess } from "./access";
import { assertDepartmentAccess } from "./departments";
import { boundAllows, visibleConversation } from "./visibility";
import { currentActor } from "./channel-runtime";
import { ApiError, json, now, requireValue, type Actor, type Conversation, type Env } from "./types";
import type { ChannelAction, ChannelOperationContext, ChannelReview, ChannelRouteContext, ChannelWritePlan, ExtensionConnection, LoadedChannelResource, Resource, ServerChannelAction, VerifiedIngress } from "./channel-c2-contracts";
import { channelConnectionDriver, channelExtension, channelExtensionReady, extensionKey, findChannelRoute } from "./channel-extension-registry";
import { channelNotReady } from "./channel-extension-stubs";
import { refreshChannelSummaryStatements } from "./channel-accounts";
import { signedPayload } from "./signature";

const authenticated = new WeakSet<object>();
const denied = () => new ApiError(403, "invalid_channel_evidence", "A origem do evento não foi confirmada.");
function missing(): never { throw new ApiError(404, "not_found", "Recurso não encontrado nesta área."); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
export function assertVerifiedIngress(scope: VerifiedIngress): void {
  if (!object(scope) || !authenticated.has(scope)) throw denied();
}
function validScope(scope: unknown): scope is VerifiedIngress {
  if (!object(scope) || !identifier(scope.profileId) || !identifier(scope.connectionId) || !identifier(scope.accountId)) return false;
  const key = extensionKey(scope.channel, scope.context as VerifiedIngress["context"]);
  return !!key && (scope.channel === "email" ? scope.source === "worker_email"
    : scope.channel === "telegram" ? scope.source === "telegram_secret" : scope.source === "zernio_hmac");
}
/** Chamado somente após HMAC/segredo/runtime; o ticket vincula também o corpo e expira. */
export async function signVerifiedIngress(env: Env, scope: VerifiedIngress, input: unknown): Promise<string> {
  if (!validScope(scope) || !env.MASTER_KEY || env.MASTER_KEY.length < 32) throw denied();
  const body = JSON.stringify({ version: 1, scope, input, expires: now() + 300_000 });
  if (new TextEncoder().encode(body).byteLength > 1_048_576) throw new ApiError(413, "event_too_large", "Evento grande demais.");
  authenticated.add(scope);
  return JSON.stringify({ body, signature: await hmac(env.MASTER_KEY, `c2-ingress:${body}`) });
}
export async function verifyIngressTicket(env: Env, ticket: unknown): Promise<{ scope: VerifiedIngress; input: unknown }> {
  try {
    if (typeof ticket !== "string" || ticket.length > 2_097_152 || !env.MASTER_KEY || env.MASTER_KEY.length < 32) throw denied();
    const envelope: unknown = JSON.parse(ticket);
    if (!object(envelope) || typeof envelope.body !== "string" || typeof envelope.signature !== "string" ||
        !equal(envelope.signature, await hmac(env.MASTER_KEY, `c2-ingress:${envelope.body}`))) throw denied();
    const payload: unknown = JSON.parse(envelope.body);
    if (!object(payload) || payload.version !== 1 || !validScope(payload.scope) || typeof payload.expires !== "number" ||
        payload.expires <= now() || payload.expires > now() + 300_000) throw denied();
    authenticated.add(payload.scope);
    return { scope: payload.scope, input: payload.input };
  } catch { throw denied(); }
}
export async function ingressOperationContext(env: Env, scope: VerifiedIngress): Promise<ChannelOperationContext> {
  assertVerifiedIngress(scope);
  const connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=? AND channel=? AND status='active'", scope.connectionId, scope.profileId, scope.channel);
  if (!connection) throw denied();
  const config = json(connection.config);
  if (scope.source === "telegram_secret" && (connection.kind !== "telegram_bot" || String(config.bot_id ?? config.account_id ?? "") !== scope.accountId)) throw denied();
  if (scope.source === "worker_email" && (connection.kind !== "email" || String(config.address ?? config.account_id ?? "") !== scope.accountId)) throw denied();
  if (scope.source === "zernio_hmac" && (connection.kind !== "zernio" || !await one(env,
    "SELECT 1 FROM zernio_channel_accounts WHERE connection_id=? AND profile_id=? AND channel=? AND account_id=?", scope.connectionId, scope.profileId, scope.channel, scope.accountId))) throw denied();
  const key = extensionKey(scope.channel, scope.context)!;
  const extension = channelExtension(key);
  if (!channelExtensionReady(key) || !extension.enabled?.(connection)) channelNotReady();
  const actor: Actor = { id: "channel:ingress", kind: "connector", role: "service", name: "Entrada de canal", profiles: [scope.profileId], scopes: [], bots: [], rate: 0, runLimit: 0 };
  return { env, connection, resource: null, authorization: { actor, profileId: scope.profileId, origin: "ingress", permissions: [] }, now: now(), commandId: "", ingress: scope };
}
export async function loadChannelOperationContext(env: Env, original: Actor, profileId: string, resource: Resource, commandId: string,
  origin: "human" | "bot" | "maintenance" = "human"): Promise<ChannelOperationContext> {
  requireValue(identifier(commandId), "Informe a chave idempotente.");
  const actor = origin === "human" ? await currentActor(env, original) : original;
  if (origin === "human" && (actor.kind !== "user" || actor.via)) throw new ApiError(403, "human_only", "Esta ação exige uma pessoa autenticada.");
  if (origin === "human") access(actor, profileId, resource.kind === "review" ? "reports:read" : "conversations:write");
  let loaded: LoadedChannelResource;
  let connectionId: string | null;
  if (resource.kind === "conversation") {
    const conversation = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", resource.id, profileId);
    if (!conversation) missing();
    if (origin === "human") {
      requireAccess(actor, "conversations");
      if (!visibleConversation(actor, conversation) || !await boundAllows(env, actor, conversation)) missing();
      await assertDepartmentAccess(env, actor, conversation);
      requireValue(conversation.owner === actor.id && conversation.state === "human", "Assuma a conversa antes desta ação.");
    } else if (actor.id !== "bot:attendant" || !actor.profiles.includes(profileId) || conversation.chat_type !== "direct") {
      throw new ApiError(403, "human_only", "Este contexto não permite resposta automática.");
    }
    loaded = { ...resource, conversation }; connectionId = conversation.connection_id;
  } else {
    if (origin !== "human") throw new ApiError(403, "human_only", "Publicação exige uma pessoa autenticada.");
    requireAccess(actor, "reports");
    const review = await one<ChannelReview>(env, "SELECT * FROM reviews WHERE id=? AND profile_id=?", resource.id, profileId);
    if (!review) missing();
    if (actor.role !== "admin" && !await one(env, "SELECT 1 FROM channel_public_grants WHERE profile_id=? AND user_id=? AND permission='google.reply'", profileId, actor.id))
      throw new ApiError(403, "forbidden", "Sem permissão para publicar resposta no Google.");
    loaded = { ...resource, review }; connectionId = review.connection_id;
  }
  const connection = connectionId ? await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", connectionId, profileId) : null;
  if (!connection || connection.status !== "active") channelNotReady();
  const context = loaded.kind === "review" ? "review" : loaded.conversation.chat_type === "comment" || json(loaded.conversation.channel_context).context === "comment" ? "comment" : "direct";
  const key = extensionKey(connection.channel, context);
  if (!key || !channelExtensionReady(key) || !channelExtension(key).enabled?.(connection)) channelNotReady();
  return { env, connection, resource: loaded, authorization: { actor, profileId, origin, permissions: resource.kind === "review" ? ["reports:read", "google.reply"] : ["conversations:write"] }, now: now(), commandId };
}
export function parseChannelAction(input: unknown): ChannelAction {
  requireValue(object(input), "Ação de canal inválida.");
  requireValue(!["actor", "origin", "verified", "proof", "authorization", "recipient", "to", "from"].some(key => key in input), "A origem e o destinatário são definidos pelo servidor.");
  const type = input.type;
  const text = () => { requireValue(typeof input.text === "string" && input.text.length <= 50_000, "Texto inválido."); return input.text; };
  const version = () => { requireValue(Number.isSafeInteger(input.version) && Number(input.version) > 0, "Informe a versão do recurso."); return Number(input.version); };
  const attachments = () => {
    if (input.attachments === undefined) return undefined;
    requireValue(Array.isArray(input.attachments) && input.attachments.length <= 32, "Anexos inválidos.");
    return input.attachments.map((item: unknown) => {
      requireValue(object(item) && identifier(item.mediaId) && ["image", "video", "audio", "document", "sticker"].includes(String(item.kind)) &&
        typeof item.mimeType === "string" && Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0, "Anexo inválido.");
      return { mediaId: item.mediaId as string, kind: item.kind as "image" | "video" | "audio" | "document" | "sticker", mimeType: item.mimeType as string, bytes: Number(item.bytes), ...(typeof item.name === "string" ? { name: item.name.slice(0, 200) } : {}) };
    });
  };
  if (type === "comment.reply" || type === "comment.private" || type === "comment.suggest") {
    requireValue(identifier(input.commentId), "Selecione o comentário."); return { type, commentId: input.commentId, text: text() };
  }
  if (type === "comment.visibility") { requireValue(identifier(input.commentId) && typeof input.hidden === "boolean", "Selecione o comentário e a visibilidade."); return { type, commentId: input.commentId as string, hidden: input.hidden as boolean }; }
  if (type === "telegram.request-contact") return { type };
  if (type === "message.send") return { type, text: text(), attachments: attachments() };
  if (type === "email.send") { requireValue(typeof input.subject === "string" && input.subject.length <= 200 && !/[\r\n\u0000]/.test(input.subject), "Assunto inválido."); return { type, subject: input.subject, text: text(), attachments: attachments() }; }
  if (type === "google.reply") return { type, version: version(), text: text() };
  if (type === "google.reply.delete" || type === "google.suggest") return { type, version: version() };
  throw new ApiError(400, "invalid_channel_action", "Ação de canal inválida.");
}
export function parseServerChannelAction(ctx: ChannelOperationContext, input: unknown): ServerChannelAction {
  if (!object(input) || !["email.auto-reply", "email.acknowledgement"].includes(String(input.type))) return parseChannelAction(input);
  const ack = input.type === "email.acknowledgement";
  if (ctx.authorization.origin !== "bot" || ctx.connection.channel !== "email" ||
      json(ctx.connection.config)[ack ? "auto_ack_enabled" : "bot_enabled"] !== true ||
      !(ack ? channelExtension("email/direct").prepareAcknowledgement : channelExtension("email/direct").prepareBotReply))
    throw new ApiError(403, "human_only", "Esta operação é interna ao canal.");
  const checked = parseChannelAction({ ...input, type: "email.send" });
  if (checked.type !== "email.send") throw new ApiError(400, "invalid_channel_action", "Ação inválida.");
  return { type: ack ? "email.acknowledgement" : "email.auto-reply", subject: checked.subject, text: checked.text };
}
export async function authorizeChannelAction(ctx: ChannelOperationContext, input: unknown): Promise<void> {
  const action = parseServerChannelAction(ctx, input);
  const context = ctx.resource?.kind === "review" ? "review" : ctx.resource?.kind === "conversation" && (ctx.resource.conversation.chat_type === "comment" || json(ctx.resource.conversation.channel_context).context === "comment") ? "comment" : "direct";
  const key = extensionKey(ctx.connection.channel, context);
  if (!key) channelNotReady();
  const publicAction = action.type.startsWith("comment.") || action.type.startsWith("google.");
  if (publicAction && (ctx.authorization.origin !== "human" || ctx.authorization.actor.kind !== "user" || ctx.authorization.actor.via))
    throw new ApiError(403, "human_only", "Publicação exige uma pessoa autenticada.");
  const compatible = key.endsWith("/comment") ? action.type.startsWith("comment.")
    : key === "googlebusiness/review" ? action.type.startsWith("google.")
    : key === "email/direct" ? action.type === "email.send" || action.type === "email.auto-reply" || action.type === "email.acknowledgement"
    : action.type === "message.send" || (key === "telegram/direct" && action.type === "telegram.request-contact");
  requireValue(compatible, "Esta ação não pertence ao contexto do canal.");
  if (action.type.startsWith("google.") && "version" in action &&
      (ctx.resource?.kind !== "review" || ctx.resource.review.version !== action.version))
    throw new ApiError(409, "resource_changed", "A avaliação mudou. Atualize antes de publicar.");
  if (ctx.authorization.origin !== "human" && !["email.auto-reply", "email.acknowledgement"].includes(action.type) && (action.type !== "message.send" || !channelExtension(key).spec.contexts.direct?.bot))
    throw new ApiError(403, "human_only", "Esta ação não permite resposta automática.");
  if ("attachments" in action) for (const attachment of action.attachments ?? []) {
    const media = await one<{ size: number; type: string }>(ctx.env, "SELECT size,type FROM media WHERE id=? AND profile_id=?", attachment.mediaId, ctx.authorization.profileId);
    requireValue(media && media.size === attachment.bytes && media.type === attachment.mimeType, "Anexo não pertence à área ou foi alterado.");
  }
}
export async function prepareChannelAction(ctx: ChannelOperationContext, input: unknown) {
  await authorizeChannelAction(ctx, input);
  const action = parseServerChannelAction(ctx, input);
  const context = ctx.resource?.kind === "review" ? "review" : ctx.resource?.kind === "conversation" && (ctx.resource.conversation.chat_type === "comment" || json(ctx.resource.conversation.channel_context).context === "comment") ? "comment" : "direct";
  const key = extensionKey(ctx.connection.channel, context)!;
  let prepared = action;
  if ((action.type === "message.send" || action.type === "email.send" || action.type === "comment.reply" || action.type === "comment.private") && action.text) {
    const profile = await one<{ settings: string }>(ctx.env, "SELECT settings FROM profiles WHERE id=?", ctx.authorization.profileId);
    const actor = ctx.authorization.actor;
    const signer = actor.kind === "user" ? actor.id : actor.bots[0] ? `bot:${actor.bots[0]}` : "system";
    const signed = await signedPayload(ctx.env, json(profile?.settings), { kind: "text", actor: signer }, { text: action.text }, ctx.connection.channel ?? null);
    prepared = { ...action, text: String(signed.text) };
  }
  // Assinatura precede divisão, validação de comprimento e reserva de quota.
  const plan = await channelExtension(key).prepareSend(ctx, prepared);
  requireValue(ctx.resource && plan.resource.kind === ctx.resource.kind && plan.resource.id === ctx.resource.id && plan.deliveries.length <= 100, "Recurso de entrega inválido.");
  requireValue(!action.type.endsWith("suggest") || plan.deliveries.length === 0, "Sugestão não publica mensagens.");
  return plan;
}
export async function performChannelAction(env: Env, actor: Actor, profile: string, id: string, input: unknown, commandId: string) {
  const ctx = await loadChannelOperationContext(env, actor, profile, { kind: "conversation", id }, commandId);
  const action = parseChannelAction(input);
  const plan = await prepareChannelAction(ctx, action);
  if (action.type.endsWith("suggest")) {
    requireValue(typeof plan.suggestion === "string" && plan.suggestion.length <= 50_000 && !plan.deliveries.length && !plan.statements?.length && !plan.reservations, "Sugestão inválida.");
    return { status: "suggestion", suggestion: plan.suggestion };
  }
  const { enqueueChannelPlan } = await import("./engine");
  return { delivery_id: await enqueueChannelPlan(ctx, plan, action), status: "pending", channel_extension: ctx.connection.channel };
}
export async function authorizeChannelActionReplay(env: Env, actor: Actor, profile: string, id: string, input: unknown): Promise<void> {
  const ctx = await loadChannelOperationContext(env, actor, profile, { kind: "conversation", id }, "replay");
  await authorizeChannelAction(ctx, input);
}
export async function validateChannelWritePlan(ctx: ChannelOperationContext, plan: ChannelWritePlan): Promise<void> {
  if (ctx.ingress) assertVerifiedIngress(ctx.ingress);
  requireValue(plan.statements.length <= 500, "Lote de canal grande demais.");
  if (ctx.resource && plan.resource && (ctx.resource.kind !== plan.resource.kind || ctx.resource.id !== plan.resource.id)) missing();
  const connection = await one(ctx.env, "SELECT 1 FROM connections WHERE id=? AND profile_id=? AND channel=? AND status='active'", ctx.connection.id, ctx.authorization.profileId, ctx.connection.channel);
  if (!connection) channelNotReady();
  if (plan.conversationId) {
    const existing = await one<Conversation>(ctx.env, "SELECT * FROM conversations WHERE id=?", plan.conversationId);
    if (existing && (existing.profile_id !== ctx.authorization.profileId || existing.connection_id !== ctx.connection.id)) missing();
  }
}
export async function applyChannelWritePlan(ctx: ChannelOperationContext, plan: ChannelWritePlan): Promise<void> {
  await validateChannelWritePlan(ctx, plan);
  if (plan.statements.length) await batch(ctx.env, plan.statements);
}
async function resolvedRoute(env: Env, profileId: string, method: string, path: string) {
  let found = findChannelRoute(method, path);
  if (found && path.includes("/connections/") && found.params.id) {
    const connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", found.params.id, profileId);
    if (!connection?.channel) missing();
    found = findChannelRoute(method, path, connection.channel);
  }
  return found;
}
export async function authorizeExtensionReplay(env: Env, original: Actor, profileId: string, method: string, path: string, input: unknown): Promise<void> {
  const found = await resolvedRoute(env, profileId, method, path);
  if (!found) channelNotReady();
  const actor = await currentActor(env, original);
  if (actor.kind !== "user" || actor.via) throw new ApiError(403, "human_only", "Esta operação exige uma pessoa autenticada.");
  const policy = found.route.authorization;
  access(actor, profileId, policy.startsWith("google") || policy.startsWith("reviews") ? "reports:read" : "conversations:write");
  if (policy === "admin") admin(actor);
  else if (policy === "reviews.read" || policy === "google.reply") {
    requireAccess(actor, "reports");
    if (found.params.id && !await one(env, "SELECT 1 FROM reviews WHERE id=? AND profile_id=?", found.params.id, profileId)) missing();
    if (policy === "google.reply" && actor.role !== "admin" && !await one(env, "SELECT 1 FROM channel_public_grants WHERE profile_id=? AND user_id=? AND permission='google.reply'", profileId, actor.id))
      throw new ApiError(403, "forbidden", "Sem permissão para publicar resposta no Google.");
  } else if (policy === "conversation.reply") {
    await loadChannelOperationContext(env, actor, profileId, { kind: "conversation", id: found.params.id }, "authorize");
  } else {
    requireAccess(actor, "contacts"); requireAccess(actor, "conversations");
    if (!object(input) || !identifier(input.contactId) || !await one(env, "SELECT 1 FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'", input.contactId, profileId)) missing();
  }
  if (path.includes("/connections/")) {
    const connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", found.params.id, profileId);
    if (!connection || connection.channel !== found.extension.spec.id) missing();
  }
}
export async function performExtensionRoute(env: Env, actor: Actor, profileId: string, method: string, path: string, input: unknown, commandId: string): Promise<unknown> {
  await authorizeExtensionReplay(env, actor, profileId, method, path, input);
  if (method !== "GET") requireValue(identifier(commandId), "Informe a chave idempotente.");
  const found = (await resolvedRoute(env, profileId, method, path))!;
  const result = await found.route.handler({ env, actor: await currentActor(env, actor), profileId, params: found.params, input, commandId, now: now() });
  assertPublicChannelData(result);
  return result;
}
export async function performConnectionSetup(ctx: ChannelRouteContext, method: string) {
  const connection = await one<ExtensionConnection>(ctx.env, "SELECT * FROM connections WHERE id=? AND profile_id=?", ctx.params.id, ctx.profileId);
  if (!connection?.channel) missing();
  if (!channelConnectionDriver(connection.channel)) channelNotReady();
  if (method === "GET") {
    const configured = !!await one(ctx.env, "SELECT 1 FROM secrets WHERE id=?", `connection:${connection.id}`);
    return { id: connection.id, channel: connection.channel, status: connection.status,
      credential: configured ? "configurado" : null, configured };
  }
  requireValue(object(ctx.input), "Configuração inválida.");
  return configureChannelConnection(ctx.env, ctx.actor, ctx.profileId, { ...ctx.input, id: connection.id, kind: connection.kind, channel: connection.channel }, ctx.commandId);
}
export async function configureChannelConnection(env: Env, original: Actor, profileId: string, input: unknown, commandId: string) {
  const actor = await currentActor(env, original); access(actor, profileId, "routing:read"); admin(actor);
  requireValue(object(input) && identifier(commandId), "Configuração inválida.");
  const channel = input.kind === "telegram_bot" ? "telegram" : input.kind === "email" ? "email" : null;
  if (!channel) channelNotReady();
  const driver = channelConnectionDriver(channel); if (!driver) channelNotReady();
  requireValue(input.channel === undefined || input.channel === channel, "Canal incompatível com a conexão.");
  const validated = driver.validate(input);
  requireValue(validated.channel === channel, "Canal inválido.");
  const id = identifier(input.id) ? input.id : `c2:${await sha(`${profileId}:${commandId}`)}`;
  let connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", id, profileId);
  if (connection && (connection.channel !== channel || connection.kind !== input.kind)) throw new ApiError(409, "channel_immutable", "O canal da conexão não pode ser alterado.");
  const time = now();
  if (!connection) {
    await batch(env, [["INSERT INTO connections(id,profile_id,name,kind,mode,status,config,channel,created) VALUES(?,?,?,?,'direct','paused','{}',?,?)", [id, profileId, typeof input.name === "string" ? input.name.slice(0, 120) : channel, input.kind, channel, time]]]);
    connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", id, profileId))!;
  }
  const result = await driver.configure({ env, actor, profileId, connection, input, commandId, now: time });
  // Driver guarda segredos somente no cofre. A projeção persiste apenas configuração pública.
  const config = result.configuration ?? validated.config;
  assertPublicChannelData(config);
  await batch(env, [["UPDATE connections SET config=?,status=? WHERE id=? AND profile_id=?", [JSON.stringify(config), result.status === "active" ? "active" : "paused", id, profileId]], ...refreshChannelSummaryStatements(profileId)]);
  return { id, channel, status: result.status, configured: result.configured, ...(result.code ? { code: result.code } : {}) };
}
export function assertPublicChannelData(value: unknown, depth = 0): void {
  if (depth > 16) throw new ApiError(400, "invalid_channel_data", "Metadados de canal inválidos.");
  if (typeof value === "string" && /https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^/\s]+/i.test(value))
    throw new ApiError(400, "invalid_channel_data", "Credencial não pode ser publicada.");
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:bot_token|webhook_secret|api_key|password|secret|raw|raw_html|html)$/i.test(key))
      throw new ApiError(400, "invalid_channel_data", "Credencial ou conteúdo bruto não pode ser publicado.");
    assertPublicChannelData(entry, depth + 1);
  }
}
