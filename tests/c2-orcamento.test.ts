import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, withReadCache } from "../src/db";
import { conversation, inbound } from "../src/service";
import { processInbox, dispatchChannelDelivery } from "../src/engine";
import { completeChannelDelivery } from "../src/delivery";
import { inboundConnection } from "../src/customer/identity";
import { identityPort } from "../src/customer/ports";
import { channelAutomationBlock } from "../src/channel-extension-kernel";
import { installC2Worker } from "../src/c2-entry/install";
import type { ChannelOutboxRow } from "../src/channel-c2-contracts";
import { uid, type Conversation, type Env } from "../src/types";
import { installC2Web } from "../web/c2/register";
import { ChannelConversationHeader, ChannelConversationInfo, ChannelComposerFields,
  ChannelMessageMetadata, ChannelContactActions, ChannelReviewsPage, channelCatalogVisible,
  prepareChannelUiAction } from "../web/channel-extensions";
import { configure, fixture, quietCoordinator } from "./service-center-fixture";

// SQL integral, inclusive dentro de batch: o contador legado trunca e perde
// as instruções internas. Linhas/fases comparadas estão no probe de baseline.
function meter(original: Env) {
  const count = { calls: 0, statements: 0, sql: [] as string[] };
  const raw = new WeakMap<object, D1PreparedStatement>(), texts = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (["all", "first", "run", "raw"].includes(String(key))) return (...args: unknown[]) => {
        count.calls++; count.statements++; count.sql.push(sql);
        return Reflect.apply(Reflect.get(target, key), target, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(proxy, statement); texts.set(proxy, sql); return proxy;
  };
  const DB = new Proxy(original.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === "batch") return (statements: D1PreparedStatement[]) => {
      const sql = statements.map(statement => texts.get(statement));
      expect(sql.every(Boolean), "Toda instrução do batch precisa ser observada").toBe(true);
      count.calls++; count.statements += statements.length; count.sql.push(...sql as string[]);
      return target.batch(statements.map(statement => raw.get(statement) ?? statement));
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...original, DB } as Env, count };
}
const newTables = /\b(?:channel_delivery_state|channel_public_grants|channel_comments|telegram_callbacks|tiktok_send_slots|reviews|channel_sync_state|email_channel_addresses|email_channel_inbox|email_channel_blocks|email_channel_probes)\b/i;
const profiles = new Set<string>();
let unexpected: string[];
beforeEach(() => {
  unexpected = [];
  vi.spyOn(Date, "now").mockReturnValue(1_795_100_000_000);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    unexpected.push("chamada externa inesperada"); throw new Error("O cenário sem canal novo não precisa de rede.");
  });
  installC2Worker(); installC2Web();
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); vi.restoreAllMocks(); expect(unexpected).toEqual([]);
}, 60_000);

describe("c2-orçamento: canais novos não usados", () => {
  it("preserva tetos WhatsApp, replay 1/1 e identidade pronta 0/0 sem tabelas da segunda leva", async () => {
    const f = await fixture(); profiles.add(f.profile);
    await configure(f, { menus: [{ id: "humano", label: "Atendente", type: "human" }] });
    await quietCoordinator(f.profile);
    const payload = { external_id: "5511979990401", phone: "5511979990401", text: "Olá", message_id: uid() };
    const first = meter(env), result = await inbound(first.env, f.profile, payload, `channel:${f.line}`, f.line);
    expect(first.count.statements, JSON.stringify(first.count)).toBeLessThanOrEqual(20);
    const engine = meter(env); await processInbox(engine.env, f.profile);
    expect(engine.count.statements, JSON.stringify(engine.count)).toBeLessThanOrEqual(30);
    const replay = meter(env); await inbound(replay.env, f.profile, payload, `channel:${f.line}`, f.line);
    expect(replay.count).toMatchObject({ calls: 1, statements: 1 });
    const c = await conversation(env, result.conversation_id, f.profile);
    const cached = withReadCache(env); await inboundConnection(cached, f.line);
    const ready = meter(cached);
    expect(await identityPort.prepareInbound(ready.env, c, { provider: "zernio", phone: payload.phone }))
      .toEqual({ state: "ready", verifiedPhone: payload.phone, statements: [] });
    expect(ready.count).toEqual({ calls: 0, statements: 0, sql: [] });
    const next = meter(env); await inbound(next.env, f.profile, { ...payload, message_id: uid() }, `channel:${f.line}`, f.line);
    for (const [phase, measured] of Object.entries({ first, engine, replay, ready, next }))
      expect(measured.count.sql.filter(sql => newTables.test(sql)), phase).toEqual([]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", c.id)).toHaveLength(2);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND status='pending'", c.id)).toHaveLength(1);
  }, 60_000);

  it("despacho tardio e slots antigos têm zero D1 e DOM exatamente igual com composição instalada", async () => {
    const measured = meter(env);
    const api = vi.fn(async () => { throw new Error("Slot legado não consulta API."); });
    const cases = [{ channel: "whatsapp", chat_type: "direct" }, { channel: "instagram", chat_type: "direct" },
      { channel: "facebook", chat_type: "direct" }, { kind: "internal" }, { external_namespace: "app:teste" }];
    for (const row of cases) {
      if (row.channel) expect(await channelAutomationBlock(measured.env, row as unknown as Conversation, "acceptance")).toBeNull();
      const common = { conversation: row, detail: {}, api, root: "v1/profiles/teste", now: Date.now(), refresh: async () => undefined };
      const draft = { conversation: row, text: "Olá", attachments: [], attachmentDetails: [], content: {}, fields: {} };
      const slots = [React.createElement(ChannelConversationHeader, common), React.createElement(ChannelConversationInfo, common),
        React.createElement(ChannelComposerFields, { ...common, draft, disabled: false, change() {} }),
        React.createElement(ChannelMessageMetadata, { ...common, message: {}, previousMessage: null, content: {} }),
        React.createElement(ChannelContactActions, { ...common, contactId: "pessoa", contact: {}, channels: [] }),
        React.createElement(ChannelReviewsPage, { api, root: common.root, now: common.now, mode: "reviews", status: {} })];
      const before = renderToStaticMarkup(React.createElement("main", null, "Atendimento"));
      expect(renderToStaticMarkup(React.createElement("main", null, "Atendimento", ...slots))).toBe(before);
      expect(prepareChannelUiAction(draft)).toBeNull();
    }
    expect(await dispatchChannelDelivery(measured.env, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    expect(await completeChannelDelivery(measured.env, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    expect(measured.count).toEqual({ calls: 0, statements: 0, sql: [] });
    expect(api).not.toHaveBeenCalled();
    expect(channelCatalogVisible({ connected_channels: ["whatsapp", "instagram", "facebook"] }, "")).toBe(false);
  });

  it("calibra uma chamada por batch, conserva SQL e não encobre tabela nova dentro dele", async () => {
    const measured = meter(env);
    const result = await measured.env.DB.batch([measured.env.DB.prepare("SELECT 1 value"),
      measured.env.DB.prepare("SELECT count(*) value FROM email_channel_inbox WHERE 0")]);
    expect(measured.count).toEqual({ calls: 1, statements: 2,
      sql: ["SELECT 1 value", "SELECT count(*) value FROM email_channel_inbox WHERE 0"] });
    expect(measured.count.sql.filter(sql => newTables.test(sql))).toHaveLength(1);
    expect(result.map(row => row.results[0])).toEqual([{ value: 1 }, { value: 0 }]);
    expect(newTables.test("SELECT id FROM conversations")).toBe(false);
  });
});
