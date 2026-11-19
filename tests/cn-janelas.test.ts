import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { deliver, enqueueSocialDeliveries, assertSocialDeliveryWindow } from "../src/engine";
import { channelRules, channelWindow, assertChannelSend } from "../src/channels";
import { installChannelAccountsPort, installChannelIdentityPort, installSocialTransportPort,
  type ChannelAccountsPort, type ChannelIdentityPort } from "../src/channel-ports";
import { persistedSocialOrigin, prepareSocialSend, socialRules, zernioSocialTransport } from "../src/zernio-social";
import { setSecret } from "../src/security";
import { uid, now, json } from "../src/types";

// Fixtures sintéticas do anexo; campos remotos a conferir com a conta real.
vi.hoisted(() => vi.resetModules());
const HOUR = 3_600_000;
const TIME = 1_800_000_000_000;
const MESSAGE_URL = "https://zernio.com/api/v1/inbox/conversations/thread/messages";
let unexpectedCalls: string[] = [];
function unexpectedNetwork(url: unknown, method?: string): never {
  const description = `${method || "GET"} ${String(url)}`;
  unexpectedCalls.push(description);
  throw new Error("Rede inesperada: " + description);
}
const absent = async (): Promise<never> => { throw new Error("Port de outra tarefa não deve executar neste teste."); };
beforeAll(() => {
  installChannelAccountsPort({ channels: ["instagram", "facebook"], discover: absent, importAccount: absent,
    validateConfiguration: absent, removeLink: absent } satisfies ChannelAccountsPort);
  installChannelIdentityPort({ channels: ["instagram", "facebook"], prepareInbound: absent, readChannels: absent,
    previewMerge: absent, merge: absent, undoMerge: absent } satisfies ChannelIdentityPort);
  installSocialTransportPort(zernioSocialTransport);
});
beforeEach(() => {
  unexpectedCalls = [];
  vi.spyOn(Date, "now").mockReturnValue(TIME);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => unexpectedNetwork(url, init?.method));
});
afterEach(() => {
  try { expect(unexpectedCalls).toEqual([]); }
  finally { vi.restoreAllMocks(); }
});

async function fixture(age = HOUR, channel: "instagram" | "facebook" = "instagram") {
  const profile = uid(), id = uid(), integration = uid(), conversationId = uid(), actor = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Social',?,1,?)", profile,
    JSON.stringify({ sender_signature: false }), now());
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created,channel) VALUES(?,?,'Social','zernio','direct','active',?,?,?)",
    id, profile, JSON.stringify({ account_id: "business", platform: channel, zernio_workspace_id: integration }), now(), channel);
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Integração',?,'zernio',?)", integration, profile, uid(), now());
  await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    id, profile, integration, channel, "business", now(), now());
  await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated,channel,channel_account_id,channel_subject_id) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?)",
    conversationId, profile, id, `channel:${id}`, "social:123456789", uid(), now() - age, now(), now(), channel, "business", "123456789");
  await exec(env, "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,'thread')", id, "social:123456789");
  await setSecret(env, `zernio-account:${integration}`, { api_key: "mock-key" });
  const c = await one(env, "SELECT * FROM conversations WHERE id=?", conversationId);
  const connection = await one(env, "SELECT * FROM connections WHERE id=?", id);
  const proof = (commandId: string, origin = "manual_text") => ({ version: 1, origin, actorId: actor,
    conversationId, connectionId: id, commandId });
  return { c, connection, actor, proof };
}
const rows = (c: any) => all(env, "SELECT * FROM outbox WHERE conversation_id=? ORDER BY created,rowid", c.id);
const code = (call: () => unknown, expected: string) => {
  try { call(); throw new Error("Esperava bloqueio."); } catch (error) { expect(error).toMatchObject({ code: expected }); }
};

describe("cn-janelas: origem e limites sociais", () => {
  it.each(["instagram", "facebook"] as const)("%s usa limites exatos de 24 h e 168 h", (channel) => {
    const rules = socialRules(channel);
    expect(channelWindow(rules, TIME - 24 * HOUR + 1, TIME).state).toBe("open");
    expect(channelWindow(rules, TIME - 24 * HOUR, TIME).state).toBe("human_text_only");
    expect(channelWindow(rules, TIME - 168 * HOUR + 1, TIME).state).toBe("human_text_only");
    expect(channelWindow(rules, TIME - 168 * HOUR, TIME).state).toBe("closed");
    for (const stamp of [0, NaN, Infinity, -1, TIME + 1])
      expect(channelWindow(rules, stamp, TIME).state).toBe("closed");
    for (const origin of ["bot", "automation", "human_media"] as const)
      code(() => assertChannelSend({ rules, window: channelWindow(rules, TIME - 25 * HOUR, TIME), origin,
        contentType: "text", hasAttachments: false }), "human_only");
  });

  it("só WhatsApp conserva oficial com modelo e QR sem prazo", () => {
    const base = { id: "wa", profile_id: "area", config: "{}" };
    const official = channelRules({ ...base, kind: "zernio" })!;
    expect(channelWindow(official, TIME - 25 * HOUR, TIME).state).toBe("closed");
    expect(() => assertChannelSend({ rules: official, window: channelWindow(official, TIME - 25 * HOUR, TIME),
      origin: "automation", contentType: "template", hasAttachments: false })).not.toThrow();
    expect(channelWindow(channelRules({ ...base, kind: "qr" })!, 0, TIME).state).toBe("open");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("aparência de usuário, parâmetros do cliente e prova de outra conversa não liberam extensão", async () => {
    const f = await fixture(25 * HOUR);
    const command = uid();
    const forged = { text: "Resposta", origin: "manual_text", human: true, messageTag: "HUMAN_AGENT" };
    await expect(enqueueSocialDeliveries(env, f.c, f.actor, "text", forged, command)).rejects.toMatchObject({ code: "human_only" });
    await expect(enqueueSocialDeliveries(env, f.c, f.actor, "text", { ...forged,
      social_provenance: { ...f.proof(command), conversationId: "other" } }, command)).rejects.toMatchObject({ code: "human_only" });
    for (const actor of ["app:client", "bot:attendant", "system"])
      expect(persistedSocialOrigin({ actor, kind: "text" }, { social_provenance: { ...f.proof(command), actorId: actor } }, f.c, f.connection)).toBe("automation");
    expect(await rows(f.c)).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("pessoa com origem persistida envia texto com HUMAN_AGENT e comando repetido não duplica", async () => {
    const f = await fixture(25 * HOUR), command = uid();
    const payload = { text: "Posso ajudar.", social_provenance: f.proof(command) };
    const [first, second] = await Promise.all([
      enqueueSocialDeliveries(env, f.c, f.actor, "text", payload, command),
      enqueueSocialDeliveries(env, f.c, f.actor, "text", payload, command),
    ]);
    expect(second).toBe(first);
    const queued = await rows(f.c);
    expect(queued).toHaveLength(1);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url) !== MESSAGE_URL || init?.method !== "POST") unexpectedNetwork(url, init?.method);
      expect(JSON.parse(String(init?.body))).toMatchObject({ message: "Posso ajudar.", messageTag: "HUMAN_AGENT" });
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(json(queued[0].payload).social_delivery.idempotencyKey);
      return Response.json({ data: { messageId: "remote-one" } });
    });
    await Promise.all([deliver(env, queued[0]), deliver(env, queued[0])]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((await rows(f.c))[0].status).toBe("sent");
  });

  it("reconfere janela após preparação e não usa janela de outra conta", async () => {
    const f = await fixture(24 * HOUR - 1), command = uid();
    await enqueueSocialDeliveries(env, f.c, "bot:attendant", "text", { text: "Resposta" }, command);
    const row = (await rows(f.c))[0], payload = json(row.payload);
    expect(assertSocialDeliveryWindow(f.connection, f.c, row, payload, TIME).state).toBe("open");
    code(() => assertSocialDeliveryWindow(f.connection, f.c, row, payload, TIME + 2), "human_only");
    code(() => assertSocialDeliveryWindow({ ...f.connection, id: "outra-conta" }, f.c, row, payload, TIME), "channel_not_ready");
    vi.mocked(Date.now).mockReturnValue(TIME + 2);
    await deliver(env, row);
    expect((await rows(f.c))[0]).toMatchObject({ status: "failed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("recalcula HUMAN_AGENT quando texto manual cruza 24 h e bloqueia aos 168 h", async () => {
    const f = await fixture(24 * HOUR - 1), command = uid();
    await enqueueSocialDeliveries(env, f.c, f.actor, "text", { text: "Resposta humana", social_provenance: f.proof(command) }, command);
    const row = (await rows(f.c))[0], payload = json(row.payload);
    expect(payload.social_delivery).not.toHaveProperty("messageTag");
    assertSocialDeliveryWindow(f.connection, f.c, row, payload, TIME + 2);
    expect(payload.social_delivery.messageTag).toBe("HUMAN_AGENT");
    code(() => assertSocialDeliveryWindow(f.connection, f.c, row, payload, f.c.last_customer + 168 * HOUR), "window_closed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("texto e imagem têm entregas distintas, ordenadas, com chaves próprias", async () => {
    const f = await fixture(), mediaId = uid(), command = uid();
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'foto.jpg','image/jpeg',3,?,'system',?)", mediaId, f.c.profile_id, mediaId, now());
    await env.MEDIA.put(mediaId, new Uint8Array([1, 2, 3]));
    await enqueueSocialDeliveries(env, f.c, f.actor, "text", { text: "Veja esta imagem.", media_id: mediaId,
      content: { type: "image" }, social_provenance: f.proof(command, "human_media") }, command);
    const queued = await rows(f.c);
    expect(queued).toHaveLength(2);
    expect(queued.map((row) => json(row.payload).social_delivery.content.type)).toEqual(["text", "media"]);
    expect(new Set(queued.map((row) => json(row.payload).social_delivery.idempotencyKey)).size).toBe(2);
    await deliver(env, queued[1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const sent: any[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const target = String(url);
      if (target === "https://zernio.com/api/v1/media/presign" && init?.method === "POST")
        return Response.json({ uploadUrl: "https://upload.example.test/item", publicUrl: "https://files.example.test/item" });
      if (target === "https://upload.example.test/item" && init?.method === "PUT") {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return new Response(null, { status: 200 });
      }
      if (target !== MESSAGE_URL || init?.method !== "POST") unexpectedNetwork(url, init?.method);
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { messageId: `remote-${sent.length}` } });
    });
    await deliver(env, queued[0]);
    await deliver(env, queued[1]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ message: "Veja esta imagem." });
    expect(sent[1]).toMatchObject({ attachmentType: "image" });
    expect(sent[1]).not.toHaveProperty("message");
    expect((await rows(f.c)).map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("preparação de imagem que cruza 24 h bloqueia o fetch de mensagem", async () => {
    const f = await fixture(24 * HOUR - 1), mediaId = uid();
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'foto.jpg','image/jpeg',3,?,'system',?)", mediaId, f.c.profile_id, mediaId, now());
    await env.MEDIA.put(mediaId, new Uint8Array([1, 2, 3]));
    await enqueueSocialDeliveries(env, f.c, "system", "text", { media_id: mediaId, content: { type: "image" } }, uid());
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url) === "https://zernio.com/api/v1/media/presign" && init?.method === "POST") return Response.json({ uploadUrl: "https://upload.example.test/item", publicUrl: "https://files.example.test/item" });
      if (String(url) === "https://upload.example.test/item" && init?.method === "PUT") {
        vi.mocked(Date.now).mockReturnValue(TIME + 2);
        return new Response(null, { status: 200 });
      }
      return unexpectedNetwork(url, init?.method);
    });
    await deliver(env, (await rows(f.c))[0]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((await rows(f.c))[0]).toMatchObject({ status: "failed" });
    expect((await rows(f.c))[0].error).toContain("human_only");
  });

  it("resultado indeterminado bloqueia repetição e a próxima entrega", async () => {
    const f = await fixture();
    await enqueueSocialDeliveries(env, f.c, "system", "text", { text: "x".repeat(641) }, uid());
    const queued = await rows(f.c);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url) !== MESSAGE_URL || init?.method !== "POST") unexpectedNetwork(url, init?.method);
      return Response.json({ data: {} });
    });
    await deliver(env, queued[0]);
    await deliver(env, queued[0]);
    await deliver(env, queued[1]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((await rows(f.c)).map((row) => row.status)).toEqual(["unknown", "pending"]);
  });

  it("nenhum anexo ou menu ganha extensão mesmo com origem humana", async () => {
    const scope = { profileId: "area", integrationId: "integration", connectionId: "connection", channel: "instagram" as const,
      accountId: "account", providerProfileId: null };
    const input = { scope, conversationId: "conversation", threadId: "thread", commandId: "command", origin: "manual_text" as const,
      lastCustomer: TIME - 25 * HOUR, serverNow: TIME, text: "Veja", attachments: [] };
    await expect(prepareSocialSend({ ...input, menu: [{ id: "1", title: "Sim" }] })).rejects.toMatchObject({ code: "human_only" });
    await expect(prepareSocialSend({ ...input, attachments: [{ mediaId: "image", kind: "image", mimeType: "image/jpeg", bytes: 3 }] }))
      .rejects.toMatchObject({ code: "human_only" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
