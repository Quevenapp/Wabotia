import React, { useSyncExternalStore } from "react";
import { useRoute } from "../../lib/routes";
import { os2OperationalPages } from "./objects/ServiceObjectsPage";

export interface Os2ObjectPageProps { objectId?: string }
export interface Os2Pages {
  ServiceObjectsPage: React.ComponentType<Os2ObjectPageProps>;
}
const listeners = new Set<() => void>();
const installations = new Map<symbol, Partial<Os2Pages>>();
// Páginas de produção conectadas estaticamente. Este arquivo só é baixado pela
// rota interna (importação sob demanda no registro), fora do pacote inicial.
const production: Os2Pages = { ...os2OperationalPages };
let pages: Os2Pages = production;
const refresh = () => {
  pages = Object.assign({}, production, ...installations.values());
  listeners.forEach((listener) => listener());
};

/** Substituição explícita (testes/demonstração); remove apenas a própria instalação. */
export function installOs2Pages(next: Partial<Os2Pages>) {
  const owner = Symbol("os2-pages");
  installations.set(owner, { ...next });
  refresh();
  return () => {
    if (installations.delete(owner)) refresh();
  };
}

export function Os2ObjectPage() {
  const route = useRoute();
  const installed = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => pages,
  );
  const Page = installed.ServiceObjectsPage;
  return <Page objectId={route.id} />;
}
