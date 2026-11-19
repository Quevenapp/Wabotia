/** Fixtures sintéticas: formato do plano; a conferir com a conta real.
 * Worker, Coordinator, identidade, D1 e R2 são reais. Só o fornecedor é simulado. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Conversation, type Env } from "../src/types";
import { tiktokConnectionDriver, tiktokExtension } from "../src/c2/tiktok";
import { resolveChannelCustomer } from "../src/customer/channel-identity";
import { channelAutomationBlock, loadChannelOperationContext, prepareChannelAction } from "../src/channel-extension-kernel";
import { registerChannelExtension } from "../src/channel-extension-registry";
import { completeChannelDelivery } from "../src/delivery";
import { dispatchChannelDelivery, enqueueChannelPlan } from "../src/engine";
import type { ChannelConnectionContext, ChannelOutboxRow, ExtensionConnection } from "../src/channel-c2-contracts";
import { assertNoChannelEffects, bearer, c2Fixture, c2Request, c2ZernioWebhook, denyNetwork, installTestExtension, measure,
  quietCoordinator, type C2Fixture } from "./c2-fixtures";

const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  network.restore();
  network.assertNone();
});

async function setup() {
  const f = await c2Fixture("tiktok");
  profiles.add(f.profile);
  await installTestExtension(f, tiktokExtension);
  return f;
}

function message(f: C2Fixture, direction: "incoming" | "outgoing" = "incoming", remoteId = uid()) {
  const subject = "pessoa/opaca:ç", thread = "thread-sintética";
  return {
    id: uid(), event: direction === "incoming" ? "message.received" : "message.sent",
    account: { accountId: f.account, platform: "tiktok", profileId: f.remoteProfile },
    conversation: { id: thread, participantId: subject, type: "direct" },
    message: {
      platformMessageId: remoteId, conversationId: thread, direction, sentAt: now() - 1000,
      text: direction === "incoming" ? "Olá, preciso de informação." : "Resposta no aplicativo.",
      sender: { id: direction === "incoming" ? subject : f.account, name: "Pessoa com acentos", username: "pessoa_sintetica" },
      recipient: { id: direction === "incoming" ? f.account : subject },
      attachments: [] as { type: string; mimeType: string; url: string; name?: string }[],
      idempotencyKey: undefined as string | undefined,
    },
  };
}

async function accepted(f: C2Fixture, event: ReturnType<typeof message>) {
  const response = await c2ZernioWebhook(f, event);
  expect(response.status, await response.clone().text()).toBe(202);
  return response;
}

async function conversation(f: C2Fixture) {
  const row = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND connection_id=?", f.profile, f.line);
  expect(row).not.toBeNull();
  return row!;
}

async function driverContext(f: C2Fixture): Promise<ChannelConnectionContext> {
  const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", f.line, f.profile))!;
  return { env: env as Env, actor: f.admin, profileId: f.profile, connection,
    commandId: uid(), now: now(), input: { kind: "zernio", channel: "tiktok", config: { c2_enabled: true } } };
}

function mockAccountProbe(f: C2Fixture, respond: () => Response) {
  let calls = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://zernio.com" || url.pathname !== "/api/v1/accounts" ||
        url.searchParams.get("profileId") !== f.remoteProfile || url.searchParams.get("platform") !== "tiktok" ||
        url.searchParams.get("limit") !== "100" || (init?.method ?? "GET") !== "GET") {
      network.unexpected.push("chamada externa inesperada");
      throw new Error("Fronteira não simulada.");
    }
    calls++;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer chave-sintetica-c2");
    return respond();
  });
  return { calls: () => calls };
}

describe("TikTok: configuração importada e elegibilidade", { timeout: 30_000 }, () => {
  it("driver não classifica região nem aceita trocar conta ou expor credenciais", () => {
    for (const region of ["BR", "US", "desconhecida"]) {
      expect(tiktokConnectionDriver.validate({ kind: "zernio", channel: "tiktok", config: {
        c2_enabled: true, region, account_id: "outra-conta", api_key: "segredo-sintético", tiktok_error_code: null,
      } })).toEqual({ channel: "tiktok", config: { c2_enabled: true } });
    }
    expect(() => tiktokConnectionDriver.validate({ kind: "qr", channel: "tiktok", config: {} })).toThrow();
    expect(() => tiktokConnectionDriver.validate({ kind: "zernio", channel: "instagram", config: {} })).toThrow();
    expect(() => tiktokConnectionDriver.validate({ kind: "zernio", config: { c2_enabled: "sim" } })).toThrow();
  });

  it("configuração normal não faz rede; vínculo ausente não é promovido e remoção conclui pausada", async () => {
    const f = await setup(), ctx = await driverContext(f);
    const token = await bearer(f.admin);
    const setupView = await c2Request(`/api/v1/profiles/${f.profile}/c2/connections/${f.line}/setup`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(setupView.status).toBe(200);
    const publicSetup = await setupView.json();
    expect(publicSetup).toMatchObject({ configured: true, credential: "configurado", conservativeQuota: true });
    expect(JSON.stringify(publicSetup)).not.toContain("chave-sintetica-c2");
    expect(JSON.stringify(publicSetup)).not.toContain(f.webhookSecret);
    expect(await tiktokConnectionDriver.configure(ctx)).toMatchObject({ status: "active", configured: true,
      configuration: { c2_enabled: true } });
    expect(await tiktokConnectionDriver.configure({ ...ctx, input: { kind: "zernio", config: { c2_enabled: false } } }))
      .toMatchObject({ status: "paused", configured: true, configuration: { c2_enabled: false } });
    expect(await tiktokConnectionDriver.remove(ctx)).toEqual({ status: "paused", configured: false });
    await exec(env, "DELETE FROM zernio_channel_accounts WHERE connection_id=? AND profile_id=?", f.line, f.profile);
    expect(await tiktokConnectionDriver.probe(ctx)).toEqual({ status: "pending", configured: false, code: "channel_import_required" });
    await assertNoChannelEffects(f.profile);
  });

  it("setup revalida Inbox antes de retirar bloqueio de elegibilidade e conserva a quota no replay", async () => {
    const f = await setup();
    await accepted(f, message(f));
    await accepted(f, message(f, "outgoing"));
    const slots = await all(env, "SELECT id,state,counted_at FROM tiktok_send_slots WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.tiktok_error_code','tiktok_account_ineligible') WHERE id=?", f.line);
    let inboxEnabled = false;
    const probe = mockAccountProbe(f, () => Response.json({ accounts: [{ _id: f.account, platform: "tiktok", profileId: f.remoteProfile,
      isActive: true, needsReconnect: false, inboxEnabled, region: "a conferir com a conta real" }] }));
    const token = await bearer(f.admin), path = `/api/v1/profiles/${f.profile}/c2/connections/${f.line}/setup`;
    const request = (key: string) => c2Request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`,
      "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ config: { c2_enabled: true } }) });
    const denied = await request(uid());
    expect(denied.status, await denied.clone().text()).toBe(200);
    expect(await denied.json()).toMatchObject({ status: "pending", configured: true, code: "inbox_required" });
    expect(await one(env, "SELECT status,json_extract(config,'$.tiktok_error_code') code FROM connections WHERE id=?", f.line))
      .toEqual({ status: "paused", code: "tiktok_account_ineligible" });
    inboxEnabled = true;
    const key = uid(), restored = await request(key);
    expect(restored.status, await restored.clone().text()).toBe(200);
    const result = await restored.json();
    expect(result).toMatchObject({ status: "active", configured: true, channel: "tiktok" });
    expect(JSON.stringify(result)).not.toContain("chave-sintetica-c2");
    expect(JSON.stringify(result)).not.toContain(f.webhookSecret);
    expect(await one(env, "SELECT status,json_extract(config,'$.tiktok_error_code') code FROM connections WHERE id=?", f.line))
      .toEqual({ status: "active", code: null });
    const replay = await request(key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(probe.calls()).toBe(2);
    expect(await all(env, "SELECT id,state,counted_at FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual(slots);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("probe recusado conserva bloqueio e devolve somente código local seguro", async () => {
    const f = await setup();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.tiktok_error_code','tiktok_account_ineligible') WHERE id=?", f.line);
    const probe = mockAccountProbe(f, () => Response.json({ error: `corpo remoto com chave-sintetica-c2 e ${f.webhookSecret}`,
      code: "ACCOUNT_INELIGIBLE", region: "valor-não-confiável" }, { status: 403 }));
    const result = await tiktokConnectionDriver.probe(await driverContext(f));
    expect(result).toEqual({ status: "pending", configured: true, code: "provider_authorization_failed" });
    expect(probe.calls()).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/corpo remoto|chave-sintetica|valor-não-confiável/);
    expect(JSON.stringify(result)).not.toContain(f.webhookSecret);
    expect(await one(env, "SELECT json_extract(config,'$.tiktok_error_code') code FROM connections WHERE id=?", f.line))
      .toEqual({ code: "tiktok_account_ineligible" });
    await assertNoChannelEffects(f.profile);
  });
});

describe("TikTok: entrada autenticada e compatibilidade", { timeout: 30_000 }, () => {
  it("canal não usado mantém zero consultas para WhatsApp e DMs da primeira leva", async () => {
    registerChannelExtension(tiktokExtension);
    const measured = await measure(env as Env, async counted => {
      for (const channel of ["whatsapp", "instagram", "facebook"] as const) {
        expect(tiktokExtension.enabled?.({ id: "antiga", profile_id: "área", kind: "zernio", channel, config: "{}" })).toBe(false);
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "legado")).toBeNull();
      }
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(measured.count).toMatchObject({ calls: 0, statements: 0 });
  });

  it("canal não usado ignora webhook legítimo sem criar mensagem, identidade ou vaga", async () => {
    const f = await setup();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    const response = await c2ZernioWebhook(f, message(f));
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ ignored: true, reason: "channel_not_ready" });
    await assertNoChannelEffects(f.profile);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("HMAC errado é recusado antes de mídia e qualquer efeito", async () => {
    const f = await setup(), event = message(f);
    event.message.attachments.push({ type: "image", mimeType: "image/png", url: "https://p16-sign.tiktokcdn.com/fixture.png" });
    const response = await c2ZernioWebhook(f, event, "0".repeat(64));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("invalid_signature");
    expect(body).not.toContain(f.webhookSecret);
    expect(body).not.toContain("chave-sintetica-c2");
    await assertNoChannelEffects(f.profile);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("conta e perfil divergentes não produzem efeitos mesmo com HMAC correto", async () => {
    const f = await setup();
    for (const field of ["accountId", "profileId"] as const) {
      const event = message(f);
      event.account[field] = uid();
      const response = await c2ZernioWebhook(f, event);
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ ignored: true });
    }
    await assertNoChannelEffects(f.profile);
  });

  it("recebe uma vez sob concorrência, cria identidade dm e nunca inventa telefone", async () => {
    const f = await setup(), event = message(f);
    const responses = await Promise.all([c2ZernioWebhook(f, event), c2ZernioWebhook(f, event)]);
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(202);
    const bodies = await Promise.all(responses.map(response => response.json<{ duplicate?: boolean }>()));
    expect(bodies.filter(body => body.duplicate)).toHaveLength(1);
    // Um novo ID de envelope não transforma a mesma mensagem em outra entrada.
    await accepted(f, { ...event, id: uid() });
    const c = await conversation(f);
    expect(c).toMatchObject({ channel: "tiktok", channel_subject_id: event.conversation.participantId,
      external_namespace: `channel:${f.line}`, external_id: `dm:${encodeURIComponent(event.conversation.participantId)}`,
      last_customer: event.message.sentAt, verified_phone: null });
    expect(c.phone == null || c.phone === "").toBe(true);
    const identities = await all(env, "SELECT subject_namespace,subject_id,account_id,channel FROM customer_channel_ids WHERE profile_id=?", f.profile);
    expect(identities).toEqual([{ subject_namespace: "dm", subject_id: event.conversation.participantId, account_id: f.account, channel: "tiktok" }]);
    const customer = await resolveChannelCustomer(env as Env, c);
    expect(customer).toMatchObject({ identityTrust: "channel", verifiedPhone: null,
      verifiedChannel: { subjectNamespace: "dm", subjectId: event.conversation.participantId } });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("timestamp inválido ou futuro preserva a última entrada válida", async () => {
    const f = await setup(), first = message(f);
    first.message.sentAt = now() - 120_000;
    await accepted(f, first);
    for (const sentAt of [0, -1, now() + 3_600_000]) {
      const event = message(f); event.message.sentAt = sentAt;
      await accepted(f, event);
      expect((await conversation(f)).last_customer).toBe(first.message.sentAt);
    }
    const malformed = message(f);
    const response = await c2ZernioWebhook(f, { ...malformed, message: { ...malformed.message, sentAt: "data inválida" } });
    expect(response.status).toBe(202);
    expect((await conversation(f)).last_customer).toBe(first.message.sentAt);
  });

  it("identidade bloqueada ou apagada não recria ficha nem recupera prova de canal", async () => {
    for (const state of ["blocked", "erased"] as const) {
      const f = await setup();
      await accepted(f, message(f));
      const original = await all<{ id: string }>(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile);
      await exec(env, "UPDATE customer_channel_ids SET state=?,version=version+1 WHERE profile_id=?", state, f.profile);
      await accepted(f, message(f));
      expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual(original);
      const c = await conversation(f);
      expect(c.customer_link_state).toBe(state === "blocked" ? "blocked" : "excluded");
      expect(await resolveChannelCustomer(env as Env, c)).toMatchObject({ verifiedPhone: null, verifiedChannel: null });
    }
  });

  it("eventos de leitura, falha ou comentários não são presumidos como mensagens", async () => {
    const f = await setup();
    for (const eventName of ["message.read", "message.delivered", "message.failed", "comment.received"]) {
      const event = message(f);
      const response = await c2ZernioWebhook(f, { ...event, event: eventName });
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ ignored: true });
    }
    const group = message(f);
    const response = await c2ZernioWebhook(f, { ...group, conversation: { ...group.conversation, type: "group" } });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ ignored: true });
    await assertNoChannelEffects(f.profile);
  });

  it("anexo recusado conserva texto e não persiste URL remota nem baixa origem arbitrária", async () => {
    const f = await setup(), event = message(f);
    event.message.attachments.push({ type: "image", mimeType: "image/png", url: "https://127.0.0.1/arquivo.png" });
    await accepted(f, event);
    const row = await one<{ text: string; attachments: string; content: string }>(env, "SELECT text,attachments,content FROM messages WHERE profile_id=?", f.profile);
    expect(row!.text).toContain(event.message.text);
    expect(JSON.parse(row!.attachments)).toEqual([]);
    expect(JSON.stringify(row)).not.toContain("127.0.0.1");
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("webhooks concorrentes copiam mídia privada uma vez depois da deduplicação", async () => {
    const f = await setup(), event = message(f);
    const source = "https://p16-sign.tiktokcdn.com/fixture.png";
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    event.message.attachments.push({ type: "image", mimeType: "image/png", url: source, name: "atenção.png" });
    let downloads = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== source) {
        network.unexpected.push("chamada externa inesperada");
        throw new Error("Fronteira não simulada.");
      }
      downloads++;
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("manual");
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
    });
    await Promise.all([accepted(f, event), accepted(f, event)]);
    await accepted(f, { ...event, id: uid() });
    expect(downloads).toBe(1);
    const media = await all<{ id: string; object_key: string; size: number; type: string }>(env,
      "SELECT id,object_key,size,type FROM media WHERE profile_id=?", f.profile);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ size: bytes.length, type: "image/png" });
    expect(await env.MEDIA.get(media[0].object_key)).not.toBeNull();
    const rows = await all<{ attachments: string; content: string }>(env, "SELECT attachments,content FROM messages WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].attachments)).toEqual([media[0].id]);
    expect(JSON.stringify(rows)).not.toContain("tiktokcdn.com");
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([]);
  });
});

describe("TikTok: saídas externas e ecos", { timeout: 30_000 }, () => {
  it("saída atrasada não reaponta o thread autenticado pela última entrada", async () => {
    const f = await setup(), incoming = message(f);
    await accepted(f, incoming);
    const outgoing = message(f, "outgoing");
    outgoing.conversation.id = "thread-antiga";
    outgoing.message.conversationId = "thread-antiga";
    outgoing.message.sentAt = incoming.message.sentAt - 60_000;
    await accepted(f, outgoing);
    expect(await one(env, "SELECT conversation_id FROM zernio_conversations WHERE connection_id=? AND external_id=?",
      f.line, `dm:${encodeURIComponent(incoming.conversation.participantId)}`)).toEqual({ conversation_id: incoming.conversation.id });
    expect((await conversation(f)).last_customer).toBe(incoming.message.sentAt);
    expect(await all(env, "SELECT state FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([{ state: "external" }]);
  });

  it("saída externa repetida consome uma vaga, sem bot, inbox ou renovação da janela", async () => {
    const f = await setup(), inbound = message(f);
    await accepted(f, inbound);
    const before = await conversation(f), outgoing = message(f, "outgoing");
    outgoing.message.sentAt = now();
    await Promise.all([accepted(f, outgoing), accepted(f, outgoing)]);
    await accepted(f, { ...outgoing, id: uid() });
    expect((await conversation(f)).last_customer).toBe(before.last_customer);
    expect(await all(env, "SELECT state,provider_message_id FROM tiktok_send_slots WHERE profile_id=?", f.profile))
      .toEqual([{ state: "external", provider_message_id: outgoing.message.platformMessageId }]);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='outbound'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("saída externa isolada não prova identidade nem abre a janela do cliente", async () => {
    const f = await setup();
    await accepted(f, message(f, "outgoing"));
    expect((await conversation(f)).last_customer).toBe(0);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT state FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toEqual([{ state: "external" }]);
  });

  it("eco de tentativa local confirma a mesma entrega sem duplicar vaga ou balão", async () => {
    const f = await setup(), inbound = message(f);
    await accepted(f, inbound);
    const c = await conversation(f);
    await exec(env, "UPDATE conversations SET owner=?,state='human' WHERE id=?", f.admin.id, c.id);
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "conversation", id: c.id }, uid());
    const action = { type: "message.send" as const, text: "Resposta local." };
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    await quietCoordinator(f.profile);
    const attemptedAt = now();
    await exec(env, "UPDATE outbox SET status='unknown',completion_handled=1 WHERE id=?", id);
    await exec(env, "UPDATE channel_delivery_state SET attempted_at=? WHERE outbox_id=?", attemptedAt, id);
    await exec(env, "UPDATE tiktok_send_slots SET state='unknown',counted_at=? WHERE outbox_id=?", attemptedAt, id);
    const echo = message(f, "outgoing");
    echo.message.idempotencyKey = id;
    echo.message.text = action.text;
    await Promise.all([accepted(f, echo), accepted(f, echo)]);
    expect(await all(env, "SELECT outbox_id,provider_message_id,state FROM tiktok_send_slots WHERE profile_id=?", f.profile))
      .toEqual([{ outbox_id: id, provider_message_id: echo.message.platformMessageId, state: "sent" }]);
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    expect(row).toMatchObject({ status: "sent", external_id: echo.message.platformMessageId });
    await completeChannelDelivery(env as Env, row);
    await completeChannelDelivery(env as Env, row);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='outbound'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await conversation(f)).last_customer).toBe(c.last_customer);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    // Uma dica reaproveitada não pode esconder um segundo ID remoto do teto.
    const other = message(f, "outgoing");
    other.message.idempotencyKey = id;
    await accepted(f, other);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await one(env, "SELECT provider_message_id FROM tiktok_send_slots WHERE outbox_id=?", id))
      .toEqual({ provider_message_id: echo.message.platformMessageId });
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='outbound'", f.profile)).toHaveLength(2);
  });

  it("eco enriquecido reconcilia saída antes registrada como externa sem perder a deduplicação", async () => {
    const f = await setup();
    await accepted(f, message(f));
    const c = await conversation(f);
    await exec(env, "UPDATE conversations SET owner=?,state='human' WHERE id=?", f.admin.id, c.id);
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "conversation", id: c.id }, uid());
    const action = { type: "message.send" as const, text: "Envio com resposta indeterminada." };
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    await quietCoordinator(f.profile);
    await exec(env, "UPDATE outbox SET status='unknown',completion_handled=1 WHERE id=?", id);
    await exec(env, "UPDATE channel_delivery_state SET attempted_at=? WHERE outbox_id=?", now(), id);
    await exec(env, "UPDATE tiktok_send_slots SET state='unknown' WHERE outbox_id=?", id);
    const echo = message(f, "outgoing");
    echo.message.text = action.text;
    // O primeiro envelope não contém correlação local: contar conservadoramente.
    await accepted(f, echo);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toHaveLength(2);
    echo.message.idempotencyKey = id;
    await Promise.all([accepted(f, echo), accepted(f, echo)]);
    await accepted(f, { ...echo, id: uid() });
    expect(await all(env, "SELECT outbox_id,provider_message_id,state FROM tiktok_send_slots WHERE profile_id=?", f.profile))
      .toEqual([{ outbox_id: id, provider_message_id: echo.message.platformMessageId, state: "sent" }]);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='outbound'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await conversation(f)).last_customer).toBe(c.last_customer);
  });
});
