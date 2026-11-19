import React, { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import type { CatalogEditorProps } from "./app/components/CatalogEditor";
import { erpPorts } from "./ports";

const ErpProfileEntry = lazy(() => import("../contact-profile/ContactProfile").then(module => ({ default: module.ErpProfileEntry })));

/** Adaptador da ficha única, instalado somente ao montar o hospedeiro ERP. */
export function ContactProfileEntry(props: CatalogEditorProps) {
  const snapshot = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
  const changed = useRef(false);
  const ports = erpPorts();
  const [sessionEpoch, setSessionEpoch] = useState(0);
  useEffect(() => {
    const subscription = ports?.auth.onAuthStateChange(() => setSessionEpoch(epoch => epoch + 1)).data.subscription;
    return () => subscription?.unsubscribe();
  }, [ports?.auth]);
  if (!props.record || !ports || snapshot.phase !== "ready") return <section className="real-editor catalog-editor"><p role="alert">Ficha completa temporariamente indisponível.</p><button type="button" onClick={props.onClose}>Voltar à listagem</button></section>;
  const root = ports.apiUrl.replace(/^\/api\//, "").replace(/\/erp\/?$/, "");
  return <Suspense fallback={<p role="status">Abrindo ficha…</p>}><ErpProfileEntry api={api} root={root} erpContactId={String(props.record.id)}
    scopeKey={JSON.stringify([root, snapshot.phase, snapshot.membership, sessionEpoch])}
    openContactProfile={ports.openContactProfile} onSaved={() => { changed.current = true; }}
    onClose={() => { if (changed.current) props.onSaved(props.record!); props.onClose(); }} /></Suspense>;
}
