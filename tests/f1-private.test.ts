import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, uid, type Actor, type Conversation } from "../src/types";
import { modulesApi } from "../src/modules/api";
import type { CustomerRef, IdentityPort } from "../src/customer/contracts";
import { customerProvider, installIdentityPort, installWritePort, installErpBridge, installHistoryPort } from "../src/customer/ports";
import { guardianOrders, phoneHash } from "../src/modules/ensino/access";
import { claimAccess } from "../src/modules/ensino/customer";
import { ensinoCustomerProvider, linkEnsinoCustomer } from "../src/modules/ensino/customer-provider";
import { saudeCustomerProvider, linkSaudeCustomer } from "../src/modules/saude/customer-provider";
import { juridicoCustomerProvider, linkJuridicoCustomer } from "../src/modules/juridico/customer-provider";
import { saudeExtension } from "../src/modules/saude/saude";
import { ensinoCommands, ensinoWrites } from "../src/modules/ensino/ensino";
import { registerJuridico } from "../src/modules/juridico/juridico";
import { motorWorkType } from "./os-motor-fixture";

// As tarefas paralelas só são consumidas pela porta; não carregar implementações.
vi.mock("../src/modules/runtime", () => ({}));

const SECRET = "PRIVADO_NAO_EXPORTAR_8d27";
const phone = "5511988887777";
const identities = new Map<string, CustomerRef>();
const deniedCommonPort = vi.fn(async (): Promise<never> => { throw new Error("Porta comum indevida"); });
const identity: IdentityPort = {
  resolve: async (_env, c) => identities.get(c.id) ?? {
    profileId: c.profile_id, namespace: "team", state: "pending", contactId: null,
    verifiedPhone: null, version: null, erp: null,
  },
  prepareInbound: deniedCommonPort, indexContact: deniedCommonPort, maintain: deniedCommonPort,
};
beforeAll(() => {
  installIdentityPort(identity);
  installWritePort({ enrich: deniedCommonPort, maintain: deniedCommonPort });
  installErpBridge({ apply: deniedCommonPort, read: deniedCommonPort, scan: deniedCommonPort });
  installHistoryPort({ read: deniedCommonPort, memory: deniedCommonPort, maintain: deniedCommonPort });
  registerJuridico();
});
afterEach(() => { vi.restoreAllMocks(); identities.clear(); deniedCommonPort.mockClear(); });

async function fixture() {
  const profile = uid(), contactId = uid(), billingId = uid(), order = uid(), person = uid();
  const subject = uid(), classroom = uid(), enrollment = uid(), guardian = uid();
  const actor: Actor = { id: uid(), name: "Pessoa autorizada", kind: "user", role: "operator",
    profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10,
    access: ["*", "os:sensitive", "saude:clinical_read", "saude:clinical_write", "ensino:secretaria", "juridico:lawyer"] };
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,?,1)", profile, "Área");
  for (const module of ["os", "saude", "ensino", "juridico"])
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated_by,updated) VALUES(?,?,1,?,1)", profile, module, actor.id);
  for (const contact of [contactId, billingId]) await exec(env,
    "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','',?,'','manual',?,?,1,1)",
    contact, profile, phone, actor.id, actor.id);
  const ctx = modulesApi(env, profile, "ensino");
  const health = modulesApi(env, profile, "saude"), legal = modulesApi(env, profile, "juridico");
  const type = motorWorkType();
  await exec(env, `INSERT INTO os_orders(id,profile_id,number,contact_id,item,problem,extra_json,source,created_by,created,updated,type_id,type_snapshot_json,stage)
    VALUES(?,?,1,?,'Administrativo','',?,'panel',?,1,1,?,?,?)`,
    order, profile, contactId, JSON.stringify({ segredo: SECRET }), actor.id, type.id, JSON.stringify({ schema_version: 1, type }), type.initial_stage);
  await exec(env, `INSERT INTO os_people(id,profile_id,order_id,role,name,phone,sensitive,client_visible,created_by,created,updated)
    VALUES(?,?,?,'responsible',?,?,1,0,?,1,1)`, person, profile, order, SECRET, phone, actor.id);
  await exec(env, `INSERT INTO ensino_classes(profile_id,id,name,school_year,start_date,end_date,teacher_id,type_id,capacity,schedule_json,periods_json,rule_json,justified_counts,created)
    VALUES(?,?,?,'2026','2026-01-01','2099-12-31',?,'type',10,'[]','[]','{}',0,1)`, profile, classroom, SECRET, actor.id);
  await exec(env, `INSERT INTO ensino_enrollments(profile_id,id,class_id,order_id,start_date,end_date)
    VALUES(?,?,?,?,'2026-01-01','2099-12-31')`, profile, enrollment, classroom, order);
  await exec(env, `INSERT INTO ensino_guardians(profile_id,id,order_id,person_id,person_version,phone_hash,valid_until,verified_by,created)
    VALUES(?,?,?,?,1,?,'2099-12-31',?,1)`, profile, guardian, order, person, await phoneHash(ctx, phone), actor.id);
  // Deliberadamente não é um envelope válido: tentar descriptografar falharia.
  await exec(env, "INSERT INTO saude_subjects(profile_id,id,kind,payload_enc,created,last_activity) VALUES(?,?,'human',?,1,1)", profile, subject, SECRET);
  const c = { id: uid(), profile_id: profile, external_namespace: "qr:test", external_id: phone,
    connection_id: "qr:test", phone, verified_phone: phone, customer_link_state: "ready", chat_type: "direct", session: uid() } as Conversation;
  // Só simula a evidência do canal; a identidade cadastral vem da porta acima.
  vi.spyOn(ctx, "verifiedPhone").mockImplementation(conversation => conversation.phone);
  identities.set(c.id, { profileId: profile, namespace: "team", state: "ready", contactId,
    verifiedPhone: phone, version: 1, erp: null });
  const guardianInput = { id: classroom, enrollment_id: enrollment, guardian_id: guardian, contact_id: contactId };
  return { profile, actor, ctx, health, legal, contactId, billingId, order, person, subject, classroom, enrollment, guardian, c, guardianInput };
}

describe("vínculos privados por IDs", () => {
  it("registra provedores e comandos nos descritores existentes", () => {
    expect(customerProvider("saude")).toBe(saudeCustomerProvider);
    expect(customerProvider("ensino")).toBe(ensinoCustomerProvider);
    expect(customerProvider("juridico")).toBe(juridicoCustomerProvider);
    expect(saudeExtension.commands.some(c => c.op === "saude.customer.link")).toBe(true);
    for (const route of ensinoWrites.filter(r => r.op.startsWith("ensino.customer.")))
      expect(ensinoCommands.some(c => c.op === route.op)).toBe(true);
  });

  it("separa responsável pedagógico do financeiro sem alterar autorizações", async () => {
    const f = await fixture();
    const before = await one(env, "SELECT * FROM ensino_guardians WHERE profile_id=? AND id=?", f.profile, f.guardian);
    await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, uid(), "guardian");
    await linkEnsinoCustomer(f.ctx, f.actor, { id: f.classroom, enrollment_id: f.enrollment, contact_id: f.billingId }, uid(), "billing");
    expect(await one(env, "SELECT * FROM ensino_guardians WHERE profile_id=? AND id=?", f.profile, f.guardian))
      .toEqual({ ...before, contact_id: f.contactId });
    expect(await one(env, "SELECT billing_contact_id FROM ensino_enrollments WHERE profile_id=? AND id=?", f.profile, f.enrollment))
      .toEqual({ billing_contact_id: f.billingId });
    expect((await guardianOrders(f.ctx, f.c)).orderIds).toEqual([f.order]);
    identities.set(f.c.id, { ...identities.get(f.c.id)!, contactId: f.billingId });
    expect((await guardianOrders(f.ctx, f.c)).orderIds).toEqual([]);
  });

  it.each(["revoked", "expired", "version", "phone", "archived", "hash"])("revalida autorização privada após %s", async change => {
    const f = await fixture(), key = uid();
    await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, key, "guardian");
    if (change === "revoked") await exec(env, "UPDATE ensino_guardians SET revoked_at=1 WHERE profile_id=?", f.profile);
    if (change === "expired") await exec(env, "UPDATE ensino_guardians SET valid_until='2000-01-01' WHERE profile_id=?", f.profile);
    if (change === "version") await exec(env, "UPDATE os_people SET version=version+1 WHERE profile_id=?", f.profile);
    if (change === "phone") await exec(env, "UPDATE os_people SET phone='5511999990000' WHERE profile_id=?", f.profile);
    if (change === "archived") await exec(env, "UPDATE os_people SET archived_at=1 WHERE profile_id=?", f.profile);
    if (change === "hash") await exec(env, "UPDATE ensino_guardians SET phone_hash='outro' WHERE profile_id=?", f.profile);
    expect((await guardianOrders(f.ctx, f.c)).orderIds).toEqual([]);
    if (["revoked", "expired", "version", "archived"].includes(change))
      await expect(linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, key, "guardian")).rejects.toMatchObject({ status: 404 });
  });

  it("revalida telefone observado, sessão e estado do contato no claim", async () => {
    const f = await fixture(), accessId = uid();
    await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, uid(), "guardian");
    await exec(env, `INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,1,1,1)`, f.c.id, f.profile, f.c.external_namespace, phone, phone, f.c.session);
    await exec(env, "INSERT INTO ensino_access(profile_id,id,conversation_id,session,phone_hash,expires) VALUES(?,?,?,?,?,?)",
      f.profile, accessId, f.c.id, f.c.session, await phoneHash(f.ctx, phone), Date.now() + 60000);
    expect(await claimAccess(f.ctx, { subject: accessId })).toMatchObject({ ready: true });
    await exec(env, "UPDATE conversations SET phone='5511999990000' WHERE id=?", f.c.id);
    await expect(claimAccess(f.ctx, { subject: accessId })).rejects.toMatchObject({ status: 404 });
    await exec(env, "UPDATE conversations SET phone=?,session='other' WHERE id=?", phone, f.c.id);
    await expect(claimAccess(f.ctx, { subject: accessId })).rejects.toMatchObject({ status: 404 });
    for (const state of ["pending", "ambiguous", "blocked", "excluded"] as const) {
      identities.set(f.c.id, { ...identities.get(f.c.id)!, state });
      await expect(guardianOrders(f.ctx, f.c)).rejects.toMatchObject({ status: 404 });
    }
  });

  it.each(["self", "responsible", "tutor"])("Saúde vincula %s sem ler identidade cifrada e repete atomicamente", async relation => {
    const f = await fixture(), key = uid();
    const input = { subject_id: f.subject, contact_id: f.contactId, relation };
    expect(await linkSaudeCustomer(f.health, f.actor, input, key)).toEqual({ contactId: f.contactId });
    expect(await linkSaudeCustomer(f.health, f.actor, input, key)).toEqual({ contactId: f.contactId });
    expect(await all(env, "SELECT * FROM saude_contact_links WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM saude_access_audit WHERE profile_id=?", f.profile)).toHaveLength(1);
    await expect(linkSaudeCustomer(f.health, f.actor, { ...input, contact_id: f.billingId }, key))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("Ensino repete comando sem novo efeito e recusa reapontamento", async () => {
    const f = await fixture(), key = uid();
    const first = await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, key, "guardian");
    expect(await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, key, "guardian")).toEqual(first);
    expect(await all(env, "SELECT id FROM ensino_audit WHERE profile_id=?", f.profile)).toHaveLength(1);
    await expect(linkEnsinoCustomer(f.ctx, f.actor, { ...f.guardianInput, contact_id: f.billingId }, key, "guardian"))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(linkEnsinoCustomer(f.ctx, f.actor, { ...f.guardianInput, contact_id: f.billingId }, uid(), "guardian"))
      .rejects.toMatchObject({ code: "contact_conflict" });
  });

  it("faz rollback do vínculo se a versão da turma muda durante o comando", async () => {
    const f = await fixture();
    const original = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
      await exec(env, "UPDATE ensino_classes SET version=version+1 WHERE profile_id=? AND id=?", f.profile, f.classroom);
      return original(statements);
    });
    await expect(linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, uid(), "guardian"))
      .rejects.toMatchObject({ code: "contact_conflict" });
    spy.mockRestore();
    expect(await one(env, "SELECT contact_id FROM ensino_guardians WHERE profile_id=? AND id=?", f.profile, f.guardian))
      .toEqual({ contact_id: null });
    expect(await all(env, "SELECT id FROM ensino_audit WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM customer_assert")).toEqual([]);
  });

  it("Jurídico usa exclusivamente o cliente do trabalho, sem promover partes", async () => {
    const f = await fixture(), input = { order_id: f.order, contact_id: f.contactId };
    const before = await one(env, "SELECT * FROM os_orders WHERE id=?", f.order);
    expect(await linkJuridicoCustomer(f.legal, f.actor, input)).toEqual({ contactId: f.contactId });
    expect(await linkJuridicoCustomer(f.legal, f.actor, input)).toEqual({ contactId: f.contactId });
    await expect(linkJuridicoCustomer(f.legal, f.actor, { ...input, contact_id: f.billingId })).rejects.toMatchObject({ code: "contact_conflict" });
    expect(await one(env, "SELECT * FROM os_orders WHERE id=?", f.order)).toEqual(before);
  });

  it("recusa papel insuficiente, automação, contato alheio, namespace e contato restrito", async () => {
    const f = await fixture(), other = await fixture();
    const attempts = (actor: Actor, contactId: string) => [
      () => linkSaudeCustomer(f.health, actor, { subject_id: f.subject, contact_id: contactId, relation: "self" }, uid()),
      () => linkEnsinoCustomer(f.ctx, actor, { ...f.guardianInput, contact_id: contactId }, uid(), "guardian"),
      () => linkJuridicoCustomer(f.legal, actor, { order_id: f.order, contact_id: contactId }),
    ];
    for (const actor of [{ ...f.actor, access: ["*"] }, { ...f.actor, kind: "app" as const },
      { ...f.actor, id: "bot:masked" }, { ...f.actor, credential: { id: "cred", module: "ensino", subject: "school" } }])
      for (const run of attempts(actor, f.contactId)) await expect(run()).rejects.toBeInstanceOf(ApiError);
    for (const run of attempts(f.actor, other.contactId)) await expect(run()).rejects.toMatchObject({ status: 404 });
    await expect(linkSaudeCustomer(f.health, f.actor, { subject_id: other.subject, contact_id: f.contactId, relation: "self" }, uid())).rejects.toMatchObject({ status: 404 });
    await expect(linkEnsinoCustomer(f.ctx, f.actor, { ...f.guardianInput, guardian_id: other.guardian }, uid(), "guardian")).rejects.toMatchObject({ status: 404 });
    await expect(linkJuridicoCustomer(f.legal, f.actor, { order_id: other.order, contact_id: f.contactId })).rejects.toMatchObject({ status: 404 });
    for (const patch of ["namespace='app:other'", "namespace='team',identity_state='restricted'"]) {
      await exec(env, `UPDATE contacts SET ${patch} WHERE id=?`, f.contactId);
      for (const run of attempts(f.actor, f.contactId)) await expect(run()).rejects.toMatchObject({ status: 404 });
    }
  });

  it("não exporta conteúdo privado, contadores ou vínculos pelas portas comuns", async () => {
    const f = await fixture();
    const before = await all(env, "SELECT * FROM contacts WHERE profile_id=? ORDER BY id", f.profile);
    await linkSaudeCustomer(f.health, f.actor, { subject_id: f.subject, contact_id: f.contactId, relation: "tutor" }, uid());
    await linkEnsinoCustomer(f.ctx, f.actor, f.guardianInput, uid(), "guardian");
    const providers = [[saudeCustomerProvider, f.health], [ensinoCustomerProvider, f.ctx], [juridicoCustomerProvider, f.legal]] as const;
    for (const [provider, ctx] of providers) {
      const view = await provider.section!(ctx, f.actor, f.contactId, "private");
      expect(view).toEqual({ version: 1, writable: false, schema: "private.navigation.v1", data: {
        target: { module: ctx.module.id, resource: "home", id: ctx.module.id },
        erasure: { state: "retained", reason: "private_retention_review" },
      } });
      expect(await provider.section!(ctx, f.actor, f.billingId, "private")).toEqual(view);
      expect(provider.list).toBeUndefined();
      expect(provider.maintain).toBeUndefined();
      await expect(provider.saveSection!(ctx, f.actor, f.contactId, "private", {
        commandId: uid(), expectedVersion: 1, data: { name: SECRET, patch: { document: SECRET } },
      })).rejects.toMatchObject({ status: 403 });
      await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id=?", f.profile, ctx.module.id);
      await expect(provider.section!(ctx, f.actor, f.contactId, "private")).rejects.toMatchObject({ code: "module_disabled" });
    }
    expect(await all(env, "SELECT * FROM contacts WHERE profile_id=? ORDER BY id", f.profile)).toEqual(before);
    for (const table of ["customer_jobs", "customer_records", "customer_sections", "outbox", "events"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).toEqual([]);
    expect(deniedCommonPort).not.toHaveBeenCalled();
  });

  it("rejeita conteúdo cadastral e privado nos comandos de IDs", async () => {
    const f = await fixture();
    for (const field of ["patch", "name", "student", "payload_enc", "document", "private_fields"]) {
      await expect(linkSaudeCustomer(f.health, f.actor, { subject_id: f.subject, contact_id: f.contactId, relation: "self", [field]: SECRET }, uid())).rejects.toMatchObject({ status: 400 });
      await expect(linkEnsinoCustomer(f.ctx, f.actor, { ...f.guardianInput, [field]: SECRET }, uid(), "guardian")).rejects.toMatchObject({ status: 400 });
      await expect(linkJuridicoCustomer(f.legal, f.actor, { order_id: f.order, contact_id: f.contactId, [field]: SECRET })).rejects.toMatchObject({ status: 400 });
    }
  });
});
