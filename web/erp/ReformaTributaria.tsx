// Fiscal › Reforma tributária (IBS, CBS e IS): a configuração da empresa
// (opção do Simples pelo regime regular e alíquotas dos anos ainda não
// publicados), o que o cofre aceita, a tabela de classificações embutida e o
// relatório do período para o contador (CSV). O servidor confere e grava
// tudo (src/erp/reforma/, src/erp/domains/fiscal/reform.ts); a tela só manda
// as escolhas.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { REFORM_CLASSES, REFORM_CSTS, REFORM_TABLE_SOURCE, REFORM_TABLE_VERSION } from "../../src/erp/domains/fiscal/reform-table.ts";
import {
  formatRate, REFORM_UNAVAILABLE, reformAvailable, reformCsvUrl, reformErrorText, reformGet, reformPost,
  type ReformReportView, type ReformSettingsView,
} from "./app/lib/reform";
import "./app/components/real-finance.css";
import "./app/components/report-chart.css";

const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const brl = (value: string) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const REGIME: Record<string, string> = {
  regular: "Regime regular: IBS e CBS destacados nos documentos.",
  simples: "Simples Nacional: IBS e CBS não são destacados (marque a opção abaixo se a empresa optou pelo regime regular).",
  simples_regular: "Simples Nacional com opção pelo regime regular: IBS e CBS destacados.",
};
type RateDraft = Record<string, { cbs: string; ibs_uf: string; ibs_mun: string }>;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

function Settings({ view, onSaved }: { view: ReformSettingsView; onSaved: (v: ReformSettingsView) => void }) {
  const [simples, setSimples] = useState(view.settings.simples_regular);
  const [rates, setRates] = useState<RateDraft>(() => Object.fromEntries(view.years.map(y => [String(y.year), {
    cbs: view.settings.rates[String(y.year)]?.cbs ?? "", ibs_uf: view.settings.rates[String(y.year)]?.ibs_uf ?? "", ibs_mun: view.settings.rates[String(y.year)]?.ibs_mun ?? "" }])));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const locked = !view.writable || busy;
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const aliquotas = Object.fromEntries(Object.entries(rates).map(([year, r]) => [year, Object.fromEntries(Object.entries(r).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim().replace(",", ".")]))])
        .filter(([, r]) => Object.keys(r as object).length));
      const saved = await reformPost<ReformSettingsView>("/configuracao", { simples_regular: simples, aliquotas, versao: view.version });
      onSaved(saved); setNotice("Configuração da reforma salva. Ela vale nas próximas propostas, pedidos e notas (prepare de novo as notas já preparadas).");
    } catch (e) { setError(reformErrorText(e)); }
    finally { setBusy(false); }
  };
  const input = (year: string, key: "cbs" | "ibs_uf" | "ibs_mun", placeholder: string | null) =>
    <input aria-label={`${key === "cbs" ? "CBS" : key === "ibs_uf" ? "IBS estadual" : "IBS municipal"} de ${year} (%)`} inputMode="decimal" disabled={locked} size={7}
      placeholder={placeholder === null ? "informe" : placeholder.replace(".", ",")} value={rates[year]?.[key] ?? ""}
      onChange={e => setRates({ ...rates, [year]: { ...rates[year], [key]: e.target.value } })} />;
  return <section aria-label="Configuração da reforma">
    <h2>Regime e alíquotas</h2>
    <p className="real-help">{REGIME[view.regime] ?? ""}</p>
    {["1", "2", "4"].includes(view.crt ?? "") && <label className="preference-check"><input type="checkbox" disabled={locked} checked={simples} onChange={e => setSimples(e.target.checked)} /> A empresa do Simples Nacional optou por recolher IBS e CBS pelo regime regular</label>}
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Ano</th><th>CBS</th><th>IBS estadual</th><th>IBS municipal</th><th>Origem</th><th>Observação</th></tr></thead>
      <tbody>{view.years.map(y => { const year = String(y.year); const table = y.origin === "company" ? null : y; return <tr key={year}>
        <td>{year}</td>
        <td>{input(year, "cbs", table?.cbs ?? null)}</td><td>{input(year, "ibs_uf", table?.ibs_uf ?? null)}</td><td>{input(year, "ibs_mun", table?.ibs_mun ?? null)}</td>
        <td>{y.origin === "test" ? "Alíquota de teste" : y.origin === "table" ? "Tabela" : y.origin === "company" ? "Informada pela empresa" : "Não publicada"}</td>
        <td>{y.note}</td></tr>; })}</tbody>
    </table></div>
    <p className="real-help">Deixe em branco para usar a alíquota da tabela. De 2027 em diante as alíquotas de referência dependem de resolução do Senado: informe as publicadas, com o contador. Em 2026 valem as de teste (CBS {formatRate("0.9")} e IBS {formatRate("0.1")}).</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-notice" role="status">{notice}</p>}
    {view.writable ? <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar configuração"}</button>
      : <p className="real-help">Só quem tem o papel Fiscal ou Administrador no ERP muda a configuração.</p>}
  </section>;
}

function Vault({ view }: { view: ReformSettingsView }) {
  const v = view.vault;
  return <section aria-label="Cofre fiscal e a reforma">
    <h2>Seu cofre fiscal</h2>
    {!v.known ? <p className="real-alert">O Vinki ainda não sabe se o seu cofre recebe a reforma tributária. Em <Link to="/certificado-a1">Configuração do emissor</Link>, clique em Testar conexão e salve a configuração da NF-e. Até lá, nota com produto classificado fica parada.</p>
      : v.ibs_cbs ? <p className="real-notice">O cofre recebe o grupo IBS/CBS{v.selective ? " e o Imposto Seletivo" : ""}: as NF-e saem com os valores da reforma.{v.credit_debit ? " Nota de crédito e nota de débito liberadas." : " Nota de crédito e nota de débito (finalidades 5 e 6) ainda não."}</p>
      : <p className="real-alert">O seu cofre ainda não recebe a reforma tributária: as NF-e saem como hoje, sem o grupo IBS/CBS, e a tela da nota mostra os valores só para conferência. Atualize o cofre e teste a conexão de novo.</p>}
  </section>;
}

function Table() {
  const [cst, setCst] = useState(""), [search, setSearch] = useState("");
  const rows = useMemo(() => REFORM_CLASSES.filter(c => (!cst || c.cst === cst) && (!search || `${c.code} ${c.description}`.toLowerCase().includes(search.toLowerCase()))), [cst, search]);
  return <section aria-label="Tabela de classificações">
    <h2>Classificações tributárias (cClassTrib)</h2>
    <p className="real-help">Tabela embutida, versão {REFORM_TABLE_VERSION}. {REFORM_TABLE_SOURCE}</p>
    <div className="report-filters">
      <label className="form-field">CST<select value={cst} onChange={e => setCst(e.target.value)}><option value="">Todos</option>{REFORM_CSTS.map(c => <option key={c.cst} value={c.cst}>{c.cst} — {c.description}</option>)}</select></label>
      <label className="form-field">Procurar<input value={search} onChange={e => setSearch(e.target.value)} placeholder="código ou descrição" /></label>
    </div>
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Código</th><th>CST</th><th>Descrição</th><th className="numeric">Redução CBS</th><th className="numeric">Redução IBS</th><th>Lei</th></tr></thead>
      <tbody>{rows.map(c => <tr key={c.code}><td>{c.code}</td><td>{c.cst}</td><td>{c.description}</td><td className="numeric">{formatRate(c.cbs_reduction)}</td><td className="numeric">{formatRate(c.ibs_reduction)}</td><td>LC 214/2025, {c.law}</td></tr>)}</tbody>
    </table></div>
  </section>;
}

function Report() {
  const [period, setPeriod] = useState(() => ({ from: monthStart(today()), to: today() }));
  const [environment, setEnvironment] = useState("producao");
  const [report, setReport] = useState<ReformReportView | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!period.from || !period.to || period.from > period.to) return;
    const request = new AbortController(); setError("");
    reformGet<ReformReportView>("/relatorio", { de: period.from, ate: period.to, ambiente: environment }, request.signal)
      .then(v => { if (!request.signal.aborted) setReport(v); })
      .catch(e => { if (!aborted(e)) { setReport(null); setError(reformErrorText(e)); } });
    return () => request.abort();
  }, [period, environment]);
  const csv = reformCsvUrl(period.from, period.to, environment);
  return <section aria-label="Relatório para o contador">
    <h2>Relatório de IBS, CBS e IS</h2>
    <p className="real-help">NF-e autorizadas no período, por mês e classificação, com o cálculo guardado em cada nota. Para conferência do contador.</p>
    <div className="report-filters">
      <label className="form-field">De<input type="date" value={period.from} onChange={e => setPeriod({ ...period, from: e.target.value })} /></label>
      <label className="form-field">Até<input type="date" value={period.to} onChange={e => setPeriod({ ...period, to: e.target.value })} /></label>
      <label className="form-field">Ambiente<select value={environment} onChange={e => setEnvironment(e.target.value)}><option value="producao">Produção (notas com valor fiscal)</option><option value="homologacao">Homologação (testes)</option></select></label>
      {csv && <a className="secondary-button" href={csv} download>Baixar CSV</a>}
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {report && <>
      {report.lines.length ? <div className="table-scroll"><table className="data-table">
        <thead><tr><th>Mês</th><th>CST</th><th>Classificação</th><th>Descrição</th><th className="numeric">Notas</th><th className="numeric">Base</th><th className="numeric">CBS</th><th className="numeric">IBS</th><th className="numeric">IS</th></tr></thead>
        <tbody>{report.lines.map((l, i) => <tr key={i}><td>{l.month}</td><td>{l.cst}</td><td>{l.cclasstrib}</td><td>{l.description}</td><td className="numeric">{l.notes}</td>
          <td className="numeric">{brl(l.base)}</td><td className="numeric">{brl(l.cbs)}</td><td className="numeric">{brl(l.ibs)}</td><td className="numeric">{brl(l.selective)}</td></tr>)}</tbody>
        <tfoot><tr><th colSpan={4}>Total</th><th className="numeric">{report.totals.notes}</th><th className="numeric">{brl(report.totals.base)}</th><th className="numeric">{brl(report.totals.cbs)}</th><th className="numeric">{brl(report.totals.ibs)}</th><th className="numeric">{brl(report.totals.selective)}</th></tr></tfoot>
      </table></div> : <p className="real-help">Nenhuma NF-e autorizada com cálculo da reforma neste período.</p>}
      {report.without_reform > 0 && <p className="real-help">{report.without_reform} nota(s) do período sem cálculo da reforma (emitidas antes dele ou sem classificação).</p>}
    </>}
  </section>;
}

export default function ReformaTributaria() {
  const [view, setView] = useState<ReformSettingsView | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!reformAvailable()) return;
    const request = new AbortController();
    reformGet<ReformSettingsView>("/configuracao", {}, request.signal).then(v => { if (!request.signal.aborted) setView(v); })
      .catch(e => { if (!aborted(e)) setError(reformErrorText(e)); });
    return () => request.abort();
  }, []);
  return <section className="report-screen">
    <header className="real-heading"><div><h1>Reforma tributária: IBS, CBS e IS</h1>
      <p>Em 2026 a NF-e leva IBS e CBS só para informar (alíquotas de teste): o total a pagar não muda. Classifique os produtos (Produto › Tributação) ou ponha um padrão na <Link to="/naturezas-operacao">natureza de operação</Link>.</p></div></header>
    {!reformAvailable() ? <p className="real-state-panel">{REFORM_UNAVAILABLE}</p> : error ? <p className="real-alert" role="alert">{error}</p> : !view ? <p role="status">Carregando…</p> : <>
      <Vault view={view} />
      <Settings key={view.version} view={view} onSaved={setView} />
      <Report />
      <Table />
    </>}
  </section>;
}
