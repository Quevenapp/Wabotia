import React from "react";
import { useApp } from "../../../app/AppContext";
import { ChildCollection } from "../components/ChildCollection";
import type { OrderHistory } from "../work-contracts";
import { instantLabel, useWorkApi } from "../work-hooks";
const labels: Record<string, string> = {
  opened: "Abertura",
  updated: "Atualização",
  status_changed: "Mudança de estado",
  stage_changed: "Mudança de etapa",
  quoted: "Orçamento enviado",
  approved: "Orçamento aprovado",
  declined: "Orçamento recusado",
  delivered: "Entrega",
  created: "Criação",
  archived: "Arquivamento",
};
export function WorkHistoryTab({ workId }: { workId: string }) {
  const api = useWorkApi(),
    app = useApp();
  return (
    <ChildCollection<OrderHistory>
      workId={workId}
      collection="history"
      load={(cursor) => api.history(workId, { cursor, limit: 50 })}
      render={(event) => (
        <>
          <strong>{labels[event.kind] || event.kind}</strong>
          <span>
            {instantLabel(event.created)} ·{" "}
            {app.names[event.actor] || event.actor}
          </span>
          {(event.from_stage || event.to_stage) && (
            <span>
              {event.from_stage || "—"} → {event.to_stage || "—"}
            </span>
          )}
          {event.entity_kind && (
            <span>
              {event.entity_kind} · {event.entity_id} · versão{" "}
              {event.entity_version}
            </span>
          )}
          {event.changed_fields?.length ? (
            <span>Campos: {event.changed_fields.join(", ")}</span>
          ) : null}
          {event.note && <p>{event.note}</p>}
        </>
      )}
    />
  );
}
