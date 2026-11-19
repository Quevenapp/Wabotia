/** Formato do plano; a conferir com a conta real.
 * Este é o único leitor dos envelopes, da paginação e da resposta da Zernio.
 * Uma página, mesmo sem cursor, nunca comprova exclusão por ausência. */
import type { ChannelDeliveryContext, ChannelDeliveryResult, ExtensionConnection, VerifiedIngress } from "../channel-c2-contracts";
import { one } from "../db";
import { ApiError, json, now, type Env } from "../types";
import { zernioRequest } from "../zernio";

export interface GoogleReviewData {
  remoteId: string;
  rating: number | null;
  text: string;
  authorName: string;
  authorPicture: string;
  permalink: string;
  publishedAt: number | null;
  updatedAt: number | null;
  /** null significa campo ausente; string vazia confirma resposta removida. */
  replyText: string | null;
  replyAt: number | null;
  state: "active" | "deleted";
}
export interface GoogleProviderEvent {
  kind: "review.new" | "review.updated" | "review.deleted" | "review.restored";
  eventId: string | null;
  review: GoogleReviewData;
}
export interface GoogleReviewPage {
  reviews: GoogleReviewData[];
  nextCursor: string | null;
}

const kinds = new Set(["review.new", "review.updated", "review.deleted", "review.restored"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const identifier = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const text = (value: unknown, max: number): string => typeof value === "string"
  ? value.replace(/\u0000/g, "").slice(0, max) : "";
function timestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 8_640_000_000_000_000 ? parsed : null;
}
function publicUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
}
function readReview(input: unknown, state?: "active" | "deleted"): GoogleReviewData | null {
  const row = object(input), remoteId = identifier(row.id);
  if (row.state !== undefined && row.state !== "active" && row.state !== "deleted") return null;
  if (state !== undefined && row.state !== undefined && row.state !== state) return null;
  const deleted = state === "deleted" || (state === undefined && row.state === "deleted");
  const rating = Number.isInteger(row.rating) && Number(row.rating) >= 1 && Number(row.rating) <= 5 ? Number(row.rating) : null;
  if (!remoteId || (!deleted && rating === null)) return null;
  const reply = object(row.reply);
  return {
    remoteId, rating, text: text(row.text, 20_000), authorName: text(row.authorName, 200),
    authorPicture: publicUrl(row.authorPicture), permalink: publicUrl(row.permalink),
    publishedAt: timestamp(row.publishedAt), updatedAt: timestamp(row.updatedAt),
    replyText: row.reply === null ? "" : typeof reply.text === "string" ? text(reply.text, 20_000) : null,
    replyAt: timestamp(reply.updatedAt), state: deleted ? "deleted" : "active",
  };
}

export function matchesGoogleReviewEvent(input: unknown): boolean {
  return kinds.has(String(object(input).event));
}
/** Puro: a autenticidade do scope é verificada pelo kernel antes deste leitor. */
export function readGoogleReviewEvent(input: unknown, scope: VerifiedIngress): GoogleProviderEvent | null {
  const body = object(input), account = object(body.account);
  if (scope.channel !== "googlebusiness" || scope.context !== "review" || scope.source !== "zernio_hmac" ||
      account.accountId !== scope.accountId || account.platform !== "googlebusiness" || !matchesGoogleReviewEvent(body)) return null;
  const kind = body.event as GoogleProviderEvent["kind"];
  const explicitState = kind === "review.deleted" ? "deleted" : "active";
  const review = readReview(body.review, explicitState);
  if (!review) return null;
  // O horário da mutação pertence ao fornecedor; chegada/retry não cria versão.
  review.updatedAt ??= timestamp(body.occurredAt);
  return { kind, eventId: identifier(body.id), review };
}
function invalidContract(): never {
  throw new ApiError(502, "provider_contract_unverified", "O formato das avaliações precisa ser confirmado com a conta real.");
}
export function readGoogleReviewPage(input: unknown, accountId: string): GoogleReviewPage {
  const body = object(input);
  if (!Array.isArray(body.reviews) || body.reviews.length > 100 ||
      (body.accountId !== undefined && body.accountId !== accountId) ||
      (body.platform !== undefined && body.platform !== "googlebusiness")) invalidContract();
  const reviews: GoogleReviewData[] = [];
  for (const inputReview of body.reviews) {
    const row = object(inputReview);
    if ((row.accountId !== undefined && row.accountId !== accountId) ||
        (row.platform !== undefined && row.platform !== "googlebusiness")) invalidContract();
    const review = readReview(row);
    if (!review) invalidContract();
    reviews.push(review);
  }
  const nextCursor = body.nextCursor === null || body.nextCursor === undefined ? null : identifier(body.nextCursor);
  if (body.nextCursor !== null && body.nextCursor !== undefined && !nextCursor) invalidContract();
  return { reviews, nextCursor };
}

export async function fetchGoogleReviewPage(env: Env, connection: ExtensionConnection, options: {
  cursor: string | null; limit: number; since: number; deadline: number;
}): Promise<GoogleReviewPage> {
  const config = object(json(connection.config)), accountId = identifier(config.account_id);
  if (connection.kind !== "zernio" || connection.channel !== "googlebusiness" || connection.status !== "active" || !accountId)
    throw new ApiError(409, "channel_not_ready", "A conexão Google não está pronta.");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 || !Number.isSafeInteger(options.since) ||
      options.since < 0 || options.since > 8_640_000_000_000_000 || !Number.isSafeInteger(options.deadline) ||
      (options.cursor !== null && !identifier(options.cursor))) invalidContract();
  const query = new URLSearchParams({ accountId, limit: String(options.limit), since: new Date(options.since).toISOString() });
  if (options.cursor !== null) query.set("cursor", options.cursor);
  try {
    const result: unknown = await zernioRequest(env, connection, `inbox/reviews?${query}`, "GET", undefined, undefined, async () => {
      // A manutenção não recebe ChannelDeliveryContext.beforeFetch. Revalidar
      // o vínculo aqui, depois das leituras de credenciais e antes da rede.
      const current = await one<{ config: string }>(env, `SELECT c.config FROM connections c
        JOIN zernio_channel_accounts a ON a.connection_id=c.id AND a.profile_id=c.profile_id AND a.channel=c.channel
        JOIN meta_accounts m ON m.id=a.integration_id AND m.profile_id=c.profile_id AND m.provider='zernio'
        WHERE c.id=? AND c.profile_id=? AND c.kind='zernio' AND c.channel='googlebusiness' AND c.status='active'
          AND a.account_id=? AND a.integration_id=? AND a.provider_profile_id=?`,
      connection.id, connection.profile_id, accountId, config.zernio_workspace_id ?? "", config.zernio_profile_id ?? "");
      const live = object(json(current?.config));
      if (!current || live.account_id !== accountId || live.zernio_workspace_id !== config.zernio_workspace_id ||
          live.zernio_profile_id !== config.zernio_profile_id || live.remove_pending || live.reviews_enabled === false ||
          (live.reviews_enabled !== true && live.c2_enabled !== true))
        throw new ApiError(409, "channel_not_ready", "A conexão Google não está pronta.");
      // O transporte compartilhado limita cada fetch a 15 s. Não iniciar outro
      // pedido se esse teto já não couber no prazo da rodada.
      if (now() + 15_000 > options.deadline)
        throw new ApiError(409, "sync_budget_exhausted", "O prazo desta rodada de avaliações terminou.");
    });
    const page = readGoogleReviewPage(result, accountId);
    if (page.reviews.length > options.limit) invalidContract();
    return page;
  } catch (error) {
    if (error instanceof ApiError && ["channel_not_ready", "sync_budget_exhausted", "provider_contract_unverified"].includes(error.code)) throw error;
    throw new ApiError(502, "google_sync_failed", "Não foi possível conferir as avaliações nesta rodada.");
  }
}

export async function publishGoogleReply(ctx: ChannelDeliveryContext, input: {
  remoteId: string; text: string; remove: boolean;
}): Promise<ChannelDeliveryResult> {
  const accountId = identifier(ctx.configuration.account_id);
  if (!accountId || !identifier(input.remoteId) || ctx.connection.channel !== "googlebusiness" || ctx.connection.kind !== "zernio")
    return { kind: "failed", code: "channel_not_ready" };
  if (!input.remove && (!input.text.trim() || [...input.text].length > 4000))
    return { kind: "failed", code: "unsupported_content" };
  const query = new URLSearchParams({ accountId });
  // Método e corpo de reply: formato do plano; a conferir com a conta real.
  const path = `inbox/reviews/${encodeURIComponent(input.remoteId)}/reply${input.remove ? `?${query}` : ""}`;
  let attempted = false;
  try {
    const result: unknown = await zernioRequest(ctx.env, ctx.connection, path, input.remove ? "DELETE" : "POST",
      input.remove ? undefined : { accountId, text: input.text }, ctx.outbox.id, async () => {
        await ctx.beforeFetch();
        attempted = true;
      });
    const body = object(result);
    if (body.success !== true) return { kind: "unknown", code: "provider_unknown" };
    const replyAt = timestamp(object(body.reply).updatedAt);
    return { kind: "sent", ...(replyAt === null ? {} : { context: { replyAt } }) };
  } catch (error) {
    // A guarda deve chegar ao motor com seu código local, sem ser confundida
    // com timeout depois de uma publicação possivelmente aceita.
    if (!attempted) throw error instanceof ApiError ? error : new ApiError(409, "channel_not_ready", "A conexão Google não está pronta.");
    if (error instanceof ApiError && error.code === "zernio_rejected") {
      // O transporte antigo conserva o status apenas no prefixo gerado localmente.
      // Não interpretar corpo, URL ou conselho remoto como autorização para retry.
      if (/^Zernio recusou a operação \(HTTP 429(?:,|\))/.test(error.message))
        return { kind: "retry", code: "rate_limited", notBefore: ctx.now + 60_000 };
      if (/^Zernio recusou a operação \(HTTP 408(?:,|\))/.test(error.message))
        return { kind: "unknown", code: "provider_unknown" };
      return { kind: "failed", code: "google_reply_rejected" };
    }
    return { kind: "unknown", code: "provider_unknown" };
  }
}
