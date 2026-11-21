import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { blockEnabled } from '../../blocks';
import { brDate, quantity, reportsAvailable, reportsGet, type LotsExpiring } from '../lib/erp-reports';
import { Icon } from './Icon';

/** Papéis que leem o estoque (erp_stock.require_access): só eles veem o alerta, e o servidor confere de novo. */
export const LOT_ALERT_ROLES = ['admin', 'consulta', 'estoque', 'vendas', 'fiscal'];

/**
 * Início do ERP: "Lotes vencendo" (lotes com saldo que vencem nos próximos N dias, das Preferências › Cadastros › Controle de
 * lotes ou 30, e os já vencidos). Some sem Estoque ligado, sem papel que leia o estoque ou sem lote para mostrar; o resto do início
 * continua funcionando se a consulta falhar. A lista completa, com filtro por depósito, fica na tela de estoque.
 */
export function HomeValidityAlert({ role }: { role: string | undefined }) {
  const allowed = blockEnabled('erp-estoque') && reportsAvailable() && Boolean(role && LOT_ALERT_ROLES.includes(role));
  const [view, setView] = useState<LotsExpiring | null>(null);
  useEffect(() => {
    setView(null); if (!allowed) return; const control = new AbortController();
    void reportsGet<LotsExpiring>('/lotes-vencendo', { }, control.signal).then(value => { if (!control.signal.aborted) setView(value); }).catch(() => { /* O aviso fica escondido. */ });
    return () => control.abort();
  }, [allowed, role]);
  if (!allowed || !view || view.expiring.total + view.expired.total === 0) return null;
  const rows = [...view.expired.items, ...view.expiring.items].slice(0, 5);
  return <section className="home-expiring" aria-labelledby="home-lots-title">
    <h2 id="home-lots-title"><Icon name="triangle-exclamation" size={13} />Lotes vencendo</h2>
    <p className="real-help">{view.expiring.lots} lote(s) vencem nos próximos {view.days} dia(s){view.expired.lots ? `; ${view.expired.lots} já venceram e ainda têm saldo` : ''}.</p>
    <div className="table-scroll" role="region" aria-label="Lotes vencendo" tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Produto</th><th scope="col">Lote</th><th scope="col">Validade</th><th scope="col">Depósito</th><th scope="col">Saldo</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.lot_id}:${row.warehouse_id}`}><td>{row.product_name}</td><td>{row.code}</td>
        <td>{brDate(row.expires_on)}{row.days_left < 0 && <> <span className="status-badge status-danger">Vencido</span></>}</td><td>{row.warehouse_name}</td><td>{quantity(row.quantity)} {row.unit ?? ''}</td></tr>)}</tbody></table></div>
    <Link to="/estoque-empresa#lotes-vencendo" className="text-button">Ver todos os lotes vencendo<Icon name="right" size={10} /></Link>
  </section>;
}
