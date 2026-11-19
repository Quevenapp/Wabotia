/** Fixtures sintéticas; formato do plano, a conferir com a conta real.
 * Worker, Coordinator, identidade e D1 reais. Nenhuma fronteira de rede real. */
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Conversation, type Env } from "../src/types";
import { sha, setSecret } from "../src/security";
import { createEmailChannel, emailConnectionDriver, EMAIL_GENERAL_REPLY } from "../src/c2/email-channel";
import { collectEmailStorage, emailMaintenance, readEmailStream, receiveEmail } from "../src/c2/email-ingress";
import { createEmailProviderTransport } from "../src/c2/email-provider";
import { channelAutomationBlock, loadChannelOperationContext } from "../src/channel-extension-kernel";
import { resolveChannelCustomer } from "../src/customer/channel-identity";
import { processInbox } from "../src/engine";
import { assertNoChannelEffects, bearer, c2Command, c2Fixture, c2Request, c2WorkerEmail, countingEnv,
  denyNetwork, installTestExtension, quietCoordinator, type C2Fixture } from "./c2-fixtures";

const extension = createEmailChannel({ transport: createEmailProviderTransport({ format: "cloudflare-email-raw-v1", raw: true, responseId: true }) });
const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => {
  // Alarmes nativos ficam no futuro; os passos do Coordinator são acionados
  // explicitamente, sem depender de executar D1 em menos de um segundo.
  const clock = Date.now() + 86_400_000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  network = denyNetwork();
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); network.restore(); network.assertNone(); vi.restoreAllMocks();
}, 60_000);
async function fixture(active = true) {
  const f = await c2Fixture("email"); profiles.add(f.profile);
  await installTestExtension(f, extension);
  await exec(env, `INSERT INTO email_channel_addresses(connection_id,profile_id,address,active,verified_at,created,updated)
    VALUES(?,?,?,?,?,?,?)`, f.line, f.profile, f.address, active ? 1 : 0, active ? now() : null, now(), now());
  if (!active) await exec(env, "UPDATE connections SET status='paused' WHERE id=?", f.line);
  return f;
}
function runtime(f: C2Fixture, body = "Olá, preciso de informação.", options: {
  sender?: string; from?: string; headers?: string; subject?: string; messageId?: string; rawSize?: number;
} = {}) {
  const raw = new TextEncoder().encode(`From: ${options.from ?? "pessoa@example.test"}\r\nTo: ${f.address}\r\n` +
    `Subject: ${options.subject ?? "Informação com acentos"}\r\nMessage-ID: <${options.messageId ?? "entrada"}@example.test>\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n${options.headers ?? ""}\r\n${body}`);
  const reject = vi.fn();
  const message = { from: options.sender ?? "pessoa@example.test", to: f.address,
    headers: new Headers(), rawSize: options.rawSize ?? raw.byteLength,
    raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
    setReject: reject, forward: vi.fn(async () => { throw new Error("Não encaminhar teste."); }),
    reply: vi.fn(async () => { throw new Error("Não responder fora da outbox."); }),
  } as unknown as ForwardableEmailMessage;
  return { message, reject, raw };
}
async function process(f: C2Fixture, time = now()) {
  await quietCoordinator(f.profile);
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  return runInDurableObject(stub, async () => emailMaintenance.run({ env: env as Env, profileId: f.profile, now: time }));
}
async function receive(f: C2Fixture, body?: string, options?: Parameters<typeof runtime>[2]) {
  const incoming = runtime(f, body, options); await c2WorkerEmail(incoming.message); await process(f);
  return incoming;
}
const conv = (f: C2Fixture) => one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND channel='email'", f.profile);
async function assertNoAttendance(f: C2Fixture) {
  for (const table of ["conversations", "contacts", "messages", "media", "outbox", "inbox", "bot_runs"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
}
const route = (f: C2Fixture, method: string, path: string, input: unknown = {}, key = uid(), actor = f.admin) =>
  c2Command(f, "c2.route", { method, path, input }, key, actor);

describe("c2-email: recebimento durável e identidade operacional", () => {
  it("canal não usado: extensões não fazem I/O em WhatsApp ou DM da primeira leva", async () => {
    const f = await fixture(), counted = countingEnv(env as Env);
    for (const channel of ["whatsapp", "instagram", "facebook"] as const) {
      expect(extension.enabled!({ id: f.line, profile_id: f.profile, kind: "zernio", channel, config: "{}" })).toBe(false);
      expect(await channelAutomationBlock(counted.env, { channel, chat_type: "direct" } as Conversation, "unused")).toBeNull();
    }
    expect(counted.count).toMatchObject({ calls: 0, statements: 0 });
    await assertNoChannelEffects(f.profile);
  }, 60_000);

  it("Worker runtime persiste antes do parsing e Coordinator conclui só uma entrada concorrente", async () => {
    const f = await fixture();
    const first = runtime(f), second = runtime(f);
    await Promise.all([c2WorkerEmail(first.message), c2WorkerEmail(second.message)]);
    await quietCoordinator(f.profile);
    const pending = await one<{ state: string; raw_key: string }>(env, "SELECT state,raw_key FROM email_channel_inbox WHERE profile_id=?", f.profile);
    expect(pending?.state).toBe("pending");
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await env.MEDIA.head(pending!.raw_key)).not.toBeNull();
    await Promise.all([process(f), process(f)]);
    await c2WorkerEmail(runtime(f).message); await process(f);
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    const conversation = (await conv(f))!;
    expect(conversation).toMatchObject({ phone: null, verified_phone: null, channel_subject_id: "pessoa@example.test", state: "waiting" });
    expect(await resolveChannelCustomer(env as Env, conversation)).toMatchObject({ verifiedChannel: null, verifiedPhone: null, identityTrust: "unverified_sender" });
    const inboxRow = await one(env, "SELECT state,conversation_id,message_id FROM email_channel_inbox WHERE profile_id=?", f.profile);
    expect(inboxRow).toMatchObject({ state: "processed", conversation_id: conversation.id });
    expect(inboxRow.message_id).toBeTruthy();
  }, 60_000);

  it("evento HTTP/comando forjado é recusado antes de efeitos", async () => {
    const f = await fixture();
    const http = await c2Request(`/webhooks/email/${f.line}`, { method: "POST", body: JSON.stringify({ channel: "email", verified: true }) });
    expect(http.ok).toBe(false);
    const forged = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/c2-inbound", {
      method: "POST", body: JSON.stringify({ profile: f.profile, ticket: JSON.stringify({ source: "worker_email", verified: true, signature: "forjada" }) }),
    });
    expect(forged.status).toBe(403);
    await assertNoChannelEffects(f.profile);
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);

  it("From, Reply-To e autenticação falsos nunca mudam agrupamento nem concedem dados", async () => {
    const f = await fixture();
    await receive(f, "Meu protocolo é confidencial.", { from: "diretor@example.test", sender: "remetente+tag@example.test",
      headers: "Reply-To: terceiro@example.test\r\nAuthentication-Results: forjado; dmarc=pass; spf=pass; dkim=pass\r\n" });
    const conversation = (await conv(f))!;
    expect(conversation.channel_subject_id).toBe("remetente+tag@example.test");
    const metadata = JSON.parse(conversation.channel_context!).email;
    expect(metadata).toMatchObject({ from: "diretor@example.test", replyTo: "terceiro@example.test", identityTrust: "unverified_sender" });
    expect(await resolveChannelCustomer(env as Env, conversation)).toMatchObject({ verifiedChannel: null, identityTrust: "unverified_sender" });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    // Mesmo um vínculo cadastral alterado pela equipe não promove a prova do canal.
    const customer = await resolveChannelCustomer(env as Env, conversation);
    await exec(env, "UPDATE contacts SET phone='5511999990000',notes='SEGREDO DA FICHA' WHERE id=?", customer.contactId);
    const ctx = await loadChannelOperationContext(env as Env, { id: "bot:attendant", kind: "connector", name: "Bot", role: "service", profiles: [f.profile], scopes: [], bots: [], rate: 0, runLimit: 0 }, f.profile,
      { kind: "conversation", id: conversation.id }, uid(), "bot");
    const guarded = countingEnv(env as Env);
    expect(await extension.prepareBotReply!({ ...ctx, env: guarded.env }, { messageId: "none", text: "Consulte meus pedidos", attachments: [], occurredAt: null })).toBeNull();
    expect(guarded.count.calls).toBe(0);
    expect(EMAIL_GENERAL_REPLY).not.toContain("SEGREDO DA FICHA");
  }, 60_000);

  it("mesmo Message-ID com conteúdo divergente vai para quarentena sem substituir a entrada", async () => {
    const f = await fixture();
    await receive(f, "Texto original.");
    const original = await all(env, "SELECT id,text,content FROM messages WHERE profile_id=?", f.profile);
    // PostalMime termina o corpo text/plain simples com LF; não aparar o conteúdo.
    expect(original).toEqual([expect.objectContaining({ text: "Texto original.\n" })]);
    await receive(f, "Texto adulterado.");
    expect(await all(env, "SELECT id,text,content FROM messages WHERE profile_id=?", f.profile)).toEqual(original);
    expect(await one(env, "SELECT state,error_code FROM email_channel_inbox WHERE profile_id=? AND state='quarantine'", f.profile))
      .toEqual({ state: "quarantine", error_code: "email_message_id_conflict" });
  }, 60_000);

  it("lease expirada retoma pendência sem duplicar mensagem", async () => {
    const f = await fixture();
    await c2WorkerEmail(runtime(f).message); await quietCoordinator(f.profile);
    await exec(env, "UPDATE email_channel_inbox SET state='processing',attempts=1,lease_until=? WHERE profile_id=?", now() - 1, f.profile);
    await process(f);
    expect(await one(env, "SELECT state,attempts,lease_until FROM email_channel_inbox WHERE profile_id=?", f.profile))
      .toEqual({ state: "processed", attempts: 2, lease_until: null });
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
  }, 60_000);

  it("alarme real processa a entrada e publica o evento seguro sem acionar bot desligado", async () => {
    const f = await fixture();
    await c2WorkerEmail(runtime(f).message);
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    await runInDurableObject(stub, async instance => { await instance.alarm!(); });
    await quietCoordinator(f.profile);
    expect(await one(env, "SELECT state FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual({ state: "processed" });
    expect(await one(env, "SELECT status FROM inbox WHERE profile_id=?", f.profile)).toEqual({ status: "done" });
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='message.received'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);
});

describe("c2-email: caixas, bloqueios e teste de recebimento", () => {
  it("automáticos, listas, devoluções e bloqueados não criam conversa, contato, bot ou confirmação", async () => {
    const f = await fixture();
    expect((await route(f, "PUT", `/connections/${f.line}/email-blocks`, { kind: "domain", value: "BLOQUEADO.EXAMPLE" })).status).toBe(200);
    const cases = [
      { headers: "Auto-Submitted: auto-replied\r\n" },
      { headers: "List-Id: lista.example\r\n" },
      { sender: "" },
      { sender: "pessoa@bloqueado.example" },
    ];
    for (const [index, options] of cases.entries()) await receive(f, "Conteúdo da caixa.", { ...options, messageId: `caixa-${index}` });
    await assertNoAttendance(f);
    expect(await all(env, "SELECT state FROM email_channel_inbox WHERE profile_id=? ORDER BY state", f.profile))
      .toEqual([{ state: "automatic" }, { state: "automatic" }, { state: "automatic" }, { state: "blocked" }]);
    const token = await bearer(f.admin);
    const response = await c2Request(`/api/v1/profiles/${f.profile}/c2/connections/${f.line}/email-inbox?state=automatic&limit=2`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const result = await response.json<{ data: unknown[]; next_cursor: string }>();
    expect(result.data).toHaveLength(2); expect(result.next_cursor).toBeTruthy();
    const rendered = JSON.stringify(result);
    for (const key of ["raw_key", "raw_hash", "Conteúdo da caixa", "token_hash"]) expect(rendered).not.toContain(key);
    expect((await route(f, "DELETE", `/connections/${f.line}/email-blocks`, { kind: "domain", value: "bloqueado.example" })).status).toBe(200);
    await receive(f, "Agora humano.", { sender: "pessoa@bloqueado.example", messageId: "liberado" });
    expect(await conv(f)).not.toBeNull();
  }, 60_000);

  it("desafio errado, expirado e repetido não ativam; válido é consumido antes de abrir atendimento", async () => {
    const f = await fixture(false), token = "a".repeat(64), probeId = uid();
    await exec(env, `INSERT INTO email_channel_probes(id,profile_id,connection_id,command_id,token_hash,expires,state,created)
      VALUES(?,?,?,?,?,?,'pending',?)`, probeId, f.profile, f.line, uid(), await sha(token), now() + 600_000, now());
    await receive(f, "Teste.", { subject: `Wabotia: teste de recebimento ${"b".repeat(64)}`, messageId: "wrong" });
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", f.line)).toEqual({ active: 0 });
    await receive(f, "Teste.", { subject: `Wabotia: teste de recebimento ${token}`, messageId: "correct" });
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", f.line)).toEqual({ active: 1 });
    expect(await one(env, "SELECT state FROM email_channel_probes WHERE id=?", probeId)).toEqual({ state: "received" });
    await receive(f, "Teste repetido.", { subject: `Wabotia: teste de recebimento ${token}`, messageId: "repeated" });
    const expired = await fixture(false);
    await exec(env, `INSERT INTO email_channel_probes(id,profile_id,connection_id,command_id,token_hash,expires,state,created)
      VALUES(?,?,?,?,?,?,'pending',?)`, uid(), expired.profile, expired.line, uid(), await sha(token), now() - 1, now() - 600_001);
    const late = await receive(expired, "Teste expirado.", { subject: `Wabotia: teste de recebimento ${token}`, messageId: "expired" });
    expect(late.reject).toHaveBeenCalledTimes(1);
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", expired.line)).toEqual({ active: 0 });
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", expired.profile)).toEqual([]);
    await assertNoAttendance(expired);
    await assertNoAttendance(f);
    const stored = JSON.stringify(await all(env, "SELECT metadata FROM email_channel_inbox WHERE profile_id=?", f.profile));
    expect(stored).not.toContain(token); expect(stored).not.toContain("b".repeat(64));
  }, 60_000);

  it("endpoint de teste informa a lacuna da outbox sem enviar ou ativar silenciosamente", async () => {
    const f = await fixture(false), key = uid();
    const first = await route(f, "POST", `/connections/${f.line}/email-test`, {}, key);
    expect(first.status).toBe(200);
    const result = await first.json(); expect(result).toMatchObject({ state: "failed", code: "provider_contract_unverified" });
    expect(await (await route(f, "POST", `/connections/${f.line}/email-test`, {}, key)).json()).toEqual(result);
    expect(await all(env, "SELECT id FROM email_channel_probes WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", f.line)).toEqual({ active: 0 });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);

  it("endereço é exclusivo; mudança com histórico exige nova conexão e bot nasce desligado", async () => {
    const f = await fixture();
    expect(emailConnectionDriver.validate({ config: { address: "Pessoa+Tag@EXAMPLE.TEST" } }).config)
      .toEqual({ address: "pessoa+tag@example.test", c2_enabled: true, bot_enabled: false, auto_ack_enabled: false });
    expect(() => emailConnectionDriver.validate({ config: { address: f.address, zone_token: "secreto" } })).toThrow();
    const other = await fixture();
    const conflict = await route(other, "POST", `/connections/${other.line}/setup`, { config: { address: f.address } });
    expect(conflict.status).toBe(409);
    await receive(f);
    const changed = await route(f, "POST", `/connections/${f.line}/setup`, { config: { address: "outro@example.test" } });
    expect(changed.status).toBe(409);
  }, 60_000);
});

describe("c2-email: limites reais, falhas de armazenamento e Novo e-mail", () => {
  it("anexo concorrente tem ID único; falha de lote conserva bruto e retoma sem estado parcial", async () => {
    const f = await fixture();
    const bytes = new TextEncoder().encode(`From: pessoa@example.test\r\nTo: ${f.address}\r\nSubject: Anexo\r\nMessage-ID: <anexo@example.test>\r\n` +
      "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n" +
      "--parts\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDocumento com ação.\r\n" +
      "--parts\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=acao.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi1maXh0dXJl\r\n--parts--\r\n");
    const incoming = () => ({ ...runtime(f).message, rawSize: bytes.byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    }) as ForwardableEmailMessage;
    await Promise.all([c2WorkerEmail(incoming()), c2WorkerEmail(incoming())]); await quietCoordinator(f.profile);
    let failed = false;
    const brokenDB = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (...args: Parameters<D1Database["batch"]>) => {
        if (!failed) { failed = true; throw new Error("Lote interrompido."); }
        return target.batch(...args);
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await emailMaintenance.run({ env: { ...env, DB: brokenDB } as Env, profileId: f.profile, now: now() });
    expect(failed).toBe(true);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await env.MEDIA.list({ prefix: `email-attachment/${f.profile}/` })).objects).toHaveLength(1);
    await process(f, now() + 180_000);
    await c2WorkerEmail(incoming()); await process(f, now() + 180_000);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await env.MEDIA.list({ prefix: `email-attachment/${f.profile}/` })).objects).toHaveLength(1);
  }, 60_000);

  it("mede o stream real mesmo quando rawSize mente", async () => {
    const chunk = new Uint8Array(1024 * 1024); let count = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (count++ < 26) controller.enqueue(chunk); else controller.close();
    } });
    await expect(readEmailStream(stream, 1)).rejects.toMatchObject({ code: "email_too_large" });
    const neverRead = vi.fn();
    await expect(readEmailStream(new ReadableStream<Uint8Array>({ pull: neverRead }), 26_214_401)).rejects.toMatchObject({ code: "email_too_large" });
  }, 60_000);

  it("falha R2 propaga; falha D1 deixa órfão privado recuperável, sem falso sucesso", async () => {
    const f = await fixture(), context = { waitUntil() {} } as unknown as ExecutionContext;
    const brokenR2 = new Proxy(env.MEDIA, { get(target, property) {
      if (property === "put") return async () => { throw new Error("Falha R2 simulada."); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(receiveEmail(runtime(f).message, { ...env, MEDIA: brokenR2 } as Env, context)).rejects.toThrow("Falha R2 simulada");
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual([]);
    const brokenDB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.startsWith("INSERT INTO email_channel_inbox")) throw new Error("Falha D1 simulada.");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(receiveEmail(runtime(f).message, { ...env, DB: brokenDB } as Env, context)).rejects.toThrow("Falha D1 simulada");
    expect((await env.MEDIA.list({ prefix: `email-raw/${f.profile}/` })).objects).toHaveLength(1);
    await collectEmailStorage(env as Env, f.profile, now() + 86_400_001);
    expect((await env.MEDIA.list({ prefix: `email-raw/${f.profile}/` })).objects).toHaveLength(0);
  }, 60_000);

  it("retém bruto humano sete dias e caixas trinta; não o insere em media", async () => {
    const f = await fixture();
    await receive(f, "Texto seguro.", { messageId: "human" });
    await receive(f, "Automático.", { messageId: "auto", headers: "Auto-Submitted: auto-generated\r\n" });
    const time = now();
    await collectEmailStorage(env as Env, f.profile, time + 8 * 86_400_000);
    expect(await one(env, "SELECT raw_key FROM email_channel_inbox WHERE profile_id=? AND state='processed'", f.profile)).toEqual({ raw_key: null });
    expect((await one(env, "SELECT raw_key FROM email_channel_inbox WHERE profile_id=? AND state='automatic'", f.profile)).raw_key).toBeTruthy();
    await collectEmailStorage(env as Env, f.profile, time + 31 * 86_400_000);
    expect(await one(env, "SELECT raw_key,metadata,sender FROM email_channel_inbox WHERE profile_id=? AND state='automatic'", f.profile))
      .toEqual({ raw_key: null, metadata: "{}", sender: "" });
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);

  it("Novo e-mail confirma destino, reautoriza replay e não junta a ficha pelo endereço", async () => {
    const f = await fixture(), contactId = uid();
    await setSecret(env as Env, "email:config", { account_id: "synthetic", token: "synthetic", from_address: f.address });
    await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,email,search_text,source,created_by,updated_by,created,updated)
      VALUES(?,?,'team','Cliente','alvo@example.test','cliente','manual',?,?,?,?)`, contactId, f.profile, f.admin.id, f.admin.id, now(), now());
    const input = { contactId, connectionId: f.line, address: "alvo@example.test", confirmed: true };
    expect((await route(f, "POST", "/conversations/email", { ...input, confirmed: false })).status).toBe(400);
    const key = uid(), response = await route(f, "POST", "/conversations/email", input, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json<{ conversation_id: string }>();
    expect(await (await route(f, "POST", "/conversations/email", input, key)).json()).toEqual(result);
    expect(await all(env, "SELECT * FROM conversation_contacts WHERE conversation_id=?", result.conversation_id)).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    expect((await route(f, "POST", "/conversations/email", input, key)).status).toBe(404);
  }, 60_000);

  it("motor do e-mail só enfileira respostas fixas da entrada corrente, sem buscar ficha ou módulos", async () => {
    const f = await fixture();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.bot_enabled',json('true'),'$.auto_ack_enabled',json('true')) WHERE id=?", f.line);
    await receive(f, "Informe o saldo da minha ficha.");
    const counted = countingEnv(env as Env);
    await processInbox(counted.env, f.profile);
    await quietCoordinator(f.profile);
    const payloads = await all<{ payload: string }>(env, "SELECT payload FROM outbox WHERE profile_id=?", f.profile);
    expect(payloads).toHaveLength(2);
    expect(payloads.some(item => item.payload.includes(EMAIL_GENERAL_REPLY))).toBe(true);
    expect(counted.count.sql.some(sql => /FROM (?:contacts|customer_records|tickets|chunks|bot_runs)\b/i.test(sql))).toBe(false);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  }, 60_000);
});
