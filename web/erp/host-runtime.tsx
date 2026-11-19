import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { createMemoryRouter } from "react-router-dom";
import type { ErpHostContext } from "../management/host-contract";
import { portedPermissionAllowed, portedTargetState } from "../management/ported-policy";
import { createAccessController, type AccessController, type AccessState } from "./app/lib/real-access";
import { installErpPorts, type ErpPorts } from "./ports";
import { createFetchPort, erpApiUrl, erpSimulated } from "./fetch-port";
import { createSessionPort, createChallengePort, createSimulatedChallengePort } from "./session-port";
import { createPeoplePort } from "./people";
import { createDemoEmissorPort, createEmissorPort } from "./emissor";
import { setErpBlocks, installErpTargetAccess } from "./blocks";
import { setActionPendingNotice, setMotorReal } from "./motor";
import { toast } from "../ui";
import { ContactProfileEntry } from "./contact-profile-entry";

const DEMO_ACTOR = "d3e00000-0000-4000-8000-000000000001";
const cancelled = () => new DOMException("Contexto do ERP encerrado", "AbortError");

export function erpHostKey(context: ErpHostContext): string {
  return JSON.stringify([context.profile, context.actor, context.demo, context.sessionKey]);
}

function policyKey(context: ErpHostContext): string {
  const c = context.management;
  return JSON.stringify([context.suspended === true, c.statusLoaded, c.role, c.erpRole,
    c.access && [...c.access].sort(), ["erp", "erp-fiscal", "erp-cobranca", "erp-pdv"].map(id => c.modules[id] === true)]);
}

export interface ErpHostRuntime {
  key: string;
  ports: ErpPorts;
  controller: AccessController;
  context(): ErpHostContext;
  allowed(to: string, state?: AccessState): boolean;
}
type Entry = {
  key: string;
  owners: Map<symbol, ErpHostContext>;
  ready: Promise<ErpHostRuntime>;
  invalidate(): void;
  updatePolicy(): void;
  valid: boolean;
};
// Os adaptadores legados são globais. Só uma identidade pode estar ativa;
// hospedeiros compatíveis compartilham a mesma instalação e o mesmo controlador.
let active: Entry | null = null;

export function acquireErpHost(context: ErpHostContext) {
  const key = erpHostKey(context), owner = Symbol("erp-runtime-owner");
  if (active?.key !== key) active?.invalidate();
  if (!active) {
    let stop: (() => void) | undefined, removePorts: (() => void) | undefined, removeAccess: (() => void) | undefined;
    let expire: (() => void) | undefined, observe: (() => void) | undefined;
    let controller: AccessController | undefined;
    let revision = new AbortController(), policy = policyKey(context);
    const lifetime = new AbortController();
    const entry: Entry = {
      key, owners: new Map(), valid: true, ready: null!,
      updatePolicy() {
        if (!entry.valid || !entry.owners.size) return;
        const next = current(), nextPolicy = policyKey(next);
        setErpBlocks(Object.fromEntries(["erp", "erp-fiscal", "erp-cobranca", "erp-pdv"].map(id => [id, next.management.modules[id] === true])));
        if (nextPolicy !== policy) {
          policy = nextPolicy;
          revision.abort(); revision = new AbortController();
          controller?.setSuspended(true);
          controller?.setSuspended(!available());
        }
        report();
      },
      invalidate() {
        if (!entry.valid) return;
        entry.valid = false;
        lifetime.abort();
        revision.abort();
        // Publica signed_out e cancela as leituras antes de descartar o store.
        expire?.(); observe?.(); stop?.(); removePorts?.(); removeAccess?.();
        for (const owner of entry.owners.values()) owner.onPermissions?.(null);
        if (active === entry) {
          active = null;
          setErpBlocks(null); setMotorReal(false); setActionPendingNotice(null);
        }
      },
    };
    active = entry;
    entry.owners.set(owner, context);
    const current = () => {
      if (!entry.valid || !entry.owners.size) throw cancelled();
      return [...entry.owners.values()].at(-1)!;
    };
    const available = () => {
      const c = current();
      return !c.suspended && c.management.statusLoaded && c.management.modules.erp === true && !!c.management.erpRole;
    };
    const operational = () => { current(); if (!available()) throw cancelled(); return revision.signal; };
    const report = () => {
      const permissions = controller?.getSnapshot().permissions ?? null;
      for (const owner of entry.owners.values()) owner.onPermissions?.(permissions);
    };
    const optional = <K extends "onConfirmIdentity" | "onAccount" | "openContactProfile",>(key: K): ErpHostContext[K] | undefined => {
      current();
      return [...entry.owners.values()].reverse().find(owner => owner[key])?.[key];
    };
    entry.ready = (async () => {
      const actor = context.demo ? DEMO_ACTOR : context.actor;
      const simulated = erpSimulated(context.demo);
      const simulation = simulated ? await import("./demo/simulated-api") : null;
      current();
      const auth = createSessionPort({ id: actor }, () => {
        const leave = current().onLeave;
        entry.invalidate(); leave();
      });
      expire = () => auth.expire();
      const apiUrl = erpApiUrl(context.profile);
      // Também cobre portas auxiliares que não passam pelo controlador.
      const scoped = async <T,>(read: () => Promise<T>) => {
        const signal = operational();
        try { const value = await read(); operational(); if (signal.aborted) throw cancelled(); return value; }
        catch (error) { if (signal.aborted || !entry.valid) throw cancelled(); throw error; }
      };
      const people = createPeoplePort(context.profile);
      const challenge = context.demo ? createSimulatedChallengePort() : createChallengePort();
      const emissor = simulation ? createDemoEmissorPort() : createEmissorPort(context.profile);
      const simulate = simulation?.createSimulatedApi({ actor, readOnly: context.demo });
      const fetchPort = createFetchPort({ apiUrl, actor,
        simulate: simulate ? (path, init) => path === "/v1/sistema/permissoes" && init.method === "GET"
          ? Response.json({ scope: "access_permissions", data_mode: "erp_native", user_id: actor, role: "admin", user_type: "normal", permissions: null, access: { open: true, until: null } })
          : simulate(path, init) : undefined,
      });
      const ports: ErpPorts = {
        auth, apiUrl, demo: context.demo,
        challenge: input => scoped(() => challenge(input)),
        people: signal => scoped(() => simulation ? Promise.resolve(structuredClone(simulation.simulatedPeople(actor))) : people(AbortSignal.any([signal, lifetime.signal, revision.signal]))),
        fetch: async (...args) => {
          const response = await scoped(() => fetchPort(args[0], { ...args[1], signal: AbortSignal.any([lifetime.signal, revision.signal, ...(args[1]?.signal ? [args[1].signal] : [])]) }));
          // Um 401 de uma geração já cancelada não encerra a sessão retomada.
          if (response.status === 401 && !args[1]?.signal?.aborted) {
            const onExpired = current().onExpired;
            entry.invalidate(); onExpired();
          }
          return response;
        },
        embedded: true,
        accessHost: ErpAccessHost,
        contactProfileEditor: ContactProfileEntry,
        get admin() { return current().management.role === "admin"; },
        openModules: () => current().onModules(),
        get openPeople() { return current().management.role === "admin" ? () => current().onPeople() : undefined; },
        get confirmIdentity() { return context.demo || !optional("onConfirmIdentity") ? undefined : async () => { await optional("onConfirmIdentity")?.(); }; },
        get openAccount() { return context.demo || !optional("onAccount") ? undefined : () => { optional("onAccount")?.(); }; },
        get openContactProfile() { return !optional("openContactProfile") ? undefined : (contactId: string) => optional("openContactProfile")?.(contactId); },
        emissor: {
          read: signal => scoped(() => emissor.read(AbortSignal.any([lifetime.signal, revision.signal, ...(signal ? [signal] : [])]))),
          save: body => scoped(() => emissor.save(body)),
          remove: () => scoped(() => emissor.remove()),
          test: () => scoped(() => emissor.test()),
        },
      };
      const access = createAccessController(ports.auth, ports.apiUrl, ports.fetch, {});
      controller = access;
      ports.controller = access;
      const runtime: ErpHostRuntime = {
        key, ports, controller: access, context: () => [...entry.owners.values()].at(-1) ?? context,
        allowed(to, state = access.getSnapshot()) {
          return entry.valid && available() && state.phase === "ready" && state.membership?.user_id === actor &&
            portedTargetState(to, current().management, simulated) === "allowed" &&
            portedPermissionAllowed(to, state.membership?.role, state.membership?.resources ?? [],
              state.permissions?.userId === actor && state.permissions.apiUrl === apiUrl ? state.permissions : null);
        },
      };
      // Sempre explícitos no runtime; o modo permissivo legado não participa da política.
      entry.updatePolicy();
      setMotorReal(!simulated);
      let lastNotice = 0;
      setActionPendingNotice(() => {
        if (!entry.valid || Date.now() - lastNotice < 5000) return;
        lastNotice = Date.now();
        toast("Esta ação ainda está em implantação no ERP do Wabotia e não foi feita. O restante da tela funciona normalmente.", { tone: "info", ms: 10000 });
      });
      removePorts = installErpPorts(ports);
      removeAccess = installErpTargetAccess(to => runtime.allowed(to));
      observe = access.subscribe(report);
      access.setSuspended(!available());
      stop = access.start();
      return runtime;
    })();
    // Pode ser descartado durante o import da simulação, antes de haver consumidor.
    void entry.ready.catch(() => undefined);
  } else { active.owners.set(owner, context); active.updatePolicy(); }
  const entry = active;
  let disposed = false;
  return {
    ready: entry.ready,
    update(next: ErpHostContext) {
      if (disposed || !entry.valid) return;
      if (erpHostKey(next) !== key) { entry.invalidate(); return; }
      entry.owners.delete(owner); entry.owners.set(owner, next);
      entry.updatePolicy();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const leaving = entry.owners.get(owner);
      entry.owners.delete(owner);
      leaving?.onPermissions?.(null);
      if (!entry.owners.size) entry.invalidate();
      else entry.updatePolicy();
    },
  };
}

export function useErpHost(context: ErpHostContext) {
  const key = erpHostKey(context), latest = useRef(context); latest.current = context;
  const lease = useRef<ReturnType<typeof acquireErpHost> | null>(null);
  const [result, setResult] = useState<{ key: string; runtime?: ErpHostRuntime; error?: unknown } | null>(null);
  useEffect(() => {
    const owner = acquireErpHost(latest.current); lease.current = owner;
    let live = true;
    void owner.ready.then(runtime => { if (live) setResult({ key, runtime }); }, error => { if (live) setResult({ key, error }); });
    return () => { live = false; owner.dispose(); if (lease.current === owner) lease.current = null; };
  }, [key]);
  useLayoutEffect(() => { lease.current?.update(context); });
  return result?.key === key ? result : null;
}

export type ErpHostView = { runtime: ErpHostRuntime; embedded: boolean; chromeTarget: HTMLElement | null; suspended?: boolean; Activity?: typeof React.Activity; holdGuard?: (check: () => boolean) => () => void; router?: ReturnType<typeof createMemoryRouter> | null; ToolsScope?: typeof ErpToolsScope; bindLinks?: (element: HTMLElement | null) => (() => void) | undefined; body?: (controller: AccessController, state: AccessState) => React.ReactNode };
export const ErpHostProvider = createContext<ErpHostView | null>(null);
export const useErpHostView = () => useContext(ErpHostProvider);

function ErpAccessHost({ children }: { children(host: ErpHostView | null): React.ReactNode }) {
  return children(useErpHostView());
}

/** Escopo de ferramentas pertence ao hospedeiro, fora da cópia portada. */
export function ErpToolsScope({ scopeRef, children }: { scopeRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  return <div className="fagoo-root" data-erp-tools="" ref={scopeRef}>{children}</div>;
}

export function TargetNotice({ state }: { state: string }) {
  const text: Record<string, string> = {
    loading: "Verificando acesso…", disabled: "Recurso desligado", denied: "Você não tem acesso a esta página",
    unavailable: "Página indisponível", "not-found": "Página não encontrada",
  };
  return <section className="real-state-panel" role="status"><h1>{text[state] ?? "Não foi possível abrir esta página"}</h1></section>;
}

