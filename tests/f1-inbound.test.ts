import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { conversation, conversationByPhone, inbound, perform } from "../src/service";
import * as contacts from "../src/contacts";
import { customerRecordStatements, resolveCustomer } from "../src/customer/ports";
import { lookupProtocols, verifiedPhone } from "../src/protocol-lookup";
import { zernioInbound } from "../src/zernio";
import { decodeMessage } from "../connectors/qr/features.mjs";
import { now, uid, type Env } from "../src/types";
import { fixture } from "./service-center-fixture";
import { measure } from "./d1-counter";

afterEach(() => vi.restoreAllMocks());
const phone = "5511987654321";
const message = (extra: Record<string, unknown> = {}) => ({ external_id: phone, phone, text: "oi", message_id: uid(), ...extra });

/** Injeta falha somente no lote da inbox, preservando a atomicidade real do D1. */
function failingInbox(mode: "before" | "inside" | "after") {
  const sqls = new WeakMap<object, string>(), raw = new WeakMap<object, any>();
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: any): any => {
        const proxy = new Proxy(statement, { get(stmt, prop) {
          if (prop === "bind") return (...args: any[]) => wrap(stmt.bind(...args));
          const value = Reflect.get(stmt, prop);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
        sqls.set(proxy, sql); raw.set(proxy, statement);
        return proxy;
      };
      return wrap(db.prepare(sql));
    };
    if (key === "batch") return async (statements: any[]) => {
      const isInbox = statements.some((s) => sqls.get(s)?.includes("INSERT INTO inbox"));
      if (isInbox && mode === "before") throw new Error("queda antes do lote");
      const writes = statements.map((s) => raw.get(s) || s);
      if (isInbox && mode === "inside") writes.push(db.prepare("INSERT INTO customer_assert(id,ok) VALUES('failure',0)"));
      const result = await db.batch(writes);
      if (isInbox && mode === "after") throw new Error("queda depois do lote");
      return result;
    };
    const value = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  } });
  return { ...env, DB } as Env;
}

describe("entrada autenticada", () => {
  it.each([
    [`${phone}@s.whatsapp.net`, undefined, phone],
    [`${phone}:12@s.whatsapp.net`, undefined, phone],
    ["123456789012345@lid", `${phone}@s.whatsapp.net`, phone],
    [`${phone}@s.whatsapp.net`, "123456789012345@lid", phone],
    ["123456789012345@lid", undefined, null],
    ["123456789012345@lid", "999999999999@lid", null],
  ])("QR extrai prova somente de JID telefônico: %s", async (jid, alternate, expected) => {
    const f = await fixture();
    const { payload } = decodeMessage({ key: { remoteJid: jid, remoteJidAlt: alternate, id: uid() } }, { conversation: "oi" }, "55000000000@s.whatsapp.net");
    expect(payload.phone).toBe(expected);
    const r = await inbound(env, f.profile, payload, `channel:${f.qr}`, f.qr);
    const c = await conversation(env, r.conversation_id, f.profile);
    expect(c.verified_phone).toBe(expected);
    expect(c.phone).toBe(expected);
    expect(c.customer_link_state).toBe(expected ? "ready" : "pending");
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(expected ? 1 : 0);
  });

  it("servidor recusa telefone QR sem JID comprovado, divergente ou de outra área", async () => {
    const f = await fixture(), foreign = await fixture();
    for (const extra of [{}, { phone_jid: "12345678@lid" }, { phone_jid: "5511987654322@s.whatsapp.net" }]) {
      const r = await inbound(env, f.profile, message({ external_id: "lid@lid", ...extra }), `channel:${f.qr}`, f.qr);
      expect((await conversation(env, r.conversation_id, f.profile)).customer_link_state).toBe("pending");
    }
    await expect(inbound(env, f.profile, message(), `channel:${foreign.line}`, foreign.line)).rejects.toThrow(/Origem/);
    await expect(inbound(env, f.profile, message(), "app:forged", f.line)).rejects.toThrow(/Origem/);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("Zernio ignora sender.id numérico e aceita somente phoneNumber normalizado", async () => {
    const f = await fixture();
    const conn = { ...(await one(env, "SELECT * FROM connections WHERE id=?", f.line)), config: JSON.stringify({ account_id: "account" }) };
    for (const [sender, expected] of [
      [{ id: phone }, null],
      [{ id: phone, phoneNumber: "telefone " + phone }, null],
      [{ id: "opaque", phoneNumber: "+55 (11) 98765-4321" }, phone],
    ] as const) {
      const dispatch = vi.fn(async (data: any) => Response.json(await inbound(env, f.profile, data, `channel:${f.line}`, f.line)));
      await zernioInbound(env, conn, {
        event: "message.received", account: { accountId: "account", platform: "whatsapp" },
        message: { platform: "whatsapp", direction: "incoming", sender, platformMessageId: uid(), text: "oi", sentAt: new Date().toISOString() },
      }, dispatch);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0].phone).toBe(expected);
    }
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("Zernio não transforma o remetente de grupo ainda não sincronizado em contato", async () => {
    const f = await fixture();
    const conn = { ...(await one(env, "SELECT * FROM connections WHERE id=?", f.line)), config: JSON.stringify({ account_id: "account" }) };
    const dispatch = vi.fn(async (data: any) => Response.json(await inbound(env, f.profile, data, `channel:${f.line}`, f.line)));
    await zernioInbound(env, conn, {
      event: "message.received", account: { accountId: "account", platform: "whatsapp" },
      conversation: { platformConversationId: "123456789@g.us", participantId: phone },
      message: { platform: "whatsapp", direction: "incoming", sender: { id: phone, phoneNumber: phone }, platformMessageId: uid(), text: "oi", sentAt: new Date().toISOString() },
    }, dispatch);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ external_id: "123456789@g.us", chat_type: "group", phone: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("grupo fica excluded e aplicação pending, sem aceitar campos de prova forjados", async () => {
    const f = await fixture();
    const app = await inbound(env, f.profile, message({ provider: "qr", phone_jid: `${phone}@s.whatsapp.net`, verified_phone: phone, customer_link_state: "ready" }), "app:integration", null);
    const group = await inbound(env, f.profile, message({ external_id: "123456789@g.us", chat_type: "group", content: { participant: `${phone}@s.whatsapp.net` } }), `channel:${f.qr}`, f.qr);
    for (const r of [app, group]) {
      const c = await conversation(env, r.conversation_id, f.profile);
      expect(c).toMatchObject({ customer_link_state: r === app ? "pending" : "excluded", verified_phone: null });
      expect(verifiedPhone(c)).toBeNull();
    }
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it.each(["before", "inside", "after"] as const)("queda %s do lote e repetição não perdem nem duplicam identidade", async (mode) => {
    const f = await fixture(), data = message();
    await expect(inbound(failingInbox(mode), f.profile, data, `channel:${f.line}`, f.line)).rejects.toThrow();
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(mode === "after" ? 1 : 0);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(mode === "after" ? 1 : 0);
    expect((await one(env, "SELECT epoch FROM conversations WHERE profile_id=?", f.profile)).epoch)
      .toBe(mode === "after" ? 2 : 1);
    const r = await inbound(env, f.profile, data, `channel:${f.line}`, f.line);
    const c = await conversation(env, r.conversation_id, f.profile);
    expect(c.epoch).toBe(2);
    expect(JSON.parse((await one(env, "SELECT payload FROM inbox WHERE conversation_id=?", c.id)).payload).epoch).toBe(c.epoch);
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "ready", verifiedPhone: phone });
    const repeated = await measure(env, (e) => inbound(e, f.profile, data, `channel:${f.line}`, f.line));
    expect(repeated.result).toMatchObject({ duplicate: true, conversation_id: c.id });
    expect(repeated.count).toMatchObject({ statements: 1, calls: 1 });
    expect((await conversation(env, c.id, f.profile)).epoch).toBe(c.epoch);
    for (const table of ["inbox", "contacts", "customer_phones", "customer_records", "messages"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT * FROM conversation_contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it.each(["before", "inside", "after"] as const)("queda %s preserva a época anterior de uma conversa existente até confirmar a inbox", async (mode) => {
    const f = await fixture();
    const first = await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
    await exec(env, "UPDATE conversations SET epoch=37 WHERE id=?", first.conversation_id);
    const data = message();
    await expect(inbound(failingInbox(mode), f.profile, data, `channel:${f.line}`, f.line)).rejects.toThrow();
    expect((await conversation(env, first.conversation_id, f.profile)).epoch)
      .toBe(mode === "after" ? 38 : 37);
    for (const table of ["inbox", "messages"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile))
        .toHaveLength(mode === "after" ? 2 : 1);

    const retried = await inbound(env, f.profile, data, `channel:${f.line}`, f.line);
    expect(retried.conversation_id).toBe(first.conversation_id);
    const c = await conversation(env, retried.conversation_id, f.profile);
    expect(c.epoch).toBe(38);
    const inbox = await one(env, "SELECT payload FROM inbox WHERE event_key=?", `${f.profile}:channel:${f.line}:${phone}:${data.message_id}`);
    expect(JSON.parse(inbox.payload).epoch).toBe(c.epoch);
    const repeated = await measure(env, (e) => inbound(e, f.profile, data, `channel:${f.line}`, f.line));
    expect(repeated.result).toMatchObject({ duplicate: true, conversation_id: c.id });
    expect(repeated.count).toMatchObject({ statements: 1, calls: 1 });
    expect((await conversation(env, c.id, f.profile)).epoch).toBe(38);
    for (const table of ["inbox", "messages"])
      expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile)).toHaveLength(2);
    for (const table of ["contacts", "customer_phones", "customer_records"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT * FROM conversation_contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("retorno abre vínculo próprio de sessão e preserva o anterior", async () => {
    const f = await fixture();
    const r = await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
    const previous = await conversation(env, r.conversation_id, f.profile);
    await exec(env, "UPDATE conversations SET state='closed' WHERE id=?", previous.id);
    const r2 = await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
    const next = await conversation(env, r2.conversation_id, f.profile);
    expect(next.session).not.toBe(previous.session);
    expect(await all(env, "SELECT record_id FROM customer_records WHERE conversation_id=?", next.id))
      .toEqual(expect.arrayContaining([{ record_id: `${next.id}:${previous.session}` }, { record_id: `${next.id}:${next.session}` }]));
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("resposta com o telefone exato reaproveita conversa aberta para envio", async () => {
    const f = await fixture(), opened = await conversationByPhone(env, f.profile, phone, { open: true });
    expect(opened?.customer_link_state).toBe("pending");
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(0);
    const r = await inbound(env, f.profile, message({ external_id: "bsuid" }), `channel:${f.line}`, f.line);
    expect(r.conversation_id).toBe(opened!.id);
    expect(await resolveCustomer(env, await conversation(env, r.conversation_id, f.profile))).toMatchObject({ state: "ready" });
  });

  it("encaminha o identificador estável de perform ao comando de contatos", async () => {
    const f = await fixture(), stable = uid();
    const command = vi.spyOn(contacts, "contactCommand").mockResolvedValue({ ok: true } as any);
    await perform(env, f.admin, f.profile, "contact.create", { name: "Ana" }, stable);
    expect(command.mock.calls[0]).toEqual([expect.anything(), f.admin, f.profile, "contact.create", { name: "Ana" }, stable]);
  });

  it("preserva a precedência da afinidade do roteador sobre o identificador exato", async () => {
    const f = await fixture();
    const routed = await inbound(env, f.profile, message({ external_id: "routed" }), `channel:${f.line}`, f.line);
    const exact = await inbound(env, f.profile, message({ external_id: "exact" }), `channel:${f.line}`, f.line);
    await exec(env, `INSERT INTO router_affinities(profile_id,actor,external_id,source_type,source_id,conversation_id,connection_id,recipient,created)
      VALUES(?,?,'logical','line',?,?,?,?,?)`, f.profile, "test", f.line, routed.conversation_id, f.line, "exact", now());
    const result = await inbound(env, f.profile, message({ external_id: "exact" }), `channel:${f.line}`, f.line);
    expect(result.conversation_id).toBe(routed.conversation_id);
    expect(result.conversation_id).not.toBe(exact.conversation_id);
  });

  it("retoma protocolos existentes e registra a mesma época na conversa e na inbox", async () => {
    const f = await fixture();
    const first = await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
    const c = await conversation(env, first.conversation_id, f.profile), id = uid();
    await exec(env, `INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,created,updated)
      VALUES(?,?,?,?,'Atendimento','waiting_customer',?,?)`, id, uid(), f.profile, c.id, now(), now());
    const data = message();
    await inbound(env, f.profile, data, `channel:${f.line}`, f.line);
    expect((await one(env, "SELECT status FROM tickets WHERE id=?", id)).status).toBe("in_progress");
    const current = await conversation(env, c.id, f.profile);
    const inbox = await one(env, "SELECT payload FROM inbox WHERE event_key=?", `${f.profile}:channel:${f.line}:${phone}:${data.message_id}`);
    expect(JSON.parse(inbox.payload)).toMatchObject({ epoch: current.epoch, resumed_tickets: [id] });
    expect(current.epoch).toBe(c.epoch + 1);
  });
});

describe("protocolos por identidade resolvida", () => {
  it("preserva protocolos pelo telefone autenticado entre linhas e bloqueia identidades recusadas", async () => {
    const f = await fixture();
    const a = await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
    const b = await inbound(env, f.profile, message(), `channel:${f.second}`, f.second);
    const ca = await conversation(env, a.conversation_id, f.profile), cb = await conversation(env, b.conversation_id, f.profile);
    const ref = await resolveCustomer(env, ca), ticket = uid();
    await exec(env, "INSERT INTO tickets(id,number,profile_id,conversation_id,title,created,updated) VALUES(?,?,?,?,?,?,?)", ticket, uid(), f.profile, ca.id, "Atendimento", now(), now());
    expect(await lookupProtocols(env, cb)).toHaveLength(1); // compatibilidade da 0.22.0
    // Simula o produtor de histórico pela fachada da base.
    await batch(env, customerRecordStatements({ profileId: f.profile, moduleId: "tickets", kind: "ticket",
      recordId: ticket, contactId: ref.contactId!, conversationId: ca.id, linkedBy: "test", occurredAt: now() }));
    expect(await lookupProtocols(env, cb)).toHaveLength(1);
    await exec(env, "UPDATE conversations SET customer_link_state='pending' WHERE id=?", cb.id);
    expect(await lookupProtocols(env, await conversation(env, cb.id, f.profile))).toHaveLength(1);
    for (const state of ["ambiguous", "blocked", "excluded"]) {
      await exec(env, "UPDATE conversations SET customer_link_state=? WHERE id=?", state, cb.id);
      const current = await conversation(env, cb.id, f.profile);
      expect(verifiedPhone(current)).toBeNull();
      expect(await lookupProtocols(env, current)).toEqual([]);
    }
    expect(await lookupProtocols(env, ca)).toHaveLength(1);
  });
});

it("customer-tick é dedicado, respeita orçamento e não agenda alarme", async () => {
  const f = await fixture();
  await inbound(env, f.profile, message(), `channel:${f.line}`, f.line);
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  await runInDurableObject(coordinator, async (_instance, state) => state.storage.deleteAlarm());
  const response = await coordinator.fetch("https://coordinator/customer-tick", { method: "POST", body: JSON.stringify({ profile: f.profile, remainingStatements: 999, remainingItems: 999 }) });
  expect(response.status).toBe(200);
  const result = await response.json<any>();
  expect(result.statements).toBeLessThanOrEqual(40);
  expect(result.items).toBeLessThanOrEqual(20);
  expect(response.headers.get("Server-Timing")).toContain("d1;");
  await runInDurableObject(coordinator, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
});
