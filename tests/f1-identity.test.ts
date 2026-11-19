import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one, withReadCache } from "../src/db";
import { conversation, inbound, conversationByPhone } from "../src/service";
import { identityPort, resolveCustomer } from "../src/customer/ports";
import { CONTACT_TASK, inboundConnection } from "../src/customer/identity";
import { now, uid, type Env } from "../src/types";
import { fixture, type Fixture } from "./service-center-fixture";
import { measure } from "./d1-counter";

const phone = "5511987654321";
afterEach(() => vi.restoreAllMocks());
async function send(f: Fixture, line = f.line, value = phone) {
  const r = await inbound(env, f.profile, { external_id: value, phone: value, text: "oi", message_id: uid() }, `channel:${line}`, line);
  return conversation(env, r.conversation_id, f.profile);
}
async function contact(f: Fixture, value: string, namespace = "team", id = uid()) {
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,?,'',?,?,'manual','test','test',?,?)`, id, f.profile, namespace, value, value, now(), now());
  return id;
}
async function indexed(f: Fixture, id: string, phones: string[]) {
  const statements = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: id, phones, origin: "local" });
  if (statements.length) await batch(env, statements);
}

describe("identidade de atendimento", () => {
  it("cria contato telefônico com os módulos desligados e reutiliza entre dois canais sem ERP", async () => {
    const f = await fixture();
    const noErp = vi.fn(() => { throw new Error("não chamar ERP"); });
    const isolated = { ...env, COORDINATOR: { get: noErp, idFromName: noErp } } as unknown as Env;
    const result = await inbound(isolated, f.profile, { external_id: phone, phone, text: "oi", message_id: uid() }, `channel:${f.line}`, f.line);
    const c1 = await conversation(env, result.conversation_id, f.profile);
    const c2 = await send(f, f.second);
    const ref1 = await resolveCustomer(env, c1), ref2 = await resolveCustomer(env, c2);
    expect(ref1).toMatchObject({ state: "ready", namespace: "team", verifiedPhone: phone, erp: null });
    expect(ref2.contactId).toBe(ref1.contactId);
    expect(await all(env, "SELECT name,source,erp_contact_id FROM contacts WHERE profile_id=?", f.profile))
      .toEqual([{ name: "", source: "automatic", erp_contact_id: null }]);
    expect(await all(env, "SELECT record_id,contact_id FROM customer_records WHERE profile_id=? ORDER BY record_id", f.profile))
      .toEqual([c1, c2].map((c) => ({ record_id: `${c.id}:${c.session}`, contact_id: ref1.contactId })).sort((a, b) => a.record_id.localeCompare(b.record_id)));
    expect(noErp).not.toHaveBeenCalled();
  });

  it("isola áreas, namespaces e variantes do nono dígito", async () => {
    const f = await fixture(), other = await fixture();
    const appContact = await contact(f, phone, "app:integration");
    const a = await resolveCustomer(env, await send(f));
    const b = await resolveCustomer(env, await send(other));
    const variant = await resolveCustomer(env, await send(f, f.line, "551187654321"));
    expect(new Set([appContact, a.contactId, b.contactId, variant.contactId]).size).toBe(4);
    expect(await conversationByPhone(env, f.profile, "55117654321")).toBeNull();
  });

  it("consulta legado formatado antes de criar e guarda duplicados como ambiguous", async () => {
    const f = await fixture();
    const first = await contact(f, "+55 (11) 98765-4321");
    const c1 = await send(f);
    expect((await resolveCustomer(env, c1)).contactId).toBe(first);
    const second = await contact(f, "55.11.98765.4321");
    await indexed(f, second, [phone]);
    const c2 = await send(f, f.second);
    expect(await resolveCustomer(env, c2)).toMatchObject({ state: "ambiguous", contactId: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await one(env, "SELECT state,contact_id FROM customer_phones WHERE profile_id=? AND phone=?", f.profile, phone))
      .toEqual({ state: "ambiguous", contact_id: null });
    expect((await conversation(env, c1.id, f.profile)).customer_link_state).toBe("pending");
    expect(await all(env, "SELECT contact_id FROM customer_records WHERE conversation_id=?", c1.id)).toEqual([{ contact_id: first }]);
  });

  it("invalida antigo e novo telefone no lote e preserva blocked e históricos", async () => {
    const f = await fixture();
    const c1 = await send(f), c2 = await send(f, f.second);
    const ref = await resolveCustomer(env, c1);
    await batch(env, [
      ["DELETE FROM conversation_contacts WHERE conversation_id=?", [c2.id]],
      ["UPDATE conversations SET customer_link_state='blocked' WHERE id=?", [c2.id]],
    ]);
    const newer = "5511987654322";
    const statements = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: ref.contactId!, phones: [newer], origin: "local" });
    await batch(env, [["UPDATE contacts SET phone=?,version=version+1 WHERE id=?", [newer, ref.contactId]], ...statements]);
    expect((await conversation(env, c1.id, f.profile)).customer_link_state).toBe("pending");
    expect((await send(f, f.second)).customer_link_state).toBe("blocked");
    expect(await one(env, "SELECT state FROM customer_phones WHERE profile_id=? AND phone=?", f.profile, phone)).toEqual({ state: "pending" });
    expect(await all(env, "SELECT contact_id FROM customer_records WHERE profile_id=?", f.profile)).toEqual([{ contact_id: ref.contactId }, { contact_id: ref.contactId }]);
  });

  it("descoberta de candidato legado invalida os outros canais no lote da entrada", async () => {
    const f = await fixture(), c = await send(f), ref = await resolveCustomer(env, c);
    await contact(f, "+55 (11) 98765-4321");
    const other = await send(f, f.second);
    expect(other.customer_link_state).toBe("ambiguous");
    expect((await conversation(env, c.id, f.profile)).customer_link_state).toBe("pending");
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await all(env, "SELECT contact_id FROM customer_records WHERE conversation_id=?", c.id))
      .toEqual([{ contact_id: ref.contactId }]);
  });

  it("restrição depois do plano cancela a entrada mesmo com preenchimento completo", async () => {
    const f = await fixture(), c = await send(f), ref = await resolveCustomer(env, c);
    await identityPort.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await one(env, "SELECT complete FROM customer_progress WHERE profile_id=? AND task=?", f.profile, CONTACT_TASK)).complete).toBe(1);
    const original = identityPort.prepareInbound.bind(identityPort);
    const plan = vi.spyOn(identityPort, "prepareInbound").mockImplementation(async (...args) => {
      const result = await original(...args);
      await exec(env, "UPDATE contacts SET identity_state='restricted',version=version+1 WHERE id=?", ref.contactId);
      return result;
    });
    await expect(send(f, f.second)).rejects.toThrow();
    plan.mockRestore();
    expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT contact_id FROM conversation_contacts WHERE profile_id=?", f.profile)).toEqual([{ contact_id: ref.contactId }]);
    expect((await send(f, f.second)).customer_link_state).toBe("excluded");
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("não reaponta número removido ao ID automático da pessoa anterior", async () => {
    const f = await fixture(), c = await send(f), previous = await resolveCustomer(env, c);
    const changed = "5511987654322";
    const index = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: previous.contactId!, phones: [changed], origin: "local" });
    await batch(env, [["UPDATE contacts SET phone=?,version=version+1 WHERE id=?", [changed, previous.contactId]], ...index]);
    const current = await resolveCustomer(env, await send(f, f.second));
    expect(current.state).toBe("ready");
    expect(current.contactId).not.toBe(previous.contactId);
    expect(await one(env, "SELECT contact_id FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`)).toEqual({ contact_id: previous.contactId });
  });

  it("restrição impede resolução e criação de outra ficha", async () => {
    const f = await fixture();
    const c = await send(f), ref = await resolveCustomer(env, c);
    await exec(env, "UPDATE contacts SET identity_state='restricted',version=version+1 WHERE id=?", ref.contactId);
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "excluded", contactId: null });
    const other = await send(f, f.second);
    expect(other.customer_link_state).toBe("excluded");
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("mesmo telefone pronto não acrescenta instrução de identidade", async () => {
    const f = await fixture(), c = await send(f);
    const invocation = withReadCache(env);
    await inboundConnection(invocation, f.line); // leitura já necessária para a linha
    const { result, count } = await measure(invocation, (e) => identityPort.prepareInbound(e, c, { provider: "zernio", phone }));
    expect(result).toEqual({ state: "ready", verifiedPhone: phone, statements: [] });
    expect(count).toMatchObject({ statements: 0, calls: 0 });
  });

  it("telefone observado diferente revalida sem transferir a sessão antiga", async () => {
    const f = await fixture(), c = await send(f), ref = await resolveCustomer(env, c);
    await inbound(env, f.profile, { external_id: phone, phone: "5511987654322", text: "retorno", message_id: uid() }, `channel:${f.line}`, f.line);
    const changed = await resolveCustomer(env, await conversation(env, c.id, f.profile));
    expect(changed.state).toBe("ready");
    expect(changed.contactId).not.toBe(ref.contactId);
    expect(await all(env, "SELECT contact_id FROM customer_records WHERE conversation_id=?", c.id)).toEqual([{ contact_id: ref.contactId }]);
  });
});

describe("preenchimento retomável", () => {
  it("limita a página, retoma por ID e não promove", async () => {
    const f = await fixture();
    for (let i = 0; i < 23; i++) await contact(f, `+55 (11) 98765-${String(i).padStart(4, "0")}`, "team", `legacy-${String(i).padStart(2, "0")}`);
    const first = await measure(env, (e) => identityPort.maintain(e, f.profile, { remainingItems: 20, remainingStatements: 40 }));
    expect(first.result.items).toBe(20);
    expect(first.result.statements).toBe(first.count.statements);
    expect(first.count.statements).toBeLessThanOrEqual(40);
    const checkpoint = await one(env, "SELECT complete,cursor_json FROM customer_progress WHERE profile_id=? AND task=?", f.profile, CONTACT_TASK);
    expect(checkpoint.complete).toBe(0);
    expect(JSON.parse(checkpoint.cursor_json)).toEqual({ id: "legacy-19" });
    const next = await identityPort.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(next.items).toBe(3);
    expect(await all(env, "SELECT phone FROM customer_phones WHERE profile_id=?", f.profile)).toHaveLength(23);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=? AND erp_contact_id IS NOT NULL", f.profile)).toEqual([]);
    expect(await identityPort.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 1 }))
      .toEqual({ statements: 0, items: 0, pending: true });
  });

  it("edição depois da leitura cancela o lote e o checkpoint; retomada usa a versão nova", async () => {
    const f = await fixture(), id = await contact(f, "+55 (11) 98765-4321");
    let edited = false;
    const raw = new WeakMap<object, any>();
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return (statements: any[]) => target.batch(statements.map((s) => raw.get(s) || s));
      if (property === "prepare") return (sql: string) => {
        const wrap = (statement: any): any => {
          const proxy = new Proxy(statement, { get(stmt, key) {
          if (key === "bind") return (...args: any[]) => wrap(stmt.bind(...args));
          if (key === "all" && sql.includes("SELECT id,version,phone,mirror_json")) return async () => {
            const result = await stmt.all();
            if (!edited) {
              edited = true;
              await exec(env, "UPDATE contacts SET phone=?,version=version+1 WHERE id=?", "+55 (11) 98765-4322", id);
              await indexed(f, id, ["5511987654322"]);
            }
            return result;
          };
          const value = Reflect.get(stmt, key);
          return typeof value === "function" ? value.bind(stmt) : value;
          } });
          raw.set(proxy, statement);
          return proxy;
        };
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(identityPort.maintain({ ...env, DB }, f.profile, { remainingItems: 20, remainingStatements: 40 })).rejects.toThrow();
    expect(await one(env, "SELECT * FROM customer_progress WHERE profile_id=?", f.profile)).toBeNull();
    await identityPort.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(await all(env, "SELECT phone FROM customer_phone_candidates WHERE profile_id=?", f.profile)).toEqual([{ phone: "5511987654322" }]);
    expect(await one(env, "SELECT phone,version FROM contacts WHERE id=?", id)).toEqual({ phone: "+55 (11) 98765-4322", version: 2 });
  });

  it("não inventa prova de telefone em conversas legadas e mantém escolha humana do índice", async () => {
    const f = await fixture(), c = await send(f), ref = await resolveCustomer(env, c);
    const second = await contact(f, phone);
    await indexed(f, second, [phone]);
    await exec(env, "UPDATE customer_phones SET state='ready',contact_id=?,version=version+1 WHERE profile_id=? AND phone=?", ref.contactId, f.profile, phone);
    await exec(env, "UPDATE conversations SET verified_phone=NULL,customer_link_state='pending' WHERE id=?", c.id);
    for (let i = 0; i < 4; i++) await identityPort.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(await one(env, "SELECT state,contact_id FROM customer_phones WHERE profile_id=? AND phone=?", f.profile, phone)).toEqual({ state: "ready", contact_id: ref.contactId });
    expect((await conversation(env, c.id, f.profile)).customer_link_state).toBe("pending");
  });
});
