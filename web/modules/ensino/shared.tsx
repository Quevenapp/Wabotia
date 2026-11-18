import React, { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import type { Row } from "../../lib/api";
import { Button } from "../../ui";

export function useSchoolData(path: string | null, revision = 0) {
  const app = useApp(), [data, setData] = useState<Row | null>(null), [error, setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    if (!path) return;
    const controller = new AbortController();
    app.api(`${app.root}/${path}`, "GET", undefined, controller.signal).then(setData).catch(e => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [app.root, app.api, path, revision]);
  return { data, error };
}
export interface Field {
  key: string; label: string; type?: string; value?: string | number | boolean;
  options?: [string, string][]; optional?: boolean; min?: number; max?: number; step?: number;
}
export function SchoolForm({ fields, submit, onSubmit }: { fields: Field[]; submit: string; onSubmit: (data: Row) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form className="ensino-form" onSubmit={async e => {
    e.preventDefault(); const form = e.currentTarget, entries = new FormData(form), data: Row = {};
    for (const f of fields) data[f.key] = f.type === "checkbox" ? entries.has(f.key) : f.type === "number" ? (entries.get(f.key) === "" ? null : Number(entries.get(f.key))) : entries.get(f.key);
    setBusy(true); setError("");
    try { await onSubmit(data); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }}>
    {fields.map(f => <label key={f.key}>{f.label}
      {f.options ? <select name={f.key} defaultValue={String(f.value ?? "")} required={!f.optional}>
        <option value="">Selecione</option>{f.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select> : f.type === "textarea" ? <textarea name={f.key} defaultValue={String(f.value ?? "")} maxLength={3000} required={!f.optional} /> :
        <input name={f.key} type={f.type ?? "text"} defaultValue={f.type === "checkbox" ? undefined : String(f.value ?? "")} defaultChecked={f.type === "checkbox" && !!f.value}
          min={f.min} max={f.max} step={f.step} required={f.type !== "checkbox" && !f.optional} maxLength={120} />}
    </label>)}
    <Button type="submit" busy={busy}>{submit}</Button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
export function FrequencyView({ value }: { value: Row }) {
  return <section><h3>Frequência</h3><p>{value.percent === null ? "Percentual pendente" : `${value.percent}%`} · {value.present} presenças · {value.absent} faltas · {value.justified} justificadas · {value.pending} pendentes</p><p>{value.explanation}</p>
    {value.lessons?.length > 0 && <details><summary>Registros por aula</summary>{value.lessons.map((l: Row) => <p key={l.id}>{l.date} · {l.starts}–{l.ends} · {l.status === "cancelled" ? "Cancelada" : l.status === "planned" ? "Prevista" : ({ present: "Presente", absent: "Falta", justified: "Falta justificada" }[l.attendance as string] ?? "Chamada pendente")}</p>)}</details>}
  </section>;
}
export function ReportView({ report }: { report: Row }) {
  return <article className="card"><h3>{report.name} · {report.period.name}</h3>
    <p>{report.class_name} · {report.school_year}{report.revision ? ` · Revisão ${report.revision}` : " · Prévia"}</p>
    {(report.subjects ?? []).map((s: Row) => <section key={s.subject}><h4>{s.subject}: {s.final === null ? "Pendente" : s.final}</h4><p>{s.explanation}</p></section>)}
    <FrequencyView value={report.frequency} />
  </article>;
}
