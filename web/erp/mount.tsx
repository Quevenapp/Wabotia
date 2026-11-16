// Monta o painel do Fagoo (web/erp/app) dentro da casca do Wabotia, na mesma
// árvore React. Faz o papel de app/erp-entry.tsx: roteador com basename
// /app/erp, guarda de alterações não salvas e as folhas globais do ERP.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./app/App";
import {
  UnsavedChangesProvider,
  useUnsavedChangesGuard,
} from "./app/hooks/useUnsavedChanges";
import { setNavigationGuard } from "../lib/routes";
import { setErpPorts, type ErpPorts } from "./ports";
import { createFetchPort, erpApiUrl } from "./fetch-port";
import {
  createCoreMfaPort,
  createSessionPort,
  createSimulatedMfaPort,
} from "./session-port";
// Ordem: o reset do escopo primeiro; as folhas do Fagoo, prefixadas no build
// (web/erp/css-scope.ts), vencem por terem uma classe a mais.
import "./scope.css";
import "./app/styles.css";
import "./app/fonts.css";
import "./app/fagoo-system.css";
import "./app/components/document-layout.css";

export const ERP_BASENAME = "/app/erp";

/** A guarda do Fagoo também segura a saída pelo trilho do painel. */
function GuardBridge() {
  const guard = useUnsavedChangesGuard();
  useEffect(() => {
    setNavigationGuard(() => guard.store.shouldBlock());
    return () => setNavigationGuard(null);
  }, [guard]);
  return null;
}

type Props = {
  profile: string;
  actor: string;
  demo: boolean;
  onLeave: () => void;
  onExpired: () => void;
};

/** API simulada: demonstração e desenvolvimento (web/erp/demo, chunk próprio). */
const simulated = (demo: boolean) =>
  demo ||
  (import.meta.env.DEV &&
    !new URLSearchParams(location.search).has("erp-real"));

/**
 * O ERP exige que o ator seja um UUID (as pessoas do Wabotia já são:
 * crypto.randomUUID). Só a pessoa fictícia da demonstração ("demo-user") não é.
 */
const DEMO_ACTOR = "d3e00000-0000-4000-8000-000000000001";

export default function ErpMount({
  profile,
  actor: panelActor,
  demo,
  onLeave,
  onExpired,
}: Props) {
  const actor = demo ? DEMO_ACTOR : panelActor;
  const [simulate, setSimulate] = useState<
    | null
    | ((
        path: string,
        init: RequestInit & { method: string },
      ) => Promise<Response>)
  >(null);
  const useSimulation = simulated(demo);
  useEffect(() => {
    if (!useSimulation) return;
    let live = true;
    void import("./demo/simulated-api").then(({ createSimulatedApi }) => {
      if (live)
        setSimulate(() => createSimulatedApi({ actor, readOnly: demo }));
    });
    return () => {
      live = false;
    };
  }, [useSimulation, actor, demo]);

  const ports = useMemo<ErpPorts | null>(() => {
    if (useSimulation && !simulate) return null;
    const auth = createSessionPort({ id: actor }, onLeave);
    const apiUrl = erpApiUrl(profile);
    return {
      auth,
      mfa: useSimulation ? createSimulatedMfaPort() : createCoreMfaPort(),
      apiUrl,
      fetch: createFetchPort({
        apiUrl,
        simulate: simulate ?? undefined,
        onUnauthorized: () => {
          auth.expire();
          onExpired();
        },
      }),
      demo,
    };
    // onLeave/onExpired mudam a cada render da casca; a sessão não.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, actor, demo, useSimulation, simulate]);

  // StrictMode monta, desmonta e monta de novo: o roteador nasce no efeito e é
  // descartado (router.dispose) ao sair da área.
  const [router, setRouter] = useState<ReturnType<
    typeof createBrowserRouter
  > | null>(null);
  useEffect(() => {
    if (!ports) return;
    setErpPorts(ports);
    // As telas do Fagoo recusam parâmetros que não conhecem no endereço; o
    // ?demo da casca já foi lido (a casca guarda o modo no estado).
    const search = new URLSearchParams(location.search);
    if (search.has("demo")) {
      search.delete("demo");
      const query = search.toString();
      history.replaceState(
        history.state,
        "",
        location.pathname + (query ? "?" + query : "") + location.hash,
      );
    }
    const next = createBrowserRouter(
      [
        {
          path: "*",
          element: (
            <UnsavedChangesProvider>
              <GuardBridge />
              <App />
            </UnsavedChangesProvider>
          ),
        },
      ],
      { basename: ERP_BASENAME },
    );
    setRouter(next);
    return () => {
      next.dispose();
      setRouter(null);
      setErpPorts(null);
    };
  }, [ports]);

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => keepLinksInside(root.current), []);

  return (
    <div className="fagoo-root" ref={root}>
      {router && <RouterProvider router={router} />}
    </div>
  );
}

/**
 * Algumas telas do Fagoo usam <a href="/rota"> cru, fora do roteador (abrir em
 * nova aba, atalhos). Com o ERP em /app/erp, esses endereços passam a levar o
 * prefixo; os <Link> do roteador já o levam.
 */
function keepLinksInside(element: HTMLElement | null) {
  if (!element) return;
  const fix = (scope: Node | null) => {
    if (!(scope instanceof Element)) scope = element;
    (scope as Element)
      .querySelectorAll<HTMLAnchorElement>(
        'a[href^="/"]:not([href^="/app/"]):not([href^="/api/"]):not([href^="//"])',
      )
      .forEach((link) =>
        link.setAttribute("href", ERP_BASENAME + link.getAttribute("href")),
      );
  };
  fix(element);
  const observer = new MutationObserver((changes) => {
    for (const change of changes)
      if (change.type === "attributes") fix(change.target.parentNode);
      else
        change.addedNodes.forEach(
          (node) => node instanceof Element && fix(node.parentNode),
        );
  });
  observer.observe(element, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  return () => observer.disconnect();
}
