/** Aceite da composição de produção. Formatos do plano; a conferir com a conta real.
 * Não importa c2-fixtures: aquele helper isola a instalação dos descritores.
 * Aqui Worker, Coordinator, identidade, motor, D1, R2 e conclusão são reais;
 * somente as fronteiras dos fornecedores e o relógio são simulados. */
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Worker, { Coordinator } from "../src/index";
import { all, exec, one } from "../src/db";
import { hmac, setSecret } from "../src/security";
import { json, now, uid, type Actor, type Conversation } from "../src/types";
import { processPush } from "../src/push";
import { bearer, fixture, quietCoordinator } from "./service-center-fixture";

const profiles = new Set<string>();
const TOKEN = "123456789:aceite_synthetic_token_123456789";
let clock = 0;
let unexpected: string[];
let logs: unknown[];
let remote: (request: Request) => Response | Promise<Response>;
beforeEach(async () => {
  clock = Date.now() + 86_400_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  unexpected = []; logs = [];
  remote = () => { unexpected.push("fronteira não prevista"); throw new Error("Rede inesperada no aceite."); };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => Promise.resolve(remote(new Request(input, init))));
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { logs.push(values); });
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
}, 60_000);

type Channel = "instagram" | "facebook" | "telegram" | "googlebusiness" | "email" | "tiktok";
async function setup(channel: Channel) {
  const f = await fixture(); profiles.add(f.profile);
  // O resolvedor da conta exige IDs Zernio hexadecimais de 24 caracteres,
  // como na descoberta/importação. UUIDs locais resultam em scope_mismatch.
  const integration = uid(), remoteProfile = uid().replaceAll("-", "").slice(0, 24), address = `${f.line}@example.test`;
  const account = channel === "telegram" ? "123456789" : channel === "email" ? address : uid().replaceAll("-", "").slice(0, 24);
  const secret = `segredo-sintetico-${f.line}`;
  const kind = channel === "telegram" ? "telegram_bot" : channel === "email" ? "email" : "zernio";
  await exec(env, "UPDATE connections SET kind=?,channel=?,config=? WHERE id=?", kind, channel, JSON.stringify({
    c2_enabled: true, comments_enabled: true, reviews_enabled: true, account_id: account,
    bot_id: channel === "telegram" ? account : undefined, address: channel === "email" ? address : undefined,
    zernio_workspace_id: kind === "zernio" ? integration : undefined,
    zernio_profile_id: kind === "zernio" ? remoteProfile : undefined,
    bot_enabled: false, auto_ack_enabled: false, service: { mode: "human", menu_mode: "off" },
  }), f.line);
  if (kind === "zernio") {
    await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Aceite',?,'zernio',?,?)",
      integration, f.profile, `zernio:${remoteProfile}`, remoteProfile, now());
    await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintetica-aceite", webhook_secret: secret });
    await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,'Aceite',?,?)",
      f.line, f.profile, integration, channel, account, remoteProfile, now(), now());
  } else if (channel === "telegram") {
    await setSecret(env, `connection:${f.line}`, { bot_token: TOKEN, webhook_secret: secret });
  } else {
    await exec(env, "INSERT INTO email_channel_addresses(connection_id,profile_id,address,active,verified_at,created,updated) VALUES(?,?,?,1,?,?,?)",
      f.line, f.profile, address, now(), now(), now());
    await setSecret(env, "email:config", { account_id: "a".repeat(32), token: "email-sintetico-aceite", from_address: address });
  }
  return { ...f, channel, integration, remoteProfile, account, secret, address };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function fetchWorker(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await Worker.fetch(new Request(`https://test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function api(f: Fixture, method: string, path: string, input?: unknown, key = uid(), actor: Actor = f.admin) {
  const response = await fetchWorker(`/api/v1/profiles/${f.profile}/${path}`, { method,
    headers: { Authorization: `Bearer ${await bearer(actor)}`, "Content-Type": "application/json", "Idempotency-Key": key },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  await quietCoordinator(f.profile); return response;
}
async function webhook(f: Fixture, body: unknown, forged = false) {
  const telegram = f.channel === "telegram", raw = JSON.stringify(body);
  const response = await fetchWorker(`/webhooks/${telegram ? `telegram-bot/${f.line}` : `zernio-accounts/${f.integration}`}`, {
    method: "POST", body: raw, headers: { "Content-Type": "application/json",
      [telegram ? "X-Telegram-Bot-Api-Secret-Token" : "X-Zernio-Signature"]: forged ? "incorreto" : telegram ? f.secret : await hmac(f.secret, raw) },
  });
  await quietCoordinator(f.profile); return response;
}
async function acceptedWebhook(f: Fixture, body: unknown) {
  const response = await webhook(f, body);
  // Um webhook ignorado também responde 2xx. Exigir o recibo do Coordinator
  // impede que uma fixture inválida pareça uma entrada integrada bem-sucedida.
  expect(response.status, await response.clone().text()).toBe(202);
  const receipt = await response.json() as { received: boolean; duplicate?: boolean;
    resource: { kind: "conversation" | "review"; id: string } };
  expect(receipt).toMatchObject({ received: true, resource: {
    kind: f.channel === "googlebusiness" ? "review" : "conversation", id: expect.any(String),
  } });
  expect(receipt).not.toHaveProperty("ignored");
  return receipt;
}
async function concurrentZernioIngress(f: Fixture, body: unknown) {
  expect((await webhook(f, body, true)).status).toBe(403); await noEffects(f);
  await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false'),'$.comments_enabled',json('false'),'$.reviews_enabled',json('false')) WHERE id=?", f.line);
  const unused = await webhook(f, body);
  expect(unused.status).toBe(200);
  expect(await unused.json()).toEqual({ received: true, ignored: true, reason: "channel_not_ready" });
  await noEffects(f);
  await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('true'),'$.comments_enabled',json('true'),'$.reviews_enabled',json('true')) WHERE id=?", f.line);
  const receipts = await Promise.all([acceptedWebhook(f, body), acceptedWebhook(f, body)]);
  expect(receipts.filter(receipt => receipt.duplicate === true)).toHaveLength(1);
  expect(receipts[0].resource).toEqual(receipts[1].resource);
  expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
}
const account = (f: Fixture) => ({ accountId: f.account, platform: f.channel, profileId: f.remoteProfile });
function telegramEvent(id = 1) {
  return { update_id: id, message: { message_id: id, date: Math.floor(now() / 1000),
    from: { id: 901234567, is_bot: false, first_name: "Pessoa sintética" },
    chat: { id: 901234567, type: "private" }, text: "Olá, preciso de atendimento." } };
}
async function alarm(f: Fixture, advance = 2000) {
  await quietCoordinator(f.profile); clock += advance;
  await runInDurableObject(env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)), async (instance: Coordinator) => instance.alarm());
  await quietCoordinator(f.profile);
}
async function claim(f: Fixture) {
  const conversation = (await one<Conversation>(env, "SELECT * FROM conversations WHERE connection_id=?", f.line))!;
  expect(conversation).not.toBeNull();
  const response = await api(f, "POST", `conversations/${conversation.id}/actions`, { action: "claim" });
  expect(response.status, await response.clone().text()).toBe(200);
  return conversation;
}
const action = (f: Fixture, conversation: string, channelAction: unknown, key = uid()) =>
  api(f, "POST", `conversations/${conversation}/message-actions`, { action: "channel", channel_action: channelAction }, key);
async function noEffects(f: Fixture) {
  for (const table of ["contacts", "conversations", "messages", "inbox", "outbox", "reviews", "bot_runs", "media"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
  expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toEqual([]);
}
async function noSecrets(f: Fixture, responses: unknown[] = []) {
  const persisted: unknown[] = [...responses, logs];
  for (const table of ["connections", "conversations", "contacts", "messages", "inbox", "outbox", "events", "audit", "channel_delivery_state"])
    persisted.push(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile));
  persisted.push(await all(env, "SELECT payload FROM channel_events WHERE connection_id=?", f.line));
  persisted.push(await all(env, "SELECT response FROM receipts WHERE scope LIKE ?", `%${f.profile}%`));
  const text = JSON.stringify(persisted);
  for (const secret of [TOKEN, f.secret, "chave-sintetica-aceite", "email-sintetico-aceite", "corpo-remoto-proibido"])
    expect(text).not.toContain(secret);
  expect(text).not.toMatch(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot/);
}

describe("c2-aceite: Worker e Coordinator de produção", { timeout: 120_000 }, () => {
  it("canal não usado e segredo forjado não produzem atendimento, fila ou mídia", async () => {
    const f = await setup("telegram"), input = telegramEvent();
    expect((await webhook(f, input, true)).status).toBe(403); await noEffects(f);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false')) WHERE id=?", f.line);
    expect((await webhook(f, input)).ok).toBe(true); await noEffects(f);
    expect((await env.MEDIA.list()).objects).toEqual([]);
    await noSecrets(f);
  });

  it("Telegram percorre entrada concorrente, identidade, ação HTTP, alarme e conclusão sem repetir envio", async () => {
    const f = await setup("telegram"), input = telegramEvent();
    const received = await Promise.all([webhook(f, input), webhook(f, input)]);
    expect(received.map(response => response.ok)).toEqual([true, true]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toHaveLength(1);
    const conversation = await claim(f), key = uid();
    const responses = await Promise.all([action(f, conversation.id, { type: "message.send", text: "Olá, vamos ajudar." }, key),
      action(f, conversation.id, { type: "message.send", text: "Olá, vamos ajudar." }, key)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND kind='channel'", f.profile)).toHaveLength(1);
    let calls = 0;
    remote = async request => {
      expect(request.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`); expect(request.method).toBe("POST");
      expect(await request.json()).toMatchObject({ chat_id: "901234567", text: expect.stringContaining("Olá, vamos ajudar.") });
      calls++; return Response.json({ ok: true, result: { message_id: 777 } });
    };
    await alarm(f); await alarm(f);
    expect(calls).toBe(1);
    expect(await one(env, "SELECT status,completion_handled FROM outbox WHERE profile_id=? AND kind='channel'", f.profile))
      .toEqual({ status: "sent", completion_handled: 1 });
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", conversation.id)).toHaveLength(1);
    expect(await one(env, "SELECT verified_phone FROM conversations WHERE id=?", conversation.id)).toEqual({ verified_phone: null });
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    await noSecrets(f);
  });

  it.each(["instagram", "facebook"] as const)("%s: privada concorrente consome uma tentativa indeterminada e nunca executa bot", async channel => {
    const f = await setup(channel), remoteId = uid(), postId = uid();
    await concurrentZernioIngress(f, { id: uid(), event: "comment.received", account: account(f),
      comment: { id: remoteId, text: "Preciso de informação.", author: { id: "autor" }, createdAt: now() - 1000 }, post: { id: postId } });
    const conversation = await claim(f), row = (await one<{ id: string }>(env, "SELECT id FROM channel_comments WHERE profile_id=?", f.profile))!;
    const input = { type: "comment.private", commentId: row.id, text: "Podemos conversar em privado." };
    const responses = await Promise.all([action(f, conversation.id, input), action(f, conversation.id, input)]);
    expect(responses.filter(response => response.ok)).toHaveLength(1);
    const rejected = responses.find(response => !response.ok)!;
    expect(await rejected.json()).toMatchObject({ error: { code: "private_reply_used" } });
    let calls = 0;
    remote = request => {
      expect(new URL(request.url).pathname).toBe(`/api/v1/inbox/comments/${postId}/${remoteId}/private-reply`);
      expect(request.method).toBe("POST"); calls++;
      return Response.json({ success: false, error: "chave-sintetica-aceite corpo-remoto-proibido" }, { status: 500 });
    };
    await alarm(f); await alarm(f);
    expect(calls).toBe(1);
    expect(await one(env, "SELECT private_state FROM channel_comments WHERE id=?", row.id)).toEqual({ private_state: "unknown" });
    expect(await one(env, "SELECT status,completion_handled FROM outbox WHERE profile_id=? AND kind='channel'", f.profile))
      .toEqual({ status: "unknown", completion_handled: 1 });
    expect((await action(f, conversation.id, input)).ok).toBe(false);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=? AND chat_type='direct'", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    await noSecrets(f);
  });

  it("Google conclui publicação e push pelo alarme; revogação barra replay e nova publicação sem criar contato", async () => {
    const f = await setup("googlebusiness"), remoteId = uid();
    const pushes: Array<{ token: string; title: string; data: Record<string, string> }> = [];
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["conversations"]), f.other.id);
    await setSecret(env, "push:config", { mode: "gateway", gateway_url: "https://push.example.test", preview: "preview", ticket_alert_minutes: 0 });
    for (const person of [f.admin, f.member, f.other]) await exec(env,
      "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,'android','fcm',?,'Aceite','1',?,'https://test',?,?)",
      uid(), person.id, `device:${person.id}`, JSON.stringify([f.profile]), now(), now());
    await processPush(env, f.profile); // Estabelece o cursor anterior à entrada.
    const incoming = { id: uid(), event: "review.new", account: account(f),
      review: { id: remoteId, rating: 4, text: "Atendimento atencioso.", authorName: "Nome privado do autor", publishedAt: now() } };
    await concurrentZernioIngress(f, incoming);
    const review = (await one<{ id: string; version: number }>(env, "SELECT id,version FROM reviews WHERE profile_id=?", f.profile))!;
    expect(review).not.toBeNull();
    expect((await api(f, "PUT", `c2/reviews/${review.id}/reply`, { version: review.version, text: "Obrigada pela avaliação." })).status).toBe(200);
    let publications = 0;
    remote = async request => {
      if (new URL(request.url).pathname === "/api/v1/inbox/reviews" && request.method === "GET") {
        expect(new URL(request.url).searchParams.get("accountId")).toBe(f.account);
        // Reconciliação real no mesmo alarme: ausência na página não é exclusão.
        return Response.json({ accountId: f.account, reviews: [], nextCursor: null });
      }
      if (request.url === "https://push.example.test/v1/push" && request.method === "POST") {
        const body = await request.json() as { messages: typeof pushes }; pushes.push(...body.messages);
        return Response.json({ results: body.messages.map(message => ({ token: message.token, status: "ok" })) });
      }
      if (new URL(request.url).pathname === `/api/v1/inbox/reviews/${remoteId}/reply` && request.method === "POST") {
        publications++; return Response.json({ success: true, reply: { updatedAt: now() } });
      }
      unexpected.push("operação Google não prevista"); throw new Error("Rede inesperada.");
    };
    await alarm(f);
    expect(publications).toBe(1);
    expect(pushes.map(push => push.token).sort()).toEqual([`device:${f.admin.id}`, `device:${f.member.id}`].sort());
    expect(JSON.stringify(pushes)).not.toContain(incoming.review.authorName);
    for (const push of pushes) {
      expect(push.title).toBe("Google · nova avaliação de 4 estrelas");
      expect(push.data).toMatchObject({ type: "web", review_id: review.id });
      expect(push.data).not.toHaveProperty("conversation_id");
    }
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "Obrigada pela avaliação." });
    expect((await api(f, "PUT", `c2/review-publishers/${f.member.id}`, {})).status).toBe(200);
    const version = (await one<{ version: number }>(env, "SELECT version FROM reviews WHERE id=?", review.id))!.version;
    const key = uid(), path = `c2/reviews/${review.id}/reply`, body = { version, text: "Publicação revogada." };
    expect((await api(f, "PUT", path, body, key, f.member)).status).toBe(200);
    expect((await api(f, "DELETE", `c2/review-publishers/${f.member.id}`, {})).status).toBe(200);
    expect((await api(f, "PUT", path, body, key, f.member)).status).toBe(403);
    await alarm(f); expect((await acceptedWebhook(f, incoming)).duplicate).toBe(true); await alarm(f);
    expect(publications).toBe(1); expect(pushes).toHaveLength(2);
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "Obrigada pela avaliação." });
    expect(await all(env, "SELECT status,completion_handled,conversation_id FROM outbox WHERE profile_id=? AND kind='channel' ORDER BY rowid", f.profile))
      .toEqual([{ status: "sent", completion_handled: 1, conversation_id: null }, { status: "failed", completion_handled: 1, conversation_id: null }]);
    for (const table of ["contacts", "conversations", "messages", "bot_runs"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
    await noSecrets(f);
  });

  it("TikTok limita onze pedidos HTTP concorrentes a dez reservas; falha remota não devolve vaga", async () => {
    const f = await setup("tiktok"), thread = uid();
    const incoming = { id: uid(), event: "message.received", account: account(f),
      conversation: { id: thread, participantId: "sujeito-opaco", type: "direct" },
      message: { platformMessageId: uid(), conversationId: thread, direction: "incoming", sentAt: now() - 1000,
        text: "Olá.", sender: { id: "sujeito-opaco" }, recipient: { id: f.account }, attachments: [] } };
    await concurrentZernioIngress(f, incoming);
    const conversation = await claim(f);
    const responses = await Promise.all(Array.from({ length: 11 }, (_, i) => action(f, conversation.id, { type: "message.send", text: `Resposta ${i + 1}.` })));
    expect(responses.filter(response => response.ok)).toHaveLength(10);
    expect(await responses.find(response => !response.ok)!.json()).toMatchObject({ error: { code: "quota_exhausted" } });
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=?", f.profile)).toHaveLength(10);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND kind='channel'", f.profile)).toHaveLength(10);
    let calls = 0;
    remote = request => {
      expect(new URL(request.url).pathname).toBe(`/api/v1/inbox/conversations/${thread}/messages`); expect(request.method).toBe("POST");
      calls++; return Response.json({ success: false, error: "corpo-remoto-proibido" }, { status: 500 });
    };
    await alarm(f); await alarm(f);
    expect(calls).toBe(1); // Unknown serializa o recurso e impede as nove saídas seguintes.
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=? AND state='unknown'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM tiktok_send_slots WHERE profile_id=? AND state='reserved'", f.profile)).toHaveLength(9);
    const renewed = { ...incoming, id: uid(), message: { ...incoming.message, platformMessageId: uid(), sentAt: now() } };
    await acceptedWebhook(f, renewed);
    expect(await (await action(f, conversation.id, { type: "message.send", text: "A nova entrada não zera a quota." })).json())
      .toMatchObject({ error: { code: "quota_exhausted" } });
    await noSecrets(f);
  });

  it("e-mail HTML hostil entra pelo runtime uma vez, não prova remetente e saída aguarda contrato confirmado", async () => {
    const f = await setup("email");
    const raw = new TextEncoder().encode(`From: Pessoa <exibido@example.test>\r\nTo: ${f.address}\r\nReply-To: outro@example.test\r\nSubject: Informação com acentos\r\nMessage-ID: <aceite@example.test>\r\nAuthentication-Results: forjado.example; dmarc=pass\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>Olá, informação pública.</p><script>segredoExecutavel()</script><img src="https://remoto.invalid/pixel"><style>body{display:none}</style>`);
    const receive = async () => {
      const message = { from: "envelope@example.test", to: f.address, rawSize: raw.byteLength, headers: new Headers(),
        raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
        setReject: vi.fn(), forward: vi.fn(), reply: vi.fn() } as unknown as ForwardableEmailMessage;
      const ctx = createExecutionContext(); await Worker.email(message, env, ctx); await waitOnExecutionContext(ctx);
      expect(message.setReject).not.toHaveBeenCalled(); expect(message.forward).not.toHaveBeenCalled(); expect(message.reply).not.toHaveBeenCalled();
    };
    await Promise.all([receive(), receive()]); await quietCoordinator(f.profile); await alarm(f);
    expect(await all(env, "SELECT state FROM email_channel_inbox WHERE profile_id=?", f.profile)).toEqual([{ state: "processed" }]);
    const conversation = await claim(f);
    expect(conversation.channel_subject_id).toBe("envelope@example.test"); expect(conversation.verified_phone).toBeNull();
    expect(json(conversation.channel_context).identityTrust).toBe("unverified_sender");
    const messages = await all<{ text: string; content: string }>(env, "SELECT text,content FROM messages WHERE conversation_id=? AND direction='customer'", conversation.id);
    expect(messages).toHaveLength(1); expect(messages[0].text).toContain("Olá, informação pública.");
    expect(JSON.stringify(messages)).not.toMatch(/<script|<img|<style|segredoExecutavel|remoto\.invalid/);
    const response = await action(f, conversation.id, { type: "email.send", subject: "Re: Informação com acentos", text: "Resposta." });
    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({ error: { code: "provider_contract_unverified" } });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND kind='channel'", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM email_log WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    await receive(); await alarm(f);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='customer'", conversation.id)).toHaveLength(1);
    await noSecrets(f);
  });
});
