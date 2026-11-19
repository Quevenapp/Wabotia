import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementContext, ManagementItem } from "../src/modules/panel-contract";
import type { WorkTypeView } from "../web/modules/os/work-contracts";
import type { Route } from "../web/lib/routes";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import { ERP_MANAGEMENT_ITEMS } from "../src/modules/erp/panel-menu";

// Catálogo e endereços reais da junção; somente estado e bordas de carga simulados.
const mocks = vi.hoisted(() => ({
  route: { area: "erp" } as Route,
  app: {} as Record<string, any>,
  portedImport: vi.fn(), prefetch: vi.fn(), nativeRender: vi.fn(), policy: vi.fn(),
  types: vi.fn(), resource: vi.fn(), catalog: [] as WorkTypeView[], navigate: vi.fn(),
}));
vi.mock("../web/lib/routes", async original => ({
  ...await original<typeof import("../web/lib/routes")>(),
  useRoute: () => mocks.route, navigate: mocks.navigate,
  navigationGuarded: () => false, setNavigationGuard: vi.fn(),
}));
vi.mock("../web/management/pages", () => ({
  ManagementPage: ({ page }: { page: string }) => { mocks.nativeRender(page); return React.createElement("p", null, "Página nativa"); },
}));
vi.mock("../web/management/ported-policy", () => ({
  portedTargetState: (to: string, c: ManagementContext, simulated = false) => {
    mocks.policy(to, c, simulated);
    if (to === "/missing") return "not-found";
    if (!c.statusLoaded) return "loading";
    if (!c.erpRole) return "denied";
    if (!c.modules.erp) return "disabled";
    if (to === "/soon") return "unavailable";
    return "allowed";
  },
}));
vi.mock("../web/erp/mount", () => { mocks.portedImport(); return { default: () => null }; });
vi.mock("../web/erp/fetch-port", () => ({
  erpSimulated: (demo: boolean) => demo,
  erpApiUrl: (profile: string) => `/api/v1/profiles/${profile}/erp`,
  prefetchErpMe: mocks.prefetch,
}));
vi.mock("../web/app/AppContext", () => ({
  useApp: () => mocks.app,
  ManagementRequestBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../web/app/Account", () => ({ AccountDialog: () => null, MfaPrompt: () => null }));
vi.mock("../web/modules/os/work-hooks", () => ({
  useWorkApi: () => ({ types: mocks.types }),
  useWorkResource: (key: string | null, load: () => Promise<unknown>) => {
    mocks.resource(key);
    if (key) void load();
    return { data: key ? { data: mocks.catalog } : undefined };
  },
}));
vi.mock("../web/ui", () => ({
  Empty: ({ title, description, action }: any) => React.createElement("div", null, title, description, action),
  Button: ({ children }: any) => React.createElement("button", null, children),
  Spinner: ({ label }: any) => React.createElement("span", null, label),
}));

import {
  MANAGEMENT_ITEMS, canEnterManagement, createManagementGeneration, createManagementRequestScope,
  managementContext, managementEntryState, managementLanding, nativeTargetState, resolveManagement,
} from "../web/management/registry";
import { ErpArea, contextBoundResponse, createDeferredHostSlot, loadAuthorizedPorted, startAuthorizedPortedPrefetch } from "../web/erp/ErpArea";
import { activeNavigationTypes, useWorkNavigation } from "../web/modules/os/work-navigation";
import { ManagementShell } from "../web/management/ManagementShell";

const context = (input: Partial<Parameters<typeof managementContext>[0]> = {}) => managementContext({
  statusLoaded: true, role: "admin", access: null, modules: {}, ...input,
});
const native = Object.values(NATIVE_MANAGEMENT_ITEMS).flat();
const types = (id: string, plural: string, archived = false, kind = "custom") => ({
  id, kind, archived, labels: { plural }, features: { tasks: true },
}) as WorkTypeView;
const render = () => renderToString(React.createElement(ErpArea));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.route = { area: "erp" };
  mocks.catalog = [];
  mocks.types.mockResolvedValue({ data: [] });
  mocks.app = {
    profile: "area-a", root: "v1/profiles/area-a", identityKey: "area-a:person-a",
    contextGeneration: 1, statusLoaded: true, modules: {}, settings: {}, status: {},
    me: { id: "person-a", role: "admin", access: null }, isAdmin: true, demo: false,
  };
  vi.stubGlobal("location", new URL("https://painel.test/app/erp"));
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});

describe("elegibilidade, ativação e autorização independentes", () => {
  it("ErpArea mantém os nativos antes dos grupos portados ao montar o menu final", () => {
    mocks.app.modules = { agenda: true, erp: true };
    const html = render();
    const headings = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1]);
    expect(headings[0]).toBe("Agenda");
    expect(headings[1]).toBe("Resultados");
  });

  it("entrada e menu usam grupos, nativos primeiro, com cinco destinos e Ver todos", () => {
    const c = context({ modules: { os: true, agenda: true, erp: true }, vocabulary: { collection_label: "Atendimentos" } });
    const items = resolveManagement(MANAGEMENT_ITEMS, c);
    const html = renderToString(React.createElement(ManagementShell, {
      context: c, items, entry: true, chromeRef: vi.fn(), children: null,
    }));
    const titles = [...new Set(items.map(item => item.module === "os" ? "Atendimentos" : item.groupLabel))];
    expect(titles.slice(0, 2)).toEqual(["Atendimentos", "Agenda"]);
    const headings = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1]);
    expect(headings).toEqual([...titles, ...titles]);
    expect(headings).not.toContain("Dashboard geral");
    const cards = [...html.split('class="management-cards"')[1].matchAll(/<section>([\s\S]*?)<\/section>/g)];
    expect(cards).toHaveLength(titles.length);
    for (const [index, card] of cards.entries()) {
      const destinations = items.filter(item => (item.module === "os" ? "Atendimentos" : item.groupLabel) === titles[index]);
      const links = [...card[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
      expect(links.map(link => link[2])).toEqual([
        ...destinations.slice(0, 5).map(item => item.resolvedLabel), ...(destinations.length > 5 ? ["Ver todos"] : []),
      ]);
      if (destinations.length > 5) expect(links.at(-1)![1]).toBe(destinations[0].href.replaceAll("&", "&amp;"));
    }
  });

  it("mantém administrador e pessoa elegível com todos os módulos desligados", () => {
    for (const c of [context(), context({ role: "agent", access: ["agenda"] })]) {
      expect(canEnterManagement(c)).toBe(true);
      expect(resolveManagement(MANAGEMENT_ITEMS, c)).toEqual([]);
      expect(managementEntryState(c, [])).toBe("empty");
    }
    expect(render()).toContain("Abrir Módulos");
    mocks.app.me = { id: "b", role: "agent", access: ["agenda"] }; mocks.app.isAdmin = false;
    expect(render()).toContain("Peça ao administrador em Gestão → Módulos");
  });

  it("não confunde status pendente ou falta de destinos com instalação vazia", () => {
    expect(managementEntryState(context({ statusLoaded: false }), [])).toBe("loading");
    const c = context({ role: "agent", access: ["os"], modules: { agenda: true } });
    expect(canEnterManagement(c)).toBe(true);
    expect(managementEntryState(c, resolveManagement(MANAGEMENT_ITEMS, c))).toBe("denied");
    expect(canEnterManagement(context({ role: "agent", access: [] }))).toBe(false);
    expect(canEnterManagement(context({ role: "agent", access: ["payments"] }))).toBe(false);
  });

  it("conta módulos, incluindo configurações e tipos no mesmo módulo", () => {
    const c = context({ modules: { agenda: true } });
    const agenda = resolveManagement(MANAGEMENT_ITEMS, c);
    expect(agenda.map((item) => item.id)).toEqual(["agenda.calendar", "agenda.settings"]);
    expect(managementLanding(agenda)).toBe("/app/erp/modulos/agenda");
    expect(managementLanding(agenda.slice(1))).toBe("/app/erp/modulos/servicos-e-horarios");
    expect(managementLanding([])).toBeNull();
    expect(managementLanding(resolveManagement(MANAGEMENT_ITEMS, context({ modules: { agenda: true, os: true } })))).toBeNull();
    expect(managementLanding([...agenda, { ...agenda[0], id: "agenda.extra", primary: false, href: "/app/erp/modulos/agenda?extra=1" }])).toBe(agenda[0].href);
  });

  it("conserva configurações administrativas, inclusive com estrela", () => {
    const c = context({ role: "agent", access: ["*"], modules: { agenda: true, os: true } });
    expect(resolveManagement(native, c).map((item) => item.id)).toEqual(["os.work", "os.deadlines", "agenda.calendar"]);
    expect(nativeTargetState("agenda-settings", c)).toBe("denied");
    expect(nativeTargetState("agenda", context())).toBe("disabled");
    expect(nativeTargetState("unknown", context())).toBe("not-found");
    expect(nativeTargetState("work", context({ statusLoaded: false }))).toBe("loading");
  });

  it.each([
    { access: null }, { access: ["*"] }, { access: ["erp"] }, { access: ["os"] },
    { access: ["erp:invalido"] }, { access: ["erp:invalido", "erp:consulta"] },
  ])("não inventa papel ERP com acesso $access", ({ access }) => {
    const c = context({ role: "agent", access, modules: { erp: true, os: true } });
    expect(c.erpRole).toBeNull();
    expect(resolveManagement(ERP_MANAGEMENT_ITEMS, c)).toEqual([]);
  });

  it("valida consulta e financeiro e permite nativos com acesso somente a os", () => {
    const consulta = resolveManagement(ERP_MANAGEMENT_ITEMS, context({ role: "agent", access: ["erp:consulta"], modules: { erp: true } }));
    expect(consulta.some((item) => item.id === "erp.customers")).toBe(true);
    expect(consulta.some((item) => item.id === "erp.products")).toBe(true);
    expect(consulta.some((item) => item.id === "erp.employees")).toBe(false);
    expect(managementLanding(consulta)).toBe("/app/erp/visao-geral");
    const financeiro = resolveManagement(ERP_MANAGEMENT_ITEMS, context({ role: "agent", access: ["erp:financeiro"], modules: { erp: true } }));
    expect(financeiro.some((item) => item.id === "erp.payables")).toBe(true);
    expect(financeiro.some((item) => item.id === "erp.products")).toBe(false);
    const os = resolveManagement(MANAGEMENT_ITEMS, context({ role: "agent", access: ["os"], modules: { os: true, erp: true } }));
    expect(os.map((item) => item.id)).toEqual(["os.work", "os.deadlines"]);
  });
});

describe("catálogo determinístico e vocabulário", () => {
  it("ordena grupo, ordem e id sem alterar a entrada; rejeita ids repetidos mesmo enquanto carrega", () => {
    const base = NATIVE_MANAGEMENT_ITEMS.agenda[0];
    const items: ManagementItem[] = [
      { ...base, id: "c", order: 20 }, { ...base, id: "b", order: 10 }, { ...base, id: "a", order: 10 },
    ];
    const before = items.map((item) => item.id);
    const resolved = resolveManagement(items, context({ modules: { agenda: true } }));
    expect(resolved.map((item) => item.id)).toEqual(["a"]);
    expect(items.map((item) => item.id)).toEqual(before);
    expect(() => resolveManagement([base, base], context({ statusLoaded: false }))).toThrow(/ID.*repetido/);
  });

  it("deduplica destino completo normalizado, preservando consultas e fragmentos distintos", () => {
    const base = ERP_MANAGEMENT_ITEMS[0];
    const make = (id: string, to: string, order: number): ManagementItem => ({ ...base, id, order, target: { kind: "ported", to } });
    const resolved = resolveManagement([
      make("b", "/acesso/?b=2&a=1#parte", 2), make("a", "/acesso?a=1&b=2#parte", 1),
      make("c", "/acesso?a=2&b=2#parte", 3), make("d", "/acesso?a=1&b=2#outra", 4),
    ], context({ modules: { erp: true } }));
    expect(resolved.map((item) => item.id)).toEqual(["a", "c", "d"]);
  });

  it("vocabulário muda apenas apresentação e usa somente tipos ativos autorizados", () => {
    const c = context({ modules: { os: true, erp: true }, vocabulary: { collection_label: "Projetos", customer_plural: "Pacientes" } });
    const result = resolveManagement(MANAGEMENT_ITEMS, c);
    expect(result.find((item) => item.id === "os.work")).toMatchObject({ resolvedLabel: "Projetos", module: "os", target: { kind: "native", page: "work" } });
    expect(result.find((item) => item.id === "erp.customers")?.resolvedLabel).toBe("Pacientes");
    mocks.catalog = [types("z", "Arquivados", true), types("b", "Projetos"), types("a", "Ordens", true, "builtin")];
    mocks.app.modules = { os: true };
    expect(activeNavigationTypes(mocks.catalog).map((type) => type.id)).toEqual(["b"]);
    expect(useWorkNavigation()).toMatchObject({ label: "Projetos", hasCustom: true, tasksEnabled: true });
    mocks.catalog = [types("service_order", "Ordens de serviço", false, "builtin")];
    expect(useWorkNavigation().label).toBe("Ordens de serviço");
  });

  it("não consulta tipos antes do status, com os desligado ou sem permissão", () => {
    mocks.app.statusLoaded = false; useWorkNavigation();
    mocks.app.statusLoaded = true; mocks.app.modules = { os: false }; useWorkNavigation();
    mocks.app.modules = { os: true }; mocks.app.me = { id: "b", role: "agent", access: ["agenda"] }; useWorkNavigation();
    expect(mocks.types).not.toHaveBeenCalled();
    mocks.app.me.access = ["os"]; useWorkNavigation();
    expect(mocks.types).toHaveBeenCalledExactlyOnceWith();
  });

  it("a chave do catálogo não reaproveita área, pessoa, acesso ou geração", () => {
    mocks.app.modules = { os: true };
    useWorkNavigation(); mocks.app.me.id = "outra"; useWorkNavigation();
    mocks.app.me.access = ["os"]; useWorkNavigation();
    mocks.app.contextGeneration++; useWorkNavigation();
    mocks.app.root = "v1/profiles/outra"; useWorkNavigation();
    expect(new Set(mocks.resource.mock.calls.map(([key]) => key)).size).toBe(5);
  });
});

describe("hospedagem leve e isolamento", () => {
  it("não importa portado nem antecipa /v1/me nos estados leves e na página nativa", () => {
    for (const state of ["loading", "disabled", "denied", "unavailable", "not-found"] as const) {
      expect(loadAuthorizedPorted(state, mocks.portedImport, mocks.prefetch)).toBeNull();
      startAuthorizedPortedPrefetch(state, { profile: "a", actor: "b", simulated: false }, mocks.prefetch).dispose();
    }
    render();
    mocks.app.statusLoaded = false; expect(render()).toContain("Abrindo a gestão");
    mocks.app.statusLoaded = true; mocks.app.modules = { agenda: true, os: true }; render();
    mocks.app.me = { id: "a", role: "agent", access: ["agenda"] }; mocks.app.isAdmin = false;
    mocks.route = { area: "erp", page: "agenda" }; expect(render()).toContain("Página nativa");
    mocks.route = { area: "erp", nativePath: "/desconhecido" }; expect(render()).toContain("Página não encontrada");
    mocks.app.me = { id: "a", role: "admin", access: null }; mocks.app.isAdmin = true;
    mocks.route = { area: "erp", erpPath: "/acesso" }; expect(render()).toContain("Módulo desligado");
    mocks.app.modules.erp = true; mocks.app.me = { id: "a", role: "agent", access: ["os"] };
    expect(render()).toContain("Você não tem acesso");
    expect(mocks.portedImport).not.toHaveBeenCalled(); expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.nativeRender).toHaveBeenCalledExactlyOnceWith("agenda");
  });

  it("autoriza antes da carga e consulta a política com a modalidade correta", async () => {
    const load = vi.fn(async () => "host");
    await expect(loadAuthorizedPorted("allowed", load, mocks.prefetch)).resolves.toBe("host");
    expect(load).toHaveBeenCalledOnce(); expect(mocks.prefetch).toHaveBeenCalledOnce();
    resolveManagement(ERP_MANAGEMENT_ITEMS, context({ modules: { erp: true } }), true);
    expect(mocks.policy.mock.calls.every(([, , simulated]) => simulated === true)).toBe(true);
  });

  it("prefetch só começa com destino autorizado, ator e motor real", () => {
    startAuthorizedPortedPrefetch("allowed", { profile: "a", actor: "b", simulated: true }, mocks.prefetch).dispose();
    startAuthorizedPortedPrefetch("allowed", { profile: "a", actor: "", simulated: false }, mocks.prefetch).dispose();
    expect(mocks.prefetch).not.toHaveBeenCalled();
    const operation = startAuthorizedPortedPrefetch("allowed", { profile: "a", actor: "b", simulated: false }, mocks.prefetch);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith("/api/v1/profiles/a/erp", "b", expect.any(Function));
    operation.dispose(); operation.dispose();
  });

  it("A → B → A e eventos de módulo invalidam gerações anteriores", () => {
    const generation = createManagementGeneration();
    const a = generation.update("area-a:pessoa-a");
    generation.update("area-b:pessoa-b"); generation.update("area-a:pessoa-a");
    expect(generation.current(a)).toBe(false);
    const current = generation.capture(); generation.invalidate(); expect(generation.current(current)).toBe(false);
  });

  it("descarta status atrasado e bloqueia leituras e ações durante a suspensão", async () => {
    let finish!: (data: unknown) => void;
    const network = vi.fn((_path: string, _method?: string, _body?: unknown, _signal?: AbortSignal) => new Promise((resolve) => { finish = resolve; }));
    const scope = createManagementRequestScope(network);
    scope.update("area-a:pessoa-a:acesso-a", true);
    const late = scope.api("v1/profiles/area-a/status");
    scope.update("area-b:pessoa-b:acesso-b", true);
    expect(network.mock.calls[0][3]?.aborted).toBe(true);
    finish({ modules: { erp: true } });
    await expect(late).rejects.toMatchObject({ name: "AbortError" });
    scope.update("modulo-desligado", false);
    await expect(scope.api("consulta")).rejects.toMatchObject({ name: "AbortError" });
    await expect(scope.api("acao", "POST", {})).rejects.toMatchObject({ name: "AbortError" });
    expect(network).toHaveBeenCalledOnce();
    scope.dispose(); scope.dispose(); scope.update("area-a:pessoa-a:acesso-a", true);
    await expect(scope.api("consulta")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("um prefetch já respondido não entrega dados após revogação", async () => {
    const controller = new AbortController();
    const response = await contextBoundResponse(new Response('{"pessoa":"anterior"}'), controller.signal);
    expect(response.ok).toBe(true);
    controller.abort();
    expect(response.ok).toBe(false);
    await expect(response.json()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prepara encaixe sem host-port e só instala com autorização, descartando resolução tardia", async () => {
    await createDeferredHostSlot(() => true).open();
    let allowed = false;
    let finish!: (value: { dispose(): void }) => void;
    const dispose = vi.fn(); const install = vi.fn(() => new Promise<{ dispose(): void }>((resolve) => { finish = resolve; }));
    const slot = createDeferredHostSlot(() => allowed, install);
    await slot.open(); expect(install).not.toHaveBeenCalled();
    allowed = true; const pending = slot.open(); slot.open(); expect(install).toHaveBeenCalledOnce();
    slot.dispose(); slot.dispose(); finish({ dispose }); await pending; expect(dispose).toHaveBeenCalledOnce();
    await slot.open(); expect(install).toHaveBeenCalledOnce();
    const installed = vi.fn(); const next = createDeferredHostSlot(() => true, async () => ({ dispose: installed }));
    await next.open(); next.dispose(); next.dispose(); expect(installed).toHaveBeenCalledOnce();
    const revoked = createDeferredHostSlot(() => allowed, install);
    const revoking = revoked.open(); allowed = false; finish({ dispose }); await revoking;
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
