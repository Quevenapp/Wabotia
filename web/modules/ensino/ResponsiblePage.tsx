import React, { useEffect, useState } from "react";
import type { Row } from "../../lib/api";
import { Button } from "../../ui";
import { FrequencyView, ReportView } from "./shared";
import "./ensino.css";

/** Entrada pública sem conteúdo escolar; as consultas posteriores exigem Bearer. */
export function ResponsiblePage() {
  const [code] = useState(() => location.hash.slice(1)), [session, setSession] = useState<Row | null>(null);
  const [students, setStudents] = useState<Row[]>([]), [result, setResult] = useState<Row | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { history.replaceState(null, "", location.pathname); }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { setSession(null); setStudents([]); setResult(null); setError("A consulta venceu. Peça outro acesso no WhatsApp."); }, Math.max(0, session.expires_at - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  async function read(s: Row, tail = "", after = "") {
    const response = await fetch(`/api/v1/profiles/${encodeURIComponent(s.profile)}/ensino/access/${encodeURIComponent(s.subject)}/students${tail}${after ? `?cursor=${encodeURIComponent(after)}` : ""}`, {
      headers: { Authorization: `Bearer ${s.token}` }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    const data = await response.json() as Row;
    if (!response.ok) throw new Error("Consulta indisponível. Peça outro acesso no WhatsApp ou fale com a secretaria.");
    return data;
  }
  async function run(task: () => Promise<void>) {
    setBusy(true); setError(""); setResult(null);
    try { await task(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className="ensino"><h1>Consulta escolar</h1>
    {!session ? <section className="card"><p>Abra o acesso pessoal recebido no WhatsApp para consultar os alunos sob sua responsabilidade.</p><Button disabled={!/^[2-9A-HJ-NP-Za-km-np-z]{32}$/.test(code)} busy={busy} onClick={() => run(async () => {
      const response = await fetch("/api/credentials/claim", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", body: JSON.stringify({ code, name: "Responsável", device: "Consulta escolar web" }) });
      const data = await response.json() as Row;
      if (!response.ok || data.module !== "ensino") throw new Error("Este acesso não vale mais. Peça outro pelo WhatsApp.");
      setSession({ ...data, expires_at: Math.min(data.expires_at, data.data.expires_at) }); const list = await read(data); setStudents(list.data); setCursor(list.next_cursor);
    })}>Abrir consulta protegida</Button></section> : <>
      <Button secondary onClick={() => { setSession(null); setStudents([]); setResult(null); }}>Fechar consulta</Button>
      <section className="card"><h2>Alunos autorizados</h2>{students.map(s => <p key={s.id}><Button secondary busy={busy} onClick={() => run(async () => { setResult(await read(session, `/${encodeURIComponent(s.id)}`)); })}>{s.name} · {s.class_name} · {s.school_year}</Button></p>)}
        {cursor && <Button secondary busy={busy} onClick={() => run(async () => { const list = await read(session, "", cursor); setStudents(list.data); setCursor(list.next_cursor); })}>Mais alunos</Button>}
      </section>
      {result && <><h2>Boletins publicados</h2>{!result.reports.length && <p>A secretaria ainda não publicou boletins.</p>}{result.reports.map((r: Row) => <ReportView key={r.period.id} report={r} />)}<section className="card"><FrequencyView value={result.frequency} /></section><h2>Comunicados</h2>{result.notices.map((n: Row) => <article className="card" key={n.id}><p>{n.text}</p></article>)}</>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
