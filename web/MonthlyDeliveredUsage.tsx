import React from "react";

export type MonthlyUsage = {
  period: string;
  timezone: string;
  delivered: number;
  service_delivered: number;
  utility_delivered: number;
  marketing_delivered: number;
  authentication_delivered: number;
  unclassified_delivered: number;
  monitored_at: number;
};

export function MonthlyDeliveredUsage({ usage }: { usage?: MonthlyUsage }) {
  if (!usage)
    return <p>As entregas deste telefone ainda não foram consultadas.</p>;
  const categories: [string, number][] = [
    ["Atendimento · janela de 24 horas", usage.service_delivered],
    ["Atendimento · template (UTILITY)", usage.utility_delivered],
    ["Marketing · templates", usage.marketing_delivered],
  ];
  if (usage.authentication_delivered > 0)
    categories.push([
      "Autenticação · templates",
      usage.authentication_delivered,
    ]);
  if (usage.unclassified_delivered > 0)
    categories.push(["Categoria não informada", usage.unclassified_delivered]);
  const monitored = usage.monitored_at
    ? new Date(usage.monitored_at).toLocaleString("pt-BR", {
        timeZone: usage.timezone,
        dateStyle: "short",
        timeStyle: "short",
      })
    : null;
  return (
    <section
      className="monthly-delivered"
      aria-label="Mensagens entregues no mês"
    >
      <p>
        <strong className="router-count">
          {usage.delivered.toLocaleString("pt-BR")}
        </strong>{" "}
        mensagens entregues
        <small className="monthly-period">Mês: {usage.period}</small>
      </p>
      <dl>
        {categories.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value.toLocaleString("pt-BR")}</dd>
          </div>
        ))}
      </dl>
      <p className="router-field-help">
        Fuso: {usage.timezone}.
        {monitored && ` Monitoramento desde ${monitored}.`} Inclui somente
        mensagens com entrega ou leitura confirmada. Mensagens na fila ou apenas
        enviadas não entram na contagem. Templates de utilidade continuam nessa
        categoria mesmo sem cobrança.
      </p>
    </section>
  );
}
