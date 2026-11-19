import { env as testEnv } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Actor, type Conversation, type Env } from "../src/types";
import type { CustomerRef, IdentityPort } from "../src/customer/contracts";
import { installIdentityPort } from "../src/customer/ports";
import { modulesApi } from "../src/modules/api";
import { modules } from "../src/modules/registry";
import type { ModuleDefinition } from "../src/modules/types";
import { condominioModule } from "../src/modules/condominio/definition";
import { openResidentAccess, registerCondominio } from "../src/modules/condominio/condominio";
import { personIdentity, resident } from "../src/modules/condominio/common";
import { condominioCustomerProvider as provider } from "../src/modules/condominio/customer-provider";
import { listNotices, noticeCommand, sendDueNotices } from "../src/modules/condominio/notices";

const env = testEnv as unknown as Env;
// Simula apenas a porta central. Provas especializadas e todas as consultas usam D1 real.
const refs = new Map<string, CustomerRef>();
const identity: IdentityPort = {
  async resolve(_env, c) { return refs.get(c.id)!; },
  async prepareInbound() { return { statements: [], state: "pending", verifiedPhone: null }; },
  async indexContact() { return []; },
  async maintain() { return { pending: false, statements: 0, items: 0 }; },
};
beforeAll(() => {
  installIdentityPort(identity);
  if (!modules.some(m => m.id === "condominio")) {
    (modules as ModuleDefinition[]).push(condominioModule);
    registerCondominio();
  }
});

async function fixture() {
  const profile = uid(), contact = uid(), person = uid(), connection = uid(), conversation = uid();
  const block = uid(), unit = uid(), membership = uid(), phoneId = uid(), accessId = uid();
  const phone = "5511960010203", at = now() - 1000;
  const admin: Actor = { id: uid(), kind: "user", role: "operator", name: "Equipe", profiles: [profile],
    scopes: [], bots: [], rate: 100, runLimit: 0, access: ["condominio:admin"] };
  const finance = { ...admin, access: [...admin.access!, "mensalidade"] };
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,'Condomínio',1)", profile);
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','a','a',1,1)", contact, profile);
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,created) VALUES(?,?,'Canal','whatsapp','qr',1)", connection, profile);
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated)
    VALUES(?,?,?,?,?,?,?,'ready','session',1,1,1)`, conversation, profile, connection, `channel:${connection}`, phone, phone, phone);
  await exec(env, "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')", profile, phone, contact);
  refs.set(conversation, { profileId: profile, namespace: "team", state: "ready", contactId: contact, verifiedPhone: phone, version: 1, erp: null });
  for (const module of ["condominio", "os", "mensalidade"])
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,1,'a')", profile, module);
  await exec(env, "INSERT INTO cond_blocks(profile_id,id,name) VALUES(?,?,'Bloco A')", profile, block);
  await exec(env, "INSERT INTO cond_units(profile_id,id,block_id,number) VALUES(?,?,?,'101')", profile, unit, block);
  await exec(env, "INSERT INTO cond_people(profile_id,id,name) VALUES(?,?,'Morador legado')", profile, person);
  await exec(env, "INSERT INTO cond_phones(profile_id,id,person_id,phone,verified_by,starts_at) VALUES(?,?,?,?,'admin',?)", profile, phoneId, person, phone, at);
  await exec(env, "INSERT INTO cond_memberships(profile_id,id,person_id,unit_id,role,starts_at,verified_by,notices) VALUES(?,?,?,?,'proprietario',?,'admin',1)", profile, membership, person, unit, at);
  await exec(env, "INSERT INTO cond_access(profile_id,id,conversation_id,phone,person_id,expires_at) VALUES(?,?,?,?,?,?)", profile, accessId, conversation, phone, person, now() + 3600000);
  const c = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", conversation))!;
  const ctx = { ...modulesApi(env, profile, "condominio"),
    conversation: async () => (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", conversation))!,
    conversationByPhone: async () => c,
    sendMessage: vi.fn(async () => ({})) as any,
    issueCredential: vi.fn(async () => ({ url: "https://example.test/c/claim" })) as any,
    wake: vi.fn(async () => {}),
  };
  const customer: Actor = { ...admin, id: `cred:${uid()}`, kind: "app", role: "service", access: [],
    credential: { id: uid(), module: "condominio", subject: accessId } };
  const maintain = (e = env, statements = 40, items = 20) => provider.maintain!(e, profile, { remainingStatements: statements, remainingItems: items });
  const linked = () => one(env, "SELECT contact_id FROM cond_people WHERE profile_id=? AND id=?", profile, person);
  const read = (actor = admin) => provider.section!(ctx, actor, contact, "units");
  return { profile, contact, person, unit, membership, phoneId, phone, c, ctx, at, admin, finance, customer, accessId, maintain, linked, read };
}

async function subscription(f: Awaited<ReturnType<typeof fixture>>) {
  const id = uid();
  await exec(env, `INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,period,amount_cents,due_day,start_date,bill_from,created_by,created,updated)
    VALUES(?,?,'plan','monthly',12345,10,'2026-01-01','2026-01-01','a',1,1)`, id, f.profile);
  await exec(env, "INSERT INTO cond_unit_subscriptions(profile_id,unit_id,subscription_id) VALUES(?,?,?)", f.profile, f.unit, id);
  return id;
}

describe("c1 Condomínio — M3: vínculo legado", () => {
  it("preserva acesso especializado pendente e associa uma vez, com orçamento limitado", async () => {
    const f = await fixture();
    expect(await f.maintain(env, 7)).toEqual({ pending: true, statements: 0, items: 0 });
    await openResidentAccess(f.ctx, f.c, uid());
    expect(f.ctx.issueCredential).toHaveBeenCalledOnce();
    expect((await resident(f.ctx, f.customer, f.accessId)).person).toBe(f.person);
    expect((await f.linked()).contact_id).toBeNull();
    const result = await f.maintain(env, 8, 1);
    expect(result).toMatchObject({ statements: 8, items: 1 });
    expect((await f.linked()).contact_id).toBe(f.contact);
    const version = (await f.read()).version;
    await f.maintain();
    await f.maintain();
    expect((await f.read()).version).toBe(version);
    expect(await all(env, "SELECT id FROM cond_people WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it.each(["blocked", "excluded", "ambiguous", "pending"] as const)("não associa identidade %s", async state => {
    const f = await fixture();
    refs.set(f.c.id, { ...refs.get(f.c.id)!, state });
    await expect(personIdentity(f.ctx, f.c, f.person)).rejects.toThrow();
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
  });

  it("recusa contato restrito, de outra área e proprietário concorrente", async () => {
    const f = await fixture(), other = await fixture();
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.contact);
    await expect(personIdentity(f.ctx, f.c, f.person)).rejects.toThrow();
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
    await exec(env, "UPDATE contacts SET identity_state='active' WHERE id=?", f.contact);
    refs.set(f.c.id, { ...refs.get(f.c.id)!, contactId: other.contact });
    await expect(personIdentity(f.ctx, f.c, f.person)).rejects.toThrow();
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
    refs.set(f.c.id, { ...refs.get(f.c.id)!, contactId: f.contact });
    const competitor = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','a','a',1,1)", competitor, f.profile);
    let raced = false;
    const concurrent = { ...env, DB: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) { raced = true; await exec(env, "UPDATE cond_people SET contact_id=? WHERE profile_id=? AND id=?", competitor, f.profile, f.person); }
        return env.DB.batch(statements);
      },
    } } as unknown as Env;
    await f.maintain(concurrent);
    expect((await f.linked()).contact_id).toBe(competitor);
    await expect(personIdentity(f.ctx, f.c, f.person)).rejects.toThrow();
    expect(await all(env, "SELECT * FROM customer_sections WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it.each(["expirado", "futuro", "ambíguo"])("recusa telefone especializado %s", async kind => {
    const f = await fixture();
    if (kind === "expirado") await exec(env, "UPDATE cond_phones SET ends_at=? WHERE profile_id=?", now(), f.profile);
    if (kind === "futuro") await exec(env, "UPDATE cond_phones SET starts_at=? WHERE profile_id=?", now() + 60000, f.profile);
    if (kind === "ambíguo") {
      const person = uid();
      await exec(env, "INSERT INTO cond_people(profile_id,id,name) VALUES(?,?,'Outra pessoa')", f.profile, person);
      await exec(env, "INSERT INTO cond_phones(profile_id,id,person_id,phone,verified_by,starts_at,ends_at) VALUES(?,?,?,?,'admin',?,?)", f.profile, uid(), person, f.phone, f.at, now() + 60000);
    }
    await expect(personIdentity(f.ctx, f.c, f.person)).rejects.toThrow();
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
  });

  it("não escolhe entre contatos concorrentes nos telefones da mesma pessoa", async () => {
    const f = await fixture(), other = uid(), phone = "5511970010203";
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','a','a',1,1)", other, f.profile);
    await exec(env, "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')", f.profile, phone, other);
    await exec(env, "INSERT INTO cond_phones(profile_id,id,person_id,phone,verified_by,starts_at) VALUES(?,?,?,?,'admin',?)", f.profile, uid(), f.person, phone, f.at);
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
  });

  it("revalida restrição entre a leitura e a gravação da manutenção", async () => {
    const f = await fixture();
    let raced = false;
    const concurrent = { ...env, DB: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) { raced = true; await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.contact); }
        return env.DB.batch(statements);
      },
    } } as unknown as Env;
    await f.maintain(concurrent);
    expect((await f.linked()).contact_id).toBeNull();
    expect(await all(env, "SELECT * FROM customer_sections WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("recupera comunicado sem recadastrar e envia apenas aviso genérico", async () => {
    const f = await fixture();
    const notice = await noticeCommand(f.ctx, f.admin, "create", { title: "Aviso", body: "Conteúdo do condomínio", audience: "all" }, uid());
    await noticeCommand(f.ctx, f.admin, "approve", { ...notice, reviewed_public_content: true }, uid());
    await noticeCommand(f.ctx, f.admin, "send", notice, uid());
    await sendDueNotices(f.ctx);
    expect((await one(env, "SELECT status FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?", f.profile, notice.id)).status).toBe("queued");
    expect((await listNotices(f.ctx, f.customer, {}, f.accessId)).data).toContainEqual({ id: notice.id, title: "Aviso", body: "Conteúdo do condomínio" });
    expect(JSON.stringify(f.ctx.sendMessage.mock.calls)).not.toContain("Conteúdo do condomínio");
    expect((await f.linked()).contact_id).toBeNull();
  });
});

describe("c1 Condomínio — S8: assinaturas protegidas", () => {
  it.each(["permissão", "ativação"])("não consulta nem revela relações sem %s e preserva vínculos ao salvar", async missing => {
    const f = await fixture();
    await f.maintain();
    const subscriptionId = await subscription(f);
    const actor = missing === "permissão" ? f.admin : f.finance;
    if (missing === "ativação") await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='mensalidade'", f.profile);
    const queries: string[] = [];
    const guarded = { ...f.ctx, env: { ...env, DB: {
      prepare(sql: string) { queries.push(sql); return env.DB.prepare(sql); },
      batch: env.DB.batch.bind(env.DB),
    } } as unknown as Env };
    const before = await provider.section!(guarded, actor, f.contact, "units");
    expect((before.data as any).subscriptions).toEqual([]);
    const saved = await provider.saveSection!(guarded, actor, f.contact, "units", {
      commandId: uid(), expectedVersion: before.version,
      data: { memberships: [{ id: f.membership, personId: f.person, unitId: f.unit, role: "proprietario", startsAt: f.at, endsAt: null, notices: false }] },
    });
    expect((saved.data as any).subscriptions).toEqual([]);
    expect(queries.some(sql => /cond_unit_subscriptions|mensalidade_subscriptions/.test(sql))).toBe(false);
    expect(await all(env, "SELECT subscription_id FROM cond_unit_subscriptions WHERE profile_id=?", f.profile)).toEqual([{ subscription_id: subscriptionId }]);
    await expect(provider.saveSection!(f.ctx, actor, f.contact, "units", { commandId: uid(), expectedVersion: saved.version,
      data: { subscriptions: [{ unitId: f.unit, subscriptionId, linked: false }] } })).rejects.toThrow();
  });

  it("replay oculta assinaturas quando a autorização atual foi removida", async () => {
    const f = await fixture();
    await f.maintain();
    const subscriptionId = await subscription(f);
    const command = { commandId: uid(), expectedVersion: (await f.read()).version, data: {} };
    const saved = await provider.saveSection!(f.ctx, f.finance, f.contact, "units", command);
    expect((saved.data as any).subscriptions).toEqual([{ unitId: f.unit, subscriptionId, linked: true }]);
    const replay = await provider.saveSection!(f.ctx, f.admin, f.contact, "units", command);
    expect(replay.replayed).toBe(true);
    expect((replay.data as any).subscriptions).toEqual([]);
  });
});

describe("c1 Condomínio — F10: projeções", () => {
  it.each([["deliveries", "encomenda"], ["visits", "visitante"], ["occurrences", "ocorrencia"]])("projeta referência, estado real e datas em %s", async (collection, kind) => {
    const f = await fixture();
    await f.maintain();
    const id = uid();
    await exec(env, "INSERT INTO cond_works(profile_id,id,unit_id,person_id,membership_id,kind,created_at,source_key) VALUES(?,?,?,?,?,?,?,?)", f.profile, id, f.unit, f.person, f.membership, kind, f.at, id);
    const read = () => provider.list!(f.ctx, f.admin, f.contact, collection, { limit: 10 });
    expect((await read()).items[0].cells).toMatchObject({ id, status: null, occurredAt: f.at, unit: "101", block: "Bloco A" });
    await exec(env, "INSERT INTO os_orders(id,profile_id,number,status,item,problem,source,created_by,created,updated) VALUES(?,?,1,'delivered','Privado','Não projetar','panel','a',?,?)", id, f.profile, f.at, f.at);
    const result = await read();
    expect(result.items[0].cells).toMatchObject({ id, status: "delivered", occurredAt: f.at, unit: "101", block: "Bloco A" });
    expect(JSON.stringify(result)).not.toContain("Privado");
    expect(JSON.stringify(result)).not.toContain("Não projetar");
  });

  it("preserva vencimento e centavos nas parcelas, com referência e data", async () => {
    const f = await fixture();
    await f.maintain();
    const subscriptionId = await subscription(f), id = uid();
    await exec(env, "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,created,updated) VALUES(?,?,?,'2026-11','2026-11-10',12345,'paid',?,?)", id, f.profile, subscriptionId, f.at, f.at);
    const result = await provider.list!(f.ctx, f.finance, f.contact, "dues", { limit: 10 });
    expect(result.items[0].cells).toEqual({ id, status: "paid", occurredAt: f.at, dueDate: "2026-11-10", amountCents: 12345 });
    await expect(provider.list!(f.ctx, f.admin, f.contact, "dues", { limit: 10 })).rejects.toThrow();
  });

  it("não associa dependente privado nem projeta seus vínculos ou coleções", async () => {
    const f = await fixture();
    await exec(env, "UPDATE cond_memberships SET role='dependente',notices=0 WHERE profile_id=?", f.profile);
    await f.maintain();
    expect((await f.linked()).contact_id).toBeNull();
    expect((await f.read()).data).toMatchObject({ people: [], memberships: [], functions: [], subscriptions: [] });
    // Mesmo um vínculo preexistente indevido não permite projeção do dependente.
    await exec(env, "UPDATE cond_people SET contact_id=? WHERE profile_id=?", f.contact, f.profile);
    await expect(f.read()).rejects.toMatchObject({ code: "forbidden" });
    for (const collection of ["deliveries", "visits", "occurrences", "dues"])
      await expect(provider.list!(f.ctx, f.finance, f.contact, collection, { limit: 10 })).rejects.toMatchObject({ code: "forbidden" });
  });
});
