// A casca e as políticas são leves. O hospedeiro portado só entra por import().
import React, { Activity, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ManagementRequestBoundary, useApp } from "../app/AppContext";
import { href, navigate, navigationGuarded, setNavigationGuard, useRoute } from "../lib/routes";
import { erpApiUrl, erpSimulated, prefetchErpMe } from "./fetch-port";
import { contextBoundResponse } from "../management/context-response.ts";
import { Empty, Spinner, Button } from "../ui";
import { AccountDialog, MfaPrompt } from "../app/Account";
import { ManagementShell, ManagementState } from "../management/ManagementShell";
import { ManagementPage } from "../management/pages";
import { isNativeManagementPage } from "../management/routes";
import { portedTargetState } from "../management/ported-policy";
import { MANAGEMENT_ITEMS, managementItemOrder, canEnterManagement, managementContext, nativeTargetState, normalizedManagementHref, resolveManagement } from "../management/registry";
import { useWorkNavigation } from "../modules/os/work-navigation";
import type { Disposable, ErpHostContext, ErpMountProps, ErpPermissions, MountCustomerProfile, PortedTargetState } from "../management/host-contract";
import { setPanelPartsContext } from "./fetch-port";
import type { FullCustomerHost } from "../contact-profile/host-port";
import { installIntegrationHost, integrationRouteState, portableWorkBlocked, visibleIntegrationItems } from "../modules/integrations/visibility";
import { IntegrationsPage } from "../modules/integrations/IntegrationStatus";
import { setMotorWorkEnabled } from "./motor";
import { partOffMessage } from "./modules";

/** Testável por injeção: estado leve não inicia import nem prefetch. */
export function loadAuthorizedPorted<T>(state: PortedTargetState, load: () => Promise<T>, prefetch: () => void): Promise<T> | null {
  if (state !== "allowed") return null;
  prefetch();
  return load();
}

/** Guarda da casca enquanto Activity remove os efeitos do editor suspenso. */
let heldDraftOwner: symbol | null = null;
export function holdManagementDraft(check: () => boolean, target: EventTarget = window) {
  const owner = Symbol("suspended-draft"); heldDraftOwner = owner;
  const preventLoss = (event: Event) => {
    if (heldDraftOwner !== owner || !check()) return;
    event.preventDefault(); (event as BeforeUnloadEvent).returnValue = "";
  };
  setNavigationGuard(check);
  target.addEventListener("beforeunload", preventLoss);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; target.removeEventListener("beforeunload", preventLoss);
    if (heldDraftOwner === owner) { heldDraftOwner = null; setNavigationGuard(null); }
  };
}

/**
 * Instalação adiada com limpeza inclusive quando o import termina após a saída.
 */
export function createDeferredHostSlot(authorized: () => boolean, install?: () => Promise<Disposable>) {
  let disposed = false, installed: Disposable | undefined, pending: Promise<void> | undefined;
  return {
    open(): Promise<void> {
      if (disposed || !authorized() || !install || installed) return Promise.resolve();
      if (!pending) pending = install().then((value) => {
        if (disposed || !authorized()) value.dispose();
        else installed = value;
      }).finally(() => { pending = undefined; });
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      installed?.dispose();
      installed = undefined;
    },
  };
}

/** Adapta a porta publicada pela fase 1 sem confundir ID D1 com ID ERP.
 * Registrar a porta leve não baixa o ERP; somente mount, com vínculo já
 * resolvido e autorização, carrega o hospedeiro completo.
 */
export function installManagementCustomerHost(context: ErpHostContext, dependencies: {
  port?: () => Promise<typeof import("../contact-profile/host-port")>;
  mount?: () => Promise<{ mountCustomerProfile: MountCustomerProfile }>;
} = {}) {
  let live = true, unregister: (() => void) | undefined;
  const mounted = new Set<Disposable>();
  const check = () => {
    if (!live || portedTargetState("/cadastros-reais?cadastro=contacts", context.management, erpSimulated(context.demo)) !== "allowed")
      throw new DOMException("Ficha completa indisponível neste contexto", "AbortError");
  };
  const host: FullCustomerHost = {
    async mount(element, input) {
      check();
      if (input.profileId !== context.profile || !input.contactId || !input.erpContactId)
        throw new Error("ERP_CUSTOMER_CONTEXT");
      const module = await (dependencies.mount ?? (() => import("./mount")))();
      check();
      const releaseParts = setPanelPartsContext(erpApiUrl(context.profile), context.management.modules);
      let instance: Disposable;
      try { instance = await module.mountCustomerProfile(element, {
        context, erpContactId: input.erpContactId, vocabulary: input.vocabulary,
        onSaved: () => { if (live) input.onSaved(); },
        onClose: () => { if (live) input.onClose(); },
      });
      } catch (error) { releaseParts(); throw error; }
      if (!live) { instance.dispose(); releaseParts(); check(); }
      let disposed = false;
      const owner = { dispose() {
        if (disposed) return;
        disposed = true; mounted.delete(owner); instance.dispose(); releaseParts();
      } };
      mounted.add(owner);
      return owner;
    },
  };
  const ready = (async () => {
    check();
    const port = await (dependencies.port ?? (() => import("../contact-profile/host-port")))();
    if (!live) return;
    const loader = async () => { check(); return host; };
    // A porta recusa outro dono simultâneo; só removemos nosso registro aceito.
    port.installFullCustomerHost(loader);
    unregister = () => port.installFullCustomerHost(null);
  })();
  return { ready, dispose() {
    if (!live) return;
    live = false;
    unregister?.(); unregister = undefined;
    for (const owner of mounted) owner.dispose();
  } };
}

export { contextBoundResponse } from "../management/context-response.ts";

export function startAuthorizedPortedPrefetch(
  state: PortedTargetState,
  context: { profile: string; actor: string; simulated: boolean },
  prefetch = prefetchErpMe,
): Disposable {
  const controller = new AbortController();
  if (state === "allowed" && context.actor && !context.simulated) {
    prefetch(erpApiUrl(context.profile), context.actor, async (input, init) => {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return contextBoundResponse(response, controller.signal);
    });
  }
  return { dispose: () => controller.abort() };
}

class LoadBoundary extends React.Component<
  { children: React.ReactNode; target: string; retry(): void },
  { failed: boolean; target: string }
> {
  state = { failed: false, target: this.props.target };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { target: string }, state: { target: string }) {
    return props.target !== state.target ? { failed: false, target: props.target } : null;
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Empty title="Não foi possível abrir esta página" description="Confira a conexão e tente novamente."
      action={<Button onClick={this.props.retry}>Tentar novamente</Button>} />;
  }
}

function PortedContent({ target, props }: { target: string; props: ErpMountProps }) {
  const [attempt, setAttempt] = useState(0);
  const ErpMount = useMemo(() => lazy(() => {
    // A política é conferida também no ponto exato de importação.
    const state = portedTargetState(target, props.management, erpSimulated(props.demo));
    const loading = loadAuthorizedPorted(state, () => import("./mount"), () => {});
    if (!loading) return Promise.reject(new Error("Destino indisponível"));
    return loading;
  }), [attempt]);
  return <LoadBoundary key={attempt} target={target} retry={() => setAttempt((value) => value + 1)}>
    <Suspense fallback={<div className="loading"><Spinner label="Abrindo a página…" /></div>}>
      <ErpMount {...props} />
    </Suspense>
  </LoadBoundary>;
}

export function ErpArea() {
  const app = useApp();
  const route = useRoute();
  const work = useWorkNavigation();
  const identity = JSON.stringify([app.profile, app.me.id, app.demo]);
  const context = managementContext({
    statusLoaded: app.statusLoaded, modules: app.modules,
    role: app.me.role, access: app.me.access ?? null,
    vocabulary: { ...app.settings.os_vocabulary, collection_label: work.label },
  });
  const partsKey = JSON.stringify(context.modules);
  useLayoutEffect(() => setPanelPartsContext(erpApiUrl(app.profile), context.modules), [app.profile, partsKey]);
  const integrationKey = JSON.stringify([identity, partsKey, context.role, context.access, context.statusLoaded, app.contextGeneration]);
  useLayoutEffect(() => installIntegrationHost({ context, api: app.api, root: app.root, actor: String(app.me.id), generation: app.contextGeneration }), [integrationKey, app.api]);
  useLayoutEffect(() => { setMotorWorkEnabled(context.modules.os === true); return () => setMotorWorkEnabled(false); }, [partsKey]);
  const [accessReport, setAccessReport] = useState<{ identity: string; permissions: ErpPermissions | null } | null>(null);
  const permissions = route.erpPath && accessReport?.identity === identity &&
    accessReport.permissions?.apiUrl === erpApiUrl(app.profile) &&
    (app.demo || accessReport.permissions.userId === String(app.me.id)) ? accessReport.permissions : null;
  const items = [...resolveManagement(visibleIntegrationItems(MANAGEMENT_ITEMS, context), context, erpSimulated(app.demo), permissions)];
  if (integrationRouteState(context) === "allowed") items.push({ id: "erp.integrations", module: "erp", group: "comercial", groupLabel: "Comercial", groupOrder: 20, order: 225, label: "Integrações", resolvedLabel: "Integrações", icon: "link", target: { kind: "ported", to: "/integracoes" }, permission: { kind: "erp" }, href: "/app/erp/integracoes" });
  items.sort(managementItemOrder);
  const destinations = new Set<string>();
  const menu = items.filter((item) => {
    const key = normalizedManagementHref(item.href);
    if (destinations.has(key)) return false;
    destinations.add(key); return true;
  });
  const entry = !route.page && !route.erpPath && !route.nativePath;
  const ported = route.erpPath ? route.erpPath + (route.search || "") + (route.hash || "") : null;
  const integrations = route.erpPath === "/integracoes";
  const workRequired = !!ported && portableWorkBlocked(ported, context);
  const state: PortedTargetState = integrations ? integrationRouteState(context) : workRequired ? "unavailable" : route.nativePath ? "not-found"
    : route.page ? isNativeManagementPage(route.page) ? nativeTargetState(route.page, context) : "not-found"
    : ported ? portedTargetState(ported, context, erpSimulated(app.demo)) : "loading";
  const [chromeTarget, setChromeTarget] = useState<HTMLDivElement | null>(null);
  const selection = href(route);
  const last = useRef<{ selection: string; identity: string; guarded: boolean; suspended?: boolean } | null>(null);
  const fineState = !integrations && ported && state === "allowed" ? portedTargetState(ported, context, erpSimulated(app.demo), permissions) : state;
  const waitingPermission = state === "allowed" && (fineState === "loading" || fineState === "unavailable") &&
    last.current?.selection === selection && last.current.identity === identity && last.current.suspended;
  if (state === "allowed" && !waitingPermission) last.current = { selection, identity, guarded: navigationGuarded() };
  const retained = (state === "disabled" || state === "loading") &&
    last.current?.selection === selection && last.current.identity === identity;
  if (state !== "allowed" && !retained) last.current = null;
  // Activity desmonta efeitos (incluindo a guarda da tela), mas conserva estado.
  if (retained && last.current && !last.current.suspended) {
    last.current.guarded = navigationGuarded();
    last.current.suspended = true;
  }
  const heldGuard = (retained || waitingPermission) && last.current?.guarded;
  useEffect(() => {
    if (!heldGuard) return;
    return holdManagementDraft(() => !!last.current?.suspended && last.current.selection === selection &&
      last.current.identity === identity && last.current.guarded);
  }, [heldGuard, selection, identity]);
  const actor = String(app.me.id);
  const authorized = !entry && !integrations && !!ported && state === "allowed";
  useEffect(() => {
    const prefetch = startAuthorizedPortedPrefetch(authorized ? "allowed" : "denied", {
      actor, profile: app.profile, simulated: erpSimulated(app.demo),
    });
    return () => prefetch.dispose();
  }, [authorized, actor, app.demo, app.profile, identity, app.contextGeneration]);

  const [dialog, setDialog] = useState<null | { kind: "mfa"; done(): void } | { kind: "account" }>(null);
  const pendingIdentity = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => { pendingIdentity.current?.(); pendingIdentity.current = null; }, []);
  const closeDialog = () => {
    pendingIdentity.current?.(); pendingIdentity.current = null;
    setDialog(null);
  };
  const mountProps: ErpMountProps = {
    profile: app.profile, actor, demo: app.demo, management: context,
    suspended: state !== "allowed",
    onPermissions: (value) => setAccessReport(previous => previous?.identity === identity && previous.permissions === value
      ? previous : { identity: identity, permissions: value }),
    subscribePermissions: (recheck) => app.onEvents(events => {
      if (events.some(event => event.kind === "resync" || /^(user|person|access|profile)\.(changed|updated|deleted)$/.test(event.kind))) recheck();
    }),
    embedded: true, chromeTarget,
    onModules: () => navigate({ area: "admin", page: "modules" }),
    onPeople: () => navigate({ area: "admin", page: "users" }),
    onLeave: () => navigate({ area: "conversations" }),
    onExpired: () => void app.reloadSession(),
    onConfirmIdentity: () => new Promise<void>((done) => {
      pendingIdentity.current?.(); pendingIdentity.current = done;
      setDialog({ kind: "mfa", done });
    }),
    onAccount: () => setDialog({ kind: "account" }),
  };
  if (!canEnterManagement(context)) return <ManagementState state="denied" admin={false} />;
  const failedStatus = !app.statusLoaded && app.statusError;
  return <ManagementShell context={context} items={menu} entry={entry && !failedStatus} chromeRef={setChromeTarget}>
    {failedStatus && <Empty title="Não foi possível abrir a gestão" description={app.statusError}
      action={<Button onClick={() => void app.refresh().catch(() => {})}>Tentar novamente</Button>} />}
    {workRequired ? <Empty title="Crie um trabalho para esta operação" description="A ordem de serviço comercial acompanha o trabalho da área." action={<a href="/app/erp/modulos/trabalhos">Abrir trabalhos</a>} /> : !entry && state !== "allowed" && <ManagementState state={state} admin={app.isAdmin} retained={!!retained}
      detail={state === "disabled" && ported ? partOffMessage(ported, context.modules) : null} />}
    {!entry && (state === "allowed" || retained) && <ManagementRequestBoundary key={identity} enabled={state === "allowed"}>
      {integrations ? <IntegrationsPage key={selection + identity} search={route.search} /> : ported ? <div className="management-page erp-area"><PortedContent target={ported} props={mountProps} /></div> : <Activity mode={state === "allowed" ? "visible" : "hidden"}>
        <div className={"management-page" + (ported ? " erp-area" : "")}>
          {route.page && isNativeManagementPage(route.page)
            ? <ManagementPage key={route.page === "service-objects" ? route.id : route.page} page={route.page} />
            : null}
        </div>
      </Activity>}
    </ManagementRequestBoundary>}
    {dialog?.kind === "mfa" && <MfaPrompt factor={Boolean(app.me.mfa?.factor)} onClose={closeDialog} />}
    {dialog?.kind === "account" && <AccountDialog onClose={closeDialog} />}
  </ManagementShell>;
}
