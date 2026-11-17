// Pedido de aprovação à equipe (src/approvals.ts) na conversa interna: o
// cartão vem do módulo (números lidos por código); o resumo do bot aparece à
// parte, como não verificado. Aprovar (com ajuste opcional), Recusar (com
// motivo opcional) ou Assumir a conversa. O primeiro a decidir vence.
import React, { useState } from "react";
import { Check, Headphones, X } from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { navigate } from "../lib/routes";
import { Button, Field, Notice, Pill } from "../ui";

const statusLabels: Record<string, [string, "ok" | "warn" | "muted" | "danger"]> = {
  pending: ["Aguardando a equipe", "warn"],
  deciding: ["Decidindo", "warn"],
  approved: ["Aprovado", "ok"],
  declined: ["Recusado", "danger"],
  handoff: ["Conversa assumida", "ok"],
  expired: ["Venceu", "muted"],
};

export function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: Row;
  onDecided: () => void;
}) {
  const app = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [value, setValue] = useState(""),
    [reason, setReason] = useState("");
  const [label, tone] = statusLabels[approval.status] || [approval.status, "muted"];
  const pending = approval.status === "pending";
  async function decide(decision: "approve" | "decline" | "handoff") {
    if (busy || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      await app.api(
        `${app.root}/approvals/${encodeURIComponent(approval.id)}/decide`,
        "POST",
        {
          decision,
          ...(decision === "approve" && value.trim() ? { value: Number(value.replace(",", ".")) } : {}),
          ...(decision === "decline" && reason.trim() ? { reason: reason.trim() } : {}),
        },
        undefined,
        `decide:${approval.id}:${decision}`,
      );
      onDecided();
      if (decision === "handoff" && approval.conversation_id)
        navigate({ area: "conversations", id: approval.conversation_id });
    } catch (e: any) {
      setError(e?.message || "Não foi possível decidir.");
      onDecided();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="proposal-card">
      <p>
        <strong>{approval.title}</strong>
      </p>
      <dl className="proposal-params">
        {(approval.fields || []).map((f: Row) => (
          <React.Fragment key={f.key}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {approval.hidden_fields > 0 && (
        <p className="muted">
          <small>{approval.hidden_fields} campo(s) restrito(s) ao seu acesso.</small>
        </p>
      )}
      {approval.model_summary && (
        <p className="muted">
          <small>Resumo do bot (não verificado): {approval.model_summary}</small>
        </p>
      )}
      <div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {!pending && approval.decided_by && (
        <p className="muted">
          <small>
            Decidido por {app.names[approval.decided_by] || approval.decided_by}
            {approval.value !== null ? ` · ${approval.value}` : ""}
            {approval.reason ? ` · ${approval.reason}` : ""}
          </small>
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {pending && approval.can_decide && (
        <>
          {approval.adjust && (
            <Field
              label={`${approval.adjust.label} (opcional)`}
              value={value}
              onChange={setValue}
              type="text"
            />
          )}
          <Field label="Motivo da recusa (opcional)" value={reason} onChange={setReason} maxLength={300} />
          <div className="card-actions">
            <Button size="sm" icon={<Check size={15} />} busy={busy} onClick={() => void decide("approve")}>
              Aprovar
            </Button>
            <Button size="sm" secondary icon={<X size={15} />} disabled={busy} onClick={() => void decide("decline")}>
              Recusar
            </Button>
            <Button size="sm" secondary icon={<Headphones size={15} />} disabled={busy} onClick={() => void decide("handoff")}>
              Assumir a conversa
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
