import { env as testEnv } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Actor, type Conversation, type Env } from "../src/types";
import type { CustomerRef, IdentityPort } from "../src/customer/contracts";
import { customerProvider, installIdentityPort } from "../src/customer/ports";
import { modulesApi } from "../src/modules/api";
import { modules } from "../src/modules/registry";
import type { ModuleDefinition } from "../src/modules/types";
import { condominioModule } from "../src/modules/condominio/definition";
import { registerCondominio, openResidentAccess } from "../src/modules/condominio/condominio";
import { cadastro } from "../src/modules/condominio/cadastro";
import { resident, selected } from "../src/modules/condominio/common";
import { condominioCustomerProvider as provider } from "../src/modules/condominio/customer-provider";
import { createWork, workDetail, workTypes, works } from "../src/modules/condominio/works";
import { noticeCommand, sendDueNotices } from "../src/modules/condominio/notices";
import type { CustomWorkType } from "../src/modules/os/contracts";

const env = testEnv as unknown as Env;
function motorWorkType(): CustomWorkType {
  return {
    schema_version: 1, kind: "custom", id: "portaria", revision: 1, archived: false,
    labels: { singular: "Registro", plural: "Registros", item: "Item", problem: "Descrição", customer_singular: "Pessoa", customer_plural: "Pessoas" },
    number_prefix: "REG", terms: null, fields: [], retired_field_ids: [], retired_stage_ids: [], initial_stage: "entrada",
    stages: [
      { id: "entrada", label: "Entrada", base_status: "received", message: "" },
      { id: "entregue", label: "Concluído", base_status: "delivered", message: "" },
      { id: "cancelado", label: "Cancelado", base_status: "cancelled", message: "" },
    ],
    transitions: [
      { id: "concluir", from: "entrada", to: "entregue", label: "Concluir", kind: "manual" },
      { id: "cancelar", from: "entrada", to: "cancelado", label: "Cancelar", kind: "manual" },
    ],
    features: { customer_open: true, tasks: true, people: true, documents: true, entries: true, quote: null, warranty_days: 0, pickup_reminder_days: 0, stale_days: 0 },
    pickup_reminder_text: "",
  };
}

// Porta simulada: esta tarefa não implementa o resolvedor da frente de identidade.
const identities = new Map<string, CustomerRef>();
const identity: IdentityPort = {
  async resolve(_env, c) {
    return identities.get(c.id) ?? { profileId: c.profile_id, namespace: "team", state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null };
  },
  async prepareInbound() { return { statements: [], state: "pending", verifiedPhone: null }; },
  async indexContact() { return []; },
  async maintain() { return { pending: false, items: 0, statements: 0 }; },
};
beforeAll(() => {
  installIdentityPort(identity);
  if (!modules.some(m => m.id === "condominio")) {
    (modules as ModuleDefinition[]).push(condominioModule);
    registerCondominio();
  }
});
async function fixture() {
  const profile = uid(), contact = uid(), conversation = uid();
  const phoneNumber = "5511960010203";
  const admin: Actor = { id: uid(), kind: "user", role: "admin", name: "Equipe", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 0, access: ["condominio:admin"] };
  const concierge = { ...admin, id: uid(), role: "operator", access: ["condominio:portaria"] } as Actor;
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,'Condomínio',1)", profile);
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic',?,?,1,1)", contact, profile, admin.id, admin.id);
  await exec(env, `INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated)
    VALUES(?,?,'channel:test',?, ?,?,'ready','session',1,1,1)`, conversation, profile, conversation, phoneNumber, phoneNumber);
  await exec(env, "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')", profile, phoneNumber, contact);
  for (const module of ["condominio", "os", "mensalidade"])
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,1,?)", profile, module, admin.id);
  const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", conversation);
  identities.set(conversation, { profileId: profile, namespace: "team", state: "ready", contactId: contact, verifiedPhone: phoneNumber, version: 1, erp: null });
  const types = Object.values(workTypes).map((id, i) => {
    const type = motorWorkType(); type.id = id; type.number_prefix = ["OC", "ENC", "VIS"][i];
    type.fields.push({ id: "unidade", label: "Unidade", help: "", kind: "text", max_length: 120, multiline: false, required: true, sensitive: false, client_visible: true });
    return type;
  });
  const ctx = { ...modulesApi(env, profile, "condominio"),
    conversation: async (id: string) => { const row = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, id); if (!row) throw new Error("Conversa ausente"); return row; },
    verifiedPhone: (c: Conversation) => c.verified_phone ?? null,
    conversationByPhone: async () => c!,
    settings: async () => ({ os_work_types: types }) as any,
    run: vi.fn(async (_actor: Actor, _op: string, _data: unknown, key?: string) => ({ id: `order:${key}` })) as any,
    sendMessage: vi.fn(async () => ({})) as any,
    wake: vi.fn(async () => {}),
  };
  const create = (action: string, data: unknown, key = uid()) => cadastro(ctx, admin, action, data, key);
  const block = (await create("block", { name: "Bloco A" })).id;
  const unit = (await create("unit", { block_id: block, number: "101" })).id;
  const unit2 = (await create("unit", { block_id: block, number: "102" })).id;
  const person = (await create("person", { name: "Ana" })).id;
  const membership = (await create("membership", { person_id: person, unit_id: unit, role: "proprietario", starts_at: now() - 10000, notices: true })).id;
  await create("phone", { person_id: person, conversation_id: conversation, confirmed: true });
  const accessId = uid();
  await exec(env, "INSERT INTO cond_access(profile_id,id,conversation_id,phone,person_id,expires_at) VALUES(?,?,?,?,?,?)", profile, accessId, conversation, phoneNumber, person, now() + 3600000);
  const customer: Actor = { ...admin, id: `cred:${uid()}`, kind: "app", role: "service", access: [], credential: { id: uid(), module: "condominio", subject: accessId } };
  const read = () => provider.section!(ctx, admin, contact, "units");
  const save = async (data: any, commandId = uid(), expectedVersion?: number) => provider.saveSection!(ctx, admin, contact, "units", { commandId, expectedVersion: expectedVersion ?? (await read()).version, data });
  return { profile, contact, c: c!, admin, concierge, ctx, create, unit, unit2, person, membership, customer, accessId, read, save };
}

describe("f1 Condomínio: ficha e identidade", () => {
  it("registra o provedor e preserva IDs ao associar pessoa ao contato", async () => {
    const f = await fixture();
    expect(customerProvider("condominio")).toBe(provider);
    expect(await one(env, "SELECT id,contact_id FROM cond_people WHERE profile_id=? AND id=?", f.profile, f.person)).toEqual({ id: f.person, contact_id: f.contact });
    expect((await f.read()).schema).toBe("condominio.units.v1");
    expect((await all(env, "SELECT id FROM cond_memberships WHERE profile_id=?", f.profile)).map(r => r.id)).toEqual([f.membership]);
    const previousPhone = await one(env, "SELECT id FROM cond_phones WHERE profile_id=?", f.profile);
    // Simula o vínculo telefônico legado, criado antes da coluna contact_id.
    await exec(env, "UPDATE cond_people SET contact_id=NULL WHERE profile_id=? AND id=?", f.profile, f.person);
    expect(await f.create("phone", { person_id: f.person, conversation_id: f.c.id, confirmed: true })).toEqual({ id: previousPhone.id });
    expect(await all(env, "SELECT id FROM cond_phones WHERE profile_id=?", f.profile)).toEqual([previousPhone]);
  });

  it("deriva funções simultâneas, fim exclusivo, várias unidades e empregado de unidade", async () => {
    const f = await fixture(), at = now();
    const functionId = uid();
    await f.save({
      memberships: [{ id: uid(), personId: f.person, unitId: f.unit2, role: "empregado_unidade", startsAt: at - 2000, endsAt: null, notices: false }],
      functions: [
        { id: functionId, personId: f.person, unitId: null, role: "sindico", startsAt: at - 2000, endsAt: null, expectedVersion: 0 },
        { id: uid(), personId: f.person, unitId: f.unit, role: "prestador", startsAt: at - 2000, endsAt: at, expectedVersion: 0 },
        { id: uid(), personId: f.person, unitId: f.unit, role: "visitante_recorrente", startsAt: at + 60000, endsAt: null, expectedVersion: 0 },
      ],
    });
    const data = (await f.read()).data as any;
    expect(data.personTypes.map((t: any) => t.key).sort()).toEqual(["empregado_unidade", "morador", "proprietario", "sindico"]);
    expect(data.memberships.find((m: any) => m.unitId === f.unit2)).toMatchObject({ role: "empregado_unidade", label: "Empregado de unidade" });
    const r = await resident(f.ctx, f.customer, f.accessId);
    expect(() => selected(r)).toThrow(/Escolha/);
    expect(selected(r, f.unit2).unit_id).toBe(f.unit2);
    await f.save({ functions: [{ id: functionId, personId: f.person, unitId: null, role: "sindico", startsAt: at - 2000, endsAt: at, expectedVersion: 1 }] });
    expect(((await f.read()).data as any).personTypes.map((t: any) => t.key)).not.toContain("sindico");
    // Função cadastral não muda a autorização de portaria para administrar.
    await expect(provider.section!(f.ctx, f.concierge, f.contact, "units")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("exige revisão telefônica e não reaponta pessoas nem acessos antigos", async () => {
    const f = await fixture();
    const person = (await f.create("person", { name: "Outra pessoa" })).id;
    await f.create("end-phone", { id: (await one(env, "SELECT id FROM cond_phones WHERE profile_id=?", f.profile)).id });
    const ref = identities.get(f.c.id)!;
    identities.set(f.c.id, { ...ref, state: "ambiguous", contactId: null });
    await expect(f.create("phone", { person_id: person, conversation_id: f.c.id, confirmed: true })).rejects.toMatchObject({ code: "customer_ambiguous" });
    expect((await one(env, "SELECT contact_id FROM cond_people WHERE profile_id=? AND id=?", f.profile, person)).contact_id).toBeNull();
    await expect(openResidentAccess(f.ctx, f.c, uid())).rejects.toMatchObject({ code: "customer_ambiguous" });
    identities.set(f.c.id, { ...ref, state: "pending", contactId: null });
    await expect(openResidentAccess(f.ctx, f.c, uid())).rejects.toMatchObject({ code: "phone_not_verified" });
    identities.set(f.c.id, ref);
    const other = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','a','a',1,1)", other, f.profile);
    identities.set(f.c.id, { ...ref, contactId: other });
    await expect(f.create("phone", { person_id: f.person, conversation_id: f.c.id, confirmed: true })).rejects.toMatchObject({ code: "contact_conflict" });
    expect((await one(env, "SELECT contact_id FROM cond_people WHERE profile_id=? AND id=?", f.profile, f.person)).contact_id).toBe(f.contact);
  });

  it("revalida identidade em acesso existente e antes de enviar avisos", async () => {
    const f = await fixture();
    const notice = await noticeCommand(f.ctx, f.admin, "create", { title: "Aviso", body: "Conteúdo administrativo", audience: "all" }, uid());
    await noticeCommand(f.ctx, f.admin, "approve", { ...notice, reviewed_public_content: true }, uid());
    await noticeCommand(f.ctx, f.admin, "send", notice, uid());
    identities.set(f.c.id, { ...identities.get(f.c.id)!, state: "ambiguous", contactId: null });
    await expect(resident(f.ctx, f.customer, f.accessId)).rejects.toMatchObject({ code: "customer_ambiguous" });
    await sendDueNotices(f.ctx);
    expect(f.ctx.sendMessage).not.toHaveBeenCalled();
    expect((await one(env, "SELECT status FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?", f.profile, notice.id)).status).toBe("failed");
  });

  it("replay devolve recibo original; corpo, ator e versão não podem ser trocados", async () => {
    const f = await fixture(), key = uid(), version = (await f.read()).version;
    const data = { functions: [{ id: uid(), personId: f.person, unitId: null, role: "zelador", startsAt: now(), endsAt: null, expectedVersion: 0 }] };
    const first = await f.save(data, key, version);
    await f.save({});
    expect(await f.save(data, key, version)).toEqual({ ...first, replayed: true });
    await expect(f.save({}, key, version)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(provider.saveSection!(f.ctx, { ...f.admin, id: uid() }, f.contact, "units", { commandId: key, expectedVersion: version, data })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.save({}, uid(), version)).rejects.toMatchObject({ code: "contact_conflict" });
    expect(await all(env, "SELECT id FROM cond_person_functions WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("reverte lote com falha intermediária e retoma após perda da resposta", async () => {
    const f = await fixture(), key = uid(), version = (await f.read()).version;
    const input = { commandId: key, expectedVersion: version, data: { functions: [{ id: uid(), personId: f.person, unitId: f.unit, role: "prestador", startsAt: now(), endsAt: null, expectedVersion: 0 }] } };
    const broken = { ...f.ctx, env: { ...env, DB: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => env.DB.batch([...statements.slice(0, -1), env.DB.prepare("INSERT INTO customer_assert(id,ok) VALUES(?,0)").bind(uid()), ...statements.slice(-1)]),
    } } as unknown as Env };
    await expect(provider.saveSection!(broken, f.admin, f.contact, "units", input)).rejects.toThrow();
    expect((await f.read()).version).toBe(version);
    expect(await all(env, "SELECT id FROM cond_person_functions WHERE profile_id=?", f.profile)).toHaveLength(0);
    expect(await all(env, "SELECT id FROM customer_jobs WHERE profile_id=?", f.profile)).toHaveLength(0);
    const lost = { ...f.ctx, env: { ...env, DB: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => { await env.DB.batch(statements); throw new Error("Resposta perdida"); },
    } } as unknown as Env };
    const recovered = await provider.saveSection!(lost, f.admin, f.contact, "units", input);
    expect(recovered).toMatchObject({ version: version + 1, replayed: true });
    expect(await provider.saveSection!(f.ctx, f.admin, f.contact, "units", input)).toEqual(recovered);
    expect(await all(env, "SELECT id FROM cond_person_functions WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_assert WHERE id LIKE 'cond-units:%'")).toHaveLength(0);
  });

  it("não recria vínculo antigo nem permite reapontar seus identificadores", async () => {
    const f = await fixture();
    const before = await one(env, "SELECT * FROM cond_memberships WHERE profile_id=? AND id=?", f.profile, f.membership);
    const work = await createWork(f.ctx, f.concierge, { kind: "encomenda", unit_id: f.unit, person_id: f.person, item: "Caixa", problem: "Recebida" }, uid());
    await f.save({ memberships: [{ id: f.membership, personId: f.person, unitId: f.unit, role: "proprietario", startsAt: before.starts_at, endsAt: now(), notices: false }] });
    expect((await one(env, "SELECT membership_id FROM cond_works WHERE profile_id=? AND id=?", f.profile, work.id)).membership_id).toBe(f.membership);
    await expect(f.save({ memberships: [{ id: f.membership, personId: f.person, unitId: f.unit2, role: "proprietario", startsAt: before.starts_at, endsAt: null, notices: false }] })).rejects.toMatchObject({ code: "contact_conflict" });
  });

  it("portaria não lê ocorrências; visitante eventual e entrega não criam contatos", async () => {
    const f = await fixture();
    const before = await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile);
    const visit = await createWork(f.ctx, f.concierge, { kind: "visitante", unit_id: f.unit, person_id: f.person, item: "Visita eventual", problem: "Aguardando autorização" }, uid());
    const delivery = await createWork(f.ctx, f.concierge, { kind: "encomenda", unit_id: f.unit, person_id: f.person, item: "Pacote", problem: "Recebido", delivery_source: "correios" }, uid());
    const incident = await createWork(f.ctx, f.admin, { kind: "ocorrencia", unit_id: f.unit, person_id: f.person, item: "Ocorrência", problem: "Relato privado" }, uid());
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual(before);
    expect(await one(env, "SELECT visitor_person_id,delivery_source FROM cond_portaria_details WHERE profile_id=? AND work_id=?", f.profile, visit.id)).toEqual({ visitor_person_id: null, delivery_source: null });
    expect((await one(env, "SELECT delivery_source FROM cond_portaria_details WHERE profile_id=? AND work_id=?", f.profile, delivery.id)).delivery_source).toBe("correios");
    await expect(workDetail(f.ctx, f.concierge, incident.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await works(f.ctx, f.concierge, {})).data.map(r => r.id)).not.toContain(incident.id);
    await expect(provider.list!(f.ctx, f.concierge, f.contact, "occurrences", { limit: 25 })).rejects.toMatchObject({ code: "forbidden" });
    expect((await provider.list!(f.ctx, f.concierge, f.contact, "visits", { limit: 25 })).items).toHaveLength(1);
  });

  it("visitante recorrente exige vigência e não recebe acesso de morador", async () => {
    const f = await fixture();
    const other = (await f.create("person", { name: "Visitante" })).id;
    await exec(env, "INSERT INTO cond_person_functions(profile_id,id,person_id,unit_id,role,starts_at,verified_by) VALUES(?,?,?,?,'visitante_recorrente',?,?)", f.profile, uid(), other, f.unit, now() - 1000, f.admin.id);
    const input = { kind: "visitante", unit_id: f.unit, person_id: f.person, visitor_person_id: other, item: "Visita", problem: "Aguardando autorização" };
    const result = await createWork(f.ctx, f.concierge, input, uid());
    expect((await one(env, "SELECT visitor_person_id FROM cond_portaria_details WHERE profile_id=? AND work_id=?", f.profile, result.id)).visitor_person_id).toBe(other);
    expect(await all(env, "SELECT id FROM cond_access WHERE profile_id=? AND person_id=?", f.profile, other)).toHaveLength(0);
    expect(f.ctx.run.mock.calls.every((args: any[]) => args[1] === "os.create")).toBe(true);
    await exec(env, "UPDATE cond_person_functions SET ends_at=? WHERE profile_id=? AND person_id=?", now(), f.profile, other);
    await expect(createWork(f.ctx, f.concierge, input, uid())).rejects.toMatchObject({ code: "not_found" });
  });

  it("taxas só aparecem com unidade–assinatura explícita, área correta e módulo ligado", async () => {
    const f = await fixture(), foreign = await fixture(), subscription = uid(), installment = uid();
    await exec(env, `INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,contact_id,period,amount_cents,due_day,start_date,bill_from,created_by,created,updated)
      VALUES(?,?,'plan',?,'monthly',1000,10,'2026-01-01','2026-01',?,1,1)`, subscription, f.profile, f.contact, f.admin.id);
    await exec(env, `INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,created,updated)
      VALUES(?,?,?,'2026-11','2026-11-10',1000,1,1)`, installment, f.profile, subscription);
    const list = () => provider.list!(f.ctx, f.admin, f.contact, "dues", { limit: 25 });
    expect((await list()).items).toHaveLength(0);
    await expect(foreign.save({ subscriptions: [{ unitId: foreign.unit, subscriptionId: subscription, linked: true }] })).rejects.toMatchObject({ code: "not_found" });
    await f.save({ subscriptions: [{ unitId: f.unit, subscriptionId: subscription, linked: true }] });
    expect((await list()).items.map(r => r.id)).toEqual([installment]);
    await f.create("end-membership", { id: f.membership });
    expect((await list()).items).toHaveLength(0);
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='mensalidade'", f.profile);
    await expect(list()).rejects.toMatchObject({ code: "module_disabled" });
  });

  it("cursor é autenticado e preso à área, contato, coleção e ator", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await createWork(f.ctx, f.concierge, { kind: "encomenda", unit_id: f.unit, person_id: f.person, item: "Pacote", problem: "Recebido" }, uid());
    const first = await provider.list!(f.ctx, f.admin, f.contact, "deliveries", { limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await provider.list!(f.ctx, f.admin, f.contact, "deliveries", { limit: 1, cursor: first.nextCursor! });
    expect(second.items[0].id).not.toBe(first.items[0].id);
    for (const [actor, collection, cursor] of [[f.concierge, "deliveries", first.nextCursor], [f.admin, "visits", first.nextCursor], [f.admin, "deliveries", "alterado"]] as const)
      await expect(provider.list!(f.ctx, actor, f.contact, collection, { limit: 1, cursor: cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("dependentes não são vinculados nem projetados na ficha comum", async () => {
    const f = await fixture(), person = (await f.create("person", { name: "Protegido" })).id;
    await f.create("membership", { person_id: person, unit_id: f.unit, role: "dependente", starts_at: now() });
    await f.create("end-phone", { id: (await one(env, "SELECT id FROM cond_phones WHERE profile_id=?", f.profile)).id });
    await expect(f.create("phone", { person_id: person, conversation_id: f.c.id, confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await one(env, "SELECT contact_id FROM cond_people WHERE profile_id=? AND id=?", f.profile, person)).contact_id).toBeNull();
    await f.create("membership", { person_id: f.person, unit_id: f.unit2, role: "dependente", starts_at: now() });
    await expect(f.read()).rejects.toMatchObject({ code: "forbidden" });
  });
});
