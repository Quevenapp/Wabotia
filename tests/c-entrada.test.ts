import React from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import { accessAllows, canOpenPage } from "../web/workspace-navigation";
import { nativeReadAllows } from "../web/management/native-access";
import { managementContext, nativeTargetState, resolveManagement } from "../web/management/registry";
import mainSource from "../web/main.tsx?raw";

type HookOwner = { index: number; slots: any[]; effects: (() => void)[] };
const runtime = vi.hoisted(() => ({
  app: {} as Record<string, any>,
  owner: null as HookOwner | null,
  publicImports: [] as string[],
  publicWait: null as Promise<void> | null,
  rootRender: vi.fn(),
}));

// Efeitos e eventos reais das telas, com fronteiras DOM/API controladas.
// Suspense e renderização dos imports usam React real.
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const memo = (compute: () => any, deps?: readonly unknown[]) => {
    const owner = runtime.owner!, index = owner.index++, old = owner.slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i])))
      owner.slots[index] = { deps, value: compute() };
    return owner.slots[index].value;
  };
  return {
    ...actual,
    useState: (initial: any) => {
      if (!runtime.owner) return actual.useState(initial);
      const owner = runtime.owner, index = owner.index++;
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
      return [owner.slots[index], (value: any) => {
        owner.slots[index] = typeof value === "function" ? value(owner.slots[index]) : value;
      }];
    },
    useMemo: (compute: () => any, deps?: readonly unknown[]) =>
      runtime.owner ? memo(compute, deps) : actual.useMemo(compute, deps!),
    useCallback: (fn: (...args: any[]) => any, deps: readonly unknown[]) =>
      runtime.owner ? memo(() => fn, deps) : actual.useCallback(fn, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!runtime.owner) return actual.useEffect(effect, deps);
      const owner = runtime.owner, index = owner.index++, old = owner.slots[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i])))
        owner.effects.push(() => {
          old?.cleanup?.();
          owner.slots[index] = { deps, cleanup: effect() };
        });
    },
    useSyncExternalStore: (subscribe: any, snapshot: any, server: any) =>
      runtime.owner ? snapshot() : actual.useSyncExternalStore(subscribe, snapshot, server),
  };
});
vi.mock("../web/app/AppContext", () => ({ useApp: () => runtime.app }));
vi.mock("../web/lib/api", () => ({ useIntents: () => runtime.app.api }));
vi.mock("../web/modules/juridico/Calendars", () => ({ Calendars: () => React.createElement("p", null, "Calendários disponíveis") }));
vi.mock("../web/modules/juridico/CreateDeadline", () => ({ CreateDeadline: () => React.createElement("p", null, "Criar prazo") }));
vi.mock("../web/lib/theme", () => ({ useTheme: () => ({ mode: "system", theme: "light", setMode: vi.fn() }) }));
vi.mock("../web/lib/source", () => ({ useSourceLink: () => ({ url: "/fonte" }), sourceLinkLabel: () => "Código-fonte" }));
vi.mock("../web/app/Account", () => ({ AccountDialog: () => null }));
vi.mock("../web/app/chrome", () => ({ PreferencesDialog: () => null, PresenceDialog: () => null, ShortcutsDialog: () => null, ThemePicker: () => null }));
vi.mock("../web/app/App", () => ({ App: () => React.createElement("p", null, "Painel") }));
vi.mock("../web/site/Landing", () => ({ Landing: () => null }));
vi.mock("../web/site/Install", () => ({ Install: () => null }));
vi.mock("../web/site/WebInstall", () => ({ WebInstall: () => null }));
vi.mock("../web/site/Privacy", () => ({ Privacy: () => null }));
vi.mock("../web/site/ApiDocs", () => ({ ApiDocs: () => null }));
vi.mock("../web/queue/QueueDisplay", () => ({ QueueDisplay: () => null }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: runtime.rootRender }) }));
vi.mock("../web/modules/ensino/ResponsiblePage", async () => {
  runtime.publicImports.push("responsavel");
  await runtime.publicWait;
  return { ResponsiblePage: () => React.createElement("p", null, "Consulta escolar") };
});
vi.mock("../web/modules/condominio/MoradorPage", async () => {
  runtime.publicImports.push("morador");
  await runtime.publicWait;
  return { MoradorPage: () => React.createElement("p", null, "Portal do morador") };
});

const owners: HookOwner[] = [];
function hooks<T>(render: () => T) {
  const owner: HookOwner = { index: 0, slots: [], effects: [] };
  owners.push(owner);
  return {
    draw() {
      owner.index = 0; runtime.owner = owner;
      try { return render(); } finally { runtime.owner = null; }
    },
    effects() { owner.effects.splice(0).forEach(effect => effect()); },
  };
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement(child)) return [];
    const element = child as React.ReactElement<any>;
    return [element, ...elements(element.props.children)];
  });
}
const button = (tree: React.ReactNode, text: string) =>
  elements(tree).find(el => el.type === "button" && el.props.children === text)!;
async function markup(element: React.ReactElement, onError?: (error: unknown) => void) {
  const stream = await renderToReadableStream(element, { onError });
  const text = new Response(stream).text();
  await stream.allReady;
  return text;
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const native = Object.values(NATIVE_MANAGEMENT_ITEMS).flat();
const context = (role: string, access: string[] | null) => managementContext({
  statusLoaded: true, role, access,
  modules: { ensino: true, juridico: true, os: true, agenda: true, erp: true },
});

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  runtime.publicImports = []; runtime.publicWait = null;
  runtime.app = {
    profile: "area-a", root: "v1/profiles/area-a", statusLoaded: true,
    me: { id: "pessoa-a", name: "Pessoa", role: "agent", access: [] },
    modules: { juridico: true, os: true, erp: true },
    moduleOn: (id: string) => runtime.app.modules[id] === true,
    api: vi.fn(async () => ({ data: [], next_cursor: null })),
    names: {}, profiles: [], ticketCounts: {}, ringingCalls: [],
  };
  vi.stubGlobal("location", Object.assign(new URL("https://panel.test/app"), { reload: vi.fn() }));
  vi.stubGlobal("document", { getElementById: () => ({}), hidden: false });
});
afterEach(() => {
  runtime.owner = null;
  owners.splice(0).forEach(owner => owner.slots.forEach(slot => slot?.cleanup?.()));
  vi.unstubAllGlobals();
});

describe("A3 — leitura nativa explícita", () => {
  it.each([
    ["admin", null], ["admin", []], ["admin", ["*"]],
    ["agent", null], ["agent", ["*"]], ["agent", ["ensino"]],
  ] as const)("Ensino conserva navegação legada e recusa leitura na casa para %s com %j", (role, input) => {
    const access = input && [...input], c = context(role, access);
    // A navegação geral conserva o contrato legado; a casa aplica os papéis de leitura.
    expect(accessAllows("ensino", role, access)).toBe(role === "admin" || !access);
    expect(canOpenPage("ensino", role, c.modules, access)).toBe(role === "admin" || !access);
    expect(resolveManagement(native, c).some(item => item.module === "ensino")).toBe(false);
    expect(nativeTargetState("ensino", c)).toBe("denied");
  });

  it.each(["ensino:secretaria", "ensino:professor"])("%s conserva menu e abertura", grant => {
    for (const role of ["admin", "agent"]) {
      const c = context(role, [grant]);
      expect(canOpenPage("ensino", role, c.modules, [grant])).toBe(true);
      expect(resolveManagement(native, c).some(item => item.module === "ensino")).toBe(true);
      expect(nativeTargetState("ensino", c)).toBe("allowed");
    }
  });

  it.each([
    { access: null, calendars: false, deadlines: false },
    { access: ["*"], calendars: false, deadlines: false },
    { access: ["juridico"], calendars: false, deadlines: false },
    { access: ["os:sensitive"], calendars: false, deadlines: false },
    { access: ["juridico:lawyer"], calendars: false, deadlines: false },
    { access: ["juridico:curator"], calendars: false, deadlines: false },
    { access: ["os:sensitive", "juridico:curator"], calendars: true, deadlines: false },
    { access: ["os:sensitive", "juridico:lawyer"], calendars: true, deadlines: true },
    { access: ["os:sensitive", "juridico:lawyer", "juridico:curator"], calendars: true, deadlines: true },
  ])("Jurídico separa calendários e prazos para $access", ({ access, calendars, deadlines }) => {
    for (const role of ["admin", "agent"]) {
      const c = context(role, access);
      expect(accessAllows("juridico", role, access)).toBe(role === "admin" || !access || calendars);
      expect(canOpenPage("juridico", role, c.modules, access)).toBe(role === "admin" || !access || calendars);
      expect(resolveManagement(native, c).some(item => item.module === "juridico")).toBe(calendars);
      expect(nativeTargetState("juridico", c)).toBe(calendars ? "allowed" : "denied");
      expect(nativeReadAllows("juridico.deadlines", access)).toBe(deadlines);
    }
  });

  // "Meus prazos" deixou de ser item do menu (ordem de serviço, parte 1): abre
  // de dentro da lista. A página continua permitida ao técnico; a entrada no
  // menu que leva até ela é a da lista ("work").
  it.each([["agenda", "agenda", "agenda"], ["work", "os", "work"], ["my-deadlines", "os:technician", "work"]])(
    "%s mantém acesso nativo %s sem papel ERP", (page, grant, entry) => {
      const c = context("agent", [grant]);
      expect(c.erpRole).toBeNull();
      expect(canOpenPage(page, c.role, c.modules, [grant])).toBe(true);
      expect(canOpenPage(entry, c.role, c.modules, [grant])).toBe(true);
      expect(nativeTargetState(page, c)).toBe("allowed");
      expect(resolveManagement(native, c).some(item => item.target.kind === "native" && item.target.page === entry)).toBe(true);
    },
  );

  it("curador começa em Calendários e atualizar não consulta responsáveis, prazos ou alertas", async () => {
    runtime.app.me.access = ["os:sensitive", "juridico:curator"];
    const { PrazosPage } = await import("../web/modules/juridico/PrazosPage");
    const content = PrazosPage() as React.ReactElement<any>;
    const page = hooks(() => (content.type as Function)(content.props));
    let tree = page.draw(); page.effects(); await settle(); tree = page.draw();
    expect(button(tree, "Calendários").props["aria-pressed"]).toBe(true);
    expect(button(tree, "Prazos")).toBeUndefined();
    expect(button(tree, "Novo prazo")).toBeUndefined();
    expect(renderToString(tree)).toContain("Calendários disponíveis");
    await button(tree, "Atualizar").props.onClick(); page.draw(); page.effects(); await settle();
    expect(runtime.app.api.mock.calls.map(([path]: [string]) => path)).toEqual([
      "v1/profiles/area-a/juridico/calendars", "v1/profiles/area-a/juridico/calendars",
    ]);
  });

  it("advogado conserva consultas de prazos; revogação para curador cancela as leituras privativas", async () => {
    runtime.app.me.access = ["os:sensitive", "juridico:lawyer"];
    const { PrazosPage } = await import("../web/modules/juridico/PrazosPage");
    const content = PrazosPage() as React.ReactElement<any>;
    const page = hooks(() => (content.type as Function)(content.props));
    const tree = page.draw(); page.effects(); await settle();
    expect(button(tree, "Prazos").props["aria-pressed"]).toBe(true);
    expect(runtime.app.api.mock.calls.map(([path]: [string]) => path.split("/juridico/")[1].split("?")[0]))
      .toEqual(["calendars", "assignees", "deadlines", "alerts"]);
    const signals = runtime.app.api.mock.calls.map((call: any[]) => call[3] as AbortSignal);
    runtime.app.api.mockClear();
    runtime.app.me.access = ["os:sensitive", "juridico:curator"];
    const revoked = page.draw(); page.effects(); await settle();
    expect(button(revoked, "Calendários").props["aria-pressed"]).toBe(true);
    expect(button(revoked, "Prazos")).toBeUndefined();
    expect(signals.every((signal: AbortSignal) => signal.aborted)).toBe(true);
    expect(runtime.app.api.mock.calls.map(([path]: [string]) => path)).toEqual(["v1/profiles/area-a/juridico/calendars"]);
  });
});

describe("A8 — entrada móvel restrita", () => {
  it("Mais não concede acesso a destinos desconhecidos nem altera a lista da pessoa", () => {
    const access = ["conversations", "tickets", "team", "calls", "erp:consulta"];
    expect(accessAllows("more", "agent", access)).toBe(true);
    expect(accessAllows("more", "agent", [])).toBe(true);
    for (const page of ["desconhecida", "contacts", "queue"])
      expect(accessAllows(page, "agent", access)).toBe(false);
    expect(access).toEqual(["conversations", "tickets", "team", "calls", "erp:consulta"]);
  });

  it("quatro primeiras abas → Mais → ERP usa a casca e a navegação reais", async () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    let state: unknown = null;
    const locate = (_state: unknown, _title: string, url: string) => {
      state = _state; vi.stubGlobal("location", new URL(url, "https://panel.test"));
    };
    vi.stubGlobal("history", { get state() { return state; }, pushState: locate, replaceState: locate });
    locate(null, "", "/app/conversas");
    runtime.app.me.access = ["conversations", "tickets", "team", "calls", "erp:consulta"];
    const routes = await import("../web/lib/routes");
    const { Shell } = await import("../web/app/Shell");
    const { MoreArea } = await import("../web/app/MoreArea");
    const shell = hooks(() => Shell({ children: React.createElement("p", null, "Conteúdo autorizado") }));
    const tree = shell.draw(); shell.effects();
    const tabbar = elements(tree).find(el => el.props.className === "tabbar")!;
    const tabs = React.Children.toArray(tabbar.props.children) as React.ReactElement<any>[];
    expect(tabs.map(el => el.props.item.area)).toEqual(["conversations", "tickets", "team", "calls", "more"]);
    const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn() };
    const moreLink = (tabs[4].type as Function)(tabs[4].props);
    moreLink.props.onClick(click);
    expect(location.pathname).toBe("/app/mais");
    const moreShell = shell.draw(); shell.effects();
    expect(location.pathname).toBe("/app/mais");
    const rail = elements(moreShell).find(el => el.props.className === "rail-items")!;
    const railItems = React.Children.toArray(rail.props.children) as React.ReactElement<any>[];
    expect(railItems.map(el => el.props.item.area)).toEqual(["conversations", "tickets", "team", "calls", "erp", "admin"]);
    expect(renderToString(moreShell)).toContain("Conteúdo autorizado");
    const more = hooks(() => MoreArea());
    const erpLink = elements(more.draw()).find(el => el.type === "a" && el.props.href === "/app/erp")!;
    expect(erpLink).toBeDefined(); erpLink.props.onClick(click);
    expect(routes.currentRoute().area).toBe("erp"); shell.draw(); shell.effects();
    expect(location.pathname).toBe("/app/erp");
    expect(runtime.app.api).not.toHaveBeenCalled();
  });
});

describe("R8 — páginas públicas sob demanda", () => {
  it("abrir /app não importa páginas públicas nem suas folhas", async () => {
    const { SiteEntry } = await import("../web/main");
    expect(runtime.rootRender).toHaveBeenCalledOnce();
    expect(await markup(React.createElement(SiteEntry, { pathname: "/app" }))).toContain("Painel");
    expect(runtime.publicImports).toEqual([]);
    expect(mainSource).not.toMatch(/^import .*from ["']\.\/modules\/(ensino|condominio)\//m);
    expect(mainSource).not.toMatch(/^import ["'].*(?:ensino|condominio)\.css["']/m);
  });

  it.each([
    ["/ensino/acesso", "responsavel", "Consulta escolar"],
    ["/condominio/acesso", "morador", "Portal do morador"],
  ])("%s carrega somente sua página e mostra espera", async (pathname, name, label) => {
    let finish!: () => void;
    runtime.publicWait = new Promise<void>(resolve => { finish = resolve; });
    const { SiteEntry } = await import("../web/main");
    expect(runtime.publicImports).toEqual([]);
    const stream = await renderToReadableStream(React.createElement("main", null, React.createElement(SiteEntry, { pathname })));
    const reader = stream.getReader();
    const pending = new TextDecoder().decode((await reader.read()).value);
    expect(pending).toContain('role="status"'); expect(pending).toContain("Abrindo a página");
    expect(pending).not.toContain(label);
    finish();
    let loaded = "";
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      loaded += new TextDecoder().decode(part.value);
    }
    expect(loaded).toContain(label);
    expect(runtime.publicImports).toEqual([name]);
  });

  it("a recuperação usada pela entrada repete somente import falho e permite recarregar", async () => {
    const { lazyWithRecovery } = await import("../web/management/pages");
    const save = vi.fn();
    const load = vi.fn().mockRejectedValueOnce(new Error("chunk indisponível")).mockResolvedValue({
      default: () => React.createElement("button", { onClick: save }, "Página disponível"),
    });
    const Deferred = lazyWithRecovery<object>(load);
    const page = hooks(() => Deferred({}) as React.ReactElement<any>);
    const tree = page.draw(), errors: unknown[] = [];
    await markup(tree.props.children, error => { errors.push(error); });
    expect(errors).toHaveLength(1);
    const Boundary = tree.type as any, boundary = new Boundary(tree.props);
    boundary.state = Boundary.getDerivedStateFromError(errors[0]);
    const failed = boundary.render();
    expect(renderToString(failed)).toContain("Não foi possível abrir a página");
    const actions = React.Children.toArray(failed.props.action.props.children) as React.ReactElement<any>[];
    expect(actions.map(el => el.props.children)).toEqual(["Tentar novamente", "Recarregar"]);
    actions[1].props.onClick(); expect(location.reload).toHaveBeenCalledOnce();
    actions[0].props.onClick();
    const retry = page.draw(); expect(retry.key).not.toBe(tree.key);
    expect(await markup(retry.props.children)).toContain("Página disponível");
    expect(load).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
    boundary.state = Boundary.getDerivedStateFromError(new Error("falha após montagem"));
    const contentError = boundary.render();
    expect(React.Children.toArray(contentError.props.action.props.children)).toHaveLength(1);
    expect(mainSource).toContain("const ResponsiblePage = lazyWithRecovery<object>(");
    expect(mainSource).toContain("const MoradorPage = lazyWithRecovery<object>(");
  });
});
