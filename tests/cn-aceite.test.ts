import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChannelRuntime } from "../src/channel-runtime";
import { all, batch, exec, one } from "../src/db";
import { configureEmail } from "../src/email";
import { hmac, setSecret } from "../src/security";
import { now, uid } from "../src/types";
import { api, application, bearer, drain, fixture, quietCoordinator } from "./service-center-fixture";

// Prova pelas rotas públicas, com Worker, Coordinator, identidade e D1 reais.
// Somente discovery Zernio e envio de e-mail são fronteiras simuladas.
// Estes eventos representam o anexo; não são capturas de uma conta real.
const SECRET = "cn-aceite-assinatura-sintetica";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const MAIL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`;
const profiles = new Set<string>();
let unexpected: string[], sent: any[], discoveryCalls: number;
let mailFailure = false;
const discovered = new Map<string, Record<string, string>>();

beforeEach(async () => {
  installChannelRuntime();
  unexpected = []; sent = []; discoveryCalls = 0; mailFailure = false;
  discovered.clear();
  await exec(env, "DELETE FROM secrets WHERE id IN ('email:config','push:config')");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const remote = url.searchParams.get("profileId") ?? "";
    const accounts = discovered.get(remote), channel = url.searchParams.get("platform") ?? "";
    if (url.origin === "https://zernio.com" && url.pathname === "/api/v1/accounts" &&
        request.method === "GET" && request.headers.get("Authorization") === "Bearer cn-chave-sintetica" &&
        accounts && ["instagram", "facebook"].includes(channel)) {
      discoveryCalls++;
      return Response.json({ accounts: [{ _id: accounts[channel], platform: channel, profileId: remote,
        username: `@loja.${channel}`, isActive: true, inboxEnabled: true }], pagination: { nextCursor: null } });
    }
    if (request.url === MAIL && request.method === "POST") {
      const body = await request.json() as any;
      sent.push(body);
      if (mailFailure) throw new Error("Simulação: conexão caiu após o provedor receber a requisição.");
      return Response.json({ success: true, result: { delivered: [body.to], queued: [], permanent_bounces: [] } });
    }
    unexpected.push(`${request.method} ${request.url}`);
    throw new Error(`Rede inesperada no aceite: ${request.method} ${request.url}`);
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  await exec(env, "DELETE FROM secrets WHERE id IN ('email:config','push:config')");
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

const objectId = () => uid().replaceAll("-", "").slice(0, 24);
async function setup() {
  const f = await fixture(); profiles.add(f.profile);
  const integration = uid(), remote = objectId();
  const accounts = { whatsapp: objectId(), instagram: objectId(), facebook: objectId() };
  discovered.set(remote, accounts);
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Aceite sintético',?,'zernio',?,?)",
    integration, f.profile, `zernio:${remote}`, remote, now());
  await setSecret(env, `zernio-account:${integration}`, { api_key: "cn-chave-sintetica", webhook_secret: SECRET });
  await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ account_id: accounts.whatsapp,
    zernio_workspace_id: integration, zernio_profile_id: remote, service: { mode: "human", menu_mode: "off" } }), f.line);
  return { ...f, integration, remote, accounts, token: await bearer(f.admin) };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function request(f: Fixture, path: string, body: unknown, key = uid(), token = f.token, method = "POST") {
  const response = await api(token, `/profiles/${f.profile}${path}`, method, body, key);
  await quietCoordinator(f.profile);
  return response;
}
async function ok(response: Response) {
  const body = await response.json<any>();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}
async function get(f: Fixture, path: string, token = f.token) {
  return ok(await api(token, `/profiles/${f.profile}${path}`));
}
async function mail(f: Fixture) {
  await configureEmail(env, f.admin, { account_id: ACCOUNT, token: "cn-email-sintetico-1234567890",
    from_address: "atendimento@example.test", from_name: "Loja sintética" });
}
async function importChannel(f: Fixture, channel: "instagram" | "facebook") {
  const discovery = await ok(await request(f, `/router/accounts/${f.integration}/discover-channels`, {}));
  expect(discovery.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ channel, importable: true })]));
  const path = `/router/accounts/${f.integration}/channel-connections`, key = uid();
  const body = { channel, accountId: f.accounts[channel] };
  const imported = await ok(await request(f, path, body, key)), calls = discoveryCalls;
  expect((await ok(await request(f, path, body, key))).connection.id).toBe(imported.connection.id);
  expect(discoveryCalls).toBe(calls);
  expect(imported.connection).toMatchObject({ channel, status: "paused" });
  // Configuração da fixture: linha humana já verificada, sem menus/IA.
  await exec(env, "UPDATE connections SET status='active',config=json_set(config,'$.service',json(?)) WHERE id=?",
    JSON.stringify({ mode: "human", menu_mode: "off" }), imported.connection.id);
  expect(await all(env, "SELECT connection_id FROM meta_numbers WHERE connection_id=?", imported.connection.id)).toEqual([]);
  return imported.connection.id as string;
}
function event(f: Fixture, channel: "whatsapp" | "instagram" | "facebook", text = "Olá da origem social", ageHours = 0) {
  const subject = channel === "whatsapp" ? "5511999988776" : "sujeito:opaco:5511999988776";
  return { id: uid(), event: "message.received", timestamp: new Date().toISOString(),
    account: { accountId: f.accounts[channel], platform: channel, profileId: f.remote },
    conversation: { id: uid(), participantId: subject },
    message: { platform: channel, platformMessageId: uid(), direction: "incoming", text,
      sentAt: new Date(now() - ageHours * 3600000 - 1000).toISOString(),
      sender: { id: subject, name: "Ana", username: "ana.sintetica", phoneNumber: "5511999988776" } } };
}
async function webhook(f: Fixture, body: ReturnType<typeof event>) {
  const raw = JSON.stringify(body);
  const route = body.account.platform === "whatsapp" ? `zernio/${f.line}` : `zernio-accounts/${f.integration}`;
  const response = await SELF.fetch(`https://test/webhooks/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Zernio-Signature": await hmac(SECRET, raw) }, body: raw });
  await quietCoordinator(f.profile);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}
async function receive(f: Fixture, channel: "whatsapp" | "instagram" | "facebook", text?: string, ageHours = 0) {
  const body = event(f, channel, text, ageHours);
  await webhook(f, body); await drain(f);
  const row = await one(env, "SELECT id FROM conversations WHERE profile_id=? AND external_id=?", f.profile,
    channel === "whatsapp" ? body.conversation.participantId : `dm:${encodeURIComponent(body.conversation.participantId)}`);
  expect(row).toBeTruthy();
  return { body, detail: await get(f, `/conversations/${row.id}`) };
}
async function merge(f: Fixture, source: string, target: string) {
  const preview = await ok(await request(f, `/contacts/${source}/merge-preview`, { targetId: target }));
  expect(preview.blockers).toEqual([]);
  const body = { targetId: target, sourceVersion: preview.source.version, targetVersion: preview.target.version,
    previewToken: preview.previewToken, fieldChoices: {} };
  const key = uid(), path = `/contacts/${source}/merge`;
  const result = await ok(await request(f, path, body, key));
  expect((await ok(await request(f, path, body, key))).id).toBe(result.id);
  expect(result).toMatchObject({ sourceId: source, targetId: target, state: "applied" });
  return result;
}
const previewBody = { destination: { kind: "self" }, range: { kind: "session" } };

describe("aceite encadeado pelas rotas reais", () => {
  it("só WhatsApp preserva DTOs antigos, namespace e identidade; transcrição é a ação adicional autorizada", async () => {
    const f = await setup(), { body, detail } = await receive(f, "whatsapp", "Olá do WhatsApp");
    const id = detail.conversation.id;
    expect(detail).toMatchObject({ channel: "whatsapp", multichannel: false, other_conversations: [],
      conversation: { external_namespace: `channel:${f.line}`, phone: "5511999988776", verified_phone: "5511999988776" } });
    const status = await get(f, "/status");
    expect(status).toMatchObject({ connected_channels: ["whatsapp"], conversation_channels: ["whatsapp"], multichannel: false,
      email_transcript: { available: false } });
    expect((await get(f, "/conversations")).data.map((row: any) => row.id)).toEqual([id]);
    const caps = await get(f, `/connections/${f.line}/capabilities`);
    for (const key of ["text", "image", "document", "reply", "reaction", "groups", "upgrade_required"])
      expect(typeof caps[key], key).toBe("boolean");
    expect(caps).toMatchObject({ channel: "whatsapp", multichannel: false, modules: true, templates: true });
    await webhook(f, body); await webhook(f, body);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='customer'", id)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual([]);
    await mail(f);
    expect((await get(f, `/conversations/${id}`)).email_transcript.available).toBe(true);
    const preview = await ok(await request(f, `/conversations/${id}/email/preview`, previewBody));
    const key = uid(), send = { previewToken: preview.previewToken };
    expect(await ok(await request(f, `/conversations/${id}/email`, send, key))).toMatchObject({ status: "sent" });
    await ok(await request(f, `/conversations/${id}/email`, send, key));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Olá do WhatsApp");
    expect(discoveryCalls).toBe(0);
  }, 60_000);

  it.each(["instagram", "facebook"] as const)("%s: importa, recebe em paralelo, junta/desfaz, mantém escopo e exporta só esta conversa", async channel => {
    const f = await setup(), wa = await receive(f, "whatsapp", "SEGREDO EXCLUSIVO WHATSAPP");
    const line = await importChannel(f, channel), body = event(f, channel);
    await Promise.all([webhook(f, body), webhook(f, { ...body, id: uid() })]);
    await drain(f);
    const row = await one(env, "SELECT id FROM conversations WHERE connection_id=?", line);
    const detail = await get(f, `/conversations/${row.id}`), id = detail.conversation.id;
    expect(detail).toMatchObject({ channel, multichannel: true, account_label: `@loja.${channel}`,
      conversation: { channel, phone: null, verified_phone: null, customer_link_state: "ready", external_namespace: `channel:${line}` } });
    for (const table of ["inbox", "messages"]) expect(await all(env, `SELECT id FROM ${table} WHERE conversation_id=?`, id)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
    await webhook(f, body);
    expect(await all(env, "SELECT id FROM inbox WHERE conversation_id=?", id)).toHaveLength(1);
    const source = detail.contact.id, target = wa.detail.contact.id;
    expect(source).not.toBe(target); // Nome/foto/phoneNumber do evento não juntam automaticamente.
    const profile = await get(f, `/contacts/${source}/profile`);
    expect(profile.channels).toMatchObject([{ channel, state: "ready" }]);
    expect(JSON.stringify(profile.channels)).not.toContain(body.conversation.participantId);
    expect((await get(f, `/conversations?channel=${channel}`)).data.map((c: any) => c.id)).toEqual([id]);
    expect((await get(f, "/status")).connected_channels).toEqual(expect.arrayContaining(["whatsapp", channel]));
    expect(await get(f, `/connections/${line}/capabilities`)).toMatchObject({ channel, modules: false, templates: false, text_limit: 640 });
    const invalid = await request(f, "/connections", { name: "Social digitado", kind: "zernio", channel, config: {} });
    expect(invalid.status).toBeGreaterThanOrEqual(400);

    // O número é globalmente único. A fixture não pode reservar '10001', que
    // pode já existir; a rota real numera e vincula o protocolo no mesmo lote.
    const ticket = await ok(await request(f, "/tickets", {
      conversation_id: wa.detail.conversation.id, title: "PROTOCOLO SÓ WHATSAPP",
    }));
    expect(await one(env, "SELECT contact_id,conversation_id FROM customer_records WHERE profile_id=? AND module_id='tickets' AND kind='ticket' AND record_id=?",
      f.profile, ticket.id)).toEqual({ contact_id: target, conversation_id: wa.detail.conversation.id });
    const first = await merge(f, source, target);
    const joined = await get(f, `/conversations/${id}`);
    expect(joined.other_conversations.map((c: any) => c.id)).toContain(wa.detail.conversation.id);
    expect(joined.conversation.verified_phone).toBeNull();
    const history = await get(f, `/contacts/${target}/history`);
    expect(history.items.map((item: any) => item.target.id)).toEqual(expect.arrayContaining([id, wa.detail.conversation.id, ticket.id]));
    const originHistory = await get(f, `/conversations/${id}/customer-history`);
    expect(originHistory.items.map((item: any) => item.target.id)).toContain(id);
    expect(originHistory.items.map((item: any) => item.target.id)).not.toContain(wa.detail.conversation.id);
    expect(originHistory.items.map((item: any) => item.target.id)).not.toContain(ticket.id);
    const undoKey = uid(), undoPath = `/contacts/${source}/merges/${first.id}/undo`;
    expect(await ok(await request(f, undoPath, {}, undoKey))).toMatchObject({ state: "undone" });
    await ok(await request(f, undoPath, {}, undoKey));
    expect((await get(f, `/conversations/${id}`)).contact.id).toBe(source);
    const second = await merge(f, source, target);
    // A resposta HTTP é o resultado real da consulta que será enviada ao cliente.
    const protocols = await ok(await request(f, `/conversations/${id}/actions`, { action: "protocols", number: ticket.number }));
    expect(protocols.data).toEqual([]);
    const waProtocols = await ok(await request(f, `/conversations/${wa.detail.conversation.id}/actions`, { action: "protocols", number: ticket.number }));
    expect(waProtocols.data).toMatchObject([{ number: ticket.number }]);
    const blockedModule = await request(f, `/conversations/${id}/actions`, { action: "form" });
    expect(blockedModule.status).toBe(422);
    expect((await blockedModule.json<any>()).error.code).toBe("unsupported_content");
    expect(await all(env, "SELECT id FROM web_steps WHERE conversation_id=?", id)).toEqual([]);

    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'note',?,'NOTA INTERNA SECRETA',?)", uid(), f.profile, id, f.admin.id, now());
    await mail(f);
    const preview = await ok(await request(f, `/conversations/${id}/email/preview`, previewBody));
    expect(preview.messageCount).toBe(1);
    const key = uid(), input = { previewToken: preview.previewToken };
    const results = await Promise.all([request(f, `/conversations/${id}/email`, input, key), request(f, `/conversations/${id}/email`, input, key)]);
    const replies = await Promise.all(results.map(ok));
    expect(new Set(replies.map(r => r.id)).size).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(body.message.text);
    for (const secret of ["SEGREDO EXCLUSIVO WHATSAPP", "NOTA INTERNA SECRETA", "PROTOCOLO SÓ WHATSAPP"])
      expect(sent[0].text + sent[0].html).not.toContain(secret);
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=? AND purpose='conversation.email'", f.profile)).toEqual({ n: 1 });
    const changed = await request(f, `/contacts/${source}/merges/${second.id}/undo`, {});
    expect(changed.status).toBe(409);
    expect((await changed.json<any>()).error.code).toBe("merge_changed");
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  }, 60_000);

  it("janela de 25 h exige texto humano autenticado; 168 h bloqueia até cliente antigo", async () => {
    const f = await setup(); await importChannel(f, "instagram");
    const { detail } = await receive(f, "instagram", "Mensagem de ontem", 25), id = detail.conversation.id;
    expect(detail.capabilities.window).toMatchObject({ state: "human_text_only", canAutomation: false, canHumanText: true });
    const app = await application(f, ["conversations:read", "conversations:write"]);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", `app:${app.id}`, id);
    const forged = await request(f, `/conversations/${id}/actions`, { action: "reply", text: "Automação forjada", human: true,
      origin: "manual_text", messageTag: "HUMAN_AGENT" }, uid(), app.token);
    expect((await forged.json<any>()).error.code).toBe("human_only");
    await exec(env, "UPDATE conversations SET owner=? WHERE id=?", f.admin.id, id);
    const key = uid(), text = { action: "reply", text: "Texto humano sem campos novos do aplicativo" };
    await ok(await request(f, `/conversations/${id}/actions`, text, key));
    await ok(await request(f, `/conversations/${id}/actions`, text, key));
    const rows = await all(env, "SELECT payload FROM outbox WHERE conversation_id=?", id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ social_provenance: { origin: "manual_text", actorId: f.admin.id }, social_delivery: { messageTag: "HUMAN_AGENT" } });
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now() - 168 * 3600000 - 1000, id);
    const closed = await request(f, `/conversations/${id}/actions`, { action: "reply", text: "Cliente antigo, sem janela no DTO" });
    expect((await closed.json<any>()).error.code).toBe("window_closed");
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=?", id)).toHaveLength(1);
  }, 60_000);

  it("reautoriza área e ficha: operador não importa, aplicação não junta e área alheia fica oculta", async () => {
    const f = await setup(), foreign = await setup();
    const own = await receive(f, "whatsapp"), other = await receive(foreign, "whatsapp");
    const member = await bearer(f.member);
    expect((await request(f, `/router/accounts/${f.integration}/discover-channels`, {}, uid(), member)).status).toBe(403);
    const app = await application(f, ["contacts:read", "contacts:write", "contacts:merge"]);
    expect((await request(f, `/contacts/${own.detail.contact.id}/merge-preview`, { targetId: own.detail.contact.id }, uid(), app.token)).status).toBe(403);
    expect((await request(f, `/contacts/${own.detail.contact.id}/merge-preview`, { targetId: other.detail.contact.id })).status).toBe(404);
    expect((await api(f.token, `/profiles/${f.profile}/contacts/${other.detail.contact.id}/profile`)).status).toBe(404);
    expect((await api(f.token, `/profiles/${f.profile}/conversations/${other.detail.conversation.id}`)).status).toBe(404);
    expect((await request(f, `/conversations/${other.detail.conversation.id}/email/preview`, previewBody)).status).toBe(404);
    expect(await all(env, "SELECT id FROM customer_merges WHERE profile_id=?", f.profile)).toEqual([]);
    expect(sent).toEqual([]);
    expect(discoveryCalls).toBe(0);
  }, 60_000);

  it.each(["ator", "área"] as const)("cota de %s é reservada atomicamente por comandos concorrentes e replay não reserva outra", async scope => {
    const f = await setup(), { detail } = await receive(f, "whatsapp"); await mail(f);
    const id = detail.conversation.id, count = scope === "ator" ? 9 : 49;
    await batch(env, Array.from({ length: count }, (_, i) => [
      "INSERT INTO email_log(id,profile_id,user_id,conversation_id,purpose,to_masked,to_hash,status,created) VALUES(?,?,?,?,'conversation.email','a***@example.test','hash','unknown',?)",
      [uid(), f.profile, scope === "ator" ? f.admin.id : `ator-sintetico:${i}`, id, now()],
    ] as [string, unknown[]]));
    const preview = await ok(await request(f, `/conversations/${id}/email/preview`, previewBody));
    const keys = [uid(), uid()], input = { previewToken: preview.previewToken };
    const results = await Promise.all(keys.map(key => request(f, `/conversations/${id}/email`, input, key)));
    expect(results.map(r => r.status).sort()).toEqual([200, 429]);
    const accepted = results.findIndex(r => r.status === 200);
    await ok(await request(f, `/conversations/${id}/email`, input, keys[accepted]));
    const rejected = results.find(r => r.status === 429)!;
    expect((await rejected.json<any>()).error.code).toBe("email_limit");
    expect(sent).toHaveLength(1);
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=? AND purpose='conversation.email'", f.profile)).toEqual({ n: count + 1 });
  }, 60_000);

  it("queda externa gera indeterminado sem reenviar; replay reautoriza e wildcard não concede exportação", async () => {
    const f = await setup(), { detail } = await receive(f, "whatsapp"); await mail(f);
    const id = detail.conversation.id, member = await bearer(f.member);
    await exec(env, "UPDATE users SET access='[\"*\"]' WHERE id=?", f.member.id);
    expect((await request(f, `/conversations/${id}/email/preview`, previewBody, uid(), member)).status).toBe(403);
    const app = await application(f, ["conversations:read"]);
    expect((await request(f, `/conversations/${id}/email/preview`, previewBody, uid(), app.token)).status).toBe(403);
    const missing = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/conversations/${id}/email/preview`, {
      method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" }, body: JSON.stringify(previewBody),
    });
    expect(missing.status).toBe(400);
    const preview = await ok(await request(f, `/conversations/${id}/email/preview`, previewBody));
    const key = uid(), input = { previewToken: preview.previewToken };
    mailFailure = true;
    const first = await ok(await request(f, `/conversations/${id}/email`, input, key));
    expect(first).toMatchObject({ status: "unknown", duplicate: false });
    const replay = await ok(await request(f, `/conversations/${id}/email`, input, key));
    expect(replay).toMatchObject({ id: first.id, status: "unknown" });
    const conflict = await request(f, `/conversations/${id}/email`, { ...input, customerRequested: true }, key);
    expect(conflict.status).toBe(409);
    expect((await conflict.json<any>()).error.code).toBe("idempotency_conflict");
    await exec(env, "UPDATE users SET role='operator',access='[\"*\"]' WHERE id=?", f.admin.id);
    expect((await request(f, `/conversations/${id}/email`, input, key)).status).toBe(403);
    expect(sent).toHaveLength(1);
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
  }, 60_000);
});
