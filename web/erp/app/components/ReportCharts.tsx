import { useEffect, useState, type ReactElement } from 'react';
import { blockEnabled } from '../../blocks';
import { todaySP } from '../lib/real-finance-model';
import { DUE_LABELS, REPORTS_UNAVAILABLE, brDate, bucketLabel, c, exportCsv, failureText, money, n, periodOf, quantity, reportsAvailable, reportsGet, t,
  type CashFlowChart, type ChartGroup, type DueChart, type SalesChart, type TurnoverChart, type WarehouseChart } from '../lib/erp-reports';
import { BarList, ColumnChart, fullMoney, shortMoney } from './ReportChart';
import { Icon } from './Icon';
import './real-finance.css';
import './report-chart.css';

type ReportId = 'vendas-periodo' | 'vendas-vendedor' | 'vendas-produto' | 'fluxo' | 'vencimentos' | 'depositos' | 'giro';
const REPORTS: readonly { id: ReportId; label: string; part: 'erp-vendas' | 'erp-financeiro' | 'erp-estoque'; period: boolean; group: boolean }[] = [
  { id: 'vendas-periodo', label: 'Vendas por período', part: 'erp-vendas', period: true, group: true },
  { id: 'vendas-vendedor', label: 'Vendas por vendedor', part: 'erp-vendas', period: true, group: false },
  { id: 'vendas-produto', label: 'Vendas por produto', part: 'erp-vendas', period: true, group: false },
  { id: 'fluxo', label: 'Fluxo de caixa', part: 'erp-financeiro', period: true, group: true },
  { id: 'vencimentos', label: 'Contas por vencimento', part: 'erp-financeiro', period: false, group: false },
  { id: 'depositos', label: 'Estoque por depósito', part: 'erp-estoque', period: false, group: false },
  { id: 'giro', label: 'Giro do estoque', part: 'erp-estoque', period: true, group: false },
];
const request = (id: ReportId, from: string, to: string, group: ChartGroup): [string, Record<string, string>] => {
  const agrupar = { day: 'dia', week: 'semana', month: 'mes' }[group];
  if (id === 'vendas-periodo') return ['/graficos/vendas', { relatorio: 'periodo', de: from, ate: to, agrupar }];
  if (id === 'vendas-vendedor') return ['/graficos/vendas', { relatorio: 'vendedor', de: from, ate: to }];
  if (id === 'vendas-produto') return ['/graficos/vendas', { relatorio: 'produto', de: from, ate: to }];
  if (id === 'fluxo') return ['/graficos/financeiro', { relatorio: 'fluxo', de: from, ate: to, agrupar }];
  if (id === 'vencimentos') return ['/graficos/financeiro', { relatorio: 'vencimentos' }];
  if (id === 'depositos') return ['/graficos/estoque', { relatorio: 'depositos' }];
  return ['/graficos/estoque', { relatorio: 'giro', de: from, ate: to }];
};
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const num = (cents: string) => Number(cents);

/** O gráfico, a tabela por baixo e a planilha de cada relatório. */
function render(id: ReportId, data: any): { chart: ReactElement; table: ReactElement; csv: () => void } {
  if (id === 'vendas-periodo') {
    const v = data as SalesChart, labels = v.items.map(i => bucketLabel(i.start_on!, i.end_on!, v.group));
    return { chart: <ColumnChart title="Valor vendido" labels={labels} series={[{ name: 'Vendas', values: v.items.map(i => num(i.amount_cents)) }]} format={fullMoney} shortFormat={shortMoney} />,
      table: <table className="data-table"><thead><tr><th>Período</th><th className="numeric">Pedidos</th><th className="numeric">Valor</th></tr></thead>
        <tbody>{v.items.map(i => <tr key={i.start_on}><td>{brDate(i.start_on)} a {brDate(i.end_on)}</td><td className="numeric">{i.orders}</td><td className="numeric">{money(i.amount_cents)}</td></tr>)}</tbody>
        <tfoot><tr><th>Total</th><td className="numeric">{v.order_count}</td><td className="numeric">{money(v.total_cents)}</td></tr></tfoot></table>,
      csv: () => exportCsv('vendas-por-periodo', ['Início', 'Fim', 'Pedidos', 'Valor'], v.items.map(i => [t(i.start_on), t(i.end_on), n(i.orders), c(i.amount_cents)])) };
  }
  if (id === 'vendas-vendedor' || id === 'vendas-produto') {
    const v = data as SalesChart, product = id === 'vendas-produto';
    return { chart: <BarList title={product ? 'Produtos que mais venderam' : 'Valor vendido por vendedor'} items={v.items.map(i => ({ label: i.name ?? '—', value: num(i.amount_cents), note: product ? `${quantity(i.quantity)} ${i.unit ?? ''}`.trim() : `${i.orders} pedido(s)` }))} format={fullMoney} />,
      table: <table className="data-table"><thead><tr><th>{product ? 'Produto' : 'Vendedor'}</th>{product && <th>Código</th>}<th className="numeric">{product ? 'Quantidade' : 'Pedidos'}</th><th className="numeric">Valor</th></tr></thead>
        <tbody>{v.items.map((i, k) => <tr key={`${i.seller_id ?? i.product_id ?? i.name}-${k}`}><td>{i.name}</td>{product && <td>{i.code ?? '—'}</td>}<td className="numeric">{product ? quantity(i.quantity) : i.orders}</td><td className="numeric">{money(i.amount_cents)}</td></tr>)}</tbody>
        <tfoot><tr><th>Total do período</th>{product && <td />}<td className="numeric">{product ? `${v.product_count} produto(s)` : v.order_count}</td><td className="numeric">{money(v.total_cents)}</td></tr></tfoot></table>,
      csv: () => exportCsv(product ? 'vendas-por-produto' : 'vendas-por-vendedor', product ? ['Produto', 'Código', 'Quantidade', 'Pedidos', 'Valor'] : ['Vendedor', 'Pedidos', 'Valor'],
        v.items.map(i => product ? [t(i.name), t(i.code), n(i.quantity), n(i.orders), c(i.amount_cents)] : [t(i.name), n(i.orders), c(i.amount_cents)])) };
  }
  if (id === 'fluxo') {
    const v = data as CashFlowChart, labels = v.items.map(i => bucketLabel(i.start_on, i.end_on, v.group));
    const net = (a: string, b: string) => num(a) - num(b);
    return { chart: <ColumnChart title="Resultado do período: previsto e realizado" labels={labels} format={fullMoney} shortFormat={shortMoney}
      series={[{ name: 'Previsto', values: v.items.map(i => net(i.forecast_in_cents, i.forecast_out_cents)) }, { name: 'Realizado', values: v.items.map(i => net(i.realized_in_cents, i.realized_out_cents)) }]} />,
      table: <table className="data-table"><thead><tr><th>Período</th><th className="numeric">A receber (previsto)</th><th className="numeric">A pagar (previsto)</th><th className="numeric">Entradas</th><th className="numeric">Saídas</th><th className="numeric">Saldo realizado</th></tr></thead>
        <tbody>{v.items.map(i => <tr key={i.start_on}><td>{brDate(i.start_on)} a {brDate(i.end_on)}</td><td className="numeric">{money(i.forecast_in_cents)}</td><td className="numeric">{money(i.forecast_out_cents)}</td>
          <td className="numeric">{money(i.realized_in_cents)}</td><td className="numeric">{money(i.realized_out_cents)}</td><td className="numeric">{money(i.balance_cents)}</td></tr>)}</tbody>
        <tfoot><tr><th>Total (saldo inicial {money(v.opening_cents)})</th><td className="numeric">{money(v.totals.forecast_in_cents)}</td><td className="numeric">{money(v.totals.forecast_out_cents)}</td>
          <td className="numeric">{money(v.totals.realized_in_cents)}</td><td className="numeric">{money(v.totals.realized_out_cents)}</td><td className="numeric">{money(v.totals.closing_cents)}</td></tr></tfoot></table>,
      csv: () => exportCsv('fluxo-de-caixa', ['Início', 'Fim', 'A receber (previsto)', 'A pagar (previsto)', 'Entradas', 'Saídas', 'Saldo realizado'],
        v.items.map(i => [t(i.start_on), t(i.end_on), c(i.forecast_in_cents), c(i.forecast_out_cents), c(i.realized_in_cents), c(i.realized_out_cents), c(i.balance_cents)])) };
  }
  if (id === 'vencimentos') {
    const v = data as DueChart, labels = v.items.map(i => DUE_LABELS[i.key] ?? i.key);
    return { chart: <ColumnChart title="Contas em aberto por vencimento" labels={labels} format={fullMoney} shortFormat={shortMoney}
      series={[{ name: 'A receber', values: v.items.map(i => num(i.receivable_cents)) }, { name: 'A pagar', values: v.items.map(i => num(i.payable_cents)) }]} />,
      table: <table className="data-table"><thead><tr><th>Vencimento</th><th className="numeric">Contas a receber</th><th className="numeric">A receber</th><th className="numeric">Contas a pagar</th><th className="numeric">A pagar</th></tr></thead>
        <tbody>{v.items.map(i => <tr key={i.key}><td>{DUE_LABELS[i.key]}</td><td className="numeric">{i.receivable_count}</td><td className="numeric">{money(i.receivable_cents)}</td><td className="numeric">{i.payable_count}</td><td className="numeric">{money(i.payable_cents)}</td></tr>)}</tbody>
        <tfoot><tr><th>Total em aberto</th><td /><td className="numeric">{money(v.totals.receivable_cents)}</td><td /><td className="numeric">{money(v.totals.payable_cents)}</td></tr></tfoot></table>,
      csv: () => exportCsv('contas-por-vencimento', ['Vencimento', 'De', 'Até', 'Contas a receber', 'A receber', 'Contas a pagar', 'A pagar'],
        v.items.map(i => [t(DUE_LABELS[i.key]), t(i.from_on), t(i.to_on), n(i.receivable_count), c(i.receivable_cents), n(i.payable_count), c(i.payable_cents)])) };
  }
  if (id === 'depositos') {
    const v = data as WarehouseChart;
    return { chart: <BarList title="Produtos com saldo por depósito" items={v.items.map(i => ({ label: i.name, value: i.products, note: i.ignored ? 'saldo desconsiderado' : undefined }))} format={value => `${value} produto(s)`} />,
      table: <table className="data-table"><thead><tr><th>Depósito</th><th className="numeric">Produtos com saldo</th><th className="numeric">Quantidade</th><th className="numeric">Saldos negativos</th></tr></thead>
        <tbody>{v.items.map(i => <tr key={i.warehouse_id}><td>{i.name}{i.active ? '' : ' (inativo)'}{i.ignored ? ' · saldo desconsiderado' : ''}</td><td className="numeric">{i.products}</td><td className="numeric">{quantity(i.quantity)}</td><td className="numeric">{i.negative_positions}</td></tr>)}</tbody></table>,
      csv: () => exportCsv('estoque-por-deposito', ['Depósito', 'Produtos com saldo', 'Quantidade', 'Saldos negativos'], v.items.map(i => [t(i.name), n(i.products), n(i.quantity), n(i.negative_positions)])) };
  }
  const v = data as TurnoverChart;
  return { chart: <BarList title="Giro no período (saídas ÷ saldo médio)" items={v.items.map(i => ({ label: i.name, value: Number(i.turnover ?? 0), note: `${quantity(i.out_quantity)} ${i.unit ?? ''} saíram`.trim() }))} format={value => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}×`} />,
    table: <table className="data-table"><thead><tr><th>Produto</th><th className="numeric">Saídas</th><th className="numeric">Saldo médio</th><th className="numeric">Saldo no fim</th><th className="numeric">Giro</th><th className="numeric">Dura (dias)</th></tr></thead>
      <tbody>{v.items.map(i => <tr key={i.product_id}><td>{i.code ? `${i.code} · ` : ''}{i.name}</td><td className="numeric">{quantity(i.out_quantity)}</td><td className="numeric">{quantity(i.average_quantity)}</td>
        <td className="numeric">{quantity(i.end_quantity)}</td><td className="numeric">{i.turnover === null ? '—' : `${Number(i.turnover).toLocaleString('pt-BR')}×`}</td><td className="numeric">{i.cover_days ?? '—'}</td></tr>)}</tbody></table>,
    csv: () => exportCsv('giro-do-estoque', ['Código', 'Produto', 'Saídas', 'Saldo inicial', 'Saldo médio', 'Saldo no fim', 'Giro', 'Dura (dias)'],
      v.items.map(i => [t(i.code), t(i.name), n(i.out_quantity), n(i.start_quantity), n(i.average_quantity), n(i.end_quantity), n(i.turnover), n(i.cover_days)])) };
}

/**
 * Relatórios em gráfico: vendas por período, vendedor e produto (Vendas), fluxo de caixa previsto e realizado e contas por vencimento
 * (Financeiro), estoque por depósito e giro (Estoque). Cada relatório só aparece com a parte dele ligada; o gráfico vem com a tabela
 * por baixo e a exportação CSV.
 */
export default function ReportCharts() {
  const today = todaySP(), available = reportsAvailable();
  const reports = REPORTS.filter(report => blockEnabled(report.part));
  const [id, setId] = useState<ReportId | null>(reports[0]?.id ?? null);
  const month = periodOf('mes', today);
  const [period, setPeriod] = useState({ from: month.from, to: today < month.to ? today : month.to }), [draft, setDraft] = useState(period), [group, setGroup] = useState<ChartGroup>('day');
  const [state, setState] = useState<{ key: string; data: unknown; error: string }>({ key: '', data: null, error: '' }), [reload, setReload] = useState(0);
  const current = reports.find(report => report.id === id) ?? reports[0];
  const key = current ? JSON.stringify([current.id, period, group, reload]) : '';
  useEffect(() => {
    if (!available || !current) return; const control = new AbortController(), [path, query] = request(current.id, period.from, period.to, group);
    void reportsGet(path, query, control.signal).then(data => { if (!control.signal.aborted) setState({ key, data, error: '' }); })
      .catch(failure => { if (!aborted(failure)) setState({ key, data: null, error: failureText(failure) }); });
    return () => control.abort();
  }, [key, available]);
  if (!available) return <section className="real-state-panel"><h1>Relatórios em gráfico</h1><p>{REPORTS_UNAVAILABLE}</p></section>;
  if (!current) return <section className="real-state-panel"><h1>Relatórios em gráfico</h1><p>Os relatórios em gráfico precisam de Vendas, Financeiro ou Estoque ligado. Ligue em Gestão → Módulos.</p></section>;
  const ready = state.key === key ? state : null, view = ready?.data ? render(current.id, ready.data) : null;
  const apply = () => { if (draft.from && draft.to && draft.from <= draft.to) setPeriod(draft); };
  const off = REPORTS.filter(report => !blockEnabled(report.part)).map(report => report.part).filter((part, i, all) => all.indexOf(part) === i);
  return <section className="report-screen">
    <header className="real-heading"><div><h1>Relatórios em gráfico</h1><p>{REPORTS.find(r => r.id === current.id)!.label}</p></div>
      <div className="report-actions"><button type="button" className="secondary-button" disabled={!view} onClick={() => view?.csv()}><Icon name="file-lines" size={14} />Exportar CSV</button></div></header>
    <nav className="cnab-tabs report-tabs" aria-label="Relatórios">{reports.map(report => <button key={report.id} type="button" aria-current={report.id === current.id ? 'page' : undefined} onClick={() => setId(report.id)}>{report.label}</button>)}</nav>
    {off.length > 0 && <p className="real-help">Outros relatórios aparecem quando {off.map(part => ({ 'erp-vendas': 'Vendas', 'erp-financeiro': 'Financeiro', 'erp-estoque': 'Estoque' }[part])).join(', ')} estiver ligado em Gestão → Módulos.</p>}
    {(current.period || current.group) && <form className="report-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      {current.period && <><label className="form-field">De<input type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
        <label className="form-field">Até<input type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label></>}
      {current.group && <label className="form-field">Agrupar por<select value={group} onChange={event => setGroup(event.target.value as ChartGroup)}><option value="day">Dia</option><option value="week">Semana</option><option value="month">Mês</option></select></label>}
      {current.period && <button type="submit" className="primary-button">Gerar</button>}
    </form>}
    {current.id === 'giro' && <p className="real-help">Giro = quantidade que saiu (lançamentos de saída) ÷ saldo médio do período. O período do giro vai até hoje, no máximo um ano. Dura = quantos dias o saldo do fim do período dura no mesmo ritmo de saída.</p>}
    {current.id === 'fluxo' && <p className="real-help">Previsto: contas a receber e a pagar (não canceladas) pelo vencimento. Realizado: entradas e saídas das contas financeiras, sem as transferências entre elas.</p>}
    {current.id.startsWith('vendas') && <p className="real-help">Pedidos de venda pela data do pedido, sem os cancelados e os rascunhos.</p>}
    {ready?.error && <p className="real-alert" role="alert">{ready.error} <button type="button" className="text-button" onClick={() => setReload(x => x + 1)}>Tentar de novo</button></p>}
    {!ready && <p role="status">Gerando o relatório…</p>}
    {view && <>{view.chart}<div className="table-scroll" tabIndex={0} role="region" aria-label="Tabela do relatório">{view.table}</div></>}
  </section>;
}
