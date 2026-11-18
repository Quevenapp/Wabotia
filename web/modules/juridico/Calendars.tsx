import React, { useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents } from "../../lib/api";
import type { Calendar, CalendarEvent } from "../../../src/modules/juridico/model";
import type { CalendarView } from "./shared";

const kinds = { national: "Nacional", state: "Estadual", municipal: "Municipal", court: "Tribunal", suspension: "Suspensão de prazo", recess: "Recesso" };
const effects = { all: "Contagem, início e vencimento", count: "Somente contagem", start: "Somente início", due: "Somente vencimento" };
function fresh(): Calendar {
  const year = new Date().getFullYear();
  return { name: "", jurisdiction: "", from: `${year}-01-01`, to: `${year}-12-31`, timezone: "America/Sao_Paulo", weekend: [0, 6], events: [] };
}
export function Calendars({ rows, refresh }: { rows: CalendarView[]; refresh: () => Promise<void> }) {
  const app = useApp(), write = useIntents(app.api);
  const [selected, setSelected] = useState<CalendarView | null>(null), [form, setForm] = useState<Calendar>(fresh);
  const [seed, setSeed] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const set = <K extends keyof Calendar>(key: K, value: Calendar[K]) => setForm(f => ({ ...f, [key]: value }));
  const event = (index: number, patch: Partial<CalendarEvent>) => setForm(f => ({ ...f, events: f.events.map((e, i) => i === index ? { ...e, ...patch } : e) }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await write(`${app.root}/juridico/calendars${selected ? `/${selected.id}` : ""}`, selected ? "PUT" : "POST", {
        calendar: form, ...(selected ? { revision: selected.revision } : { seed_national: seed }),
      });
      await refresh(); setSelected(null); setForm(fresh());
      setMessage(`Revisão ${result.revision} salva. ${result.recalculation_pending ? "Os prazos abertos serão recalculados nas próximas rodadas; confira os avisos em Prazos." : "Confira a cobertura e todas as ocorrências antes de usar."}`);
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <section>
    <h2>Calendários forenses</h2>
    <p>Exige o papel Curador de calendários e acesso sensível. Cada alteração cria uma revisão, mantendo as memórias anteriores.</p>
    <div className="jur-cards">{rows.map(row => <button type="button" key={row.id} onClick={() => { setSelected(row); setForm(structuredClone(row.calendar)); setMessage(""); }}>
      {row.calendar.name} · revisão {row.revision}<small>{row.calendar.jurisdiction}</small>{row.seed_warning && <small>{row.seed_warning}</small>}
    </button>)}</div>
    <button type="button" onClick={() => { setSelected(null); setForm(fresh()); }}>Novo calendário</button>
    <form className="card jur-form" onSubmit={save}>
      <h3>{selected ? `Editar ${selected.calendar.name}` : "Cadastrar calendário"}</h3>
      <div className="jur-grid">
        <label>Nome<input required maxLength={160} value={form.name} onChange={e => set("name", e.target.value)} /></label>
        <label>Âmbito (UF, município, tribunal e unidade)<input required maxLength={240} value={form.jurisdiction} onChange={e => set("jurisdiction", e.target.value)} /></label>
        <label>Cobertura inicial<input required type="date" value={form.from} onChange={e => set("from", e.target.value)} /></label>
        <label>Cobertura final<input required type="date" value={form.to} onChange={e => set("to", e.target.value)} /></label>
        <label>Fuso horário<input required value={form.timezone} onChange={e => set("timezone", e.target.value)} list="jur-timezones" /></label>
        <datalist id="jur-timezones">{["America/Sao_Paulo", "America/Fortaleza", "America/Manaus", "America/Rio_Branco"].map(zone => <option key={zone}>{zone}</option>)}</datalist>
      </div>
      <fieldset><legend>Dias da semana não úteis</legend><div className="jur-inline">
        {["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((name, index) => <label key={name}><input type="checkbox" checked={form.weekend.includes(index)} onChange={e => set("weekend", e.target.checked ? [...form.weekend, index] : form.weekend.filter(d => d !== index))} />{name}</label>)}
      </div></fieldset>
      {!selected && <label className="jur-inline"><input type="checkbox" checked={seed} onChange={e => setSeed(e.target.checked)} />Carregar somente feriados nacionais fixos. Confira antes de usar.</label>}
      <p>Não são incluídos feriados móveis, estaduais, municipais, do tribunal, suspensões ou recesso. Cadastre as ocorrências aplicáveis e suas fontes. O recesso não suspende a contagem automaticamente: escolha o efeito.</p>
      <h3>Ocorrências</h3>
      {form.events.map((row, i) => <fieldset key={row.id}><legend>Ocorrência {i + 1}</legend><div className="jur-grid">
        <label>Nome<input required value={row.name} maxLength={160} onChange={e => event(i, { name: e.target.value })} /></label>
        <label>Categoria<select value={row.kind} onChange={e => event(i, { kind: e.target.value as CalendarEvent["kind"] })}>{Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>De<input required type="date" value={row.from} onChange={e => event(i, { from: e.target.value })} /></label>
        <label>Até (inclusive)<input required type="date" value={row.to} onChange={e => event(i, { to: e.target.value })} /></label>
        <label>Efeito<select value={row.effect} onChange={e => event(i, { effect: e.target.value as CalendarEvent["effect"] })}>{Object.entries(effects).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Fonte e âmbito<input required maxLength={500} value={row.source} onChange={e => event(i, { source: e.target.value })} /></label>
      </div><button type="button" onClick={() => set("events", form.events.filter((_, j) => j !== i))}>Remover desta nova revisão</button></fieldset>)}
      <button type="button" disabled={form.events.length >= 300} onClick={() => set("events", [...form.events, { id: crypto.randomUUID(), name: "", kind: "court", from: form.from, to: form.from, effect: "all", source: "" }])}>Adicionar ocorrência</button>
      <button className="brand" disabled={busy}>{busy ? "Salvando…" : "Salvar revisão do calendário"}</button>
      {message && <p role="status">{message}</p>}
    </form>
  </section>;
}
