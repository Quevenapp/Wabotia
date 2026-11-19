import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, withReadCache } from "../src/db";
import { conversation, inbound } from "../src/service";
import { processInbox } from "../src/engine";
import { inboundConnection } from "../src/customer/identity";
import { identityPort } from "../src/customer/ports";
import { installChannelRuntime } from "../src/channel-runtime";
import { uid } from "../src/types";
import { configure, fixture, quietCoordinator } from "./service-center-fixture";
import { measure } from "./d1-counter";

const profiles = new Set<string>();
let unexpected: string[] = [];
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); vi.restoreAllMocks();
  expect(unexpected).toEqual([]); unexpected = [];
});

it("só WhatsApp: linha herdada com menu, tetos históricos, replay 1/1 e identidade pronta sem I/O adicional", async () => {
  installChannelRuntime();
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    unexpected.push(String(input)); throw new Error("Este cenário WhatsApp não precisa de rede.");
  });
  const f = await fixture(); profiles.add(f.profile);
  // O teto de d1-budget pertence à linha herdada com menu automático.
  // A linha humana inclui a consulta do portão e o evento de entrada na fila;
  // seu custo integral é comparado contra a referência no probe compartilhado.
  await configure(f, { menus: [{ id: "humano", label: "Atendente", type: "human" }] });
  const phone = "5511979990301", payload = { external_id: phone, phone, text: "Olá", message_id: uid() };
  const first = await measure(env, e => inbound(e, f.profile, payload, `channel:${f.line}`, f.line));
  expect(first.count.statements, JSON.stringify(first.count)).toBeLessThanOrEqual(20);
  const engine = await measure(env, e => processInbox(e, f.profile));
  expect(engine.count.statements, JSON.stringify(engine.count)).toBeLessThanOrEqual(30);
  expect(await all(env, "SELECT id FROM inbox WHERE profile_id=? AND status='done'", f.profile)).toHaveLength(1);
  expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND status='pending'", first.result.conversation_id)).toHaveLength(1);
  const replay = await measure(env, e => inbound(e, f.profile, payload, `channel:${f.line}`, f.line));
  expect(replay.count).toMatchObject({ calls: 1, statements: 1 });
  const c = await conversation(env, first.result.conversation_id, f.profile);
  const invocation = withReadCache(env);
  await inboundConnection(invocation, f.line);
  const ready = await measure(invocation, e => identityPort.prepareInbound(e, c, { provider: "zernio", phone }));
  expect(ready.result).toEqual({ state: "ready", verifiedPhone: phone, statements: [] });
  expect(ready.count).toMatchObject({ calls: 0, statements: 0 });
  const next = await measure(env, e => inbound(e, f.profile, { ...payload, message_id: uid() }, `channel:${f.line}`, f.line));
  for (const [phase, measured] of Object.entries({ first, engine, replay, next, ready })) {
    expect(measured.count.sql.some(sql => /customer_channel_ids|zernio_channel_accounts|customer_merges|COUNT\(.*connections/i.test(sql)), phase).toBe(false);
  }
  expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual([]);
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", c.id)).toHaveLength(2);
  // A comparação absoluta com 20e15da9 é feita pelo cn-baseline.mjs, com o
  // probe completo e SQL sem truncar. Estes tetos não substituem o baseline.
}, 30_000);

it("só WhatsApp: um batch conta uma chamada e cada instrução separadamente", async () => {
  // Calibração do contador legado usado nos tetos; o probe conserva também
  // as instruções internas, escritas e metadata do D1 quando disponíveis.
  const result = await measure(env, e => e.DB.batch([
    e.DB.prepare("SELECT 1 value"), e.DB.prepare("SELECT 2 value"), e.DB.prepare("SELECT 3 value"),
  ]));
  expect(result.count).toMatchObject({ calls: 1, statements: 3, sql: ["batch(3)"] });
  expect(result.result.map(row => row.results[0])).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
});
