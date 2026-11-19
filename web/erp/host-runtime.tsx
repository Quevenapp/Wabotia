import React, { createContext, useContext, useEffect, useRef, useState } from "react";
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

const DEMO_ACTOR = "d3e00000-0000-4000-8000-000000000001";
const cancelled = () => new DOMException("Contexto do ERP encerrado", "AbortError");

export function erpHostKey(context: ErpHostContext): string {
  const c = context.management;
  return JSON.stringify([context.profile, context.actor, context.demo, c.statusLoaded, c.role, c.erpRole,
    c.access && [...c.access].sort(), Object.entries(c.modules).sort()]);
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
    let expire: (() => void) | undefined;
    const lifetime = new AbortController();
    const entry: Entry = {
      key, owners: new Map(), valid: true, ready: null!,
      invalidate() {
        if (!entry.valid) return;
        entry.valid = false;
        lifetime.abort();
        // Publica signed_out e cancela as leituras antes de descartar o store.
        expire?.(); stop?.(); removePorts?.(); removeAccess?.();
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
        current();
        const value = await read();
        current();
        return value;
      };
      const people = createPeoplePort(context.profile);
      const challenge = context.demo ? createSimulatedChallengePort() : createChallengePort();
      const emissor = simulation ? createDemoEmissorPort() : createEmissorPort(context.profile);
      const fetchPort = createFetchPort({ apiUrl, actor,
        simulate: simulation?.createSimulatedApi({ actor, readOnly: context.demo }),
        onUnauthorized: () => {
          if (!entry.valid) return;
          const onExpired = current().onExpired;
          entry.invalidate(); onExpired();
        },
      });
      const ports: ErpPorts = {
        auth, apiUrl, demo: context.demo,
        challenge: input => scoped(() => challenge(input)),
        people: signal => scoped(() => simulation ? Promise.resolve(structuredClone(simulation.simulatedPeople(actor))) : people(AbortSignal.any([signal, lifetime.signal]))),
        fetch: async (...args) => {
          current();
          const response = await fetchPort(args[0], { ...args[1], signal: AbortSignal.any([lifetime.signal, ...(args[1]?.signal ? [args[1].signal] : [])]) });
          current();
          return response;
        },
        admin: context.management.role === "admin",
        openModules: () => current().onModules(),
        get openPeople() { return current().management.role === "admin" ? () => current().onPeople() : undefined; },
        get confirmIdentity() { return context.demo || !optional("onConfirmIdentity") ? undefined : async () => { await optional("onConfirmIdentity")?.(); }; },
        get openAccount() { return context.demo || !optional("onAccount") ? undefined : () => { optional("onAccount")?.(); }; },
        get openContactProfile() { return !optional("openContactProfile") ? undefined : (contactId: string) => optional("openContactProfile")?.(contactId); },
        emissor: {
          read: signal => scoped(() => emissor.read(AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]))),
          save: body => scoped(() => emissor.save(body)),
          remove: () => scoped(() => emissor.remove()),
          test: () => scoped(() => emissor.test()),
        },
      };
      const controller = createAccessController(ports.auth, ports.apiUrl, ports.fetch, {});
      const runtime: ErpHostRuntime = {
        key, ports, controller, context: () => [...entry.owners.values()].at(-1) ?? context,
        allowed(to, state = controller.getSnapshot()) {
          return entry.valid && state.phase === "ready" &&
            portedTargetState(to, current().management, simulated) === "allowed" &&
            portedPermissionAllowed(to, state.membership?.role, state.membership?.resources ?? []);
        },
      };
      // Sempre explícitos no runtime; o modo permissivo legado não participa da política.
      setErpBlocks(Object.fromEntries(["erp", "erp-fiscal", "erp-cobranca", "erp-pdv"].map(id => [id, context.management.modules[id] === true])));
      setMotorReal(!simulated);
      let lastNotice = 0;
      setActionPendingNotice(() => {
        if (!entry.valid || Date.now() - lastNotice < 5000) return;
        lastNotice = Date.now();
        toast("Esta ação ainda está em implantação no ERP do Wabotia e não foi feita. O restante da tela funciona normalmente.", { tone: "info", ms: 10000 });
      });
      removePorts = installErpPorts(ports);
      removeAccess = installErpTargetAccess(to => runtime.allowed(to));
      stop = controller.start();
      return runtime;
    })();
    // Pode ser descartado durante o import da simulação, antes de haver consumidor.
    void entry.ready.catch(() => undefined);
  } else active.owners.set(owner, context);
  const entry = active;
  let disposed = false;
  return {
    ready: entry.ready,
    update(next: ErpHostContext) {
      if (disposed || !entry.valid) return;
      if (erpHostKey(next) !== key) { entry.invalidate(); return; }
      entry.owners.set(owner, next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entry.owners.delete(owner);
      if (!entry.owners.size) entry.invalidate();
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
  useEffect(() => { lease.current?.update(context); });
  return result?.key === key ? result : null;
}

type HostView = { runtime: ErpHostRuntime; embedded: boolean; chromeTarget: HTMLElement | null; router?: ReturnType<typeof createMemoryRouter> | null; body?: (controller: AccessController, state: AccessState) => React.ReactNode };
export const ErpHostProvider = createContext<HostView | null>(null);
export const useErpHostView = () => useContext(ErpHostProvider);

/** Escopo de ferramentas fora da árvore de estilos do painel hospedeiro. */
export function ErpToolsScope({ scopeRef, children }: { scopeRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  return <div className="fagoo-root" data-erp-tools="" ref={scopeRef}>{children}</div>;
}

/** Compatibilidade dos testes e da montagem independente anterior ao hospedeiro. */
const controllers = new WeakMap<ErpPorts, { controller: AccessController; users: number; stop?: () => void }>();
export function useErpAccess(ports: ErpPorts) {
  const host = useErpHostView();
  let shared = controllers.get(ports);
  if (!shared) {
    shared = { controller: host?.runtime.controller ?? createAccessController(ports.auth, ports.apiUrl, ports.fetch, {}), users: 0 };
    controllers.set(ports, shared);
  }
  const entry = shared;
  useEffect(() => {
    if (host) return;
    if (entry.users++ === 0) entry.stop = entry.controller.start();
    return () => { if (--entry.users === 0) { entry.stop?.(); entry.stop = undefined; } };
  }, [entry, host]);
  return host?.runtime.controller ?? entry.controller;
}

export function TargetNotice({ state }: { state: string }) {
  const text: Record<string, string> = {
    loading: "Verificando acesso…", disabled: "Recurso desligado", denied: "Você não tem acesso a esta página",
    unavailable: "Página indisponível", "not-found": "Página não encontrada",
  };
  return <section className="real-state-panel" role="status"><h1>{text[state] ?? "Não foi possível abrir esta página"}</h1></section>;
}

