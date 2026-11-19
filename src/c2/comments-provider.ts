import type { ChannelConnection } from "../channel-contracts";
import type { ChannelDeliveryContext, ChannelDeliveryResult, NormalizedChannelEvent, VerifiedIngress } from "../channel-c2-contracts";
import { ApiError } from "../types";
import { zernioRequest } from "../zernio";

/** Formato do plano; a conferir com a conta real. Todos os nomes de campos,
 * aliases, endpoints e hipóteses de resposta de comentários ficam neste leitor.
 * O contrato de ocultação exige confirmação explícita antes de qualquer envio.
 * A resposta de privada só prova DM se trouxer TODOS os campos de privateReply
 * abaixo; um ID de autor de comentário jamais é usado como participante de DM. */
export const COMMENT_PROVIDER_PENDING = Object.freeze({
  inbound: "comment.received: account, comment.author, comment.createdAt e post; a conferir com a conta real",
  reply: "POST /v1/inbox/comments/{postId}: accountId, platform, commentId, text; a conferir com a conta real",
  privateReply: "POST /v1/inbox/comments/{postId}/{commentId}/private-reply: accountId, platform, text; a conferir com a conta real",
  visibility: "PATCH /v1/inbox/comments/{postId}/{commentId}: accountId, platform, hidden; a conferir com a conta real",
  privateIdentity: "privateReply: commentId, postId, accountId, platform, profileId, conversationId e participantId; a conferir com a conta real",
});

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function configOf(connection: ChannelConnection): Record<string, unknown> {
  try { return record(JSON.parse(connection.config)); } catch { return {}; }
}
function opaque(value: unknown): string | null {
  const text = typeof value === "string" ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  if (!text || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  try { encodeURIComponent(text); return text; } catch { return null; }
}
const limitedText = (value: unknown, limit: number): string => typeof value === "string" ? value.slice(0, limit) : "";
function publicUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
function timestamp(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : value;
  return typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time <= Date.now() ? time : null;
}

/** Reconhecer a família impede eventos não implementados de caírem no parser DM. */
export function matchesCommentEvent(input: unknown): boolean {
  const event = record(input).event;
  return typeof event === "string" && event.startsWith("comment.");
}

/** Leitura pura: sem rede, downloads, credenciais ou escrita. O descritor exige
 * assertVerifiedIngress antes desta função; scope nunca vem do corpo público. */
export async function normalizeCommentEvent(input: unknown, scope: VerifiedIngress): Promise<NormalizedChannelEvent | null> {
  const body = record(input), account = record(body.account), comment = record(body.comment), post = record(body.post);
  if (body.event !== "comment.received" || body.test === true || scope.context !== "comment" ||
      scope.source !== "zernio_hmac" || !["instagram", "facebook"].includes(scope.channel) ||
      account.platform !== scope.channel || opaque(account.accountId ?? account.id) !== scope.accountId) return null;
  const author = record(comment.author), remoteId = opaque(comment.id), authorId = opaque(author.id), postId = opaque(post.id);
  const providerProfileId = opaque(account.profileId);
  if (!remoteId || !authorId || !postId || !providerProfileId) return null;
  if ((comment.accountId !== undefined && opaque(comment.accountId) !== scope.accountId) ||
      (post.accountId !== undefined && opaque(post.accountId) !== scope.accountId) ||
      (comment.platform !== undefined && comment.platform !== scope.channel) ||
      (post.platform !== undefined && post.platform !== scope.channel) ||
      (comment.postId !== undefined && opaque(comment.postId) !== postId)) return null;
  const parentId = comment.parentCommentId == null ? null : opaque(comment.parentCommentId);
  if (comment.parentCommentId != null && !parentId) return null;
  const permalink = publicUrl(post.permalink), imageUrl = publicUrl(post.imageUrl);
  return {
    // O ID do envelope pode mudar no retry. A identidade imutável é o comentário.
    key: `comment.received:${remoteId}`,
    kind: "comment.received", remoteId, subjectId: authorId, subjectNamespace: "comment-author",
    occurredAt: timestamp(comment.createdAt ?? comment.timestamp),
    context: { postId, providerProfileId, accountId: scope.accountId, channel: scope.channel,
      ...(parentId ? { parentId } : {}), postText: limitedText(post.text, 4000),
      ...(permalink ? { permalink } : {}), ...(imageUrl ? { imageUrl } : {}) },
    content: { text: limitedText(comment.text, 10000), displayName: limitedText(author.name, 256), username: limitedText(author.username, 256) },
  };
}

/** VerifiedIngress contém a área local, não o perfil Zernio. A preparação
 * confere o perfil do fornecedor contra a conexão já carregada pelo kernel. */
export function assertCommentProviderScope(event: NormalizedChannelEvent, connection: ChannelConnection): void {
  const config = configOf(connection);
  if (connection.kind !== "zernio" || event.context.channel !== connection.channel ||
      event.context.accountId !== config.account_id || !opaque(config.zernio_profile_id) ||
      event.context.providerProfileId !== config.zernio_profile_id)
    throw new ApiError(403, "invalid_channel_evidence", "A conta do comentário não foi confirmada.");
}

export type CommentRemoteOperation = "comment.reply" | "comment.private" | "comment.visibility";
export interface CommentRemoteAction {
  operation: CommentRemoteOperation;
  postId: string;
  remoteId: string;
  text?: string;
  hidden?: boolean;
}

/** Sem I/O, para rejeitar contratos indisponíveis antes da reserva de privada. */
export function validateCommentOperation(configuration: Readonly<Record<string, unknown>>, operation: CommentRemoteOperation): void {
  if (!["comment.reply", "comment.private", "comment.visibility"].includes(operation))
    throw new ApiError(422, "unsupported_content", "A operação de comentário não é suportada.");
  if (operation === "comment.visibility" && configuration.comments_visibility_contract !== "v1")
    throw new ApiError(409, "provider_contract_unverified", "O formato de ocultação ainda precisa ser confirmado com a conta real.");
}

function validateTarget(action: CommentRemoteAction): void {
  if (!opaque(action.postId) || !opaque(action.remoteId) || /^\.{1,2}$/.test(action.postId) || /^\.{1,2}$/.test(action.remoteId))
    throw new ApiError(422, "invalid_comment", "O comentário alvo é inválido.");
  if (action.operation === "comment.visibility" ? typeof action.hidden !== "boolean"
    : typeof action.text !== "string" || !action.text.trim() || action.text.length > 10000)
    throw new ApiError(422, "unsupported_content", "Revise o conteúdo da ação do comentário.");
}

function confirmedPrivateThread(result: Record<string, unknown>, ctx: ChannelDeliveryContext, action: CommentRemoteAction): string | null {
  const reply = record(result.privateReply), config = ctx.configuration;
  const threadId = opaque(reply.conversationId);
  if (!threadId || opaque(reply.commentId) !== action.remoteId || opaque(reply.postId) !== action.postId ||
      reply.platform !== ctx.connection.channel || opaque(reply.accountId) !== config.account_id ||
      !opaque(config.zernio_profile_id) || opaque(reply.profileId) !== config.zernio_profile_id) return null;
  return threadId;
}

/** Única fronteira remota. zernioRequest resolve a credencial e só então chama
 * beforeFetch imediatamente antes da rede. Falhas locais propagam, permitindo
 * liberar reserva sem consumir tentativa. Não copiamos mensagem/corpo remoto. */
export async function deliverComment(ctx: ChannelDeliveryContext, action: CommentRemoteAction): Promise<ChannelDeliveryResult> {
  validateCommentOperation(ctx.configuration, action.operation);
  validateTarget(action);
  if (ctx.connection.kind !== "zernio" || !["instagram", "facebook"].includes(String(ctx.connection.channel)) ||
      !opaque(ctx.configuration.account_id))
    throw new ApiError(409, "channel_not_ready", "A conexão de comentários não está pronta.");
  const post = encodeURIComponent(action.postId), comment = encodeURIComponent(action.remoteId);
  const path = action.operation === "comment.reply" ? `inbox/comments/${post}`
    : action.operation === "comment.private" ? `inbox/comments/${post}/${comment}/private-reply` : `inbox/comments/${post}/${comment}`;
  const body = { accountId: ctx.configuration.account_id, platform: ctx.connection.channel,
    ...(action.operation === "comment.reply" ? { commentId: action.remoteId } : {}),
    ...(action.operation === "comment.visibility" ? { hidden: action.hidden } : { text: action.text }) };
  let result: Record<string, unknown>;
  try {
    result = record(await zernioRequest(ctx.env, ctx.connection, path,
      action.operation === "comment.visibility" ? "PATCH" : "POST", body, ctx.outbox.id, ctx.beforeFetch));
  } catch (error) {
    if (error instanceof ApiError && error.code === "zernio_rejected") return { kind: "failed", code: "zernio_rejected" };
    if (error instanceof ApiError && error.code === "zernio_unknown") return { kind: "unknown", code: "zernio_unknown" };
    throw error;
  }
  if (action.operation === "comment.visibility") {
    const updated = record(result.comment);
    return result.success === true && opaque(updated.id) === action.remoteId && updated.hidden === action.hidden
      ? { kind: "sent", context: { hidden: action.hidden } }
      : { kind: "unknown", code: "provider_contract_unverified" };
  }
  const reply = record(result.privateReply), publicComment = record(result.comment);
  const externalId = opaque(action.operation === "comment.private" ? reply.messageId : publicComment.id);
  if (result.success !== true && !externalId) return { kind: "unknown", code: "provider_contract_unverified" };
  if (action.operation === "comment.private") {
    const threadId = confirmedPrivateThread(result, ctx, action), subjectId = opaque(reply.participantId);
    const dm = threadId && subjectId ? { threadId, subjectId, accountId: ctx.configuration.account_id, channel: ctx.connection.channel } : null;
    return { kind: "sent", ...(externalId ? { externalId } : {}),
      context: dm ? { dm, privateThreadId: threadId, privateLinkPending: false }
        : { ...(threadId ? { privateThreadId: threadId } : {}), privateLinkPending: true } };
  }
  return { kind: "sent", ...(externalId ? { externalId } : {}) };
}
