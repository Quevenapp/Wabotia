/** Fixtures sintéticas: formato do plano; a conferir com a conta real.
 * Worker, Coordinator, kernel, D1 e identidade continuam reais. Só a fronteira
 * do fornecedor é simulada; nenhuma captura de cliente ou credencial real. */
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";
// Estes ensaios instalam descritores (inclusive sintéticos) explicitamente.
// Isolamos apenas a instalação automática; Worker, Coordinator e registro
// continuam reais. c2-entry.test.ts não usa este helper e testa o main completo.
vi.mock("../src/c2-entry/install", () => ({}));
import Worker from "../src/index";
import { all, exec } from "../src/db";
import { hmac, setSecret, sha } from "../src/security";
import { ApiError, json, now, uid, type Env as WorkerEnv } from "../src/types";
import type { ChannelContext, ChannelId } from "../src/channel-contracts";
import type { ChannelExtension, VerifiedIngress } from "../src/channel-c2-contracts";
import { assertVerifiedIngress, signVerifiedIngress } from "../src/channel-extension-kernel";
import { replaceChannelExtensionForTests } from "../src/channel-extension-registry";
import { loadChannelOperationContext, parseChannelAction, prepareChannelAction } from "../src/channel-extension-kernel";
import { enqueueChannelPlan } from "../src/engine";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import { fixture, quietCoordinator } from "./service-center-fixture";
export { bearer, quietCoordinator } from "./service-center-fixture";
export { countingEnv, measure } from "./d1-counter";

declare global {
  namespace Cloudflare { interface Env extends WorkerEnv {} }
}

export function denyNetwork() {
  const unexpected: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    // Não copiamos URLs: um teste de Telegram pode conter token sintético.
    unexpected.push("chamada externa inesperada");
    throw new Error("Rede inesperada na fixture c2.");
  });
  return { unexpected, restore: () => spy.mockRestore(), assertNone: () => expect(unexpected).toEqual([]) };
}

export async function c2Fixture(channel: ChannelId = "googlebusiness") {
  const base = await fixture();
  const integration = uid(), account = uid().replaceAll("-", "").slice(0, 24), remoteProfile = uid().replaceAll("-", "").slice(0, 24);
  const address = `${base.line}@example.test`, webhookSecret = `c2-sintetico-${base.line}`;
  const kind = channel === "telegram" ? "telegram_bot" : channel === "email" ? "email" : "zernio";
  const config = { c2_enabled: true, comments_enabled: true, account_id: channel === "email" ? address : account,
    bot_id: channel === "telegram" ? account : undefined, address: channel === "email" ? address : undefined,
    zernio_workspace_id: kind === "zernio" ? integration : undefined,
    zernio_profile_id: kind === "zernio" ? remoteProfile : undefined,
    service: { mode: "human", menu_mode: "off" } };
  await exec(env, "UPDATE connections SET kind=?,channel=?,account_label=?,config=? WHERE id=? AND profile_id=?",
    kind, channel, "Conta sintética", JSON.stringify(config), base.line, base.profile);
  if (kind === "zernio") {
    await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,?,?,'zernio',?,?)",
      integration, base.profile, "Integração sintética", `zernio:${remoteProfile}`, remoteProfile, now());
    await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintetica-c2", webhook_secret: webhookSecret });
    if (channel !== "whatsapp") await exec(env,
      "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,'Conta sintética',?,?)",
      base.line, base.profile, integration, channel, account, remoteProfile, now(), now());
  } else if (kind === "telegram_bot") {
    await setSecret(env, `connection:${base.line}`, { bot_token: "000000:token-sintetico", webhook_secret: webhookSecret });
  }
  return { ...base, channel, integration, account: channel === "email" ? address : account, remoteProfile, webhookSecret, address };
}
export type C2Fixture = Awaited<ReturnType<typeof c2Fixture>>;

export async function c2Request(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await Worker.fetch(new Request(`https://test${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}
/** Entrada real do runtime; não inventa assinatura SMTP nem endpoint HTTP. */
export async function c2WorkerEmail(message: ForwardableEmailMessage): Promise<void> {
  const context = createExecutionContext();
  await Worker.email(message, env, context);
  await waitOnExecutionContext(context);
}
export async function c2Command(f: C2Fixture, operation: string, data: unknown, key = uid(), actor = f.admin) {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/command", {
    method: "POST", body: JSON.stringify({ profile: f.profile, actor, operation, data, key, requestId: uid() }),
  });
  await quietCoordinator(f.profile);
  return response;
}
export async function c2ZernioWebhook(f: C2Fixture, body: unknown, signature?: string): Promise<Response> {
  const raw = JSON.stringify(body);
  const response = await c2Request(`/webhooks/zernio-accounts/${f.integration}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Zernio-Signature": signature ?? await hmac(f.webhookSecret, raw) }, body: raw,
  });
  await quietCoordinator(f.profile);
  return response;
}
export async function c2TelegramWebhook(f: C2Fixture, body: unknown, webhookSecret = f.webhookSecret): Promise<Response> {
  const response = await c2Request(`/webhooks/telegram-bot/${f.line}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhookSecret }, body: JSON.stringify(body),
  });
  await quietCoordinator(f.profile);
  return response;
}
export async function coordinatorTicket(f: C2Fixture, input: unknown, context: ChannelContext = f.channel === "googlebusiness" ? "review" : "direct") {
  const scope: VerifiedIngress = { profileId: f.profile, connectionId: f.line, channel: f.channel,
    context, accountId: f.account, source: f.channel === "telegram" ? "telegram_secret" : f.channel === "email" ? "worker_email" : "zernio_hmac" };
  return signVerifiedIngress(env, scope, input);
}
export async function c2Ingress(f: C2Fixture, input: unknown, context?: ChannelContext): Promise<Response> {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/c2-inbound", {
    method: "POST", body: JSON.stringify({ profile: f.profile, ticket: await coordinatorTicket(f, input, context) }),
  });
  await quietCoordinator(f.profile);
  return response;
}
export function reviewFixtureEvent(f: C2Fixture, id = uid()) {
  return { id, event: "review.new", account: { accountId: f.account, platform: "googlebusiness", profileId: f.remoteProfile },
    review: { id: `review:${id}`, rating: 4, text: "Atendimento com atenção.", authorName: "Pessoa sintética", publishedAt: now() - 1000 } };
}
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input)
  ? input as Record<string, unknown> : {};

/** Descritor de ensaio, não adaptador de Google. Nenhum normalizador real é
 * presumido. O teste consegue percorrer outbox sem conversa e sua recuperação. */
export const syntheticReviewExtension: ChannelExtension = {
  ...CHANNEL_EXTENSION_STUBS["googlebusiness/review"],
  spec: { ...CHANNEL_EXTENSION_STUBS["googlebusiness/review"].spec, enabled: true,
    contexts: { review: { enabled: true, bot: false, publicReply: true } }, text: { enabled: true, maxChars: 4000 } },
  enabled: connection => json(connection.config).c2_enabled === true,
  account: { importable: true, serviceLine: false },
  ingress: { zernio: { matches: input => String(record(input).event).startsWith("review.") } },
  async normalize(input, scope) {
    assertVerifiedIngress(scope);
    const body = record(input), account = record(body.account), review = record(body.review);
    if (scope.channel !== "googlebusiness" || scope.context !== "review" || body.event !== "review.new" ||
        account.accountId !== scope.accountId || account.platform !== scope.channel || typeof body.id !== "string" ||
        typeof review.id !== "string" || typeof review.rating !== "number" || review.rating < 1 || review.rating > 5) return null;
    return { key: body.id, kind: "review.new", remoteId: review.id,
      occurredAt: typeof review.publishedAt === "number" ? review.publishedAt : null,
      context: {}, content: { rating: review.rating, text: typeof review.text === "string" ? review.text.slice(0, 4000) : "" } };
  },
  async prepareInbound(ctx, event) {
    const id = `c2-review:${await sha(JSON.stringify([ctx.connection.id, event.remoteId]))}`;
    return { resource: { kind: "review", id }, wake: false, statements: [[
      `INSERT INTO reviews(id,profile_id,connection_id,account_id,remote_id,rating,text,last_event_key,published_at,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,remote_id) DO UPDATE SET text=excluded.text,
       rating=excluded.rating,last_event_key=excluded.last_event_key,version=reviews.version+1,updated=excluded.updated`,
      [id, ctx.authorization.profileId, ctx.connection.id, ctx.ingress!.accountId, event.remoteId,
        event.content.rating, event.content.text, event.key, event.occurredAt, ctx.now, ctx.now],
    ]] };
  },
  async prepareSend(ctx, action) {
    if (ctx.resource?.kind !== "review" || !["google.reply", "google.reply.delete"].includes(action.type))
      throw new ApiError(422, "unsupported_content", "A fixture aceita somente resposta de avaliação.");
    return { resource: { kind: "review", id: ctx.resource.id }, operation: action.type, orderKey: `review:${ctx.resource.id}`,
      deliveries: [{ key: ctx.commandId, payload: { text: "text" in action ? action.text : "" } }] };
  },
  async deliver(ctx) { await ctx.beforeFetch(); return { kind: "sent", externalId: `synthetic:${ctx.outbox.id}` }; },
  async complete(ctx) {
    if (ctx.resource.kind !== "review") throw new Error("A fixture não cria conversa para avaliação.");
    const payload = record(record(json(ctx.outbox.payload).c2).delivery);
    return { resource: { kind: "review", id: ctx.resource.id }, wake: false, statements: ctx.result.kind === "sent" ? [[
      "UPDATE reviews SET reply_text=?,reply_at=?,replied_by=?,version=version+1,updated=? WHERE id=? AND profile_id=? AND version=?",
      [typeof payload.text === "string" ? payload.text : "", ctx.now, ctx.outbox.actor, ctx.now,
        ctx.resource.id, ctx.outbox.profile_id, ctx.resource.review.version],
    ]] : [] };
  },
  routes: [
    { method: "GET", path: "/reviews", authorization: "reviews.read", handler: async () => ({ data: [] }) },
    { method: "PUT", path: "/reviews/:id/reply", authorization: "google.reply", async handler(ctx) {
      const input = record(ctx.input);
      const action = parseChannelAction({ type: "google.reply", text: input.text, version: input.version });
      const operation = await loadChannelOperationContext(ctx.env, ctx.actor, ctx.profileId, { kind: "review", id: ctx.params.id }, ctx.commandId);
      const plan = await prepareChannelAction(operation, action);
      return { delivery_id: await enqueueChannelPlan(operation, plan, action), status: "pending" };
    } },
  ],
};

// A composição de produção já instala os descritores reais; o teste troca o da
// mesma chave pelo que quer exercitar (o próprio descritor real passa direto).
export async function installTestExtension(f: C2Fixture, extension: ChannelExtension) {
  replaceChannelExtensionForTests(extension);
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  await runInDurableObject(stub, async () => { replaceChannelExtensionForTests(extension); });
}
export async function installSyntheticReview(f: C2Fixture) {
  await installTestExtension(f, syntheticReviewExtension);
}
export async function assertNoChannelEffects(profile: string) {
  for (const table of ["conversations", "messages", "contacts", "reviews", "outbox", "inbox", "media", "bot_runs"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, profile), table).toEqual([]);
  expect(await all(env, `SELECT e.event_key FROM channel_events e JOIN connections c ON c.id=e.connection_id
    WHERE c.profile_id=?`, profile), "channel_events").toEqual([]);
}
