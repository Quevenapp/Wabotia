import React from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router-dom";
import type { ErpHostContext, Disposable } from "../web/management/host-contract";
import type { AppState } from "../web/app/AppContext";
import { nativePageSlugs } from "../web/management/routes";

// Implementações reais da casca, políticas, rotas, ponte, porta da fase 1 e
// controlador. Somente as bordas DOM, página Agenda e transporte são controladas.
// Não é prova de foco/layout nem substitui a entrega da UI da fase 1.
const surface = vi.hoisted(() => ({ app: {} as AppState, portedLoads: 0, nativeLoads: 0, roots: [] as any[] }));
vi.mock("../web/app/AppContext", () => ({
  useApp: () => surface.app,
  ManagementRequestBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../web/modules/agenda/AgendaPage", () => {
  surface.nativeLoads++;
  return { AgendaPage: () => React.createElement("p", null, "Agenda autorizada") };
});
vi.mock("../web/erp/fetch-port", async original => ({
  ...await original<typeof import("../web/erp/fetch-port")>(), erpSimulated: () => false,
}));
vi.mock("react-dom/client", () => ({ createRoot: () => {
  const root = { render: vi.fn(), unmount: vi.fn() }; surface.roots.push(root); return root;
} }));

const actor = "00000000-0000-4000-8000-000000000001";
const otherActor = "00000000-0000-4000-8000-000000000002";
const contactTarget = "/cadastros-reais?cadastro=contacts";
const record = { id: "erp-42", entity: "contacts", name: "Cliente", version: 1 };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const cleanups: Disposable[] = [];
const own = <T extends Disposable>(value: T): T => { cleanups.push(value); return value; };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function browser(initial: string) {
  const events = new EventTarget();
  const entries = [{ url: initial, state: null as any }];
  let position = 0;
  const locate = () => vi.stubGlobal("location", new URL(entries[position].url, "https://panel.test"));
  const history = {
    get state() { return entries[position].state; },
    get length() { return entries.length; },
    pushState: vi.fn((state: unknown, _: string, url: string) => {
      entries.splice(++position, entries.length, { state, url }); locate();
    }),
    replaceState: vi.fn((state: unknown, _: string, url: string) => { entries[position] = { state, url }; locate(); }),
    go: (delta: number) => queueMicrotask(() => {
      const next = position + delta;
      if (next < 0 || next >= entries.length || next === position) return;
      position = next; locate(); events.dispatchEvent(new Event("popstate"));
    }),
  };
  Object.assign(events, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("window", events); vi.stubGlobal("history", history); locate();
  return { history, entries, position: () => position };
}
class Scope {
  className = ""; removed = false; children: Scope[] = [];
  ownerDocument = { createElement: () => new Scope() };
  querySelectorAll() { return []; }
  addEventListener() {} removeEventListener() {}
  appendChild(child: Scope) { this.children.push(child); }
  remove() { this.removed = true; }
}
let routes: typeof import("../web/lib/routes");
let registry: typeof import("../web/management/registry");
let area: typeof import("../web/erp/ErpArea");
let web: ReturnType<typeof browser>;
let fetcher: ReturnType<typeof vi.fn>;
const parse = (to: string) => { const url = new URL(to, location.origin); return routes.parseRoute(url.pathname, url.search, url.hash); };
const context = (modules: Record<string, boolean> = {}, role = "admin", access: string[] | null = null) => registry.managementContext({ statusLoaded: true, modules, role, access });
const host = (changes: Partial<ErpHostContext> = {}): ErpHostContext => ({
  profile: "area-a", actor, demo: false, management: context({ erp: true }),
  onModules: vi.fn(), onPeople: vi.fn(), onLeave: vi.fn(), onExpired: vi.fn(), ...changes,
});
function app(modules = {}, role = "admin", access: string[] | null = null) {
  surface.app = { profile: "area-a", root: "v1/profiles/area-a", identityKey: "a", contextGeneration: 1,
    statusLoaded: true, modules, settings: {}, status: {}, me: { id: actor, role, access }, isAdmin: role === "admin", demo: false,
    api: vi.fn(async () => ({})), onEvents: () => () => {}, refresh: vi.fn(async () => {}), reloadSession: vi.fn(async () => {}),
  } as unknown as AppState;
}
async function markup() {
  const stream = await renderToReadableStream(React.createElement("div", null, React.createElement(area.ErpArea)));
  const result = new Response(stream).text(); await stream.allReady; return result;
}
beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../web/erp/mount", async original => {
    surface.portedLoads++;
    return await original<typeof import("../web/erp/mount")>();
  });
  surface.portedLoads = 0; surface.nativeLoads = 0; surface.roots.length = 0;
  web = browser("/app/erp");
  fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    if (url.endsWith("/v1/me")) return Response.json({ user_id: actor, role: "admin", resources: ["contacts", "products"], data_mode: "staging_readonly" });
    if (url.endsWith("/v1/cadastros")) return Response.json({ read: ["contacts"], write: ["contacts"], data_mode: "erp_native" });
    if (url.endsWith("/v1/cadastros/contatos/erp-42")) return Response.json({ record });
    throw new Error("Leitura inesperada: " + url);
  });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("Element", Scope);
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  routes = await import("../web/lib/routes"); registry = await import("../web/management/registry");
  area = await import("../web/erp/ErpArea"); app();
});
afterEach(() => { cleanups.splice(0).reverse().forEach(value => value.dispose()); routes.setNavigationGuard(null); vi.unstubAllGlobals(); });

describe("casa integrada: entrada e isolamento", () => {
  it("administrador vazio, status pendente/falho, só Agenda sem ERP e vários módulos não carregam o portado", async () => {
    expect(registry.canEnterManagement(context())).toBe(true);
    expect(await markup()).toContain("Abrir Módulos");
    surface.app.statusLoaded = false;
    expect(await markup()).toContain("Abrindo a gestão");
    surface.app.statusError = "Status indisponível";
    expect(await markup()).toContain("Tentar novamente");
    app({ agenda: true }, "agent", ["agenda"]);
    const c = context({ agenda: true }, "agent", ["agenda"]);
    expect(c.erpRole).toBeNull();
    const landing = registry.managementLanding(registry.resolveManagement(registry.MANAGEMENT_ITEMS, c));
    expect(landing).toBe("/app/erp/modulos/agenda");
    routes.navigate(parse(landing!), { replace: true });
    const native = await markup();
    expect(native).toContain("Agenda autorizada"); expect(native).not.toContain("fagoo-root");
    expect(surface.nativeLoads).toBe(1);
    app({ agenda: true, os: true }); routes.navigate({ area: "erp" });
    expect(registry.managementLanding(registry.resolveManagement(registry.MANAGEMENT_ITEMS, context({ agenda: true, os: true })))).toBe("/app/erp/modulos/trabalhos");
    expect(await markup()).toContain("Abrindo a gestão");
    expect(surface.portedLoads).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });

  it("só os abre Trabalhos; configurações administrativas e URLs negadas não importam páginas", async () => {
    const c = context({ os: true }, "agent", ["os"]);
    expect(registry.managementLanding(registry.resolveManagement(registry.MANAGEMENT_ITEMS, c))).toBe("/app/erp/modulos/trabalhos");
    app({ agenda: true }, "agent", ["agenda"]);
    routes.navigate(parse("/app/gestao/servicos-e-horarios?x=1#fim"));
    expect(await markup()).toContain("Você não tem acesso");
    routes.navigate(parse("/app/erp/modulos/inexistente"));
    expect(await markup()).toContain("Página não encontrada");
    routes.navigate(parse("/app/erp/cadastros-reais?cadastro=contacts"));
    expect(await markup()).toContain("Módulo desligado");
    // A negativa por papel precisa do módulo ligado; são estados distintos.
    app({ agenda: true, erp: true }, "agent", ["agenda"]);
    expect(await markup()).toContain("Você não tem acesso");
    expect(routes.pageRoute("modules")).toEqual({ area: "admin", page: "modules" });
    expect(surface.nativeLoads).toBe(0); expect(surface.portedLoads).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });

  it("só Cadastro abre Clientes e mantém Produtos desligado", async () => {
    const { ERP_MANAGEMENT_ITEMS } = await import("../src/modules/erp/panel-menu");
    const customer = ERP_MANAGEMENT_ITEMS.filter(item => item.id === "erp.customers");
    const c = context({ erp: true });
    expect(registry.managementLanding(registry.resolveManagement(customer, c))).toBe("/app/erp" + contactTarget);
    expect(registry.managementLanding(registry.resolveManagement(registry.MANAGEMENT_ITEMS, c))).toBe("/app/erp" + contactTarget);
    expect(registry.resolveManagement(registry.MANAGEMENT_ITEMS, c).some(item => item.id === "erp.products")).toBe(false);
    expect(registry.resolveManagement(registry.MANAGEMENT_ITEMS, context({ erp: true, "erp-produtos": true })).some(item => item.id === "erp.products")).toBe(true);
    expect(registry.resolveManagement(customer, context({ "erp-cadastro": true }))).toEqual([]);
  });
});

describe("aliases e ponte reais no mesmo histórico", () => {
  it("cancelar a guarda principal conserva URL/conteúdo e permite um novo pedido", () => {
    routes.navigate(routes.pageRoute("agenda"));
    const blocked = vi.fn(); own({ dispose: routes.onBlocked(blocked) });
    routes.setNavigationGuard(() => true);
    const length = web.history.length, target = parse("/app/erp/acesso");
    routes.navigate(target); routes.navigate(target);
    expect(blocked).toHaveBeenCalledTimes(1);
    routes.cancelBlockedNavigation();
    expect(routes.currentRoute().page).toBe("agenda");
    expect(location.pathname).toBe("/app/erp/modulos/agenda");
    expect(web.history.length).toBe(length);
    routes.navigate(target); expect(blocked).toHaveBeenCalledTimes(2);
    routes.navigate(target, { force: true }); routes.navigate(target, { force: true });
    expect(web.history.length).toBe(length + 1);
  });

  // Cada entrada/F5 reinicia o roteador real. Casos independentes conservam
  // todos os aliases sem somar dezenas de imports no prazo de um único teste.
  it.each([...new Set(Object.values(nativePageSlugs)), "ordens-de-servico", "trabalhos/tipo/id%2F1", "meus-prazos/tipo", "tipos-de-trabalho/tipo"])("alias %s preserva consulta bruta, fragmento, detalhe, atualização e nova aba", async slug => {
    const suffix = "?q=a%20b&q=outro&x=%2f&x=2&aba=pessoas#se%C3%A7%C3%A3o";
    vi.resetModules(); web = browser("/app/gestao/" + slug + suffix); routes = await import("../web/lib/routes");
    const route = routes.currentRoute();
    const canonical = "/app/erp/modulos/" + (slug === "ordens-de-servico" ? "trabalhos" : slug) + suffix;
    expect(routes.href(route)).toBe(canonical); expect(location.pathname + location.search + location.hash).toBe(canonical);
    expect(web.history.length).toBe(1); expect(web.history.pushState).not.toHaveBeenCalled();
    const click = { defaultPrevented: false, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn() };
    const link = routes.linkProps(route);
    expect(link.href).toBe(canonical);
    link.onClick(click); expect(click.preventDefault).not.toHaveBeenCalled();
    vi.resetModules(); routes = await import("../web/lib/routes"); expect(routes.href(routes.currentRoute())).toBe(canonical);
    expect(web.history.length).toBe(1); expect(web.history.pushState).not.toHaveBeenCalled();
    vi.resetModules(); web = browser(link.href); routes = await import("../web/lib/routes");
    expect(routes.href(routes.currentRoute())).toBe(canonical);
    expect(web.history.length).toBe(1); expect(web.history.pushState).not.toHaveBeenCalled();
  });

  it("objetos antigos de trabalhos abrem o detalhe na casa", () => {
    routes.navigate({ area: "admin", page: "work", typeId: "tipo", id: "d1/1", tab: "pessoas" });
    expect(routes.currentRoute()).toMatchObject({ area: "erp", page: "work", id: "d1/1" });
  });

  it("nativo→portado, portado→portado, histórico e saída confirmam uma vez, inclusive cliques repetidos", async () => {
    routes.navigate(routes.pageRoute("agenda"));
    let dirty = true;
    const blocked = vi.fn(); const unlisten = routes.onBlocked(blocked); own({ dispose: unlisten });
    routes.setNavigationGuard(() => dirty);
    const initial = web.history.length;
    expect(routes.navigate(parse("/app/erp/acesso"))).toBe(false);
    expect(routes.navigate(parse("/app/erp/acesso"))).toBe(false);
    expect(blocked).toHaveBeenCalledTimes(1); expect(web.history.length).toBe(initial);
    expect(routes.currentRoute().page).toBe("agenda");
    routes.navigate(blocked.mock.calls[0][0], { force: true });
    const { connectErpRouter } = await import("../web/erp/mount");
    const router = createMemoryRouter([{ path: "*", element: null }], { basename: "/app/erp", initialEntries: [location.pathname] });
    const bridge = connectErpRouter(router); own({ dispose() { bridge.dispose(); router.dispose(); } });
    router.getBlocker("editor", () => dirty);
    const length = web.history.length;
    const target = parse("/app/erp/cadastros-reais?cadastro=contacts#dados");
    routes.navigate(target); routes.navigate(target); await tick();
    expect(blocked).toHaveBeenCalledTimes(1); expect(router.state.blockers.get("editor")?.state).toBe("blocked");
    router.state.blockers.get("editor")!.reset!(); await tick();
    expect(router.state.blockers.get("editor")?.state).toBe("unblocked");
    expect(web.history.length).toBe(length); expect(location.pathname).toBe("/app/erp/acesso");
    routes.navigate(target); routes.navigate(target); await tick();
    router.state.blockers.get("editor")!.proceed!(); await tick();
    expect(web.history.length).toBe(length + 1); expect(routes.currentRoute().hash).toBe("#dados");
    web.history.go(-1); await tick();
    expect(web.position()).toBe(length); expect(routes.currentRoute().hash).toBe("#dados");
    router.state.blockers.get("editor")!.reset!(); await tick();
    expect(web.position()).toBe(length);
    web.history.go(-1); await tick(); router.state.blockers.get("editor")!.proceed!(); await tick();
    expect(routes.currentRoute().erpPath).toBe("/acesso"); expect(web.history.length).toBe(length + 1);
    dirty = false; web.history.go(1); await tick(); expect(routes.currentRoute().hash).toBe("#dados");
    dirty = true;
    routes.navigate(routes.pageRoute("agenda")); expect(blocked).toHaveBeenCalledTimes(2);
    expect(routes.currentRoute().erpPath).toBe("/cadastros-reais");
    routes.navigate(blocked.mock.calls[1][0], { force: true }); bridge.dispose(); router.dispose();
    expect(routes.currentRoute().page).toBe("agenda");
    dirty = false; web.history.go(-1); await tick(); expect(routes.currentRoute().erpPath).toBe("/cadastros-reais");
    web.history.go(1); await tick(); expect(routes.currentRoute().page).toBe("agenda");
    dirty = true; routes.navigate({ area: "conversations" }); expect(blocked).toHaveBeenCalledTimes(3);
    expect(routes.currentRoute().page).toBe("agenda");
    routes.navigate(blocked.mock.calls[2][0], { force: true }); expect(routes.currentRoute().area).toBe("conversations");
  });
});

describe("rede, falhas e descarte", () => {
  it("suspende leituras/ações nativas, ignora respostas fora de ordem e não revive A→B→A", async () => {
    const late = deferred<unknown>(); let signal: AbortSignal | undefined;
    const request = vi.fn(async (_: string, _method?: string, _body?: unknown, incoming?: AbortSignal) => { signal = incoming; return late.promise; });
    const scope = own(registry.createManagementRequestScope(request));
    scope.update("a:1", true); const old = scope.api("v1/profiles/a/status");
    const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
    scope.update("b:2", true); scope.update("a:3", true);
    expect(signal?.aborted).toBe(true); late.resolve({ modules: { erp: true } }); await rejection;
    scope.update("disabled", false);
    await expect(scope.api("leitura")).rejects.toMatchObject({ name: "AbortError" });
    await expect(scope.api("acao", "POST", {})).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
    scope.update("retry", true); await expect(scope.api("status")).resolves.toEqual({ modules: { erp: true } });
  });

  it("/v1/me falha e repete, montagem dupla compartilha sessão e revogação bloqueia retornos tardios", async () => {
    const { acquireErpHost } = await import("../web/erp/host-runtime");
    fetcher.mockRejectedValueOnce(new Error("offline"));
    const a = own(acquireErpHost(host())), b = own(acquireErpHost(host()));
    const first = await a.ready; expect(await b.ready).toBe(first);
    await vi.waitFor(() => expect(first.controller.getSnapshot().phase).toBe("error"));
    first.controller.retry(); await vi.waitFor(() => expect(first.controller.getSnapshot().phase).toBe("ready"));
    const delayed = deferred<Response>(); let signal: AbortSignal | undefined;
    fetcher.mockImplementationOnce((_input: unknown, init: RequestInit) => { signal = init.signal as AbortSignal; return delayed.promise; });
    const read = first.controller.catalog("/v1/cadastros/contatos/erp-42");
    const rejection = expect(read).rejects.toMatchObject({ name: "AbortError" }); await tick();
    a.update(host({ management: context({ erp: false }) }));
    expect(signal?.aborted).toBe(true); expect(first.allowed(contactTarget)).toBe(false);
    const calls = fetcher.mock.calls.length;
    await expect(first.ports.fetch("/api/v1/profiles/area-a/erp/v1/me")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    delayed.resolve(Response.json({ record })); await rejection;
    fetcher.mockImplementationOnce(async () => Response.json({ user_id: otherActor, role: "admin", resources: ["contacts"], data_mode: "staging_readonly" }));
    const next = await own(acquireErpHost(host({ actor: otherActor, profile: "area-b" }))).ready;
    await vi.waitFor(() => expect(next.controller.getSnapshot().membership?.user_id).toBe(otherActor));
    a.dispose(); b.dispose(); expect(next.allowed(contactTarget)).toBe(true);
    expect(first.controller.getSnapshot().membership).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("um corpo de prefetch revogado não entrega dados; cancelar depois de consumir não falha", async () => {
    const abort = new AbortController(); const response = await area.contextBoundResponse(Response.json({ actor }), abort.signal);
    abort.abort(); await expect(response.json()).rejects.toMatchObject({ name: "AbortError" });
    const complete = new AbortController(); const ok = await area.contextBoundResponse(Response.json({ actor }), complete.signal);
    expect(await ok.json()).toEqual({ actor }); expect(() => complete.abort()).not.toThrow();
  });

  it("registro da ficha é leve, recupera chunk, usa ID ERP e callback D1 e limpa só sua instância", async () => {
    const port = await import("../web/contact-profile/host-port");
    const load = vi.fn(() => import("../web/erp/mount"));
    const open = vi.fn();
    const registration = own(area.installManagementCustomerHost(host({ openContactProfile: open }), { mount: load }));
    await registration.ready;
    const full = await port.loadFullCustomerHost();
    expect(load).not.toHaveBeenCalled(); expect(surface.portedLoads).toBe(0); expect(fetcher).not.toHaveBeenCalled();
    const input = { profileId: "area-a", contactId: "d1:007", erpContactId: "erp-42", onSaved: vi.fn(), onClose: vi.fn() };
    const element = new Scope();
    await expect(full.mount(element as any, { ...input, erpContactId: "" })).rejects.toThrow("ERP_CUSTOMER_CONTEXT");
    await expect(full.mount(element as any, { ...input, profileId: "area-b" })).rejects.toThrow("ERP_CUSTOMER_CONTEXT");
    expect(load).not.toHaveBeenCalled();
    load.mockRejectedValueOnce(new Error("chunk"));
    await expect(full.mount(element as any, input)).rejects.toThrow("chunk");
    const mounted = own(await full.mount(element as any, input));
    const { erpPorts } = await import("../web/erp/ports");
    await vi.waitFor(() => expect(erpPorts()?.controller?.getSnapshot().phase).toBe("ready"));
    await erpPorts()!.openContactProfile!(input.contactId);
    expect(open).toHaveBeenCalledExactlyOnceWith("d1:007");
    const { acquireErpHost } = await import("../web/erp/host-runtime");
    const lease = own(acquireErpHost(host())); const runtime = await lease.ready;
    const { readCustomerProfile } = await import("../web/erp/mount");
    expect((await readCustomerProfile(runtime, input.erpContactId, new AbortController().signal)).record.id).toBe("erp-42");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/contatos/erp-42"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("d1:007"))).toBe(false);
    registration.dispose(); registration.dispose(); mounted.dispose();
    expect(surface.roots[0].unmount).toHaveBeenCalledTimes(1); expect(element.children[0].removed).toBe(true);
    expect(runtime.allowed(contactTarget)).toBe(true);
    await expect(port.loadFullCustomerHost()).rejects.toMatchObject({ code: "dependency_unavailable" });
    await expect(full.mount(element as any, input)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("descarte durante import/montagem e callbacks tardios não restauram a identidade", async () => {
    const port = await import("../web/contact-profile/host-port");
    const loadingPort = deferred<typeof port>();
    const early = own(area.installManagementCustomerHost(host(), { port: () => loadingPort.promise }));
    early.dispose(); loadingPort.resolve(port); await early.ready;
    await expect(port.loadFullCustomerHost()).rejects.toMatchObject({ code: "dependency_unavailable" });
    const pending = deferred<{ dispose(): void }>(); const dispose = vi.fn();
    let saved!: () => void;
    const registration = own(area.installManagementCustomerHost(host(), { mount: async () => ({ mountCustomerProfile: async (_el, options) => { saved = options.onSaved!; return pending.promise; } }) }));
    await registration.ready; const full = await port.loadFullCustomerHost(); const onSaved = vi.fn();
    const mounting = full.mount(new Scope() as any, { profileId: "area-a", contactId: "d1:7", erpContactId: "erp-42", onSaved, onClose() {} });
    const rejected = expect(mounting).rejects.toMatchObject({ name: "AbortError" }); await tick();
    registration.dispose(); pending.resolve({ dispose }); await rejected; saved();
    expect(dispose).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
    const next = own(area.installManagementCustomerHost(host())); await next.ready;
    registration.dispose(); expect(await port.loadFullCustomerHost()).toHaveProperty("mount");
  });
});
