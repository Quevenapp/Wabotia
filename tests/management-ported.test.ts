import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router-dom";
import { PREFERENCE_PAGES, preferencePageHref } from "../packages/erp-domain/src/preferences/catalog.mjs";
import { ROLE_RESOURCES } from "../src/erp/role-resources";
import { ERP_MANAGEMENT_ITEMS, type ErpPart } from "../src/modules/erp/panel-menu";
import type { ManagementContext, ManagementRouterBridge } from "../src/modules/panel-contract";
import { portedPermissionAllowed, portedTarget, portedTargetState } from "../web/management/ported-policy";
import { erpPartEnabled } from "../web/erp/modules";
import * as erpModules from "../web/erp/modules";
import { blockOf, blockEnabled, setErpBlocks, targetEnabled } from "../web/erp/blocks";
import { setMotorReal } from "../web/erp/motor";
import { erpPorts, installErpPorts, setErpPorts } from "../web/erp/ports";
import { acquireErpHost, ErpHostProvider, type ErpHostRuntime } from "../web/erp/host-runtime";
import { connectErpRouter, keepLinksInside, mountCustomerProfile, readCustomerProfile, registerErpGuard } from "../web/erp/mount";
import { createUnsavedChangesStore } from "../web/erp/app/lib/unsaved-changes-store";
import OriginTopBar from "../web/erp/app/components/OriginTopBar";
import RealAccess from "../web/erp/app/components/RealAccess";
import App from "../web/erp/app/App";
import { ContactEditor } from "../web/erp/app/components/ContactEditor";
import { ContactProfileEntry } from "../web/erp/contact-profile-entry";
import CompanyNavigation from "../web/erp/app/components/CompanyNavigation";
import { resolveMenu } from "../web/erp/app/lib/origin-menu";
import policySource from "../web/management/ported-policy.ts?raw";
import modulesSource from "../web/erp/modules.ts?raw";
import motorSource from "../web/erp/motor.ts?raw";
import mountSource from "../web/erp/mount.tsx?raw";
import runtimeSource from "../web/erp/host-runtime.tsx?raw";
import appSource from "../web/erp/app/App.tsx?raw";
import navigationSource from "../web/erp/app/components/CompanyNavigation.tsx?raw";

// Sem navegador ou rede: roteador em memória real, controlador real e portas simuladas.
const testRuntime = vi.hoisted(() => ({
  location: { pathname: "/acesso", search: "", hash: "" },
  hooks: null as any, view: null as any, roots: [] as any[], bound: null as any,
  publish: vi.fn(), disconnect: vi.fn(), guard: null as null | (() => boolean), navigate: vi.fn(),
}));
vi.mock("../web/lib/routes", () => ({
  bindManagementRouter: (bridge: ManagementRouterBridge) => { testRuntime.bound = bridge; return { publish: testRuntime.publish, dispose: testRuntime.disconnect }; },
  navigate: testRuntime.navigate, parseRoute: (pathname: string, search: string) => ({ area: "erp", erpPath: pathname.slice(8), search }),
  setNavigationGuard: (guard: (() => boolean) | null) => { testRuntime.guard = guard; },
}));
vi.mock("../web/ui", () => ({ toast: vi.fn() }));
vi.mock("../web/erp/fetch-port", async original => ({ ...await original<typeof import("../web/erp/fetch-port")>(), erpSimulated: () => false }));
vi.mock("react-dom/client", () => ({ createRoot: () => {
  const root = { render: vi.fn(), unmount: vi.fn() }; testRuntime.roots.push(root); return root;
} }));
vi.mock("../web/erp/app/hooks/useUnsavedChanges", async original => ({
  ...await original<typeof import("../web/erp/app/hooks/useUnsavedChanges")>(),
  useUnsavedChangesGuard: () => ({ store: { shouldBlock: () => false }, confirmLeave: (run: () => void) => run() }),
}));
vi.mock("react-router-dom", async original => ({
  ...await original<typeof import("react-router-dom")>(),
  useLocation: () => testRuntime.location, useNavigate: () => testRuntime.navigate,
}));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const owner = testRuntime.hooks, index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (next: any) => { owner.slots[index] = typeof next === "function" ? next(owner.slots[index]) : next; }];
  };
  return { ...actual, useState, useRef: (value: any) => useState(() => ({ current: value }))[0],
    useMemo: (compute: () => any) => compute(), useCallback: (callback: any) => callback,
    useContext: (context: any) => context === ErpHostProvider ? testRuntime.view : context._currentValue,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useEffect: () => {}, useLayoutEffect: () => {},
  };
});

const leases: { dispose(): void }[] = [];
const actor = "00000000-0000-4000-8000-000000000001";
function context(change: Partial<ManagementContext> = {}): ManagementContext {
  return { statusLoaded: true, modules: { erp: true }, role: "admin", access: null, erpRole: "admin", ...change };
}
const host = (change: Record<string, unknown> = {}) => ({ profile: "area-a", actor, demo: false, management: context(),
  onModules: vi.fn(), onPeople: vi.fn(), onLeave: vi.fn(), onExpired: vi.fn(), ...change });
function acquire(options = host()) { const lease = acquireErpHost(options); leases.push(lease); return lease; }
const member = (id = actor, role = "admin", resources = ["contacts", "products"]) => ({ user_id: id, role, resources, data_mode: "staging_readonly" });
const record = { id: "erp-42", entity: "contacts" as const, version: 1, active: true, name: "Cliente", credit_limit_mode: "none", types: [],
  code: null, source: null, created_at: "2026-11-19T00:00:00Z", updated_at: "2026-11-19T00:00:00Z" };
const fetcher = vi.fn(async (input: unknown) => {
  const path = String(input);
  if (path.endsWith("/v1/me")) return Response.json(member());
  if (path.endsWith("/v1/cadastros")) return Response.json({ read: ["contacts"], write: ["contacts"], data_mode: "erp_native" });
  if (path.endsWith("/v1/cadastros/contatos/erp-42")) return Response.json({ record });
  throw new Error(`Leitura inesperada: ${path}`);
});
const ready = async (runtime: ErpHostRuntime) => { await vi.waitFor(() => expect(runtime.controller.getSnapshot().phase).toBe("ready")); };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function render(fn: () => any) { testRuntime.hooks = { index: 0, slots: [] }; return fn(); }
function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return React.isValidElement(tree) ? [tree, ...nodes((tree.props as any).children)] : [];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return React.isValidElement(tree) ? text((tree.props as any).children) : tree == null ? "" : String(tree);
}
class Scope {
  className = ""; removed = false; children: Scope[] = []; parentNode = null;
  ownerDocument = { createElement: () => new Scope() };
  querySelectorAll() { return []; }
  addEventListener = vi.fn(); removeEventListener = vi.fn();
  appendChild(child: Scope) { this.children.push(child); }
  remove() { this.removed = true; }
}
beforeEach(() => {
  testRuntime.location = { pathname: "/acesso", search: "", hash: "" };
  vi.clearAllMocks(); testRuntime.roots.length = 0; testRuntime.view = null; testRuntime.bound = null;
  vi.stubGlobal("location", new URL("https://painel.example/app/erp/acesso"));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Element", Scope);
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  setErpBlocks(null); setMotorReal(false); setErpPorts(null);
});
afterEach(() => { leases.splice(0).forEach(lease => lease.dispose()); setErpBlocks(null); setMotorReal(false); setErpPorts(null); vi.unstubAllGlobals(); });

describe("política portada pura", () => {
  it("permite simular a futura separação por parte mudando somente a decisão central", () => {
    const activation = vi.spyOn(erpModules, "erpPartEnabled").mockImplementation(part => part === "cadastro");
    try {
      expect(portedTargetState("/cadastros-reais?cadastro=contacts", context())).toBe("allowed");
      expect(portedTargetState("/cadastros-reais?cadastro=products", context())).toBe("disabled");
      expect(portedTargetState("/cadastros-reais?cadastro=warehouses", context())).toBe("disabled");
      expect(activation).toHaveBeenCalledWith("catalogo", expect.anything(), "/cadastros-reais?cadastro=products");
    } finally { activation.mockRestore(); }
  });
  it("centraliza núcleo, opcionais e exceções por consulta", () => {
    const modules = { erp: true, "erp-fiscal": false, "erp-cobranca": false, "erp-pdv": false };
    for (const item of ERP_MANAGEMENT_ITEMS) expect(portedTargetState(item.target.to, context({ modules }), true)).toBe(erpPartEnabled(item.part, modules, item.target.to) ? "allowed" : "disabled");
    expect(erpPartEnabled("financeiro", modules, "/financeiro-empresa?area=borderos")).toBe(true);
    expect(erpPartEnabled("financeiro", modules, "/financeiro-empresa?area=remessas#arquivo")).toBe(false);
    expect(erpPartEnabled("financeiro", modules, "/financeiro-empresa?area=retornos")).toBe(false);
    expect(erpPartEnabled("compras", modules, "/checkin-recebimentos")).toBe(false);
    expect(erpPartEnabled("pdv", modules, "/preferencias/vendas/frente-caixa/atalhos")).toBe(false);
    expect(erpPartEnabled("catalogo", { "erp-produtos": true }, "/cadastros-reais?cadastro=products")).toBe(false);
    expect(erpPartEnabled("parte-futura" as ErpPart, { erp: true }, "/acesso")).toBe(false);
    expect(blockOf("/financeiro-empresa?area=retornos#x")).toBe("erp-cobranca");
    setErpBlocks(modules); expect(blockEnabled("erp-fiscal")).toBe(false); expect(targetEnabled("/checkin-recebimentos")).toBe(false);
  });
  it("não depende da montagem nem do fallback permissivo do adaptador", () => {
    expect(portedTargetState("/acesso", context({ modules: {} }))).toBe("disabled");
    setErpBlocks({ erp: false }); setMotorReal(true);
    expect(portedTargetState("/acesso", context())).toBe("allowed");
    expect(portedTargetState("/meu-negocio", context(), true)).toBe("allowed");
    for (const source of [policySource, modulesSource, motorSource]) {
      const imports = [...source.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)].map(match => match[1]);
      expect(imports.some(path => /(?:app\/|screens\/|packages\/|react-router|registry|mount|host-runtime)/.test(path))).toBe(false);
    }
    expect(policySource).not.toMatch(/setErpBlocks|erpPorts\(|fetch\(/);
  });
  it("distingue carregamento, papel, recurso, destino desconhecido, oculto e sem motor", () => {
    expect(portedTargetState("/acesso", context({ statusLoaded: false }))).toBe("loading");
    expect(portedTargetState("/acesso", context({ erpRole: null }))).toBe("denied");
    expect(portedTargetState("/cadastros-reais?cadastro=products", context({ erpRole: "financeiro" }))).toBe("denied");
    expect(portedTargetState("/cadastros-reais?cadastro=contacts", context({ erpRole: "financeiro" }))).toBe("allowed");
    expect(portedTargetState("/documentos-empresa?tipo=sales_orders&acao=checkout", context({ erpRole: "consulta" }))).toBe("denied");
    expect(portedTargetState("/documentos-empresa?tipo=service_orders", context({ erpRole: "estoque" }))).toBe("denied");
    expect(portedPermissionAllowed("/cadastros-reais?cadastro=contacts", "admin", [])).toBe(false);
    for (const target of ["/nao-existe", "/preferencias/sistema/inventada", "/ajuda/inventada", "/cadastros-reais?cadastro=secrets", "/cadastros-reais?cadastro=contacts&cadastro=products", "//exemplo/acesso", "/x/../acesso"]) expect(portedTargetState(target, context())).toBe("not-found");
    expect(portedTargetState("/preferencias/sistema/atualizacoes", context())).toBe("unavailable");
    expect(portedTargetState("/meu-negocio?painel=mensal", context())).toBe("unavailable");
    expect(portedTargetState("/meu-negocio?painel=mensal", context(), true)).toBe("allowed");
  });
  it("fragmentos não liberam páginas indisponíveis no adaptador legado", () => {
    setMotorReal(true);
    for (const target of ["/meu-negocio", "/notas-recebidas", "/preferencias/sistema/registro-atividades"]) {
      for (const suffix of ["", "#detalhe", "?filtro=ativo#detalhe"]) {
        expect(targetEnabled(target + suffix), target + suffix).toBe(false);
      }
    }
    expect(targetEnabled("/acesso#inicio")).toBe(true);
    setMotorReal(false);
    expect(targetEnabled("/meu-negocio#mensal")).toBe(true);
  });
  it("mantém o inventário de rotas e schemas sem levar seus imports para a política", () => {
    for (const match of appSource.matchAll(/['"](\/[a-z-]+)['"]/g)) expect(portedTarget(match[1]), match[1]).not.toBeNull();
    for (const page of PREFERENCE_PAGES) {
      const to = preferencePageHref(page);
      expect(portedTarget(to), to).not.toBeNull();
      for (const role of Object.keys(ROLE_RESOURCES)) expect(portedPermissionAllowed(to, role, ROLE_RESOURCES[role]), `${to}:${role}`).toBe(page.readRoles.some(allowed => allowed === role));
      if (page.subsections) for (const section of page.sections) expect(portedTarget(preferencePageHref(page, section.id))).not.toBeNull();
    }
    expect(portedTargetState("/tags?tipo=contatos", context({ erpRole: "financeiro" }))).toBe("allowed");
    expect(portedTargetState("/tags?tipo=produtos", context({ erpRole: "financeiro" }))).toBe("denied");
    expect(portedTargetState("/tags?tipo=inventado", context())).toBe("not-found");
  });
  it("classifica preferências, ferramentas, ajuda, subseções e detalhes", () => {
    const c = context({ modules: { erp: true, "erp-fiscal": true, "erp-pdv": true, "erp-cobranca": true } });
    for (const to of ["/preferencias", "/preferencias/cadastros", "/preferencias/cadastros/clientes-fornecedores", "/preferencias/vendas/vendas/checkout", "/preferencias/notas-fiscais/nfe/preenchimento", "/preferencias/importacoes/contatos", "/preferencias/sistema/gestao-acoes", "/empresa-configuracoes?secao=armazenamento", "/ajuda/novidades", "/ajuda/primeiros-passos#conta", "/cadastros-reais?cadastro=contacts&id=erp-42", "/documentos-empresa?tipo=purchase_orders&id=42", "/financeiro-empresa?area=comissoes-relatorio"]) expect(portedTargetState(to, c)).toBe("allowed");
    expect(portedTarget("/cadastros-reais?cadastro=products")?.part).toBe("catalogo");
    expect(portedTarget("/cadastros-reais?cadastro=warehouses")?.part).toBe("estoque");
    expect(portedTargetState("/preferencias/importacoes/contatos", { ...c, erpRole: "consulta" })).toBe("denied");
  });
});

describe("ponte portada", () => {
  function routerFixture() {
    const router = createMemoryRouter([{ path: "*", element: null }], { basename: "/app/erp", initialEntries: ["/app/erp/acesso"] });
    const bridge = connectErpRouter(router);
    leases.push({ dispose() { bridge.dispose(); router.dispose(); } });
    return { router, bridge };
  }
  it("o alias de acesso publica o painel geral por replace, preservando consulta e fragmento", async () => {
    testRuntime.location = { pathname: "/acesso", search: "?periodo=mes", hash: "#resumo" };
    const redirect = App();
    expect(redirect.props.to).toBe("/visao-geral?periodo=mes#resumo");
    expect(redirect.props.replace).toBe(true);
    const { router } = routerFixture();
    await router.navigate(redirect.props.to, { replace: redirect.props.replace });
    expect(testRuntime.publish).toHaveBeenCalledExactlyOnceWith("/app/erp/visao-geral?periodo=mes#resumo", "replace");
    expect(portedTargetState("/visao-geral", context())).toBe("allowed");
    testRuntime.location = { pathname: "/visao-geral", search: "", hash: "" };
    expect(App().props.to).toBeUndefined(); // link copiado/recarregado renderiza a tela, sem outro redirecionamento
  });
  it("não publica a montagem, espera confirmação e publica uma única vez", async () => {
    const { router, bridge } = routerFixture();
    expect(testRuntime.publish).not.toHaveBeenCalled();
    const store = createUnsavedChangesStore(); store.update(Symbol("editor"), { dirty: true, busy: false });
    router.getBlocker("unsaved", () => store.shouldBlock());
    let finished = false;
    const request = bridge.navigate("/app/erp/cadastros-reais?cadastro=contacts#dados").then(() => { finished = true; });
    await tick(); expect(finished).toBe(false); expect(testRuntime.publish).not.toHaveBeenCalled();
    router.state.blockers.get("unsaved")!.proceed!();
    await request;
    expect(testRuntime.publish).toHaveBeenCalledExactlyOnceWith("/app/erp/cadastros-reais?cadastro=contacts#dados", "push");
    expect(router.state.location.pathname).toBe("/app/erp/cadastros-reais");
  });
  it("cancelamento conclui a promessa sem publicar; replace e descarte não criam ciclos", async () => {
    const { router, bridge } = routerFixture(); router.getBlocker("unsaved", () => true);
    const request = bridge.navigate("/app/erp/preferencias"); await tick(); router.state.blockers.get("unsaved")!.reset!(); await request;
    expect(testRuntime.publish).not.toHaveBeenCalled(); expect(router.state.location.pathname).toBe("/app/erp/acesso");
    router.deleteBlocker("unsaved"); await bridge.navigate("/app/erp/preferencias", { replace: true });
    expect(testRuntime.publish).toHaveBeenCalledExactlyOnceWith("/app/erp/preferencias", "replace");
    await bridge.navigate("/app/erp/preferencias"); expect(testRuntime.publish).toHaveBeenCalledTimes(1);
    bridge.dispose(); bridge.dispose(); await router.navigate("/acesso"); expect(testRuntime.publish).toHaveBeenCalledTimes(1); expect(testRuntime.disconnect).toHaveBeenCalledTimes(1);
    await expect(bridge.navigate("/app/erp/acesso")).rejects.toThrow("ERP_ROUTER_DISPOSED");
  });
  it("recusa entrada/nativos e limpa pedidos pendentes e guardas por dono", async () => {
    const { router, bridge } = routerFixture();
    for (const to of ["/app/erp", "/app/erp/", "/app/erp/modulos/agenda", "https://outro/app/erp/acesso", "/app/erp/x/../acesso", "/app/erp/./acesso", "/app/erp/%2e/acesso"]) await expect(bridge.navigate(to)).rejects.toThrow();
    router.getBlocker("unsaved", () => true); const pending = bridge.navigate("/app/erp/preferencias"); await tick(); bridge.dispose(); await expect(pending).rejects.toThrow("ERP_ROUTER_DISPOSED");
    const a = registerErpGuard(() => true), b = registerErpGuard(() => true);
    a(); a(); expect(testRuntime.guard?.()).toBe(true); b(); expect(testRuntime.guard).toBeNull();
    expect(mountSource).not.toMatch(/createBrowserRouter|history\.(?:pushState|replaceState)|dispatchEvent/);
    expect(mountSource).toContain("<UnsavedChangesProvider>");
  });
  it("publica navegação interna aceita e rejeita falha técnica sem publicar", async () => {
    const { router, bridge } = routerFixture();
    await router.navigate("/preferencias");
    expect(testRuntime.publish).toHaveBeenCalledExactlyOnceWith("/app/erp/preferencias", "push");
    vi.spyOn(router, "navigate").mockRejectedValueOnce(new Error("Falha técnica"));
    await expect(bridge.navigate("/app/erp/acesso")).rejects.toThrow("Falha técnica");
    expect(testRuntime.publish).toHaveBeenCalledTimes(1);
  });
});

describe("hospedeiros autorizados", () => {
  it("instala a ficha pela porta e monta o corpo bruto sem reabrir a entrada", async () => {
    const lease = acquire(), runtime = await lease.ready; await ready(runtime);
    expect(runtime.ports.contactProfileEditor).toBe(ContactProfileEntry);
    const props = { controller: runtime.controller, entity: "contacts" as const, record, writable: true, onClose: vi.fn(), onSaved: vi.fn() };
    expect(render(() => ContactEditor(props)).type).toBe(ContactProfileEntry);
    expect(render(() => ContactEditor({ ...props, record: null })).type.name).toBe("ContactForm");
    lease.dispose();
    expect(render(() => ContactEditor(props)).type.name).toBe("ContactForm");
    expect(mountSource).toContain("default: module.RawContactEditor");
    expect(mountSource).toContain("embeddedProfile vocabulary={options.vocabulary}");
  });
  it("compartilha dois hospedeiros, libera só o último e repassa o ID D1 sem conversão", async () => {
    const openContactProfile = vi.fn(), a = acquire(host({ openContactProfile })), b = acquire(host());
    const [one, two] = await Promise.all([a.ready, b.ready]); await ready(one);
    expect(one).toBe(two); expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/v1/me"))).toHaveLength(1);
    await one.ports.openContactProfile?.("d1:cliente-007"); expect(openContactProfile).toHaveBeenCalledExactlyOnceWith("d1:cliente-007");
    a.dispose(); a.dispose(); expect(erpPorts()).toBe(two.ports); expect(two.ports.openContactProfile).toBeUndefined(); expect(two.allowed("/cadastros-reais?cadastro=contacts")).toBe(true);
    b.dispose(); expect(erpPorts()).toBeNull(); expect(two.allowed("/cadastros-reais?cadastro=contacts")).toBe(false);
    const independent = installErpPorts({} as any); const newer = installErpPorts({ demo: true } as any); independent(); expect(erpPorts()?.demo).toBe(true); newer();
  });
  it("invalida identidade anterior, aborta leitura atrasada e não limpa o novo hospedeiro", async () => {
    const a = acquire(), previous = await a.ready; await ready(previous);
    let finish!: (value: Response) => void, signal!: AbortSignal;
    fetcher.mockImplementationOnce((_input, init?: any) => { signal = init.signal; return new Promise<Response>(resolve => { finish = resolve; }); });
    const read = previous.controller.catalog("/v1/cadastros/contatos/erp-42");
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" }); await tick();
    fetcher.mockImplementationOnce(async () => Response.json(member("00000000-0000-4000-8000-000000000002")));
    const b = acquire(host({ actor: "00000000-0000-4000-8000-000000000002" })), next = await b.ready; await ready(next);
    expect(signal.aborted).toBe(true); finish(Response.json({ record })); await rejected;
    expect(previous.allowed("/acesso")).toBe(false); a.dispose(); expect(erpPorts()).toBe(next.ports);
    expect(next.ports.openContactProfile).toBeUndefined();
  });
  it("callbacks capturados revalidam os donos ativos e a identidade", async () => {
    const first = vi.fn(), replacement = vi.fn(), account = vi.fn(), identity = vi.fn(async () => {});
    const a = acquire(host({ openContactProfile: first, onAccount: account, onConfirmIdentity: identity }));
    const runtime = await a.ready; await ready(runtime);
    const open = runtime.ports.openContactProfile!, openAccount = runtime.ports.openAccount!, confirmIdentity = runtime.ports.confirmIdentity!;
    a.update(host({ openContactProfile: replacement, onAccount: account, onConfirmIdentity: identity }));
    await open("d1:cliente-007");
    expect(first).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledExactlyOnceWith("d1:cliente-007");
    const b = acquire(); await b.ready;
    a.dispose();
    await open("d1:cliente-008"); openAccount(); await confirmIdentity();
    expect(replacement).toHaveBeenCalledTimes(1); expect(account).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
    b.dispose();
    expect(() => open("d1:cliente-009")).toThrow(); expect(() => openAccount()).toThrow();
    await expect(confirmIdentity()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("lê ficha completa na área recebida, sem comando, e revalida o acesso efetivo", async () => {
    const runtime = await acquire().ready; await ready(runtime);
    const data = await readCustomerProfile(runtime, "erp-42", new AbortController().signal);
    expect(data).toEqual({ record, writable: true });
    expect(fetcher.mock.calls.every(([path, init]: any[]) => String(path).startsWith("/api/v1/profiles/area-a/erp/") && init.method === "GET")).toBe(true);
    expect(fetcher.mock.calls.some(([path]) => String(path).includes("/contatos/erp-42"))).toBe(true);
    await expect(readCustomerProfile(runtime, "", new AbortController().signal)).rejects.toThrow();
    const count = fetcher.mock.calls.length;
    const denied = { ...runtime, allowed: () => false };
    await expect(readCustomerProfile(denied, "erp-42", new AbortController().signal)).rejects.toThrow("ERP_CUSTOMER_DENIED");
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("monta raiz exclusiva e descarta a ficha duas vezes sem encerrar a tela", async () => {
    const options = host(), runtime = await acquire(options).ready; await ready(runtime);
    const container = new Scope();
    const profile = await mountCustomerProfile(container as any, { context: options, erpContactId: "erp-42", onClose: vi.fn() });
    leases.push(profile);
    expect(container.children).toHaveLength(1); expect(container.children[0].className).toBe("fagoo-root");
    expect(testRuntime.roots[0].render).toHaveBeenCalledTimes(1);
    const tree = testRuntime.roots[0].render.mock.calls[0][0]; expect(tree.props.value.body).toBeTypeOf("function"); expect(tree.props.value.chromeTarget).toBeNull();
    profile.dispose(); profile.dispose(); expect(testRuntime.roots[0].unmount).toHaveBeenCalledTimes(1); expect(container.children[0].removed).toBe(true);
    expect(erpPorts()).toBe(runtime.ports); expect(runtime.allowed("/acesso")).toBe(true);
    await expect(mountCustomerProfile(container as any, { context: host({ management: context({ erpRole: null }) }), erpContactId: "erp-42", onClose: vi.fn() })).rejects.toThrow("ERP_CUSTOMER_DENIED");
  });
  it("mantém MFA, horário, negativa e repetição antes do corpo da ficha", async () => {
    const runtime = await acquire().ready; await ready(runtime);
    const body = vi.fn(() => React.createElement("section", null, "Ficha"));
    testRuntime.view = { runtime, embedded: true, chromeTarget: null, body };
    const original = runtime.controller.getSnapshot;
    for (const [phase, message, expected] of [["mfa", null, "Confirme que é você"], ["pending", "Horário restrito", "Acesso fora do horário permitido"], ["pending", null, "Acesso aguardando liberação"], ["error", "Falha", "Tentar novamente"]] as const) {
      runtime.controller.getSnapshot = () => ({ ...original(), phase, message });
      const outer = render(() => RealAccess({ host: testRuntime.view })); const connected = render(() => (outer.type as any)(outer.props));
      expect(text(connected)).toContain(expected); expect(body).not.toHaveBeenCalled();
      expect(nodes(connected).some(node => node.type === CompanyNavigation)).toBe(false);
    }
    runtime.controller.getSnapshot = original;
    const outer = render(() => RealAccess({ host: testRuntime.view })); render(() => (outer.type as any)(outer.props)); expect(body).toHaveBeenCalledTimes(1);
  });
});

it("modo embutido não renderiza segunda navegação e preserva ferramentas filtradas", () => {
  const groups = resolveMenu("real", { role: "admin", resources: ["contacts", "products"] });
  const tree = render(() => OriginTopBar({ embedded: true, groups, homeTo: "/acesso", preferencesTo: "/preferencias", user: { name: "Pessoa", company: "Empresa" }, theme: "light", onTheme: vi.fn(), role: "admin", allows: to => !to.includes("sales_orders") }));
  const all = nodes(tree);
  expect(all.some(node => node.type === "aside" || node.props.className === "origin-drawer-toggle" || node.props.className === "fagoo-modules")).toBe(false);
  for (const label of ["Notificações", "Central de ajuda", "Preferências"]) expect(all.some(node => node.props["aria-label"] === label)).toBe(true);
  expect(all.some(node => node.type === "form" && node.props.role === "search")).toBe(true);
  expect(navigationSource).toContain("createPortal(<ErpToolsScope");
  expect(runtimeSource).toContain('className="fagoo-root" data-erp-tools=');
  expect(navigationSource).toContain("notificationsPanel="); expect(navigationSource).toContain("storage=");
  const legacy = render(() => OriginTopBar({ groups, homeTo: "/acesso", preferencesTo: "/preferencias", user: { name: "Pessoa", company: "Empresa" }, theme: "light", onTheme: vi.fn() }));
  expect(nodes(legacy).some(node => node.type === "aside")).toBe(true);
});

it("observador de links mantém prefixo, consulta, fragmento e cliques em nova aba", () => {
  const links = ["/preferencias", "?cadastro=contacts#dados", "/api/v1/arquivo", "https://externo.example/"].map(href => ({
    value: href, getAttribute() { return this.value; }, setAttribute(_key: string, value: string) { this.value = value; },
  }));
  const scope = new Scope(); scope.querySelectorAll = () => links as any;
  const router = { state: { location: { pathname: "/app/erp/cadastros-reais", search: "", hash: "" } }, navigate: vi.fn() };
  const dispose = keepLinksInside(scope as any, router as any);
  expect(links.map(link => link.value)).toEqual(["/app/erp/preferencias", "/app/erp/cadastros-reais?cadastro=contacts#dados", "/api/v1/arquivo", "https://externo.example/"]);
  const click = scope.addEventListener.mock.calls[0][1]; const preventDefault = vi.fn();
  click({ button: 0, ctrlKey: true, preventDefault }); click({ button: 1, preventDefault });
  expect(preventDefault).not.toHaveBeenCalled(); expect(router.navigate).not.toHaveBeenCalled();
  dispose?.(); expect(scope.removeEventListener).toHaveBeenCalledTimes(1);
});
