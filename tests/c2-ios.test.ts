import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelExtension, ChannelExtensionView } from "../src/channel-c2-contracts";
import { assertVerifiedIngress, parseChannelAction } from "../src/channel-extension-kernel";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import { prepareChannelInbound, resolveChannelCustomer } from "../src/customer/channel-identity";
import { all, exec, one } from "../src/db";
import { sha } from "../src/security";
import { json, now, type Conversation } from "../src/types";
import { assertNoChannelEffects, c2Fixture, c2Request, c2TelegramWebhook, denyNetwork,
  installTestExtension, quietCoordinator } from "./c2-fixtures";
import models from "../mobile/ios/Wabotia/Core/Models.swift?raw";
import channels from "../mobile/ios/Wabotia/Core/ChannelModels.swift?raw";
import window from "../mobile/ios/Wabotia/Core/WindowClock.swift?raw";
import endpoints from "../mobile/ios/Wabotia/Core/API/Endpoints.swift?raw";
import composer from "../mobile/ios/Wabotia/Features/Conversations/ComposerView.swift?raw";
import detail from "../mobile/ios/Wabotia/Features/Conversations/ConversationView.swift?raw";
import detailModel from "../mobile/ios/Wabotia/Features/Conversations/ConversationViewModel.swift?raw";
import bubble from "../mobile/ios/Wabotia/Features/Conversations/MessageBubbleView.swift?raw";
import demo from "../mobile/ios/Wabotia/Core/Demo/ChannelsSecondWave.swift?raw";
import demoServer from "../mobile/ios/Wabotia/Core/Demo/DemoServer.swift?raw";
import nativeTests from "../mobile/ios/WabotiaTests/ChannelsSecondWaveTests.swift?raw";
import demoTests from "../mobile/ios/WabotiaTests/ChannelsSecondWaveDemoTests.swift?raw";

// O trecho Swift abaixo é inspecionado estaticamente. Vitest NÃO compila Swift,
// NÃO executa XCTest e NÃO substitui build/inspeção visual no Xcode.
// Compilação e execução dos testes iOS: pendentes de macOS.
const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  try {
    for (const profile of profiles) await quietCoordinator(profile);
    network.assertNone();
  } finally {
    profiles.clear();
    network.restore();
  }
});

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Formato do plano; a conferir com a conta real. Descritor sintético de ensaio,
 * não implementação Telegram. Worker, Coordinator, deduplicação, identidade e
 * D1 são reais. Não há download, transporte ou normalizador da tarefa paralela. */
const iosTelegramFixture: ChannelExtension = {
  ...CHANNEL_EXTENSION_STUBS["telegram/direct"],
  spec: { ...CHANNEL_EXTENSION_STUBS["telegram/direct"].spec, enabled: true,
    contexts: { direct: { enabled: true, bot: false, publicReply: false } },
    text: { enabled: true, maxChars: 4096 } },
  enabled: connection => json(connection.config).c2_enabled === true,
  async normalize(input, scope) {
    assertVerifiedIngress(scope);
    const update = object(input), message = object(update.message);
    const chat = object(message.chat), from = object(message.from);
    if (scope.channel !== "telegram" || scope.context !== "direct" ||
        !Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(message.message_id) ||
        chat.type !== "private" || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(from.id) ||
        typeof message.text !== "string") return null;
    return { key: String(update.update_id), kind: "message.received",
      remoteId: `${chat.id}:${message.message_id}`, subjectId: String(from.id), subjectNamespace: "telegram-user",
      occurredAt: typeof message.date === "number" ? message.date * 1000 : null,
      context: { version: 1, context: "direct" }, content: { text: message.text } };
  },
  async prepareInbound(ctx, event) {
    const profile = ctx.authorization.profileId, scope = ctx.ingress!;
    const id = `ios-tg:${await sha(JSON.stringify([profile, ctx.connection.id, event.subjectId]))}`;
    const existing = await one<Conversation>(ctx.env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", id, profile);
    const conversation: Conversation = existing ?? {
      id, profile_id: profile, connection_id: ctx.connection.id,
      external_namespace: `channel:${ctx.connection.id}`, external_id: `telegram:${event.subjectId}`,
      channel: "telegram", channel_account_id: scope.accountId, channel_subject_id: event.subjectId,
      channel_context: JSON.stringify(event.context), customer_link_state: "pending", phone: null,
      verified_phone: null, chat_type: "direct", title: "Pessoa sintética", bot_policy: "off",
      state: "waiting", owner: null, epoch: 1, session: id, topic: null, tags: "[]",
      last_customer: event.occurredAt ?? 0, created: ctx.now, updated: ctx.now,
    };
    const identity = await prepareChannelInbound(ctx.env, conversation, {
      channel: "telegram", provider: "telegram_bot", accountId: scope.accountId,
      subjectId: event.subjectId!, subjectNamespace: "telegram-user", displayName: "Pessoa sintética", ingress: scope,
    });
    const messageId = `ios-msg:${await sha(JSON.stringify([ctx.connection.id, event.remoteId]))}`;
    return { conversationId: id, resource: { kind: "conversation", id }, wake: false, statements: [
      ...(!existing ? [[
        `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
          channel,channel_account_id,channel_subject_id,channel_context,customer_link_state,chat_type,
          title,bot_policy,state,epoch,last_customer,created,updated)
         VALUES(?,?,?,?,?,?,'telegram',?,?,?,'pending','direct',?,'off','waiting',1,?,?,?)`,
        [id, profile, ctx.connection.id, conversation.external_namespace, conversation.external_id, id,
          scope.accountId, event.subjectId, conversation.channel_context, conversation.title,
          conversation.last_customer, ctx.now, ctx.now],
      ] as [string, unknown[]]] : []),
      ...identity.statements,
      ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,content,created) VALUES(?,?,?,'customer','customer',?,?,?,?)",
        [messageId, profile, id, event.content.text, event.remoteId, JSON.stringify(event.context), ctx.now]],
    ] };
  },
};

async function setupTelegram() {
  const fixture = await c2Fixture("telegram");
  profiles.add(fixture.profile);
  await installTestExtension(fixture, iosTelegramFixture);
  return fixture;
}

function telegramEvent() {
  return { update_id: 42, message: { message_id: 7, date: Math.floor(now() / 1000) - 1,
    chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "Olá! Preciso de atenção." } };
}

describe("c2-ios: fronteira real da base, sem fornecedor nem execução Swift", () => {
  it("canal não usado: entrada legítima desligada não cria efeitos nem cai no WhatsApp", async () => {
    const f = await setupTelegram();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    const response = await c2TelegramWebhook(f, telegramEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, ignored: true, reason: "channel_not_ready" });
    await assertNoChannelEffects(f.profile);
  }, 60_000);

  it("evento repetido concorrentemente no webhook cria só uma mensagem e uma identidade", async () => {
    const f = await setupTelegram(), event = telegramEvent();
    const responses = await Promise.all([c2TelegramWebhook(f, event), c2TelegramWebhook(f, event)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<Record<string, unknown>>));
    expect(bodies.filter(body => body.duplicate === true)).toHaveLength(1);
    expect(await all(env, "SELECT text FROM messages WHERE profile_id=?", f.profile))
      .toEqual([{ text: event.message.text }]);
    expect(await all(env, "SELECT phone FROM contacts WHERE profile_id=?", f.profile)).toEqual([{ phone: "" }]);
    expect(await all(env, "SELECT subject_namespace FROM customer_channel_ids WHERE profile_id=?", f.profile))
      .toEqual([{ subject_namespace: "telegram-user" }]);
    expect(await all(env, "SELECT kind FROM channel_events WHERE connection_id=?", f.line))
      .toEqual([{ kind: "message.received" }]);
    const conversation = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=?", f.profile);
    expect(conversation).toMatchObject({ channel: "telegram", phone: null, verified_phone: null });
    expect(await resolveChannelCustomer(env, conversation!))
      .toMatchObject({ state: "ready", verifiedPhone: null, identityTrust: "channel" });
    for (const table of ["outbox", "bot_runs", "media"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile)).toEqual([]);
    expect((await c2TelegramWebhook(f, event)).ok).toBe(true);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
  }, 60_000);

  it("evento forjado é recusado pelo Worker antes de parse, identidade, mensagem ou mídia", async () => {
    const f = await setupTelegram();
    const response = await c2TelegramWebhook(f, telegramEvent(), "segredo-incorreto");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(f.webhookSecret);
    const malformed = await c2Request(`/webhooks/telegram-bot/${f.line}`, {
      method: "POST", body: "{", headers: { "X-Telegram-Bot-Api-Secret-Token": "incorreto" },
    });
    expect(malformed.status).toBe(403);
    await assertNoChannelEffects(f.profile);
    expect(await all(env, "SELECT operation FROM audit WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);
});

describe("c2-ios: contratos e encaixes de fonte; build em macOS pendente", () => {
  it("preserva os nomes reais da projeção e metadados opcionais do servidor", () => {
    const view: ChannelExtensionView = { capabilities: { enabled: true, text: { enabled: true, maxChars: 50_000 }, subject: true },
      metadata: { email: { subject: "Pedido 123 · https://example.test", sender: "pessoa@example.test",
        identityTrust: "unverified_sender", authentication: [{ method: "dmarc", result: "pass" }] } } };
    expect(models).toMatch(/var channel_extension: [^\n]+\?/);
    for (const key of ["capabilities", "metadata", "subject", "sender", "identityTrust", "authentication"])
      expect(channels).toContain(key);
    expect(view.metadata.email?.identityTrust).toBe("unverified_sender");
    expect(nativeTests).toContain("XCTestCase");
    expect(nativeTests).toContain("JSONDecoder");
  });

  it("ação de e-mail preserva assunto, sem identidade ou destinatário informado pelo cliente", () => {
    const action = { type: "email.send", text: "Olá, segue a resposta.", subject: "Re: Pedido 123 · https://example.test" };
    expect(parseChannelAction(action)).toMatchObject(action);
    for (const subject of ["Assunto\nBcc: terceiro@example.test", "Assunto\rOutro", "Assunto\0", "a".repeat(201)])
      expect(() => parseChannelAction({ ...action, subject })).toThrow();
    for (const field of ["to", "recipient", "actor", "origin", "verified"])
      expect(() => parseChannelAction({ ...action, [field]: "forjado" })).toThrow();
    expect(channels).toContain('"email.send"');
    expect(composer).toContain("Assunto");
    expect(bubble).toContain("subject");
    expect(endpoints).toContain("func channelAction");
    expect(endpoints).toContain("_ body: ChannelActionRequest, key: String");
  });

  it("comentário exige ação explícita e comentário alvo em público e privado", () => {
    for (const type of ["comment.reply", "comment.private"] as const) {
      expect(parseChannelAction({ type, commentId: "comment-1", text: "Resposta revisada" }))
        .toEqual({ type, commentId: "comment-1", text: "Resposta revisada" });
      expect(() => parseChannelAction({ type, text: "Sem alvo" })).toThrow();
      expect(channels).toContain(`"${type}"`);
    }
    expect(parseChannelAction({ type: "comment.visibility", commentId: "comment-1", hidden: true }))
      .toEqual({ type: "comment.visibility", commentId: "comment-1", hidden: true });
    expect(detail + composer).toContain("Comentário");
    expect(channels).toContain("privateExpiresAt");
    expect(channels).toContain("privateState");
    expect(detailModel).toContain("channel_action");
  });

  it("TikTok projeta prazo/contador do servidor e mantém testes Swift independentes", () => {
    const view: ChannelExtensionView = { capabilities: { enabled: true }, metadata: {
      tiktok: { remainingMessages: 1, closesAt: 1_800_000_000_000, conservativeQuota: true },
    } };
    for (const key of Object.keys(view.metadata.tiktok!)) expect(channels).toContain(key);
    expect(channels + window + detail).toContain("48");
    expect(channels + detail).toContain("de 10 mensagens");
    expect(channels).toContain('return "Canal desconhecido"');
    expect(channels).toContain("guard resolvedChannel(fallbackKind: fallbackKind) == .whatsapp");
    expect(nativeTests).not.toContain("URLSession.shared");
  });

  it("retry conserva corpo e chave, com provas nativas de campos ausentes e permissões", () => {
    expect(channels).toContain("let body: ChannelActionRequest");
    expect(channels).toContain("previous.body == body");
    expect(detailModel).toContain("attempt.body, key: attempt.key");
    expect(detailModel).toContain("guard let attempt = channelPending");
    for (const test of [
      "testUnusedChannelKeepsWhatsAppPresentation",
      "testAbsentFieldsAndUnknownChannelFailClosed",
      "testCapabilitiesAndPermissionsAreExplicit",
      "testEmailSubjectAndUnverifiedSenderMetadata",
      "testCommentRequiresExplicitActionTargetAndPrivateDeadline",
      "testTikTokCounterDeadlineAndNoQuotaReset",
      "testRetryFreezesSubjectTargetAndAttachments",
      "testOnlyActivatedConversationChannelsAppearInFilter",
    ]) expect(nativeTests).toContain(`func ${test}`);
  });

  it("demo é opt-in, usa o mesmo envelope e mantém retry sem rede", () => {
    expect(demoServer).toContain("ChannelsSecondWave");
    expect(demoServer + demo).toContain("WABOTIA_DEMO_CHANNELS_SECOND_WAVE");
    for (const action of ["email.send", "comment.reply", "comment.private", "message.send"])
      expect(demo).toContain(action);
    expect(demo).toContain("idempotency_conflict");
    expect(demo).toContain("quota_exhausted");
    expect(demoTests).toContain("XCTestCase");
    for (const test of [
      "testUnusedChannelKeepsLegacyDemoAndExplicitOptInAddsFixtures",
      "testEveryFixtureDecodesAndUnknownNeverSends",
      "testCommentsKeepAuthorAndPostScopesAndRequireExplicitTarget",
      "testPrivateReplyConsumesAttemptAndVisibilityIsExplicit",
      "testEmailSubjectIsFrozenWithRetryAndHostileHTMLIsOnlySafeText",
      "testTikTokTwoSlotsAreRejectedThenTenthAllowedAndEleventhBlocked",
      "testRepeatedInboundAndLocalEchoDoNotDuplicateOrResetTikTokQuota",
      "testTelegramBlockedAndRateLimitedDoNotSendAndPhoneIsOnlySuggestion",
    ]) expect(demoTests).toContain(`func ${test}`);
    expect(demoTests).not.toContain("URLSession.shared");
    expect(demo).not.toContain("URLSession");
  });
});
