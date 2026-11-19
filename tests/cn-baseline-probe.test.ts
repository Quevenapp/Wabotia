// Este arquivo e service-center-fixture.ts são copiados, sem transformação,
// para 20e15da9 pelo script. Não importar módulos exclusivos da leva aqui.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { all, exec, one, withReadCache } from "../src/db";
import { processInbox, deliver } from "../src/engine";
import { processPush } from "../src/push";
import { hmac, setSecret } from "../src/security";
import { now, uid, type Env } from "../src/types";
import { fixture, bearer, configure, quietCoordinator } from "./service-center-fixture";
import { identityPort } from "../src/customer/ports";
import { inboundConnection } from "../src/customer/identity";
import { conversation } from "../src/service";

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

afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
  unexpected.length = 0;
});

it("CN_BASELINE_PROBE_V3: Worker, Coordinator, motor, outbox e push reais", async ({ task }) => {
  const outbound: any[] = [], notifications: any[] = [];
  let mediaDownloads = 0;
  const allowedThreads = new Set<string>(), allowedAccounts = new Set<string>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (request.url === "https://push.example.test/v1/push" && request.method === "POST") {
      const body = await request.json() as any;
      notifications.push(...body.messages);
      return Response.json({ results: body.messages.map((m: any) => ({ token: m.token, status: "ok" })) });
    }
    if (url.origin === "https://zernio.com" && request.headers.get("Authorization") === "Bearer cn-fixture-key") {
      const match = url.pathname.match(/^\/api\/v1\/inbox\/conversations\/([^/]+)\/messages$/);
      if (request.method === "POST" && match && allowedThreads.has(match[1])) {
        const body = await request.json() as any;
        expect(allowedAccounts.has(body.accountId)).toBe(true);
        expect(request.headers.get("Idempotency-Key")).toBeTruthy();
        outbound.push(body);
        return Response.json({ data: { messageId: `cn-delivery-${outbound.length}` } });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/whatsapp/media/cn-fixture-image" && allowedAccounts.has(url.searchParams.get("accountId") || "")) {
        mediaDownloads++;
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "Content-Type": "image/png" } });
      }
    }
    unexpected.push(`${request.method} ${request.url}`);
    throw new Error("Fronteira externa não prevista pela fixture CN.");
  });
  const f = await fixture(); profiles.add(f.profile);
  await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ service: { mode: "human", menu_mode: "off" } }), f.qr);
  const token = await bearer(f.admin);
  const accounts = new Map<string, string>();
  for (const line of [f.line, f.second]) {
    const account = uid().replaceAll("-", "").slice(0, 24), integration = uid();
    accounts.set(line, account); allowedAccounts.add(account);
    await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Fixture CN',?,'zernio',?)", integration, f.profile, `cn:${integration}`, now());
    await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ account_id: account, zernio_workspace_id: integration, service: { mode: "human", menu_mode: "off" } }), line);
    await setSecret(env, `zernio-account:${integration}`, { api_key: "cn-fixture-key", webhook_secret: secret });
  }
  await setSecret(env, "push:config", { mode: "gateway", gateway_url: "https://push.example.test", preview: "preview", ticket_alert_minutes: 0 });
  await exec(env, "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,'android','fcm','cn-device','Fixture','1',?,'https://test',?,?)", uid(), f.admin.id, JSON.stringify([f.profile]), now(), now());
  await processPush(env, f.profile); // Inicializa cursor fora da medição.
  const coordinatorId = env.COORDINATOR.idFromName(f.profile);
  // blockConcurrencyWhile rejeitado invalida os stubs da instância anterior.
  // Cada acesso, inclusive a limpeza após falha, precisa obter um stub novo.
  const coordinatorStub = () => env.COORDINATOR.get(coordinatorId);
  const report: Record<string, Record<string, Count>> = {};
  const measured = async (fn: (e: Env) => Promise<unknown>) => {
    const m = meter(env); await fn(m.env); return m.count;
  };
  // Só o binding D1 recebe proxy. O namespace, a instância, fetch, os ports,
  // a identidade e o alarme do Coordinator continuam sendo os de produção.
  const http = async (request: Request, failure?: "before" | "after") => {
    await quietCoordinator(f.profile);
    let originalEnv!: Env, coordinatorMeter!: ReturnType<typeof meter>;
    await runInDurableObject<DurableObject, void>(coordinatorStub(), async (instance: any) => {
      originalEnv = instance.env;
      coordinatorMeter = meter(instance.env, failure);
      instance.env = coordinatorMeter.env;
    });
    const m = meter(env), ctx = createExecutionContext();
    let response!: Response, coordinator = empty();
    try {
      response = await worker.fetch(request, m.env, ctx);
      await waitOnExecutionContext(ctx);
      await quietCoordinator(f.profile);
    } finally {
      await runInDurableObject<DurableObject, void>(coordinatorStub(), async (instance: any, state) => {
        await state.storage.deleteAlarm();
        // O stub novo alcança a instância reiniciada após a falha. O contador
        // sobrevive no teste; o env dessa nova instância já é o original.
        if (instance.env === coordinatorMeter.env) instance.env = originalEnv;
      });
      coordinator = coordinatorMeter.count;
      if (failure) expect(coordinatorMeter.injected()).toBe(true);
    }
    return { response, worker: m.count, coordinator };
  };
  const makeEvent = (line = f.line, phone = "5511979990201") => {
    const thread = uid(); allowedThreads.add(thread);
    return { id: uid(), event: "message.received", timestamp: new Date().toISOString(),
      account: { accountId: accounts.get(line), platform: "whatsapp" }, conversation: { id: thread, participantId: phone },
      message: { platform: "whatsapp", platformMessageId: uid(), direction: "incoming", text: "Olá", sentAt: new Date(now() - 1000).toISOString(), sender: { id: phone, name: "Ana", phoneNumber: phone } } };
  };
  const requestFor = async (event: any, line = f.line) => {
    const body = JSON.stringify(event);
    return new Request(`https://test/webhooks/zernio/${line}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Zernio-Signature": await hmac(secret, body) }, body });
  };
  const pipeline = async (name: string, event: any, line = f.line) => {
    const result = await http(await requestFor(event, line));
    expect(result.response.ok, await result.response.clone().text()).toBe(true);
    const parts: Record<string, Count> = { worker: result.worker, coordinator: result.coordinator };
    const current = await one(env, "SELECT id FROM conversations WHERE profile_id=? AND connection_id=? AND external_id=?", f.profile, line, event.conversation.participantId);
    expect(current).toBeTruthy();
    const pending = await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='pending'", f.profile);
    expect(pending.n, `${name}: alarme antecipado contaminou a fase do motor`).toBe(["duplicate", "media_duplicate"].includes(name) ? 0 : 1);
    parts.engine = await measured(e => processInbox(e, f.profile));
    parts.outbox = await measured(async e => {
      for (const row of await all(e, "SELECT * FROM outbox WHERE profile_id=? AND conversation_id=? AND status='pending' ORDER BY created,rowid", f.profile, current.id)) await deliver(e, row);
    });
    parts.push = await measured(e => processPush(e, f.profile));
    parts.aggregate = aggregate(Object.values(parts)); report[name] = parts;
    expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status!='done'", f.profile)).toEqual({ n: 0 });
  };
  const first = makeEvent();
  await pipeline("first", first);
  // A linha humana acrescenta o portão e o evento da fila já em 20e15da9.
  // Seu custo completo continua no comparativo, sem subtrair instruções.
  // O teto histórico de entrada é conferido em inherit_first, abaixo.
  expect(report.first.engine.statements, JSON.stringify(report.first.engine)).toBeLessThanOrEqual(30);
  const c = await one(env, "SELECT * FROM conversations WHERE profile_id=? AND connection_id=?", f.profile, f.line);
  const readyEnv = withReadCache(env);
  await inboundConnection(readyEnv, f.line);
  const readyMeter = meter(readyEnv);
  const ready = await identityPort.prepareInbound(readyMeter.env, await conversation(env, c.id, f.profile), { provider: "zernio", phone: first.message.sender.phoneNumber });
  expect(ready).toEqual({ state: "ready", verifiedPhone: first.message.sender.phoneNumber, statements: [] });
  expect(readyMeter.count).toMatchObject({ statements: 0, calls: 0 });
  report.identity_ready = { coordinator: readyMeter.count, aggregate: aggregate([readyMeter.count]) };
  await exec(env, "UPDATE conversations SET state='human',owner=?,title='Ana' WHERE id=?", f.admin.id, c.id);
  await exec(env, "UPDATE contacts SET name='Ana' WHERE profile_id=?", f.profile);
  await pipeline("next", { ...first, id: uid(), message: { ...first.message, platformMessageId: uid() } });
  await pipeline("duplicate", first);
  const replayCount = await runInDurableObject<DurableObject, Count>(coordinatorStub(), async (instance: any, state) => {
    const original = instance.env, m = meter(original); instance.env = m.env;
    try {
      const response = await instance.fetch(new Request("https://coordinator/inbound", { method: "POST", body: JSON.stringify({ profile: f.profile, namespace: `channel:${f.line}`, connectionId: f.line,
        data: { external_id: first.conversation.participantId, phone: first.message.sender.phoneNumber, message_id: first.message.platformMessageId, text: first.message.text } }) }));
      expect(response.status).toBe(202);
    } finally { instance.env = original; await state.storage.deleteAlarm(); }
    return m.count;
  });
  expect(replayCount).toMatchObject({ calls: 1, statements: 1 });
  report.inbound_replay = { coordinator: replayCount, aggregate: aggregate([replayCount]) };
  expect(await one(env, "SELECT count(*) n FROM messages WHERE conversation_id=? AND direction='customer'", c.id)).toEqual({ n: 2 });
  await pipeline("second_connection", makeEvent(f.second), f.second);
  const media = makeEvent(f.line, "5511979990202") as any;
  media.message.attachments = [{ type: "image", url: "https://zernio.com/api/v1/whatsapp/media/cn-fixture-image", mimeType: "image/png" }];
  await pipeline("media", media);
  await pipeline("media_duplicate", media);
  expect(mediaDownloads).toBe(1);
  expect(await one(env, "SELECT count(*) n FROM media WHERE profile_id=?", f.profile)).toEqual({ n: 1 });

  // Uma resposta humana completa prova outbox e chamada externa, mesmo na
  // linha humana sem bot/IA. A chave também percorre o recibo real.
  const reply = { action: "reply", text: "Resposta de aceite WhatsApp" }, key = uid();
  const commandRequest = () => new Request(`https://test/api/v1/profiles/${f.profile}/conversations/${c.id}/actions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(reply),
  });
  const command = await http(commandRequest()); expect(command.response.status).toBe(200);
  const outbox = await measured(async e => {
    for (const row of await all(e, "SELECT * FROM outbox WHERE conversation_id=? AND status='pending' ORDER BY created,rowid", c.id)) await deliver(e, row);
  });
  expect(outbound).toHaveLength(1);
  expect(outbound[0].message).toContain(reply.text);
  const repeated = await http(commandRequest()); expect(repeated.response.status).toBe(200);
  expect(await one(env, "SELECT count(*) n FROM outbox WHERE conversation_id=?", c.id)).toEqual({ n: 1 });
  report.reply = { worker: command.worker, coordinator: command.coordinator, outbox, aggregate: aggregate([command.worker, command.coordinator, outbox]) };
  report.reply_duplicate = { worker: repeated.worker, coordinator: repeated.coordinator, aggregate: aggregate([repeated.worker, repeated.coordinator]) };
  expect(notifications.some(n => n.data.conversation_id === c.id && n.title === "Ana")).toBe(true);

  // O mesmo evento simultâneo passa pelo Worker e a serialização real do DO.
  const concurrent = makeEvent(f.line, "5511979990203"), body = await requestFor(concurrent), simultaneous = await requestFor(concurrent);
  const ctx = createExecutionContext();
  const responses = await Promise.all([worker.fetch(body, env, ctx), worker.fetch(simultaneous, env, ctx)]);
  await waitOnExecutionContext(ctx); await quietCoordinator(f.profile);
  responses.forEach(response => expect(response.ok).toBe(true));
  expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND event_key LIKE ?", f.profile, `%:${concurrent.message.platformMessageId}`)).toEqual({ n: 1 });
  const alarmReply = await http(new Request(`https://test/api/v1/profiles/${f.profile}/conversations/${c.id}/actions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": uid() },
    body: JSON.stringify({ action: "reply", text: "Entrega executada pelo alarme real" }),
  }));
  expect(alarmReply.response.status).toBe(200);
  expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='pending'", f.profile)).toEqual({ n: 1 });
  expect(await one(env, "SELECT count(*) n FROM outbox WHERE conversation_id=? AND status='pending'", c.id)).toEqual({ n: 1 });
  // Execute o alarme completo, inclusive manutenção, motor, entrega e push.
  report.alarm = { coordinator: await runInDurableObject<DurableObject, Count>(coordinatorStub(), async (instance: any, state) => {
    const original = instance.env, m = meter(original); instance.env = m.env;
    try { await instance.alarm(); } finally { instance.env = original; await state.storage.deleteAlarm(); }
    return m.count;
  }) };
  report.alarm.aggregate = aggregate(Object.values(report.alarm));
  expect(outbound).toHaveLength(2);
  expect(outbound[1].message).toContain("Entrega executada pelo alarme real");
  expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status!='done'", f.profile)).toEqual({ n: 0 });

  // Caminhos sem webhook Zernio: LID do QR, grupo e aplicação entram no
  // endpoint interno real (a origem está identificada no relatório).
  for (const [name, namespace, connection, extra] of [
    ["lid", `channel:${f.qr}`, f.qr, { external_id: "123456789012345@lid", phone: null }],
    ["group", `channel:${f.qr}`, f.qr, { external_id: "120000000000001@g.us", phone: null, chat_type: "group", content: { participant: "5511979990204@s.whatsapp.net" } }],
    ["application", "app:cn-baseline", null, { external_id: "cn-customer", phone: null }],
  ] as const) {
    const data = { text: "Mensagem sintética", message_id: uid(), ...extra };
    const count = await runInDurableObject<DurableObject, Count>(coordinatorStub(), async (instance: any, state) => {
      const original = instance.env, m = meter(original); instance.env = m.env;
      try {
        const response = await instance.fetch(new Request("https://coordinator/inbound", { method: "POST", body: JSON.stringify({ profile: f.profile, namespace, connectionId: connection, data }) }));
        expect(response.status).toBe(202);
      } finally { instance.env = original; await state.storage.deleteAlarm(); }
      return m.count;
    });
    report[name] = { coordinator: count, engine: await measured(e => processInbox(e, f.profile)) };
    report[name].aggregate = aggregate(Object.values(report[name]));
  }
  const ambiguousPhone = "5511979990205";
  for (let n = 0; n < 2; n++) {
    const contactId = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Ana',?,?,'manual','test','test',?,?)", contactId, f.profile, ambiguousPhone, ambiguousPhone, now(), now());
    const statements = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId, phones: [ambiguousPhone], origin: "local" });
    await env.DB.batch(statements.map(([sql, args]) => env.DB.prepare(sql).bind(...args)));
  }
  await pipeline("ambiguous", makeEvent(f.line, ambiguousPhone));
  expect(await one(env, "SELECT customer_link_state FROM conversations WHERE profile_id=? AND external_id=?", f.profile, ambiguousPhone)).toEqual({ customer_link_state: "ambiguous" });
  for (const mode of ["before", "after"] as const) {
    const event = makeEvent(f.line, mode === "before" ? "5511979990206" : "5511979990207");
    const failed = await http(await requestFor(event), mode);
    expect(failed.response.status).toBeGreaterThanOrEqual(500);
    const failedCalls = failed.coordinator.trace.filter(call => call.failed);
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0].method).toBe("batch");
    expect(failedCalls[0].sql.some(sql => /INSERT INTO inbox/i.test(sql))).toBe(true);
    expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND event_key LIKE ?", f.profile, `%:${event.message.platformMessageId}`)).toEqual({ n: mode === "before" ? 0 : 1 });
    report[`failure_${mode}`] = { worker: failed.worker, coordinator: failed.coordinator, aggregate: aggregate([failed.worker, failed.coordinator]) };
    await pipeline(`recovery_${mode}`, event);
    expect(await one(env, "SELECT count(*) n FROM messages WHERE profile_id=? AND external_id=? AND direction='customer'", f.profile, event.message.platformMessageId)).toEqual({ n: 1 });
  }
  // Mesma modalidade de d1-budget: linha herdada, menu automático e nenhum
  // bot. Área separada evita contaminar o cursor push e a outbox já medidos.
  // A entrada atravessa o Coordinator real; só o binding D1 é instrumentado.
  const inherited = await fixture(); profiles.add(inherited.profile);
  await configure(inherited, { menus: [{ id: "humano", label: "Atendente", type: "human" }] });
  const inheritedStub = env.COORDINATOR.get(env.COORDINATOR.idFromName(inherited.profile));
  const inheritedInbound = await runInDurableObject<DurableObject, Count>(inheritedStub, async (instance: any, state) => {
    const original = instance.env, m = meter(original); instance.env = m.env;
    try {
      const response = await instance.fetch(new Request("https://coordinator/inbound", { method: "POST", body: JSON.stringify({
        profile: inherited.profile, namespace: `channel:${inherited.line}`, connectionId: inherited.line,
        data: { external_id: "5511979990208", phone: "5511979990208", message_id: uid(), text: "Olá" },
      }) }));
      expect(response.status).toBe(202);
    } finally { instance.env = original; await state.storage.deleteAlarm(); }
    return m.count;
  });
  const inheritedEngine = await measured(e => processInbox(e, inherited.profile));
  report.inherit_first = { coordinator: inheritedInbound, engine: inheritedEngine,
    aggregate: aggregate([inheritedInbound, inheritedEngine]) };
  expect(inheritedInbound.statements, JSON.stringify(inheritedInbound)).toBeLessThanOrEqual(20);
  expect(inheritedEngine.statements, JSON.stringify(inheritedEngine)).toBeLessThanOrEqual(30);
  expect(await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='done'", inherited.profile)).toEqual({ n: 1 });
  expect(await one(env, "SELECT count(*) n FROM outbox WHERE profile_id=? AND status='pending'", inherited.profile)).toEqual({ n: 1 });
  expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  for (const phases of Object.values(report)) for (const count of Object.values(phases)) {
    expect(count.trace.some(call => call.sql.includes("UNOBSERVED"))).toBe(false);
    expect(count.statements).toBe(count.trace.reduce((sum, call) => sum + call.sql.length, 0));
  }
  // Um único JSON por execução; o script guarda stdout completo e compara
  // cenários/fases individualmente. Não usar números históricos como prova.
  // A saída de console dos testes do Worker não chega ao terminal neste
  // ambiente. O relatório segue nos metadados do teste, que o reporter JSON
  // do Vitest grava em arquivo; o script lê de lá.
  (task.meta as Record<string, unknown>).cnBaselineReport = JSON.stringify({ fixtureVersion: 3, report });
}, 120_000);
