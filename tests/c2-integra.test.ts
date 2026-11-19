/** Composição real; apenas as fronteiras dos fornecedores são simuladas.
 * Fixtures do plano, a conferir com a conta real. */
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, now, uid, type Env } from "../src/types";
import type { ChannelOutboxRow, ChannelReview, ExtensionConnection } from "../src/channel-c2-contracts";
import { googleReviewsExtension } from "../src/c2/google-reviews";
import { tiktokExtension } from "../src/c2/tiktok";
import { instagramCommentsExtension, type CommentRow } from "../src/c2/comments";
import { dispatchChannelDelivery, listReadyChannelDeliveries } from "../src/engine";
import { ZernioRequestError, zernioRequest } from "../src/zernio";
import { normalizeZernioError } from "../src/zernio-errors";
import { setSecret, sha } from "../src/security";
import { createEmailChannel } from "../src/c2/email-channel";
import { createEmailProviderTransport } from "../src/c2/email-provider";
import { emailMaintenance } from "../src/c2/email-ingress";
import { eraseContact } from "../src/customer/http";
import { assertNoChannelEffects, bearer, c2Command, c2Fixture, c2Request, c2ZernioWebhook,
  c2WorkerEmail, denyNetwork, installTestExtension, quietCoordinator, reviewFixtureEvent, type C2Fixture } from "./c2-fixtures";

const emailIntegrationExtension = createEmailChannel({ transport: createEmailProviderTransport({ format: "cloudflare-email-raw-v1", raw: true, responseId: true }) });
async function emailIntegrationFixture(active = true) {
  const f = await c2Fixture("email");
  await installTestExtension(f, emailIntegrationExtension);
  await exec(env, `INSERT INTO email_channel_addresses(connection_id,profile_id,address,active,verified_at,created,updated)
    VALUES(?,?,?,?,?,?,?)`, f.line, f.profile, f.address, active ? 1 : 0, active ? now() : null, now(), now());
  if (!active) await exec(env, "UPDATE connections SET status='paused' WHERE id=?", f.line);
  await setSecret(env, "email:config", { account_id: "a".repeat(32), token: "email-integration-synthetic", from_address: f.address });
  return f;
}

describe("c2-integra: drivers, permissões e transporte", { timeout: 60_000 }, () => {
  const driverProfiles = new Set<string>();
  const driverRealNow = Date.now.bind(Date);
  let driverNetwork: ReturnType<typeof denyNetwork>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(driverRealNow() + 3_600_000);
    driverNetwork = denyNetwork();
  });
  afterEach(async () => {
    for (const profile of driverProfiles) await quietCoordinator(profile);
    driverProfiles.clear();
    driverNetwork.restore();
    vi.useRealTimers();
    driverNetwork.assertNone();
  });
  async function driverFixture(channel: "googlebusiness" | "tiktok" = "googlebusiness") {
    const fixture = await c2Fixture(channel);
    driverProfiles.add(fixture.profile);
    await installTestExtension(fixture, channel === "googlebusiness" ? googleReviewsExtension : tiktokExtension);
    return fixture;
  }
  async function driverGoogleActive(fixture: C2Fixture) {
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", fixture.line);
    const response = await c2Command(fixture, "connection.state", { id: fixture.line, status: "active" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id: fixture.line, status: "active", configured: true, channel_extension: true });
  }
  function driverRemote(handler: (url: URL, init?: RequestInit) => Response) {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      try { return handler(url, init); }
      catch (error) { driverNetwork.unexpected.push("fronteira externa não simulada"); throw error; }
    });
  }

  it("connection.state ativa Google pelo driver, preserva o marco na retomada e não cria atendimento", async () => {
    const fixture = await driverFixture(), activatedAt = now();
    await driverGoogleActive(fixture);
    expect(await one(env, "SELECT activation_at FROM channel_sync_state WHERE connection_id=?", fixture.line))
      .toEqual({ activation_at: activatedAt });
    expect(await one(env, "SELECT json_extract(config,'$.reviews_enabled') enabled FROM connections WHERE id=?", fixture.line))
      .toEqual({ enabled: 1 });
    expect((await c2Command(fixture, "connection.state", { id: fixture.line, status: "paused" })).status).toBe(200);
    vi.setSystemTime(activatedAt + 60_000);
    await driverGoogleActive(fixture);
    expect(await all(env, "SELECT activation_at FROM channel_sync_state WHERE connection_id=?", fixture.line))
      .toEqual([{ activation_at: activatedAt }]);
    await assertNoChannelEffects(fixture.profile);
  });

  it("listagem Google projeta permissões explícitas e reconfere a concessão e o acesso", async () => {
    const fixture = await driverFixture();
    const list = async (actor = fixture.member) => c2Request(`/api/v1/profiles/${fixture.profile}/c2/reviews`, {
      headers: { Authorization: `Bearer ${await bearer(actor)}` },
    });
    const reader = await list();
    expect(reader.status).toBe(200);
    expect(await reader.json()).toMatchObject({ data: [], permissions: { can_read: true, can_reply: false, is_admin: false } });
    const administrator = await list(fixture.admin);
    expect(administrator.status).toBe(200);
    expect(await administrator.json()).toMatchObject({ permissions: { can_read: true, can_reply: true, is_admin: true } });
    const route = { path: `/review-publishers/${fixture.member.id}`, input: {} };
    expect((await c2Command(fixture, "c2.route", { ...route, method: "PUT" })).status).toBe(200);
    expect(await (await list()).json()).toMatchObject({ permissions: { can_read: true, can_reply: true, is_admin: false } });
    expect((await c2Command(fixture, "c2.route", { ...route, method: "DELETE" })).status).toBe(200);
    expect(await (await list()).json()).toMatchObject({ permissions: { can_read: true, can_reply: false, is_admin: false } });
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["conversations"]), fixture.member.id);
    expect((await list()).status).toBe(403);
    await assertNoChannelEffects(fixture.profile);
  });

  it("connection.test encaminha TikTok ao driver, recupera elegibilidade e deduplica o probe", async () => {
    const fixture = await driverFixture("tiktok");
    await exec(env, "UPDATE connections SET config=json_set(config,'$.tiktok_error_code','tiktok_account_ineligible') WHERE id=?", fixture.line);
    let calls = 0;
    driverRemote((url, init) => {
      expect(url.origin).toBe("https://zernio.com");
      expect(url.pathname).toBe("/api/v1/accounts");
      expect(url.searchParams.get("profileId")).toBe(fixture.remoteProfile);
      expect(url.searchParams.get("platform")).toBe("tiktok");
      expect(init?.method ?? "GET").toBe("GET");
      calls++;
      return Response.json({ accounts: [{ _id: fixture.account, platform: "tiktok", profileId: fixture.remoteProfile,
        isActive: true, needsReconnect: false, inboxEnabled: true }] });
    });
    const key = uid(), data = { id: fixture.line, origin: "https://test" };
    const first = await c2Command(fixture, "connection.test", data, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ ok: true, status: "active", configured: true });
    expect(await one(env, "SELECT json_extract(config,'$.tiktok_error_code') code FROM connections WHERE id=?", fixture.line))
      .toEqual({ code: null });
    const replay = await c2Command(fixture, "connection.test", data, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("chave-sintetica-c2");
    expect(JSON.stringify(result)).not.toContain(fixture.webhookSecret);
    await assertNoChannelEffects(fixture.profile);
  });

  it("transporte mantém o erro legado e expõe HTTP e Retry-After sem corpo bruto", async () => {
    const fixture = await driverFixture();
    const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", fixture.line))!;
    const payload = { error: `Não autorizado: chave-sintetica-c2 ${fixture.webhookSecret}`, code: "LIMIT" };
    const legacy = normalizeZernioError(429, payload, ["chave-sintetica-c2", fixture.webhookSecret]);
    for (const [header, expected] of [
      ["120", 120_000],
      [new Date(Math.floor(now() / 1000) * 1000 + 180_000).toUTCString(), Math.floor(now() / 1000) * 1000 + 180_000 - now()],
      ["-1", null], ["segredo-inválido", null],
    ] as const) {
      driverRemote(url => {
        expect(url.origin).toBe("https://zernio.com");
        expect(url.pathname).toBe("/api/v1/inbox/reviews");
        return Response.json(payload, { status: 429, headers: { "Retry-After": header } });
      });
      const failure: unknown = await zernioRequest(env as Env, connection, "inbox/reviews").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toBeInstanceOf(ZernioRequestError);
      expect(failure).toMatchObject({ ...legacy, httpStatus: 429, retryAfterMs: expected });
      expect(String(failure)).not.toContain("chave-sintetica-c2");
      expect(String(failure)).not.toContain(fixture.webhookSecret);
      expect(JSON.stringify(failure)).not.toContain(header === "segredo-inválido" ? header : fixture.webhookSecret);
    }
    await assertNoChannelEffects(fixture.profile);
  });

  it("publicação Google respeita Retry-After e conclui sem conversa nem balão", async () => {
    const fixture = await driverFixture();
    await driverGoogleActive(fixture);
    const incoming = reviewFixtureEvent(fixture);
    incoming.review.publishedAt = now();
    expect((await c2ZernioWebhook(fixture, incoming)).ok).toBe(true);
    const review = (await one<ChannelReview>(env, "SELECT * FROM reviews WHERE connection_id=?", fixture.line))!;
    expect(review).not.toBeNull();
    const response = await c2Command(fixture, "c2.route", { method: "PUT", path: `/reviews/${review.id}/reply`,
      input: { version: review.version, text: "Obrigada pela avaliação." } });
    expect(response.status, await response.clone().text()).toBe(200);
    const { delivery_id: id } = await response.json() as { delivery_id: string };
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    expect(row.conversation_id).toBeNull();
    let calls = 0;
    driverRemote((url, init) => {
      expect(url.origin).toBe("https://zernio.com");
      expect(url.pathname).toBe(`/api/v1/inbox/reviews/${encodeURIComponent(review.remote_id)}/reply`);
      expect(init?.method).toBe("POST");
      calls++;
      return calls === 1 ? Response.json({ error: "Limite temporário" }, { status: 429, headers: { "Retry-After": "120" } })
        : Response.json({ success: true });
    });
    const attemptedAt = now();
    expect(await dispatchChannelDelivery(env as Env, row)).toBe(true);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", id)).toEqual({ status: "pending" });
    expect(await one(env, "SELECT not_before FROM channel_delivery_state WHERE outbox_id=?", id))
      .toEqual({ not_before: attemptedAt + 120_000 });
    expect(await listReadyChannelDeliveries(env as Env, fixture.profile)).toEqual([]);
    vi.setSystemTime(attemptedAt + 120_000);
    const ready = await listReadyChannelDeliveries(env as Env, fixture.profile);
    expect(ready.map(item => item.id)).toEqual([id]);
    await dispatchChannelDelivery(env as Env, ready[0]);
    expect(calls).toBe(2);
    expect(await one(env, "SELECT status,completion_handled FROM outbox WHERE id=?", id))
      .toEqual({ status: "sent", completion_handled: 1 });
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id))
      .toEqual({ reply_text: "Obrigada pela avaliação." });
    for (const table of ["contacts", "conversations", "messages", "inbox", "bot_runs"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, fixture.profile), table).toEqual([]);
  });
});

describe("c2-integra: projeções autorizadas dos canais", { timeout: 60_000 }, () => {
  const projectionProfiles = new Set<string>();
  const projectionRealNow = Date.now.bind(Date);
  let projectionNetwork: ReturnType<typeof denyNetwork>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(projectionRealNow() + 86_400_000);
    projectionNetwork = denyNetwork();
  });
  afterEach(async () => {
    for (const profile of projectionProfiles) await quietCoordinator(profile);
    projectionProfiles.clear();
    projectionNetwork.restore();
    vi.useRealTimers();
    projectionNetwork.assertNone();
  });
  async function projectionFixture(channel: "instagram" | "tiktok") {
    const fixture = await c2Fixture(channel);
    projectionProfiles.add(fixture.profile);
    await installTestExtension(fixture, channel === "instagram" ? instagramCommentsExtension : tiktokExtension);
    return fixture;
  }
  async function projectionDetail(fixture: C2Fixture, id: string) {
    const response = await c2Request(`/api/v1/profiles/${fixture.profile}/conversations/${id}`, {
      headers: { Authorization: `Bearer ${await bearer(fixture.admin)}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ channel_extension?: { metadata: { comments: { id: string; privateState: string; privateExpiresAt: number }[] }; capabilities: { menu: unknown } };
      capabilities: { menu: unknown }; messages: { id: string; content: string }[] }>;
  }
  async function projectionComment(fixture: C2Fixture, remoteId: string) {
    const response = await c2ZernioWebhook(fixture, {
      id: uid(), event: "comment.received",
      account: { accountId: fixture.account, platform: "instagram", profileId: fixture.remoteProfile },
      comment: { id: remoteId, text: "Informação sobre a publicação", createdAt: now() - 1000,
        author: { id: "mesma-pessoa", name: "Pessoa sintética" } },
      post: { id: "mesma-publicacao", text: "Publicação de teste" },
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return (await one<CommentRow>(env, "SELECT * FROM channel_comments WHERE connection_id=? AND remote_id=?", fixture.line, remoteId))!;
  }

  it("ficha projeta resposta e envio pronto somente com acesso, endereço verificado e contrato confirmado", async () => {
    const fixture = await emailIntegrationFixture(), contactId = uid();
    projectionProfiles.add(fixture.profile);
    await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated)
      VALUES(?,?,'team','Pessoa sintética','pessoa sintetica','manual',?,?,?,?)`,
      contactId, fixture.profile, fixture.admin.id, fixture.admin.id, now(), now());
    const read = async () => {
      const response = await c2Request(`/api/v1/profiles/${fixture.profile}/contacts/${contactId}/profile`, {
        headers: { Authorization: `Bearer ${await bearer(fixture.member)}` },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json() as Promise<{ channel_extensions?: string[]; channel_status?: {
        can_reply: boolean; connections: { id: string; can_reply: boolean; send_ready: boolean }[];
      } }>;
    };
    const ready = await read();
    expect(ready.channel_status?.can_reply).toBe(true);
    expect(ready.channel_status?.connections).toEqual([expect.objectContaining({ id: fixture.line, can_reply: true, send_ready: true })]);
    expect(JSON.stringify(ready.channel_status)).not.toContain("email-integration-synthetic");
    expect(JSON.stringify(ready.channel_status)).not.toContain("config");
    const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", fixture.line))!;
    // O transporte real ainda sem confirmação permanece fechado na mesma ficha.
    expect(await createEmailChannel().contactStatus!({ env, connection, resource: null,
      authorization: { actor: fixture.member, profileId: fixture.profile, origin: "human", permissions: ["contacts:read", "conversations:write"] },
      now: now(), commandId: "" })).toEqual({ send_ready: false });
    await exec(env, "UPDATE email_channel_addresses SET active=0 WHERE connection_id=?", fixture.line);
    expect((await read()).channel_status?.connections).toEqual([expect.objectContaining({ id: fixture.line, can_reply: true, send_ready: false })]);
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["contacts"]), fixture.member.id);
    expect(await read()).not.toHaveProperty("channel_status");
    await exec(env, "UPDATE users SET access=NULL WHERE id=?", fixture.member.id);
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", fixture.line);
    const unused = await read();
    expect(unused).not.toHaveProperty("channel_status");
    expect(unused).not.toHaveProperty("channel_extensions");
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", fixture.profile)).toEqual([]);
  });

  it("projeta a tentativa privada por alvo antigo e reconstrói o conteúdo sem alterar o histórico", async () => {
    const fixture = await projectionFixture("instagram");
    const old = await projectionComment(fixture, "comentario-antigo");
    vi.setSystemTime(now() + 1000);
    const current = await projectionComment(fixture, "comentario-atual");
    expect(current.conversation_id).toBe(old.conversation_id);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", fixture.admin.id, old.conversation_id);
    const response = await c2Command(fixture, "message.action", { id: old.conversation_id, action: "channel",
      channel_action: { type: "comment.private", commentId: old.id, text: "Vamos conversar em privado." } });
    expect(response.status, await response.clone().text()).toBe(200);
    // Snapshot antigo de mensagem: a leitura deve respeitar a reserva atual da tabela.
    await exec(env, "UPDATE messages SET content=json_set(content,'$.comment.privateState','available') WHERE id=?", old.message_id);
    const detail = await projectionDetail(fixture, old.conversation_id);
    const targets = detail.channel_extension!.metadata.comments;
    expect(targets).toHaveLength(2);
    expect(targets.find(target => target.id === old.id)).toMatchObject({ privateState: "reserved", privateExpiresAt: old.occurred_at! + 168 * 3_600_000 });
    expect(targets.find(target => target.id === current.id)).toMatchObject({ privateState: "available" });
    expect(JSON.parse(detail.messages.find(message => message.id === old.message_id)!.content).comment.privateState).toBe("reserved");
    expect(await one(env, "SELECT json_extract(content,'$.comment.privateState') state FROM messages WHERE id=?", old.message_id))
      .toEqual({ state: "available" });
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", fixture.profile)).toEqual([]);
  });

  it("projeta menu numerado TikTok explícito sem anunciar botões ou listas", async () => {
    const fixture = await projectionFixture("tiktok"), thread = "thread-projecao", subject = "pessoa-projecao";
    const response = await c2ZernioWebhook(fixture, {
      id: uid(), event: "message.received", account: { accountId: fixture.account, platform: "tiktok", profileId: fixture.remoteProfile },
      conversation: { id: thread, participantId: subject, type: "direct" },
      message: { platformMessageId: uid(), conversationId: thread, direction: "incoming", sentAt: now() - 1000,
        text: "Olá", sender: { id: subject, name: "Pessoa sintética" }, recipient: { id: fixture.account }, attachments: [] },
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const conversation = (await one<{ id: string }>(env, "SELECT id FROM conversations WHERE connection_id=?", fixture.line))!;
    const detail = await projectionDetail(fixture, conversation.id);
    const menu = { buttons: 0, quickReplies: 0, listItems: 0, fallback: "numbered_text", numberedText: true };
    expect(detail.channel_extension!.capabilities.menu).toEqual(menu);
    expect(detail.capabilities.menu).toEqual(menu);
  });

  it("canal de comentários não usado não cria alvo ou projeção de atendimento", async () => {
    const fixture = await projectionFixture("instagram");
    await exec(env, "UPDATE connections SET config=json_set(config,'$.comments_enabled',json('false')) WHERE id=?", fixture.line);
    const response = await c2ZernioWebhook(fixture, { event: "comment.received",
      account: { accountId: fixture.account, platform: "instagram", profileId: fixture.remoteProfile },
      comment: { id: "nao-usado", text: "Comentário", createdAt: now(), author: { id: "pessoa" } }, post: { id: "post" } });
    expect(await response.json()).toMatchObject({ ignored: true });
    await assertNoChannelEffects(fixture.profile);
    expect(await all(env, "SELECT id FROM channel_comments WHERE profile_id=?", fixture.profile)).toEqual([]);
  });
});

describe("c2-integra: desafio e exclusão de dados do e-mail", { timeout: 60_000 }, () => {
  const profiles = new Set<string>();
  const realNow = Date.now.bind(Date);
  let network: ReturnType<typeof denyNetwork>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(realNow() + 86_400_000);
    network = denyNetwork();
  });
  afterEach(async () => {
    for (const profile of profiles) await quietCoordinator(profile);
    profiles.clear(); network.restore(); network.assertNone(); vi.restoreAllMocks(); vi.useRealTimers();
  });
  async function fixture(active = false) {
    const result = await emailIntegrationFixture(active); profiles.add(result.profile); return result;
  }
  function runtime(f: C2Fixture, raw: Uint8Array, sender = "pessoa@example.test") {
    return { from: sender, to: f.address, headers: new Headers(), rawSize: raw.byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      setReject: vi.fn(), forward: vi.fn(async () => { throw new Error("Encaminhamento inesperado."); }),
      reply: vi.fn(async () => { throw new Error("Envio fora da outbox."); }),
    } as unknown as ForwardableEmailMessage;
  }
  function incoming(f: C2Fixture, id: string, headers = "", text = "Olá, conteúdo pessoal.") {
    return new TextEncoder().encode(`From: pessoa@example.test\r\nTo: ${f.address}\r\nSubject: Assunto pessoal\r\nMessage-ID: <${id}@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n${headers}\r\n${text}`);
  }
  const start = async (f: C2Fixture, key = uid()) => c2Request(`/api/v1/profiles/${f.profile}/c2/connections/${f.line}/email-test`, {
    method: "POST", headers: { Authorization: `Bearer ${await bearer(f.admin)}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: "{}",
  });
  async function alarm(f: C2Fixture) {
    await runInDurableObject(env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)), async instance => { await instance.alarm!(); });
    await quietCoordinator(f.profile);
  }
  async function process(f: C2Fixture) {
    await quietCoordinator(f.profile);
    await runInDurableObject(env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)),
      async () => emailMaintenance.run({ env: env as Env, profileId: f.profile, now: now() }));
  }

  it("desafio concorrente passa por Worker, Coordinator e outbox sem conversa; recebimento é uso único", async () => {
    const f = await fixture(), key = uid();
    const responses = await Promise.all([start(f, key), start(f, key)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    const probe = (await one<{ id: string; token_hash: string; state: string }>(env, "SELECT id,token_hash,state FROM email_channel_probes WHERE profile_id=?", f.profile))!;
    expect(probe.state).toBe("pending");
    expect(JSON.stringify(bodies)).not.toContain(probe.token_hash);
    const queued = await all<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "channel", conversation_id: null, status: "pending" });
    let sent: Uint8Array | undefined, calls = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/email/sending/send` || init?.method !== "POST") {
        network.unexpected.push("fronteira inesperada"); throw new Error("Rede inesperada.");
      }
      calls++;
      const body = JSON.parse(String(init.body)) as { raw: string; to: string };
      expect(body.to).toBe(f.address);
      sent = Uint8Array.from(atob(body.raw), character => character.charCodeAt(0));
      return Response.json({ success: true, result: { id: "probe-confirmed", status: "accepted" } });
    });
    await alarm(f);
    expect(calls).toBe(1); expect(sent).toBeDefined();
    expect(await one(env, "SELECT status,completion_handled,conversation_id FROM outbox WHERE id=?", queued[0].id))
      .toEqual({ status: "sent", completion_handled: 1, conversation_id: null });
    expect((await one<{ payload: string }>(env, "SELECT payload FROM outbox WHERE id=?", queued[0].id))!.payload).not.toContain("challengeCipher");
    await Promise.all([c2WorkerEmail(runtime(f, sent!, f.address)), c2WorkerEmail(runtime(f, sent!, f.address))]);
    await process(f);
    expect(await one(env, "SELECT state FROM email_channel_probes WHERE id=?", probe.id)).toEqual({ state: "received" });
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", f.line)).toEqual({ active: 1 });
    await c2WorkerEmail(runtime(f, sent!, f.address)); await process(f); await alarm(f);
    expect(calls).toBe(1);
    expect(await all(env, "SELECT id FROM email_channel_inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    for (const table of ["contacts", "conversations", "messages", "bot_runs"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
  });

  it("desafio errado e HTTP forjado não ativam; replay e publicação reautorizam administrador", async () => {
    const f = await fixture(), key = uid();
    expect((await start(f, key)).status).toBe(200);
    const wrong = incoming(f, "wrong", `X-Wabotia-Email-Probe: ${"a".repeat(64)}\r\n`);
    await c2WorkerEmail(runtime(f, wrong)); await process(f);
    expect(await one(env, "SELECT active FROM email_channel_addresses WHERE connection_id=?", f.line)).toEqual({ active: 0 });
    expect(await one(env, "SELECT state FROM email_channel_probes WHERE profile_id=?", f.profile)).toEqual({ state: "pending" });
    const forged = await c2Command(f, "inbound", { channel: "email", origin: "worker_email", verified: true, text: "Forjado" });
    expect(forged.ok).toBe(false);
    await exec(env, "UPDATE users SET role='operator' WHERE id=?", f.admin.id);
    expect((await start(f, key)).status).toBe(403);
    await alarm(f);
    expect(await one(env, "SELECT status,error,completion_handled FROM outbox WHERE profile_id=?", f.profile))
      .toMatchObject({ status: "failed", error: "forbidden", completion_handled: 1 });
    for (const table of ["contacts", "conversations", "messages", "bot_runs"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
  });

  it("canal não usado: teste não enfileira desafio ou cria dados de atendimento", async () => {
    const f = await fixture();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    expect((await start(f)).status).toBe(503);
    expect(await all(env, "SELECT id FROM email_channel_probes WHERE profile_id=?", f.profile)).toEqual([]);
    await assertNoChannelEffects(f.profile);
  });

  it("exclusão do contato limpa pendências, caixas, brutos, anexos e conteúdo; replay retoma e preserva tombstone", async () => {
    const f = await fixture(true);
    await c2WorkerEmail(runtime(f, incoming(f, "personal"))); await process(f);
    const contact = (await one<{ id: string; version: number }>(env, "SELECT id,version FROM contacts WHERE profile_id=?", f.profile))!;
    const receipt = (await one<{ id: string; conversation_id: string }>(env, "SELECT id,conversation_id FROM email_channel_inbox WHERE profile_id=?", f.profile))!;
    await c2WorkerEmail(runtime(f, incoming(f, "pending")));
    await c2WorkerEmail(runtime(f, incoming(f, "automatic", "Auto-Submitted: auto-generated\r\n"))); await process(f);
    await c2WorkerEmail(runtime(f, incoming(f, "still-pending")));
    const mediaId = uid(), objectKey = `email-attachment/${f.profile}/${receipt.id}/0`;
    await env.MEDIA.put(objectKey, "anexo pessoal");
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'pessoal.txt','text/plain',13,?,'email',?)", mediaId, f.profile, objectKey, now());
    const sharedId = uid(), sharedKey = `email-attachment/${f.profile}/${receipt.id}/1`, otherConversation = uid();
    await env.MEDIA.put(sharedKey, "cópia compartilhada");
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'compartilhado.txt','text/plain',20,?,'email',?)", sharedId, f.profile, sharedKey, now());
    await exec(env, "UPDATE messages SET attachments=? WHERE conversation_id=?", JSON.stringify([sharedId]), receipt.conversation_id);
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_id,session,created,updated) VALUES(?,?,?,?,?,?,?)", otherConversation, f.profile, f.second, uid(), uid(), now(), now());
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created) VALUES(?,?,?,'outbound',?,'Outro atendimento',?,?)",
      uid(), f.profile, otherConversation, f.admin.id, JSON.stringify([sharedId]), now());
    const pendingMedia = [uid(), uid()], pendingKeys: string[] = [], pendingDeliveries: string[] = [];
    for (const [index, id] of pendingMedia.entries()) {
      const object = `email-attachment/${f.profile}/${receipt.id}/${index + 2}`, delivery = uid();
      pendingKeys.push(object); pendingDeliveries.push(delivery);
      await env.MEDIA.put(object, "anexo aguardando envio");
      await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'pendente.txt','text/plain',22,?,'email',?)", id, f.profile, object, now());
      // Ambos os formatos usados na fila legada, ainda sem balão de confirmação.
      const payload = index === 0 ? { attachments: [id] } : { media_id: id, attachments: [] };
      await exec(env, `INSERT INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,dedupe,created,updated)
        VALUES(?,?,?,?,1,'manual',?,?,?,?,?)`, delivery, f.profile, otherConversation, f.second, f.admin.id,
        JSON.stringify(payload), `shared:${delivery}`, now(), now());
    }
    await exec(env, "UPDATE messages SET attachments=? WHERE conversation_id=?", JSON.stringify([sharedId, ...pendingMedia]), receipt.conversation_id);
    const uploadId = uid(), uploadKey = `uploads/${uploadId}`;
    await env.MEDIA.put(uploadKey, "saída pessoal");
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'saida.txt','text/plain',13,?,?,?)", uploadId, f.profile, uploadKey, f.admin.id, now());
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created) VALUES(?,?,?,'outbound',?,'Saída pessoal',?,?)",
      uid(), f.profile, receipt.conversation_id, f.admin.id, JSON.stringify([uploadId]), now());
    await exec(env, "INSERT INTO email_channel_blocks(profile_id,connection_id,kind,value,actor_id,created) VALUES(?,?,'address','pessoa@example.test',?,?)", f.profile, f.line, f.admin.id, now());
    const orphan = `email-raw/${f.profile}/orphan`;
    await env.MEDIA.put(orphan, "bruto órfão", { customMetadata: { connection_id: f.line, sender_hash: await sha("pessoa@example.test") } });
    const key = uid(), command = (await sha(`${f.admin.id}:${f.profile}:contact.erasure\n${key}`)).slice(0, 32);
    const input = { id: contact.id, expectedVersion: contact.version, reason: "Solicitação do titular", confirm: true };
    const interrupted = { ...env, MEDIA: new Proxy(env.MEDIA, { get(target, property) {
      if (property === "delete") return async () => { throw new Error("Exclusão R2 interrompida."); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }) } as Env;
    await expect(eraseContact(interrupted, f.admin, f.profile, contact.id, input, command)).rejects.toThrow("Exclusão R2 interrompida.");
    const resumed = await c2Command(f, "contact.erasure", input, key);
    expect(resumed.status).toBe(200);
    const result = await resumed.json();
    expect(await eraseContact(env as Env, f.admin, f.profile, contact.id, input, command)).toEqual(result);
    for (const table of ["email_channel_inbox", "email_channel_blocks", "inbox"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
    expect((await all<{ id: string }>(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).map(media => media.id).sort())
      .toEqual([sharedId, ...pendingMedia].sort());
    expect((await env.MEDIA.list({ prefix: `email-raw/${f.profile}/` })).objects).toEqual([]);
    expect((await env.MEDIA.list({ prefix: `email-attachment/${f.profile}/` })).objects.map(object => object.key).sort())
      .toEqual([sharedKey, ...pendingKeys].sort());
    expect((await all<{ id: string; status: string }>(env, "SELECT id,status FROM outbox WHERE profile_id=?", f.profile)).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(pendingDeliveries.sort().map(id => ({ id, status: "pending" })));
    expect(await env.MEDIA.head(uploadKey)).toBeNull();
    expect(await one(env, "SELECT channel_subject_id,channel_context,title FROM conversations WHERE id=?", receipt.conversation_id))
      .toEqual({ channel_subject_id: null, channel_context: "{}", title: "Contato excluído" });
    for (const message of await all<{ text: string; content: string; attachments: string }>(env, "SELECT text,content,attachments FROM messages WHERE profile_id=? AND conversation_id=?", f.profile, receipt.conversation_id))
      expect(message).toEqual({ text: "", content: "{}", attachments: "[]" });
    expect(await one(env, "SELECT text,attachments FROM messages WHERE conversation_id=?", otherConversation))
      .toEqual({ text: "Outro atendimento", attachments: JSON.stringify([sharedId]) });
    expect(await one(env, "SELECT state,display_name,username FROM customer_channel_ids WHERE contact_id=?", contact.id))
      .toEqual({ state: "blocked", display_name: "", username: "" });
    await c2WorkerEmail(runtime(f, incoming(f, "after-erasure"))); await process(f);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await one(env, "SELECT state FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual({ state: "blocked" });
  });
});
