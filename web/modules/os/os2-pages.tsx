import React, { useSyncExternalStore } from "react";
import { useRoute } from "../../lib/routes";
import { Empty } from "../../ui";

export interface Os2ObjectPageProps { objectId?: string }
export interface Os2Pages {
  ServiceObjectsPage: React.ComponentType<Os2ObjectPageProps>;
}
const listeners = new Set<() => void>();
const installations = new Map<symbol, Partial<Os2Pages>>();
let pages: Partial<Os2Pages> = {};
const refresh = () => {
  pages = Object.assign({}, ...installations.values());
  listeners.forEach((listener) => listener());
};

/** A junção final instala a página da folha; testes removem apenas sua própria instalação. */
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
  return Page ? <Page objectId={route.id} /> : <Empty
    title="Objetos do cliente ainda indisponíveis"
    description="Este recurso ainda não está disponível nesta instalação."
  />;
}
