import React, { useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import { Button } from "../../ui";
import { ClassForm } from "./ClassForm";
import { ReportView, SchoolForm, useSchoolData } from "./shared";
import "./ensino.css";

const attendanceOptions: [string, string][] = [["present", "Presente"], ["absent", "Faltou"], ["justified", "Falta justificada"]];
const gradeOptions: [string, string][] = [["graded", "Nota"], ["absent", "Ausente (pendente)"], ["exempt", "Dispensado"]];
function ClassWork({ classId, secretary, back }: { classId: string; secretary: boolean; back: () => void }) {
  const app = useApp(), [revision, refresh] = useState(0), [tab, setTab] = useState("students");
  const write = useIntents(app.api);
  const [selected, select] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const base = `ensino/classes/${classId}`, resource = useSchoolData(base, revision), c = resource.data;
  const students = useSchoolData(`${base}/enrollments`, revision);
  const [cursor, setCursor] = useState("");
  const path = tab === "lessons" ? "lessons" : tab === "assessments" ? "assessments" : tab === "notices" ? "notices" : null;
  const list = useSchoolData(path ? `${base}/${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}` : null, revision);
  const rows = useSchoolData(selected && ["lessons", "assessments"].includes(tab) ? `${base}/${tab}/${selected}/${tab === "lessons" ? "attendance" : "grades"}` : null, revision);
  const student = (students.data?.data ?? []).find((x: Row) => x.id === selected);
  const guardians = useSchoolData(tab === "students" && selected && secretary ? `${base}/enrollments/${selected}/guardians` : null, revision);
  const people = useSchoolData(tab === "students" && student && secretary ? `service-orders/${student.order_id}/people?limit=100` : null, revision);
  const [period, setPeriod] = useState("");
  const report = useSchoolData(tab === "reports" && selected && period ? `${base}/enrollments/${selected}/reports/${encodeURIComponent(period)}` : null, revision);
  const send = async (suffix: string, data: Row, method = "POST") => {
    const result = await write(`${app.root}/${base}${suffix}`, method, { ...data, version: c?.version });
    refresh(n => n + 1); return result;
  };
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(""); try { await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (!c) return <><Button secondary onClick={back}>Voltar às turmas</Button><p role={resource.error ? "alert" : "status"}>{resource.error || "Carregando turma…"}</p>{resource.error && <Button secondary onClick={() => refresh(n => n + 1)}>Tentar novamente</Button>}</>;
  const selectedItem = (list.data?.data ?? []).find((x: Row) => x.id === selected);
  return <>
    <header><Button secondary onClick={back}>Turmas</Button><Button secondary onClick={() => refresh(n => n + 1)}>Atualizar turma</Button><h2>{c.name} · {c.school_year}</h2><p>{c.start_date} a {c.end_date} · Professor: {app.names[c.teacher_id] ?? c.teacher_id}</p></header>
    <nav aria-label="Turma">{[["students", "Alunos"], ["lessons", "Frequência"], ["assessments", "Avaliações e notas"], ["reports", "Boletins"], ["notices", "Comunicados"], ...(secretary ? [["settings", "Configuração"]] : [])].map(([value, label]) => <Button key={value} secondary={tab !== value} onClick={() => { setTab(value); select(""); setCursor(""); }}>{label}</Button>)}</nav>
    {(error || list.error || rows.error || students.error || guardians.error || people.error || report.error) && <p role="alert">{error || list.error || rows.error || students.error || guardians.error || people.error || report.error}</p>}
    {tab === "settings" && <ClassForm key={c.version} value={c} onSave={d => send("", d, "PATCH")} />}
    {tab === "students" && <>
      <section className="card"><h3>Enturmações</h3>{!students.data?.data.length && <p>Nenhum aluno enturmado.</p>}{(students.data?.data ?? []).map((s: Row) => <p key={s.id}><Button secondary onClick={() => select(s.id)}>{s.name}</Button> {s.start_date} a {s.end_date}{s.ended ? " · Encerrada" : ""}</p>)}</section>
      {secretary && <section className="card"><h3>Enturmar matrícula do motor</h3><SchoolForm submit="Enturmar" onSubmit={d => send("/enrollments", d)} fields={[
        { key: "order_id", label: "ID da matrícula (aluno como pessoa central)" },
        { key: "start_date", label: "Início", type: "date", value: c.start_date }, { key: "end_date", label: "Fim", type: "date", value: c.end_date },
      ]} /></section>}
      {secretary && student && <section className="card"><h3>{student.name} · Responsáveis</h3><p>Confira identidade, poderes pedagógicos e eventual telefone compartilhado antes de autorizar. A pessoa ligada deve estar marcada como sensível no motor.</p>
        <SchoolForm key={`guardian:${student.id}:${c.version}`} submit="Autorizar responsável" onSubmit={d => send(`/enrollments/${student.id}/guardians`, d)} fields={[
          { key: "person_id", label: "Pessoa ligada", options: (people.data?.data ?? []).filter((p: Row) => p.sensitive && !p.client_visible && p.phone).map((p: Row) => [p.id, p.name]) },
          { key: "valid_until", label: "Autorizar até", type: "date", value: c.end_date },
          { key: "identity_confirmed", label: "Conferi identidade e poderes pedagógicos", type: "checkbox" },
        ]} />
        {(guardians.data?.data ?? []).map((g: Row) => <p key={g.id}>{g.name} · até {g.valid_until}{g.revoked_at ? " · Revogado" : g.stale ? " · Cadastro alterado; autorize novamente" : " · Autorizado"} {!g.revoked_at && <Button secondary busy={busy} onClick={() => action(() => send(`/enrollments/${student.id}/guardians/${g.id}/revoke`, {}))}>Revogar</Button>}</p>)}
        <h3>Encerrar participação</h3><SchoolForm submit="Encerrar enturmação" onSubmit={d => send(`/enrollments/${student.id}/end`, d)} fields={[{ key: "end_date", label: "Último dia nesta turma (inclusivo)", type: "date", value: student.end_date }]} />
      </section>}
    </>}
    {tab === "lessons" && <>
      <section className="card"><h3>Aulas</h3>{(list.data?.data ?? []).map((l: Row) => <p key={l.id}><Button secondary onClick={() => select(l.id)}>{l.date} · {l.starts}–{l.ends}</Button> {{ planned: "Prevista", held: "Realizada", cancelled: "Cancelada" }[l.status as string]}</p>)}
        <SchoolForm submit="Cadastrar aula" onSubmit={d => send("/lessons", d)} fields={[
          { key: "date", label: "Data", type: "date" }, { key: "starts", label: "Início", type: "time", value: c.schedule[0].start }, { key: "ends", label: "Fim", type: "time", value: c.schedule[0].end },
          { key: "status", label: "Situação", value: "planned", options: [["planned", "Prevista"], ["held", "Realizada"], ["cancelled", "Cancelada"]] }, { key: "exception", label: "Aula extraordinária ou reposição (cancele a substituída)", type: "checkbox" },
        ]} /></section>
      {selectedItem && <section className="card"><h3>Chamada · {selectedItem.date}</h3>
        <SchoolForm key={`${selected}:${c.version}`} submit="Atualizar situação da aula" onSubmit={d => send(`/lessons/${selected}`, { ...d, reason: "correction" }, "PATCH")} fields={[{ key: "status", label: "Situação", value: selectedItem.status, options: [["planned", "Prevista"], ["held", "Realizada"], ["cancelled", "Cancelada"]] }]} />
        {(rows.data?.data ?? []).map((r: Row) => <div key={`${r.enrollment_id}:${c.version}`}><h4>{r.name} · {r.status ? attendanceOptions.find(([v]) => v === r.status)?.[1] : "Pendente"}</h4><SchoolForm submit={r.revision ? "Corrigir frequência" : "Registrar frequência"} onSubmit={d => send(`/lessons/${selected}/attendance`, { ...d, enrollment_id: r.enrollment_id, reason: r.revision ? "correction" : "initial" })} fields={[{ key: "status", label: "Frequência", value: r.status ?? "", options: attendanceOptions }]} /></div>)}
      </section>}
    </>}
    {tab === "assessments" && <>
      <section className="card"><h3>Avaliações</h3>{(list.data?.data ?? []).map((a: Row) => <p key={a.id}><Button secondary onClick={() => select(a.id)}>{a.subject} · {a.title}</Button> {a.date} · escala {a.max_score} · peso {a.weight}{a.kind === "recovery" ? " · Recuperação" : ""}</p>)}
        <SchoolForm submit="Cadastrar avaliação" onSubmit={d => send("/assessments", d)} fields={[
          { key: "period_id", label: "Período", options: c.periods.map((p: Row) => [p.id, p.name]) }, { key: "subject", label: "Disciplina" }, { key: "title", label: "Avaliação" }, { key: "date", label: "Data", type: "date" },
          { key: "max_score", label: "Nota máxima", type: "number", min: 0.01, max: 10000, step: 0.01, value: 10 }, { key: "weight", label: "Peso", type: "number", min: 0.01, max: 100, step: 0.01, value: 1 },
          { key: "kind", label: "Modalidade", value: "regular", options: [["regular", "Regular"], ["recovery", "Recuperação"]] },
        ]} /></section>
      {selectedItem && <section className="card"><h3>{selectedItem.title} · Notas</h3>{(rows.data?.data ?? []).map((r: Row) => <div key={`${r.enrollment_id}:${c.version}`}><h4>{r.name} · {r.status === "graded" ? r.score : r.status === "exempt" ? "Dispensado" : "Pendente"}</h4><SchoolForm submit={r.revision ? "Corrigir resultado" : "Registrar resultado"} onSubmit={d => send(`/assessments/${selected}/grades`, { ...d, score: d.status === "graded" ? d.score : null, enrollment_id: r.enrollment_id, reason: r.revision ? "correction" : "initial" })} fields={[
        { key: "status", label: "Resultado", value: r.status ?? "graded", options: gradeOptions }, { key: "score", label: "Nota (somente quando resultado = Nota)", type: "number", value: r.score ?? "", min: 0, max: selectedItem.max_score, step: 0.01, optional: true },
      ]} /></div>)}</section>}
    </>}
    {tab === "reports" && <>
      <div className="ensino-row"><label>Aluno<select value={selected} onChange={e => select(e.target.value)}><option value="">Selecione</option>{(students.data?.data ?? []).map((s: Row) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Período<select value={period} onChange={e => setPeriod(e.target.value)}><option value="">Selecione</option>{c.periods.map((p: Row) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
      {report.data && <><ReportView report={report.data} />{secretary && <Button busy={busy} onClick={() => action(() => send(`/enrollments/${selected}/reports`, { period_id: period }))}>Publicar nova revisão do boletim</Button>}</>}
    </>}
    {tab === "notices" && <>
      <section className="card"><h3>Novo comunicado</h3><p>Use apenas informações coletivas. O WhatsApp recebe um aviso; o texto fica na consulta protegida.</p><SchoolForm submit="Salvar rascunho" onSubmit={d => send("/notices", d)} fields={[{ key: "text", label: "Texto", type: "textarea" }, { key: "audience_date", label: "Alunos enturmados na data", type: "date" }]} /></section>
      {(list.data?.data ?? []).map((n: Row) => <article key={n.id} className="card"><p>{n.text}</p><p>Destinatários em {n.audience_date} · {n.published_at ? "Publicado" : "Rascunho"}</p><p>{n.queued} na fila · {n.pending} pendentes · {n.blocked} bloqueados · {n.cancelled} cancelados</p>{secretary && <>
        {!n.published_at ? <SchoolForm submit="Revisar e publicar" fields={[{ key: "reviewed", label: "Conferi texto e destinatários; não há dados individuais", type: "checkbox" }]} onSubmit={d => send(`/notices/${n.id}/publish`, d)} /> : <Button busy={busy} onClick={() => action(async () => {
          for (let i = 0; i < 100; i++) {
            const result = await write(`${app.root}/${base}/notices/${n.id}/send`, "POST", { retry: i === 0 });
            if (!result.counts.some((x: Row) => x.status === "pending" && x.total > 0)) break;
          }
          refresh(v => v + 1);
        })}>Enviar avisos pendentes / tentar bloqueados</Button>}
      </>}</article>)}
    </>}
    {path && <div className="ensino-row"><Button secondary disabled={!cursor} onClick={() => setCursor("")}>Primeira página</Button><Button secondary disabled={!list.data?.next_cursor} onClick={() => { setCursor(list.data!.next_cursor); select(""); }}>Próxima página</Button></div>}
  </>;
}
function SchoolWorkspace() {
  const [selected, select] = useState(""), [creating, setCreating] = useState(false), [cursor, setCursor] = useState(""), [revision, refresh] = useState(0);
  const app = useApp(), classes = useSchoolData(`ensino/classes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, revision);
  const write = useIntents(app.api);
  return <main className="ensino"><h1>Ensino</h1>
    {classes.error && <p role="alert">{classes.error}</p>}
    {selected ? <ClassWork classId={selected} secretary={!!classes.data?.secretary} back={() => { select(""); refresh(v => v + 1); }} /> : <>
      {!classes.data && !classes.error && <p role="status">Carregando turmas…</p>}
      {classes.data && !classes.data.data.length && <p>Nenhuma turma disponível.</p>}
      {(classes.data?.data ?? []).map((c: Row) => <section className="card" key={c.id}><h2>{c.name}</h2><p>{c.school_year} · {c.start_date} a {c.end_date}</p><Button onClick={() => select(c.id)}>Abrir turma</Button></section>)}
      <div className="ensino-row"><Button secondary disabled={!cursor} onClick={() => setCursor("")}>Primeira página</Button><Button secondary disabled={!classes.data?.next_cursor} onClick={() => setCursor(classes.data!.next_cursor)}>Próxima página</Button></div>
      {classes.data?.secretary && <Button secondary onClick={() => setCreating(!creating)}>Nova turma</Button>}
      {creating && <ClassForm onSave={async d => { const result = await write(`${app.root}/ensino/classes`, "POST", d); setCreating(false); select(result.id); refresh(v => v + 1); }} />}
    </>}
  </main>;
}
export function EnsinoPage() { const app = useApp(); return <SchoolWorkspace key={app.profile} />; }
