// OS4: blocos do detalhe da ordem (clássica e modelos): o contrato que cobre
// a ordem ("Coberto pelo contrato nº 3: 1 de 2 visitas usadas neste mês") e
// a execução agendada (Agenda ou data combinada).
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Button, Field, Notice, toast } from "../../../ui";
import type { Order } from "../work-contracts";
import { ResourceState, dateTimeInput, dateTimeValue, useWorkApi, useWorkResource } from "../work-hooks";
import { pendingImplementation } from "../work-api";
import { brDate, type OrderContract, type OrderSchedule, type ScheduleSlots } from "./types";

const closed = (order: Pick<Order, "status">) => ["delivered", "cancelled"].includes(order.status);
const timeOf = (at: number) => new Date(at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export function OrderContractPanel({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const app = useApp(), api = useWorkApi();
  const [revision, setRevision] = useState(0);
  const [covering, setCovering] = useState<OrderContract["contracts"][number] | null>(null);
  const [releasing, setReleasing] = useState(false);
  const data = useWorkResource(`${app.root}/os4-order-contract/${order.id}/${order.version ?? ""}/${order.status}/${revision}`, () => api.orderContract(order.id));
  const done = (result: OrderContract) => {
    for (const warning of result.warnings || []) toast(warning, { tone: "error", ms: 9000 });
    setRevision(n => n + 1);
    onChanged();
  };
  // Instalação sem a rota (demonstração, versão antiga): o bloco some, sem erro.
  if (data.error) return pendingImplementation(data.error) ? null : <ResourceState resource={data} />;
  const view = data.data;
  if (!view) return null;
  if (!view.available) return <p className="muted">Contrato de manutenção: {view.missing}</p>;
  if (!view.contracts.length && !view.coverage) return null;
  const marked = view.coverage ? view.contracts.find(c => c.id === view.coverage!.contract_id) : null;
  return <section className="os-work-section os4-contract">
    <h3>Contrato de manutenção</h3>
    {view.coverage ? <>
      <p><strong>Coberta pelo contrato nº {view.coverage.contract_number}</strong>: {view.coverage.covered_text || "nada coberto"}
        {view.coverage.excess_text ? ` · excedente: ${view.coverage.excess_text}` : ""}.
        {marked ? ` ${marked.usage.text}.` : ""}</p>
      {!view.coverage.counts && <p className="muted">A ordem foi cancelada: o limite do contrato foi devolvido.</p>}
      {!!view.coverage.excess_units && view.coverage.excess_rule === "approval" && <Notice>Excedente ao contrato: envie o orçamento e registre a aprovação do cliente antes de executar.</Notice>}
      {!!view.coverage.excess_units && view.coverage.excess_rule === "quote" && <p className="muted">O excedente segue o orçamento normal da ordem.</p>}
      {!closed(order) && <Button secondary size="sm" onClick={() => setReleasing(true)}>Desmarcar cobertura</Button>}
    </> : view.contracts.map(contract => <div key={contract.id} className="os-work-record">
      <p><strong>{contract.headline}</strong></p>
      {contract.warnings.map(w => <p key={w} className="muted">{w}</p>)}
      {contract.blocked_reason ? <Notice>{contract.blocked_reason}</Notice>
        : contract.can_cover && <Button size="sm" onClick={() => contract.coverage.unit === "hours" ? setCovering(contract) : api.coverOrder(order.id, { contract_id: contract.id, version: order.version }).then(done, error => toast((error as Error).message, { tone: "error" }))}>Marcar como coberta</Button>}
    </div>)}
    {covering && <FormHours contract={covering} onClose={() => setCovering(null)} onSubmit={async hours => {
      const result = await api.coverOrder(order.id, { contract_id: covering.id, hours, version: order.version });
      setCovering(null);
      done(result);
    }} />}
    {releasing && <ReleaseDialog onClose={() => setReleasing(false)} onSubmit={async reason => {
      const result = await api.releaseCoverage(order.id, { reason });
      setReleasing(false);
      done(result);
    }} />}
  </section>;
}

function FormHours({ contract, onClose, onSubmit }: { contract: OrderContract["contracts"][number]; onClose: () => void; onSubmit: (hours: number) => Promise<void> }) {
  const [hours, setHours] = useState("1");
  return <FormDialog title={`Coberta pelo ${contract.display_number.toLowerCase()}`} submitLabel="Marcar como coberta" onClose={onClose}
    subtitle={contract.usage.text}
    onSubmit={async () => {
      const value = Number(hours.replace(",", "."));
      if (!Number.isFinite(value) || value <= 0) throw new Error("Informe as horas desta ordem, por exemplo 1,5.");
      await onSubmit(value);
    }}>
    <Field label="Horas desta ordem" required value={hours} onChange={setHours} help="O que passar do limite do período entra como excedente." />
  </FormDialog>;
}

function ReleaseDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  return <FormDialog title="Desmarcar cobertura do contrato" submitLabel="Desmarcar" onClose={onClose}
    subtitle="O limite do período volta para o contrato. Revise o orçamento depois."
    onSubmit={async () => {
      if (!reason.trim()) throw new Error("Informe o motivo.");
      await onSubmit(reason.trim());
    }}>
    <Field label="Motivo" required value={reason} maxLength={500} onChange={setReason} />
  </FormDialog>;
}

export function OrderSchedulePanel({ order, onChanged }: { order: Order; onChanged?: () => void }) {
  const app = useApp(), api = useWorkApi();
  const [revision, setRevision] = useState(0), [editing, setEditing] = useState(false), [cancelling, setCancelling] = useState(false);
  const data = useWorkResource(`${app.root}/os4-schedule/${order.id}/${order.status}/${revision}`, () => api.schedule(order.id));
  const done = (result: OrderSchedule) => {
    for (const warning of result.warnings || []) toast(warning, { tone: "error", ms: 9000 });
    setRevision(n => n + 1);
    onChanged?.();
  };
  if (data.error) return pendingImplementation(data.error) ? null : <ResourceState resource={data} />;
  const view = data.data;
  if (!view) return null;
  const s = view.schedule, active = s?.state === "active";
  return <section className="os-work-section os4-schedule">
    <h3>Execução agendada</h3>
    {s ? <>
      <p><strong>{active ? `Agendado para ${s.when_text}` : `Agendamento de ${s.when_text} cancelado`}</strong>
        {s.mode === "agenda" ? ` · Agenda${s.service?.name ? `: ${s.service.name}` : ""}${s.professional?.name ? ` com ${s.professional.name}` : ""}` : " · data combinada"}
        {s.appointment ? ` · ${s.appointment.status_label}` : ""}</p>
      {s.changed_by_agenda && <Notice>{active ? "O horário foi alterado pela Agenda." : "O agendamento foi cancelado pela Agenda."}</Notice>}
      {s.agenda_off && <p className="muted">A Agenda está desligada: o horário mostrado é o último conhecido. Ligue o módulo Agenda para reagendar ou cancelar.</p>}
      {s.note && <p className="muted">{s.note}</p>}
    </> : <p className="muted">Sem execução agendada.</p>}
    {!view.agenda.enabled && <p className="muted">{view.agenda.message}</p>}
    {!view.whatsapp.ready && <p className="muted">{view.whatsapp.reason}</p>}
    {!closed(order) && <div className="os-work-toolbar">
      <Button size="sm" onClick={() => setEditing(true)}>{active ? "Reagendar" : "Agendar"}</Button>
      {active && <Button secondary size="sm" onClick={() => setCancelling(true)}>Cancelar agendamento</Button>}
    </div>}
    {editing && <ScheduleDialog order={order} view={view} onClose={() => setEditing(false)} onSaved={result => { setEditing(false); done(result); }} />}
    {cancelling && <FormDialog title="Cancelar agendamento" danger submitLabel="Cancelar agendamento" onClose={() => setCancelling(false)}
      subtitle={s?.mode === "agenda" ? "O agendamento também é cancelado na Agenda e o cliente recebe o aviso de cancelamento da Agenda." : "O cliente é avisado pela conversa da ordem."}
      onSubmit={async () => { const result = await api.cancelSchedule(order.id, {}); setCancelling(false); done(result); }}>
      <p>Cancelar a execução de {s?.when_text}?</p>
    </FormDialog>}
  </section>;
}

function ScheduleDialog({ order, view, onClose, onSaved }: { order: Order; view: OrderSchedule; onClose: () => void; onSaved: (result: OrderSchedule) => void }) {
  const app = useApp(), api = useWorkApi();
  const current = view.schedule?.state === "active" ? view.schedule : null;
  const [mode, setMode] = useState<"agenda" | "manual">(view.agenda.enabled && current?.mode !== "manual" ? "agenda" : "manual");
  const options = useWorkResource(view.agenda.enabled ? `${app.root}/os4-schedule-options` : null, () => api.scheduleOptions());
  const [service, setService] = useState(current?.service?.id || ""), [professional, setProfessional] = useState(current?.mode === "agenda" ? current.professional?.id || "" : "");
  const [from, setFrom] = useState(() => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10));
  const [slot, setSlot] = useState<{ starts: number; professional_id: string } | null>(null);
  const [manual, setManual] = useState(current?.mode === "manual" ? dateTimeInput(current.starts) : ""), [note, setNote] = useState(current?.note || "");
  const slots = useWorkResource<ScheduleSlots>(mode === "agenda" && service ? `${app.root}/os4-slots/${order.id}/${service}/${professional}/${from}` : null,
    () => api.scheduleSlots({ service_id: service, professional_id: professional || undefined, from, days: 7, order_id: order.id }));
  const professionals = (options.data?.professionals || []).filter(p => !service || p.service_ids.includes(service));
  const names = Object.fromEntries((options.data?.professionals || []).map(p => [p.id, p.name]));
  return <FormDialog title={current ? "Reagendar a execução" : "Agendar a execução"} submitLabel={current ? "Reagendar" : "Agendar"} size="lg" onClose={onClose}
    subtitle={view.whatsapp.ready ? "O cliente recebe a confirmação e o lembrete pelo WhatsApp." : view.whatsapp.reason || undefined}
    onSubmit={async () => {
      if (mode === "agenda") {
        if (!service) throw new Error("Escolha o serviço da Agenda.");
        if (!slot) throw new Error("Escolha um horário livre.");
        onSaved(await api.setSchedule(order.id, { mode, service_id: service, professional_id: slot.professional_id || professional || null, starts: slot.starts, note }));
      } else {
        const starts = dateTimeValue(manual);
        if (!starts) throw new Error("Informe a data e a hora combinadas.");
        onSaved(await api.setSchedule(order.id, { mode, starts, note }));
      }
    }}>
    {view.agenda.enabled
      ? <Field label="Como agendar" value={mode} emptyOption={null} options={[{ id: "agenda", name: "Pelos horários livres da Agenda" }, { id: "manual", name: "Data e hora combinadas (sem a Agenda)" }]} onChange={value => setMode(value as "agenda" | "manual")} />
      : <Notice>{view.agenda.message}</Notice>}
    {mode === "agenda" ? <>
      <ResourceState resource={options} />
      {options.data && !options.data.services.length && <Notice>Cadastre serviços e profissionais em Agenda → Serviços e horários.</Notice>}
      {options.data && options.data.services.length > 0 && <div className="form-field-grid">
        <Field label="Serviço" required value={service} options={options.data.services.map(s => ({ id: s.id, name: `${s.name} · ${s.duration_minutes} min` }))} onChange={value => { setService(value); setSlot(null); }} />
        <Field label="Profissional" value={professional} emptyOption="Qualquer um livre" options={professionals.map(p => ({ id: p.id, name: p.name }))} onChange={value => { setProfessional(value); setSlot(null); }} />
        <Field label="A partir de" type="date" value={from} onChange={value => { setFrom(value); setSlot(null); }} />
      </div>}
      {service && <ResourceState resource={slots} />}
      {slots.data && (slots.data.days.some(d => d.slots.length) ? slots.data.days.filter(d => d.slots.length).map(d => <div key={d.date} className="os4-slots">
        <p><strong>{brDate(d.date)}</strong></p>
        <div className="os-work-toolbar">{d.slots.map(s => {
          const chosen = slot?.starts === s.starts;
          const who = professional || s.professional_ids[0] || "";
          return <Button key={s.starts} size="sm" secondary={!chosen} onClick={() => setSlot({ starts: s.starts, professional_id: who })}
            >{timeOf(s.starts)}{!professional && who && names[who] ? ` · ${names[who]}` : ""}</Button>;
        })}</div>
      </div>) : <p className="muted">Sem horários livres nestes 7 dias. Escolha outra data ou outro profissional.</p>)}
    </> : <>
      <Field label="Data e hora combinadas" type="datetime-local" required value={manual} onChange={setManual} help="Sem conferência de conflito de horário." />
    </>}
    <Field label="Observação (opcional)" value={note} maxLength={300} onChange={setNote} />
  </FormDialog>;
}
