import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactContribution, ContactProfileView, SectionView } from "../src/customer/profile-contracts";
import type { Api } from "../web/lib/api";
import { bindErpContact, contactsQuery, mountProfileHost, profileMode, profileScopeKey, ProfileRequests, sectionWriter } from "../web/contact-profile/model";
import { installFullCustomerHost, type FullCustomerHost } from "../web/contact-profile/host-port";
import { privateTarget, registeredComponent, targetHref } from "../web/contact-profile/registry";

const view = (extra: Partial<ContactProfileView> = {}): ContactProfileView => ({ profileId: "area", contactId: "d1-contact", erpContactId: null,
  depth: "simple", writable: true, vocabulary: { singular: "Cliente", plural: "Clientes" }, contributions: [], ...extra });
const full = () => view({ depth: "full", erpContactId: "different-erp-id" });
const input = () => ({ profileId: "area", contactId: "d1-contact", erpContactId: "different-erp-id", onSaved: vi.fn(), onClose: vi.fn() });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => installFullCustomerHost(null));

describe("ficha simples e hospedeiro completo", () => {
  it("simples, vínculo sem autorização e completo sem vínculo nunca carregam o hospedeiro", async () => {
    const loader = vi.fn(), element = {} as HTMLElement;
    for (const value of [view(), view({ erpContactId: "different-erp-id" }), view({ depth: "full" })]) {
      expect(profileMode(value)).toBe("simple");
      await expect(mountProfileHost(element, value, input(), new AbortController().signal, loader)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(loader).not.toHaveBeenCalled();
  });
  it("valida área e ambos os IDs antes de carregar, inclusive para consulta", async () => {
    const loader = vi.fn(async () => ({ mount: vi.fn(async () => ({ dispose: vi.fn() })) }));
    for (const wrong of [{ profileId: "other" }, { contactId: "erp-id" }, { erpContactId: "d1-contact" }])
      await expect(mountProfileHost({} as HTMLElement, full(), { ...input(), ...wrong }, new AbortController().signal, loader))
        .rejects.toMatchObject({ code: "forbidden" });
    expect(loader).not.toHaveBeenCalled();
    const readOnly = full(); readOnly.writable = false;
    await mountProfileHost({} as HTMLElement, readOnly, input(), new AbortController().signal, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("ausência de A7 mostra dependency_unavailable sem fallback a outro editor", async () => {
    await expect(mountProfileHost({} as HTMLElement, full(), input(), new AbortController().signal))
      .rejects.toMatchObject({ code: "dependency_unavailable" });
  });
  it("carregamento atrasado após troca de área não monta o editor", async () => {
    const loading = deferred<FullCustomerHost>(), mount = vi.fn<FullCustomerHost["mount"]>();
    const controller = new AbortController();
    const promise = mountProfileHost({} as HTMLElement, full(), input(), controller.signal, () => loading.promise);
    controller.abort(); loading.resolve({ mount });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(mount).not.toHaveBeenCalled();
  });
  it("mount atrasado é descartado e seus callbacks não atingem a próxima pessoa", async () => {
    const mounting = deferred<{ dispose(): void }>(), dispose = vi.fn(), callbacks = input();
    const mount = vi.fn<FullCustomerHost["mount"]>(() => mounting.promise), controller = new AbortController();
    const promise = mountProfileHost({} as HTMLElement, full(), callbacks, controller.signal, async () => ({ mount }));
    await Promise.resolve();
    controller.abort();
    const supplied = mount.mock.calls[0][1];
    supplied.onSaved(); supplied.onClose();
    mounting.resolve({ dispose });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledTimes(1); expect(callbacks.onSaved).not.toHaveBeenCalled(); expect(callbacks.onClose).not.toHaveBeenCalled();
  });
  it("hospedeiro simulado usa o contexto recebido e descarte é idempotente", async () => {
    const dispose = vi.fn(), callbacks = input(), controller = new AbortController();
    const mount = vi.fn<FullCustomerHost["mount"]>(async () => ({ dispose })), loader = vi.fn(async () => ({ mount }));
    installFullCustomerHost(loader);
    const element = {} as HTMLElement;
    const mounted = await mountProfileHost(element, full(), callbacks, controller.signal);
    expect(mount).toHaveBeenCalledWith(element, expect.objectContaining({ profileId: "area", contactId: "d1-contact", erpContactId: "different-erp-id" }));
    const supplied = mount.mock.calls[0][1]; supplied.onSaved();
    expect(callbacks.onSaved).toHaveBeenCalledTimes(1);
    controller.abort(); mounted.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    supplied.onSaved(); expect(callbacks.onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("leituras e formulários independentes", () => {
  it("respostas fora de ordem e transportes que ignoram abort não sobrescrevem o contato atual", async () => {
    const requests = new ProfileRequests(), first = deferred<string>(), second = deferred<string>();
    let visible = "";
    const old = requests.begin("contact"), oldRead = first.promise.then(value => { if (old.current()) visible = value; });
    const current = requests.begin("contact"), newRead = second.promise.then(value => { if (current.current()) visible = value; });
    second.resolve("novo"); await newRead;
    first.resolve("antigo"); await oldRead;
    expect(visible).toBe("novo"); expect(old.signal.aborted).toBe(true);
    requests.dispose(); expect(current.current()).toBe(false);
    expect(requests.begin("late").signal.aborted).toBe(true);
  });
  it("falha em uma lista não cancela histórico, outra lista ou edição", async () => {
    const requests = new ProfileRequests();
    const failed = requests.begin("orders"), history = requests.begin("history"), appointments = requests.begin("appointments"), form = requests.begin("section-save");
    const results = await Promise.allSettled([Promise.reject(new Error("falha isolada")), Promise.resolve("histórico"), Promise.resolve("agenda")]);
    requests.cancel("orders");
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(failed.current()).toBe(false);
    expect([history.current(), appointments.current(), form.current()]).toEqual([true, true, true]);
    requests.dispose(); expect([history.signal.aborted, appointments.signal.aborted, form.signal.aborted]).toEqual([true, true, true]);
  });
  it("sessão, pessoa, área e módulos invalidam o escopo; ordem do catálogo não", () => {
    const person = { id: "person", sessionId: "session", role: "operator", access: ["contacts"] };
    const key = profileScopeKey("v1/profiles/area", person, { erp: true, agenda: true });
    expect(profileScopeKey("v1/profiles/area", person, { agenda: true, erp: true })).toBe(key);
    for (const next of [
      profileScopeKey("v1/profiles/other", person, { erp: true, agenda: true }),
      profileScopeKey("v1/profiles/area", { ...person, id: "other" }, { erp: true, agenda: true }),
      profileScopeKey("v1/profiles/area", { ...person, sessionId: "new" }, { erp: true, agenda: true }),
      profileScopeKey("v1/profiles/area", person, { erp: false, agenda: true }),
      profileScopeKey("v1/profiles/area", { ...person, access: [] }, { erp: true, agenda: true }),
    ]) expect(next).not.toBe(key);
  });
  it("versões e comandos de duas seções não se misturam com o cadastro", async () => {
    const pendingA = deferred<SectionView>(), pendingB = deferred<SectionView>();
    const api = vi.fn((path: string) => path.endsWith("/units") ? pendingA.promise : pendingB.promise) as unknown as Api;
    const a = sectionWriter(api, "contacts/d1/modules/condominio/sections/units"), b = sectionWriter(api, "contacts/second/modules/condominio/sections/units-b");
    const section: SectionView = { version: 7, writable: true, schema: "condominio.units.v1", data: { units: [] } };
    const signal = new AbortController().signal, draft = { units: [{ unitId: "u", role: "morador" }] };
    const saveA = a(section, draft, signal), saveB = b({ ...section, version: 2 }, { units: [] }, signal);
    const calls = vi.mocked(api).mock.calls;
    expect(calls[0][2]).toMatchObject({ expectedVersion: 7, data: draft });
    expect(calls[1][2]).toMatchObject({ expectedVersion: 2, data: { units: [] } });
    expect(calls[0][4]).not.toBe(calls[1][4]);
    pendingB.resolve({ ...section, version: 3 }); expect((await saveB).version).toBe(3);
    pendingA.resolve({ ...section, version: 8, data: draft }); expect((await saveA).version).toBe(8);
    expect(section.version).toBe(7); expect(section.data).toEqual({ units: [] });
    expect(calls.every(call => call[1] === "PUT" && call[0].includes("/sections/"))).toBe(true);
  });
  it("timeout repete a intenção intacta; uma alteração posterior recebe outro comando", async () => {
    const section: SectionView = { version: 3, schema: "condominio.units.v1", writable: true, data: {} };
    const api = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ ...section, version: 4 });
    const write = sectionWriter(api, "section"), signal = new AbortController().signal;
    await expect(write(section, { role: "sindico" }, signal)).rejects.toThrow("timeout");
    await write(section, { role: "sindico" }, signal);
    expect(api.mock.calls[0]).toEqual(api.mock.calls[1]);
    await write({ ...section, version: 4 }, { role: "morador" }, signal);
    expect(api.mock.calls[2][4]).not.toBe(api.mock.calls[1][4]);
  });
});

describe("entradas, filtro e registro estático", () => {
  it("lista envia identified por padrão e revisão seleciona somente telefônicos", () => {
    expect(new URLSearchParams(contactsQuery({})).get("identity")).toBe("identified");
    expect(new URLSearchParams(contactsQuery({ identity: "phone_only" })).get("identity")).toBe("phone_only");
    expect(new URLSearchParams(contactsQuery({ identity: "all" })).get("identity")).toBe("all");
    const review = new URLSearchParams(contactsQuery({ identity: "all", review: true, search: "João & Ana" }));
    expect(review.get("identity")).toBe("phone_only"); expect(review.get("review")).toBe("inactive180"); expect(review.get("q")).toBe("João & Ana");
  });
  it("entrada ERP usa a associação, preserva a chave e nunca deduz ou promove", async () => {
    const api = vi.fn(async () => ({ contactId: "canonical-d1-id", version: 1, state: "done", pending: false, jobId: null }));
    const signal = new AbortController().signal;
    expect(await bindErpContact(api, "v1/profiles/area", "different-erp-id", signal, "stable-command"))
      .toMatchObject({ contactId: "canonical-d1-id", jobId: null });
    expect(api).toHaveBeenCalledExactlyOnceWith("v1/profiles/area/contacts/from-erp", "POST", { erpId: "different-erp-id" }, signal, "stable-command");
    api.mockResolvedValueOnce({ erpId: "different-erp-id" } as never);
    await expect(bindErpContact(api, "v1/profiles/area", "different-erp-id", signal, "stable-command")).rejects.toThrow(/vínculo/);
  });
  it("somente componentes compilados e destinos locais são aceitos", () => {
    const contribution: ContactContribution = { id: "appointments", kind: "collection", component: "table", title: "Agenda", source: "agenda.appointments", policy: "module" };
    expect(registeredComponent(contribution)).toEqual({ kind: "collection" });
    for (const component of ["https://example.com/editor", "../erp/app/components/ContactEditor", "__proto__", "constructor"])
      expect(registeredComponent({ ...contribution, component } as ContactContribution)).toBeNull();
    expect(registeredComponent({ ...contribution, kind: "section" })).toBeNull();
    expect(targetHref({ module: "javascript:alert(1)", resource: "x", id: "x" })).toBeNull();
    expect(privateTarget({ target: { module: "erp", resource: "ledger", id: "x" } })).toBeNull();
    expect(targetHref({ module: "erp", resource: "ledger", id: "x&admin=1" })).toBe("/app/erp/financeiro-empresa?area=ficha&contato=x%26admin%3D1");
  });
});
