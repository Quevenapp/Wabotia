import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, defaults, now, uid } from "../src/types";
import type { SocialEventScope, SocialSendInput } from "../src/channel-contracts";
import {
  normalizeSocialEvent, persistedSocialOrigin, prepareSocialSend, socialDeliveryPayload,
  socialEchoHint, socialExternalId, socialInteractiveReplyId, socialProviderError, socialProviderMessageId, zernioSocialTransport,
} from "../src/zernio-social";
import { createChannelPorts, installChannelAccountsPort, installChannelIdentityPort, installSocialTransportPort } from "../src/channel-ports";
import { channelEvent, applyChannelEvents } from "../src/whatsapp";
import { zernioInbound } from "../src/zernio";
import { menuPayload } from "../src/line-service";
import { signedPayload } from "../src/signature";
import { createPiiMask } from "../src/pii-mask";
import { fixture } from "./service-center-fixture";
import { countingEnv } from "./d1-counter";

vi.hoisted(() => vi.resetModules());
let unexpectedNetwork = 0;
beforeEach(() => {
  unexpectedNetwork = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpectedNetwork++; throw new Error("Rede inesperada no teste."); });
});
afterEach(() => { vi.restoreAllMocks(); expect(unexpectedNetwork).toBe(0); });

beforeAll(() => {
  const stubs = createChannelPorts();
  installChannelAccountsPort({ ...stubs.channelAccountsPort, channels: ["instagram", "facebook"] });
  installChannelIdentityPort({ ...stubs.channelIdentityPort, channels: ["instagram", "facebook"] });
  installSocialTransportPort(zernioSocialTransport);
});

const scope: SocialEventScope = { profileId: "area", integrationId: "integration", connectionId: "connection", channel: "instagram", accountId: "account", providerProfileId: "provider-profile" };
// Hipóteses do esquema do anexo: a conferir com a conta real. Não são capturas reais.
function socialFixture(event = "message.received") {
  return { id: `event:${event}`, event,
    account: { accountId: scope.accountId, platform: scope.channel, profileId: scope.providerProfileId },
    conversation: { id: "thread", participantId: "5511999998888" },
    message: { platform: scope.channel, platformMessageId: "social-message", conversationId: "thread",
      direction: event === "message.sent" ? "outgoing" : "incoming", text: "Olá!", attachments: [],
      sender: { id: "5511999998888", name: "Ana Silva", username: "ana.perfil", phoneNumber: "+5511888887777" },
      recipient: { id: "5511999998888", name: "Ana Silva" }, sentAt: "2026-01-01T12:00:00.000Z" },
    timestamp: "2026-01-01T12:00:01.000Z", metadata: {} as Record<string, unknown> };
}
function sendInput(overrides: Partial<SocialSendInput> = {}): SocialSendInput {
  return { scope, conversationId: "conversation", commandId: "command", threadId: "thread", origin: "bot",
    lastCustomer: 1_800_000_000_000, serverNow: 1_800_000_001_000, text: "Olá", attachments: [], ...overrides };
}

async function parserFixture() {
  const profileId = uid(), connectionId = uid(), integrationId = uid(), conversationId = uid(), providerProfileId = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)", profileId, "Social", JSON.stringify(defaults), now());
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,?,?,?,?,?)", integrationId, profileId, "Integração", uid(), "zernio", providerProfileId, now());
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created,channel,account_label) VALUES(?,?,?,'zernio','direct','active',?,?,'instagram','@loja')",
    connectionId, profileId, "Instagram", JSON.stringify({ account_id: "account", zernio_workspace_id: integrationId }), now());
  await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,created,updated) VALUES(?,?,?,'instagram',?,?,?,?)",
    connectionId, profileId, integrationId, "account", providerProfileId, now(), now());
  await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,channel,channel_account_id,channel_subject_id) VALUES(?,?,?,?,?,?,?,?,?,'instagram','account','5511999998888')",
    conversationId, profileId, connectionId, `channel:${connectionId}`, "dm:5511999998888", uid(), 1_800_000_000_000, now(), now());
  const connection = await one(env, "SELECT * FROM connections WHERE id=?", connectionId);
  const body = socialFixture(); body.account.profileId = providerProfileId;
  return { profileId, connectionId, conversationId, connection, body };
}

describe("parser social com fronteira do serviço simulada", () => {
  it("deduplica webhook simultâneo e retry após falha de mídia antes de baixar novamente", async () => {
    const f = await parserFixture(), fetcher = vi.mocked(fetch);
    fetcher.mockRejectedValue(new Error("CDN indisponível simulada"));
    (f.body.message.attachments as any[]) = [{ type: "image", url: "https://scontent.fbcdn.net/photo", mimeType: "image/png" }];
    const dispatch = vi.fn(async (data: any) => {
      // cn-servidor é dono do lote real identidade+mensagem+inbox; aqui somente
      // a fronteira/recibo é simulado, sem substituir a prova de integração.
      await exec(env, "INSERT OR IGNORE INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
        uid(), f.profileId, `${f.profileId}:channel:${f.connectionId}:${data.external_id}:${data.message_id}`, f.conversationId, JSON.stringify(data), now());
      return Response.json({ received: true });
    });
    await Promise.all([
      zernioInbound(env, f.connection, f.body, dispatch),
      zernioInbound(env, f.connection, { ...f.body, id: "retry-different-webhook-id" }, dispatch),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const data = dispatch.mock.calls[0][0];
    expect(data).toMatchObject({ external_id: "dm:5511999998888", phone: null, channel: "instagram", channel_subject_id: "5511999998888", attachments: [], content: { media_error: true } });
    expect(data.text).toContain("Olá!"); expect(data.text).toContain("Anexo indisponível");
    expect(data.evidence).toMatchObject({ channel: "instagram", subjectNamespace: "dm", subjectId: "5511999998888" });
    expect(JSON.stringify(data)).not.toContain("https://scontent");
    const replay = await zernioInbound(env, f.connection, f.body, dispatch);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profileId)).toHaveLength(1);
  });
  it("plataforma divergente não cria inbox nem baixa mídia", async () => {
    const f = await parserFixture(), dispatch = vi.fn();
    f.body.message.platform = "facebook" as any;
    expect(await (await zernioInbound(env, f.connection, f.body, dispatch)).json()).toMatchObject({ ignored: true, reason: "scope_mismatch" });
    expect(dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profileId)).toEqual([]);
  });
  it("seleção de resposta rápida chega à engine sem transformar perfil em telefone", async () => {
    const f = await parserFixture(); f.body.metadata = { interactiveId: "wmenu:token:option" };
    const dispatch = vi.fn(async (_data: any) => Response.json({ received: true }));
    await zernioInbound(env, f.connection, f.body, dispatch);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ phone: null, content: { interactive_reply_id: "wmenu:token:option" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("eco correlacionado não duplica mensagem e saída externa não abre janela", async () => {
    const f = await parserFixture(), deliveryId = uid();
    const payload = { text: "Resposta local", content: { type: "text" }, social_delivery: { idempotencyKey: "social:local" } };
    await exec(env, "INSERT INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,dedupe,created,updated) VALUES(?,?,?,?,0,'text','system',?,?,?,?)",
      deliveryId, f.profileId, f.conversationId, f.connectionId, JSON.stringify(payload), uid(), now(), now());
    const dispatch = async (data: any) => Response.json(await channelEvent(env, f.connection, data));
    const sent = { ...f.body, id: "sent", event: "message.sent", metadata: { idempotencyKey: "social:local" }, message: { ...f.body.message, direction: "outgoing" } };
    await zernioInbound(env, f.connection, sent, dispatch);
    await zernioInbound(env, f.connection, sent, dispatch);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", f.conversationId)).toHaveLength(1);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", deliveryId)).toMatchObject({ status: "sent" });
    const external = { ...sent, id: "external", metadata: {}, message: { ...sent.message, platformMessageId: "external-message", text: "Escrito no aplicativo" } };
    await zernioInbound(env, f.connection, external, dispatch);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", f.conversationId)).toHaveLength(2);
    expect(await one(env, "SELECT direction,author FROM messages WHERE conversation_id=? AND external_id='external-message'", f.conversationId)).toMatchObject({ direction: "outbound", author: "external:instagram" });
    expect(await one(env, "SELECT last_customer FROM conversations WHERE id=?", f.conversationId)).toMatchObject({ last_customer: 1_800_000_000_000 });
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profileId)).toHaveLength(0);
  });
  it("eco sem pista aguarda associação do envio em andamento e replay não duplica", async () => {
    const f = await parserFixture(), deliveryId = uid();
    await exec(env, "INSERT INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,0,'text','system',?,'sending',?,?,?)",
      deliveryId, f.profileId, f.conversationId, f.connectionId, JSON.stringify({ text: "Resposta original" }), uid(), now(), now());
    const sent = { ...f.body, id: "early-echo", event: "message.sent", message: { ...f.body.message, direction: "outgoing", text: "Eco remoto" } };
    const dispatch = async (data: any) => Response.json(await channelEvent(env, f.connection, data));
    await zernioInbound(env, f.connection, sent, dispatch);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", f.conversationId)).toHaveLength(0);
    expect(await one(env, "SELECT applied FROM channel_events WHERE connection_id=?", f.connectionId)).toEqual({ applied: 0 });
    // Simula o retorno do provedor identificando a entrega que já estava em andamento.
    await exec(env, "UPDATE outbox SET external_id=? WHERE id=?", sent.message.platformMessageId, deliveryId);
    await zernioInbound(env, f.connection, sent, dispatch);
    expect(await all(env, "SELECT id,text FROM messages WHERE conversation_id=?", f.conversationId)).toEqual([{ id: `delivery:${deliveryId}`, text: "Resposta original" }]);
    expect(await one(env, "SELECT applied FROM channel_events WHERE connection_id=?", f.connectionId)).toEqual({ applied: 1 });
  });
  it("exclusão e edição fora de ordem são idempotentes e não ressuscitam texto apagado", async () => {
    const f = await parserFixture();
    const base = { external_id: "dm:5511999998888", message_id: "before-message", channel: "instagram" };
    await channelEvent(env, f.connection, { ...base, event: "delete", event_id: "delete-first", timestamp: 1000 });
    const id = uid();
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,created) VALUES(?,?,?,'customer','customer','Texto original','before-message',?)", id, f.profileId, f.conversationId, now());
    await applyChannelEvents(env, f.connectionId, "before-message");
    await channelEvent(env, f.connection, { ...base, event: "edit", event_id: "edit-later", timestamp: 2000, text: "Não ressuscitar" });
    await channelEvent(env, f.connection, { ...base, event: "delete", event_id: "delete-first", timestamp: 1000 });
    expect(await one(env, "SELECT text,attachments FROM messages WHERE id=?", id)).toEqual({ text: "Mensagem apagada", attachments: "[]" });
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.connectionId)).toHaveLength(2);
  });
});

describe("leitor social isolado de WhatsApp", () => {
  it("preserva sujeitos opacos sem colisão entre delimitadores da inbox", () => {
    expect(socialExternalId("5511999998888")).toBe("dm:5511999998888");
    expect(`${socialExternalId("a:b")}:c`).not.toBe(`${socialExternalId("a")}:b:c`);
    expect(socialExternalId("a:b")).not.toBe(socialExternalId("a%3Ab"));
  });
  it("conserva identificador numérico como sujeito opaco sem telefone nem credencial", async () => {
    const result = await normalizeSocialEvent(socialFixture(), scope);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Evento recusado");
    expect(result.event.subject).toEqual({ namespace: "dm", id: "5511999998888", displayName: "Ana Silva", username: "ana.perfil" });
    expect(result.event).not.toHaveProperty("phone");
    expect(JSON.stringify(result)).not.toContain("5511888887777");
    expect(result.event.occurredAt).toBe(Date.parse("2026-01-01T12:00:00.000Z"));
    expect(await normalizeSocialEvent(socialFixture(), scope)).toEqual(result);
  });
  it("aceita Facebook e ID numérico seguro sem normalização telefônica", async () => {
    const body = socialFixture(); body.account.platform = "facebook"; body.message.platform = "facebook";
    (body.conversation.participantId as any) = 123456789;
    const result = await normalizeSocialEvent(body, { ...scope, channel: "facebook" });
    expect(result).toMatchObject({ status: "accepted", event: { scope: { channel: "facebook" }, subject: { id: "123456789" } } });
    expect(result.status === "accepted" && result.event).not.toHaveProperty("phone");
  });
  it("ignora plataforma, conta, perfil, thread e modos divergentes", async () => {
    for (const mutate of [
      (b: any) => { b.account.platform = "whatsapp"; },
      (b: any) => { b.message.platform = "facebook"; },
      (b: any) => { b.account.accountId = "other"; },
      (b: any) => { b.account.profileId = "other-profile"; },
      (b: any) => { b.conversation.accountId = "other-account"; },
      (b: any) => { b.conversation.id = "other-thread"; },
    ]) {
      const body = socialFixture(); mutate(body);
      expect(await normalizeSocialEvent(body, scope)).toEqual({ status: "ignored", reason: "scope_mismatch" });
    }
    for (const event of ["comment.created", "review.created", "message.failed"])
      expect((await normalizeSocialEvent(socialFixture(event), scope)).status).toBe("ignored");
    expect(await normalizeSocialEvent(socialFixture(), { ...scope, channel: "tiktok" as any }))
      .toEqual({ status: "ignored", reason: "channel_not_ready" });
  });
  it("não renova a janela pelo retry, timestamp inválido ou futuro", async () => {
    for (const sentAt of ["inválido", new Date(Date.now() + 60000).toISOString(), ""]) {
      const body = socialFixture(); body.message.sentAt = sentAt;
      const result = await normalizeSocialEvent(body, scope);
      expect(result.status === "accepted" && result.event.occurredAt).toBe(null);
    }
  });
  it("normaliza edição, exclusão, leitura, entrega e reação mesmo antes da mensagem", async () => {
    for (const event of ["message.edited", "message.deleted", "message.read", "message.delivered", "message.sent"]) {
      const result = await normalizeSocialEvent(socialFixture(event), scope);
      expect(result).toMatchObject({ status: "accepted", event: { type: event, messageId: "social-message", threadId: "thread" } });
      expect(await normalizeSocialEvent(socialFixture(event), scope)).toEqual(result);
    }
    const body = { ...socialFixture("reaction.received"), reaction: { platformMessageId: "social-message", emoji: "👍", action: "added" } };
    expect(await normalizeSocialEvent(body, scope)).toMatchObject({ event: { type: "message.reaction", reaction: "👍" } });
    body.reaction.action = "removed";
    expect(await normalizeSocialEvent(body, scope)).toMatchObject({ event: { type: "message.reaction", reaction: null } });
  });
  it("não aceita pista de eco como prova de entrega local", async () => {
    const body = socialFixture("message.sent"); body.metadata = { idempotencyKey: "social:local", localDeliveryId: "forged" };
    const result = await normalizeSocialEvent(body, scope);
    expect(result.status === "accepted" && result.event).not.toHaveProperty("localDeliveryId");
    expect(socialEchoHint(body)).toBe("social:local");
  });
  it("lê seleção do menu num único ponto e ignora eventos de teste", async () => {
    const body = socialFixture(); body.metadata = { interactiveId: "wmenu:token:option" };
    expect(socialInteractiveReplyId(body)).toBe("wmenu:token:option");
    expect(await normalizeSocialEvent({ ...body, test: true }, scope)).toEqual({ status: "ignored", reason: "unsupported_event" });
  });
  it("só WhatsApp conserva payload e não consulta tabelas sociais", async () => {
    const profile = uid(), id = uid();
    await exec(env, "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)", profile, "Só WhatsApp", JSON.stringify(defaults), now());
    await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)", id, profile, "WhatsApp", JSON.stringify({ account_id: "wa-account", platform: "whatsapp_cloud" }), now());
    const connection = await one(env, "SELECT * FROM connections WHERE id=?", id);
    const received: any[] = [];
    const body = socialFixture(); body.account = { accountId: "wa-account", platform: "whatsapp" as any, profileId: null as any };
    body.message.platform = "whatsapp" as any;
    body.message.platformMessageId = "wamid.only-wa";
    const counted = countingEnv(env);
    await zernioInbound(counted.env, connection, body, async (data) => { received.push(data); return Response.json({ received: true }); });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ external_id: "5511999998888", phone: "5511888887777", message_id: "wamid.only-wa", text: "Olá!" });
    expect(received[0]).not.toHaveProperty("channel_subject_id");
    expect(counted.count.sql.some((sql) => /zernio_channel_accounts|customer_channel_ids/.test(sql))).toBe(false);
    // Caminho anterior do parser: grupo, associação, gravação do thread e inbox.
    expect(counted.count).toMatchObject({ statements: 4, calls: 4 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("plano social e apresentação", () => {
  it.each([[3, "buttons"], [5, "quick_replies"], [15, "text"]])("adapta menu de %s opções", async (count, type) => {
    const menu = Array.from({ length: count as number }, (_, index) => ({ id: `option:${index}`, title: `Opção ${index + 1}` }));
    const plan = await prepareSocialSend(sendInput({ menu }));
    expect(plan.deliveries[0].content.type).toBe(type);
    const line = menuPayload(menu.map((option) => ({ id: option.id, label: option.title })), "Escolha", "token", true, false, "instagram");
    expect(line.content?.type ?? "text").toBe(type);
    if (type === "text") expect(plan.deliveries.map((delivery) => delivery.content.type === "text" ? delivery.content.text : "").join("")).toContain("15. Opção 15");
  });
  it("menu incompatível cai para texto e WhatsApp conserva interativos", async () => {
    const plan = await prepareSocialSend(sendInput({ menu: [{ id: "id", title: "x".repeat(21) }] }));
    expect(plan.deliveries[0].content).toEqual({ type: "text", text: `Olá\n\n1. ${"x".repeat(21)}` });
    expect(menuPayload([{ id: "one", label: "Um" }], "Escolha", "token", true).content?.type).toBe("interactive");
  });
  it("separa texto e imagem em duas entregas ordenadas com chaves estáveis distintas", async () => {
    const input = sendInput({ attachments: [{ mediaId: "image", kind: "image", mimeType: "image/png", bytes: 128 }] });
    const plan = await prepareSocialSend(input), replay = await prepareSocialSend(input);
    expect(replay).toEqual(plan);
    expect(plan.deliveries.map((delivery) => [delivery.sequence, delivery.content.type])).toEqual([[0, "text"], [1, "media"]]);
    expect(new Set(plan.deliveries.map((delivery) => delivery.idempotencyKey)).size).toBe(2);
    const payload = socialDeliveryPayload(plan.deliveries[1], { url: "https://cdn.example/image.png", name: "Foto.png" });
    expect(payload).toEqual({ attachmentUrl: "https://cdn.example/image.png", attachmentType: "image", attachmentName: "Foto.png" });
    expect(payload).not.toHaveProperty("replyTo");
  });
  it("divide 641 caracteres incluindo a assinatura sem truncar", async () => {
    const text = "😊".repeat(641), plan = await prepareSocialSend(sendInput({ text }));
    expect(plan.deliveries).toHaveLength(2);
    const parts = plan.deliveries.map((delivery) => delivery.content.type === "text" ? delivery.content.text : "");
    expect(parts.map((part) => Array.from(part).length)).toEqual([640, 1]);
    expect(parts.join("")).toBe(text);
  });
  it("não inicia thread nem aceita formato ou tamanho não validado", async () => {
    await expect(prepareSocialSend(sendInput({ threadId: null }))).rejects.toMatchObject({ code: "cannot_initiate" });
    for (const attachment of [
      { mediaId: "media", kind: "image" as const, mimeType: "image/png", bytes: 3 * 1024 * 1024 + 1 },
      { mediaId: "media", kind: "document" as const, mimeType: "application/msword", bytes: 128 },
    ]) await expect(prepareSocialSend(sendInput({ attachments: [attachment] }))).rejects.toMatchObject({ code: "unsupported_content" });
  });
  it("exige proveniência persistida, sem aceitar ator aparente ou campos arbitrários", () => {
    const row = { actor: "person", kind: "text" }, conversation = { id: "conversation" }, connection = { id: "connection" };
    expect(persistedSocialOrigin(row, { origin: "manual_text", human: true, messageTag: "HUMAN_AGENT" }, conversation, connection)).toBe("automation");
    const payload = { social_provenance: { version: 1, origin: "manual_text", actorId: "person", conversationId: "conversation", connectionId: "connection", commandId: "command" } };
    expect(persistedSocialOrigin(row, payload, conversation, connection)).toBe("manual_text");
    expect(persistedSocialOrigin(row, payload, conversation, { id: "other-account" })).toBe("automation");
    expect(persistedSocialOrigin({ actor: "app:person" }, { social_provenance: { ...payload.social_provenance, actorId: "app:person" } }, conversation, connection)).toBe("automation");
  });
  it("trata resultado indeterminado sem transformar ausência de ID em sucesso", () => {
    expect(() => socialProviderMessageId({ data: {} })).toThrowError(expect.objectContaining({ code: "provider_unknown" }));
    expect(socialProviderMessageId({ data: { messageId: "confirmed" } })).toBe("confirmed");
    expect(socialProviderError(new ApiError(502, "zernio_unknown", "secret"))).toMatchObject({ code: "provider_unknown" });
    expect(socialProviderError(new Error("access_token=secret")).message).not.toContain("secret");
  });
  it("assina social em texto simples e conserva assinatura só WhatsApp", async () => {
    const f = await fixture();
    await exec(env, "UPDATE users SET name='Ana' WHERE id=?", f.member.id);
    const row = { kind: "text", actor: f.member.id }, payload = { text: "Olá" };
    expect((await signedPayload(env, {}, row, payload, "instagram")).text).toBe("Ana - Humano\nOlá");
    expect((await signedPayload(env, {}, row, payload)).text).toBe("*Ana - Humano*\nOlá");
    expect((await signedPayload(env, {}, { ...row, actor: "automation:menu" }, payload, "instagram")).text).toBe("Olá");
  });
  it("mascara IDs sociais, handles e nomes nos campos e valores conhecidos", () => {
    const pii = createPiiMask(true, { subjectId: "5511999998888", username: "ana.perfil", displayName: "Ana Silva" });
    const original = "Ana Silva, @ana.perfil, 5511999998888";
    const masked = pii.mask(original);
    expect(masked).toContain("[SOCIAL_ID_"); expect(masked).toContain("[HANDLE_"); expect(masked).toContain("[NAME_");
    expect(masked).not.toContain("[TEL_"); expect(pii.restore(masked)).toBe(original);
    const fields = { subjectId: "998877", channel_subject_id: 123456789, username: "perfil", handle: "@perfil2", display_name: "Nome", displayName: "Outro nome" };
    const maskedFields = pii.maskValue(fields);
    for (const key of Object.keys(fields)) expect(maskedFields[key]).toMatch(/^\[(SOCIAL_ID|HANDLE|NAME)_\d+\]$/);
    expect(pii.restoreValue(maskedFields)).toEqual(fields);
    expect(createPiiMask(false, { subjectId: "5511999998888" }).mask(original)).toBe(original);
    expect(createPiiMask().mask("telefone +55 11 99999-8888")).toContain("[TEL_");
  });
});
