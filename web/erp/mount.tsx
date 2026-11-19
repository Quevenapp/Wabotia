// Hospedagem autorizada do conteúdo portado. Somente o roteador principal escreve no histórico.
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import App from "./app/App";
import { UnsavedChangesProvider, useUnsavedChangesGuard } from "./app/hooks/useUnsavedChanges";
import { bindManagementRouter, setNavigationGuard, navigate, parseRoute } from "../lib/routes";
import type { BindManagementRouter, ErpMountProps, MountCustomerProfile, CustomerProfileHostOptions } from "../management/host-contract";
import type { ManagementRouterBridge } from "../../src/modules/panel-contract";
import { portedTargetState, portedUrl } from "../management/ported-policy";
import { acquireErpHost, ErpHostProvider, ErpToolsScope, useErpHost, TargetNotice, type ErpHostRuntime } from "./host-runtime";
import { erpSimulated } from "./fetch-port";
import type { AccessController, AccessState } from "./app/lib/real-access";
import type { CatalogAccess, CatalogRecord } from "./app/lib/catalog-base";
// A ordem e as raízes de impressão continuam sendo as do escopo original.
import "./scope.css";
import "./app/styles.css";
import "./app/fonts.css";
import "./app/fagoo-system.css";
import "./app/components/document-layout.css";

export const ERP_BASENAME = "/app/erp";
const CONTACT_TARGET = "/cadastros-reais?cadastro=contacts";
const RealAccess = lazy(() => import("./app/components/RealAccess"));
const ContactEditor = lazy(() => import("./app/components/ContactEditor").then(module => ({ default: module.ContactEditor })));

const guards = new Map<symbol, () => boolean>();
export function registerErpGuard(guard: () => boolean) {
  const owner = Symbol("erp-guard");
  guards.set(owner, guard);
  setNavigationGuard(() => [...guards.values()].some(check => check()));
  return () => {
    if (!guards.delete(owner)) return;
    if (!guards.size) setNavigationGuard(null);
  };
}
function GuardBridge() {
  const guard = useUnsavedChangesGuard();
  useEffect(() => registerErpGuard(() => guard.store.shouldBlock()), [guard]);
  return null;
}

type MemoryRouter = ReturnType<typeof createMemoryRouter>;
const localUrl = (location: MemoryRouter["state"]["location"]) => location.pathname + location.search + location.hash;
function publicTarget(to: string): string {
  const url = portedUrl(to);
  if (!url || !url.pathname.startsWith(ERP_BASENAME + "/") || url.pathname === ERP_BASENAME + "/" ||
    url.pathname === ERP_BASENAME + "/modulos" || url.pathname.startsWith(ERP_BASENAME + "/modulos/")) throw new TypeError("ERP_ROUTER_TARGET");
  return url.pathname + url.search + url.hash;
}

/** O navigate do React Router termina cedo quando bloqueado; esta ponte espera a decisão. */
export function connectErpRouter(router: MemoryRouter, bind: BindManagementRouter = bindManagementRouter): ManagementRouterBridge {
  let disposed = false, last = localUrl(router.state.location);
  let pending: { resolve(): void; reject(error: unknown): void; blocked: boolean; started: boolean } | null = null;
  let connection: ReturnType<BindManagementRouter> | undefined;
  let inFlight: Promise<void> | null = null;
  const settled = () => router.state.navigation.state === "idle" && [...router.state.blockers.values()].every(blocker => blocker.state === "unblocked");
  const inspect = () => {
    if (disposed) return;
    const blocked = [...router.state.blockers.values()].some(blocker => blocker.state !== "unblocked");
    if (pending && blocked) pending.blocked = true;
    const to = localUrl(router.state.location);
    if (settled() && to !== last) {
      last = to;
      try { connection?.publish(to, router.state.historyAction === "PUSH" ? "push" : "replace"); }
      catch (error) { pending?.reject(error); pending = null; return; }
    }
    if (pending?.started && settled()) { const done = pending; pending = null; done.resolve(); }
  };
  const unsubscribe = router.subscribe(inspect);
  const bridge: ManagementRouterBridge = {
    navigate(to, options) {
      let target: string;
      try { target = publicTarget(to); } catch (error) { return Promise.reject(error); }
      // Cliques enquanto a decisão está aberta pertencem à mesma transação.
      // Enfileirá-los reabria a confirmação depois de um cancelamento.
      if (inFlight) return inFlight;
      const run = () => new Promise<void>((resolve, reject) => {
        if (disposed) { reject(new Error("ERP_ROUTER_DISPOSED")); return; }
        if (!settled()) { reject(new Error("ERP_ROUTER_BUSY")); return; }
        pending = { resolve, reject, blocked: false, started: true };
        // Usar caminho absoluto no roteador com basename duplicaria /app/erp.
        const relative = target.slice(ERP_BASENAME.length);
        try {
          void router.navigate(relative, options).then(inspect, error => { pending?.reject(error); pending = null; });
        } catch (error) { pending?.reject(error); pending = null; }
      });
      const result = Promise.resolve().then(run).finally(() => {
        if (inFlight === result) inFlight = null;
      });
      inFlight = result;
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe(); connection?.dispose();
      pending?.reject(new Error("ERP_ROUTER_DISPOSED")); pending = null;
    },
  };
  try { connection = bind(bridge); } catch (error) { bridge.dispose(); throw error; }
  return bridge;
}

function TargetGate({ runtime }: { runtime: ErpHostRuntime }) {
  const location = useLocation();
  const context = runtime.context();
  const state = portedTargetState(location.pathname + location.search + location.hash, context.management, erpSimulated(context.demo));
  if (state !== "allowed") return <TargetNotice state={state} />;
  return <App />;
}

function HostTree({ runtime, props }: { runtime: ErpHostRuntime; props: ErpMountProps }) {
  const [router, setRouter] = useState<MemoryRouter | null>(null);
  // Atualizações do portal/callbacks não recriam o roteador nem descartam edições.
  const view = useMemo(() => ({ runtime, embedded: true, chromeTarget: props.chromeTarget, router, ToolsScope: ErpToolsScope,
    bindLinks: (element: HTMLElement | null) => keepLinksInside(element, router),
  }), [runtime, props.chromeTarget, router]);
  useEffect(() => {
    const initial = publicTarget(location.pathname + location.search + location.hash);
    const next = createMemoryRouter([{ path: "*", element: <UnsavedChangesProvider><GuardBridge /><TargetGate runtime={runtime} /></UnsavedChangesProvider> }],
      { basename: ERP_BASENAME, initialEntries: [initial] });
    let bridge: ManagementRouterBridge;
    try { bridge = connectErpRouter(next); } catch (error) { next.dispose(); throw error; }
    setRouter(next);
    return () => { bridge.dispose(); next.dispose(); setRouter(null); };
  }, [runtime]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => keepLinksInside(root.current, router), [router]);
  return <ErpHostProvider.Provider value={view}><div className="fagoo-root" ref={root}>{router && <RouterProvider router={router} />}</div></ErpHostProvider.Provider>;
}

export default function ErpMount(props: ErpMountProps): React.ReactElement {
  const result = useErpHost(props);
  if (!result?.runtime) return <TargetNotice state={result?.error ? "unavailable" : "loading"} />;
  return <HostTree key={result.runtime.key} runtime={result.runtime} props={props} />;
}

/** Apenas leituras e o corpo do editor existente; nunca usar record=null (inclusão). */
export async function readCustomerProfile(runtime: ErpHostRuntime, id: string, signal: AbortSignal) {
  if (!id || /[/\\?#]/.test(id) || !runtime.allowed(CONTACT_TARGET)) throw new Error("ERP_CUSTOMER_DENIED");
  const access = await runtime.controller.catalog("/v1/cadastros", { signal }) as CatalogAccess;
  if (signal.aborted || !runtime.allowed(CONTACT_TARGET)) throw new DOMException("Contexto encerrado", "AbortError");
  if (access.data_mode !== "erp_native" || !Array.isArray(access.read) || !Array.isArray(access.write) || !access.read.includes("contacts")) throw new Error("ERP_CUSTOMER_DENIED");
  const result = await runtime.controller.catalog(`/v1/cadastros/contatos/${encodeURIComponent(id)}`, { signal }) as { record?: CatalogRecord };
  if (signal.aborted || !runtime.allowed(CONTACT_TARGET)) throw new DOMException("Contexto encerrado", "AbortError");
  if (result.record?.id !== id || result.record.entity !== "contacts") throw new Error("ERP_CUSTOMER_RESPONSE");
  return { record: result.record, writable: access.write.includes("contacts") };
}
function CustomerBody({ runtime, options, state }: { runtime: ErpHostRuntime; options: CustomerProfileHostOptions; state: AccessState }) {
  const guard = useUnsavedChangesGuard();
  const [data, setData] = useState<(Awaited<ReturnType<typeof readCustomerProfile>> & { membership: AccessState["membership"] }) | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const request = new AbortController(); setData(null); setError(false);
    void readCustomerProfile(runtime, options.erpContactId, request.signal).then(value => { if (!request.signal.aborted) setData({ ...value, membership: state.membership }); }, () => { if (!request.signal.aborted) setError(true); });
    return () => request.abort();
  }, [runtime, options.erpContactId, state.membership]);
  if (!runtime.allowed(CONTACT_TARGET, state)) return <TargetNotice state="denied" />;
  if (!data || data.membership !== state.membership || error) return <TargetNotice state={error ? "unavailable" : "loading"} />;
  return <Suspense fallback={<TargetNotice state="loading" />}><ContactEditor key={`${data.record.id}:${data.record.version}`} controller={runtime.controller} entity="contacts" record={data.record} writable={data.writable}
    onClose={() => guard.confirmLeave(options.onClose)} onSaved={record => { setData({ ...data, record }); options.onSaved?.(); }} /></Suspense>;
}

export const mountCustomerProfile: MountCustomerProfile = async (element: HTMLElement, options: CustomerProfileHostOptions) => {
  if (portedTargetState(CONTACT_TARGET, options.context.management, erpSimulated(options.context.demo)) !== "allowed" || !options.erpContactId) throw new Error("ERP_CUSTOMER_DENIED");
  const lease = acquireErpHost(options.context);
  let scope: HTMLElement | undefined, root: ReturnType<typeof createRoot> | undefined, router: MemoryRouter | undefined;
  let stopLinks: (() => void) | undefined, stopNavigation: (() => void) | undefined, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopLinks?.(); stopNavigation?.();
    try { root?.unmount(); } finally { router?.dispose(); scope?.remove(); lease.dispose(); }
  };
  try {
    const runtime = await lease.ready;
    scope = element.ownerDocument.createElement("div"); scope.className = "fagoo-root";
    element.appendChild(scope);
    root = createRoot(scope);
    const body = (_controller: AccessController, state: AccessState) => <CustomerBody runtime={runtime} options={options} state={state} />;
    router = createMemoryRouter([{ path: "*", element: <UnsavedChangesProvider><GuardBridge /><Suspense fallback={<TargetNotice state="loading" />}><RealAccess host={{ runtime, embedded: true, chromeTarget: null, body }} /></Suspense></UnsavedChangesProvider> }],
      { basename: ERP_BASENAME, initialEntries: [ERP_BASENAME + CONTACT_TARGET] });
    stopLinks = keepLinksInside(scope, router);
    // Links do histórico do cliente deixam a ficha após sua guarda. Não instalar
    // outra ponte por cima da tela portada que já pode estar aberta atrás dela.
    const initial = localUrl(router.state.location);
    stopNavigation = router.subscribe(state => {
      const to = localUrl(state.location);
      if (to === initial || state.navigation.state !== "idle" || [...state.blockers.values()].some(blocker => blocker.state !== "unblocked")) return;
      queueMicrotask(() => {
        if (disposed) return;
        const url = new URL(to, location.origin);
        const target = { ...parseRoute(url.pathname, url.search), hash: url.hash };
        dispose(); options.onClose(); navigate(target, { replace: state.historyAction !== "PUSH" });
      });
    });
    root.render(<ErpHostProvider.Provider value={{ runtime, embedded: true, chromeTarget: null, body }}><RouterProvider router={router} /></ErpHostProvider.Provider>);
    return { dispose };
  } catch (error) { dispose(); throw error; }
};

/** Links crus e relativos continuam sob a base pública; cliques modificados mantêm a nova aba. */
export function keepLinksInside(element: HTMLElement | null, router: MemoryRouter | null) {
  if (!element) return;
  const fix = (scope: Node | null) => {
    if (!(scope instanceof Element)) scope = element;
    (scope as Element).querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
      const href = link.getAttribute("href");
      if (!href || /^(?:#|[a-z][a-z0-9+.-]*:|\/\/|\/app(?:\/|$)|\/api(?:\/|$))/i.test(href)) return;
      const base = router ? localUrl(router.state.location) : ERP_BASENAME + "/";
      const url = new URL(href, new URL(base, location.origin));
      const target = href.startsWith("/") ? ERP_BASENAME + href : url.pathname + url.search + url.hash;
      if (target.startsWith(ERP_BASENAME + "/")) link.setAttribute("href", target);
    });
  };
  fix(element);
  const observer = new MutationObserver(changes => {
    for (const change of changes) if (change.type === "attributes") fix(change.target.parentNode);
    else change.addedNodes.forEach(node => node instanceof Element && fix(node.parentNode));
  });
  observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  const click = (event: MouseEvent) => {
    if (!router || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith(ERP_BASENAME + "/") || url.pathname.startsWith(ERP_BASENAME + "/modulos")) return;
    event.preventDefault();
    void router.navigate(url.pathname.slice(ERP_BASENAME.length) + url.search + url.hash);
  };
  element.addEventListener("click", click);
  return () => { observer.disconnect(); element.removeEventListener("click", click); };
}
