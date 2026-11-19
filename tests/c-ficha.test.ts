import { env as testEnv } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exec, withReadCache } from "../src/db";
import { ApiError, uid, type Actor, type Env } from "../src/types";
import { createProfilePort } from "../src/customer/profile";
import { customerProvider, registerCustomerProvider } from "../src/customer/ports";
import { customerProfileDeclarations } from "../src/customer/declarations";
import type { ContactProfileView, CustomerModuleProvider, SectionView } from "../src/customer/profile-contracts";
import { erpCustomerProvider } from "../src/modules/erp/customer-provider";
import * as bridge from "../src/customer/erp-bridge";
import * as identity from "../src/modules/erp/identity";
import { SimpleContactBody, ContactsPanel, ContactConflictReview } from "../web/ContactsPanel";
// O contrato de vocabulário não precisa avaliar o grafo de telas portadas no Worker.
// O formulário importa e reexporta esta mesma função; sua UI segue coberta pela suíte Node.
import { contactEditorTitle } from "../web/erp/contact-editor-labels";
import { installFullCustomerHost, loadFullCustomerHost } from "../web/contact-profile/host-port";
import { cancelContactJob, contactNamespace, contactVocabulary, contactWriter, jobBlocksEditing, jobMessage, mountProfileHost,
  profileMessage, profileMode, ProfileRequests, readContactConflicts, replaceSectionRole, resolveContactIdentity,
  sectionChanges, sectionWriter, synchronizationJob, watchContactJob, writeFeedback, type ProfileJob } from "../web/contact-profile/model";
import { cellText, targetHref } from "../web/contact-profile/registry";
import profileSource from "../web/contact-profile/ContactProfile.tsx?raw";

// O setup/Worker pode ter carregado as portas e registrado o ERP antes dos mocks.
// Limpe o cache ANTES dos imports da suíte: mockar local-fetch não desfaz um
// registro já executado. Todas as referências abaixo devem usar a mesma instância
// nova das portas, mantendo a implementação real e sua proteção contra duplicatas.
vi.hoisted(() => vi.resetModules());
vi.mock("../src/modules/runtime", () => ({}));
// A ponte importa esta costura, que registra o ERP real ao ser avaliada.
// Isole só o transporte/composição: a ficha, o provedor e as portas continuam reais.
vi.mock("../src/erp/api/local-fetch", () => ({ localFetch: vi.fn(() => {
  throw new Error("O teste da ficha não pode abrir o transporte ERP.");
}) }));
vi.mock("../src/service", () => ({ conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(), handoff: vi.fn(),
  handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn() }));
vi.mock("../web/app/AppContext", () => ({ useApp: () => ({ me: { id: "operator", access: ["contacts"] }, modules: {}, settings: {} }) }));

const env = testEnv as unknown as Env;
const port = createProfilePort();
const authorize = vi.fn<NonNullable<CustomerModuleProvider["authorizeProfile"]>>();
const list = vi.fn<NonNullable<CustomerModuleProvider["list"]>>();
const section = vi.fn<NonNullable<CustomerModuleProvider["section"]>>();
beforeAll(() => {
  expect(customerProvider("erp")).toBeNull();
  registerCustomerProvider("erp", { authorizeProfile: authorize, list });
  registerCustomerProvider("condominio", { list, section });
  registerCustomerProvider("ensino", { section });
});
beforeEach(() => {
  authorize.mockReset().mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue({ items: [], nextCursor: null, incomplete: false });
  section.mockReset().mockResolvedValue({ version: 1, writable: false, schema: "private.navigation.v1", data: { target: { module: "ensino", resource: "home", id: "ensino" } } });
  installFullCustomerHost(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); installFullCustomerHost(null); });

async function fixture(enabled: string[] = [], namespace = "team") {
  const profile = uid(), contactId = uid();
  const actor: Actor = { id: uid(), name: "Pessoa", kind: "user", role: "operator", profiles: [profile],
    scopes: [], bots: [], access: ["contacts"], sessionId: "session", rate: 100, runLimit: 1 };
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,'Ficha',1)", profile);
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,?,'Ana','ana','manual',?,?,1,1)`, contactId, profile, namespace, actor.id, actor.id);
  for (const module of enabled) await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,1,?)", profile, module, actor.id);
  return { env: withReadCache(env), profile, contactId, actor };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const signal = () => new AbortController().signal;
const job = (state: ProfileJob["state"]): ProfileJob => ({ id: "job/a", contactId: "contact", state, errorCode: null, missingFields: [], updated: 91 });

describe("F4/F5 — domínio e namespace da ficha", () => {
  it("isola a composição ERP e mantém a recusa a um segundo provedor", () => {
    const registered = customerProvider("erp");
    expect(registered).toEqual({ authorizeProfile: authorize, list });
    expect(() => registerCustomerProvider("erp", { list })).toThrow("Implementação de provedor erp já registrada.");
    expect(customerProvider("erp")).toBe(registered);
  });
  it("abre app para humano autorizado, simples, sem ERP, contribuições team ou consulta ao ERP", async () => {
    const f = await fixture(["erp", "condominio", "os"], "app:integration");
    await exec(env, "UPDATE contacts SET erp_contact_id='legacy-erp' WHERE id=?", f.contactId);
    const view = await port.view(f.env, { ...f.actor, access: ["contacts", "erp:admin", "condominio:admin"] }, f.profile, f.contactId);
    expect(view).toMatchObject({ namespace: "app:integration", depth: "simple", erpContactId: null, contributions: [], writable: true });
    expect(profileMode({ ...view, depth: "full", erpContactId: "stale" })).toBe("simple");
    expect(authorize).not.toHaveBeenCalled();
    await expect(port.collection(f.env, f.actor, f.profile, f.contactId, "erp", "sales", { limit: 25 })).rejects.toMatchObject({ status: 404 });
    expect(list).not.toHaveBeenCalled();
    expect(contactNamespace({ namespace: "app:integration" }, { external_namespace: "channel:other" })).toBe("app:integration");
    expect(contactNamespace(null, { external_namespace: "app:integration" })).toBe("app:integration");
    expect(profileSource).toContain('!view.namespace?.startsWith("app:") && <History');
  });
  it("recusa aplicações, credenciais, bots, outra área, restrição e papel de extensão para app", async () => {
    const f = await fixture(["erp"], "app:integration");
    for (const actor of [{ ...f.actor, kind: "app" }, { ...f.actor, via: "app" }, { ...f.actor, id: "bot:x" },
      { ...f.actor, module: "erp" }, { ...f.actor, credential: "credential" }, { ...f.actor, access: ["erp:admin"] }])
      await expect(port.view(f.env, actor as Actor, f.profile, f.contactId)).rejects.toMatchObject({ status: 403 });
    await expect(port.view(f.env, f.actor, "another-area", f.contactId)).rejects.toMatchObject({ status: 404 });
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.contactId);
    await expect(port.view(f.env, f.actor, f.profile, f.contactId)).rejects.toMatchObject({ status: 404 });
  });
  it("papel somente ERP abre o registro autorizado sem notas locais, e consulta não vira escrita", async () => {
    const f = await fixture(["erp"]);
    await exec(env, "UPDATE contacts SET erp_contact_id='erp-contact' WHERE id=?", f.contactId);
    const seller = { ...f.actor, access: ["erp:vendas"] };
    const view = await port.view(f.env, seller, f.profile, f.contactId);
    expect(view).toMatchObject({ depth: "full", readable: false, writable: true, localWritable: false });
    expect(view.contributions.map(item => item.id)).toEqual(["sales"]);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ profile: f.profile }), seller, f.contactId);
    expect(await port.view(f.env, { ...f.actor, access: ["contacts", "erp:consulta"] }, f.profile, f.contactId))
      .toMatchObject({ depth: "full", writable: false, localWritable: true });
  });
  it("carteira recusada não abre ERP, mas mantém ficha local de quem tem Contatos", async () => {
    const f = await fixture(["erp"]);
    await exec(env, "UPDATE contacts SET erp_contact_id='erp-contact' WHERE id=?", f.contactId);
    authorize.mockRejectedValue(new ApiError(403, "forbidden", "Fora da carteira"));
    await expect(port.view(f.env, { ...f.actor, access: ["erp:vendas"] }, f.profile, f.contactId)).rejects.toMatchObject({ status: 403 });
    expect(await port.view(f.env, { ...f.actor, access: ["contacts", "erp:vendas"] }, f.profile, f.contactId))
      .toMatchObject({ depth: "simple", writable: true, contributions: [] });
  });
  it("papel da extensão já abria só suas contribuições; não projeta dados locais ou ID ERP", async () => {
    const f = await fixture(["ensino", "os"]);
    await exec(env, "UPDATE contacts SET erp_contact_id='private-erp-id' WHERE id=?", f.contactId);
    const actor = { ...f.actor, access: ["ensino:secretaria"] };
    const view = await port.view(f.env, actor, f.profile, f.contactId);
    expect(view).toMatchObject({ depth: "simple", readable: false, writable: false, erpContactId: null });
    expect(view.contributions.map(item => item.moduleId)).toEqual(["ensino"]);
    expect(await port.section(f.env, actor, f.profile, f.contactId, "ensino", "private")).toMatchObject({ writable: false });
    await expect(port.view(f.env, { ...f.actor, access: [] }, f.profile, f.contactId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("F6/P14 — resultado confirmado e solicitações existentes", () => {
  it.each(["pending", "running", "conflict", "paused", "failed", "cancelled", "retained"] as const)("PATCH %s não anuncia sucesso", state => {
    const result = writeFeedback({ id: "contact", pending: false, result: { ...job(state), jobId: "job/a", pending: state === "pending" } });
    expect(result).toMatchObject({ jobId: "job/a", completed: false });
    expect(result.message).not.toMatch(/salv[oa]|sincronizad[oa]|concluíd/i);
  });
  it("conclusão exige done e ausência de pending; detalhe inicial acompanha a intenção existente", () => {
    expect(writeFeedback({ result: { jobId: "x", state: "done", pending: false } }).completed).toBe(true);
    expect(writeFeedback({ result: { jobId: "x", state: "done", pending: true } }).completed).toBe(false);
    expect(writeFeedback({ result: {} }).completed).toBe(false);
    expect(synchronizationJob({ synchronization: { jobId: "already-pending", state: "paused" } })).toBe("already-pending");
    expect(synchronizationJob({ synchronization: { jobId: "done", state: "done" } })).toBeNull();
    expect(jobMessage({ ...job("paused"), errorCode: "contact_required", missingFields: ["postal_code", "person_type", "phones"] }))
      .toContain("Campos pendentes: CEP, Tipo de pessoa, Telefones.");
    expect(jobMessage({ ...job("paused"), reason: "Falta comprovação do canal." })).toContain("Falta comprovação do canal.");
    expect(jobBlocksEditing(job("failed"))).toBe(true);
    expect(jobBlocksEditing(job("cancelled"))).toBe(false);
  });
  it("acompanha pending → done e reler a ficha após promoção altera o modo", async () => {
    const f = await fixture(["erp"]), actor = { ...f.actor, access: ["contacts", "erp:vendas"] };
    expect(profileMode(await port.view(f.env, actor, f.profile, f.contactId))).toBe("simple");
    await exec(env, "UPDATE contacts SET erp_contact_id='promoted' WHERE id=?", f.contactId);
    expect(profileMode(await port.view(f.env, actor, f.profile, f.contactId))).toBe("full");
    vi.useFakeTimers();
    const api = vi.fn().mockResolvedValueOnce(job("pending")).mockResolvedValueOnce(job("done")), changed = vi.fn();
    const stop = watchContactJob(api, "root", "job/a", signal(), changed, vi.fn());
    await vi.advanceTimersByTimeAsync(1500);
    expect(changed.mock.calls.map(([value]) => value.state)).toEqual(["pending", "done"]);
    await vi.advanceTimersByTimeAsync(6000); expect(api).toHaveBeenCalledTimes(2); stop();
    // A conclusão do componente invalida tanto o detalhe quanto /profile.
    const completion = profileSource.slice(profileSource.indexOf("finishedJobs.current.add(jobId)"), profileSource.indexOf("!demo && profile.loading"));
    expect(completion).toContain("setContactRevision(n => n + 1)");
    expect(completion).toContain("setRevision(n => n + 1)");
  });
  it.each(["paused", "conflict", "failed", "cancelled"] as const)("%s para polling automático e preserva o motivo", async state => {
    vi.useFakeTimers();
    const api = vi.fn().mockResolvedValue({ ...job(state), reason: "Revisão necessária" }), changed = vi.fn();
    const stop = watchContactJob(api, "root", "x", signal(), changed, vi.fn());
    await vi.advanceTimersByTimeAsync(9000);
    expect(api).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith(expect.objectContaining({ state, reason: "Revisão necessária" })); stop();
  });
  it("descarta resposta atrasada de job e leituras de pessoa anterior, mesmo sem suporte a abort", async () => {
    const pending = deferred<ProfileJob>(), changed = vi.fn(), failure = vi.fn(), controller = new AbortController();
    const stop = watchContactJob(vi.fn(() => pending.promise), "root", "old", controller.signal, changed, failure);
    controller.abort(); pending.resolve(job("done")); await pending.promise; await Promise.resolve(); stop();
    expect(changed).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
    const requests = new ProfileRequests(), old = requests.begin("detail"), current = requests.begin("detail");
    expect(old.current()).toBe(false); expect(current.current()).toBe(true);
    requests.dispose(); expect(current.current()).toBe(false);
  });
});

describe("F7 — operações exatas do Condomínio", () => {
  const membership = { id: "m", personId: "p", unitId: "u", role: "proprietario", startsAt: 1, endsAt: null, notices: true, label: "Proprietário", active: true };
  const func = { id: "f", personId: "p", unitId: null, role: "sindico", startsAt: 1, endsAt: null, version: "3", label: "Síndico" };
  const initial: SectionView = { version: 5, schema: "condominio.units.v1", writable: true,
    data: { people: [{ id: "p" }], memberships: [membership], functions: [func], subscriptions: [{ unitId: "u", subscriptionId: "s", linked: true }] } };
  it("envia somente diferenças aceitas, versão numérica da função e nenhuma relação oculta", async () => {
    const api = vi.fn().mockResolvedValue({ ...initial, version: 6 }), write = sectionWriter(api, "section");
    await write(initial, { memberships: [{ ...membership, notices: false }], functions: [{ ...func, endsAt: 2, version: 999 }] }, signal());
    expect(api.mock.calls[0][2]).toEqual({ commandId: expect.any(String), expectedVersion: 5, data: {
      memberships: [{ id: "m", personId: "p", unitId: "u", role: "proprietario", startsAt: 1, endsAt: null, notices: false }],
      functions: [{ id: "f", personId: "p", unitId: null, role: "sindico", startsAt: 1, endsAt: 2, expectedVersion: 3 }], subscriptions: [],
    } });
    expect(sectionChanges(initial, { ...initial.data as object, memberships: [{ ...membership, label: "Outra descrição" }] } as any))
      .toEqual({ memberships: [], functions: [], subscriptions: [] });
    expect(sectionChanges(initial, { subscriptions: [{ unitId: "u", subscriptionId: "s", linked: false, label: "Ignorar rótulo" }] }))
      .toEqual({ memberships: [], functions: [], subscriptions: [{ unitId: "u", subscriptionId: "s", linked: false }] });
  });
  it("troca de papel encerra e cria; nunca reaponta o vínculo existente", () => {
    const next = replaceSectionRole(initial.data, "memberships", "m", "inquilino", 10, "new");
    expect(sectionChanges(initial, next)).toEqual({ memberships: [
      { id: "m", personId: "p", unitId: "u", role: "proprietario", startsAt: 1, endsAt: 10, notices: true },
      { id: "new", personId: "p", unitId: "u", role: "inquilino", startsAt: 10, endsAt: null, notices: true },
    ], functions: [], subscriptions: [] });
    for (const change of [{ role: "inquilino" }, { unitId: "elsewhere" }, { personId: "other" }, { startsAt: 2 }])
      expect(() => sectionChanges(initial, { memberships: [{ ...membership, ...change }] })).toThrow(/Encerre/);
    const functions = sectionChanges(initial, replaceSectionRole(initial.data, "functions", "f", "zelador", 10, "new-f")) as any;
    expect(functions.functions.map((row: any) => row.expectedVersion)).toEqual([3, 0]);
  });
});

describe("F8 — revisão e cancelamento versionados", () => {
  it("pagina revisão e envia escolha, namespace, versão e motivo sem operação de histórico", async () => {
    const api = vi.fn().mockResolvedValue({ state: "pending", reason: "awaiting_proof" }), sig = signal();
    await readContactConflicts(api, "root", "next&cursor", sig);
    expect(api).toHaveBeenLastCalledWith("root/contact-conflicts?limit=25&cursor=next%26cursor", "GET", undefined, sig);
    const conflict = { kind: "identity" as const, namespace: "app:one", phone: "5511999990000", version: 7, candidates: [{ id: "a", name: "Ana", phone: "5511999990000" }] };
    await resolveContactIdentity(api, "root", conflict, "a", "  Cadastro conferido  ", sig, "resolve-key");
    expect(api).toHaveBeenLastCalledWith("root/contact-identities/resolve", "POST", { namespace: "app:one", phone: conflict.phone,
      expectedVersion: 7, contactId: "a", reason: "Cadastro conferido" }, sig, "resolve-key");
    expect(api.mock.calls.some(([path]) => path.includes("history") || path.includes("conversations"))).toBe(false);
    const html = renderToStaticMarkup(React.createElement(ContactConflictReview, { api, root: "root" }));
    expect(html).toContain("não transfere histórico"); expect(html).toContain("Sem prova do canal");
  });
  it("cancelamento usa marcador atualizado e versão; uma nova edição ganha outra chave", async () => {
    const api = vi.fn().mockResolvedValue(job("cancelled")), sig = signal();
    const oldWrite = contactWriter(api), body = { name: "Ana", expected_version: 4 };
    await oldWrite("root/contacts/a", "PATCH", body, sig);
    const oldKey = api.mock.calls.at(-1)![4];
    await oldWrite("root/contacts/a", "PATCH", body, sig); expect(api.mock.calls.at(-1)![4]).toBe(oldKey);
    await cancelContactJob(api, "root", job("conflict"), 4, "  Corrigir cadastro  ", sig, "cancel-key");
    expect(api).toHaveBeenLastCalledWith("root/contact-jobs/job%2Fa/cancel", "POST", { expectedUpdated: 91, expectedVersion: 4, reason: "Corrigir cadastro" }, sig, "cancel-key");
    await contactWriter(api)("root/contacts/a", "PATCH", body, sig);
    expect(api.mock.calls.at(-1)![4]).not.toBe(oldKey);
    expect(() => cancelContactJob(api, "root", { ...job("conflict"), updated: undefined }, 4, "Motivo", sig, "cancel-key")).toThrow(/Recarregue/);
  });
});

describe("F9/F10/F11 — destinos, colunas e moeda", () => {
  it.each([["sales_orders", "documentos-empresa?tipo=sales_orders&documento="], ["titles", "financeiro-empresa?area=receivable&titulo="],
    ["contact_ledger", "financeiro-empresa?area=ficha&contato="]])("destino ERP %s escapa ID", (resource, path) => {
    expect(targetHref({ module: "erp", resource, id: "id/ &?é" })).toBe("/app/erp/" + path + encodeURIComponent("id/ &?é"));
  });
  it("colunas comuns e adicionais do Condomínio preservam ausências e centavos", async () => {
    const f = await fixture(["condominio", "os", "mensalidade"]), actor = { ...f.actor, access: ["condominio:admin", "mensalidade"] };
    list.mockResolvedValue({ items: [{ id: "delivery", cells: { unit: "101", block: "A", createdAt: 100, privateNote: "ocultar" },
      target: { module: "condominio", resource: "works", id: "delivery" } }], nextCursor: null, incomplete: false });
    const page = await port.collection(f.env, actor, f.profile, f.contactId, "condominio", "deliveries", { limit: 25 });
    expect(page.items[0].cells).toEqual({ id: "delivery", status: null, occurredAt: 100, unit: "101", block: "A" });
    list.mockResolvedValue({ items: [{ id: "due", cells: { id: "due", status: "open", occurredAt: 100, dueDate: "2026-11-19", amountCents: 12345 },
      target: { module: "mensalidade", resource: "installments", id: "due" } }], nextCursor: null, incomplete: false });
    const dues = await port.collection(f.env, actor, f.profile, f.contactId, "condominio", "dues", { limit: 25 });
    expect(dues.items[0].cells.amountCents).toBe(12345);
    expect(cellText(dues.items[0].cells.amountCents, "moneyCents")).toBe("R$ 123,45");
    expect(cellText(undefined, "moneyCents")).toBe("—"); expect(cellText(null, "money")).toBe("—");
    expect(cellText(0, "moneyCents")).toBe("R$ 0,00");
    expect(cellText("2026-11-19", "date")).toBe("19/11/2026");
  });
  it("provedor ERP conserva referência, data, situação e total decimal com a autorização do registro", async () => {
    const f = await fixture(["erp"]), seller = { ...f.actor, access: ["erp:vendas"] };
    await exec(env, "UPDATE contacts SET erp_contact_id='erp-contact' WHERE id=?", f.contactId);
    vi.spyOn(identity, "erpIdentity").mockResolvedValue({ actor: { user_id: seller.id, erp_role: "vendas" } } as any);
    const rpc = vi.spyOn(bridge, "customerRpc").mockImplementation(async (_env, _profile, _actor, _identity, name) => name === "erp_catalog_contact_get"
      ? { id: "erp-contact" } : { items: [{ id: "sale", number: "42", date: "2026-11-19", status: "confirmed", total: "9007199254740993.17" }] });
    const ctx = { env: f.env, profile: f.profile } as any;
    await erpCustomerProvider.authorizeProfile!(ctx, seller, f.contactId);
    const page = await erpCustomerProvider.list!(ctx, seller, f.contactId, "sales", { limit: 25 });
    expect(page.items[0]).toEqual({ id: "sale", cells: { id: "42", status: "confirmed", occurredAt: "2026-11-19", total: "9007199254740993.17" },
      target: { module: "erp", resource: "sales_orders", id: "sale" } });
    expect(cellText(page.items[0].cells.total, "money")).toBe("R$ 9.007.199.254.740.993,17");
    expect(cellText(page.items[0].cells.occurredAt, "date")).toBe("19/11/2026");
    expect(cellText("partially_fulfilled", "status")).toBe("Atendido parcialmente");
    expect(customerProfileDeclarations.erp.contributions.find(item => item.id === "sales")?.columns?.map(column => column.key))
      .toEqual(["id", "status", "occurredAt", "total"]);
    expect(rpc.mock.calls.map(call => call[4])).toEqual(["erp_catalog_contact_get", "erp_catalog_contact_get", "erp_catalog_contact_history"]);
    rpc.mockRejectedValue(new ApiError(403, "forbidden", "Fora da carteira"));
    await expect(erpCustomerProvider.authorizeProfile!(ctx, seller, f.contactId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("F12 e hospedeiro — vocabulário e ciclo de vida", () => {
  it("explica a criação automática de contatos e a complementação posterior na ficha", () => {
    const html = renderToStaticMarkup(React.createElement(ContactsPanel, {
      api: vi.fn(), root: "root", demo: true, openConversation: vi.fn(),
    }));
    expect(html).toContain("Todo número que envia uma mensagem vira contato automaticamente.");
    expect(html).toContain("O nome e os demais dados podem ser completados depois na ficha.");
    expect(html).not.toContain("Salvar a partir de uma conversa");
    expect(html).not.toContain("clique em");
  });
  it.each([{ singular: "Paciente", plural: "Pacientes" }, { singular: "Aluno", plural: "Alunos" }])("usa $singular na lista, corpo e contrato do hospedeiro", async vocabulary => {
    const api = vi.fn(), close = vi.fn(), saved = vi.fn();
    const listHtml = renderToStaticMarkup(React.createElement(ContactsPanel, { api, root: "root", demo: true, openConversation: vi.fn(), vocabulary }));
    const body = renderToStaticMarkup(React.createElement(SimpleContactBody, { api, root: "root", demo: true, close, saved, vocabulary }));
    expect(listHtml).toContain(vocabulary.plural); expect(body).toContain(`Salvar ${vocabulary.singular.toLowerCase()}`);
    expect(contactEditorTitle(vocabulary)).toBe(`${vocabulary.singular} ou Fornecedor`);
    expect(contactEditorTitle(vocabulary, ["supplier"])).toBe("Fornecedor");
    expect(contactVocabulary(vocabulary, true).plural).toBe("Fornecedores");
    const view: ContactProfileView = { profileId: "area", contactId: "d1", erpContactId: "erp", depth: "full", writable: true, vocabulary, contributions: [] };
    const mount = vi.fn().mockResolvedValue({ dispose: vi.fn() }), controller = new AbortController();
    await mountProfileHost({} as HTMLElement, view, { profileId: "area", contactId: "d1", erpContactId: "erp", vocabulary, onSaved: saved, onClose: close }, controller.signal, async () => ({ mount }));
    expect(mount.mock.calls[0][1].vocabulary).toEqual(vocabulary); controller.abort();
  });
  it("somente consulta esconde ações; ausência do hospedeiro continua explícita", async () => {
    const html = renderToStaticMarkup(React.createElement(SimpleContactBody, { api: vi.fn(), root: "root", demo: false, embedded: true,
      writable: false, contact: { id: "app", namespace: "app:one" }, conversation: { id: "conversation" }, close: vi.fn(), saved: vi.fn() }));
    expect(html).toContain("Somente consulta"); expect(html).not.toContain('type="submit"'); expect(html).not.toContain("Desvincular desta conversa");
    const error = await loadFullCustomerHost().catch(failure => failure);
    expect(error.code).toBe("dependency_unavailable"); expect(profileMessage(error)).toMatch(/hospedeiro.*não está instalado/i);
  });
});
