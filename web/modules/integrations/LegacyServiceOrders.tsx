import React, { useEffect, useRef, useState } from "react";
import { useIntegrationApi, integrationError } from "./api";
import { integrationAccess, sourceHref, useIntegrationHost } from "./visibility";
import type { DocumentOrigin } from "./contracts";

export function LegacyServiceOrders() {
  const host = useIntegrationHost();
  if (!host || !integrationAccess(host.context).documents) return null;
  return <a href="/app/erp/documentos-empresa?tipo=service_orders&legado=1">Documentos anteriores à integração</a>;
}
// A âncora é imutável. Uma resposta posterior que omite a origem (por revogação
// ou módulo desligado) nunca deve destravar um documento já reconhecido.
// Só guardamos a trava; não reapresentamos a origem sem autorização atual.
const knownLinked = new Set<string>();
/** O editor e os auxiliares só montam depois desta leitura; falha fecha a edição. */
export function useDocumentOrigins(ids: readonly string[]) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const hosted = useRef(false);
  if (host) hosted.current = true;
  const key = JSON.stringify(ids), allowed = !!host && integrationAccess(host.context).documents;
  const [state, setState] = useState<{ api: typeof api; key: string; origins: DocumentOrigin[]; error: string } | null>(null);
  useEffect(() => {
    if (!api || !allowed || !ids.length) return;
    const request = new AbortController();
    void api.origins([...ids], request.signal).then(origins => { if (!request.signal.aborted) setState({ api, key, origins, error: "" }); }).catch(e => { if (!request.signal.aborted) setState({ api, key, origins: [], error: integrationError(e) }); });
    return () => request.abort();
  }, [api, allowed, key]);
  const current = state?.api === api && state.key === key ? state : null;
  if (host && current) for (const origin of current.origins) knownLinked.add(JSON.stringify([host.root, origin.document_id]));
  return { host, ready: (!host && !hosted.current) || !!host && allowed && (!ids.length || !!current && !current.error), origins: current?.origins ?? [],
    protectedIds: host ? ids.filter(id => knownLinked.has(JSON.stringify([host.root, id]))) : [], error: current?.error ?? "" };
}
export function DocumentOriginNotice({ origin }: { origin: DocumentOrigin }) {
  return <p>Documento vinculado · somente leitura. <a href={sourceHref(origin.source)}>{origin.source.module === "os" ? "Abrir trabalho" : origin.source.module === "mesas" ? "Abrir conta" : origin.source.module === "pedido" ? "Abrir pedido" : "Abrir origem"}</a></p>;
}
