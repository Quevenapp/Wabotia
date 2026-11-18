import React, { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import type { Calculation } from "../../../src/modules/juridico/calculation";
import type { Rule } from "../../../src/modules/juridico/model";
import { CalculationView, emptyRule, type CalendarView } from "./shared";

export function CreateDeadline({ calendars, people, created }: { calendars: CalendarView[]; people: Row[]; created: () => Promise<void> }) {
  const app = useApp(), write = useIntents(app.api);
  const [rule, setRule] = useState<Rule>(emptyRule), [calendarId, setCalendarId] = useState("");
  const [title, setTitle] = useState(""), [assignee, setAssignee] = useState(""), [order, setOrder] = useState(""), [search, setSearch] = useState("");
  const [orders, setOrders] = useState<Row[]>([]), [memory, setMemory] = useState<Calculation | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const calendar = calendars.find(c => c.id === calendarId);
  const currentKey = JSON.stringify([calendarId, calendar?.revision, rule]);
  useEffect(() => { setMemory(null); }, [rule, calendarId, calendar?.revision]);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      app.api(`${app.root}/service-orders?open=1&limit=50&q=${encodeURIComponent(search)}`, "GET", undefined, abort.signal)
        .then(result => setOrders(result.data)).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [app.api, app.root, search]);
  const set = <K extends keyof Rule>(key: K, value: Rule[K]) => setRule(r => ({ ...r, [key]: value }));
  async function simulate(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const result = await write(`${app.root}/juridico/preview`, "POST", { calendar_id: calendarId, calendar_revision: calendar?.revision, rule });
      setMemory(result); setPreviewKey(currentKey);
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      await write(`${app.root}/juridico/deadlines`, "POST", { order_id: order, title, assignee, calendar_id: calendarId, calendar_revision: calendar?.revision, rule });
      setMemory(null); setTitle(""); await created();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form className="card jur-form" onSubmit={simulate}>
    <h2>Novo prazo</h2>
    <fieldset className="jur-grid" disabled={busy}>
      <label>Buscar processo<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Número ou descrição" /></label>
      <label>Processo<select required value={order} onChange={e => setOrder(e.target.value)}><option value="">Selecione o trabalho</option>{orders.map(o => <option key={o.id} value={o.id}>{o.display_number || o.number} · {o.item}</option>)}</select></label>
      <label>Providência<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Advogado responsável<select required value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">Selecione</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Calendário<select required value={calendarId} onChange={e => setCalendarId(e.target.value)}><option value="">Selecione</option>{calendars.map(c => <option key={c.id} value={c.id}>{c.calendar.name} · revisão {c.revision}</option>)}</select></label>
      <label>Termo inicial definido pelo advogado<input required type="date" value={rule.start_date} onChange={e => set("start_date", e.target.value)} /></label>
      <label>Quantidade de dias úteis<input required type="number" min={1} max={366} value={rule.days} onChange={e => set("days", +e.target.value)} /></label>
      <label>Início em dia não útil<select value={rule.start_non_working} onChange={e => set("start_non_working", e.target.value as Rule["start_non_working"])}><option value="next">Avançar ao próximo útil</option><option value="previous">Recuar ao útil anterior</option><option value="reject">Recusar o cálculo</option></select></label>
      <label>Contar o início ajustado?<select value={String(rule.include_start)} onChange={e => set("include_start", e.target.value === "true")}><option value="false">Não: começar no dia seguinte</option><option value="true">Sim: contar se útil para contagem</option></select></label>
      <label>Vencimento em dia não útil<select value={rule.due_non_working} onChange={e => set("due_non_working", e.target.value as Rule["due_non_working"])}><option value="next">Avançar ao próximo útil</option><option value="previous">Recuar ao útil anterior</option><option value="reject">Recusar o cálculo</option></select></label>
      <label>Horário limite do ato<input required type="time" value={rule.due_time} onChange={e => set("due_time", e.target.value)} /></label>
      <label>Antecedência do aviso (dias úteis)<input required type="number" min={0} max={60} value={rule.alert_days} onChange={e => set("alert_days", +e.target.value)} /></label>
      <label>Horário do aviso interno<input required type="time" value={rule.alert_time} onChange={e => set("alert_time", e.target.value)} /></label>
    </fieldset>
    <p>Primeiro ajustamos o termo inicial; depois incluímos ou excluímos esse dia. Contamos apenas dias úteis para contagem e, ao final, aplicamos a regra de vencimento. Ocorrências podem afetar somente início ou vencimento. A antecedência recua dias úteis para contagem; zero avisa no próprio dia.</p>
    <p>Os horários usam {calendar?.calendar.timezone || "o fuso do calendário"}. Informe o horário aplicável ao ato; não há horário limite presumido.</p>
    {calendar?.seed_warning && <p role="note">{calendar.seed_warning}</p>}
    <button disabled={busy || !calendar} className="brand">{busy ? "Calculando…" : "Simular e ver memória"}</button>
    {memory && previewKey === currentKey && <><CalculationView memory={memory} /><button type="button" disabled={busy || !order || !title.trim() || !assignee} onClick={save}>Criar tarefa e prazo pendente de conferência</button></>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
