import React from "react";
import { linkProps } from "../../../lib/routes";
import { ExtraFields } from "../components/ExtraFields";
import { instantLabel } from "../work-hooks";
import type { ServiceObjectSnapshotView } from "../work-contracts";

/** A ficha atual nunca é consultada para renderizar esta cópia histórica. */
export function ObjectSnapshot({ snapshot, showCurrentLink = true }: {
  snapshot: ServiceObjectSnapshotView;
  showCurrentLink?: boolean;
}) {
  const later = snapshot.origin === "legacy_link";
  return <section className="os-object-snapshot" aria-label="Cópia histórica do objeto">
    <h3>{snapshot.type.labels.singular} {later ? "no vínculo posterior" : "na abertura"}</h3>
    <p><strong>{snapshot.identifier}</strong> · {later ? "Vinculado posteriormente" : "Capturado na abertura"} em {instantLabel(snapshot.captured_at)}.</p>
    <p>Cópia histórica, somente leitura. Versão {snapshot.object_version} do cadastro; revisão {snapshot.type.revision} da definição. Alterar o cadastro atual não muda esta cópia.</p>
    <dl className="os-work-fields"><ExtraFields fields={snapshot.type.fields} values={snapshot.values} readOnly /></dl>
    {showCurrentLink && <a {...linkProps({ area: "erp", page: "service-objects", id: snapshot.object_id })}>Ver cadastro atual e histórico</a>}
  </section>;
}
