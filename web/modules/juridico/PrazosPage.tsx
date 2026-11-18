import React, { useCallback, useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import { Calendars } from "./Calendars";
import { CreateDeadline } from "./CreateDeadline";
import { CalculationView, stamp, warning, type CalendarView } from "./shared";
import "./juridico.css";

function Deadline({ id, close, changed }: { id: string; close: () => void; changed: () => Promise<void> }) {
  const app = useApp(), write = useIntents(app.api);
  const [row, setRow] = useState<Row | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false), [evidence, setEvidence] = useState(""), [revision, setRevision] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await app.api(`${app.root}/juridico/deadlines/${id}${revision ? `?revision=${revision}` : ""}`, "GET", undefined, signal);
    setRow(result); setChecked(false);
  }, [app.api, app.root, id, revision]);
  useEffect(() => { const abort = new AbortController(); load(abort.signal).catch(e => { if (e.name !== "AbortError") setError(e.message); }); return () => abort.abort(); }, [load]);
  async function action(op: "confirm" | "complete") {
    if (!row) return;
    setBusy(true); setError("");
    try {
      await write(`${app.root}/juridico/deadlines/${id}/${op}`, "POST", { version: row.version, task_version: row.task_version, ...(op === "confirm" ? { checked: true } : { evidence }) });
      await load(); await changed();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="card jur-form" aria-label="Detalhes do prazo">
    <button type="button" onClick={close}>Fechar detalhe</button>
    {!row ? <p role="status">Carregando memória…</p> : <>
      <h2>{row.title}</h2><p>{warning}</p>
      <p>Data da tarefa: <strong>{stamp(row.due_at, row.memory.calendar.timezone)}</strong>. Estado: {row.state === "done" ? "Cumprido" : row.state === "cancelled" ? "Cancelado" : row.review === "confirmed" ? "Conferência registrada pelo advogado" : "Exige conferência"}.</p>
      {row.previous_due_at !== null && <p role="status">Calendário alterado. Antes: {stamp(row.previous_due_at, row.memory.calendar.timezone)}. Novo cálculo: {row.review === "error" ? "indisponível" : stamp(row.calculated_due_at, row.memory.calendar.timezone)}. A tarefa mantém a data mais cedo até a conferência.</p>}
      {row.recalculation_pending && <p role="alert">O calendário mudou e o recálculo ainda está pendente. Aguarde a próxima rodada e atualize antes de conferir.</p>}
      <label>Memória da revisão<select value={revision} onChange={e => { setChecked(false); setRevision(e.target.value); }}><option value="">Atual ({row.version})</option>{Array.from({ length: row.version - 1 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
      {row.memory_revision > 1 && <section><h3>O que mudou no calendário desta revisão</h3>{row.calendar_changes.length ? <ul>{row.calendar_changes.map((change: string, index: number) => <li key={index}>{change}</li>)}</ul> : <p>Os dados do calendário permaneceram iguais; há uma nova revisão para conferir.</p>}</section>}
      <CalculationView memory={row.memory} />
      {row.state === "open" && <>
        <label className="jur-inline"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />Conferi a memória atual, o calendário, o termo inicial, a regra e o horário aplicável.</label>
        <button type="button" disabled={busy || !checked || !!revision || row.memory_revision !== row.version || row.review === "error" || row.recalculation_pending} onClick={() => action("confirm")}>Registrar minha conferência</button>
        <label>Referência da providência realizada<textarea maxLength={1000} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="Referência do protocolo ou documento no processo" /></label>
        <button type="button" disabled={busy || !evidence.trim()} onClick={() => action("complete")}>Registrar cumprimento</button>
      </>}
      {row.completion_evidence && <p>Providência: {row.completion_evidence}</p>}
      <button type="button" disabled={busy} onClick={() => load().catch(e => setError(e.message))}>Atualizar memória</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
function PrazosContent() {
  const app = useApp(), write = useIntents(app.api);
  const [tab, setTab] = useState("prazos"), [calendars, setCalendars] = useState<CalendarView[]>([]), [people, setPeople] = useState<Row[]>([]);
  const [rows, setRows] = useState<Row[]>([]), [alerts, setAlerts] = useState<Row[]>([]), [sort, setSort] = useState("due"), [assignee, setAssignee] = useState("");
  const [state, setState] = useState("open"), [cursor, setCursor] = useState(""), [next, setNext] = useState<string | null>(null);
  const [detail, setDetail] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(async () => { setRefreshKey(k => k + 1); }, []);
  useEffect(() => {
    const abort = new AbortController(); setError(""); setLoading(true);
    const read = (path: string) => app.api(`${app.root}/juridico/${path}`, "GET", undefined, abort.signal);
    Promise.allSettled([read("calendars"), read("assignees")]).then(results => {
      if (abort.signal.aborted) return;
      if (results[0].status === "fulfilled") setCalendars(results[0].value.data);
      else setError(results[0].reason.message);
      if (results[1].status === "fulfilled") setPeople(results[1].value.data);
      else if (tab !== "calendarios") setError(results[1].reason.message);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [app.api, app.root, refreshKey, tab]);
  useEffect(() => {
    if (tab !== "prazos") return;
    const abort = new AbortController();
    const query = new URLSearchParams({ sort, state, ...(assignee ? { assignee } : {}), ...(cursor ? { cursor } : {}) });
    app.api(`${app.root}/juridico/deadlines?${query}`, "GET", undefined, abort.signal)
      .then(result => { setRows(result.data); setNext(result.next_cursor); })
      .catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => abort.abort();
  }, [app.api, app.root, tab, sort, state, assignee, cursor, refreshKey]);
  useEffect(() => {
    if (tab !== "prazos") return;
    const abort = new AbortController();
    const read = () => app.api(`${app.root}/juridico/alerts`, "GET", undefined, abort.signal).then(result => setAlerts(result.data)).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    void read(); const timer = setInterval(() => { if (!document.hidden) void read(); }, 30000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [app.api, app.root, tab, refreshKey]);
  if (!app.moduleOn("juridico")) return <p>Ative Jurídico e o motor de trabalhos em Módulos.</p>;
  return <div className="juridico-page">
    <h1>Prazos</h1><p role="note">{warning}</p>
    <p>Calendários e prazos são exclusivos da equipe jurídica autorizada da área. Avisos internos aparecem nesta tela; não são enviados ao cliente.</p>
    <div className="toolbar" role="group" aria-label="Seções jurídicas">{[["prazos", "Prazos"], ["novo", "Novo prazo"], ["calendarios", "Calendários"]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}<button onClick={refresh}>Atualizar</button></div>
    {loading && <p role="status">Carregando…</p>}{error && <p role="alert">{error}</p>}
    {tab === "calendarios" && <Calendars rows={calendars} refresh={refresh} />}
    {tab === "novo" && <CreateDeadline calendars={calendars} people={people} created={async () => { setTab("prazos"); setCursor(""); await refresh(); }} />}
    {tab === "prazos" && <>
      {alerts.length > 0 && <section className="card jur-form" aria-label="Avisos para mim"><h2>Avisos para mim</h2>{alerts.map(alert => <div key={alert.id} className="jur-alert"><p>{alert.message}</p><button onClick={() => setDetail(alert.deadline_id)}>Abrir cálculo</button><button onClick={async () => {
        try { await write(`${app.root}/juridico/alerts/${encodeURIComponent(alert.id)}/acknowledge`, "POST"); await refresh(); } catch (e) { setError((e as Error).message); }
      }}>Marcar aviso como lido</button></div>)}<p>Ler um aviso não registra cumprimento.</p></section>}
      <div className="jur-grid">
        <label>Organizar por<select value={sort} onChange={e => { setCursor(""); setSort(e.target.value); }}><option value="due">Vencimento</option><option value="assignee">Responsável</option><option value="process">Processo</option></select></label>
        <label>Responsável<select value={assignee} onChange={e => { setCursor(""); setAssignee(e.target.value); }}><option value="">Todos</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Estado<select value={state} onChange={e => { setCursor(""); setState(e.target.value); }}><option value="open">Abertos</option><option value="done">Cumpridos</option><option value="cancelled">Cancelados</option><option value="all">Todos</option></select></label>
      </div>
      <p>Datas da lista no fuso America/Sao_Paulo. A memória mostra o fuso do calendário.</p>
      <div className="jur-table card"><table><thead><tr><th>Vencimento da tarefa</th><th>Responsável</th><th>Processo</th><th>Providência</th><th>Conferência</th><th>Ação</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}><td>{stamp(row.due_at)}</td><td>{people.find(p => p.id === row.assignee)?.name || app.names[row.assignee] || "Responsável indisponível"}</td><td>{row.process_label}</td><td>{row.title}</td><td>{row.state === "done" ? "Cumprido" : row.recalculation_pending ? "Aguardando recálculo" : row.review === "confirmed" ? "Registrada pelo advogado" : row.review === "error" ? "Cálculo indisponível" : "Pendente"}</td><td><button onClick={() => setDetail(row.id)}>Ver memória</button></td></tr>)}
      </tbody></table>{!rows.length && <p>Nenhum prazo neste filtro.</p>}</div>
      <div className="toolbar"><button disabled={!cursor} onClick={() => setCursor("")}>Primeira página</button><button disabled={!next} onClick={() => setCursor(next || "")}>Próxima página</button></div>
      {detail && <Deadline key={detail} id={detail} close={() => setDetail("")} changed={refresh} />}
    </>}
  </div>;
}
export function PrazosPage() {
  const app = useApp();
  return <PrazosContent key={app.profile} />;
}
