import React, { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router-dom";
import { useAction } from "../web/app/hooks";
import { ErpArea, holdManagementDraft, loadAuthorizedPorted, startAuthorizedPortedPrefetch } from "../web/erp/ErpArea";
import ErpMount, { connectErpRouter, internalErpTarget, keepLinksInside, registerErpGuard } from "../web/erp/mount";
import { acquireErpHost, erpHostKey, type ErpHostRuntime } from "../web/erp/host-runtime";
import { HostedContent } from "../web/erp/app/components/RealAccess";
import { erpPorts } from "../web/erp/ports";
import { targetEnabled } from "../web/erp/blocks";
import { createUnsavedChangesStore } from "../web/erp/app/lib/unsaved-changes-store";
import { financeListRoute } from "../web/erp/app/lib/finance-list-route";
import { borderoRoute } from "../web/erp/app/lib/finance-bordero-route";
import { ERP_CORE_TEST_MODULES } from "./erp-module-helper";
import { ROLE_RESOURCES } from "../src/erp/role-resources";
import { portedPermissionAllowed, portedPermissionState, portedTargetState } from "../web/management/ported-policy";
import { MANAGEMENT_ITEMS, managementContext, resolveManagement } from "../web/management/registry";
import { href, parseRoute } from "../web/lib/routes";
import type { ErpHostContext, ErpPermissions } from "../web/management/host-contract";

const env = vi.hoisted(() => ({ frame: null as any, guard: null as null | (() => boolean), store: null as any,
  app: {} as any, route: {} as any, location: { pathname: "/acesso", search: "", hash: "" },
  publish: vi.fn(), toast: vi.fn(), toastError: vi.fn(), navigate: vi.fn(), demoBlocked: () => false,
}));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const frame = env.frame, index = frame.index++;
    if (!(index in frame.slots)) frame.slots[index] = typeof initial === "function" ? initial() : initial;
    return [frame.slots[index], (next: any) => { frame.slots[index] = typeof next === "function" ? next(frame.slots[index]) : next; }];
  };
  const useMemo = (compute: () => any, deps: unknown[]) => {
    const frame = env.frame, index = frame.index++, old = frame.slots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) frame.slots[index] = { value: compute(), deps };
    return frame.slots[index].value;
  };
  const useEffect = (factory: () => any, deps?: unknown[]) => {
    const frame = env.frame, index = frame.index++, old = frame.slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
      const effect = { factory, deps, cleanup: old?.cleanup, effect: true };
      frame.slots[index] = effect;
      frame.pending.push(effect);
    }
  };
  return { ...actual, useState, useRef: (value: any) => useState(() => ({ current: value }))[0], useMemo,
    useCallback: (callback: any, deps: unknown[]) => useMemo(() => callback, deps), useEffect, useLayoutEffect: useEffect,
    useSyncExternalStore: (_subscribe: any, snapshot: () => any) => snapshot(), useContext: (c: any) => c._currentValue,
  };
});
vi.mock("../web/lib/routes", async original => ({ ...await original<typeof import("../web/lib/routes")>(),
  useRoute: () => env.route, navigate: env.navigate,
  setNavigationGuard: (check: (() => boolean) | null) => { env.guard = check; }, navigationGuarded: () => !!env.guard?.(),
  bindManagementRouter: () => ({ publish: env.publish, dispose() {} }),
}));
vi.mock("react-router-dom", async original => ({ ...await original<typeof import("react-router-dom")>(),
  useLocation: () => env.location, useNavigate: () => env.navigate,
}));
vi.mock("../web/app/AppContext", () => ({ useApp: () => ({ ...env.app, demoBlocked: env.demoBlocked }), ManagementRequestBoundary: ({ children }: any) => children }));
vi.mock("../web/modules/os/work-navigation", () => ({ useWorkNavigation: () => ({ types: [], label: "Trabalhos" }) }));
vi.mock("../web/ui", () => ({ toast: env.toast, toastError: env.toastError, Button: "button", Empty: "section", Spinner: "span" }));
vi.mock("../web/erp/fetch-port", async original => ({ ...await original<typeof import("../web/erp/fetch-port")>(), erpSimulated: () => false }));
vi.mock("../web/erp/app/hooks/useUnsavedChanges", () => ({
  UnsavedChangesProvider: ({ children }: any) => children,
  useUnsavedChangesGuard: () => ({ store: env.store, confirmLeave: (fn: () => void) => fn() }),
}));

// Ciclo de hooks determinístico, incluindo a limpeza/reinstalação que Activity faz.
// O roteador e o controlador são reais; não simula layout ou interação visual.
class Frame {
  slots: any[] = []; index = 0; pending: any[] = [];
  render<T>(fn: () => T): T { this.index = 0; env.frame = this; try { return fn(); } finally { env.frame = null; } }
  commit() { for (const effect of this.pending.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.factory(); } }
  suspend() { for (const slot of this.slots) if (slot?.effect) { slot.cleanup?.(); slot.cleanup = undefined; } }
  resume() { for (const slot of this.slots) if (slot?.effect) slot.cleanup = slot.factory(); }
}
const cleanup: (() => void)[] = [];
const own = <T extends { dispose(): void }>(value: T): T => { cleanup.push(() => value.dispose()); return value; };
const frame = () => { const value = new Frame(); cleanup.push(() => value.suspend()); return value; };
const actor = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const stock = "/estoque-empresa", permission = "suprimentos.controle_estoque";
const context = (modules: Record<string, boolean> = { ...ERP_CORE_TEST_MODULES, agenda: true }, role = "consulta") => managementContext({ statusLoaded: true, modules, role: "operator", access: [`erp:${role}`] });
const host = (change: Partial<ErpHostContext> = {}): ErpHostContext => ({ profile: "area-a", actor, demo: false, management: context(), onModules() {}, onPeople() {}, onLeave() {}, onExpired() {}, ...change });
const member = (user_id = actor, role = "consulta") => ({ user_id, role, resources: ROLE_RESOURCES[role], data_mode: "staging_readonly" });
const permissions = (keys: string[] | null = [permission], user_id = actor, role = "consulta") => ({ scope: "access_permissions", data_mode: "erp_native", user_id, role, user_type: "normal", permissions: keys, access: { open: true, until: null } });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const ready = async (runtime: ErpHostRuntime) => { await vi.waitFor(() => expect(runtime.controller.getSnapshot().phase).toBe("ready")); };
let fetcher: ReturnType<typeof vi.fn>;
function nodes(tree: any): any[] { return Array.isArray(tree) ? tree.flatMap(nodes) : React.isValidElement(tree) ? [tree, ...nodes((tree.props as any).children)] : []; }
function text(tree: any): string { return Array.isArray(tree) ? tree.map(text).join("") : React.isValidElement(tree) ? text((tree.props as any).children) : tree == null ? "" : String(tree); }
beforeEach(() => {
  vi.clearAllMocks(); env.guard = null; env.store = createUnsavedChangesStore(); env.location = { pathname: "/acesso", search: "", hash: "" };
  vi.stubGlobal("location", new URL("https://panel.test/app/erp/acesso"));
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  fetcher = vi.fn(async (input: unknown) => String(input).endsWith("/v1/me") ? Response.json(member()) : String(input).endsWith("/v1/sistema/permissoes") ? Response.json(permissions()) : Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  env.app = { profile: "area-a", identityKey: "legacy", contextGeneration: 1, me: { id: actor, role: "operator", access: ["erp:consulta"] }, demo: false, modules: { ...ERP_CORE_TEST_MODULES, agenda: true }, statusLoaded: true, settings: {}, onEvents: () => () => {}, reloadSession: vi.fn() };
  env.route = parseRoute(location.pathname, location.search);
});
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); });

describe("A1/R1 — identidade e suspensão", () => {
  it("Agenda conserva o dono, roteador, editor alterado e guarda; suspensão não libera o último dono", async () => {
    const mounting = frame(), tree = frame(), editor = frame();
    let props = { ...host(), embedded: true as const, chromeTarget: null };
    mounting.render(() => ErpMount(props)); mounting.commit(); await tick();
    const mounted: any = mounting.render(() => ErpMount(props)); mounting.commit();
    tree.render(() => mounted.type(mounted.props)); tree.commit();
    const view: any = tree.render(() => mounted.type(mounted.props)); tree.commit();
    const runtime = view.props.value.runtime, router = view.props.value.router;
    await ready(runtime); await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready")); expect(router).toBeTruthy();
    const dispose = vi.spyOn(router, "dispose");
    const Editor = () => { const [draft, setDraft] = useState("Original"); useEffect(() => registerErpGuard(() => draft !== "Original"), [draft]); return { draft, setDraft }; };
    const initialEditor = editor.render(Editor); editor.commit(); initialEditor.setDraft("Alterado"); editor.render(Editor); editor.commit(); expect(env.guard?.()).toBe(true);
    const key = erpHostKey(props);
    const reads = fetcher.mock.calls.length;
    props = { ...props, management: context({ ...ERP_CORE_TEST_MODULES, agenda: false }) };
    const updated: any = mounting.render(() => ErpMount(props)); mounting.commit();
    const same: any = tree.render(() => updated.type(updated.props)); tree.commit();
    expect(erpHostKey(props)).toBe(key); expect(updated.type).toBe(mounted.type); expect(updated.props.runtime).toBe(runtime);
    expect(same.props.value.router).toBe(router); expect(editor.render(Editor).draft).toBe("Alterado"); expect(env.guard?.()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(reads);
    const checks = () => fetcher.mock.calls.filter(([path]) => String(path).endsWith("/v1/me")).length;
    for (const event of ["focus", "erp:permissions-changed"]) {
      const count = checks(); window.dispatchEvent(new Event(event)); await vi.waitFor(() => expect(checks()).toBeGreaterThan(count));
      await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready"));
    }
    const count = checks(); await router.navigate("/acesso#retomada"); await vi.waitFor(() => expect(checks()).toBeGreaterThan(count));
    expect(editor.render(Editor).draft).toBe("Alterado");
    props = { ...props, suspended: true, management: context({ erp: false, agenda: false }) };
    const hidden: any = mounting.render(() => ErpMount(props)); mounting.commit();
    const hiddenTree: any = tree.render(() => hidden.type(hidden.props)); tree.commit(); editor.suspend();
    expect(nodes(hiddenTree).find(node => node.type === React.Activity)?.props.mode).toBe("hidden");
    expect(erpPorts()).toBe(runtime.ports); expect(dispose).not.toHaveBeenCalled();
    await expect(runtime.controller.catalog("/v1/cadastros")).rejects.toMatchObject({ name: "AbortError" });
    props = { ...props, suspended: false, management: context() };
    const resumed: any = mounting.render(() => ErpMount(props)); mounting.commit(); tree.render(() => resumed.type(resumed.props)); tree.commit(); editor.resume();
    await tick(); expect(editor.render(Editor).draft).toBe("Alterado"); expect(env.guard?.()).toBe(true); expect(dispose).not.toHaveBeenCalled();
    tree.suspend(); mounting.suspend(); expect(dispose).toHaveBeenCalledTimes(1); expect(erpPorts()).toBeNull();
  });

  it("aborta leituras e ações antigas, bloqueia novas na suspensão e separa pessoa/área", async () => {
    const lease = own(acquireErpHost(host())), runtime = await lease.ready; await ready(runtime);
    const late = deferred<Response>(), lateRead = deferred<Response>(); let signal!: AbortSignal, readSignal!: AbortSignal;
    fetcher.mockImplementationOnce((_path, init) => { signal = init.signal; return late.promise; });
    const action = runtime.controller.catalog("/v1/cadastros/contatos", { method: "POST", body: { synthetic: true } });
    const rejection = expect(action).rejects.toMatchObject({ name: "AbortError" }); await tick();
    fetcher.mockImplementationOnce((_path, init) => { readSignal = init.signal; return lateRead.promise; });
    const reading = runtime.controller.catalog("/v1/cadastros/contatos/atrasado");
    const readRejection = expect(reading).rejects.toMatchObject({ name: "AbortError" }); await tick();
    lease.update(host({ suspended: true })); expect(signal.aborted).toBe(true);
    expect(readSignal.aborted).toBe(true);
    const count = fetcher.mock.calls.length;
    await expect(runtime.ports.fetch("/api/v1/profiles/area-a/erp/v1/me")).rejects.toMatchObject({ name: "AbortError" });
    await expect(runtime.controller.catalog("/v1/cadastros")).rejects.toMatchObject({ name: "AbortError" });
    await expect(runtime.controller.catalog("/v1/cadastros/contatos", { method: "POST" })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(count); late.resolve(Response.json({ saved: true })); lateRead.resolve(Response.json({ record: "antigo" })); await rejection; await readRejection;
    lease.update(host()); await tick(); expect(await lease.ready).toBe(runtime); expect(runtime.allowed("/acesso")).toBe(true);
    const newer = own(acquireErpHost(host({ actor: other, profile: "area-b" }))); const replacement = await newer.ready;
    expect(replacement).not.toBe(runtime); expect(runtime.allowed("/acesso")).toBe(false); expect(runtime.controller.getSnapshot().membership).toBeNull();
    expect(erpHostKey(host({ profile: "area-b" }))).not.toBe(erpHostKey(host()));
    expect(erpHostKey(host({ actor: other }))).not.toBe(erpHostKey(host()));
  });
  it("um 401 antigo não encerra o runtime depois da retomada", async () => {
    const expired = vi.fn(), options = host({ onExpired: expired });
    const lease = own(acquireErpHost(options)), runtime = await lease.ready; await ready(runtime);
    const late = deferred<Response>(); fetcher.mockImplementationOnce(() => late.promise);
    const read = runtime.controller.catalog("/v1/cadastros/contatos/antigo");
    const rejection = expect(read).rejects.toMatchObject({ name: "AbortError" }); await tick();
    lease.update({ ...options, suspended: true }); lease.update(options); await tick();
    late.resolve(Response.json({}, { status: 401 })); await rejection;
    expect(expired).not.toHaveBeenCalled(); expect(runtime.allowed("/acesso")).toBe(true);
  });
});

describe("A2 — gerações de useAction", () => {
  it("instala, limpa e reinstala; conclusão antiga não limpa uma ação nova nem avisa sucesso", async () => {
    const f = frame(), old = deferred<string>(), current = deferred<string>();
    f.render(useAction); f.commit();
    const first = f.render(useAction).run(() => old.promise, { key: "old", success: "Antiga" });
    expect(f.render(useAction).busyKey).toBe("old"); f.suspend();
    const blocked = vi.fn(async () => "indevido"); await f.render(useAction).run(blocked); expect(blocked).not.toHaveBeenCalled();
    f.resume(); expect(f.render(useAction).busy).toBe(false);
    const next = f.render(useAction).run(() => current.promise, { key: "new", success: "Nova" });
    old.resolve("tardio"); expect(await first).toBeUndefined(); expect(env.toast).not.toHaveBeenCalled(); expect(f.render(useAction).busyKey).toBe("new");
    current.resolve("atual"); expect(await next).toBe("atual"); expect(f.render(useAction).busy).toBe(false); expect(env.toast).toHaveBeenCalledExactlyOnceWith("Nova");
  });
  it("cancelamento/erro durante suspensão não publica conclusão nem erro tardio", async () => {
    const f = frame(), pending = deferred<void>(); f.render(useAction); f.commit();
    const action = f.render(useAction).run(() => pending.promise, { success: "Concluído" }); f.suspend();
    pending.reject(new DOMException("Cancelado", "AbortError")); expect(await action).toBeUndefined(); f.resume();
    expect(f.render(useAction).busy).toBe(false); expect(env.toast).not.toHaveBeenCalled(); expect(env.toastError).not.toHaveBeenCalled();
    await f.render(useAction).run(async () => { throw new DOMException("Cancelado", "AbortError"); }, { success: "Concluído" });
    expect(env.toast).not.toHaveBeenCalled(); expect(env.toastError).not.toHaveBeenCalled();
  });
});

describe("R2 — guarda do rascunho suspenso", () => {
  it("protege fechamento só enquanto o rascunho atual está retido e limpa sem duplicar", () => {
    const target = new EventTarget(), add = vi.spyOn(target, "addEventListener"), remove = vi.spyOn(target, "removeEventListener");
    let dirty = true; const stop = holdManagementDraft(() => dirty, target);
    const unload = () => { const event = new Event("beforeunload", { cancelable: true }); target.dispatchEvent(event); return event.defaultPrevented; };
    expect(unload()).toBe(true); expect(env.guard?.()).toBe(true);
    dirty = false; expect(unload()).toBe(false); stop(); stop(); expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    const resumed = vi.fn(() => true); cleanup.push(registerErpGuard(resumed)); stop(); expect(env.guard?.()).toBe(true);
    const second = holdManagementDraft(() => false, target); expect(unload()).toBe(false); second(); expect(unload()).toBe(false);
  });
  it("a casca mantém portado fora de Activity e retém a guarda na desativação", () => {
    const f = frame(); env.guard = () => true;
    const visible = f.render(ErpArea); f.commit();
    expect(nodes(visible).filter(node => node.type === React.Activity)).toHaveLength(0);
    env.app = { ...env.app, modules: { erp: false, agenda: true } };
    f.render(ErpArea); f.commit();
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    env.app = { ...env.app, modules: { ...ERP_CORE_TEST_MODULES, agenda: true } }; f.render(ErpArea); f.commit();
    const resumed = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(resumed); expect(resumed.defaultPrevented).toBe(false);
    env.app = { ...env.app, profile: "area-b" }; f.render(ErpArea); f.commit(); expect(env.guard?.()).not.toBe(true);
  });
  it("ao religar, conserva beforeunload até o editor reassumir após a verificação fina", () => {
    env.route = parseRoute("/app/erp/estoque-empresa", ""); env.guard = () => true;
    const f = frame(); f.render(ErpArea); f.commit();
    env.app = { ...env.app, modules: { erp: false, agenda: true } }; f.render(ErpArea); f.commit();
    const blocked = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    expect(blocked()).toBe(true);
    env.app = { ...env.app, modules: { ...ERP_CORE_TEST_MODULES, agenda: true } };
    const pending = f.render(ErpArea); f.commit(); expect(blocked()).toBe(true);
    const content = nodes(pending).find(node => node.props.target === stock && node.props.props?.onPermissions);
    expect(content).toBeTruthy();
    content.props.props.onPermissions({ phase: "ready", userId: actor, role: "consulta", apiUrl: "/api/v1/profiles/area-a/erp", permissions: [permission], message: null });
    f.render(ErpArea); f.commit(); expect(blocked()).toBe(false);
  });
});

describe("A4 — mesma autorização efetiva", () => {
  const menuAllows = (value: ErpPermissions | null) => resolveManagement(MANAGEMENT_ITEMS, context(), false, value).some(item => item.target.kind === "ported" && item.target.to === stock);
  it("mesmo papel: concessão, retirada e restauração concordam no menu, rota, atalhos e conteúdo", async () => {
    const reports: (ErpPermissions | null)[] = [];
    const owner = own(acquireErpHost(host({ onPermissions: p => reports.push(p) })));
    const runtime = await owner.ready; await ready(runtime);
    expect(menuAllows(null)).toBe(false); expect(runtime.allowed(stock)).toBe(false); expect(targetEnabled(stock)).toBe(false);
    expect(portedTargetState(stock, context())).toBe("allowed");
    expect(portedTargetState(stock, context(), false, null)).toBe("loading");
    const delay = deferred<Response>(); fetcher.mockImplementationOnce(() => delay.promise);
    const check = runtime.controller.verifyPermissions();
    expect(portedPermissionState(stock, runtime.controller.getSnapshot().permissions)).toBe("loading");
    const before = fetcher.mock.calls.length; await expect(runtime.controller.stock("/v1/estoque/saldos")).rejects.toMatchObject({ status: 503 }); expect(fetcher).toHaveBeenCalledTimes(before);
    delay.resolve(Response.json(permissions())); await check;
    for (const [index, allowed] of [true, false, true].entries()) {
      if (index > 0) {
        fetcher.mockImplementationOnce(async () => Response.json(member())).mockImplementationOnce(async () => Response.json(permissions(allowed ? [permission] : [])));
        runtime.controller.retry(); await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready"));
      }
      const state = runtime.controller.getSnapshot(); expect(menuAllows(state.permissions!)).toBe(allowed); expect(runtime.allowed(stock)).toBe(allowed); expect(targetEnabled(stock)).toBe(allowed);
      expect(portedTargetState(stock, context(), false, state.permissions)).toBe(allowed ? "allowed" : "denied");
      const f = frame(), child = React.createElement("input", { defaultValue: "Rascunho" });
      const body = f.render(() => HostedContent({ host: { runtime, embedded: true, chromeTarget: null, Activity: React.Activity }, state, target: stock, children: child }));
      expect(nodes(body).some(node => node === child)).toBe(allowed);
    }
    expect(reports.at(-1)?.permissions).toEqual([permission]);
    expect(portedPermissionAllowed(stock, "consulta", ROLE_RESOURCES.consulta, { ...reports.at(-1)!, permissions: [permission + ".insercao"] })).toBe(false);
    owner.dispose(); expect(reports.at(-1)).toBeNull(); expect(menuAllows(reports.at(-1)!)).toBe(false);
  });
  it("erro tem motivo/repetição; formato, pessoa e papel incompatíveis são recusados", async () => {
    const runtime = await own(acquireErpHost(host())).ready; await ready(runtime);
    for (const result of [new Error("offline"), permissions([], other), permissions(null, actor, "admin"), { ...permissions(), profile_id: "area-b" }, { ...permissions(), permissions: "*" }]) {
      fetcher.mockImplementationOnce(async () => { if (result instanceof Error) throw result; return Response.json(result); });
      await runtime.controller.verifyPermissions(); const state = runtime.controller.getSnapshot();
      expect(state.permissions?.phase).toBe("error"); expect(state.permissions?.message).toMatch(/Tente novamente/); expect(runtime.allowed(stock)).toBe(false);
      expect(portedTargetState(stock, context(), false, state.permissions)).toBe("unavailable");
    }
    await runtime.controller.verifyPermissions(); expect(runtime.allowed(stock)).toBe(true);
  });
  it("a retomada espera /me antes de reconfirmar permissões e liberar estoque", async () => {
    const lease = own(acquireErpHost(host())), runtime = await lease.ready; await ready(runtime); await runtime.controller.verifyPermissions();
    lease.update(host({ suspended: true }));
    const me = deferred<Response>(); fetcher.mockImplementationOnce(() => me.promise);
    lease.update(host()); const calls = fetcher.mock.calls.length;
    await runtime.controller.verifyPermissions(); expect(fetcher).toHaveBeenCalledTimes(calls); expect(runtime.allowed(stock)).toBe(false);
    await expect(runtime.controller.stock("/v1/estoque/saldos")).rejects.toMatchObject({ status: 503 });
    me.resolve(Response.json(member())); await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready"));
    expect(runtime.allowed(stock)).toBe(true);
  });
  it("ignora permissão atrasada após suspensão/área trocada e revalida após 403", async () => {
    const lease = own(acquireErpHost(host())), runtime = await lease.ready; await ready(runtime);
    const delay = deferred<Response>(); let signal!: AbortSignal;
    fetcher.mockImplementationOnce((_input, init) => { signal = init.signal; return delay.promise; });
    const check = runtime.controller.verifyPermissions(); lease.update(host({ suspended: true })); expect(signal.aborted).toBe(true);
    lease.update(host()); await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready"));
    delay.resolve(Response.json(permissions([]))); await check; expect(runtime.allowed(stock)).toBe(true);
    fetcher.mockImplementationOnce(async () => Response.json({}, { status: 403 })).mockImplementationOnce(async () => Response.json(member())).mockImplementationOnce(async () => Response.json(permissions([])));
    await expect(runtime.controller.catalog("/v1/cadastros/negado")).rejects.toMatchObject({ status: 403 });
    await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.permissions).toEqual([])); expect(runtime.allowed(stock)).toBe(false);
    const old = deferred<Response>(); let oldSignal: AbortSignal | undefined;
    // Esperar a requisição da área A: uma contagem fixa de microtarefas pode
    // deixar a resposta pendente na fila e entregá-la ao /me da nova área B.
    fetcher.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/v1/me")) return Response.json(member());
      if (path === "/api/v1/profiles/area-a/erp/v1/sistema/permissoes") { oldSignal = init.signal; return old.promise; }
      if (path === "/api/v1/profiles/area-b/erp/v1/sistema/permissoes") return Response.json(permissions());
      throw new Error("Leitura inesperada: " + path);
    });
    runtime.controller.retry(); await vi.waitFor(() => expect(oldSignal).toBeDefined());
    expect(runtime.controller.getSnapshot().permissions?.phase).toBe("checking");
    const oldCheck = runtime.controller.verifyPermissions();
    const next = await own(acquireErpHost(host({ profile: "area-b" }))).ready; await ready(next); await next.controller.verifyPermissions();
    expect(oldSignal!.aborted).toBe(true);
    const nextPermissions = next.controller.getSnapshot().permissions;
    old.resolve(Response.json(permissions())); await oldCheck; expect(runtime.allowed(stock)).toBe(false); expect(next.allowed(stock)).toBe(true); expect(next.controller.getSnapshot().permissions?.apiUrl).toContain("area-b");
    expect(next.controller.getSnapshot().permissions).toBe(nextPermissions);
  });
  it("entrada leve, destinos negados e páginas nativas não iniciam consulta ERP", () => {
    const load = vi.fn(), prefetch = vi.fn();
    for (const state of ["loading", "disabled", "denied", "unavailable", "not-found"] as const) {
      expect(loadAuthorizedPorted(state, load, prefetch)).toBeNull(); startAuthorizedPortedPrefetch(state, { actor, profile: "area-a", simulated: false }, prefetch).dispose();
    }
    env.app = { ...env.app, me: { ...env.app.me, role: "admin", access: null } };
    for (const route of [{ area: "erp" }, { area: "erp", page: "agenda" }]) {
      env.route = route; const f = frame(); f.render(ErpArea); f.commit();
    }
    expect(load).not.toHaveBeenCalled(); expect(prefetch).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});

it("R3 — favoritos de consulta, numeração administrativa e combinações atendidas pela tela", () => {
  for (const kind of ["sales_orders", "sales_proposals", "purchase_orders", "service_orders"]) {
    const target = `/documentos-empresa?tipo=${kind}`;
    expect(portedTargetState(target + "&acao=cabecalho", context())).toBe("allowed");
    expect(portedTargetState(target + "&acao=numeracao", context())).toBe("denied");
    expect(portedTargetState(target + "&acao=numeracao", context(undefined, "admin"))).toBe("allowed");
    expect(portedTargetState(target + "&acao=aprovacao-descontos", context())).toBe(kind === "sales_orders" ? "allowed" : "not-found");
    expect(portedTargetState(target + "&acao=checkout", context(undefined, "vendas"))).toBe(kind === "sales_orders" ? "allowed" : "not-found");
  }
  expect(portedTargetState("/documentos-empresa?tipo=sales_orders&acao=checkout", context())).toBe("denied");
  for (const role of ["financeiro", "estoque", "fiscal"]) {
    expect(portedTargetState("/documentos-empresa?tipo=sales_orders&acao=aprovacao-descontos", context(undefined, role))).toBe("allowed");
    expect(portedTargetState("/documentos-empresa?tipo=purchase_orders&acao=cabecalho", context(undefined, role))).toBe("allowed");
  }
  expect(portedTargetState("/documentos-empresa?tipo=sales_proposals&acao=cabecalho", context(undefined, "estoque"))).toBe("denied");
});

describe("R4 — sessão pública, filtros internos", () => {
  it.each(["receivable", "payable", "borderos"])("entrada, ponte, navegação e remontagem: %s", async area => {
    const raw = `area=${area}${area === "borderos" ? "&tipo=P" : ""}&q=Jo%C3%A3o%20Silva&from=2026-11-01&to=2026-11-19`;
    const publicUrl = `/app/erp/financeiro-empresa?demo=1&${raw}&pair=abc%2Fdef#detalhes`;
    vi.stubGlobal("location", new URL(publicUrl, "https://panel.test"));
    const initial = internalErpTarget(publicUrl), router = createMemoryRouter([{ path: "*", element: null }], { basename: "/app/erp", initialEntries: [initial] });
    const bridge = connectErpRouter(router, () => ({ dispose() {}, publish: to => { const url = new URL(to, location.origin); env.publish(href(parseRoute(url.pathname, url.search, url.hash))); } }));
    cleanup.push(() => { bridge.dispose(); router.dispose(); });
    const parse = () => area === "borderos" ? borderoRoute(new URLSearchParams(router.state.location.search)) : financeListRoute(new URLSearchParams(router.state.location.search));
    expect(initial).toBe(`/app/erp/financeiro-empresa?${raw}#detalhes`); expect(parse().q).toBe("João Silva");
    await bridge.navigate(publicUrl.replace("#detalhes", "#ponte")); expect(parse().q).toBe("João Silva");
    await router.navigate(`/financeiro-empresa?${raw.replace("Silva", "Souza")}#interno`); expect(parse().q).toBe("João Souza");
    expect(env.publish).toHaveBeenCalledTimes(2);
    const published = env.publish.mock.calls.at(-1)![0], external = new URL(published, location.origin);
    expect(external.searchParams.get("demo")).toBe("1"); expect(external.searchParams.get("pair")).toBe("abc/def"); expect(external.hash).toBe("#interno");
    const remount = new URL(internalErpTarget(published), location.origin); expect(remount.search).toBe(router.state.location.search); expect(remount.hash).toBe("#interno");
    expect(router.state.location.search).not.toMatch(/demo|pair/);
  });
  it("âncoras preservam sessão pública; somente demo/pair saem da consulta interna", async () => {
    vi.stubGlobal("location", new URL("https://panel.test/app/erp/acesso?demo=1&pair=p"));
    class Scope { links: any[] = []; click: any; querySelectorAll() { return this.links; } addEventListener(_type: string, callback: any) { this.click = callback; } removeEventListener() {} }
    const scope = new Scope(); vi.stubGlobal("Element", Scope); vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    const link = { value: "/financeiro-empresa?area=payable&q=a%20b#filtro", target: "", get href() { return new URL(this.value, location.origin).href; }, getAttribute() { return this.value; }, setAttribute(_key: string, value: string) { this.value = value; }, hasAttribute: () => false };
    scope.links = [link]; const router = createMemoryRouter([{ path: "*", element: null }], { basename: "/app/erp", initialEntries: ["/app/erp/acesso"] });
    const stop = keepLinksInside(scope as any, router); cleanup.push(() => { stop?.(); router.dispose(); });
    expect(new URL(link.href).searchParams.get("pair")).toBe("p");
    const target = new Scope(); Object.assign(target, { closest: () => link });
    scope.click({ target, button: 0, preventDefault() {} }); await tick();
    expect(financeListRoute(new URLSearchParams(router.state.location.search)).q).toBe("a b"); expect(router.state.location.hash).toBe("#filtro");
    expect(internalErpTarget("/app/erp/acesso?x=a%20b&demo=1&x=c%2Fd&pair=2#parte")).toBe("/app/erp/acesso?x=a%20b&x=c%2Fd#parte");
    expect(() => financeListRoute(new URLSearchParams("area=payable&demo=1"))).toThrow();
    expect(() => borderoRoute(new URLSearchParams("area=borderos&pair=1"))).toThrow();
  });
});
