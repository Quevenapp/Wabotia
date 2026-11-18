import React from "react";
import type { Calculation } from "../../../src/modules/juridico/calculation";
import type { Calendar, Rule } from "../../../src/modules/juridico/model";

export type CalendarView = { id: string; revision: number; calendar: Calendar; seed_warning: string | null };
export const warning = "Cálculo auxiliar: confira o calendário, a regra e o resultado com o advogado antes de usar.";
export const stamp = (at: number, timezone = "America/Sao_Paulo") => new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(at);
export const dateLabel = (date: string) => date.split("-").reverse().join("/");
export const emptyRule = (): Rule => ({ start_date: "", days: 5, include_start: false, start_non_working: "next", due_non_working: "next", due_time: "", alert_days: 2, alert_time: "09:00" });
export function CalculationView({ memory }: { memory: Calculation }) {
  if (!memory.trace) return <p role="alert">Cálculo indisponível nesta revisão. Confira a cobertura e as regras. A data anterior foi preservada.</p>;
  return <section className="jur-memory">
    <h3>Memória de cálculo</h3>
    <p><strong>Vencimento calculado: {stamp(memory.due_at, memory.calendar.timezone)}</strong> ({memory.calendar.timezone}).</p>
    <p>Termo informado: {dateLabel(memory.rule.start_date)}. Início ajustado: {dateLabel(memory.effective_start)}.
      {" "}{memory.rule.include_start ? "Inclui" : "Exclui"} o início ajustado na contagem de {memory.rule.days} dias úteis.</p>
    <p>Calendário: {memory.calendar.name} · {memory.calendar.jurisdiction}. Cobertura: {dateLabel(memory.calendar.from)} a {dateLabel(memory.calendar.to)}.</p>
    <p>Aviso interno: {stamp(memory.alert_at, memory.calendar.timezone)}. {warning}</p>
    <details><summary>Ver cada dia e suas fontes ({memory.trace.length} passos)</summary>
      <div className="jur-table"><table><thead><tr><th>Dia</th><th>Etapa</th><th>Resultado</th><th>Motivo / fonte</th></tr></thead><tbody>
        {memory.trace.map((day, i) => <tr key={i}><td>{dateLabel(day.date)}</td><td>{{ start: "Ajuste inicial", count: "Contagem", due: "Vencimento", alert: "Antecedência" }[day.phase]}</td>
          <td>{day.counted ? day.phase === "count" ? "Contado" : "Útil para esta etapa" : "Excluído"}</td><td>{day.reasons.join("; ") || "Dia útil"}{day.sources.length > 0 && <small>{day.sources.join("; ")}</small>}</td></tr>)}
      </tbody></table></div>
    </details>
  </section>;
}
