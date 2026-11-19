import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { now, uid, type Conversation } from "../src/types";
import { engineActor, setSecret, sha } from "../src/security";
import { sendChannelEmail } from "../src/email";
import { loadChannelOperationContext, prepareChannelAction } from "../src/channel-extension-kernel";
import { dispatchChannelDelivery, enqueueChannelPlan } from "../src/engine";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import type { ChannelExtension, ChannelOperationContext, ChannelOutboxRow, ExtensionConnection } from "../src/channel-c2-contracts";
import { completeEmail, createEmailProviderTransport, deliverEmail, emailReplySubject, encodeEmailMessage,
  prepareEmailSend } from "../src/c2/email-provider";
import { c2Fixture, denyNetwork, installTestExtension, quietCoordinator, type C2Fixture } from "./c2-fixtures";

// Formato do plano; a conferir com a conta real. Só esta fixture confirma raw/id/status.
const transport = createEmailProviderTransport({ format: "cloudflare-email-raw-v1", raw: true, responseId: true });
let beforePrepared: (() => Promise<void>) | null = null;
const controlledTransport = { async prepare(message: Parameters<typeof transport.prepare>[0]) {
  const result = await transport.prepare(message); await beforePrepared?.(); return result;
}, read: transport.read };
const extension: ChannelExtension = {
  ...CHANNEL_EXTENSION_STUBS["email/direct"],
  spec: { ...CHANNEL_EXTENSION_STUBS["email/direct"].spec, enabled: true,
    contexts: { direct: { enabled: true, bot: false, publicReply: false } }, text: { enabled: true, maxChars: 50_000 },
    media: { document: { receive: true, send: true, maxSendBytes: 8 * 1024 * 1024, mimeTypes: ["application/pdf"] } } },
  enabled: connection => JSON.parse(connection.config).c2_enabled === true,
  prepareSend: prepareEmailSend, deliver: ctx => deliverEmail(ctx, controlledTransport), complete: completeEmail,
  prepareAcknowledgement: async () => null,
};
const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => {
  // Alarmes ficam além do relógio real da máquina; cada caso controla o motor.
  const clock = Date.now() + 86_400_000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  network = denyNetwork();
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); beforePrepared = null; network.restore(); network.assertNone(); vi.restoreAllMocks();
}, 60_000);
async function setup() {
  const f = await c2Fixture("email"); profiles.add(f.profile); await installTestExtension(f, extension);
  const id = uid(), address = "pessoa+tag@example.test";
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
    channel,channel_account_id,channel_subject_id,channel_context,customer_link_state,last_customer,created,updated,state,owner)
    VALUES(?,?,?,?,?,?,'email',?,?,'{"version":1,"context":"direct"}','pending',?,?,?,'human',?)`,
    id, f.profile, f.line, `channel:${f.line}`, `email:${address}`, id, f.address, address, now(), now(), now(), f.admin.id);
  await setSecret(env, "email:config", { account_id: "a".repeat(32), token: "email-synthetic-private-token", from_address: f.address });
  return { f, id, address, ctx: await loadChannelOperationContext(env, f.admin, f.profile, { kind: "conversation", id }, uid()) };
}
async function received(f: C2Fixture, conversation: string, subject: string, messageId: string, created: number) {
  const id = uid();
  await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'inbound','pessoa+tag@example.test','Entrada corrente',?)",
    id, f.profile, conversation, created);
  await exec(env, `INSERT INTO email_channel_inbox(id,profile_id,connection_id,event_key,sender,recipient,rfc_message_id,
    raw_hash,raw_size,state,next_at,conversation_id,message_id,metadata,created,updated)
    VALUES(?,?,?,?,?,?,?,? ,0,'processed',?,?,?,?,?,?)`, id, f.profile, f.line, id, "pessoa+tag@example.test", f.address,
    messageId, id, created, conversation, id, JSON.stringify({ subject, references: ["<ancestor@example.test>"] }), created, created);
  return id;
}
const action = { type: "email.send" as const, text: "Olá, recebemos sua mensagem com atenção.", subject: "Re: Pedido 123" };
const outgoing = { from: "atendimento@example.test", to: "pessoa@example.test", subject: "Pedido 123 — https://example.test/pedido",
  text: "Olá, ação e coração.", messageId: "<local@example.test>", inReplyTo: "<incoming@example.test>", references: ["<incoming@example.test>"] };
function providerReply(reply: () => Promise<Response>) {
  return vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/email/sending/send` || init?.method !== "POST") {
      network.unexpected.push("chamada externa inesperada"); throw new Error("Rede inesperada na fixture de e-mail.");
    }
    return reply();
  });
}

describe("c2-email: contrato REST e MIME de saída", { timeout: 60_000 }, () => {
  it("canal não usado não lê D1, R2 ou configuração", async () => {
    const ctx = { connection: { channel: "whatsapp", kind: "zernio" }, env: new Proxy({}, { get() { throw new Error("I/O indevido"); } }) } as unknown as ChannelOperationContext;
    await expect(prepareEmailSend(ctx, action)).rejects.toMatchObject({ code: "channel_not_ready" });
    await expect(createEmailProviderTransport().prepare(outgoing)).rejects.toMatchObject({ code: "provider_contract_unverified" });
  });
  it("recusa contrato não confirmado antes de ler a configuração ou chamar rede", async () => {
    const poison = new Proxy({}, { get() { throw new Error("Leitura de ambiente indevida"); } });
    const connection = { channel: "email", kind: "email", config: JSON.stringify({ address: outgoing.from }) } as ExtensionConnection;
    const beforeFetch = vi.fn();
    await expect(sendChannelEmail(poison as typeof env, connection, outgoing, beforeFetch, createEmailProviderTransport()))
      .rejects.toMatchObject({ code: "provider_contract_unverified" });
    expect(beforeFetch).not.toHaveBeenCalled();
  });
  it("preserva assunto, UTF-8, encadeamento e anexo no MIME efetivamente transmitido", async () => {
    const encoded = await transport.prepare({ ...outgoing, automatic: true,
      attachments: [{ name: "ação.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("%PDF-fixture") }] });
    expect(Object.keys(encoded.body).sort()).toEqual(["from", "raw", "to"]);
    const raw = new TextDecoder().decode(encoded.encodedMessage);
    expect(atob(String(encoded.body.raw))).toBe(String.fromCharCode(...encoded.encodedMessage));
    expect(raw).toContain("Message-ID: <local@example.test>\r\nIn-Reply-To: <incoming@example.test>");
    expect(raw).toContain("Auto-Submitted: auto-replied");
    expect(raw).toContain("filename*=UTF-8''a%C3%A7%C3%A3o.pdf");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).not.toContain("text/html");
    expect(emailReplySubject("Re: re: Pedido 123")).toBe("Re: Pedido 123");
  });
  it("recusa CRLF, NUL, cabeçalhos excessivos e tamanho codificado antes do envio", async () => {
    for (const subject of ["Assunto\r\nBcc: outro@example.test", "Assunto\u0000oculto", "a".repeat(201)])
      await expect(encodeEmailMessage({ ...outgoing, subject })).rejects.toMatchObject({ code: "subject_invalid" });
    await expect(encodeEmailMessage({ ...outgoing, messageId: "<a@example.test>\r\nX: forged" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(encodeEmailMessage({ ...outgoing, references: Array.from({ length: 51 }, (_, i) => `<${i}@example.test>`) })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(encodeEmailMessage({ ...outgoing,
      attachments: [{ name: "large.pdf", mimeType: "application/pdf", bytes: new Uint8Array(20_000_000) }] }))
      .rejects.toMatchObject({ code: "attachment_too_large" });
  });
  it("aceitação não significa entrega postal e resposta ambígua permanece indeterminada", async () => {
    expect(await transport.read(Response.json({ success: true, result: { id: "remote-123", status: "accepted" } })))
      .toEqual({ kind: "sent", externalId: "remote-123", context: { accepted: true, mailboxDeliveryConfirmed: false } });
    for (const response of [Response.json({ success: true }), Response.json({ success: true, result: { id: "id", status: "delivered" } }),
      new Response("email-synthetic-private-token", { status: 502 }), Response.json({ success: false }, { status: 503 })]) {
      const result = await transport.read(response);
      expect(result).toEqual({ kind: "unknown", code: "provider_unknown" });
      expect(JSON.stringify(result)).not.toContain("email-synthetic-private-token");
    }
  });
  it("429 só agenda retry com recusa explícita; não interpreta corpo remoto como erro público", async () => {
    const fixed = createEmailProviderTransport({ format: "cloudflare-email-raw-v1", raw: true, responseId: true }, () => 10_000);
    expect(await fixed.read(Response.json({ success: false, errors: [{ message: "secret" }] }, { status: 429, headers: { "Retry-After": "120" } })))
      .toEqual({ kind: "retry", notBefore: 130_000, code: "rate_limited" });
    expect(await fixed.read(Response.json({ success: true }, { status: 429 }))).toEqual({ kind: "unknown", code: "provider_unknown" });
    expect(await fixed.read(Response.json({ success: false, result: { id: "maybe-accepted" } }, { status: 429 })))
      .toEqual({ kind: "unknown", code: "provider_unknown" });
  });
});

describe("c2-email: reservas e outbox reais", { timeout: 60_000 }, () => {
  it("encadeia com a entrada do mesmo assunto e não mistura threads do remetente", async () => {
    const { f, id, ctx } = await setup();
    await received(f, id, "Pedido 123", "<pedido@example.test>", now() - 1000);
    await received(f, id, "Outro assunto", "<outro@example.test>", now());
    const plan = await prepareEmailSend(ctx, action);
    expect(plan.deliveries[0].payload).toMatchObject({ to: "pessoa+tag@example.test", inReplyTo: "<pedido@example.test>",
      references: ["<ancestor@example.test>", "<pedido@example.test>"] });
    const unrelated = await prepareEmailSend(ctx, { ...action, subject: "Novo tema" });
    expect(unrelated.deliveries[0].payload).not.toHaveProperty("inReplyTo");
    const longSubject = "a".repeat(200);
    await received(f, id, longSubject, "<long@example.test>", now() + 1);
    expect((await prepareEmailSend(ctx, { ...action, subject: emailReplySubject(longSubject) })).deliveries[0].payload)
      .toMatchObject({ inReplyTo: "<long@example.test>" });
  });
  it("reserva junto da outbox, repete sem consumir cota e confirma mensagem no mesmo lote", async () => {
    const { ctx, f } = await setup();
    const plan = await prepareChannelAction(ctx, action), id = await enqueueChannelPlan(ctx, plan, action);
    expect(await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action)).toBe(id);
    expect(await all(env, "SELECT id FROM email_log WHERE profile_id=? AND purpose='channel.email'", f.profile)).toHaveLength(1);
    const spy = providerReply(async () => Response.json({ success: true, result: { id: "provider-123", status: "queued" } }));
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    await dispatchChannelDelivery(env, row); await dispatchChannelDelivery(env, row);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await one(env, "SELECT status,completion_handled FROM outbox WHERE id=?", id)).toMatchObject({ status: "sent", completion_handled: 1 });
    expect(await one(env, "SELECT status,provider_message_id FROM email_log WHERE id=?", id)).toMatchObject({ status: "accepted", provider_message_id: "provider-123" });
    const messages = await all(env, "SELECT content FROM messages WHERE source_key=?", `delivery:${id}`);
    expect(messages).toHaveLength(1); expect(JSON.parse(messages[0].content)).toMatchObject({ email: { mailboxDeliveryConfirmed: false } });
  });
  it("resultado após possível envio fica unknown e não é repetido automaticamente", async () => {
    const { ctx } = await setup();
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    const next = { ...ctx, commandId: uid() }, nextId = await enqueueChannelPlan(next, await prepareChannelAction(next, action), action);
    const spy = providerReply(async () => { throw new Error("secret from provider"); });
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    await dispatchChannelDelivery(env, row); await dispatchChannelDelivery(env, row);
    await dispatchChannelDelivery(env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", nextId))!);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await one(env, "SELECT status,error FROM outbox WHERE id=?", id)).toMatchObject({ status: "unknown", error: "provider_unknown" });
    expect(await one(env, "SELECT status FROM email_log WHERE id=?", id)).toMatchObject({ status: "unknown" });
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", nextId)).toMatchObject({ status: "pending" });
    expect(await all(env, "SELECT id FROM messages WHERE source_key=?", `delivery:${id}`)).toHaveLength(0);
  });
  it("reconfere bloqueio e autorização antes de qualquer chamada remota", async () => {
    const { ctx, f, address, id: conversationId } = await setup();
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    await exec(env, "INSERT INTO email_channel_blocks(profile_id,connection_id,kind,value,actor_id,created) VALUES(?,?,'address',?,?,?)",
      f.profile, f.line, address, f.admin.id, now());
    await dispatchChannelDelivery(env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!);
    expect(await one(env, "SELECT status,error FROM outbox WHERE id=?", id)).toMatchObject({ status: "failed", error: "recipient_blocked" });
    await exec(env, "DELETE FROM email_channel_blocks WHERE connection_id=?", f.line);
    const second = { ...ctx, commandId: uid() }, nextId = await enqueueChannelPlan(second, await prepareChannelAction(second, action), action);
    beforePrepared = async () => { await exec(env, "UPDATE conversations SET owner=NULL WHERE id=?", conversationId); };
    await dispatchChannelDelivery(env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", nextId))!);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", nextId)).toMatchObject({ status: "failed" });
  });
  it("confirmação automática reserva só uma por remetente/hora e exige ativação explícita", async () => {
    const { ctx, f, id } = await setup();
    const bot = { ...ctx, authorization: { ...ctx.authorization, actor: engineActor(f.profile, ""), origin: "bot" as const } };
    const acknowledgement = { type: "email.acknowledgement" as const, text: "Recebemos sua mensagem.", subject: action.subject };
    const messageId = await received(f, id, action.subject, "<ack@example.test>", now());
    await expect(prepareEmailSend(bot, acknowledgement, messageId)).rejects.toMatchObject({ code: "human_only" });
    bot.connection = { ...bot.connection, config: JSON.stringify({ ...JSON.parse(bot.connection.config), auto_ack_enabled: true }) };
    await exec(env, "UPDATE connections SET config=? WHERE id=?", bot.connection.config, f.line);
    await expect(prepareEmailSend(bot, acknowledgement)).rejects.toMatchObject({ code: "sender_unverified" });
    const plan = await prepareEmailSend(bot, acknowledgement, messageId);
    expect(plan.deliveries[0].payload.automatic).toBe(true);
    await enqueueChannelPlan(bot, plan, acknowledgement);
    await expect(prepareEmailSend({ ...bot, commandId: uid() }, acknowledgement, messageId)).rejects.toMatchObject({ code: "quota_exhausted" });
    await expect(prepareEmailSend(bot, { ...acknowledgement, type: "email.auto-reply" }, messageId)).rejects.toMatchObject({ code: "human_only" });
  });
  it("falha R2 anterior à rede mantém reserva e não confirma entrega", async () => {
    const { ctx, f } = await setup(), mediaId = uid();
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'arquivo.pdf','application/pdf',10,?,?,?)",
      mediaId, f.profile, `missing/${mediaId}`, f.admin.id, now());
    const withAttachment = { ...action, attachments: [{ mediaId, kind: "document" as const, mimeType: "application/pdf", bytes: 10 }] };
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, withAttachment), withAttachment);
    await dispatchChannelDelivery(env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!);
    expect(await one(env, "SELECT status,provider_message_id FROM email_log WHERE id=?", id)).toMatchObject({ status: "failed", provider_message_id: null });
    expect(await all(env, "SELECT id FROM messages WHERE source_key=?", `delivery:${id}`)).toHaveLength(0);
  });
  it("dez reservas por remetente resistem à concorrência e fazem rollback da perdedora", async () => {
    const { ctx, f, address } = await setup(), toHash = await sha(address);
    await batch(env, Array.from({ length: 9 }, (_, i) => [
      "INSERT INTO email_log(id,profile_id,purpose,to_masked,to_hash,status,key,created) VALUES(?,?,'channel.email','p***@example.test',?,'unknown',?,?)",
      [uid(), f.profile, toHash, `seed:${i}`, now()],
    ] as [string, unknown[]]));
    const first = { ...ctx, commandId: uid() }, second = { ...ctx, commandId: uid() };
    const plans = await Promise.all([prepareChannelAction(first, action), prepareChannelAction(second, action)]);
    const results = await Promise.allSettled([enqueueChannelPlan(first, plans[0], action), enqueueChannelPlan(second, plans[1], action)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await all(env, "SELECT id FROM email_log WHERE profile_id=?", f.profile)).toHaveLength(10);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND kind='channel'", f.profile)).toHaveLength(1);
    await expect(prepareEmailSend({ ...ctx, commandId: uid() }, action)).rejects.toMatchObject({ code: "quota_exhausted" });
  });
  it("cota da área é separada de módulos e transcrição, e falha D1 não deixa reserva parcial", async () => {
    const { ctx, f } = await setup();
    await batch(env, Array.from({ length: 200 }, (_, i) => [
      "INSERT INTO email_log(id,profile_id,purpose,to_masked,to_hash,status,key,created) VALUES(?,?,'channel.email','p***@example.test',?,'reserved',?,?)",
      [uid(), f.profile, `other:${i}`, `seed:${i}`, now()],
    ] as [string, unknown[]]));
    await expect(prepareEmailSend(ctx, action)).rejects.toMatchObject({ code: "quota_exhausted" });
    await exec(env, "UPDATE email_log SET purpose='conversation.transcript' WHERE profile_id=?", f.profile);
    const plan = await prepareChannelAction(ctx, action);
    const broken = { ...plan, statements: [["INSERT INTO customer_assert(id,ok) VALUES(?,0)", [uid()]]] as [string, unknown[]][] };
    await expect(enqueueChannelPlan(ctx, broken, action)).rejects.toBeDefined();
    expect(await all(env, "SELECT id FROM email_log WHERE profile_id=? AND purpose='channel.email'", f.profile)).toHaveLength(0);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND kind='channel'", f.profile)).toHaveLength(0);
  });
});
