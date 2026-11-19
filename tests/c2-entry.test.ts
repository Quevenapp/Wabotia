/** Composição real, sem mock do main nem do Coordinator.
 * Fixtures do plano; formatos externos a conferir com a conta real. */
import { createExecutionContext, createScheduledController, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Worker, { C2_EXTENSIONS, Coordinator, email, fetch as handleFetch, installC2Worker, scheduled } from "../src/c2-entry/index";
import CoreWorker, { Coordinator as CoreCoordinator } from "../src/index";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Conversation, type Env } from "../src/types";
import { hmac, setSecret } from "../src/security";
import { channelExtension, createChannelExtensionRegistry, registeredChannelExtensions } from "../src/channel-extension-registry";
import { channelAutomationBlock } from "../src/channel-extension-kernel";
import { completeChannelDelivery } from "../src/delivery";
import { dispatchChannelDelivery } from "../src/engine";
import { removePendingConnections } from "../src/connection-removal";
import type { ChannelOutboxRow } from "../src/channel-c2-contracts";
import { bearer, fixture, quietCoordinator } from "./service-center-fixture";
import { measure } from "./d1-counter";
import { C2_UI_EXTENSIONS, installC2Web } from "../web/c2/register";
import { channelCatalogVisible, channelUiFor, getChannelUi } from "../web/channel-extensions";

const profiles = new Set<string>();
let unexpected: string[];
let remote: (url: URL, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  // Alarmes somente quando acionados explicitamente; não dependemos da velocidade do D1.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
  unexpected = [];
  remote = () => { unexpected.push("rede inesperada"); throw new Error("Fronteira externa não prevista."); };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    Promise.resolve(remote(new URL(input instanceof Request ? input.url : String(input)), init)));
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); vi.restoreAllMocks(); expect(unexpected).toEqual([]);
}, 60_000);

type EntryChannel = "instagram" | "facebook" | "telegram" | "googlebusiness" | "email" | "tiktok";
async function setup(channel: EntryChannel) {
  const f = await fixture(); profiles.add(f.profile);
  const integration = uid(), account = channel === "telegram" ? "123456789" : uid().replaceAll("-", "").slice(0, 24);
  const remoteProfile = uid().replaceAll("-", "").slice(0, 24), address = `${f.line}@example.test`, secret = `segredo-${f.line}`;
  const kind = channel === "telegram" ? "telegram_bot" : channel === "email" ? "email" : "zernio";
  await exec(env, "UPDATE connections SET kind=?,channel=?,account_label='Conta de ensaio',config=? WHERE id=?", kind, channel,
    JSON.stringify({ c2_enabled: true, comments_enabled: true, reviews_enabled: true, account_id: channel === "email" ? address : account,
      bot_id: channel === "telegram" ? account : undefined, address: channel === "email" ? address : undefined,
      zernio_workspace_id: kind === "zernio" ? integration : undefined, zernio_profile_id: kind === "zernio" ? remoteProfile : undefined,
      bot_enabled: false, auto_ack_enabled: false, service: { mode: "human", menu_mode: "off" } }), f.line);
  if (kind === "zernio") {
    await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Ensaio',?,'zernio',?,?)",
      integration, f.profile, `zernio:${remoteProfile}`, remoteProfile, now());
    await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintética", webhook_secret: secret });
    await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,'Ensaio',?,?)",
      f.line, f.profile, integration, channel, account, remoteProfile, now(), now());
  } else if (channel === "telegram") {
    await setSecret(env, `connection:${f.line}`, { bot_token: "123456789:synthetic_token_123456789012345678", webhook_secret: secret });
  } else {
    await exec(env, "INSERT INTO email_channel_addresses(connection_id,profile_id,address,active,verified_at,created,updated) VALUES(?,?,?,1,?,?,?)",
      f.line, f.profile, address, now(), now(), now());
  }
  return { ...f, channel, integration, account, remoteProfile, address, secret };
}
type EntryFixture = Awaited<ReturnType<typeof setup>>;
async function request(f: EntryFixture, method: string, path: string, input?: unknown, key = uid()) {
  const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/${path}`, {
    method, headers: { Authorization: `Bearer ${await bearer(f.admin)}`, "Idempotency-Key": key, "Content-Type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  await quietCoordinator(f.profile); return response;
}
function event(f: EntryFixture) {
  const id = uid(), account = { accountId: f.account, platform: f.channel, profileId: f.remoteProfile };
  if (f.channel === "telegram") return { update_id: 1, message: { message_id: 1, date: Math.floor(now() / 1000),
    chat: { id: 901234567, type: "private" }, from: { id: 901234567, is_bot: false, first_name: "Pessoa sintética" }, text: "Olá, informação." } };
  if (f.channel === "googlebusiness") return { id, event: "review.new", account,
    review: { id: `review:${id}`, rating: 4, text: "Atendimento com atenção.", authorName: "Pessoa sintética", publishedAt: now() } };
  if (f.channel === "tiktok") return { id, event: "message.received", account,
    conversation: { id: "thread", participantId: "pessoa-opaca", type: "direct" },
    message: { platformMessageId: id, conversationId: "thread", direction: "incoming", sentAt: now() - 1000,
      text: "Olá, informação.", sender: { id: "pessoa-opaca", name: "Pessoa sintética" }, recipient: { id: f.account }, attachments: [] } };
  return { id, event: "comment.received", account, comment: { id, text: "Olá, informação.",
    author: { id: "autor", name: "Pessoa sintética" }, createdAt: now() - 1000 }, post: { id: "publicacao", text: "Publicação." } };
}
async function webhook(f: EntryFixture, body: unknown, forged = false) {
  const raw = JSON.stringify(body), telegram = f.channel === "telegram";
  const response = await SELF.fetch(`https://test/webhooks/${telegram ? `telegram-bot/${f.line}` : `zernio-accounts/${f.integration}`}`, {
    method: "POST", body: raw, headers: { "Content-Type": "application/json",
      [telegram ? "X-Telegram-Bot-Api-Secret-Token" : "X-Zernio-Signature"]: forged ? "incorreto" : telegram ? f.secret : await hmac(f.secret, raw) },
  });
  await quietCoordinator(f.profile); return response;
}
async function noEffects(f: EntryFixture) {
  for (const table of ["conversations", "messages", "contacts", "reviews", "outbox", "inbox", "media", "bot_runs"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
  expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toEqual([]);
}
function runtimeEmail(f: EntryFixture, headers = "", body = "Olá, informação.") {
  const raw = new TextEncoder().encode(`From: pessoa@example.test\r\nTo: ${f.address}\r\nSubject: Informação\r\nMessage-ID: <entrada@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n${headers}\r\n${body}`);
  return { from: "pessoa@example.test", to: f.address, rawSize: raw.byteLength, headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
    setReject: vi.fn(), forward: vi.fn(async () => { throw new Error("Encaminhamento inesperado."); }),
    reply: vi.fn(async () => { throw new Error("Resposta fora da outbox."); }) } as unknown as ForwardableEmailMessage;
}
async function receiveEmail(message: ForwardableEmailMessage) {
  const ctx = createExecutionContext(); await Worker.email(message, env, ctx); await waitOnExecutionContext(ctx);
}
async function alarm(f: EntryFixture) {
  await quietCoordinator(f.profile);
  await runInDurableObject(env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)), async (instance: CoreCoordinator) => instance.alarm());
  await quietCoordinator(f.profile);
}

describe("c2-entry: composição de produção", () => {
  it("reexporta a mesma classe e handlers; instalação é idempotente, sem I/O e recusa colisão", async () => {
    expect(Worker).toBe(CoreWorker); expect(Coordinator).toBe(CoreCoordinator);
    expect(handleFetch).toBe(CoreWorker.fetch); expect(email).toBe(CoreWorker.email); expect(scheduled).toBe(CoreWorker.scheduled);
    const result = await measure(env as Env, async counted => {
      installC2Worker(); installC2Worker();
      expect(registeredChannelExtensions()).toEqual(C2_EXTENSIONS);
      const registry = createChannelExtensionRegistry();
      for (const descriptor of C2_EXTENSIONS) { registry.registerChannelExtension(descriptor); registry.registerChannelExtension(descriptor); }
      expect(() => registry.registerChannelExtension({ ...C2_EXTENSIONS[0] })).toThrow(/já registrada/);
      expect(registry.registeredChannelExtensions()).toEqual(C2_EXTENSIONS);
      for (const channel of ["whatsapp", "instagram", "facebook"] as const)
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "unused")).toBeNull();
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(result.count).toMatchObject({ calls: 0, statements: 0 });
    installC2Web(); installC2Web();
    for (const descriptor of C2_UI_EXTENSIONS) expect(getChannelUi(descriptor.key)).toBe(descriptor);
    expect(channelCatalogVisible({}, "")).toBe(false);
    for (const channel of ["whatsapp", "instagram", "facebook"]) expect(channelUiFor({ channel, chat_type: "direct" })).toBeUndefined();
  });

  for (const channel of ["instagram", "facebook", "telegram", "googlebusiness", "tiktok"] as const) {
    it(`${channel}: entrada real recusa falsificação, ignora canal desligado e deduplica concorrência`, async () => {
      const f = await setup(channel), body = event(f);
      expect((await webhook(f, body, true)).status).toBe(403); await noEffects(f);
      await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false'),'$.comments_enabled',json('false'),'$.reviews_enabled',json('false')) WHERE id=?", f.line);
      expect((await webhook(f, body)).ok).toBe(true); await noEffects(f);
      await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('true'),'$.comments_enabled',json('true'),'$.reviews_enabled',json('true')) WHERE id=?", f.line);
      const responses = await Promise.all([webhook(f, body), webhook(f, body)]);
      for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
      expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
      expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(channel === "googlebusiness" ? 0 : 1);
      expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(channel === "googlebusiness" ? 0 : 1);
      expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(channel === "googlebusiness" ? 0 : 1);
      expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toHaveLength(channel === "googlebusiness" ? 1 : 0);
      expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
      expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    }, 60_000);
  }

  it("e-mail entra pelo handler, retoma no alarme e cabeçalho falso nunca prova pessoa", async () => {
    const f = await setup("email");
    const forged = await SELF.fetch(`https://test/webhooks/email/${f.line}`, { method: "POST", body: JSON.stringify({ verified: true, channel: "email" }) });
    expect(forged.status).toBe(403); await noEffects(f);
    const headers = "Authentication-Results: forjado.example; dmarc=pass\r\n";
    await Promise.all([receiveEmail(runtimeEmail(f, headers)), receiveEmail(runtimeEmail(f, headers))]);
    await quietCoordinator(f.profile);
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    await alarm(f);
    expect(await one(env, "SELECT state FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual({ state: "processed" });
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    const c = (await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=?", f.profile))!;
    expect(c.verified_phone).toBeNull(); expect(json(c.channel_context).identityTrust).toBe("unverified_sender");
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);

  it("e-mail não usado recusa destinatário; automático não abre atendimento", async () => {
    const f = await setup("email");
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    const unused = runtimeEmail(f); await receiveEmail(unused); expect(unused.setReject).toHaveBeenCalledOnce(); await noEffects(f);
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await env.MEDIA.list({ prefix: `email-raw/${f.profile}/` })).objects).toEqual([]);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('true')) WHERE id=?", f.line);
    await Promise.all([receiveEmail(runtimeEmail(f, "Auto-Submitted: auto-replied\r\n")), receiveEmail(runtimeEmail(f, "Auto-Submitted: auto-replied\r\n"))]);
    await alarm(f); await noEffects(f);
    const receipt = await all(env, "SELECT id,state,attempts FROM email_channel_inbox WHERE profile_id=?", f.profile);
    expect(receipt).toEqual([{ id: expect.any(String), state: "automatic", attempts: 1 }]);
    await receiveEmail(runtimeEmail(f, "Auto-Submitted: auto-replied\r\n"));
    await alarm(f); await noEffects(f);
    expect(await all(env, "SELECT id,state,attempts FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual(receipt);
  }, 60_000);

  it("rotas instaladas consultam área e autorização atuais no replay", async () => {
    const f = await setup("email"), other = await setup("email");
    expect((await request(f, "GET", `c2/connections/${f.line}/setup`)).status).toBe(200);
    expect((await request(f, "GET", `c2/connections/${other.line}/setup`)).status).toBe(404);
    const key = uid(), path = `c2/connections/${f.line}/email-blocks`, body = { kind: "address", value: "bloqueado@example.test" };
    const responses = await Promise.all([request(f, "PUT", path, body, key), request(f, "PUT", path, body, key)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await all(env, "SELECT value FROM email_channel_blocks WHERE profile_id=?", f.profile)).toEqual([{ value: body.value }]);
    await exec(env, "UPDATE users SET role='operator' WHERE id=?", f.admin.id);
    expect((await request(f, "PUT", path, body, key)).status).toBe(403);
  }, 60_000);

  it("scheduled recupera a manutenção registrada após perda do marcador durável", async () => {
    const f = await setup("email");
    await receiveEmail(runtimeEmail(f)); await quietCoordinator(f.profile);
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.delete("c2_pending");
      // Simula a perda do cache junto do marcador; o cron deve descobrir a pendência no D1.
      (instance as unknown as { channelWork?: Record<string, number> }).channelWork = undefined;
    });
    profiles.add("_admin");
    const ctx = createExecutionContext();
    await Worker.scheduled(createScheduledController({ scheduledTime: now(), cron: "* * * * *" }) as unknown as ScheduledEvent, env, ctx);
    await waitOnExecutionContext(ctx);
    // O cron acorda também áreas dos outros casos; não deixamos alarmes nativos pendentes.
    for (const row of await all<{ id: string }>(env, "SELECT id FROM profiles")) profiles.add(row.id);
    const pending = await runInDurableObject(stub, async (_instance, state) => state.storage.get<Record<string, number>>("c2_pending"));
    expect(pending?.["email.inbox"]).toBeTypeOf("number");
    expect(pending!["email.inbox"]).toBeGreaterThan(now());
    // A recuperação respeita nextAt: um alarme precoce não deve reivindicar a entrada.
    await alarm(f);
    expect(await one(env, "SELECT state,attempts FROM email_channel_inbox WHERE profile_id=?", f.profile))
      .toEqual({ state: "pending", attempts: 0 });
    vi.mocked(Date.now).mockReturnValue(pending!["email.inbox"]);
    await alarm(f);
    expect(await one(env, "SELECT state,attempts FROM email_channel_inbox WHERE profile_id=?", f.profile))
      .toEqual({ state: "processed", attempts: 1 });
  }, 60_000);

  it("remoção Telegram mantém pendência e segredo até retomada confirmada", async () => {
    const f = await setup("telegram"); let attempt = 0;
    remote = (url, init) => {
      if (url.origin !== "https://api.telegram.org" || !url.pathname.endsWith("/deleteWebhook") || init?.method !== "POST") {
        unexpected.push("operação inesperada"); throw new Error("Operação não prevista.");
      }
      return ++attempt === 1 ? Response.json({ ok: false, error_code: 503 }, { status: 503 }) : Response.json({ ok: true, result: true });
    };
    const response = await request(f, "DELETE", `connections/${f.line}`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ pending: true, deleted: false });
    expect(await one(env, "SELECT status FROM connections WHERE id=?", f.line)).toEqual({ status: "paused" });
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `connection:${f.line}`)).not.toBeNull();
    await removePendingConnections(env);
    expect(attempt).toBe(2); expect(await one(env, "SELECT id FROM connections WHERE id=?", f.line)).toBeNull();
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `connection:${f.line}`)).toBeNull();
    expect(channelExtension("telegram/direct")).toBe(C2_EXTENSIONS.find(e => e.key === "telegram/direct"));
  }, 60_000);
});
