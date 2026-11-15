// Passos web da conversa (docs/MODULOS.md): links de formulário e de módulos
// enviados ao cliente, com o estado de cada um e as respostas recebidas.
import React from "react";
import type { Row } from "../lib/api";
import { whenLabel } from "../lib/format";
import { Pill, type PillTone } from "../ui";
import { useApp } from "../app/AppContext";

export const webStepStates: Record<string, [string, PillTone]> = {
  sent: ["Enviado", "muted"],
  opened: ["Aberto", "warn"],
  completed: ["Concluído", "ok"],
  expired: ["Expirado", "danger"],
  cancelled: ["Cancelado", "muted"],
};

const answerText = (field: Row, value: unknown) =>
  field.type === "accept"
    ? value
      ? "Sim"
      : "Não"
    : field.type === "date" && typeof value === "string" && value
      ? value.split("-").reverse().join("/")
      : String(value || "—");

export function WebStepsSection({ steps }: { steps: Row[] }) {
  const app = useApp();
  if (!steps.length) return null;
  return (
    <section className="info-section">
      <h4>Formulários e links</h4>
      <div className="info-web-steps">
        {steps.map((step) => {
          const [label, tone] = webStepStates[step.status] || [
            step.status,
            "muted",
          ];
          const when =
            step.status === "completed"
              ? "Concluído " + whenLabel(step.completed_at, app.now)
              : step.status === "opened"
                ? "Aberto " + whenLabel(step.opened_at, app.now)
                : step.status === "sent"
                  ? "Vale até " +
                    new Date(step.expires_at).toLocaleString("pt-BR", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "Enviado " + whenLabel(step.created, app.now);
          return (
            <details className="info-web-step" key={step.id}>
              <summary>
                <span className="info-ticket-top">
                  <strong className="truncate">{step.title}</strong>
                  <Pill tone={tone}>{label}</Pill>
                </span>
                <small>{when}</small>
              </summary>
              {step.status === "completed" && step.answers ? (
                <dl>
                  {(step.fields || []).map((field: Row) => (
                    <React.Fragment key={field.id}>
                      <dt>{field.label}</dt>
                      <dd>{answerText(field, step.answers[field.id])}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              ) : (
                <p className="muted">
                  {step.status === "expired"
                    ? "O link venceu sem resposta. Envie outro se precisar."
                    : step.status === "cancelled"
                      ? "Link cancelado pela equipe."
                      : "Aguardando o cliente responder pelo link."}
                </p>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
