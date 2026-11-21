import { useEffect, useState } from 'react';
import { blockEnabled } from '../../blocks';
import { brDate, exportCsv, failureText, n, quantity, reportsAvailable, reportsGet, t, type LotRow, type LotsExpiring } from '../lib/erp-reports';
import { Icon } from './Icon';
import './report-chart.css';

import { LOT_ALERT_ROLES } from './HomeValidityAlert';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function LotTable({ rows, label }: { rows: LotRow[]; label: string }) {
  return <div className="table-scroll" role="region" aria-label={label} tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Produto</th><th scope="col">Lote</th><th scope="col">Validade</th><th scope="col">Depósito</th><th scope="col" className="numeric">Saldo</th></tr></thead>
    <tbody>{rows.map(row => <tr key={`${row.lot_id}:${row.warehouse_id}`}><td>{row.product_code ? `${row.product_code} · ` : ''}{row.product_name}</td><td>{row.code}</td>
      <td>{brDate(row.expires_on)} <small className="real-help">{row.days_left < 0 ? `venceu há ${-row.days_left} dia(s)` : row.days_left === 0 ? 'vence hoje' : `em ${row.days_left} dia(s)`}</small></td>
      <td>{row.warehouse_name}</td><td className="numeric">{quantity(row.quantity)} {row.unit ?? ''}</td></tr>)}</tbody></table></div>;
}

/**
 * Lotes vencendo: lotes com saldo que vencem nos próximos N dias (N das Preferências dos lotes, "Número de dias antes da data de
 * validade", ou 30 quando a empresa não gravou) e, à parte, os já vencidos, com filtro por depósito e exportação CSV. O aviso do
 * início do ERP é HomeValidityAlert.
 */
export default function StockLotsExpiring({ role }: { role: string | undefined }) {
  const allowed = blockEnabled('erp-estoque') && reportsAvailable() && Boolean(role && LOT_ALERT_ROLES.includes(role));
  const [warehouse, setWarehouse] = useState(''), [days, setDays] = useState<string>(''), [view, setView] = useState<LotsExpiring | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setError(''); if (!allowed) { setView(null); return; } const control = new AbortController();
    void reportsGet<LotsExpiring>('/lotes-vencendo', { deposito: warehouse || null, dias: days || null }, control.signal)
      .then(value => { if (!control.signal.aborted) setView(value); }).catch(failure => { if (!aborted(failure)) setError(failureText(failure)); });
    return () => control.abort();
  }, [allowed, warehouse, days]);
  if (!allowed) return null;
  const csv = () => view && exportCsv(`lotes-vencendo-${view.today}`, ['Situação', 'Código do produto', 'Produto', 'Lote', 'Validade', 'Dias', 'Depósito', 'Saldo', 'Unidade'],
    [...view.expired.items.map(r => ['Vencido', r] as const), ...view.expiring.items.map(r => ['Vencendo', r] as const)].map(([label, r]) =>
      [t(label), t(r.product_code), t(r.product_name), t(r.code), t(r.expires_on), n(r.days_left), t(r.warehouse_name), n(r.quantity), t(r.unit)]));
  return <section className="lots-expiring report-screen" id="lotes-vencendo" aria-labelledby="lots-expiring-title">
    <h2 id="lots-expiring-title"><Icon name="triangle-exclamation" size={13} />Lotes vencendo</h2>
    <div className="report-filters">
      <label className="form-field">Depósito<select value={warehouse} onChange={event => setWarehouse(event.target.value)}><option value="">Todos (sem os de saldo desconsiderado)</option>
        {view?.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.ignored ? ' (saldo desconsiderado)' : ''}</option>)}</select></label>
      <label className="form-field">Vencem em até<select value={days} onChange={event => setDays(event.target.value)}><option value="">{view ? `${view.preference_days} dias (padrão)` : 'Padrão'}</option>
        {['7', '15', '30', '60', '90', '180'].map(d => <option key={d} value={d}>{d} dias</option>)}</select></label>
      <button type="button" className="secondary-button" disabled={!view} onClick={csv}><Icon name="file-lines" size={14} />Exportar CSV</button>
    </div>
    {view && <p className="real-help">{view.days_source === 'default' ? 'O padrão é 30 dias; para mudar, grave o "Número de dias antes da data de validade" em Preferências › Cadastros › Controle de lotes.' : view.days_source === 'preference' ? `Padrão de ${view.preference_days} dias, de Preferências › Cadastros › Controle de lotes.` : ''}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!view && !error && <p role="status">Carregando lotes…</p>}
    {view && <>
      <h3>Vencem até {brDate(view.until)} ({view.expiring.lots} lote(s))</h3>
      {view.expiring.items.length ? <LotTable rows={view.expiring.items} label="Lotes que vencem" /> : <p className="real-help">Nenhum lote com saldo vence no período.</p>}
      <h3>Já vencidos, com saldo ({view.expired.lots} lote(s))</h3>
      {view.expired.items.length ? <LotTable rows={view.expired.items} label="Lotes vencidos" /> : <p className="real-help">Nenhum lote vencido com saldo.</p>}
      {(view.expiring.total > view.expiring.items.length || view.expired.total > view.expired.items.length) && <p className="real-help">Mostrando os {view.limit} primeiros de cada lista. Filtre por depósito para ver o resto.</p>}
    </>}
  </section>;
}
