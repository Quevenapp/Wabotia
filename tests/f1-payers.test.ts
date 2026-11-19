import { env as cloudEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { type Actor, type Conversation, type Env, now, uid } from "../src/types";
import type { CustomerRef } from "../src/customer/contracts";
import { customerProvider, installIdentityPort } from "../src/customer/ports";
import * as moduleApi from "../src/modules/api";
import { modulesApi } from "../src/modules/api";
import { createPayer, payerPhones, provisionalPayer, updatePayer } from "../src/modules/mensalidade/payers";
import { createPlan, createSubscription } from "../src/modules/mensalidade/store";
import { situationByDocument, situationByPhone, contractPlan } from "../src/modules/mensalidade/public";
import { mensalidadeCustomerProvider, payerDocumentStatement } from "../src/modules/mensalidade/customer-provider";
import { suporteCustomerProvider, supportCustomerStatements, supportSessionKey } from "../src/modules/suporte/customer-provider";
import { buyPackage, openSession, release } from "../src/modules/suporte/store";
import "../src/modules/mensalidade/mensalidade";
import "../src/modules/suporte/suporte";

// Dependência de f1-identidade simulada pela porta da base. Sem ERP, rede,
// entrada de WhatsApp ou temporizadores do Coordinator nos cenários abaixo.
const identities = new Map<string, CustomerRef>();
installIdentityPort({
  resolve: async (_env, c) => identities.get(c.id) ?? {
    profileId: c.profile_id, namespace: "team", state: "pending", contactId: null,
    verifiedPhone: null, version: null, erp: null,
  },
  prepareInbound: async () => ({ statements: [], state: "pending", verifiedPhone: null }),
  indexContact: async () => [],
  maintain: async () => ({ pending: false, statements: 0, items: 0 }),
});
const coordinator = vi.fn(() => { throw new Error("Não deve chamar o Coordinator/ERP"); });
const env = { ...cloudEnv, COORDINATOR: { idFromName: coordinator, get: coordinator } } as unknown as Env;
afterEach(() => { expect(coordinator).not.toHaveBeenCalled(); coordinator.mockClear(); });
const CPF = "52998224725", CNPJ = "11222333000181";
const phone = "5511987654321";
const pkg = { id: "avulso", name: "Atendimento", price_cents: 4900, mode: "hours" as const, hours: 24, active: true };

async function fixture() {
  const profile = uid(), connection = uid();
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,'Área',?)", profile, now());
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Linha','zernio','direct','active','{}',?)", connection, profile, now());
  for (const module of ["mensalidade", "suporte"])
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,?,'test')", profile, module, now());
  const actor: Actor = { id: uid(), kind: "user", role: "admin", name: "Equipe", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10 };
  const mctx = modulesApi(env, profile, "mensalidade");
  const sctx = modulesApi(env, profile, "suporte");
  mctx.publish = vi.fn(async () => ({})) as any;
  sctx.publish = vi.fn(async () => ({})) as any;
  sctx.recordConsent = vi.fn(async () => ({})) as any;
  sctx.activeTicket = vi.fn(async () => ({ id: "ticket", number: 1 })) as any;
  sctx.charge = vi.fn(async (_c, input) => ({ id: uid(), pix_code: "pix", url: null, method: input.method, expires_at: now() + 3_600_000 })) as any;
  async function contact(document: string | null = null, namespace = "team", identityState = "active") {
    const id = uid();
    await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,document,search_text,source,created_by,updated_by,created,updated,identity_state)
      VALUES(?,?,?,'Pessoa',?,?,'','manual','test','test',?,?,?)`, id, profile, namespace, phone, document, now(), now(), identityState);
    return id;
  }
  async function conversation(contactId: string | null) {
    const id = uid();
    await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,?,'ready',?,?,?,?)`, id, profile, connection, `channel:${connection}`, id, phone, phone, uid(), now(), now(), now());
    const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id);
    identities.set(id, { profileId: profile, namespace: "team", state: contactId ? "ready" : "ambiguous",
      contactId, verifiedPhone: phone, version: 1, erp: null });
    return c!;
  }
  return { profile, actor, mctx, sctx, contact, conversation };
}
const links = (profile: string) => all(env, "SELECT * FROM customer_records WHERE profile_id=? ORDER BY kind,record_id", profile);
const list = (f: Awaited<ReturnType<typeof fixture>>, contact: string, kind: string, query = { limit: 25 }) =>
  suporteCustomerProvider.list!(f.sctx, f.actor, contact, kind, query);

describe("f1: identidade do pagador", () => {
  it("registra os provedores permanentes", () => {
    expect(customerProvider("mensalidade")).toBe(mensalidadeCustomerProvider);
    expect(customerProvider("suporte")).toBe(suporteCustomerProvider);
  });

  it("empresa e funcionário autorizado continuam pessoas distintas; cadastro não autoriza outro telefone", async () => {
    const f = await fixture(), company = await f.contact(CNPJ), employee = await f.contact();
    const payer = await createPayer(f.mctx, { document: CNPJ, name: "Empresa", phones: [phone] }, f.actor.id);
    expect(payer.contact_id).toBe(company);
    expect(payer.contact_id).not.toBe(employee);
    expect((await situationByPhone(env, f.profile, phone))?.payer.id).toBe(payer.id);
    expect(await situationByPhone(env, f.profile, "5511987654300")).toBeNull();
    expect((await situationByDocument(env, f.profile, CNPJ, { phone: "5511987654300" }))?.phone_linked).toBe(false);
    expect(await payerPhones(f.mctx, payer.id)).toHaveLength(1);
  });

  it("familiar autorizado não vira titular; documento único ou escolha humana são as únicas associações", async () => {
    const f = await fixture(), relative = await f.contact();
    let payer = await createPayer(f.mctx, { name: "Responsável", phones: [phone] }, f.actor.id);
    expect(payer.contact_id).toBeNull();
    await mensalidadeCustomerProvider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await one(env, "SELECT contact_id FROM mensalidade_payers WHERE id=?", payer.id)).contact_id).toBeNull();
    await expect(updatePayer(f.mctx, payer, { contact_id: relative }, "app:test")).rejects.toMatchObject({ code: "forbidden" });
    payer = await updatePayer(f.mctx, payer, { contact_id: relative }, f.actor.id, f.actor);
    expect(payer.contact_id).toBe(relative);
    expect(f.mctx.publish).toHaveBeenLastCalledWith("mensalidade.payer_changed", payer.id,
      expect.objectContaining({ actor: f.actor.id, contact_id: relative, contact_link: "human" }), expect.anything());
    await expect(updatePayer(f.mctx, payer, { contact_id: await f.contact() }, f.actor.id, f.actor))
      .rejects.toMatchObject({ code: "contact_conflict" });
  });

  it("documentos conflitantes, inválidos, restritos e namespaces alheios ficam sem vínculo", async () => {
    const f = await fixture();
    await f.contact(CPF); await f.contact(CPF);
    const payer = await createPayer(f.mctx, { name: "Duplicado", document: CPF }, f.actor.id);
    expect(payer.contact_id).toBeNull();
    expect(payerDocumentStatement(f.profile, payer.id, "11111111111")).toEqual([]);
    await f.contact(CNPJ, "app:integration");
    const company = await createPayer(f.mctx, { name: "Empresa", document: CNPJ }, f.actor.id);
    expect(company.contact_id).toBeNull();
    await f.contact(CNPJ, "team", "restricted");
    await mensalidadeCustomerProvider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await one(env, "SELECT contact_id FROM mensalidade_payers WHERE id=?", company.id)).contact_id).toBeNull();
    const other = await fixture();
    await expect(updatePayer(f.mctx, payer, { contact_id: await other.contact() }, f.actor.id, f.actor))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("preenche legado por documento em lotes atômicos e preserva pagador provisório", async () => {
    const f = await fixture();
    const payer = await createPayer(f.mctx, { name: "Provisório", document: CPF, phones: [phone] }, "contrato:teste");
    const person = await f.contact(CPF);
    const budget = { remainingItems: 1, remainingStatements: 4 };
    const result = await mensalidadeCustomerProvider.maintain!(env, f.profile, budget);
    expect(result).toEqual({ items: 1, statements: 4, pending: true });
    const fresh = await one(env, "SELECT * FROM mensalidade_payers WHERE id=?", payer.id);
    expect(fresh.contact_id).toBe(person);
    expect(provisionalPayer(fresh)).toBe(true);
    expect(await one(env, "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND task='mensalidade.payers.v1'", f.profile))
      .toEqual({ cursor_json: JSON.stringify({ id: payer.id }) });
    expect(await mensalidadeCustomerProvider.maintain!(env, f.profile, { remainingItems: 1, remainingStatements: 2 }))
      .toEqual({ items: 0, statements: 0, pending: true });
  });

  it("fluxo público continua recusando documento existente sem conceder acesso", async () => {
    const f = await fixture(), person = await f.contact(CPF), c = await f.conversation(person);
    const payer = await createPayer(f.mctx, { name: "Titular", document: CPF }, f.actor.id);
    const plan = await createPlan(f.mctx, { name: "Plano", amount_cents: 9900, sellable: true }, f.actor.id);
    const mock = vi.spyOn(moduleApi, "modulesApi").mockReturnValue({
      ...f.mctx, paymentsReady: async () => ({ ready: true }),
    } as any);
    try {
      await expect(contractPlan(env, f.profile, { conversation: c, plan_id: plan.id, actor: "customer", document: CPF,
        name: "Titular", sourceKey: uid(), method: "pix" })).rejects.toMatchObject({ code: "payer_exists" });
      await expect(contractPlan(env, f.profile, { conversation: c, plan_id: plan.id, actor: "customer", payer_id: payer.id,
        sourceKey: uid(), method: "pix" })).rejects.toMatchObject({ code: "phone_not_linked" });
      expect(await payerPhones(f.mctx, payer.id)).toEqual([]);
    } finally { mock.mockRestore(); }
  });

  it("assinatura grava o interlocutor resolvido e mantém o pagador separado", async () => {
    const f = await fixture(), company = await f.contact(CNPJ), employee = await f.contact();
    const c = await f.conversation(employee);
    const payer = await createPayer(f.mctx, { name: "Empresa", document: CNPJ, phones: [phone] }, f.actor.id);
    const plan = await createPlan(f.mctx, { name: "Plano", amount_cents: 9900 }, f.actor.id);
    const sub = await createSubscription(f.mctx, { plan_id: plan.id, conversation: c, payer_id: payer.id, customer_name: "Funcionário", phone }, f.actor.id);
    expect((await one(env, "SELECT contact_id,payer_id FROM mensalidade_subscriptions WHERE id=?", sub.id)))
      .toEqual({ contact_id: employee, payer_id: payer.id });
    for (const id of [company, employee]) {
      const page = await mensalidadeCustomerProvider.list!(f.mctx, f.actor, id, "subscriptions", { limit: 25 });
      expect(page.items.map((r) => r.id)).toContain(sub.id);
      expect(page.items.find((r) => r.id === sub.id)?.cells.relation).toBe(id === company ? "Pagador" : "Interlocutor");
    }
    const installment = uid();
    await exec(env, "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,created,updated) VALUES(?,?,?,'2026-11','2026-11-25',9900,?,?)",
      installment, f.profile, sub.id, now(), now());
    const installments = await mensalidadeCustomerProvider.list!(f.mctx, f.actor, company, "installments", { limit: 25 });
    expect(installments.items.map((r) => r.id)).toContain(installment);
    expect(await links(f.profile)).toEqual([]); // vínculo próprio não é duplicado
  });
});

describe("f1: interlocutor, comprador e pagador no Suporte", () => {
  it("compra e liberação pertencem ao funcionário comprador, preservando payer_id da empresa", async () => {
    const f = await fixture(), company = await f.contact(CNPJ), buyer = await f.contact();
    const payer = await createPayer(f.mctx, { name: "Empresa", document: CNPJ, phones: [phone] }, f.actor.id);
    const c = await f.conversation(buyer), session = await openSession(f.sctx, c, "choose_method", now());
    const purchase = await buyPackage(f.sctx, { c, session, pkg, method: "pix", payer_id: payer.id, document: CNPJ, name: "Empresa", sourceKey: uid() });
    const released = await release(f.sctx, { c, session, kind: "package", ref: purchase.id, payer, actor: f.actor.id, sourceKey: uid(), pass: false, valid_until: now() + 3_600_000 });
    expect(purchase.payer_id).toBe(payer.id);
    expect(released.release.payer_id).toBe(payer.id);
    const records = await links(f.profile);
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.contact_id))).toEqual(new Set([buyer]));
    expect(records.find((r) => r.kind === "sessions")?.record_id).toBe(supportSessionKey(c.id, session.id));
    for (const kind of ["sessions", "purchases", "releases"]) {
      expect((await list(f, buyer, kind)).items).toHaveLength(1);
      expect((await list(f, company, kind)).items).toEqual([]);
    }
    expect(JSON.stringify((await list(f, buyer, "purchases")).items)).not.toMatch(/document|pix|Empresa|summary|notes/);
  });

  it("queda antes da cobrança e repetição não perdem nem reapontam o comprador", async () => {
    const f = await fixture(), buyer = await f.contact(), other = await f.contact();
    const c = await f.conversation(buyer), session = await openSession(f.sctx, c, "choose_method", now());
    const input = { c, session, pkg, method: "pix" as const, sourceKey: uid() };
    vi.mocked(f.sctx.charge).mockRejectedValueOnce(new Error("queda"));
    await expect(buyPackage(f.sctx, input)).rejects.toThrow("queda");
    const saved = await one(env, "SELECT * FROM suporte_purchases WHERE source_key=?", input.sourceKey);
    expect((await links(f.profile)).find((r) => r.kind === "purchases")?.contact_id).toBe(buyer);
    identities.set(c.id, { ...identities.get(c.id)!, contactId: other });
    const retried = await buyPackage(f.sctx, input);
    expect(retried.id).toBe(saved.id);
    expect((await buyPackage(f.sctx, input)).id).toBe(saved.id);
    expect(await all(env, "SELECT id FROM suporte_purchases WHERE source_key=?", input.sourceKey)).toHaveLength(1);
    expect((await links(f.profile)).every((r) => r.contact_id === buyer)).toBe(true);
    const next = await openSession(f.sctx, c, "choose_method", now());
    expect((await links(f.profile)).find((r) => r.record_id === supportSessionKey(c.id, next.id))?.contact_id).toBe(other);
  });

  it("backfill usa somente a sessão histórica comprovada; legado sem prova fica pendente", async () => {
    const f = await fixture(), buyer = await f.contact(), other = await f.contact();
    const c = await f.conversation(buyer), session = await openSession(f.sctx, c, "choose_method", now());
    const purchase = await buyPackage(f.sctx, { c, session, pkg, method: "pix", sourceKey: uid() });
    // Representa origem existente ainda sem vínculo, não uma transferência.
    await exec(env, "DELETE FROM customer_records WHERE profile_id=? AND kind='purchases'", f.profile);
    identities.set(c.id, { ...identities.get(c.id)!, contactId: other });
    const result = await suporteCustomerProvider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(result.statements).toBe(6);
    expect((await links(f.profile)).find((r) => r.record_id === purchase.id)?.contact_id).toBe(buyer);
    const pendingConversation = await f.conversation(null);
    const pending = await openSession(f.sctx, pendingConversation, "ask_document", now());
    expect((await links(f.profile)).some((r) => r.record_id === supportSessionKey(pendingConversation.id, pending.id))).toBe(false);
    expect((await list(f, buyer, "sessions")).incomplete).toBe(true);
    const maintenance = await suporteCustomerProvider.maintain!(env, f.profile, { remainingItems: 1, remainingStatements: 6 });
    expect(maintenance.pending).toBe(true);
    expect(maintenance.statements).toBeLessThanOrEqual(6);
    expect((await links(f.profile)).filter((r) => r.kind === "purchases")).toHaveLength(1);
  });

  it("preenche vínculo humano legado anterior à sessão, mas nunca uma associação posterior", async () => {
    const f = await fixture(), person = await f.contact(), c = await f.conversation(null);
    await exec(env, "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Equipe','test','admin',?,?)",
      f.actor.id, `${f.actor.id}@example.test`, JSON.stringify([f.profile]), now());
    const at = now(), session = await openSession(f.sctx, c, "ask_document", at);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      c.id, f.profile, person, f.actor.id, at - 1);
    await suporteCustomerProvider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await links(f.profile)).find((r) => r.record_id === supportSessionKey(c.id, session.id)))
      .toMatchObject({ contact_id: person, linked_by: "backfill:legacy-human" });
    const old = await f.conversation(null), oldSession = await openSession(f.sctx, old, "ask_document", at);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      old.id, f.profile, person, f.actor.id, at + 1);
    await suporteCustomerProvider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await links(f.profile)).some((r) => r.record_id === supportSessionKey(old.id, oldSession.id))).toBe(false);
  });

  it("sessão e vínculo são atômicos se a referência não pertence à área", async () => {
    const f = await fixture(), foreign = await fixture(), c = await f.conversation(await foreign.contact());
    await expect(openSession(f.sctx, c, "ask_document", now())).rejects.toThrow();
    expect(await all(env, "SELECT id FROM suporte_sessions WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("recusa referências pendentes e aplicações, sem fallback por telefone", async () => {
    const f = await fixture(), c = await f.conversation(null);
    for (const state of ["ambiguous", "pending", "blocked", "excluded"] as const) {
      identities.set(c.id, { ...identities.get(c.id)!, state });
      expect(await supportCustomerStatements(f.sctx, c, "sessions", uid(), now(), "test")).toEqual([]);
    }
    expect(await supportCustomerStatements(f.sctx, { ...c, external_namespace: "app:test" }, "sessions", uid(), now(), "test")).toEqual([]);
  });

  it("módulos alternados preservam vínculos; cursor autenticado separa pessoa, área e coleção", async () => {
    const f = await fixture(), buyer = await f.contact(), other = await f.contact(), c = await f.conversation(buyer);
    const at = now();
    await openSession(f.sctx, c, "choose_method", at); await openSession(f.sctx, c, "choose_method", at);
    const first = await list(f, buyer, "sessions", { limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await suporteCustomerProvider.list!(f.sctx, f.actor, buyer, "sessions", { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.nextCursor).toBeNull();
    for (const [contact, kind, cursor] of [[other, "sessions", first.nextCursor], [buyer, "purchases", first.nextCursor], [buyer, "sessions", first.nextCursor + "x"]])
      await expect(suporteCustomerProvider.list!(f.sctx, f.actor, contact!, kind!, { limit: 1, cursor: cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    for (const enabled of [1, 0, 1]) {
      await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,'erp',?,?,'test') ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
        f.profile, enabled, now());
      expect((await list(f, buyer, "sessions")).items).toHaveLength(2);
    }
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='mensalidade'", f.profile);
    await expect(list(f, buyer, "sessions")).rejects.toMatchObject({ code: "module_disabled" });
    await exec(env, "UPDATE profile_modules SET enabled=1 WHERE profile_id=? AND module_id='mensalidade'", f.profile);
    expect((await list(f, buyer, "sessions")).items).toHaveLength(2);
    await expect(suporteCustomerProvider.list!(f.sctx, { ...f.actor, kind: "app", scopes: ["contacts:read", "conversations:read"] }, buyer, "sessions", { limit: 25 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(suporteCustomerProvider.list!(f.sctx, { ...f.actor, role: "operator", access: ["contacts"] }, buyer, "sessions", { limit: 25 })).rejects.toMatchObject({ code: "forbidden" });
    const foreign = await fixture();
    await expect(suporteCustomerProvider.list!(foreign.sctx, foreign.actor, buyer, "sessions", { limit: 25 })).rejects.toMatchObject({ code: "not_found" });
  });
});
