import React, { useState } from "react";
import type { Row } from "../../lib/api";
import { Button } from "../../ui";
import { useSchoolData } from "./shared";

export function ClassForm({ value, onSave }: { value?: Row; onSave: (data: Row) => Promise<unknown> }) {
  const teachers = useSchoolData("people?grant=ensino:professor");
  const types = useSchoolData(value ? null : "service-orders/types");
  const [periods, setPeriods] = useState<Row[]>(value?.periods ?? [{ id: "p1", name: "1º período", start: "", end: "" }]);
  const [schedule, setSchedule] = useState<Row[]>(value?.schedule ?? [{ day: 1, start: "08:00", end: "09:00" }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const r = value?.rule ?? { method: "simple", decimals: 1, rounding: "half_up", recovery: { mode: "none", base_weight: 1, recovery_weight: 1, cap: 10 } };
  const select = (name: string, label: string, initial: string, options: [string, string][]) => <label>{label}<select name={name} defaultValue={initial} required>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  return <form className="ensino-form card" onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget), get = (k: string) => String(f.get(k)), num = (k: string) => Number(f.get(k));
    const data = { ...(!value ? { name: get("name"), school_year: get("school_year"), start_date: get("start_date"), end_date: get("end_date"), capacity: num("capacity"), type_id: get("type_id"), periods } : {}),
      teacher_id: get("teacher_id"), schedule, justified_counts: f.has("justified_counts"),
      rule: { method: get("method"), decimals: num("decimals"), rounding: get("rounding"), recovery: { mode: get("recovery"), base_weight: num("base_weight"), recovery_weight: num("recovery_weight"), cap: num("cap") } } };
    setBusy(true); setError(""); try { await onSave(data); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }}>
    <h3>{value ? "Professor, horários e cálculo" : "Nova turma"}</h3>
    {!value && <>
      <label>Nome<input name="name" maxLength={120} required /></label>
      <label>Período letivo<input name="school_year" placeholder="2026" maxLength={80} required /></label>
      <label>Início<input type="date" name="start_date" required /></label><label>Fim<input type="date" name="end_date" required /></label>
      <label>Vagas<input type="number" name="capacity" defaultValue={30} min={1} max={100} required /></label>
      <label>Tipo de matrícula<select name="type_id" required><option value="">Selecione</option>{(types.data?.data ?? []).filter((t: Row) => t.kind === "custom" && t.features.people && !t.archived).map((t: Row) => <option key={t.id} value={t.id}>{t.labels.singular}</option>)}</select></label>
      <fieldset><legend>Períodos de avaliação</legend>{periods.map((p, i) => <div className="ensino-row" key={i}>{["id", "name", "start", "end"].map((k, j) => <label key={k}>{["Código", "Nome", "Início", "Fim"][j]}<input type={j > 1 ? "date" : "text"} value={p[k]} required onChange={e => setPeriods(periods.map((x, n) => n === i ? { ...x, [k]: e.target.value } : x))} /></label>)}<Button secondary disabled={periods.length === 1} onClick={() => setPeriods(periods.filter((_, n) => n !== i))}>Remover</Button></div>)}<Button secondary disabled={periods.length === 8} onClick={() => setPeriods([...periods, { id: `p${periods.length + 1}`, name: "", start: "", end: "" }])}>Adicionar período</Button></fieldset>
    </>}
    <label>Professor<select name="teacher_id" defaultValue={value?.teacher_id ?? ""} required><option value="">Selecione</option>{(teachers.data?.data ?? teachers.data?.people ?? []).map((p: Row) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <fieldset><legend>Horários semanais</legend>{schedule.map((s, i) => <div className="ensino-row" key={i}>
      <label>Dia<select value={s.day} onChange={e => setSchedule(schedule.map((x, n) => n === i ? { ...x, day: Number(e.target.value) } : x))}>{["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((l, n) => <option key={n} value={n}>{l}</option>)}</select></label>
      {["start", "end"].map((k, n) => <label key={k}>{n ? "Fim" : "Início"}<input type="time" value={s[k]} required onChange={e => setSchedule(schedule.map((x, index) => index === i ? { ...x, [k]: e.target.value } : x))} /></label>)}
      <Button secondary disabled={schedule.length === 1} onClick={() => setSchedule(schedule.filter((_, n) => n !== i))}>Remover</Button></div>)}<Button secondary disabled={schedule.length === 20} onClick={() => setSchedule([...schedule, { day: 1, start: "08:00", end: "09:00" }])}>Adicionar horário</Button></fieldset>
    {select("method", "Média", r.method, [["simple", "Simples"], ["weighted", "Ponderada pelos pesos das avaliações"]])}
    {select("rounding", "Arredondamento final", r.rounding, [["half_up", "Metade para cima"], ["truncate", "Truncar"], ["ceil", "Para cima"]])}
    <label>Casas decimais<input type="number" name="decimals" min={0} max={2} defaultValue={r.decimals} required /></label>
    {select("recovery", "Recuperação", r.recovery.mode, [["none", "Desligada"], ["best", "Maior entre média e recuperação"], ["weighted", "Combinar média e recuperação"]])}
    <label>Peso da média<input type="number" name="base_weight" min={0.01} max={100} step={0.01} defaultValue={r.recovery.base_weight} required /></label>
    <label>Peso da recuperação<input type="number" name="recovery_weight" min={0.01} max={100} step={0.01} defaultValue={r.recovery.recovery_weight} required /></label>
    <label>Limite após recuperação<input type="number" name="cap" min={0} max={10} step={0.01} defaultValue={r.recovery.cap} required /></label>
    <label><input type="checkbox" name="justified_counts" defaultChecked={!!value?.justified_counts} /> Contar falta justificada como presença no percentual</label>
    <p>Boletins publicados conservam a regra anterior. Uma mudança passa a valer nas próximas publicações.</p>
    <Button type="submit" busy={busy}>Salvar turma</Button>{(error || teachers.error || types.error) && <p role="alert">{error || teachers.error || types.error}</p>}
  </form>;
}
