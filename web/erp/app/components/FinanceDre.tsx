import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { todaySP } from '../lib/real-finance-model';
import { DRE_LAYOUT, DRE_SOURCES, PERIOD_KINDS, REPORTS_UNAVAILABLE, brDate, c, exportCsv, failureText, money, periodLabel, periodOf, reportsAvailable, reportsGet, shiftPeriod, t, variation,
  type DreBasis, type DreCategory, type DreDetail, type DreView, type PeriodKind } from '../lib/erp-reports';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
import './real-finance.css';
import './report-chart.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Linhas do DRE na ordem da tela: grupos (com as categorias) e subtotais. */
function DreTable({ view, open, onToggle, onDetail }: { view: DreView; open: Set<string>; onToggle?: (key: string) => void; onDetail?: (category: DreCategory) => void }) {
  const compare = view.previous !== null;
  const value = (row: { amount_cents: string; previous_cents: string | null }) => <><td className="numeric">{money(row.amount_cents)}</td>
    {compare && <><td className="numeric">{money(row.previous_cents)}</td><td className="numeric">{variation(row.amount_cents, row.previous_cents)}</td></>}</>;
  const category = (item: DreCategory) => <tr key={item.category_id ?? 'none'} className="report-sub">
    <td>{onDetail ? <button type="button" className="text-button" onClick={() => onDetail(item)}>{item.path}</button> : item.path}{item.deleted ? ' (excluída)' : ''}</td>{value(item)}</tr>;
  return <table className="data-table">
    <thead><tr><th scope="col">Demonstrativo</th><th scope="col" className="numeric">{periodLabel(view.from, view.to)}</th>
      {compare && <><th scope="col" className="numeric">{periodLabel(view.previous!.from, view.previous!.to)}</th><th scope="col" className="numeric">Variação</th></>}</tr></thead>
    <tbody>{DRE_LAYOUT.map(entry => {
      if (entry.kind === 'L') { const line = view.lines.find(l => l.key === entry.key)!; return <tr key={entry.key} className="report-line"><th scope="row">{entry.label}</th>{value(line)}</tr>; }
      const group = view.groups.find(g => g.key === entry.key)!, expanded = open.has(entry.key);
      return <Fragment key={entry.key}><tr><th scope="row">{onToggle && group.categories.length ? <button type="button" className="text-button" aria-expanded={expanded} onClick={() => onToggle(entry.key)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} />{entry.label}</button> : entry.label}</th>{value(group)}</tr>
        {(expanded || !onToggle) && group.categories.map(category)}</Fragment>;
    })}
    {view.unclassified.categories.length > 0 && <><tr className="report-line"><th scope="row">Sem classificação (fora do resultado)</th>{value(view.unclassified)}</tr>{view.unclassified.categories.map(category)}</>}
    </tbody></table>;
}

/**
 * Financeiro › DRE gerencial: o período (mês, trimestre, ano ou intervalo) pelo regime de caixa ou de competência, nas categorias
 * financeiras do primeiro nível (o grupo de DRE se escolhe em Financeiro › Categorias), comparado com o período anterior; clicar na
 * categoria mostra as baixas, contas e lançamentos dela. Exporta CSV e imprime. Só leitura.
 */
export default function FinanceDre() {
  const today = todaySP();
  const [kind, setKind] = useState<PeriodKind>('mes'), [period, setPeriod] = useState(() => periodOf('mes', today));
  const [draft, setDraft] = useState(period), [basis, setBasis] = useState<DreBasis>('caixa'), [compare, setCompare] = useState(true);
  const [view, setView] = useState<DreView | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set()), [printing, setPrinting] = useState(false);
  const [detail, setDetail] = useState<{ category: DreCategory; page: number; data: DreDetail | null; error: string } | null>(null);
  const available = reportsAvailable();
  useEffect(() => {
    if (!available) return; const request = new AbortController(); setLoading(true); setError('');
    void reportsGet<DreView>('/dre', { de: period.from, ate: period.to, regime: basis, comparar: compare ? '1' : '0' }, request.signal)
      .then(value => { if (!request.signal.aborted) setView(value); }).catch(failure => { if (!aborted(failure)) { setView(null); setError(failureText(failure)); } })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [period.from, period.to, basis, compare, reload, available]);
  useEffect(() => {
    if (!detail || detail.data || detail.error) return; const request = new AbortController();
    void reportsGet<DreDetail>(`/dre/categoria/${detail.category.category_id ?? 'sem'}`, { de: period.from, ate: period.to, regime: basis, pagina: String(detail.page) }, request.signal)
      .then(data => { if (!request.signal.aborted) setDetail(current => current && { ...current, data }); })
      .catch(failure => { if (!aborted(failure)) setDetail(current => current && { ...current, error: failureText(failure) }); });
    return () => request.abort();
  }, [detail?.category.category_id, detail?.page]);
  if (!available) return <section className="real-state-panel"><h1>DRE gerencial</h1><p>{REPORTS_UNAVAILABLE}</p></section>;
  const choose = (next: PeriodKind) => { setKind(next); if (next !== 'intervalo') { const p = periodOf(next, period.from); setPeriod(p); setDraft(p); } };
  const step = (n: number) => { const p = shiftPeriod(kind, period.from, n); setPeriod(p); setDraft(p); };
  const csv = () => {
    if (!view) return;
    const rows: ReturnType<typeof t>[][] = [];
    const push = (label: string, row: { amount_cents: string; previous_cents: string | null }) => rows.push([t(label), c(row.amount_cents), ...(view.previous ? [c(row.previous_cents)] : [])]);
    for (const entry of DRE_LAYOUT) {
      if (entry.kind === 'L') { push(entry.label, view.lines.find(l => l.key === entry.key)!); continue; }
      const group = view.groups.find(g => g.key === entry.key)!; push(entry.label, group);
      for (const item of group.categories) push(`   ${item.path}`, item);
    }
    if (view.unclassified.categories.length) { push('Sem classificação (fora do resultado)', view.unclassified); for (const item of view.unclassified.categories) push(`   ${item.path}`, item); }
    exportCsv(`dre-${view.from}-${view.to}-${basis}`, ['Demonstrativo', periodLabel(view.from, view.to), ...(view.previous ? [periodLabel(view.previous.from, view.previous.to)] : [])], rows);
  };
  const toggle = (key: string) => setOpen(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const basisText = basis === 'caixa' ? 'Regime de caixa: pela data das baixas (juros, multas, descontos e taxas nas categorias da baixa) e dos lançamentos de caixa.'
    : 'Regime de competência: pela competência das contas (não canceladas) e dos lançamentos de caixa.';
  const header = (body: ReactNode) => <p className="real-help">{body}</p>;
  return <section className="report-screen finance-reports">
    <header className="real-heading"><div><h1>DRE gerencial</h1><p>Receitas, deduções, custos, despesas e resultado pelas categorias financeiras.</p></div>
      <div className="report-actions"><button type="button" className="secondary-button" disabled={!view} onClick={csv}><Icon name="file-lines" size={14} />Exportar CSV</button>
        <button type="button" className="secondary-button" disabled={!view} onClick={() => setPrinting(true)}><Icon name="print" size={14} />Imprimir</button></div></header>
    <nav className="cnab-tabs report-tabs" aria-label="Período">{PERIOD_KINDS.map(item => <button key={item.id} type="button" aria-current={kind === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>{item.label}</button>)}</nav>
    <div className="report-filters">
      {kind === 'intervalo' ? <form className="report-filters" onSubmit={event => { event.preventDefault(); if (draft.from && draft.to && draft.from <= draft.to) setPeriod(draft); else setError('Informe o início e o fim, com o início antes do fim.'); }}>
        <label className="form-field">De<input type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
        <label className="form-field">Até<input type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
        <button type="submit" className="primary-button">Gerar</button></form>
        : <div className="report-actions"><button type="button" className="secondary-button" aria-label="Período anterior" onClick={() => step(-1)}><Icon name="chevron-left" size={12} /></button>
          <strong>{periodLabel(period.from, period.to)}</strong><button type="button" className="secondary-button" aria-label="Próximo período" onClick={() => step(1)}><Icon name="chevron-right" size={12} /></button></div>}
      <label className="form-field">Regime<select value={basis} onChange={event => setBasis(event.target.value as DreBasis)}><option value="caixa">Caixa</option><option value="competencia">Competência</option></select></label>
      <label className="preference-check"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} /><span>Comparar com o período anterior</span></label>
    </div>
    {header(basisText)}
    {error && <p className="real-alert" role="alert">{error} <button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar de novo</button></p>}
    {loading && <p role="status">Gerando o DRE…</p>}
    {view && !loading && <>
      {view.unclassified.categories.length > 0 && <p className="real-alert report-warning" role="note">{view.unclassified.categories.length} categoria(s) sem grupo de DRE somam {money(view.unclassified.amount_cents)} e ficaram fora do resultado.
        Escolha o grupo de DRE de cada uma em <Link to="/financeiro-empresa?area=categories">Financeiro › Categorias</Link>.</p>}
      {view.hidden.categories.length > 0 && header(`${view.hidden.categories.length} categoria(s) marcadas para não exibir no DRE somam ${money(view.hidden.amount_cents)} no período.`)}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="DRE gerencial"><DreTable view={view} open={open} onToggle={toggle} onDetail={category => setDetail({ category, page: 1, data: null, error: '' })} /></div>
    </>}
    {detail && <section className="real-notice" aria-label={`Detalhe de ${detail.category.path}`}>
      <header className="real-heading"><div><h2>{detail.category.path}</h2><p>{periodLabel(period.from, period.to)} · {basis === 'caixa' ? 'caixa' : 'competência'}</p></div>
        <button type="button" className="secondary-button" onClick={() => setDetail(null)}>Fechar</button></header>
      {detail.error && <p className="real-alert" role="alert">{detail.error}</p>}
      {!detail.data && !detail.error && <p role="status">Carregando…</p>}
      {detail.data && <><div className="table-scroll"><table className="data-table"><thead><tr><th>Data</th><th>Origem</th><th>Descrição</th><th>Contato</th><th className="numeric">Valor</th></tr></thead>
        <tbody>{detail.data.items.map(item => <tr key={`${item.source}:${item.id}:${item.amount_cents}`}><td>{brDate(item.on)}</td><td>{DRE_SOURCES[item.source]}</td>
          <td>{item.description}</td>
          <td>{item.contact_name ?? '—'}</td><td className="numeric">{money(item.amount_cents)}</td></tr>)}</tbody></table></div>
        <p className="real-help">{detail.data.total} lançamento(s) · total {money(detail.data.amount_cents)}</p>
        {detail.data.total > detail.data.limit && <div className="report-actions">
          <button type="button" className="secondary-button" disabled={detail.page <= 1} onClick={() => setDetail({ ...detail, page: detail.page - 1, data: null })}>Anterior</button>
          <button type="button" className="secondary-button" disabled={detail.page * detail.data.limit >= detail.data.total} onClick={() => setDetail({ ...detail, page: detail.page + 1, data: null })}>Próxima</button></div>}</>}
    </section>}
    {printing && view && <StockPrintPreview title="DRE gerencial" onClose={() => setPrinting(false)}>
      <h1>DRE gerencial</h1><p>{periodLabel(view.from, view.to)} · regime de {basis === 'caixa' ? 'caixa' : 'competência'}</p>
      <DreTable view={view} open={new Set()} /><p className="stock-print-foot">Emitido em {brDate(today)} (horário de São Paulo).</p>
    </StockPrintPreview>}
  </section>;
}
