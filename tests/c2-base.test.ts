import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { now, uid, type Conversation, type Env } from "../src/types";
import { channelRules } from "../src/channels";
import { createChannelExtensionRegistry, channelExtension, extensionKey } from "../src/channel-extension-registry";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import { assertPublicChannelData, assertVerifiedIngress, authorizeChannelAction, loadChannelOperationContext,
  parseChannelAction, prepareChannelAction, signVerifiedIngress, verifyIngressTicket } from "../src/channel-extension-kernel";
import { prepareChannelInbound, resolveChannelCustomer } from "../src/customer/channel-identity";
import { dispatchChannelDelivery, enqueueChannelPlan, listReadyChannelDeliveries, nextChannelDeliveryAt, recoverChannelDeliveries } from "../src/engine";
import { completeChannelDelivery } from "../src/delivery";
import { inbound } from "../src/service";
import type { ChannelExtension, ChannelOperationContext, ChannelOutboxRow, ChannelReview, VerifiedIngress } from "../src/channel-c2-contracts";
import { assertNoChannelEffects, bearer, c2Fixture, c2Ingress, c2Request, c2TelegramWebhook, c2ZernioWebhook,
  coordinatorTicket, denyNetwork, installSyntheticReview, measure, quietCoordinator, reviewFixtureEvent,
  syntheticReviewExtension, type C2Fixture } from "./c2-fixtures";

const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); network.restore(); network.assertNone();
});
async function setup(channel: Parameters<typeof c2Fixture>[0] = "googlebusiness") {
  const fixture = await c2Fixture(channel); profiles.add(fixture.profile); return fixture;
}
async function review(f: C2Fixture) {
  await installSyntheticReview(f);
  const response = await c2Ingress(f, reviewFixtureEvent(f));
  expect(response.status).toBe(202);
  const row = await one<ChannelReview>(env, "SELECT * FROM reviews WHERE profile_id=?", f.profile);
  expect(row).not.toBeNull(); return row!;
}
async function emailConversation(f: C2Fixture) {
  const id = uid();
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
    channel,channel_account_id,channel_subject_id,channel_context,customer_link_state,last_customer,created,updated)
    VALUES(?,?,?,?,?,?,'email',?,?,'{"version":1,"context":"direct"}','pending',?,?,?)`,
    id, f.profile, f.line, `channel:${f.line}`, "email:pessoa@example.test", id, f.account, "pessoa@example.test", now(), now(), now());
  return (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id))!;
}

describe("c2-base: instalação e fachadas tardias", () => {
  it("registra o mesmo objeto uma vez, rejeita substituição e não executa nenhum hook", () => {
    const registry = createChannelExtensionRegistry(); let called = 0;
    const descriptor: ChannelExtension = { ...syntheticReviewExtension, normalize: async () => { called++; throw new Error("I/O não permitido na instalação"); } };
    registry.registerChannelExtension(descriptor); registry.registerChannelExtension(descriptor);
    expect(() => registry.registerChannelExtension({ ...descriptor })).toThrow(/já registrada/);
    expect(registry.channelExtension(descriptor.key)).toBe(descriptor);
    expect(called).toBe(0);
  });
  it("mantém stubs permanentes sem SQL, rede, credenciais ou projeção", async () => {
    const registry = createChannelExtensionRegistry();
    const stub = registry.channelExtension("telegram/direct");
    const trap = new Proxy({}, { get() { throw new Error("I/O proibido"); } });
    await expect(stub.prepareInbound(trap as ChannelOperationContext, {} as never)).rejects.toMatchObject({ status: 503, code: "channel_not_ready" });
    await expect(stub.prepareSend(trap as ChannelOperationContext, { type: "message.send", text: "Olá" })).rejects.toMatchObject({ status: 503 });
    expect(stub.view).toBeUndefined(); expect(stub.maintenance).toBeUndefined();
    registry.registerChannelExtension({ ...stub, enabled: () => true });
    expect(stub).toBe(CHANNEL_EXTENSION_STUBS["telegram/direct"]);
    expect(stub.spec.enabled).toBe(false);
  });
  it("consulta rotas na invocação, mesmo quando o consumidor precede a instalação", () => {
    const registry = createChannelExtensionRegistry(); const lookup = registry.findChannelRoute;
    expect(lookup("GET", "/reviews/one")).toBeNull();
    registry.registerChannelExtension({ ...syntheticReviewExtension,
      routes: [{ method: "GET", path: "/reviews/:id", authorization: "reviews.read", handler: async ctx => ({ id: ctx.params.id }) }] });
    expect(lookup("GET", "/c2/reviews/one")?.params).toEqual({ id: "one" });
    expect(lookup("GET", "/reviews/a%2Fb")).toBeNull();
  });
  it("canal não usado não consulta SQL e preserva WhatsApp fora do registro", async () => {
    const measured = await measure(env as Env, async counted => {
      expect(extensionKey("whatsapp")).toBeNull();
      expect(extensionKey("instagram")).toBeNull();
      expect(extensionKey("facebook")).toBeNull();
      const rules = channelRules({ id: "legacy", profile_id: "area", kind: "qr", channel: "whatsapp", config: "{}" });
      expect(rules?.enabled).toBe(true); expect(rules?.templates).toBe(false);
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(measured.count).toMatchObject({ calls: 0, statements: 0 });
  });
  it("não aceita publicação pública automática nem prova embutida na ação", async () => {
    const f = await setup();
    const ctx = { env, connection: { channel: "googlebusiness" }, resource: { kind: "review", id: "r" },
      authorization: { actor: { ...f.admin, kind: "app" }, profileId: f.profile, origin: "bot", permissions: [] } } as unknown as ChannelOperationContext;
    await expect(authorizeChannelAction(ctx, { type: "google.reply", version: 1, text: "Resposta" })).rejects.toMatchObject({ code: "human_only" });
    expect(() => parseChannelAction({ type: "message.send", text: "Olá", origin: "human", verified: true })).toThrow();
    expect(() => parseChannelAction({ type: "email.auto-reply", subject: "Assunto", text: "Olá" })).toThrow();
    expect(() => assertPublicChannelData({ bot_token: "segredo" })).toThrow();
    expect(() => assertPublicChannelData({ url: "https://api.telegram.org/file/bot000:segredo/arquivo" })).toThrow();
    await assertNoChannelEffects(f.profile);
  });
});

describe("c2-base: autenticidade, identidade e deduplicação", () => {
  it("recusa ticket/escopo fabricado antes de efeitos e vincula o conteúdo ao ticket", async () => {
    const f = await setup();
    const scope = { profileId: f.profile, connectionId: f.line, channel: "googlebusiness", context: "review", accountId: f.account, source: "zernio_hmac" } as const;
    expect(() => assertVerifiedIngress(scope)).toThrow();
    const ticket = await signVerifiedIngress(env as Env, scope, { event: "original" });
    const parsed = await verifyIngressTicket(env as Env, ticket);
    expect(() => assertVerifiedIngress(parsed.scope)).not.toThrow();
    expect(() => assertVerifiedIngress(JSON.parse(JSON.stringify(parsed.scope)) as VerifiedIngress)).toThrow();
    const altered = JSON.parse(ticket); altered.body = altered.body.replace("original", "forjado");
    await expect(verifyIngressTicket(env as Env, JSON.stringify(altered))).rejects.toMatchObject({ status: 403 });
    const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/c2-inbound", {
      method: "POST", body: JSON.stringify({ profile: f.profile, ticket: JSON.stringify(altered), verified: true }),
    });
    expect(response.status).toBe(403); await assertNoChannelEffects(f.profile);
  });
  it("Worker real recusa HMAC Zernio e segredo Telegram errados sem efeitos", async () => {
    const google = await setup(); await installSyntheticReview(google);
    expect((await c2ZernioWebhook(google, reviewFixtureEvent(google), "00")).status).toBe(403);
    await assertNoChannelEffects(google.profile);
    const telegram = await setup("telegram");
    expect((await c2TelegramWebhook(telegram, { update_id: 1 }, "segredo-incorreto")).status).toBe(403);
    const malformed = await c2Request(`/webhooks/telegram-bot/${telegram.line}`, { method: "POST", body: "{", headers: { "X-Telegram-Bot-Api-Secret-Token": "errado" } });
    expect(malformed.status).toBe(403); await assertNoChannelEffects(telegram.profile);
  });
  it("Worker → Coordinator repete concorrentemente um evento sem criar duas avaliações", async () => {
    const f = await setup(); await installSyntheticReview(f); const event = reviewFixtureEvent(f);
    const responses = await Promise.all([c2ZernioWebhook(f, event), c2ZernioWebhook(f, event)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    expect(await all(env, "SELECT version FROM reviews WHERE profile_id=?", f.profile)).toEqual([{ version: 1 }]);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("e-mail mantém vínculo operacional, nunca prova de pessoa ou telefone", async () => {
    const f = await setup("email"), c = await emailConversation(f);
    const scope: VerifiedIngress = { profileId: f.profile, connectionId: f.line, channel: "email", context: "direct", accountId: f.account, source: "worker_email" };
    await signVerifiedIngress(env as Env, scope, { authenticationResults: "dmarc=pass" });
    const plan = await prepareChannelInbound(env as Env, c, { channel: "email", provider: "email", accountId: f.account,
      subjectId: "pessoa@example.test", subjectNamespace: "email-address", ingress: scope });
    expect(plan.customer).toMatchObject({ verifiedPhone: null, verifiedChannel: null, identityTrust: "unverified_sender" });
    await batch(env, plan.statements);
    const persisted = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", c.id))!;
    expect(await resolveChannelCustomer(env as Env, persisted)).toMatchObject({ state: "ready", verifiedPhone: null, verifiedChannel: null, identityTrust: "unverified_sender" });
    await expect(inbound(env as Env, f.profile, { channel: "email", verified: true, origin: "worker_email", text: "Falso", external_id: "pessoa@example.test" }, `channel:${f.line}`, f.line)).rejects.toMatchObject({ code: "invalid_channel_evidence" });
  });
});

describe("c2-base: outbox sem conversa e recuperação", () => {
  it("conclui no descritor e recupera sent sem criar balão nem enviar novamente", async () => {
    const f = await setup(), resource = await review(f);
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "review", id: resource.id }, uid());
    const action = { type: "google.reply" as const, version: resource.version, text: "Obrigada pela avaliação." };
    const plan = await prepareChannelAction(ctx, action);
    const id = await enqueueChannelPlan(ctx, plan, action);
    expect(await enqueueChannelPlan(ctx, plan, action)).toBe(id);
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    expect(row.conversation_id).toBeNull();
    // Queda depois da confirmação remota e antes da conclusão local.
    await exec(env, "UPDATE outbox SET status='sent',external_id='confirmed' WHERE id=?", id);
    await recoverChannelDeliveries(env as Env, f.profile);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await one(env, "SELECT reply_text,version FROM reviews WHERE id=?", resource.id)).toEqual({ reply_text: action.text, version: 2 });
    expect(await one(env, "SELECT completion_handled FROM outbox WHERE id=?", id)).toEqual({ completion_handled: 1 });
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("respeita retry futuro e unknown bloqueia a ordem do recurso", async () => {
    const f = await setup(), resource = await review(f);
    const action = { type: "google.reply" as const, version: resource.version, text: "Resposta" };
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "review", id: resource.id }, uid());
    const first = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    const time = now() + 60_000;
    await exec(env, "UPDATE channel_delivery_state SET not_before=? WHERE outbox_id=?", time, first);
    expect(await listReadyChannelDeliveries(env as Env, f.profile, 10)).toEqual([]);
    expect(await nextChannelDeliveryAt(env as Env, f.profile)).toBe(time);
    const nextCtx = { ...ctx, commandId: uid() };
    await enqueueChannelPlan(nextCtx, await prepareChannelAction(nextCtx, action), action);
    await exec(env, "UPDATE outbox SET status='unknown',completion_handled=1 WHERE id=?", first);
    expect(await listReadyChannelDeliveries(env as Env, f.profile, 10)).toEqual([]);
    expect(await nextChannelDeliveryAt(env as Env, f.profile)).toBeNull();
  });
  it("revalida concessão imediatamente antes da publicação", async () => {
    const f = await setup(), resource = await review(f);
    await exec(env, "INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES(?,?,'google.reply',?,?)", f.profile, f.member.id, f.admin.id, now());
    const ctx = await loadChannelOperationContext(env as Env, f.member, f.profile, { kind: "review", id: resource.id }, uid());
    const action = { type: "google.reply" as const, version: resource.version, text: "Resposta" };
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    await exec(env, "DELETE FROM channel_public_grants WHERE profile_id=? AND user_id=?", f.profile, f.member.id);
    await dispatchChannelDelivery(env as Env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!);
    expect((await one(env, "SELECT status FROM outbox WHERE id=?", id)).status).toBe("failed");
    expect((await one(env, "SELECT reply_text FROM reviews WHERE id=?", resource.id)).reply_text).toBe("");
  });
  it("rotas instaladas depois do Worker usam autorização atual", async () => {
    const f = await setup(); await installSyntheticReview(f);
    const token = await bearer(f.admin);
    const response = await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    expect((await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews`, { headers: { Authorization: `Bearer ${token}` } })).ok).toBe(false);
  });
});
