import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Conversation, type Env } from "../src/types";
import type { ChannelExtension } from "../src/channel-c2-contracts";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import { assertVerifiedIngress, channelAutomationBlock, parseChannelAction } from "../src/channel-extension-kernel";
import { prepareChannelInbound, resolveChannelCustomer } from "../src/customer/channel-identity";
import { sha } from "../src/security";
import { assertNoChannelEffects, c2Fixture, c2TelegramWebhook, denyNetwork,
  installTestExtension, measure, quietCoordinator } from "./c2-fixtures";

/** Fixtures do contrato de projeção Android. Formato do plano; a conferir com a conta real.
 * Só o descritor é simulado: Worker, segredo, Coordinator, D1 e identidade são os reais. */
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function conversation(id: string, profile: string, connection: string, account: string, subject: string): Conversation {
  return { id, profile_id: profile, connection_id: connection, channel: "telegram", account_label: "Conta sintética",
    channel_account_id: account, channel_subject_id: subject, channel_context: '{"version":1,"context":"direct"}',
    external_namespace: `channel:${connection}`, external_id: `telegram:${subject}`, phone: null, customer_link_state: "pending",
    chat_type: "direct", title: "Pessoa sintética", bot_policy: "mentions", state: "human", owner: null,
    epoch: 1, session: id, topic: null, tags: "[]", last_customer: 0, created: now(), updated: now() };
}

const androidTelegram: ChannelExtension = {
  ...CHANNEL_EXTENSION_STUBS["telegram/direct"],
  spec: { ...CHANNEL_EXTENSION_STUBS["telegram/direct"].spec, enabled: true,
    contexts: { direct: { enabled: true, bot: false, publicReply: false } }, text: { enabled: true, maxChars: 4096 } },
  enabled: connection => json(connection.config).c2_enabled === true,
  async normalize(input, scope) {
    assertVerifiedIngress(scope);
    const body = object(input), message = object(body.message), chat = object(message.chat), from = object(message.from);
    if (scope.channel !== "telegram" || scope.context !== "direct" || chat.type !== "private" ||
        !Number.isSafeInteger(body.update_id) || !Number.isSafeInteger(message.message_id) || typeof from.id !== "string") return null;
    return { key: `update:${body.update_id}`, kind: "message.received", occurredAt: typeof message.date === "number" ? message.date : null,
      subjectId: from.id, subjectNamespace: "telegram-user", remoteId: `${String(chat.id)}:${message.message_id}`,
      context: { context: "direct" }, content: { text: typeof message.text === "string" ? message.text : "" } };
  },
  async prepareInbound(ctx, event) {
    const subject = event.subjectId!;
    const id = `android-conversation:${await sha(`${ctx.connection.id}:${subject}`)}`;
    const messageId = `android-message:${await sha(`${ctx.connection.id}:${event.remoteId}`)}`;
    const c = await one<Conversation>(ctx.env, "SELECT * FROM conversations WHERE id=?", id)
      ?? conversation(id, ctx.authorization.profileId, ctx.connection.id, ctx.ingress!.accountId, subject);
    const identity = await prepareChannelInbound(ctx.env, c, { channel: "telegram", provider: "telegram_bot",
      accountId: ctx.ingress!.accountId, subjectId: subject, subjectNamespace: "telegram-user", displayName: "Pessoa sintética", ingress: ctx.ingress });
    return { conversationId: id, resource: { kind: "conversation", id }, wake: false, statements: [
      [`INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,channel,channel_account_id,
        channel_subject_id,channel_context,customer_link_state,chat_type,state,last_customer,created,updated)
        VALUES(?,?,?,?,?,?,'telegram',?,?,?,'pending','direct','human',?,?,?) ON CONFLICT(id) DO NOTHING`,
      [id, c.profile_id, c.connection_id, c.external_namespace, c.external_id, c.session, c.channel_account_id,
        subject, c.channel_context, event.occurredAt ?? 0, ctx.now, ctx.now]],
      ...identity.statements,
      ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,created) VALUES(?,?,?,'customer','customer',?,?,?)",
        [messageId, c.profile_id, id, event.content.text, event.remoteId, event.occurredAt ?? ctx.now]],
    ] };
  },
  async view() { return { capabilities: androidTelegram.spec, metadata: {
    telegram: { blocked: false, webhookConfigured: true },
  } }; },
};

const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  network.restore(); network.assertNone();
}, 30_000);
async function setup() {
  const f = await c2Fixture("telegram"); profiles.add(f.profile);
  await installTestExtension(f, androidTelegram);
  return f;
}
const event = () => ({ update_id: 9001, message: { message_id: 19, date: now() - 1000,
  chat: { id: "42000", type: "private" }, from: { id: "42000" }, text: "Olá! Preciso de atenção." } });

describe("c2-android: ingresso real que alimenta as projeções nativas", () => {
  it("canal não usado: extensão desligada não cria efeitos, e canais antigos não consultam o D1 novo", async () => {
    const f = await setup();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    const response = await c2TelegramWebhook(f, event());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true, reason: "channel_not_ready" });
    await assertNoChannelEffects(f.profile);
    for (const channel of ["whatsapp", "instagram", "facebook"] as const) {
      const c = { ...conversation(uid(), f.profile, f.line, f.account, "42000"), channel };
      const measured = await measure(env as Env, counted => channelAutomationBlock(counted, c, "android-unused"));
      expect(measured.result).toBeNull();
      expect(measured.count).toEqual({ calls: 0, statements: 0, sql: [] });
    }
  }, 30_000);

  it("Worker → Coordinator aceita repetição concorrente sem duas mensagens nem duas identidades", async () => {
    const f = await setup(), input = event();
    const responses = await Promise.all([c2TelegramWebhook(f, input), c2TelegramWebhook(f, input)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toHaveLength(1);
    const rows = await all<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    expect(await resolveChannelCustomer(env as Env, rows[0])).toMatchObject({ verifiedPhone: null, identityTrust: "channel" });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("ingresso forjado é recusado pelo segredo real antes de qualquer efeito", async () => {
    const f = await setup();
    const response = await c2TelegramWebhook(f, event(), "segredo-incorreto");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(f.webhookSecret);
    await assertNoChannelEffects(f.profile);
  }, 30_000);

  it("ações Android têm assunto e alvo explícitos, sem identidade ou destinatário fornecido pelo cliente", () => {
    expect(parseChannelAction({ type: "comment.reply", commentId: "comment-1", text: "Resposta pública" }))
      .toEqual({ type: "comment.reply", commentId: "comment-1", text: "Resposta pública" });
    expect(parseChannelAction({ type: "comment.private", commentId: "comment-1", text: "Resposta privada" }).type).toBe("comment.private");
    expect(() => parseChannelAction({ type: "comment.reply", text: "Sem alvo" })).toThrow();
    const subject = "Pedido 123 · https://loja.example";
    expect(parseChannelAction({ type: "email.send", subject, text: "Olá!" })).toMatchObject({ type: "email.send", subject });
    expect(() => parseChannelAction({ type: "email.send", subject: "Olá\r\nBcc: terceiro@example.test", text: "Olá!" })).toThrow();
    expect(() => parseChannelAction({ type: "email.send", subject, text: "Olá!", recipient: "terceiro@example.test" })).toThrow();
    expect(() => parseChannelAction({ type: "message.send", text: "Olá!", verified: true })).toThrow();
  });
});
