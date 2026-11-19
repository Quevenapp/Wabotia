/** Fixtures sintéticas: formato do plano; a conferir com a conta real.
 * Worker, Coordinator, identidade, D1 e outbox reais; somente HTTP externo é simulado. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Conversation, type Env } from "../src/types";
import { secret, setSecret, sha } from "../src/security";
import { telegramConnectionDriver, telegramExtension } from "../src/c2/telegram";
import { createChannelExtensionRegistry, extensionKey } from "../src/channel-extension-registry";
import { channelAutomationBlock, loadChannelOperationContext, prepareChannelAction, signVerifiedIngress } from "../src/channel-extension-kernel";
import { completeChannelDelivery } from "../src/delivery";
import { dispatchChannelDelivery, enqueueChannelPlan, listReadyChannelDeliveries } from "../src/engine";
import { resolveChannelCustomer } from "../src/customer/channel-identity";
import { createPiiMask } from "../src/pii-mask";
import { removeConnection, removePendingConnections } from "../src/connection-removal";
import type { ChannelConnectionContext, ChannelDeliveryPlan, ChannelOperationContext, ChannelOutboxRow, ExtensionConnection } from "../src/channel-c2-contracts";
import { assertNoChannelEffects, bearer, c2Fixture, c2Request, c2TelegramWebhook, coordinatorTicket,
  installTestExtension, measure, quietCoordinator, type C2Fixture } from "./c2-fixtures";

const SUBJECT = 901234567;
let BOT_ID: string, TOKEN: string;
const profiles = new Set<string>();
type RemoteCall = { method: string; body: Record<string, unknown> };
let calls: RemoteCall[], unexpected: string[];
let remote: (call: RemoteCall) => Response | Promise<Response>;
let privateFilePath: string | null;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const ok = (result: unknown = true) => Response.json({ ok: true, result });
beforeEach(() => {
  // O D1 conserva rate_limits entre casos. Cada caso representa um bot distinto,
  // inclusive quando outro caso avançou o relógio para testar retry_after.
  // Dentro do mesmo caso, as conexões compartilham o bot e seu limite real.
  BOT_ID = String(1_000_000_000 + Number.parseInt(uid().replaceAll("-", "").slice(0, 12), 16));
  TOKEN = `${BOT_ID}:synthetic_telegram_secret_1234567890`;
  calls = []; unexpected = []; privateFilePath = null;
  remote = () => { unexpected.push("chamada externa inesperada"); throw new Error("Rede não prevista pela fixture."); };
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://api.telegram.org" && privateFilePath && url.pathname === `/file/bot${TOKEN}/${privateFilePath}`) {
      const call = { method: "download", body: {} }; calls.push(call); return remote(call);
    }
    if (url.origin !== "https://api.telegram.org" || !url.pathname.startsWith(`/bot${TOKEN}/`)) {
      unexpected.push("destino externo inesperado"); throw new Error("Destino não previsto pela fixture.");
    }
    const method = url.pathname.split("/").at(-1)!;
    const call = { method, body: typeof init?.body === "string" ? JSON.parse(init.body) : {} };
    calls.push(call);
    return remote(call);
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); fetchSpy.mockRestore(); vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
}, 60_000);
async function setup(): Promise<C2Fixture> {
  const f = await c2Fixture("telegram"); profiles.add(f.profile);
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://telegram.example.test',?)", now());
  await exec(env, "UPDATE connections SET config=json_set(config,'$.bot_id',?,'$.account_id',?,'$.username','sintetico_bot') WHERE id=?", BOT_ID, BOT_ID, f.line);
  await setSecret(env, `connection:${f.line}`, { bot_token: TOKEN, webhook_secret: f.webhookSecret });
  const result = { ...f, account: BOT_ID };
  await installTestExtension(result, telegramExtension);
  return result;
}
function update(id = 1, text = "Olá, preciso de atendimento.", extra: Record<string, unknown> = {}) {
  return { update_id: id, message: { message_id: id, date: Math.floor(now() / 1000),
    chat: { id: SUBJECT, type: "private" }, from: { id: SUBJECT, is_bot: false, first_name: "Pessoa sintética", username: "pessoa_sintetica" }, text, ...extra } };
}
async function conversation(f: C2Fixture): Promise<Conversation> {
  const row = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND connection_id=?", f.profile, f.line);
  expect(row).not.toBeNull(); return row!;
}
async function receive(f: C2Fixture) {
  const response = await c2TelegramWebhook(f, update());
  expect(response.status, await response.clone().text()).toBe(202);
  return conversation(f);
}
async function humanContext(f: C2Fixture, id: string, commandId = uid()): Promise<ChannelOperationContext> {
  await exec(env, "UPDATE conversations SET owner=?,state='human' WHERE id=? AND profile_id=?", f.admin.id, id, f.profile);
  return loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "conversation", id }, commandId);
}
async function connectionContext(f: C2Fixture, input: unknown = {}): Promise<ChannelConnectionContext> {
  const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", f.line, f.profile))!;
  return { env: env as Env, actor: f.admin, profileId: f.profile, connection, input, commandId: uid(), now: now() };
}
async function enqueue(f: C2Fixture, ctx: ChannelOperationContext, action: Parameters<typeof prepareChannelAction>[1], plan?: ChannelDeliveryPlan) {
  const prepared = plan ?? await prepareChannelAction(ctx, action);
  const id = await enqueueChannelPlan(ctx, prepared, action as Parameters<typeof enqueueChannelPlan>[2]);
  await quietCoordinator(f.profile);
  return (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
}
async function expectNoPublicSecrets(f: C2Fixture, values: unknown[] = []) {
  const outputs: unknown[] = [...values];
  for (const table of ["connections", "conversations", "contacts", "customer_channel_ids", "messages", "inbox", "outbox", "events", "audit", "media", "channel_delivery_state"])
    outputs.push(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile));
  outputs.push(await all(env, "SELECT payload FROM channel_events WHERE connection_id=?", f.line));
  outputs.push(await all(env, "SELECT response FROM receipts WHERE scope LIKE ?", `%${f.profile}%`));
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toContain(TOKEN); expect(serialized).not.toContain(f.webhookSecret);
  for (const call of calls) if (call.method === "setWebhook" && typeof call.body.secret_token === "string")
    expect(serialized).not.toContain(call.body.secret_token);
  expect(serialized).not.toMatch(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot/);
}

describe("Telegram próprio: instalação e autenticidade", () => {
  it("instala sem I/O e canal não usado acrescenta zero consultas aos canais antigos", async () => {
    const result = await measure(env as Env, async counted => {
      const registry = createChannelExtensionRegistry();
      registry.registerChannelExtension(telegramExtension); registry.registerChannelExtension(telegramExtension);
      expect(registry.channelConnectionDriver("telegram")).toBe(telegramConnectionDriver);
      for (const channel of ["whatsapp", "instagram", "facebook"] as const) {
        expect(extensionKey(channel)).toBeNull();
        expect(telegramExtension.enabled?.({ id: "legacy", profile_id: "area", kind: "zernio", channel, config: "{}" })).toBe(false);
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "legacy")).toBeNull();
      }
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(result.count).toMatchObject({ calls: 0, statements: 0 }); expect(calls).toEqual([]);
  }, 60_000);
  it("recusa segredo ausente/incorreto antes do parse, download e qualquer efeito", async () => {
    const f = await setup();
    for (const value of [undefined, "segredo-incorreto"]) {
      const response = await c2Request(`/webhooks/telegram-bot/${f.line}`, { method: "POST",
        headers: value ? { "X-Telegram-Bot-Api-Secret-Token": value } : {}, body: "{json inválido" });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TOKEN);
    }
    await assertNoChannelEffects(f.profile); expect(calls).toEqual([]);
  }, 60_000);
  it("recusa objeto de prova fabricado e ticket dirigido a outra área", async () => {
    const f = await setup(), other = await setup();
    const scope = { profileId: f.profile, connectionId: f.line, channel: "telegram" as const, context: "direct" as const,
      accountId: f.account, source: "telegram_secret" as const };
    await expect(telegramExtension.normalize(update(), scope)).rejects.toMatchObject({ code: "invalid_channel_evidence" });
    const ticket = await coordinatorTicket(f, update());
    const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(other.profile)).fetch("https://coordinator/c2-inbound", {
      method: "POST", body: JSON.stringify({ profile: other.profile, ticket }),
    });
    expect(response.status).toBe(403);
    await assertNoChannelEffects(f.profile); await assertNoChannelEffects(other.profile);
    const crossed = await signVerifiedIngress(env as Env, { ...scope, profileId: other.profile }, update());
    const mismatch = await env.COORDINATOR.get(env.COORDINATOR.idFromName(other.profile)).fetch("https://coordinator/c2-inbound", {
      method: "POST", body: JSON.stringify({ profile: other.profile, ticket: crossed }),
    });
    expect(await mismatch.json()).toMatchObject({ ignored: true });
    await assertNoChannelEffects(other.profile); expect(calls).toEqual([]);
  }, 60_000);
  it("ignora conexão pausada explicitamente antes de ler o corpo", async () => {
    const f = await setup();
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", f.line);
    const response = await c2Request(`/webhooks/telegram-bot/${f.line}`, { method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": f.webhookSecret }, body: "{não deve ser interpretado" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true, reason: "channel_not_ready" });
    await assertNoChannelEffects(f.profile); expect(calls).toEqual([]);
  }, 60_000);
});

describe("Telegram próprio: entrada e identidade", () => {
  it("deduplica duas invocações concorrentes e a repetição sem duas mensagens ou fichas", async () => {
    const f = await setup(), event = update();
    const responses = await Promise.all([c2TelegramWebhook(f, event), c2TelegramWebhook(f, event)]);
    expect(responses.map(row => row.status)).toEqual([202, 202]);
    expect((await c2TelegramWebhook(f, event)).status).toBe(202);
    const c = await conversation(f);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='customer'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
    expect(c.channel_subject_id).toBe(String(SUBJECT));
    const customer = await resolveChannelCustomer(env as Env, c);
    expect(customer).toMatchObject({ verifiedPhone: null, identityTrust: "channel",
      verifiedChannel: { subjectNamespace: "telegram-user", subjectId: String(SUBJECT) } });
    expect((await one(env, "SELECT phone FROM contacts WHERE profile_id=?", f.profile)).phone).toBe("");
    expect(calls).toEqual([]);
  }, 60_000);
  it("edição altera o balão existente sem criar inbox ou executar o bot novamente", async () => {
    const f = await setup(), c = await receive(f);
    const original = (await one(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='customer'", c.id)).id;
    const edited = { update_id: 2, edited_message: { ...update().message, text: "Texto corrigido com atenção.", edit_date: Math.floor(now() / 1000) + 1 } };
    expect((await c2TelegramWebhook(f, edited)).status).toBe(202);
    expect((await c2TelegramWebhook(f, edited)).status).toBe(202);
    expect(await all(env, "SELECT id,text FROM messages WHERE conversation_id=? AND direction='customer'", c.id))
      .toEqual([{ id: original, text: "Texto corrigido com atenção." }]);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);
  it("deduplica mídia antes do download privado e recusa evento forjado sem criar objeto", async () => {
    const f = await setup(), bytes = new TextEncoder().encode("Documento sintético com acentuação.");
    const event = update(1, "Legenda preservada", { document: { file_id: "arquivo-sintetico", file_size: bytes.byteLength,
      mime_type: "text/plain", file_name: "documento.txt" } });
    expect((await c2TelegramWebhook(f, event, "incorreto")).status).toBe(403);
    await assertNoChannelEffects(f.profile); expect(calls).toEqual([]);
    expect((await env.MEDIA.list({ prefix: `${f.profile}/` })).objects).toEqual([]);
    privateFilePath = "documents/synthetic.txt";
    remote = call => {
      if (call.method === "getFile") return ok({ file_path: privateFilePath, file_size: bytes.byteLength });
      if (call.method === "download") return new Response(bytes, { headers: { "Content-Type": "text/plain", "Content-Length": String(bytes.byteLength) } });
      unexpected.push("operação não prevista"); throw new Error("Operação não prevista.");
    };
    const responses = await Promise.all([c2TelegramWebhook(f, event), c2TelegramWebhook(f, event)]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect((await c2TelegramWebhook(f, event)).status).toBe(202);
    expect(calls.map(call => call.method)).toEqual(["getFile", "download"]);
    const media = await all<{ id: string; object_key: string; size: number }>(env, "SELECT id,object_key,size FROM media WHERE profile_id=?", f.profile);
    expect(media).toHaveLength(1); expect(media[0].size).toBe(bytes.byteLength);
    expect((await env.MEDIA.list({ prefix: `${f.profile}/` })).objects).toHaveLength(1);
    const stored = await env.MEDIA.get(media[0].object_key);
    expect(await stored!.text()).toBe(new TextDecoder().decode(bytes));
    const messages = await all(env, "SELECT text,attachments FROM messages WHERE profile_id=? AND direction='customer'", f.profile);
    expect(messages).toEqual([{ text: "Legenda preservada", attachments: JSON.stringify([media[0].id]) }]);
    await expectNoPublicSecrets(f);
  }, 60_000);
  it("grupo e business_connection não abrem conversa nem copiam conteúdo para avisos", async () => {
    const f = await setup();
    const group = update(11, "Conteúdo privado de grupo que não pode ser copiado", { chat: { id: -100001, type: "supergroup" } });
    await c2TelegramWebhook(f, group);
    const notices = await all(env, "SELECT kind,payload FROM events WHERE profile_id=?", f.profile);
    expect(notices.length).toBeGreaterThan(0);
    await c2TelegramWebhook(f, group);
    expect(await all(env, "SELECT kind,payload FROM events WHERE profile_id=?", f.profile)).toEqual(notices);
    await c2TelegramWebhook(f, { update_id: 12, business_connection: { id: "não-suportado", user: { id: SUBJECT } } });
    for (const table of ["messages", "contacts", "conversations", "inbox", "outbox", "media"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile)).toEqual([]);
    const outputs = JSON.stringify(await all(env, "SELECT * FROM events WHERE profile_id=?", f.profile));
    expect(outputs).not.toContain("Conteúdo privado de grupo"); expect(calls).toEqual([]);
  }, 60_000);
  it("bloqueio privado impede envio e aparece na projeção sem bloquear outros clientes", async () => {
    const f = await setup(), c = await receive(f);
    await c2TelegramWebhook(f, { update_id: 3, my_chat_member: { date: Math.floor(now() / 1000),
      chat: { id: SUBJECT, type: "private" }, from: { id: SUBJECT, is_bot: false },
      old_chat_member: { status: "member", user: { id: Number(BOT_ID), is_bot: true } },
      new_chat_member: { status: "kicked", user: { id: Number(BOT_ID), is_bot: true } } } });
    const ctx = await humanContext(f, c.id);
    expect((await telegramExtension.view!(ctx)).metadata.telegram?.blocked).toBe(true);
    await expect(telegramExtension.prepareSend(ctx, { type: "message.send", text: "Não enviar" })).rejects.toMatchObject({ code: "bot_blocked" });
    expect((await one(env, "SELECT status FROM connections WHERE id=?", f.line)).status).toBe("active");
    expect(calls).toEqual([]);
  }, 60_000);
});

describe("Telegram próprio: conexão e segredos", () => {
  it("getMe e setWebhook conservam somente configuração pública e projeção configurado", async () => {
    const f = await setup();
    remote = call => call.method === "getMe" ? ok({ id: Number(BOT_ID), is_bot: true, username: "sintetico_bot" })
      : call.method === "setWebhook" ? ok() : (() => { unexpected.push("operação não prevista"); throw new Error("Operação não prevista"); })();
    const configured = await telegramConnectionDriver.configure(await connectionContext(f, { bot_token: TOKEN, origin: "https://telegram.example.test" }));
    expect(configured).toMatchObject({ status: "active", configured: true });
    const webhook = calls.find(call => call.method === "setWebhook")!;
    expect(webhook.body.allowed_updates).toEqual(["message", "edited_message", "callback_query", "my_chat_member"]);
    expect(webhook.body.url).toBe(`https://telegram.example.test/webhooks/telegram-bot/${f.line}`);
    expect(typeof webhook.body.secret_token).toBe("string");
    expect(JSON.stringify(configured)).not.toContain(TOKEN);
    expect(JSON.stringify(configured)).not.toContain(String(webhook.body.secret_token));
    expect((await secret(env as Env, `connection:${f.line}`)).bot_token).toBe(TOKEN);
    const token = await bearer(f.admin);
    const response = await c2Request(`/api/v1/profiles/${f.profile}/c2/connections/${f.line}/setup`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ configured: true, credential: "configurado" });
  }, 60_000);
  it("troca para outro bot é recusada antes de registrar webhook ou substituir o cofre", async () => {
    const f = await setup();
    remote = call => {
      if (call.method !== "getMe") { unexpected.push("operação não prevista"); throw new Error("Operação não prevista"); }
      return ok({ id: 999999, is_bot: true, username: "outro_bot" });
    };
    const ctx = await connectionContext(f, { bot_token: TOKEN, origin: "https://telegram.example.test" });
    const result = await telegramConnectionDriver.configure(ctx).catch(error => ({ code: error.code, status: "paused" }));
    expect(result.status).not.toBe("active"); expect(result.code).toMatch(/^[a-z_]+$/);
    expect(calls.map(call => call.method)).toEqual(["getMe"]);
    expect((await secret(env as Env, `connection:${f.line}`)).webhook_secret).toBe(f.webhookSecret);
  }, 60_000);
  it("falha remota de configuração permanece pendente sem expor corpo, URL ou credencial", async () => {
    const f = await setup();
    const logs: unknown[] = [];
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    remote = call => call.method === "getMe" ? ok({ id: Number(BOT_ID), is_bot: true, username: "sintetico_bot" })
      : Response.json({ ok: false, error_code: 500, description: `https://api.telegram.org/bot${TOKEN}/setWebhook` }, { status: 500 });
    const result = await telegramConnectionDriver.configure(await connectionContext(f, { bot_token: TOKEN }));
    expect(result.status).not.toBe("active");
    await expectNoPublicSecrets(f, [result, logs]);
  }, 60_000);
  it("remoção falha pausada e retoma a limpeza preservando histórico e segredo até confirmação", async () => {
    const f = await setup(), c = await receive(f); let fail = true;
    remote = call => {
      if (call.method !== "deleteWebhook") { unexpected.push("operação não prevista"); throw new Error("Operação não prevista"); }
      return fail ? Response.json({ ok: false, error_code: 500, description: `erro remoto ${TOKEN}` }, { status: 500 }) : ok();
    };
    expect(await removeConnection(env as Env, f.admin, f.profile, f.line)).toMatchObject({ deleted: false, pending: true });
    expect((await one(env, "SELECT status FROM connections WHERE id=?", f.line)).status).toBe("paused");
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `connection:${f.line}`)).not.toBeNull();
    expect((await c2TelegramWebhook(f, update(15))).status).toBe(200);
    fail = false; await removePendingConnections(env as Env, f.profile);
    expect(await one(env, "SELECT id FROM connections WHERE id=?", f.line)).toBeNull();
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `connection:${f.line}`)).toBeNull();
    expect((await one(env, "SELECT connection_id FROM conversations WHERE id=?", c.id)).connection_id).toBeNull();
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='customer'", c.id)).toHaveLength(1);
  }, 60_000);
});

describe("Telegram próprio: outbox, callbacks e telefone", () => {
  it("divide texto em entregas ordenadas, sem parse_mode arbitrário", async () => {
    const f = await setup(), c = await receive(f), ctx = await humanContext(f, c.id);
    const text = "<b>Atendimento & informação</b> ".repeat(350);
    const plan = await telegramExtension.prepareSend(ctx, { type: "message.send", text });
    expect(plan.orderKey).toBe(`conversation:${c.id}`); expect(plan.deliveries.length).toBeGreaterThan(1);
    const bodies = plan.deliveries.map(item => item.payload.body as Record<string, unknown>);
    expect(bodies.every(body => typeof body.text === "string" && body.text.length <= 4096)).toBe(true);
    expect(bodies.map(body => body.text).join("")).toBe(text);
    expect(bodies.every(body => body.parse_mode === undefined)).toBe(true);
    expect(new Set(plan.deliveries.map(item => item.key)).size).toBe(plan.deliveries.length);
  }, 60_000);
  it("429 confirmado respeita retry_after e timeout de envio fica indeterminado sem replay remoto", async () => {
    const f = await setup(), c = await receive(f), ctx = await humanContext(f, c.id);
    const row = await enqueue(f, ctx, { type: "message.send", text: "Resposta humana" });
    remote = call => {
      expect(call.method).toBe("sendMessage");
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 }, description: `não publicar ${TOKEN}` }, { status: 429 });
    };
    const before = now(), clock = vi.spyOn(Date, "now").mockReturnValue(before);
    await dispatchChannelDelivery(env as Env, row);
    const retry = await one(env, "SELECT o.status,o.error,s.not_before FROM outbox o JOIN channel_delivery_state s ON s.outbox_id=o.id WHERE o.id=?", row.id);
    expect(retry).toMatchObject({ status: "pending", error: "rate_limited" });
    expect(retry.not_before).toBeGreaterThanOrEqual(before + 120_000);
    expect(await listReadyChannelDeliveries(env as Env, f.profile)).toEqual([]);
    await dispatchChannelDelivery(env as Env, row); expect(calls).toHaveLength(1);
    // Avança o relógio, conservando a reserva e o retry_after persistidos.
    clock.mockReturnValue(before + 121_000);
    remote = () => { throw new Error(`timeout remoto https://api.telegram.org/bot${TOKEN}/sendMessage`); };
    await dispatchChannelDelivery(env as Env, row);
    const unknown = await one(env, "SELECT status,error,completion_handled FROM outbox WHERE id=?", row.id);
    expect(unknown).toMatchObject({ status: "unknown", completion_handled: 1 });
    expect(unknown.error).not.toContain(TOKEN);
    const count = calls.length; await dispatchChannelDelivery(env as Env, row); expect(calls).toHaveLength(count);
    const outputs = JSON.stringify(await all(env, "SELECT payload,error FROM outbox WHERE profile_id=?", f.profile));
    expect(outputs).not.toContain(TOKEN); expect(outputs).not.toContain("api.telegram.org");
    await expectNoPublicSecrets(f, [retry, unknown]);
    clock.mockRestore();
  }, 60_000);
  it("o ritmo local preserva a ordem e limita a conversa a uma mensagem por segundo", async () => {
    const f = await setup(), c = await receive(f);
    const at = now(), clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const first = await enqueue(f, await humanContext(f, c.id), { type: "message.send", text: "Primeira" });
    const second = await enqueue(f, await humanContext(f, c.id), { type: "message.send", text: "Segunda" });
    remote = call => {
      expect(call.method).toBe("sendMessage");
      return ok({ message_id: 1000 + calls.length, chat: { id: SUBJECT, type: "private" } });
    };
    await dispatchChannelDelivery(env as Env, second); expect(calls).toHaveLength(0);
    await dispatchChannelDelivery(env as Env, first); expect(calls).toHaveLength(1);
    await dispatchChannelDelivery(env as Env, second); expect(calls).toHaveLength(1);
    const deferred = await one(env, "SELECT o.status,o.error,s.not_before FROM outbox o JOIN channel_delivery_state s ON s.outbox_id=o.id WHERE o.id=?", second.id);
    expect(deferred).toMatchObject({ status: "pending", error: "rate_limited" });
    expect(deferred.not_before).toBeGreaterThanOrEqual(at + 1000);
    clock.mockReturnValue(at + 1001);
    await dispatchChannelDelivery(env as Env, second);
    // O caminho real de envio acrescenta a assinatura humana antes de enfileirar.
    expect(calls.map(call => call.body.text)).toEqual([
      `${f.admin.name} - Humano\nPrimeira`,
      `${f.admin.name} - Humano\nSegunda`,
    ]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", c.id)).toHaveLength(2);
    clock.mockRestore();
  }, 60_000);
  it("o limite do mesmo bot é compartilhado entre conexões de áreas diferentes", async () => {
    const firstFixture = await setup(), secondFixture = await setup();
    const firstConversation = await receive(firstFixture), secondConversation = await receive(secondFixture);
    const at = now(), clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const first = await enqueue(firstFixture, await humanContext(firstFixture, firstConversation.id), { type: "message.send", text: "Primeira área" });
    const second = await enqueue(secondFixture, await humanContext(secondFixture, secondConversation.id), { type: "message.send", text: "Segunda área" });
    remote = call => {
      expect(call.method).toBe("sendMessage");
      return ok({ message_id: 2000 + calls.length });
    };
    await dispatchChannelDelivery(env as Env, first);
    expect(calls).toHaveLength(1);
    expect(await one(env, "SELECT expires FROM rate_limits WHERE key=?", `telegram:bot:${BOT_ID}`))
      .toMatchObject({ expires: at + 34 });
    await dispatchChannelDelivery(env as Env, second);
    expect(calls).toHaveLength(1);
    expect(await one(env, "SELECT o.status,o.error,s.not_before,s.attempted_at FROM outbox o JOIN channel_delivery_state s ON s.outbox_id=o.id WHERE o.id=?", second.id))
      .toMatchObject({ status: "pending", error: "rate_limited", not_before: at + 34, attempted_at: null });
    // A conversa que aguardou o bot também conserva seu próprio intervalo.
    clock.mockReturnValue(at + 1000);
    await dispatchChannelDelivery(env as Env, second);
    expect(calls.map(call => call.body.text)).toEqual([
      `${firstFixture.admin.name} - Humano\nPrimeira área`,
      `${secondFixture.admin.name} - Humano\nSegunda área`,
    ]);
    expect(await one(env, "SELECT status,completion_handled FROM outbox WHERE id=?", second.id))
      .toMatchObject({ status: "sent", completion_handled: 1 });
    clock.mockRestore();
  }, 60_000);
  it("403 confirmado encerra a entrega e bloqueia envios seguintes da conversa", async () => {
    const f = await setup(), c = await receive(f);
    const row = await enqueue(f, await humanContext(f, c.id), { type: "message.send", text: "Resposta humana" });
    remote = call => {
      expect(call.method).toBe("sendMessage");
      return Response.json({ ok: false, error_code: 403, description: `detalhe remoto privado ${TOKEN}` }, { status: 403 });
    };
    await dispatchChannelDelivery(env as Env, row);
    expect(await one(env, "SELECT status,error,completion_handled FROM outbox WHERE id=?", row.id))
      .toMatchObject({ status: "failed", error: "bot_blocked", completion_handled: 1 });
    const ctx = await humanContext(f, c.id);
    expect((await telegramExtension.view!(ctx)).metadata.telegram?.blocked).toBe(true);
    await expect(telegramExtension.prepareSend(ctx, { type: "message.send", text: "Outra resposta" })).rejects.toMatchObject({ code: "bot_blocked" });
    expect(calls).toHaveLength(1); await expectNoPublicSecrets(f);
  }, 60_000);
  it("menus paginados reservam callbacks curtos no lote e ack ocorre também em replay e expiração", async () => {
    const f = await setup(), c = await receive(f), menu = `${c.session}.sintetico`;
    const items = Array.from({ length: 18 }, (_, index) => ({ id: `opcao-${index}`, title: `Opção ${index + 1}` }));
    await exec(env, "UPDATE conversations SET menu_token=?,menu_active=1,menu_expires_at=?,menu_items=? WHERE id=?", menu, now() + 600_000, JSON.stringify(items.map(item => item.id)), c.id);
    const ctx = await humanContext(f, c.id);
    const plan = await telegramExtension.prepareMenu!(ctx, { token: menu, title: "Escolha uma opção", items, expiresAt: now() + 600_000 });
    expect(plan.deliveries.length).toBeGreaterThan(1);
    const buttons = plan.deliveries.flatMap(item => {
      const body = item.payload.body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
      return body.reply_markup.inline_keyboard.flat();
    });
    expect(buttons).toHaveLength(items.length);
    for (const button of buttons) {
      expect(new TextEncoder().encode(button.callback_data).byteLength).toBeLessThanOrEqual(64);
      expect(button.callback_data).not.toContain(menu); expect(button.callback_data).not.toContain(String(SUBJECT));
    }
    await enqueue(f, ctx, { type: "message.send", text: "Escolha uma opção" }, plan);
    expect(await all(env, "SELECT token_hash FROM telegram_callbacks WHERE connection_id=?", f.line)).toHaveLength(items.length);
    remote = call => { expect(call.method).toBe("answerCallbackQuery"); return ok(); };
    const callback = (id: number, query: string, data: string) => ({ update_id: id, callback_query: { id: query,
      from: { id: SUBJECT, is_bot: false }, data, message: { message_id: 700, chat: { id: SUBJECT, type: "private" } } } });
    await exec(env, "UPDATE telegram_callbacks SET expires=0 WHERE token_hash=?", await sha(buttons[1].callback_data));
    expect((await c2TelegramWebhook(f, callback(19, "query-vencida", buttons[1].callback_data))).status).toBe(202);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await one(env, "SELECT used_query_id FROM telegram_callbacks WHERE token_hash=?", await sha(buttons[1].callback_data))).used_query_id).toBeNull();
    const chosen = callback(20, "query-primeira", buttons[0].callback_data);
    const responses = await Promise.all([c2TelegramWebhook(f, chosen), c2TelegramWebhook(f, chosen)]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect((await c2TelegramWebhook(f, callback(21, "query-outra-opcao", buttons[2].callback_data))).status).toBe(202);
    const used = await one(env, "SELECT used_query_id,used_at FROM telegram_callbacks WHERE token_hash=?", await sha(buttons[0].callback_data));
    expect(used.used_query_id).toBe("query-primeira"); expect(used.used_at).not.toBeNull();
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(4);
  }, 60_000);
  it("telefone próprio só sugere junção após pedido enviado e não produz prova telefônica", async () => {
    const f = await setup(), c = await receive(f), ctx = await humanContext(f, c.id);
    const own = { phone_number: "+5511999998888", first_name: "Pessoa sintética", user_id: SUBJECT };
    await c2TelegramWebhook(f, update(2, "", { contact: own }));
    expect((await telegramExtension.view!(await humanContext(f, c.id))).metadata.telegram?.phoneSuggestion).toBeUndefined();
    const row = await enqueue(f, ctx, { type: "telegram.request-contact" });
    await c2TelegramWebhook(f, update(3, "", { contact: own }));
    expect((await telegramExtension.view!(await humanContext(f, c.id))).metadata.telegram?.phoneSuggestion).toBeUndefined();
    remote = call => { expect(call.method).toBe("sendMessage"); return ok({ message_id: 400, chat: { id: SUBJECT, type: "private" } }); };
    await dispatchChannelDelivery(env as Env, row);
    const contactButton = calls[0].body.reply_markup as { keyboard: { request_contact?: boolean }[][] };
    expect(contactButton.keyboard.flat().some(button => button.request_contact === true)).toBe(true);
    await c2TelegramWebhook(f, update(2, "", { contact: own }));
    expect((await telegramExtension.view!(await humanContext(f, c.id))).metadata.telegram?.phoneSuggestion).toBeUndefined();
    // Chegou depois, mas o ID remoto prova que o contato precede o pedido.
    await c2TelegramWebhook(f, update(4, "", { message_id: 399, contact: own, date: Math.floor(now() / 1000) + 1 }));
    expect((await telegramExtension.view!(await humanContext(f, c.id))).metadata.telegram?.phoneSuggestion).toBeUndefined();
    await c2TelegramWebhook(f, update(5, "", { message_id: 401, contact: { ...own, user_id: SUBJECT + 1 }, date: Math.floor(now() / 1000) + 2 }));
    expect((await telegramExtension.view!(await humanContext(f, c.id))).metadata.telegram?.phoneSuggestion).toBeUndefined();
    await c2TelegramWebhook(f, update(6, "", { message_id: 402, contact: own, date: Math.floor(now() / 1000) + 3 }));
    const refreshed = await conversation(f);
    const view = await telegramExtension.view!(await humanContext(f, c.id));
    expect(view.metadata.telegram?.phoneSuggestion).toMatchObject({ confirmedByHuman: false });
    expect(view.metadata.telegram?.phoneSuggestion?.masked).not.toContain("999998888");
    expect(await resolveChannelCustomer(env as Env, refreshed)).toMatchObject({ verifiedPhone: null });
    expect((await one(env, "SELECT phone,merged_into FROM contacts WHERE profile_id=?", f.profile))).toMatchObject({ phone: "", merged_into: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    const shared = await one(env, "SELECT content FROM messages WHERE profile_id=? AND external_id=?", f.profile, `${SUBJECT}:402`);
    const content = JSON.parse(shared.content);
    expect(content.telegram.contact).toMatchObject({ subject_id: own.phone_number, eligible: true, confirmedByHuman: false, requestId: ctx.commandId });
    const mask = createPiiMask();
    expect(JSON.stringify(mask.maskValue(content))).not.toContain(own.phone_number);
    expect(JSON.stringify(mask.maskValue({ telegram: { contact: { subject_id: "+442071838750" } } }))).not.toContain("442071838750");
  }, 60_000);
});
