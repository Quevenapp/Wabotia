import { useMemo, useState, type FormEvent } from "react";
import { useApp } from "../../app/AppContext";
import { createIntents, type Row } from "../../lib/api";
import "./saude.css";

const labels: Record<string, string> = {
  evolution: "Evolução", prescription: "Prescrição interna", exam_request: "Pedido de exame", exam_result: "Resultado recebido",
};
const date = (value: number | null) => value ? new Date(value).toLocaleString("pt-BR") : "Não definido";
const enc = encodeURIComponent;

export function SaudePage() {
  const app = useApp();
  if (!app.moduleOn("saude")) return <p>O módulo Saúde está desligado nesta área.</p>;
  // Trocar de área ou de pessoa desmonta todo o estado clínico e as intenções de escrita.
  return <ClinicalWorkspace key={`${app.profile}:${app.me.id}`} />;
}
function ClinicalWorkspace() {
  const app = useApp();
  const root = `${app.root}/saude`;
  const grants: string[] = app.me.access || [];
  const canRead = grants.includes("saude:clinical_read") && grants.includes("os:sensitive");
  const canWrite = canRead && grants.includes("saude:clinical_write");
  const isResponsible = grants.includes("saude:responsible");
  const write = useMemo(() => createIntents(app.api), [app.api, root]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [subjects, setSubjects] = useState<Row[]>([]);
  const [subjectsNext, setSubjectsNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [records, setRecords] = useState<Row[]>([]);
  const [recordsNext, setRecordsNext] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<Row[]>([]);
  const [episodesNext, setEpisodesNext] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Row[]>([]);
  const [attachmentsNext, setAttachmentsNext] = useState<string | null>(null);
  const [episodeId, setEpisodeId] = useState("");
  const [kind, setKind] = useState("evolution");
  const [edit, setEdit] = useState<Row | null>(null);
  const [addendum, setAddendum] = useState("");
  const [draft, setDraft] = useState("");
  const [auditRows, setAuditRows] = useState<Row[]>([]);
  const [auditNext, setAuditNext] = useState<string | null>(null);
  const [rules, setRules] = useState<Row | null>(null);
  const [retention, setRetention] = useState<Row | null>(null);
  const [attendance, setAttendance] = useState<Row | null>(null);
  const [upload, setUpload] = useState<{ id: string; key: string; file: File } | null>(null);
  const path = selected ? `${root}/subjects/${enc(selected.id)}` : "";
  async function act(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  const form = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
  };
  async function loadSubjects(cursor = "", append = false) {
    const page = await app.api(`${root}/subjects?cursor=${enc(cursor)}`);
    setSubjects(old => append ? [...old, ...page.data] : page.data); setSubjectsNext(page.next_cursor);
  }
  async function loadRecords(cursor = "", append = false) {
    const page = await app.api(`${path}/records?cursor=${enc(cursor)}`);
    setRecords(old => append ? [...old, ...page.data] : page.data); setRecordsNext(page.next_cursor);
  }
  async function openSubject(id: string) {
    setSelected(null); setRecords([]); setAttachments([]); setEpisodes([]); setUpload(null); setDraft(""); setEdit(null); setAddendum("");
    const base = `${root}/subjects/${enc(id)}`;
    const patient = await app.api(base);
    const [r, e, a] = await Promise.all([app.api(`${base}/records`), app.api(`${base}/episodes`), app.api(`${base}/attachments`)]);
    setSelected(patient); setRecords(r.data); setRecordsNext(r.next_cursor);
    setEpisodes(e.data); setEpisodesNext(e.next_cursor); setEpisodeId(e.data[0]?.id || "");
    setAttachments(a.data); setAttachmentsNext(a.next_cursor);
  }
  async function download(url: string, filename: string) {
    const response = await fetch(`/api/${url}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Download não autorizado ou indisponível.");
    const blob = await response.blob();
    if (filename.endsWith(".ndjson")) {
      const tail = await blob.slice(Math.max(0, blob.size - 512)).text();
      if (!tail.trim().split("\n").at(-1)?.includes('"type":"complete"')) throw new Error("Exportação incompleta. Solicite novamente.");
    }
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = objectUrl; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  async function sendFile(pending: { id: string; key: string; file: File }) {
    const response = await fetch(`/api/${path}/attachments/${enc(pending.id)}/content`, {
      method: "PUT", credentials: "same-origin", cache: "no-store", body: pending.file,
      headers: { "Idempotency-Key": pending.key, "Upload-Version": "1", "Content-Type": "application/octet-stream" },
    });
    if (!response.ok) {
      const value = await response.json() as { error?: { code?: string; message?: string } };
      if (value.error?.code === "upload_expired") setUpload({ ...pending, key: crypto.randomUUID() });
      throw new Error(value.error?.message || "Falha no envio. Tente novamente.");
    }
    setUpload(null);
    const page = await app.api(`${path}/attachments`); setAttachments(page.data); setAttachmentsNext(page.next_cursor);
  }
  return <div className="saude-page">
    <h1>Prontuários</h1>
    <p>Conteúdo clínico restrito à equipe autorizada. Toda leitura e exportação é registrada.</p>
    {error && <p role="alert" className="saude-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy}>
      {!canRead && <section className="card"><p>Seu acesso não inclui leitura clínica. A recepção acompanha o atendimento em Trabalhos.</p>
        <form onSubmit={event => { const data = form(event); void act(async () => setAttendance(await app.api(`${root}/attendance/${enc(data.order_id)}`))); }}>
          <label>Identificador do atendimento<input name="order_id" required /></label><button>Conferir atendimento</button>
        </form>
        {attendance && <p>Atendimento nº {attendance.number} · {attendance.status}</p>}
      </section>}
      {canRead && <section className="card">
        <h2>Pacientes e animais</h2><button onClick={() => void act(() => loadSubjects())}>Carregar cadastros</button>
        <ul>{subjects.map(s => <li key={s.id}><button onClick={() => void act(() => openSubject(s.id))}>{s.name} · {s.kind === "animal" ? "Animal" : "Paciente"}</button></li>)}</ul>
        {subjectsNext && <button onClick={() => void act(() => loadSubjects(subjectsNext, true))}>Mais cadastros</button>}
        {canWrite && <details><summary>Novo cadastro</summary><form onSubmit={event => {
          const data = form(event); void act(async () => {
            const result = await write(`${root}/subjects`, "POST", { kind: data.kind, name: data.name,
              ...(data.birth_date ? { birth_date: data.birth_date } : {}),
              ...(data.kind === "animal" ? { species: data.species, tutor: { name: data.tutor_name, reference: data.tutor_reference } } : {}) });
            await loadSubjects(); await openSubject(result.id);
          });
        }}>
          <label>Tipo<select name="kind"><option value="human">Paciente</option><option value="animal">Animal</option></select></label>
          <label>Nome<input name="name" required maxLength={160} autoComplete="off" /></label>
          <label>Nascimento<input type="date" name="birth_date" /></label>
          <label>Espécie (animal)<input name="species" maxLength={100} /></label>
          <label>Nome do tutor (animal)<input name="tutor_name" maxLength={160} autoComplete="off" /></label>
          <label>Referência do tutor conferida pela equipe<input name="tutor_reference" maxLength={160} autoComplete="off" /></label>
          <button>Cadastrar</button>
        </form></details>}
      </section>}
      {canRead && selected && <section className="card">
        <h2>{selected.name}</h2><p>Código: {selected.id}</p>
        {selected.tutor && <p>Tutor: {selected.tutor.name} · {selected.tutor.reference}</p>}
        <button onClick={() => { setSelected(null); setRecords([]); setAttachments([]); setEpisodes([]); setDraft(""); setUpload(null); }}>Fechar prontuário</button>
        <button onClick={() => void act(() => download(`${path}/export`, "prontuario.ndjson"))}>Exportar prontuário completo</button>
        <h3>Atendimentos</h3>
        <label>Atendimento selecionado<select value={episodeId} onChange={event => setEpisodeId(event.target.value)}>
          <option value="">Selecione</option>{episodes.map(e => <option key={e.id} value={e.id}>Ordem {e.order_id}</option>)}
        </select></label>
        {episodesNext && <button onClick={() => void act(async () => {
          const page = await app.api(`${path}/episodes?cursor=${enc(episodesNext)}`); setEpisodes(old => [...old, ...page.data]); setEpisodesNext(page.next_cursor);
        })}>Mais atendimentos</button>}
        {canWrite && <form onSubmit={event => { const data = form(event); void act(async () => {
          const result = await write(`${path}/episodes`, "POST", { order_id: data.order_id });
          setEpisodes(old => [...old, { id: result.id, order_id: data.order_id }]); setEpisodeId(result.id);
        }); }}><label>Identificador da ordem administrativa<input name="order_id" required /></label><button>Vincular atendimento</button></form>}
        <h3>Registros clínicos</h3>
        <p>Prescrições são registros internos e não constituem receitas emitidas para dispensação.</p>
        {[...records].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)).map(r => <article key={r.id} className="saude-record">
          <h4>{labels[r.kind]} · {date(r.created)}</h4><p>Autor: {app.names[r.author] || r.author} · {r.signed_at ? `Assinado em ${date(r.signed_at)}` : "Registro não assinado"}</p>
          <small>Código: {r.id}</small>{r.addendum_of && <p>Adendo a {r.addendum_of} · Motivo: {r.reason}</p>}
          {r.request_id && <p>Pedido: {r.request_id} · Origem: {r.origin} · Recebido em {date(r.received_at)}. Resultado ainda não revisado.</p>}
          <p className="saude-text">{r.text}</p>
          {r.digest && <details><summary>Integridade</summary><code>{r.digest}</code></details>}
          {canWrite && r.kind === "evolution" && !r.signed_at && r.author === app.me.id && <>
            <button onClick={() => { setEdit(r); setDraft(r.text); setKind("evolution"); setAddendum(""); }}>Editar rascunho</button>
            <button onClick={() => { if (window.confirm("Assinar esta evolução? O conteúdo ficará imutável; correções serão feitas por adendo.")) void act(async () => {
              await write(`${path}/records/${enc(r.id)}/sign`, "POST", { version: r.version, confirm: true }); await loadRecords();
            }); }}>Assinar como autor</button>
          </>}
          {canWrite && r.kind === "evolution" && r.signed_at && <button onClick={() => { setEdit(null); setAddendum(r.id); setEpisodeId(r.episode_id); setKind("evolution"); setDraft(""); }}>Criar adendo</button>}
        </article>)}
        {recordsNext && <button onClick={() => void act(() => loadRecords(recordsNext, true))}>Mais registros</button>}
        {canWrite && <form onSubmit={event => { const data = form(event); void act(async () => {
          if (edit) await write(`${path}/records/${enc(edit.id)}`, "PATCH", { version: edit.version, text: draft });
          else await write(`${path}/records`, "POST", { episode_id: episodeId, kind, text: draft,
            ...(addendum ? { addendum_of: addendum, reason: data.reason } : {}),
            ...(kind === "exam_result" ? { request_id: data.request_id, origin: data.origin, received_at: new Date(data.received_at).getTime() } : {}) });
          setDraft(""); setEdit(null); setAddendum(""); await loadRecords();
        }); }}>
          <h3>{edit ? "Editar rascunho" : addendum ? `Adendo a ${addendum}` : "Novo registro"}</h3>
          {!edit && !addendum && <label>Tipo<select value={kind} onChange={event => setKind(event.target.value)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
          {addendum && <label>Motivo da correção<input name="reason" required maxLength={2000} /></label>}
          {kind === "exam_result" && <><label>Código do pedido de exame<input name="request_id" required /></label><label>Origem<input name="origin" required maxLength={240} /></label><label>Recebido em<input name="received_at" type="datetime-local" required /></label></>}
          <label>Conteúdo<textarea required value={draft} onChange={event => setDraft(event.target.value)} maxLength={20000} rows={7} autoComplete="off" /></label>
          <button disabled={!episodeId}>Salvar registro</button><button type="button" onClick={() => { setEdit(null); setAddendum(""); setDraft(""); }}>Limpar edição</button>
        </form>}
        <h3>Anexos sensíveis</h3>
        <ul>{attachments.map(a => <li key={a.id}>{a.name} · {a.state === "ready" ? "Pronto" : "Pendente"} {a.state === "ready" && <button onClick={() => void act(() => download(`${path}/attachments/${enc(a.id)}/content`, a.name))}>Baixar</button>}</li>)}</ul>
        {attachmentsNext && <button onClick={() => void act(async () => {
          const page = await app.api(`${path}/attachments?cursor=${enc(attachmentsNext)}`); setAttachments(old => [...old, ...page.data]); setAttachmentsNext(page.next_cursor);
        })}>Mais anexos</button>}
        {canWrite && <label>Enviar PDF, JPG, PNG ou TXT (até 10 MiB)<input type="file" accept="application/pdf,image/jpeg,image/png,text/plain" disabled={!episodeId || !!upload} onChange={event => {
          const file = event.target.files?.[0]; if (!file) return; void act(async () => {
            if (!file.size || file.size > 10 * 1024 * 1024) throw new Error("O anexo deve ter entre 1 byte e 10 MiB.");
            const result = await write(`${path}/attachments`, "POST", { episode_id: episodeId, name: file.name, mime_type: file.type, expected_bytes: file.size });
            const pending = { id: result.id, key: crypto.randomUUID(), file }; setUpload(pending); await sendFile(pending);
          }); event.target.value = "";
        }} /></label>}
        {upload && <button onClick={() => void act(() => sendFile(upload))}>Tentar envio novamente</button>}
      </section>}
      {isResponsible && <section className="card">
        <h2>Responsabilidade técnica</h2>
        <button onClick={() => void act(async () => setRules(await app.api(`${root}/policy`)))}>Consultar política de guarda</button>
        {rules && <form onSubmit={event => { const data = form(event); void act(async () => {
          await write(`${root}/policy`, "PUT", { retention_days: data.days ? Number(data.days) : null, deletion_enabled: data.deletion === "on", version: rules.version });
          setRules(await app.api(`${root}/policy`)); setNotice("Política salva. Prazos anteriores não são reduzidos.");
        }); }} key={rules.version}>
          <label>Guarda em dias, após a última atividade clínica<input type="number" name="days" min={1} max={36500} defaultValue={rules.retention_days ?? ""} /></label>
          <p>Em branco: descarte bloqueado. O responsável deve definir o prazo aplicável à instituição.</p>
          <label><input type="checkbox" name="deletion" defaultChecked={!!rules.deletion_enabled} />Permitir descarte após a guarda</label><button>Salvar política</button>
        </form>}
        <form onSubmit={event => { const data = form(event); void act(async () => setRetention(await app.api(`${root}/retention/${enc(data.id)}`))); }}>
          <label>Código do prontuário para guarda<input name="id" required /></label><button>Consultar guarda</button>
        </form>
        {retention && <div><p>{retention.state} · Guarda até {date(retention.retain_until)} · Impedimento: {retention.legal_hold ? "Sim" : "Não"}</p>
          {retention.state === "active" && <button onClick={() => void act(async () => {
            await write(`${root}/subjects/${enc(retention.id)}/hold`, "PUT", { version: retention.version, legal_hold: !retention.legal_hold });
            setRetention(await app.api(`${root}/retention/${enc(retention.id)}`));
          })}>{retention.legal_hold ? "Remover impedimento" : "Bloquear descarte"}</button>}
          {canWrite && retention.state !== "deleted" && <button onClick={() => { if (window.confirm("Executar descarte definitivo do prontuário após a guarda? Esta ação não pode ser desfeita.")) void act(async () => {
            const result = await app.api(`${root}/subjects/${enc(retention.id)}/purge`, "POST", { confirm: true });
            setRetention(await app.api(`${root}/retention/${enc(retention.id)}`));
            setSelected(null); setRecords([]); setSubjects([]); setAttachments([]); setDraft("");
            setNotice(result.has_more ? "Lote removido. Execute novamente para continuar o descarte." : "Descarte concluído; auditoria preservada.");
          }); }}>Executar ou continuar descarte</button>}
        </div>}
        <h3>Leituras e operações</h3>
        <button onClick={() => void act(async () => { const page = await app.api(`${root}/audit`); setAuditRows(page.data); setAuditNext(page.next_cursor); })}>Consultar auditoria</button>
        <div className="saude-table"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Recursos</th></tr></thead><tbody>{auditRows.map(a => <tr key={a.id}><td>{date(a.created)}</td><td>{app.names[a.actor] || a.actor}</td><td>{a.action}</td><td>{a.resources.join(", ")}</td></tr>)}</tbody></table></div>
        {auditNext && <button onClick={() => void act(async () => { const page = await app.api(`${root}/audit?cursor=${enc(auditNext)}`); setAuditRows(old => [...old, ...page.data]); setAuditNext(page.next_cursor); })}>Mais auditoria</button>}
      </section>}
    </fieldset>
    {busy && <p role="status">Processando…</p>}
  </div>;
}
