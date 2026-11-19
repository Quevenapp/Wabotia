import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one, withReadCache } from "../src/db";
import { conversation, conversationByPhone, inbound, message } from "../src/service";
import { identityPort, resolveCustomer } from "../src/customer/ports";
import { CONTACT_TASK, inboundConnection, sessionStatement } from "../src/customer/identity";
import { customerPhoneVariants } from "../src/customer/phone";
import { now, uid, type Env } from "../src/types";
import { fixture, type Fixture as ServiceFixture } from "./service-center-fixture";
import { measure } from "./d1-counter";

const phone = "5511987654321", attacker = "5511987654322";
type Fixture = Omit<ServiceFixture, "line"> & { line: string };
afterEach(() => vi.restoreAllMocks());
async function send(f: Fixture, value = phone, line = f.line, extra: Record<string, unknown> = {}, target = env) {
  const result = await inbound(target, f.profile, { external_id: value, phone: value, text: "Olá", message_id: uid(), ...extra }, `channel:${line}`, line);
  return conversation(env, result.conversation_id, f.profile);
}
async function contact(f: Fixture, value: string, namespace = "team", source = "manual", mirror: unknown = null) {
  const id = uid(), at = now();
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,source,search_text,created_by,updated_by,created,updated,mirror_json)
    VALUES(?,?,?,'Ana',?,?,'','test','test',?,?,?)`, id, f.profile, namespace, value, source, at, at, mirror ? JSON.stringify(mirror) : null);
  return id;
}
async function index(f: Fixture, id: string, phones: string[], origin: "local" | "mirror" = "local") {
  const plan = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: id, phones, origin });
  if (plan.length) await batch(env, plan);
}
async function maintain(f: Fixture) {
  for (let i = 0; i < 30; i++) {
    const measured = await measure(env, e => identityPort.maintain(e, f.profile, { remainingItems: 20, remainingStatements: 40 }));
    expect(measured.result.statements).toBe(measured.count.statements);
    expect(measured.result.items).toBeLessThanOrEqual(20);
    expect(measured.result.statements).toBeLessThanOrEqual(40);
    if (!measured.result.pending) return;
  }
  throw new Error("Manutenção não terminou");
}
function failInbox(mode: "before" | "inside" | "after") {
  const sqls = new WeakMap<object, string>(), raw = new WeakMap<object, any>();
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: any): any => {
        const proxy = new Proxy(statement, { get(stmt, prop) {
          if (prop === "bind") return (...args: any[]) => wrap(stmt.bind(...args));
          const value = Reflect.get(stmt, prop);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
        sqls.set(proxy, sql); raw.set(proxy, statement); return proxy;
      };
      return wrap(db.prepare(sql));
    };
    if (key === "batch") return async (statements: any[]) => {
      const inbox = statements.some(s => sqls.get(s)?.includes("INSERT INTO inbox"));
      if (inbox && mode === "before") throw new Error("antes do lote");
      const writes = statements.map(s => raw.get(s) || s);
      if (inbox && mode === "inside") writes.push(db.prepare("INSERT INTO customer_assert(id,ok) VALUES('regression-failure',0)"));
      const result = await db.batch(writes);
      if (inbox && mode === "after") throw new Error("depois do lote");
      return result;
    };
    const value = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  } });
  return { ...env, DB } as Env;
}

describe("S1 — candidatos, provas e revogações", () => {
  it("editar A para o telefone do atacante não libera A nem reaponta seus registros", async () => {
    const f = await fixture(), c = await send(f), a = await resolveCustomer(env, c);
    const original = await all(env, "SELECT * FROM customer_records WHERE profile_id=?", f.profile);
    const plan = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: a.contactId!, phones: [attacker], origin: "local" });
    await batch(env, [["UPDATE contacts SET phone=?,version=version+1 WHERE id=?", [attacker, a.contactId]], ...plan]);
    const intruder = await send(f, attacker, f.second);
    expect(await resolveCustomer(env, intruder)).toMatchObject({ state: "pending", contactId: null });
    expect(await one(env, "SELECT state,contact_id FROM customer_phones WHERE profile_id=? AND phone=?", f.profile, attacker))
      .toEqual({ state: "pending", contact_id: null });
    expect(await one(env, "SELECT revoked FROM customer_phone_proofs WHERE profile_id=? AND phone=? AND contact_id=?", f.profile, phone, a.contactId)).toEqual({ revoked: 1 });
    expect(await all(env, "SELECT * FROM customer_records WHERE profile_id=?", f.profile)).toEqual(original);
  });

  it.each(["local", "mirror"] as const)("candidato importado/%s não vira prova na primeira mensagem", async origin => {
    const f = await fixture(), id = await contact(f, phone, "team", "import");
    await index(f, id, [phone], origin);
    const c = await send(f);
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "pending", contactId: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([{ id }]);
    expect(await all(env, "SELECT * FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("revogação explícita sobrevive a reindexação, variante, manutenção e outro canal", async () => {
    const f = await fixture(), c = await send(f), a = await resolveCustomer(env, c);
    await exec(env, "UPDATE conversations SET customer_link_state='blocked' WHERE id=?", c.id);
    await index(f, a.contactId!, [phone]);
    await maintain(f);
    const other = await send(f, "551187654321", f.second);
    expect((await resolveCustomer(env, other)).contactId).toBeNull();
    expect((await conversation(env, c.id, f.profile)).customer_link_state).toBe("blocked");
    expect(await one(env, "SELECT revoked FROM customer_phone_proofs WHERE contact_id=? AND phone=?", a.contactId, phone)).toEqual({ revoked: 1 });
  });

  it("repara índice inseguro persistido em lotes, sem alterar o proprietário histórico", async () => {
    const f = await fixture(), c = await send(f), a = await resolveCustomer(env, c);
    const bad = await contact(f, attacker, "team", "import");
    await index(f, bad, [attacker]);
    await exec(env, "UPDATE customer_phones SET state='ready',contact_id=? WHERE profile_id=? AND phone=?", bad, f.profile, attacker);
    await maintain(f);
    expect(await one(env, "SELECT state,contact_id FROM customer_phones WHERE profile_id=? AND phone=?", f.profile, attacker)).toEqual({ state: "pending", contact_id: null });
    expect(await one(env, "SELECT contact_id FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`)).toEqual({ contact_id: a.contactId });
  });
});

describe("E2/E3/S7/M7 — compatibilidade com procedência", () => {
  it.each(["(11) 98765-4321", "11987654321", "1187654321"])("recupera legado %s e persiste o alias observado", async legacy => {
    const f = await fixture(), id = await contact(f, legacy);
    const c = await send(f);
    expect((await resolveCustomer(env, c)).contactId).toBe(id);
    expect(await one(env, "SELECT contact_id,revoked FROM customer_phone_proofs WHERE profile_id=? AND phone=?", f.profile, phone)).toEqual({ contact_id: id, revoked: 0 });
    expect((await send(f, "551187654321")).id).toBe(c.id);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([{ id }]);
  });

  it("conversa legada sem DDI mantém o encaminhamento e o dono", async () => {
    const f = await fixture(), c = await send(f), owner = await resolveCustomer(env, c);
    await exec(env, "UPDATE conversations SET external_id='11987654321',phone='11987654321',verified_phone=NULL,customer_identity_proof=NULL,customer_link_state='pending' WHERE id=?", c.id);
    const next = await send(f);
    expect(next.id).toBe(c.id);
    expect((await resolveCustomer(env, next)).contactId).toBe(owner.contactId);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it.each(["maintenance", "inbound"])("recupera prova observada anterior à migração por %s", async mode => {
    const f = await fixture(), c = await send(f), owner = await resolveCustomer(env, c);
    await exec(env, "DELETE FROM customer_phone_proofs WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE conversations SET customer_identity_proof=NULL WHERE id=?", c.id);
    if (mode === "maintenance") await maintain(f); else await send(f);
    expect(await resolveCustomer(env, await conversation(env, c.id, f.profile))).toMatchObject({ state: "ready", contactId: owner.contactId });
    expect(await one(env, "SELECT revoked,conversation_id FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual({ revoked: 0, conversation_id: c.id });
  });

  it.each([32, 36])("canal de %i caracteres recupera prova e rotas sem exceder o limite de padrão do D1", async length => {
    const f: Fixture = await fixture();
    const line = length === 32 ? f.line.replace(/-/g, "") : f.line;
    await exec(env, "UPDATE connections SET id=? WHERE id=?", line, f.line);
    f.line = line;
    const c = await send(f), owner = await resolveCustomer(env, c);
    expect(f.line).toHaveLength(length);
    expect(`customer:channel:${f.line}:%`.length).toBeGreaterThan(50);
    const records = await all(env, "SELECT * FROM customer_records WHERE conversation_id=?", c.id);
    // Exercita a leitura da procedência na entrada e no reparo em lotes.
    for (const mode of ["inbound", "maintenance"]) {
      await exec(env, "DELETE FROM customer_phone_proofs WHERE profile_id=?", f.profile);
      await exec(env, "UPDATE conversations SET customer_identity_proof=NULL WHERE id=?", c.id);
      if (mode === "inbound") await send(f); else await maintain(f);
      expect(await resolveCustomer(env, await conversation(env, c.id, f.profile)))
        .toMatchObject({ state: "ready", contactId: owner.contactId });
      expect(await one(env, "SELECT revoked,conversation_id FROM customer_phone_proofs WHERE profile_id=?", f.profile))
        .toEqual({ revoked: 0, conversation_id: c.id });
    }
    // Sem marcador, as três rotas precisam conferir o autor da mensagem.
    await exec(env, "UPDATE conversations SET customer_identity_proof=NULL WHERE id=?", c.id);
    expect((await conversationByPhone(env, f.profile, phone, { connectionId: f.line }))?.id).toBe(c.id);
    await exec(env, "UPDATE conversations SET phone=NULL WHERE id=?", c.id);
    expect((await conversationByPhone(env, f.profile, phone, { open: true, connectionId: f.line }))?.id).toBe(c.id);
    await exec(env, "UPDATE conversations SET phone='11987654321' WHERE id=?", c.id);
    expect((await send(f, "551187654321")).id).toBe(c.id);
    expect(await all(env, "SELECT * FROM customer_records WHERE conversation_id=?", c.id)).toEqual(records);
  });

  it.each(["inbound", "maintenance"])("%s exige prefixo literal do canal, inclusive maiúsculas e delimitador", async mode => {
    const f = await fixture(), c = await send(f);
    await exec(env, "DELETE FROM customer_phone_proofs WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE conversations SET customer_identity_proof=NULL WHERE id=?", c.id);
    for (const namespace of [`CHANNEL:${f.line}`, `channel:${f.line}extra`, `channel:${f.second}`, `app:${f.line}`]) {
      await exec(env, "UPDATE messages SET author=? WHERE conversation_id=? AND direction='customer'", `customer:${namespace}:${phone}`, c.id);
      if (mode === "inbound") {
        const plan = await identityPort.prepareInbound(env, await conversation(env, c.id, f.profile), { provider: "zernio", phone });
        expect(plan.state).toBe("pending");
        await batch(env, plan.statements);
      } else {
        await exec(env, "DELETE FROM customer_progress WHERE profile_id=?", f.profile);
        await maintain(f);
      }
      expect((await resolveCustomer(env, await conversation(env, c.id, f.profile))).contactId).toBeNull();
      expect(await all(env, "SELECT * FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
      expect(await conversationByPhone(env, f.profile, phone, { connectionId: f.line })).toBeNull();
      await exec(env, "UPDATE conversations SET phone=NULL WHERE id=?", c.id);
      expect(await conversationByPhone(env, f.profile, phone, { open: true, connectionId: f.line })).toBeNull();
      await exec(env, "UPDATE conversations SET phone=? WHERE id=?", phone, c.id);
    }
  });

  it("dois candidatos equivalentes ficam ambíguos sem terceira ficha", async () => {
    const f = await fixture();
    await contact(f, "11987654321"); await contact(f, "551187654321");
    const c = await send(f);
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "ambiguous", contactId: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
  });

  it("internacional explícito não ganha equivalência brasileira", async () => {
    expect(customerPhoneVariants("+1 (415) 555-0100", "human_br", true)).toEqual(["14155550100"]);
    const f = await fixture(), international = await contact(f, "+11987654321");
    const c = await send(f);
    expect((await resolveCustomer(env, c)).contactId).not.toBe(international);
  });

  it("recupera encaminhamento da conversa exata antiga sem conceder histórico", async () => {
    const f = await fixture(), c = await send(f);
    await exec(env, "DELETE FROM customer_phone_proofs WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE conversations SET verified_phone=NULL,customer_link_state='pending',customer_identity_proof=NULL WHERE id=?", c.id);
    expect((await conversationByPhone(env, f.profile, phone))?.id).toBe(c.id);
    expect((await resolveCustomer(env, await conversation(env, c.id, f.profile))).contactId).toBeNull();
    expect((await conversationByPhone(env, f.profile, phone, { open: true }))?.id).toBe(c.id);
  });

  it("colisão do INSERT OR IGNORE relê a conversa antiga e não contorna bloqueio", async () => {
    const f = await fixture(), c = await send(f);
    // O destinatário externo exato permanece, embora o campo cadastral tenha sido alterado.
    await exec(env, "UPDATE conversations SET phone=NULL,verified_phone=NULL,customer_link_state='pending',customer_identity_proof=NULL WHERE id=?", c.id);
    expect((await conversationByPhone(env, f.profile, phone, { open: true }))?.id).toBe(c.id);
    await exec(env, "UPDATE conversations SET customer_link_state='blocked' WHERE id=?", c.id);
    expect(await conversationByPhone(env, f.profile, phone, { open: true })).toBeNull();
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("abrir saída não prova identidade; resposta sem nono dígito reutiliza e confirma", async () => {
    const f = await fixture(), opened = await conversationByPhone(env, f.profile, phone, { open: true });
    expect(await all(env, "SELECT * FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
    const c = await send(f, "551187654321", f.line, { external_id: "bsuid" });
    expect(c.id).toBe(opened!.id);
    expect((await resolveCustomer(env, c)).state).toBe("ready");
  });

  it("conflito entre rotas não escolhe arbitrariamente nem cria outra conversa", async () => {
    const f = await fixture();
    await send(f, phone, f.line, { external_id: "first" });
    await send(f, phone, f.line, { external_id: "second" });
    await expect(send(f, "551187654321")).rejects.toMatchObject({ code: "customer_phone_ambiguous" });
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(2);
  });
});

describe("E6/M2/M5/E10 — vínculos estáveis", () => {
  it("recupera vínculo explícito de aplicação sem mensagem e mantém verifiedPhone nulo", async () => {
    const f = await fixture(), ns = "app:integration", id = await contact(f, phone, ns);
    const r = await inbound(env, f.profile, { external_id: "user", text: "Olá", message_id: uid() }, ns, null);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'admin',?)", r.conversation_id, f.profile, id, now());
    await maintain(f);
    const c = await conversation(env, r.conversation_id, f.profile);
    expect(c.customer_link_state).toBe("ready");
    expect(await resolveCustomer(env, c)).toMatchObject({ state: "ready", contactId: id, verifiedPhone: null, namespace: ns });
    await inbound(env, f.profile, { external_id: "user", phone, text: "retorno", message_id: uid() }, ns, null);
    expect((await conversation(env, c.id, f.profile)).customer_link_state).toBe("ready");
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", id);
    expect((await resolveCustomer(env, c)).state).toBe("excluded");
  });

  it("nome não invalida e não apaga a procedência; restrição invalida o atalho", async () => {
    const f = await fixture(), c = await send(f), ref = await resolveCustomer(env, c);
    const plan = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: ref.contactId!, phones: [phone], origin: "mirror" });
    expect(plan).toEqual([]);
    await exec(env, "UPDATE contacts SET name='Ana',version=version+1 WHERE id=?", ref.contactId);
    expect((await conversation(env, c.id, f.profile)).customer_link_state).toBe("ready");
    expect(await one(env, "SELECT origin FROM customer_phone_candidates WHERE contact_id=? AND phone=?", ref.contactId, phone)).toEqual({ origin: "observed" });
    await exec(env, "UPDATE contacts SET identity_state='restricted',version=version+1 WHERE id=?", ref.contactId);
    expect((await send(f)).customer_link_state).toBe("excluded");
  });

  it("grupo e LID estáveis não recebem escrita redundante nem prova", async () => {
    const f = await fixture();
    const r = await inbound(env, f.profile, { external_id: "123@g.us", chat_type: "group", text: "Olá", message_id: uid(), content: { participant: phone } }, `channel:${f.qr}`, f.qr);
    const c = await conversation(env, r.conversation_id, f.profile);
    expect(await identityPort.prepareInbound(env, c, { provider: "qr", phone, phoneJid: `${phone}@s.whatsapp.net` }))
      .toEqual({ state: "excluded", verifiedPhone: null, statements: [] });
    const lid = await send(f, phone, f.qr, { external_id: "123@lid", phone: null });
    expect((await identityPort.prepareInbound(env, lid, { provider: "qr", phone: null, phoneJid: "123@lid" })).statements).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });
});

describe("E1/E9/S4 — sessão confirmada com a entrada", () => {
  it("chave canônica preserva proprietário e instante em repetições", async () => {
    const f = await fixture(), c = await send(f);
    const before = await one(env, "SELECT * FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`);
    expect(before).toMatchObject({ module_id: "conversations", kind: "session" });
    await exec(env, "UPDATE conversations SET updated=updated+99999 WHERE id=?", c.id);
    await batch(env, [sessionStatement(f.profile, [c.id])]);
    expect(await one(env, "SELECT * FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`)).toEqual(before);
  });

  it.each(["before", "inside", "after"] as const)("queda %s na reabertura é atômica e repetição conserva sessão", async mode => {
    const f = await fixture(), c = await send(f);
    await exec(env, "UPDATE conversations SET state='closed',epoch=37 WHERE id=?", c.id);
    const data = { external_id: phone, phone, text: "retorno", message_id: uid(), content: { customerSession: "forjada" } };
    await expect(inbound(failInbox(mode), f.profile, data, `channel:${f.line}`, f.line)).rejects.toThrow();
    const failed = await conversation(env, c.id, f.profile);
    if (mode !== "after") expect(failed).toMatchObject({ state: "closed", epoch: 37, session: c.session });
    const r = await inbound(env, f.profile, data, `channel:${f.line}`, f.line);
    const current = await conversation(env, r.conversation_id, f.profile);
    expect(current.session).not.toBe(c.session);
    const received = await one(env, "SELECT content FROM messages WHERE conversation_id=? AND external_id=?", c.id, data.message_id);
    expect(JSON.parse(received.content).customerSession).toBe(current.session);
    const inbox = await one(env, "SELECT payload FROM inbox WHERE event_key=?", `${f.profile}:channel:${f.line}:${phone}:${data.message_id}`);
    expect(JSON.parse(inbox.payload)).toMatchObject({ session: current.session, epoch: current.epoch, content: { customerSession: current.session } });
    await inbound(env, f.profile, data, `channel:${f.line}`, f.line);
    expect((await conversation(env, c.id, f.profile)).session).toBe(current.session);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND external_id=?", c.id, data.message_id)).toHaveLength(1);
  });

  it("troca de dono com telefone igual inicia outra sessão sem reapontar a anterior", async () => {
    const f = await fixture(), c = await send(f), previous = await resolveCustomer(env, c);
    const plan = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: previous.contactId!, phones: [attacker], origin: "local" });
    await batch(env, [["UPDATE contacts SET phone=?,version=version+1 WHERE id=?", [attacker, previous.contactId]], ...plan]);
    const other = await send(f, phone, f.second), currentOwner = await resolveCustomer(env, other);
    const current = await send(f);
    expect(current.session).not.toBe(c.session);
    expect((await resolveCustomer(env, current)).contactId).toBe(currentOwner.contactId);
    expect(await one(env, "SELECT contact_id FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`)).toEqual({ contact_id: previous.contactId });
  });

  it("troca observada separa a sessão e message usa a sessão atual do banco", async () => {
    const f = await fixture(), c = await send(f), owner = await resolveCustomer(env, c);
    const changed = await send(f, attacker, f.line, { external_id: phone });
    expect(changed.session).not.toBe(c.session);
    expect((await resolveCustomer(env, changed)).contactId).not.toBe(owner.contactId);
    expect(await one(env, "SELECT contact_id FROM customer_records WHERE record_id=?", `${c.id}:${c.session}`)).toEqual({ contact_id: owner.contactId });
    const id = await message(env, c, "agent", "human", "Resposta"); // objeto antigo não pode forjar a sessão
    expect(JSON.parse((await one(env, "SELECT content FROM messages WHERE id=?", id)).content).customerSession).toBe(changed.session);
  });
});

it("E7 — base grande limita linhas/volume e ausência no índice incompleto não cria duplicata", async () => {
  const f = await fixture();
  await exec(env, `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
    INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated,mirror_json)
    SELECT printf('legacy-%04d',i),?,'team','Ana','','','import','test','test',1,1,
      json_object('phones',json_array(printf('55119777%04d',i)),'notes',?) FROM n`, f.profile, "x".repeat(4000));
  const opened = await conversationByPhone(env, f.profile, phone, { open: true });
  let rowsRead = 0, bytes = 0;
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (stmt: any): any => new Proxy(stmt, { get(target, prop) {
        if (prop === "bind") return (...args: any[]) => wrap(target.bind(...args));
        if (prop === "first") return async () => {
          const result = await target.all();
          rowsRead += result.meta.rows_read || 0;
          bytes += JSON.stringify(result.results).length;
          return result.results[0] ?? null;
        };
        const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(db.prepare(sql));
    };
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  } });
  const invocation = withReadCache({ ...env, DB } as Env);
  await inboundConnection(invocation, f.line);
  rowsRead = 0; bytes = 0;
  const plan = await identityPort.prepareInbound(invocation, opened!, { provider: "zernio", phone });
  expect(plan.state).toBe("pending");
  expect(rowsRead).toBeLessThan(600);
  expect(bytes).toBeLessThan(25000);
  expect(JSON.stringify(plan.statements).length).toBeLessThan(40000);
  await batch(env, plan.statements);
  expect(await one(env, "SELECT count(*) n FROM contacts WHERE profile_id=?", f.profile)).toEqual({ n: 1000 });
  const progress = await one(env, "SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND task=?", f.profile, CONTACT_TASK);
  expect(JSON.parse(progress.cursor_json).id).toBe("legacy-0020");
  expect(progress.complete).toBe(0);
});

it.each([false, true])("E7 — checkpoint completo limita leituras em base grande (candidato: %s)", async hasCandidate => {
  const f = await fixture();
  await exec(env, `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
    INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
    SELECT ?||printf('-complete-%04d',i),?,'team','Ana',printf('55119777%04d',i),'','import','test','test',1,1 FROM n`, f.profile, f.profile);
  await exec(env, `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
    SELECT profile_id,namespace,phone,id,'local' FROM contacts WHERE profile_id=?`, f.profile);
  const candidate = hasCandidate ? await contact(f, phone, "team", "import") : null;
  if (candidate) await index(f, candidate, [phone]);
  // complete=1 dispensa a página legada, mesmo sem cursor persistido;
  // a resolução deve se limitar aos candidatos pertinentes.
  await exec(env, `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
    VALUES(?,'team',?,'{}',1,?)`, f.profile, CONTACT_TASK, now());
  const opened = await conversationByPhone(env, f.profile, phone, { open: true });
  let rowsRead = 0, bytes = 0;
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (stmt: any): any => new Proxy(stmt, { get(target, prop) {
        if (prop === "bind") return (...args: any[]) => wrap(target.bind(...args));
        if (prop === "first") return async () => {
          const result = await target.all();
          rowsRead += result.meta.rows_read || 0;
          bytes += JSON.stringify(result.results).length;
          return result.results[0] ?? null;
        };
        const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(db.prepare(sql));
    };
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  } });
  const invocation = withReadCache({ ...env, DB } as Env);
  await inboundConnection(invocation, f.line);
  rowsRead = 0; bytes = 0;
  const plan = await identityPort.prepareInbound(invocation, opened!, { provider: "zernio", phone });
  expect(plan.state).toBe(hasCandidate ? "pending" : "ready");
  expect(rowsRead).toBeLessThan(600);
  expect(bytes).toBeLessThan(25000);
  expect(JSON.stringify(plan.statements).length).toBeLessThan(40000);
  await batch(env, plan.statements);
  expect(await one(env, "SELECT count(*) n FROM contacts WHERE profile_id=?", f.profile)).toEqual({ n: 1001 });
  const current = await conversation(env, opened!.id, f.profile);
  const ref = await resolveCustomer(env, current);
  if (candidate) {
    expect(ref).toMatchObject({ state: "pending", contactId: null });
    expect(await all(env, "SELECT contact_id FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
  } else {
    expect(ref).toMatchObject({ state: "ready", verifiedPhone: phone });
    expect(ref.contactId).toBeTruthy();
  }
  expect(await one(env, "SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND task=?", f.profile, CONTACT_TASK))
    .toEqual({ cursor_json: "{}", complete: 1 });
});
