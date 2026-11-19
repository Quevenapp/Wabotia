// Mesma fixture, sem transformação, nos commits de referência e na árvore atual.
// Sem import de c2-fixtures: o main instala todos os descritores reais.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { all, exec, one } from "../src/db";
import { deliver, processInbox } from "../src/engine";
import { processPush } from "../src/push";
import { hmac, setSecret } from "../src/security";
import { now, uid, type Env } from "../src/types";
import { perform } from "../src/service";
import { fixture, bearer, quietCoordinator } from "./service-center-fixture";

type Call = { method: string; sql: string[]; writes: number; rowsRead: number | null; rowsWritten: number | null; failed: boolean };
type Count = { calls: number; statements: number; writes: number; rowsRead: number; rowsWritten: number; metadataResults: number; trace: Call[] };
const empty = (): Count => ({ calls: 0, statements: 0, writes: 0, rowsRead: 0, rowsWritten: 0, metadataResults: 0, trace: [] });
const profiles = new Set<string>();
const unexpected: string[] = [];
const secret = "cn-baseline-fixture-assinatura-v1";

// Observa chamadas reais ao D1, inclusive cada instrução de cada batch.
// first()/raw() não devolvem metadata: null não significa zero linhas.
function meter(original: Env, failure?: "before" | "after") {
  const count = empty(), raw = new WeakMap<object, any>(), sqls = new WeakMap<object, string>();
  let injected = false;
  const invoke = async (method: string, sql: string[], fn: () => Promise<any>) => {
    const writes = sql.filter(s => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(s.replace(/'[^']*'/g, ""))).length;
    const trace: Call = { method, sql, writes, rowsRead: null, rowsWritten: null, failed: false };
    count.calls++; count.statements += sql.length; count.writes += writes; count.trace.push(trace);
    try {
      const value = await fn();
      const results = method === "batch" ? value : [value];
      for (const result of results) if (result?.meta) {
        count.metadataResults++;
        if (typeof result.meta.rows_read === "number") {
          trace.rowsRead = (trace.rowsRead ?? 0) + result.meta.rows_read;
          count.rowsRead += result.meta.rows_read;
        }
        if (typeof result.meta.rows_written === "number") {
          trace.rowsWritten = (trace.rowsWritten ?? 0) + result.meta.rows_written;
          count.rowsWritten += result.meta.rows_written;
        }
      }
      return value;
    } catch (error) { trace.failed = true; throw error; }
  };
  const wrap = (statement: any, sql: string): any => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: any[]) => wrap(target.bind(...args), sql);
      if (["all", "first", "run", "raw"].includes(String(key)))
        return (...args: any[]) => invoke(String(key), [sql], () => target[key](...args));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(proxy, statement); sqls.set(proxy, sql); return proxy;
  };
  const DB = new Proxy(original.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => wrap(db.prepare(sql), sql);
    if (key === "batch") return (statements: any[]) => invoke("batch", statements.map(s => sqls.get(s) || "UNOBSERVED"), async () => {
      const fail = !injected && failure && statements.some(s => /INSERT(?: OR IGNORE)? INTO inbox/i.test(sqls.get(s) || ""));
      if (fail) injected = true;
      if (fail && failure === "before") throw new Error("cn: queda antes do lote");
      const result = await db.batch(statements.map(s => raw.get(s) || s));
      if (fail && failure === "after") throw new Error("cn: resposta perdida depois do lote");
      return result;
    });
    const value = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  } });
  return { env: { ...original, DB } as Env, count, injected: () => injected };
}
const aggregate = (counts: Count[]): Count => counts.reduce((out, c) => ({
  calls: out.calls + c.calls, statements: out.statements + c.statements,
  writes: out.writes + c.writes, rowsRead: out.rowsRead + c.rowsRead,
  rowsWritten: out.rowsWritten + c.rowsWritten, metadataResults: out.metadataResults + c.metadataResults,
  trace: [...out.trace, ...c.trace],
}), empty());


const forbidden = /\b(?:channel_delivery_state|channel_public_grants|channel_comments|telegram_callbacks|tiktok_send_slots|reviews|channel_sync_state|email_channel_addresses|email_channel_inbox|email_channel_blocks|email_channel_probes)\b/i;
type Report = Record<string, Record<string, Count>>;
beforeEach(() => {
  // Também vale na suíte externa direta, fora do wrapper de comparação.
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2040, 0, 1));
});
function publish(task: { meta: object }, group: string, report: Report, observations: Report = {}) {
  for (const phases of Object.values(report)) for (const count of Object.values(phases)) {
    expect(count.calls).toBe(count.trace.length);
    expect(count.statements).toBe(count.trace.reduce((sum, call) => sum + call.sql.length, 0));
    for (const sql of count.trace.flatMap(call => call.sql)) {
      expect(sql).not.toBe("UNOBSERVED");
      expect(sql, "Canal não usado: nenhuma tabela da segunda leva no caminho de mensagem.").not.toMatch(forbidden);
    }
  }
  (task.meta as Record<string, unknown>).c2BaselineReport = JSON.stringify({ fixtureVersion: 1, group, report, observations });
}
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
  unexpected.length = 0;
}, 60_000);

async function measured(fn: (environment: Env) => Promise<unknown>) {
  const m = meter(env); await fn(m.env); return m.count;
}
async function http(profile: string, request: Request, failure?: "before" | "after") {
  await quietCoordinator(profile);
  const stub = () => env.COORDINATOR.get(env.COORDINATOR.idFromName(profile));
  let original!: Env, coordinator!: ReturnType<typeof meter>;
  await runInDurableObject<DurableObject, void>(stub(), async (instance: any) => {
    original = instance.env; coordinator = meter(original, failure); instance.env = coordinator.env;
  });
  const m = meter(env), ctx = createExecutionContext();
  let response!: Response;
  try {
    response = await worker.fetch(request, m.env, ctx);
    await waitOnExecutionContext(ctx);
    await quietCoordinator(profile);
  } finally {
    await runInDurableObject<DurableObject, void>(stub(), async (instance: any, state) => {
      await state.storage.deleteAlarm();
      if (instance.env === coordinator.env) instance.env = original;
    });
    if (failure) expect(coordinator.injected()).toBe(true);
  }
  return { response, worker: m.count, coordinator: coordinator.count };
}
async function alarm(profile: string) {
  return runInDurableObject<DurableObject, Count>(env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)), async (instance: any, state) => {
    const original = instance.env, m = meter(original); instance.env = m.env;
    try { await instance.alarm(); } finally { instance.env = original; await state.storage.deleteAlarm(); }
    return m.count;
  });
}
async function setup(channel: "instagram" | "facebook") {
  const f = await fixture(); profiles.add(f.profile);
  const integration = uid(), account = uid().replaceAll("-", "").slice(0, 24), remoteProfile = uid().replaceAll("-", "").slice(0, 24);
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Baseline C2',?,'zernio',?,?)",
    integration, f.profile, "zernio:" + remoteProfile, remoteProfile, now());
  // Canal não usado: não habilita comentários nem qualquer recurso c2.
  await exec(env, "UPDATE connections SET channel=?,account_label='@loja',config=? WHERE id=?", channel,
    JSON.stringify({ account_id: account, zernio_workspace_id: integration, zernio_profile_id: remoteProfile,
      service: { mode: "human", menu_mode: "off" } }), f.line);
  await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,'@loja',?,?)",
    f.line, f.profile, integration, channel, account, remoteProfile, now(), now());
  await setSecret(env, "zernio-account:" + integration, { api_key: "c2-baseline-key", webhook_secret: secret });
  return { ...f, channel, integration, account, remoteProfile, token: await bearer(f.admin) };
}
type SocialFixture = Awaited<ReturnType<typeof setup>>;
// Formato do plano; a conferir com a conta real.
function event(f: SocialFixture, subject = "sujeito-opaco") {
  return { id: uid(), event: "message.received", timestamp: new Date(now()).toISOString(),
    account: { accountId: f.account, platform: f.channel, profileId: f.remoteProfile },
    conversation: { id: uid(), participantId: subject },
    message: { platform: f.channel, platformMessageId: uid(), direction: "incoming", text: "Informação, por favor.",
      sentAt: new Date(now() - 1000).toISOString(), sender: { id: subject, name: "Ana", username: "ana.sintetica" } } };
}
async function webhook(f: SocialFixture, body: unknown, failure?: "before" | "after", forged = false) {
  const raw = JSON.stringify(body);
  return http(f.profile, new Request("https://test/webhooks/zernio-accounts/" + f.integration, {
    method: "POST", headers: { "Content-Type": "application/json",
      "X-Zernio-Signature": forged ? "assinatura-forjada" : await hmac(secret, raw) }, body: raw }), failure);
}
function command(f: SocialFixture, id: string, key: string, text: string) {
  return new Request("https://test/api/v1/profiles/" + f.profile + "/conversations/" + id + "/actions", {
    method: "POST", headers: { Authorization: "Bearer " + f.token, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ action: "reply", text }) });
}
for (const channel of ["instagram", "facebook"] as const) {
  it("C2_SOCIAL_BASELINE_V1: " + channel + " direto sem segunda leva", async ({ task }) => {
    const f = await setup(channel), report: Report = {}, observations: Report = {};
    const outbound: any[] = [], notifications: any[] = [];
    let downloads = 0, failDelivery = false;
    const mediaUrl = "https://scontent.xx.fbcdn.net/c2-baseline.png";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (request.url === "https://push.example.test/v1/push" && request.method === "POST") {
        const body = await request.json() as any; notifications.push(...body.messages);
        return Response.json({ results: body.messages.map((m: any) => ({ token: m.token, status: "ok" })) });
      }
      if (request.url === mediaUrl && request.method === "GET") {
        downloads++;
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "Content-Type": "image/png" } });
      }
      if (url.origin === "https://zernio.com" && request.method === "POST" &&
          /^\/api\/v1\/inbox\/conversations\/[^/]+\/messages$/.test(url.pathname) &&
          request.headers.get("Authorization") === "Bearer c2-baseline-key") {
        const body = await request.json() as any; expect(body.accountId).toBe(f.account);
        outbound.push(body);
        if (failDelivery) throw new Error("Resposta perdida após possível envio.");
        return Response.json({ data: { messageId: "c2-out-" + outbound.length } });
      }
      unexpected.push("Fronteira externa não prevista."); throw new Error("Rede não prevista.");
    });
    await setSecret(env, "push:config", { mode: "gateway", gateway_url: "https://push.example.test", preview: "preview", ticket_alert_minutes: 0 });
    await exec(env, "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,'android','fcm',?,'Baseline','1',?,'https://test',?,?)",
      uid(), f.admin.id, "c2-device-" + channel, JSON.stringify([f.profile]), now(), now());
    await processPush(env, f.profile);
    const pipeline = async (name: string, body: unknown) => {
      const result = await webhook(f, body);
      expect(result.response.ok, await result.response.clone().text()).toBe(true);
      const parts = { worker: result.worker, coordinator: result.coordinator,
        engine: await measured(e => processInbox(e, f.profile)),
        outbox: await measured(async e => {
          for (const row of await all(e, "SELECT * FROM outbox WHERE profile_id=? AND status='pending' ORDER BY created,rowid", f.profile)) await deliver(e, row);
        }), push: await measured(e => processPush(e, f.profile)) };
      report[channel + "." + name] = { ...parts, aggregate: aggregate(Object.values(parts)) };
    };
    const first = event(f);
    const forged = await webhook(f, first, undefined, true);
    expect(forged.response.status).toBe(403);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    report[channel + ".forged"] = { worker: forged.worker, coordinator: forged.coordinator, aggregate: aggregate([forged.worker, forged.coordinator]) };
    await pipeline("first", first);
    const c = await one(env, "SELECT * FROM conversations WHERE connection_id=?", f.line);
    expect(c).toMatchObject({ channel, phone: null, verified_phone: null });
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", f.admin.id, c.id);
    await pipeline("next", { ...first, id: uid(), message: { ...first.message, platformMessageId: uid() } });
    await pipeline("replay", first);
    const media = event(f, "pessoa-midia") as any;
    media.message.attachments = [{ type: "image", mimeType: "image/png", url: mediaUrl }];
    await pipeline("media", media); await pipeline("media_replay", media);
    expect(downloads).toBe(1);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toHaveLength(1);

    const key = uid(), sent = await http(f.profile, command(f, c.id, key, "Resposta humana."));
    expect(sent.response.status).toBe(200);
    const outbox = await measured(async e => {
      for (const row of await all(e, "SELECT * FROM outbox WHERE conversation_id=? AND status='pending' ORDER BY created,rowid", c.id)) await deliver(e, row);
    });
    expect(outbound).toHaveLength(1);
    expect(await one(env, "SELECT status FROM outbox WHERE conversation_id=?", c.id)).toEqual({ status: "sent" });
    report[channel + ".reply"] = { worker: sent.worker, coordinator: sent.coordinator, outbox, aggregate: aggregate([sent.worker, sent.coordinator, outbox]) };
    const replay = await http(f.profile, command(f, c.id, key, "Resposta humana."));
    expect(replay.response.status).toBe(200);
    report[channel + ".reply_replay"] = { worker: replay.worker, coordinator: replay.coordinator, aggregate: aggregate([replay.worker, replay.coordinator]) };
    const localDelivery = await one(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id);
    await pipeline("echo", { ...first, id: uid(), event: "message.sent",
      metadata: { localDeliveryId: localDelivery.id },
      message: { ...first.message, platformMessageId: "c2-out-1", direction: "outgoing", sender: { id: f.account }, recipient: first.message.sender, text: "Resposta humana." } });
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", c.id)).toHaveLength(1);
    await pipeline("event", { ...first, id: uid(), event: "message.edited",
      message: { ...first.message, text: "Informação corrigida.", editedAt: new Date(now()).toISOString() } });
    expect(await one(env, "SELECT text FROM messages WHERE conversation_id=? AND external_id=?", c.id, first.message.platformMessageId))
      .toEqual({ text: "Informação corrigida." });

    for (const mode of ["before", "after"] as const) {
      const contactsBefore = await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile);
      const failedEvent = event(f, "falha-" + mode), failed = await webhook(f, failedEvent, mode);
      const failedCalls = failed.coordinator.trace.filter(call => call.failed);
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0].method).toBe("batch");
      expect(failedCalls[0].sql.some(sql => /INSERT INTO inbox/i.test(sql))).toBe(true);
      const persistedInbox = await all<{ id: string; conversation_id: string }>(env,
        "SELECT id,conversation_id FROM inbox WHERE profile_id=? AND event_key LIKE ?", f.profile, `%:${failedEvent.message.platformMessageId}`);
      const persistedMessages = await all<{ id: string }>(env,
        "SELECT id FROM messages WHERE profile_id=? AND external_id=? AND direction='customer'", f.profile, failedEvent.message.platformMessageId);
      expect(persistedInbox).toHaveLength(mode === "before" ? 0 : 1);
      expect(persistedMessages).toHaveLength(mode === "before" ? 0 : 1);
      expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(contactsBefore.length + (mode === "before" ? 0 : 1));
      // Desde a primeira leva, inboundSocial recupera a resposta perdida do
      // lote consultando a inbox confirmada. Esse caso é 202/duplicate, não
      // uma falha HTTP; antes do lote, nenhum recibo existe e o erro propaga.
      if (mode === "before") expect(failed.response.status).toBeGreaterThanOrEqual(500);
      else {
        expect(failed.response.status).toBe(202);
        expect(await failed.response.json()).toEqual({ conversation_id: persistedInbox[0].conversation_id, duplicate: true });
      }
      report[channel + ".failure_" + mode] = { worker: failed.worker, coordinator: failed.coordinator, aggregate: aggregate([failed.worker, failed.coordinator]) };
      await pipeline("recovery_" + mode, failedEvent);
      const recoveredMessages = await all<{ id: string }>(env,
        "SELECT id FROM messages WHERE profile_id=? AND external_id=? AND direction='customer'", f.profile, failedEvent.message.platformMessageId);
      expect(recoveredMessages).toHaveLength(1);
      expect(await all(env, "SELECT id FROM inbox WHERE profile_id=? AND event_key LIKE ?", f.profile, `%:${failedEvent.message.platformMessageId}`)).toHaveLength(1);
      expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(contactsBefore.length + 1);
      if (mode === "after") expect(recoveredMessages).toEqual(persistedMessages);
    }
    const alarmEvent = event(f, "alarme");
    const queued = await webhook(f, alarmEvent); expect(queued.response.ok).toBe(true);
    const reply = await http(f.profile, command(f, c.id, uid(), "Entrega pelo alarme."));
    expect(reply.response.status).toBe(200);
    const alarmCount = await alarm(f.profile);
    report[channel + ".alarm"] = { coordinator: alarmCount, aggregate: aggregate([alarmCount]) };
    expect(outbound).toHaveLength(2);
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=? AND status!='done'", f.profile)).toEqual([]);
    expect(notifications.some(n => n.data.conversation_id === c.id)).toBe(true);

    failDelivery = true;
    const failureCommand = await http(f.profile, command(f, c.id, uid(), "Resultado indeterminado."));
    expect(failureCommand.response.status).toBe(200);
    const deliveryFailure = await measured(async e => {
      for (const row of await all(e, "SELECT * FROM outbox WHERE conversation_id=? AND status='pending' ORDER BY created,rowid", c.id)) await deliver(e, row);
    });
    report[channel + ".delivery_failure"] = { worker: failureCommand.worker, coordinator: failureCommand.coordinator,
      outbox: deliveryFailure, aggregate: aggregate([failureCommand.worker, failureCommand.coordinator, deliveryFailure]) };
    expect(outbound).toHaveLength(3);
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND status='unknown'", c.id)).toHaveLength(1);

    // Consulta explícita de ficha: fora do caminho de recebimento. O delta é
    // publicado separadamente e não descontado de nenhuma fase da mensagem.
    const contact = await one(env, "SELECT contact_id id FROM conversation_contacts WHERE profile_id=? AND conversation_id=?", f.profile, c.id);
    const profile = await http(f.profile, new Request("https://test/api/v1/profiles/" + f.profile + "/contacts/" + contact.id + "/profile",
      { headers: { Authorization: "Bearer " + f.token } }));
    expect(profile.response.status).toBe(200);
    observations[channel + ".contact_profile"] = { worker: profile.worker, coordinator: profile.coordinator, aggregate: aggregate([profile.worker, profile.coordinator]) };
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
    publish(task, "social", report, observations);
  }, 180_000);
}

it("C2_LEGACY_EXTRA_V1: conversa interna sem canal novo", async ({ task }) => {
  const f = await fixture(); profiles.add(f.profile);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    unexpected.push("Rede inesperada."); throw new Error("Conversa interna não usa fornecedor.");
  });
  const report: Report = {};
  let chat: any;
  const create = await measured(async e => { chat = await perform(e, f.admin, f.profile, "internal.create", { peer_id: f.member.id }, uid()); });
  report.internal_create = { service: create, aggregate: aggregate([create]) };
  const key = uid();
  const send = await measured(e => perform(e, f.admin, f.profile, "internal.send", { id: chat.id, text: "Olá, equipe." }, key));
  report.internal_send = { service: send, aggregate: aggregate([send]) };
  const replay = await measured(e => perform(e, f.admin, f.profile, "internal.send", { id: chat.id, text: "Olá, equipe." }, key));
  report.internal_replay = { service: replay, aggregate: aggregate([replay]) };
  expect(await all(env, "SELECT text FROM internal_messages WHERE chat_id=?", chat.id)).toEqual([{ text: "Olá, equipe." }]);
  publish(task, "legacy", report);
}, 60_000);

