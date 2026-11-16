// Proposta de ação do bot na conversa interna (src/bot-actions): o bot só
// propõe; a pessoa confirma ou cancela aqui. Operação sensível pede o código
// do autenticador (mfa_required).
import React, { useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { Button, Notice, Pill } from "../ui";

const statusLabels: Record<string, [string, "ok" | "warn" | "muted" | "danger"]> = {
  pending: ["Aguardando você", "warn"],
  running: ["Executando", "warn"],
  done: ["Feito", "ok"],
  failed: ["Não foi possível", "danger"],
  cancelled: ["Cancelada", "muted"],
  expired: ["Venceu", "muted"],
};

export function ProposalCard({
  chatId,
  payload,
  onDecided,
}: {
  chatId: string;
  payload: Row;
  onDecided: () => void;
}) {
  const app = useApp();
  const proposal: Row = payload.proposal || {};
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [mfa, setMfa] = useState(false);
  const [label, tone] = statusLabels[proposal.status] || [proposal.status, "muted"];
  const params = Object.entries(proposal.params || {});
  async function decide(decision: "confirm" | "cancel") {
    if (busy || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    setMfa(false);
    try {
      await app.api(
        `${app.root}/internal-chats/${encodeURIComponent(chatId)}/proposals/${encodeURIComponent(proposal.id)}/${decision}`,
        "POST",
        {},
        undefined,
        `${decision}:${proposal.id}`,
      );
      onDecided();
    } catch (e: any) {
      if (e?.code === "mfa_required") setMfa(true);
      else setError(e?.message || "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="proposal-card">
      {/* O que roda ao confirmar, montado no servidor; o texto do modelo vai
          à parte, marcado como não conferido. */}
      {proposal.description ? (
        <>
          <p className="proposal-description">
            <strong>{proposal.description}</strong>
          </p>
          {proposal.summary && (
            <p className="muted">
              <small>Texto do bot (não conferido): {proposal.summary}</small>
            </p>
          )}
        </>
      ) : (
        <p>
          <strong>{proposal.summary}</strong>
        </p>
      )}
      <p className="muted">
        <small>
          {payload.operation_summary || proposal.operation}
          {proposal.sensitive && (
            <>
              {" "}
              · <ShieldAlert size={12} /> pede o código do autenticador
            </>
          )}
        </small>
      </p>
      {!proposal.description && params.length > 0 && (
        <dl className="proposal-params">
          {params.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {proposal.error && <p className="muted"><small>{proposal.error}</small></p>}
      {mfa && (
        <Notice tone="warn">
          Esta operação pede o código do autenticador. Confirme o código da sua conta e toque em Confirmar de novo.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {proposal.status === "pending" && (
        <div className="card-actions">
          <Button size="sm" icon={<Check size={15} />} busy={busy} onClick={() => void decide("confirm")}>
            Confirmar
          </Button>
          <Button size="sm" secondary icon={<X size={15} />} disabled={busy} onClick={() => void decide("cancel")}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}
