import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChannelRuntime } from "../src/channel-runtime";
import { all, batch, exec, one } from "../src/db";
import { hmac, setSecret } from "../src/security";
import { conversation, inbound } from "../src/service";
import { channelAccountsPort, channelImplementationReady } from "../src/channel-ports";
import { registeredChannelExtensions } from "../src/channel-extension-registry";
import { CHANNEL_REGISTRY } from "../src/channels";
import type { ChannelAccountImport, ChannelContext, ChannelId } from "../src/channel-contracts";
import { resolveCustomer } from "../src/customer/ports";
import { zernioInbound } from "../src/zernio";
import { processPush } from "../src/push";
import { refreshChannelSummaryStatements } from "../src/channel-accounts";
import { now, uid, type Env } from "../src/types";
import { api, application, bearer, bot, drain, fixture, quietCoordinator } from "./service-center-fixture";
import { measure } from "./d1-counter";

const secret = "cn-servidor-webhook-sintetico";
const profiles = new Set<string>();
let unexpected: string[];
beforeEach(() => {
  installChannelRuntime();
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    unexpected.push(String(input));
    throw new Error("Rede inesperada no teste de integração de canais.");
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

async function setup(channel: "whatsapp" | "instagram" | "facebook" = "instagram") {
  const f = await fixture();
  profiles.add(f.profile);
  const integration = uid(), account = uid().replaceAll("-", "").slice(0, 24);
  const remoteProfile = uid().replaceAll("-", "").slice(0, 24);
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,?,?,'zernio',?,?)",
    integration, f.profile, "Integração de teste", `zernio:${remoteProfile}`, remoteProfile, now());
  await exec(env, "UPDATE connections SET channel=?,account_label=?,config=? WHERE id=?",
    channel, channel === "whatsapp" ? "" : "@loja", JSON.stringify({ account_id: account, zernio_profile_id: remoteProfile, zernio_workspace_id: integration }), f.line);
  await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintetica", webhook_secret: secret });
  if (channel !== "whatsapp")
    await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,'@loja',?,?)",
      f.line, f.profile, integration, channel, account, remoteProfile, now(), now());
  return { ...f, channel, integration, account, remoteProfile };
}
type SocialFixture = Awaited<ReturnType<typeof setup>>;

// Esquema sintético do anexo: a conferir com a conta real, sem captura de cliente.
function event(f: SocialFixture, sentAt: string | null = new Date(now() - 1000).toISOString()) {
  return {
    id: uid(), event: "message.received", timestamp: new Date().toISOString(),
    account: { accountId: f.account, platform: f.channel, profileId: f.remoteProfile },
    conversation: { id: uid(), participantId: "5511999988776" },
    message: { platform: f.channel, platformMessageId: uid(), direction: "incoming", text: "Olá, preciso de ajuda.", sentAt,
      sender: { id: "5511999988776", name: "Ana", username: "ana.perfil", phoneNumber: "5511999988776" } },
  };
}
async function webhook(f: SocialFixture, body: unknown, signature?: string, accountRoute = true) {
  const raw = JSON.stringify(body);
  const response = await SELF.fetch(`https://test/webhooks/${accountRoute ? "zernio-accounts/" + f.integration : "zernio/" + f.line}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Zernio-Signature": signature ?? await hmac(secret, raw) }, body: raw,
  });
  await quietCoordinator(f.profile);
  return response;
}
async function received(f: SocialFixture, body = event(f)) {
  await accepted(await webhook(f, body, undefined, f.channel !== "whatsapp"));
  return conversation(env, (await one(env, "SELECT id FROM conversations WHERE connection_id=?", f.line)).id, f.profile);
}
async function accepted(response: Response) {
  expect(response.ok, `Webhook HTTP ${response.status}: ${await response.clone().text()}`).toBe(true);
}

/** Falha na fronteira do D1; serviço, identidade e lote permanecem reais. */
function failingInbox(mode: "before" | "inside" | "after"): Env {
  const sqls = new WeakMap<object, string>(), raw = new WeakMap<object, D1PreparedStatement>();
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, { get(stmt, prop) {
          if (prop === "bind") return (...values: unknown[]) => wrap(stmt.bind(...values));
          const value = Reflect.get(stmt, prop);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
        sqls.set(proxy, sql); raw.set(proxy, statement); return proxy;
      };
      return wrap(db.prepare(sql));
    };
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      const inbox = statements.some(s => /INSERT(?: OR IGNORE)? INTO inbox/.test(sqls.get(s) || ""));
      if (inbox && mode === "before") throw new Error("queda antes do lote");
      const writes = statements.map(s => raw.get(s) || s);
      if (inbox && mode === "inside") writes.push(db.prepare("INSERT INTO customer_assert(id,ok) VALUES('cn-failure',0)"));
      const result = await db.batch(writes);
      if (inbox && mode === "after") throw new Error("queda depois do lote");
      return result;
    };
    const value = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  } });
  return { ...env, DB } as Env;
}

describe("Worker e Coordinator com os ports reais", () => {
  it("instala somente os canais liberados", async () => {
    installChannelRuntime(); // A mesma composição pode ser usada por Worker e Coordinator.
    expect((await SELF.fetch("https://test/api/health")).status).toBe(200);
    const installed = [
      ...(["whatsapp", "instagram", "facebook"] as const).flatMap(channel =>
        Object.entries(CHANNEL_REGISTRY[channel].contexts)
          .filter(([context, rules]) => rules.enabled && channelImplementationReady(channel, context as ChannelContext))
          .map(([context]) => `${channel}/${context}`)),
      ...registeredChannelExtensions().map(extension => extension.key),
    ].sort();
    expect(installed).toEqual([
      "email/direct", "facebook/comment", "facebook/direct", "googlebusiness/review",
      "instagram/comment", "instagram/direct", "telegram/direct", "tiktok/direct",
      "whatsapp/direct", "whatsapp/group",
    ]);
    for (const key of installed) {
      const [channel, context] = key.split("/");
      expect(channelImplementationReady(channel as ChannelId, context as ChannelContext), key).toBe(true);
    }
    expect(channelImplementationReady("googlebusiness", "direct")).toBe(false);
    const unknown = "future_channel" as ChannelId;
    expect(channelImplementationReady(unknown)).toBe(false);
    const f = await fixture();
    profiles.add(f.profile);
    // Canal inexistente viola o DTO de propósito; a fachada deve recusá-lo.
    await expect(channelAccountsPort.importAccount(env, f.admin, f.profile, {
      commandId: uid(), integrationId: uid(), channel: unknown, accountId: uid(),
    } as unknown as ChannelAccountImport)).rejects.toMatchObject({ status: 503, code: "channel_not_ready" });
  });

  it.each(["instagram", "facebook"] as const)("%s: assinatura, concorrência e replay produzem uma identidade, inbox e mensagem", async channel => {
    const f = await setup(channel), body = event(f);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.service',json(?)) WHERE id=?", JSON.stringify({ mode: "human", menu_mode: "off" }), f.line);
    expect((await webhook(f, body, "assinatura-forjada")).status).toBe(403);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toEqual([]);
    const responses = await Promise.all([webhook(f, body), webhook(f, { ...body, id: uid() })]);
    for (const response of responses) await accepted(response);
    expect((await webhook(f, body)).ok).toBe(true);
    const c = await conversation(env, (await one(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).id, f.profile);
    expect(c).toMatchObject({ channel, channel_account_id: f.account, channel_subject_id: "5511999988776", external_namespace: `channel:${f.line}`, phone: null, verified_phone: null, customer_link_state: "ready" });
    expect(c.last_customer).toBe(Date.parse(body.message.sentAt!));
    const customer = await resolveCustomer(env, c);
    expect(customer).toMatchObject({ state: "ready", verifiedPhone: null, verifiedChannel: { channel } });
    const profileResponse = await api(await bearer(f.admin), `/profiles/${f.profile}/contacts/${customer.contactId}/profile`);
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json<any>();
    expect(profile.channels).toMatchObject([{ channel, account_label: "@loja", state: "ready" }]);
    expect(profile.merge.available).toBe(true);
    expect(profile.channels[0].subject_id).toBeUndefined();
    expect(profile.channels[0].account_id).toBeUndefined();
    for (const table of ["inbox", "messages", "contacts", "customer_channel_ids"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile), table).toHaveLength(1);
    expect(await all(env, "SELECT * FROM customer_phones WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT * FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
    await drain(f); // Motor real; linha humana sem menu não depende de IA ou rede.
    expect(await all(env, "SELECT status FROM inbox WHERE profile_id=?", f.profile)).toEqual([{ status: "done" }]);
    const processed = await conversation(env, c.id, f.profile);
    expect(processed.session).toBe(c.session);
    await drain(f);
    expect(await conversation(env, c.id, f.profile)).toMatchObject({ epoch: processed.epoch, session: processed.session });
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("ignora conta, plataforma e perfil divergentes sem criar ficha ou mídia", async () => {
    const f = await setup(), other = await setup(), body = event(f);
    const variants = [
      { ...body, account: { ...body.account, accountId: other.account } },
      { ...body, account: { ...body.account, profileId: other.remoteProfile } },
      { ...body, message: { ...body.message, platform: "facebook" } },
      { ...body, account: { ...body.account, platform: "tiktok" }, message: { ...body.message, platform: "tiktok" } },
    ];
    for (const variant of variants) expect((await webhook(f, variant)).ok).toBe(true);
    for (const table of ["inbox", "messages", "contacts", "customer_channel_ids", "media"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
  });

  it("preserva sujeito opaco longo e delimitadores sem normalização telefônica", async () => {
    const f = await setup(), body = event(f), subject = "perfil:/%:" + "é".repeat(600);
    body.conversation.participantId = subject;
    body.message.sender.id = subject;
    const c = await received(f, body);
    expect(c).toMatchObject({ external_id: `dm:${encodeURIComponent(subject)}`, channel_subject_id: subject, phone: null, verified_phone: null });
    expect(await one(env, "SELECT subject_id,state FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual({ subject_id: subject, state: "ready" });
    expect((await webhook(f, body)).ok).toBe(true);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", c.id)).toHaveLength(1);
    expect(await all(env, "SELECT phone FROM customer_phones WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("webhook simultâneo agenda uma única execução real do bot e retry não cria outra", async () => {
    const f = await setup(), target = await bot(f), body = event(f);
    body.message.text = "Gostaria de saber o prazo de atendimento.";
    await exec(env, "UPDATE connections SET config=json_set(config,'$.service',json(?)) WHERE id=?",
      JSON.stringify({ mode: "bot", bot_id: target, menu_mode: "off" }), f.line);
    const responses = await Promise.all([webhook(f, body), webhook(f, { ...body, id: uid() })]);
    for (const response of responses) await accepted(response);
    await drain(f); // Só processInbox: cria a execução, sem chamar o provedor de IA.
    const inbox = await all(env, "SELECT id,conversation_id,status FROM inbox WHERE profile_id=?", f.profile);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe("done");
    const runs = await all(env, "SELECT id,bot_id,conversation_id,source_key,status FROM bot_runs WHERE profile_id=?", f.profile);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ bot_id: target, conversation_id: inbox[0].conversation_id, source_key: `inbox:${inbox[0].id}`, status: "queued" });
    expect((await webhook(f, body)).ok).toBe(true);
    await drain(f);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([{ id: runs[0].id }]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", inbox[0].conversation_id)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("mídia social indisponível conserva texto e contexto sem salvar URL ou duplicar no retry", async () => {
    const f = await setup(), original = event(f);
    const body = { ...original, metadata: { story: { id: "story-sintetico", title: "Publicação da loja" } },
      message: { ...original.message, attachments: [{ type: "image", mimeType: "image/jpeg" }] } };
    const c = await received(f, body);
    expect(JSON.parse(c.channel_context || "{}")).toMatchObject({ context: "direct", story: { id: "story-sintetico" } });
    const message = await one(env, "SELECT text,attachments,content FROM messages WHERE conversation_id=?", c.id);
    expect(message.text).toContain(original.message.text);
    expect(message.text).toContain("Anexo indisponível");
    expect(message.attachments).toBe("[]");
    expect(JSON.parse(message.content).media_error).toBe(true);
    expect((await webhook(f, body)).ok).toBe(true);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", c.id)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("só WhatsApp mantém namespace, prova telefônica e replay de uma instrução", async () => {
    const f = await setup("whatsapp"), body = event(f);
    expect((await webhook(f, body, undefined, false)).status).toBe(202);
    expect((await webhook(f, body, undefined, false)).ok).toBe(true);
    const c = await conversation(env, (await one(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).id, f.profile);
    expect(c).toMatchObject({ external_namespace: `channel:${f.line}`, phone: "5511999988776", verified_phone: "5511999988776" });
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual([]);
    const measured = await measure(env, e => inbound(e, f.profile, { external_id: c.external_id, message_id: body.message.platformMessageId, phone: c.phone, text: body.message.text }, `channel:${f.line}`, f.line));
    expect(measured.result).toMatchObject({ duplicate: true, conversation_id: c.id });
    expect(measured.count).toMatchObject({ statements: 1, calls: 1 });
  });

  it.each(["before", "inside", "after"] as const)("falha %s do lote social conserva atomicidade e permite retry", async mode => {
    const f = await setup(), body = event(f), conn = await one(env, "SELECT * FROM connections WHERE id=?", f.line);
    const fail = failingInbox(mode);
    const attempt = zernioInbound(fail, conn, body, async data => Response.json(await inbound(fail, f.profile, data, `channel:${f.line}`, f.line)));
    if (mode === "after") expect(await (await attempt).json()).toMatchObject({ duplicate: true });
    else await expect(attempt).rejects.toThrow();
    for (const table of ["inbox", "messages", "contacts", "customer_channel_ids"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile), table).toHaveLength(mode === "after" ? 1 : 0);
    const c = await received(f, body);
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "ready", verifiedPhone: null });
    for (const table of ["inbox", "messages", "contacts", "customer_channel_ids"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile), table).toHaveLength(1);
  });

  it("timestamp antigo ou inválido não renova a janela pelo horário do retry", async () => {
    const f = await setup(), original = event(f, new Date(now() - 25 * 3600000).toISOString());
    const c = await received(f, original), token = await bearer(f.admin);
    for (const sentAt of [new Date(now() - 40 * 3600000).toISOString(), "inválido", null]) {
      const next = event(f, sentAt);
      next.conversation.id = original.conversation.id;
      expect((await webhook(f, next)).ok).toBe(true);
    }
    expect((await conversation(env, c.id, f.profile)).last_customer).toBe(c.last_customer);
    const detail = await (await api(token, `/profiles/${f.profile}/conversations/${c.id}`)).json<any>();
    expect(detail.capabilities.window).toMatchObject({ state: "human_text_only", canHumanText: true, canAutomation: false });
  });

  it("aplica edição, exclusão, leitura, entrega, reação e saída externa recebidas antes da mensagem", async () => {
    const f = await setup(), incoming = event(f), at = now() - 500;
    const change = (kind: string, offset: number) => ({ ...incoming, id: uid(), event: kind,
      timestamp: new Date(at + offset).toISOString(), statusAt: new Date(at + offset).toISOString(),
      message: { ...incoming.message, editedAt: new Date(at + offset).toISOString(), text: "Texto editado" } });
    const variants: any[] = [
      change("message.edited", 0), change("message.deleted", 1), change("message.read", 2), change("message.delivered", 3),
      { ...change("message.reaction", 4), reaction: { platformMessageId: incoming.message.platformMessageId, emoji: "👍", reactedAt: new Date(at + 4).toISOString() } },
      { ...change("message.sent", 5), message: { ...incoming.message, platformMessageId: uid(), direction: "outgoing", text: "Enviado no aplicativo da rede", recipient: { id: incoming.conversation.participantId } } },
    ];
    for (const variant of variants) expect((await webhook(f, variant)).ok).toBe(true);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toEqual([]);
    const c = await received(f, incoming);
    for (const variant of variants) expect((await webhook(f, variant)).ok).toBe(true);
    const messages = await all(env, "SELECT * FROM messages WHERE conversation_id=?", c.id);
    expect(messages).toHaveLength(2);
    const customer = messages.find(row => row.direction === "customer")!;
    expect(customer).toMatchObject({ text: "Mensagem apagada", delivery_status: "read", attachments: "[]" });
    expect(JSON.parse(customer.content)).toMatchObject({ deleted: true, reactions: { [incoming.conversation.participantId]: { emoji: "👍" } } });
    expect(messages.find(row => row.direction === "outbound")).toMatchObject({ author: "external:instagram", text: "Enviado no aplicativo da rede" });
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(variants.length);
    expect((await conversation(env, c.id, f.profile)).last_customer).toBe(Date.parse(incoming.message.sentAt!));
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  });
});

it("push preserva título só WhatsApp, prefixa canal uma vez e mantém a prévia mínima", async () => {
  const sent: any[] = [], counts: Array<{ statements: number; calls: number }> = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://push.example.test/v1/push" || request.method !== "POST") {
      unexpected.push(request.url); throw new Error("Push fora da fixture.");
    }
    const body = await request.json() as any;
    sent.push(...body.messages);
    return Response.json({ results: body.messages.map((m: any) => ({ token: m.token, status: "ok" })) });
  });
  for (const [channel, minimal] of [["whatsapp", false], ["instagram", false], ["instagram", true]] as const) {
    const f = await setup(channel);
    await batch(env, refreshChannelSummaryStatements(f.profile));
    const first = event(f), c = await received(f, first), token = `push:${uid()}`;
    await exec(env, "UPDATE contacts SET name='Ana' WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE conversations SET state='waiting',title='Ana' WHERE id=?", c.id);
    await exec(env, "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,'android','fcm',?,'Teste','1',?,'https://test',?,?)",
      uid(), f.admin.id, token, JSON.stringify([f.profile]), now(), now());
    await setSecret(env, "push:config", { mode: "gateway", gateway_url: "https://push.example.test", preview: minimal ? "minimal" : "preview", ticket_alert_minutes: 0 });
    await processPush(env, f.profile); // Cursor inicial não notifica o histórico.
    const next = event(f); next.conversation.id = first.conversation.id;
    expect((await webhook(f, next, undefined, channel !== "whatsapp")).ok).toBe(true);
    const measured = await measure(env, e => processPush(e, f.profile));
    counts.push(measured.count);
    expect(measured.count.sql.some(sql => sql.includes("zernio_channel_accounts"))).toBe(false);
    const notification = sent.filter(message => message.token === token);
    expect(notification).toHaveLength(1);
    expect(notification[0]).toMatchObject({ title: minimal ? "Vinki" : channel === "instagram" ? "Instagram · Ana" : "Ana", data: { channel, conversation_id: c.id } });
    expect(notification[0].channel).toBe("messages"); // Canal Android não é canal de atendimento.
    if (minimal) expect(notification[0].body).toBe("Nova mensagem");
  }
  expect(counts[1]).toMatchObject({ statements: counts[0].statements, calls: counts[0].calls });
});

describe("proveniência humana no comando público", () => {
  it("texto autenticado usa prova do servidor; replay não duplica entregas", async () => {
    const f = await setup(), c = await received(f, event(f, new Date(now() - 25 * 3600000).toISOString()));
    const token = await bearer(f.admin), path = `/profiles/${f.profile}/conversations/${c.id}/actions`;
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", f.admin.id, c.id);
    const key = uid(), body = { action: "reply", text: "Resposta escrita pela pessoa", origin: "bot", human: false,
      social_provenance: { version: 1, actorId: "invasor", commandId: "forjado", origin: "manual_text" } };
    const first = await api(token, path, "POST", body, key);
    await quietCoordinator(f.profile);
    expect(first.status).toBe(200);
    const replay = await api(token, path, "POST", body, key);
    await quietCoordinator(f.profile);
    expect(replay.status).toBe(200);
    const rows = await all(env, "SELECT * FROM outbox WHERE conversation_id=?", c.id);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.social_provenance).toMatchObject({ version: 1, origin: "manual_text", actorId: f.admin.id, conversationId: c.id, connectionId: f.line });
    expect(payload.social_provenance.commandId).not.toBe("forjado");
    expect(payload.social_delivery.messageTag).toBe("HUMAN_AGENT");
  });

  it("aplicação não forja os sete dias e pessoa não ultrapassa 168 horas", async () => {
    const f = await setup(), c = await received(f, event(f, new Date(now() - 25 * 3600000).toISOString()));
    const app = await application(f, ["conversations:read", "conversations:write"]);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", `app:${app.id}`, c.id);
    const path = `/profiles/${f.profile}/conversations/${c.id}/actions`;
    const forged = await api(app.token, path, "POST", { action: "reply", text: "Forjado", origin: "manual_text", human: true, messageTag: "HUMAN_AGENT",
      social_provenance: { version: 1, origin: "manual_text", actorId: f.admin.id, conversationId: c.id, connectionId: f.line, commandId: uid() } });
    await quietCoordinator(f.profile);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await forged.json<any>()).error.code).toBe("human_only");
    await exec(env, "UPDATE conversations SET owner=?,last_customer=? WHERE id=?", f.admin.id, now() - 168 * 3600000 - 1000, c.id);
    const closed = await api(await bearer(f.admin), path, "POST", { action: "reply", text: "Janela encerrada" });
    await quietCoordinator(f.profile);
    expect((await closed.json<any>()).error.code).toBe("window_closed");
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id)).toEqual([]);
  });

  it("transferir ao bot após 24 horas deixa a equipe com o motivo e não envia aviso automático", async () => {
    const f = await setup(), c = await received(f, event(f, new Date(now() - 25 * 3600000).toISOString()));
    const target = await bot(f);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", f.admin.id, c.id);
    const response = await api(await bearer(f.admin), `/profiles/${f.profile}/conversations/${c.id}/actions`, "POST", { action: "transfer", target: `bot:${target}` });
    await quietCoordinator(f.profile);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "waiting", owner: null, assigned_bot_id: null, channel_error: "human_only" });
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT text FROM messages WHERE conversation_id=? AND direction='note'", c.id)).toMatchObject([{ text: expect.stringContaining("janela de automação") }]);
  });

  it("transferir para setor após 24 horas confirma o estado sem enviar aviso automático", async () => {
    const f = await setup(), c = await received(f, event(f, new Date(now() - 25 * 3600000).toISOString()));
    const department = "atendimento-social";
    await exec(env, "UPDATE profiles SET settings=json_set(settings,'$.departments',json(?)) WHERE id=?",
      JSON.stringify([{ id: department, name: "Atendimento social", enabled: true, members: [f.admin.id] }]), f.profile);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", f.admin.id, c.id);
    const response = await api(await bearer(f.admin), `/profiles/${f.profile}/conversations/${c.id}/actions`, "POST", { action: "transfer", department_id: department });
    await quietCoordinator(f.profile);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "waiting", owner: null, department_id: department });
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    const notes = await all(env, "SELECT text FROM messages WHERE conversation_id=? AND direction='note'", c.id);
    expect(notes.some(note => /janela|texto humano|pessoa/i.test(note.text))).toBe(true);
    const changes = await all(env, "SELECT payload FROM events WHERE profile_id=? AND resource_id=? AND kind='conversation.updated'", f.profile, c.id);
    expect(changes.map(change => JSON.parse(change.payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "waiting", department_id: department, channel_error: "human_only", reason: expect.stringContaining("janela de automação") }),
    ]));
  });
});
