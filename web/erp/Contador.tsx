// Fiscal › Para o contador: o pacote do período (XML e PDF das notas e a
// planilha de índice, montado aos poucos no servidor), os relatórios fiscais
// de conferência e o cadastro do contador com o envio do link (7 dias) e o
// envio automático. O servidor confere e faz tudo (src/erp/contador/); a tela
// só manda as escolhas e mostra o andamento.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import StockPrintPreview from "./app/components/StockPrintPreview";
import {
  askPackage, CONTADOR_UNAVAILABLE, contadorBase, downloadUrl, listPackages, listSends, loadReport, loadSettings, money, monthPeriod, PHASES,
  previousMonth, reportCsvUrl, saveSettings, sendPackage, size, when,
  type Channel, type Environment, type Line, type PackageView, type Report, type SendView, type SettingsPage, type Taxes,
} from "./contador-api";
import "./app/components/real-finance.css";
import "./app/components/report-chart.css";

const ROUTE = "/contador-fiscal";
const TABS = [{ id: "pacote", label: "Pacote do mês" }, { id: "relatorios", label: "Relatórios fiscais" }, { id: "contador", label: "Contador e envios" }] as const;
type Tab = typeof TABS[number]["id"];
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Período: um mês ou um intervalo de datas. */
function PeriodPicker({ value, onChange, disabled }: { value: { from: string; to: string }; onChange: (p: { from: string; to: string }) => void; disabled?: boolean }) {
  const [kind, setKind] = useState<"mes" | "intervalo">(() => monthPeriod(value.from.slice(0, 7))?.to === value.to && value.from.endsWith("-01") ? "mes" : "intervalo");
  const [draft, setDraft] = useState(value);
  return <div className="report-filters">
    <label className="form-field">Período<select value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value as "mes" | "intervalo")}>
      <option value="mes">Mês</option><option value="intervalo">Intervalo de datas</option></select></label>
    {kind === "mes"
      ? <label className="form-field">Mês<input type="month" min="2000-01" max="2099-12" disabled={disabled} value={value.from.slice(0, 7)}
        onChange={(e) => { const p = monthPeriod(e.target.value); if (p) { onChange(p); setDraft(p); } }} /></label>
      : <form className="report-filters" onSubmit={(e) => { e.preventDefault(); if (draft.from && draft.to && draft.from <= draft.to) onChange(draft); }}>
        <label className="form-field">De<input type="date" required disabled={disabled} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="form-field">Até<input type="date" required disabled={disabled} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <button type="submit" className="secondary-button" disabled={disabled || !draft.from || !draft.to || draft.from > draft.to}>Usar este período</button></form>}
  </div>;
}

function EnvironmentPicker({ value, onChange }: { value: Environment; onChange: (e: Environment) => void }) {
  return <label className="form-field">Ambiente<select value={value} onChange={(e) => onChange(e.target.value as Environment)}>
    <option value="producao">Produção (notas com valor fiscal)</option><option value="homologacao">Homologação (testes)</option></select></label>;
}

// ---------------------------------------------------------------------------
// Pacote

function counts(p: PackageView) {
  const c = p.counts, parts = [`${c.issued} emitida(s)`, `${c.received} recebida(s)`];
  if (c.void_ranges) parts.push(`${c.void_ranges} inutilização(ões)`);
  if (c.bling) parts.push(`${c.bling} do acervo do Bling`);
  return `${parts.join(", ")}; ${c.xml} XML, ${c.events} evento(s), ${c.pdf} PDF${c.without_xml ? `; ${c.without_xml} só na planilha (sem XML)` : ""}`;
}

function PackageTab({ writable, settings }: { writable: boolean; settings: SettingsPage | null }) {
  const [period, setPeriod] = useState(() => monthPeriod(previousMonth())!);
  const [environment, setEnvironment] = useState<Environment>("producao");
  const [packages, setPackages] = useState<PackageView[]>([]), [sends, setSends] = useState<SendView[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(""), [tick, setTick] = useState(0);
  const [sendFor, setSendFor] = useState<PackageView | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void listPackages(request.signal).then((v) => { if (!request.signal.aborted) { setPackages(v.pacotes); setSends(v.envios); } })
      .catch((e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => request.abort();
  }, [tick]);
  // Em montagem: a lista atualiza a cada 3 s, só com a tela aberta e visível.
  const running = packages.some((p) => p.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { if (visible()) setTick((n) => n + 1); }, 3000);
    return () => clearInterval(timer);
  }, [running]);
  const ask = async (redo = false, target?: PackageView) => {
    const p = target ? { from: target.from, to: target.to } : period, env = target?.environment ?? environment;
    setBusy(target ? `refazer:${target.id}` : "pedir"); setError(""); setNotice("");
    try {
      const r = await askPackage({ de: p.from, ate: p.to, ambiente: env, ...(redo ? { refazer: true } : {}) });
      setNotice(r.reaproveitado ? `O pacote de ${r.pacote.label} já existe (${r.pacote.state === "done" ? "pronto" : "em montagem"}). Para incluir notas novas, use Montar de novo.`
        : `Pacote de ${r.pacote.label} em montagem. Ele continua sozinho, mesmo com a tela fechada.`);
      setTick((n) => n + 1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  };
  const lastSend = (id: string) => sends.find((s) => s.pacote === id && s.situacao === "enviado");
  return <>
    <p className="real-help">O pacote leva os XML das notas emitidas (NF-e, NFC-e e NFS-e) com cancelamentos, cartas de correção e inutilizações, das notas recebidas com entrada no ERP e do acervo do Bling, os PDFs que o emissor oferece (DANFE e DANFCE) e a planilha de índice, separados em pastas num arquivo ZIP. Nota sem XML (rejeitada ou sem resposta) aparece só na planilha.</p>
    {writable && <div className="report-filters">
      <PeriodPicker value={period} onChange={setPeriod} disabled={!!busy} />
      <EnvironmentPicker value={environment} onChange={setEnvironment} />
      <button type="button" className="primary-button" disabled={!!busy} onClick={() => void ask()}>{busy === "pedir" ? "Pedindo…" : "Montar pacote"}</button>
    </div>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-help" role="status">{notice}</p>}
    {!packages.length ? <p className="real-help">Nenhum pacote ainda.{writable ? " Escolha o período e clique em Montar pacote." : ""}</p>
      : <div className="table-scroll" tabIndex={0} role="region" aria-label="Pacotes do contador"><table className="data-table">
        <thead><tr><th>Período</th><th>Situação</th><th>O que entrou</th><th>Ações</th></tr></thead>
        <tbody>{packages.map((p) => {
          const sent = lastSend(p.id);
          return <tr key={p.id}>
            <td>{p.label}{p.environment === "homologacao" ? " (homologação)" : ""}</td>
            <td>{p.state === "done" ? <>Pronto ({size(p.bytes)}){p.finished_at ? `, ${when(p.finished_at)}` : ""}</> : p.state === "running" ? <span role="status">Montando: {PHASES[p.phase] ?? p.phase}…</span>
              : <span className="real-alert">Não montou: {p.error}</span>}
              {sent && <><br /><small>Enviado ao contador em {when(sent.enviado_em)}{sent.downloads ? `, baixado ${sent.downloads} vez(es)` : ""}</small></>}</td>
            <td><small>{counts(p)}</small></td>
            <td><div className="report-actions">
              {p.state === "done" && <a className="secondary-button" href={downloadUrl(p.id)} download>Baixar</a>}
              {p.state === "done" && writable && <button type="button" className="secondary-button" onClick={() => setSendFor(p)}>Enviar ao contador</button>}
              {writable && p.state !== "running" && <button type="button" className="text-button" disabled={!!busy} onClick={() => void ask(true, p)}>{busy === `refazer:${p.id}` ? "Pedindo…" : "Montar de novo"}</button>}
            </div></td>
          </tr>;
        })}</tbody></table></div>}
    {sendFor && <SendDialog pkg={sendFor} settings={settings} onClose={(done) => { setSendFor(null); if (done) { setNotice(done); setTick((n) => n + 1); } }} />}
  </>;
}

function SendDialog({ pkg, settings, onClose }: { pkg: PackageView; settings: SettingsPage | null; onClose: (done?: string) => void }) {
  const c = settings?.contador;
  const [channel, setChannel] = useState<Channel>(c?.canal ?? "whatsapp"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const destination = channel === "email" ? c?.email : c?.whatsapp;
  const go = async () => {
    setBusy(true); setError("");
    try { const r = await sendPackage({ pacote: pkg.id, canal: channel }); onClose(`Link do pacote de ${r.envio.periodo} enviado para ${r.envio.destino}. Vale por 7 dias.`); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <section className="real-notice" aria-label="Enviar ao contador">
    <header className="real-heading"><div><h2>Enviar ao contador</h2><p>Pacote de {pkg.label}: vai um link seguro para baixar o ZIP, válido por 7 dias.</p></div></header>
    {!c?.whatsapp && !c?.email ? <p className="real-alert" role="alert">Cadastre o contador (WhatsApp ou e-mail) na aba <Link to={`${ROUTE}?aba=contador`}>Contador e envios</Link>.</p> : <>
      <label className="form-field">Enviar por<select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
        <option value="whatsapp" disabled={!c?.whatsapp}>WhatsApp da área{c?.whatsapp ? "" : " (sem número cadastrado)"}</option>
        <option value="email" disabled={!c?.email || !settings?.email_disponivel}>E-mail{!settings?.email_disponivel ? " (a instalação não envia e-mail)" : !c?.email ? " (sem e-mail cadastrado)" : ""}</option></select></label>
      <p className="real-help">Para: {c?.nome ?? "contador"}{destination ? ` (${destination})` : ""}.</p></>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    <div className="report-actions">
      <button type="button" className="primary-button" disabled={busy || !destination} onClick={() => void go()}>{busy ? "Enviando…" : "Enviar"}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onClose()}>Cancelar</button></div>
  </section>;
}

// ---------------------------------------------------------------------------
// Relatórios

function LinesTable({ title, head, lines }: { title: string; head: string; lines: Line[] }) {
  return <section><h3>{title}</h3>{!lines.length ? <p className="real-help">Nada no período.</p>
    : <div className="table-scroll"><table className="data-table"><thead><tr><th>{head}</th><th className="numeric">Notas</th><th className="numeric">Valor</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.key}><td>{l.label}</td><td className="numeric">{l.count}</td><td className="numeric">{money(l.amount)}</td></tr>)}</tbody></table></div>}</section>;
}
function TaxTable({ title, taxes }: { title: string; taxes: Taxes }) {
  const rows: [string, number][] = [["ICMS", taxes.icms], ["ICMS-ST", taxes.icms_st], ["IPI", taxes.ipi], ["PIS", taxes.pis], ["COFINS", taxes.cofins], ["ISS", taxes.iss]];
  return <section><h3>{title}</h3><div className="table-scroll"><table className="data-table"><thead><tr><th>Imposto destacado</th><th className="numeric">Valor</th></tr></thead>
    <tbody>{rows.map(([label, value]) => <tr key={label}><td>{label}</td><td className="numeric">{money(value)}</td></tr>)}</tbody></table></div></section>;
}
function ReportBody({ r }: { r: Report }) {
  return <>
    <p className="real-help">Regime da empresa: {r.regime.label}. Notas emitidas autorizadas: {r.issued.authorized.count} ({money(r.issued.authorized.amount)}). Recebidas autorizadas: {r.received.authorized.count} ({money(r.received.authorized.amount)}), {r.received.with_entry.count} com entrada no ERP.</p>
    <h2>Notas emitidas</h2>
    <LinesTable title="Por CFOP" head="CFOP" lines={r.issued.by_cfop} />
    <LinesTable title="Por natureza da operação" head="Natureza" lines={r.issued.by_nature} />
    <LinesTable title="Por situação" head="Situação" lines={r.issued.by_status} />
    <TaxTable title="Impostos destacados nas emitidas" taxes={r.issued.taxes} />
    {r.simples && <section><h3>Receita por anexo do Simples Nacional</h3><div className="table-scroll"><table className="data-table">
      <thead><tr><th>Anexo</th><th className="numeric">Notas</th><th className="numeric">Valor</th><th>Naturezas</th></tr></thead>
      <tbody>{r.simples.by_annex.map((g) => <tr key={g.key}><td>{g.label}</td><td className="numeric">{g.count}</td><td className="numeric">{money(g.amount)}</td><td>{g.natures.join(", ")}</td></tr>)}
        {r.simples.unassigned.natures.length > 0 && <tr><td>Sem anexo informado</td><td className="numeric">{r.simples.unassigned.count}</td><td className="numeric">{money(r.simples.unassigned.amount)}</td><td>{r.simples.unassigned.natures.join(", ")}</td></tr>}
        <tr><th scope="row">Total</th><td /><td className="numeric"><strong>{money(r.simples.total)}</strong></td><td /></tr></tbody></table></div></section>}
    <h2>Notas recebidas</h2>
    <LinesTable title="Por CFOP" head="CFOP" lines={r.received.by_cfop} />
    <LinesTable title="Por natureza (as lançadas no ERP)" head="Natureza" lines={r.received.by_nature} />
    <LinesTable title="Por situação" head="Situação" lines={r.received.by_status} />
    <TaxTable title="Impostos destacados nas recebidas" taxes={r.received.taxes} />
  </>;
}

function ReportsTab() {
  const [period, setPeriod] = useState(() => monthPeriod(previousMonth())!), [environment, setEnvironment] = useState<Environment>("producao");
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [printing, setPrinting] = useState(false);
  const [tick, setTick] = useState(0);
  const query = { de: period.from, ate: period.to, ambiente: environment };
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError("");
    void loadReport(query, request.signal).then((r) => { if (!request.signal.aborted) setReport(r); })
      .catch((e) => { if (!aborted(e)) { setReport(null); setError(errorText(e)); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [period.from, period.to, environment, tick]);
  // O emissor ainda lê XML: repete depois do intervalo pedido, só com a tela visível.
  useEffect(() => {
    if (!report || report.complete) return;
    const timer = setTimeout(() => { if (visible()) setTick((n) => n + 1); }, Math.max(1500, report.retry_after_ms ?? 1500));
    return () => clearTimeout(timer);
  }, [report]);
  return <>
    <div className="report-filters">
      <PeriodPicker value={period} onChange={setPeriod} />
      <EnvironmentPicker value={environment} onChange={setEnvironment} />
      <div className="report-actions">
        <a className={`secondary-button${report ? "" : " disabled"}`} aria-disabled={!report} href={report ? reportCsvUrl(query) : undefined} download>Exportar CSV</a>
        <button type="button" className="secondary-button" disabled={!report} onClick={() => setPrinting(true)}>Imprimir</button></div>
    </div>
    <p className="real-help">Conferência para o contador: os números vêm do que o emissor autorizou e do que foi lançado no ERP. Não calcula guia de imposto.</p>
    {error && <p className="real-alert" role="alert">{error} <button type="button" className="text-button" onClick={() => setTick((n) => n + 1)}>Tentar de novo</button></p>}
    {loading && !report && <p role="status">Gerando os relatórios…</p>}
    {report && <>
      {report.notices.map((n) => <p key={n} className="real-alert report-warning" role="note">{n}</p>)}
      <ReportBody r={report} />
    </>}
    {printing && report && <StockPrintPreview title="Relatórios fiscais" onClose={() => setPrinting(false)}>
      <h1>Relatórios fiscais para o contador</h1><p>{report.period.label} · {report.environment === "homologacao" ? "homologação (testes)" : "produção"}</p>
      <ReportBody r={report} />{report.notices.map((n) => <p key={n} className="stock-print-foot">{n}</p>)}
    </StockPrintPreview>}
  </>;
}

// ---------------------------------------------------------------------------
// Contador e envios

function AccountantTab({ page, onSaved }: { page: SettingsPage | null; onSaved: (page: SettingsPage) => void }) {
  const [form, setForm] = useState(() => ({ nome: page?.contador.nome ?? "", email: page?.contador.email ?? "", whatsapp: page?.contador.whatsapp ?? "",
    canal: page?.contador.canal ?? "whatsapp" as Channel, linha: page?.contador.linha ?? "", automatico: page?.contador.automatico ?? false, dia: page?.contador.dia ?? 5,
    anexos: { ...(page?.contador.anexos ?? {}) } as Record<string, string> }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [sends, setSends] = useState<SendView[]>([]);
  useEffect(() => {
    const request = new AbortController();
    void listSends(request.signal).then((v) => { if (!request.signal.aborted) setSends(v.envios); }).catch(() => undefined);
    return () => request.abort();
  }, []);
  if (!page) return <p role="status">Carregando o cadastro do contador…</p>;
  const editable = page.pode_editar, simples = ["1", "2", "4"].includes(page.crt ?? "");
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await saveSettings({ nome: form.nome, email: form.email, whatsapp: form.whatsapp, canal: form.canal, linha: form.linha || null,
        automatico: form.automatico, dia: Number(form.dia), ...(simples ? { anexos: form.anexos } : {}) });
      onSaved({ ...page, contador: r.contador });
      setNotice(r.contador.automatico ? `Salvo. Todo dia ${r.contador.dia}, o pacote do mês anterior vai sozinho ao contador.` : "Salvo.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const field = (label: string, input: ReactNode, help?: string) => <label className="form-field">{label}{input}{help && <small className="real-help">{help}</small>}</label>;
  return <>
    <form onSubmit={(e) => { e.preventDefault(); if (editable) void save(); }}>
      <fieldset disabled={!editable || busy}><legend>Contador</legend>
        {field("Nome", <input value={form.nome} maxLength={120} onChange={(e) => setForm({ ...form, nome: e.target.value })} />)}
        {field("E-mail", <input type="email" value={form.email} maxLength={200} onChange={(e) => setForm({ ...form, email: e.target.value })} />,
          page.email_disponivel ? undefined : "Esta instalação ainda não envia e-mail (Gestão → Sistema); o envio vai pelo WhatsApp.")}
        {field("WhatsApp", <input type="tel" value={form.whatsapp} maxLength={30} placeholder="(11) 98765-4321" onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />)}
        {field("Enviar por", <select value={form.canal} onChange={(e) => setForm({ ...form, canal: e.target.value as Channel })}>
          <option value="whatsapp">WhatsApp da área</option><option value="email" disabled={!page.email_disponivel}>E-mail</option></select>)}
        {page.linhas.length > 1 && field("Linha de WhatsApp", <select value={form.linha} onChange={(e) => setForm({ ...form, linha: e.target.value })}>
          <option value="">A linha oficial da área</option>{page.linhas.map((l) => <option key={l.id} value={l.id}>{l.nome}{l.numero ? ` (${l.numero})` : ""}</option>)}</select>)}
        {!page.linhas.length && <p className="real-help">A área não tem linha de WhatsApp conectada (Conexões).</p>}
      </fieldset>
      <fieldset disabled={!editable || busy}><legend>Envio automático</legend>
        <label className="preference-check"><input type="checkbox" checked={form.automatico} onChange={(e) => setForm({ ...form, automatico: e.target.checked })} />
          <span>Enviar sozinho, todo mês, o pacote do mês anterior (produção)</span></label>
        {form.automatico && field("Dia do envio", <input type="number" min={1} max={28} value={form.dia} onChange={(e) => setForm({ ...form, dia: Number(e.target.value) })} />,
          "De 1 a 28. O pacote é montado nesse dia e o link vai assim que fica pronto.")}
        {page.contador.ultimo_mes_automatico && <p className="real-help">Último mês enviado sozinho: {page.contador.ultimo_mes_automatico.split("-").reverse().join("/")}.</p>}
      </fieldset>
      {simples && <fieldset disabled={!editable || busy}><legend>Anexo do Simples Nacional por natureza</legend>
        <p className="real-help">O relatório separa a receita do período por anexo conforme a natureza da operação da nota. Pergunte ao contador o anexo de cada uma.</p>
        {!page.naturezas.length ? <p className="real-help">Nenhuma natureza de operação cadastrada.</p> : page.naturezas.map((n) =>
          field(n, <select value={form.anexos[n] ?? ""} onChange={(e) => setForm({ ...form, anexos: { ...form.anexos, [n]: e.target.value } })}>
            <option value="">Sem anexo (não entra na separação)</option>{page.anexos_validos.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select>))}
      </fieldset>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {notice && <p className="real-help" role="status">{notice}</p>}
      {editable ? <button type="submit" className="primary-button" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
        : <p className="real-help">Só o papel fiscal ou o administrador altera o cadastro do contador.</p>}
    </form>
    <h2>Envios ao contador</h2>
    {!sends.length ? <p className="real-help">Nenhum envio ainda.</p> : <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Quando</th><th>Período</th><th>Para</th><th>Situação</th><th>Por</th></tr></thead>
      <tbody>{sends.map((s) => <tr key={s.id}><td>{when(s.enviado_em)}</td><td>{s.periodo}</td><td>{s.canal === "email" ? "E-mail" : "WhatsApp"} {s.destino}</td>
        <td>{s.situacao === "enviado" ? <>Enviado; link {s.vencido ? "vencido" : `vale até ${when(s.vale_ate)}`}{s.downloads ? `; baixado ${s.downloads} vez(es)` : ""}</> : <span className="real-alert">Não saiu: {s.erro}</span>}</td>
        <td>{s.automatico ? "Envio automático" : s.por}{s.pelo_bot ? " (proposto pelo bot)" : ""}</td></tr>)}</tbody></table></div>}
  </>;
}

// ---------------------------------------------------------------------------

export default function Contador({ role }: { role: string }) {
  const location = useLocation(), navigate = useNavigate();
  const asked = new URLSearchParams(location.search).get("aba");
  const tab: Tab = TABS.some((t) => t.id === asked) ? asked as Tab : "pacote";
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const loaded = useRef(false);
  const writable = role === "admin" || role === "fiscal";
  useEffect(() => {
    if (loaded.current || !contadorBase()) return; loaded.current = true;
    void loadSettings().then(setSettings).catch(() => undefined);
  }, []);
  if (!contadorBase()) return <section className="real-state-panel"><h1>Para o contador</h1><p>{CONTADOR_UNAVAILABLE}</p></section>;
  if (!["admin", "fiscal", "consulta"].includes(role))
    return <section className="real-state-panel"><h1>Para o contador não liberado</h1><p>Seu papel no ERP não alcança o que é do contador. Peça ao administrador o papel fiscal ou de consulta em Pessoas e acessos.</p></section>;
  return <section className="report-screen">
    <header className="real-heading"><div><h1>Para o contador</h1><p>Arquivos fiscais do período, relatórios de conferência e envio ao contador.</p></div></header>
    <nav className="cnab-tabs report-tabs" aria-label="Para o contador">{TABS.map((t) =>
      <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => navigate(`${ROUTE}?aba=${t.id}`)}>{t.label}</button>)}</nav>
    {tab === "pacote" && <PackageTab writable={writable} settings={settings} />}
    {tab === "relatorios" && <ReportsTab />}
    {tab === "contador" && <AccountantTab key={settings ? "ok" : "loading"} page={settings} onSaved={setSettings} />}
  </section>;
}
