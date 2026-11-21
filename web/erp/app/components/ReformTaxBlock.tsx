import { useEffect, useMemo, useState } from 'react';
import { decimalMoney } from '../lib/real-access';
import { calculateReform, reformYearOf } from '../../../../src/erp/domains/fiscal/reform-calc.ts';
import { documentItemBases, formatRate, reformAvailable, reformErrorText, reformGet, REFORM_STATUS_TEXT, type ReformDocumentContext } from '../lib/reform';
import type { DocumentItemInput, DocumentTotals } from '../lib/real-documents-model';
import './fiscal-invoices.css';

/**
 * Reforma tributária nas propostas e pedidos de venda: IBS, CBS e IS de cada
 * item, em bloco próprio e só informativo (em 2026 não mudam o total a pagar).
 * A classificação vem do produto ou da natureza do cliente (a mesma da
 * estimativa de IPI e ST); o cálculo é o mesmo da NF-e (reform-calc.ts).
 * Fora do painel da área, ou sem a parte Fiscal, não aparece.
 */
export default function ReformTaxBlock({ kind, contactId, items, totals, date }: {
  kind: 'sales_orders' | 'sales_proposals'; contactId: string | null; items: readonly DocumentItemInput[]; totals: DocumentTotals | null; date?: string | null;
}) {
  const [context, setContext] = useState<ReformDocumentContext | null>(null);
  const [error, setError] = useState('');
  const productIds = useMemo(() => [...new Set(items.map(item => item.product_id).filter((id): id is string => !!id))].sort().join(','), [items]);
  useEffect(() => {
    if (!reformAvailable() || !productIds) { setContext(null); return; }
    const request = new AbortController();
    const timer = setTimeout(() => {
      reformGet<ReformDocumentContext>('/documento', { tipo: kind, contato: contactId, produtos: productIds }, request.signal)
        .then(value => { if (!request.signal.aborted) { setContext(value); setError(''); } })
        .catch(e => { if (!request.signal.aborted) { setContext(null); setError(reformErrorText(e)); } });
    }, 600);
    return () => { clearTimeout(timer); request.abort(); };
  }, [kind, contactId, productIds]);
  const result = useMemo(() => {
    if (!context || !totals || totals.items.length !== items.length) return null;
    const bases = documentItemBases(totals);
    const byId = new Map(context.products.map(p => [p.id, p]));
    const year = date ? reformYearOf(date) : context.year;
    return calculateReform(items.map((item, index) => {
      const product = item.product_id ? byId.get(item.product_id) : undefined;
      return { item_id: String(index), description: item.description, base: bases[index] ?? '0.00', classification: product?.classification ?? null, selective: product?.selective ?? null };
    }), { year, crt: context.crt, settings: context.settings });
  }, [context, totals, items, date]);
  if (!reformAvailable()) return null;
  if (error) return <section className="document-tax-estimate" aria-label="Reforma tributária"><p className="real-help">IBS, CBS e IS: {error}</p></section>;
  if (!result) return null;
  const noun = kind === 'sales_orders' ? 'do pedido' : 'da proposta';
  const anyValue = result.items.some(item => item.status === 'calculated' || item.status === 'exempt' || item.status === 'manual');
  return <section className="document-tax-estimate" aria-label="Reforma tributária: IBS, CBS e IS">
    <h3>Reforma tributária: IBS, CBS e IS ({result.year})</h3>
    {anyValue && <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Item</th><th>Classificação</th><th className="numeric">Base</th><th className="numeric">CBS</th><th className="numeric">IBS</th><th className="numeric">IS</th><th>Situação</th></tr></thead>
      <tbody>{result.items.map((item, index) => <tr key={index}>
        <td>{item.description ?? `Item ${index + 1}`}</td>
        <td>{item.cst ? `${item.cst} / ${item.cclasstrib}` : '—'}</td>
        <td className="numeric">{item.base ? decimalMoney(item.base) : '—'}</td>
        <td className="numeric">{item.cbs ? `${decimalMoney(item.cbs.value)} (${formatRate(item.cbs.effective_rate)})` : '—'}</td>
        <td className="numeric">{item.ibs && item.ibs_uf ? `${decimalMoney(item.ibs)} (${formatRate(item.ibs_uf.effective_rate)})` : '—'}</td>
        <td className="numeric">{item.selective ? decimalMoney(item.selective.value) : '—'}</td>
        <td>{REFORM_STATUS_TEXT[item.status]}</td>
      </tr>)}</tbody>
    </table></div>}
    <dl className="document-total-summary" aria-live="polite">
      <div><dt>CBS</dt><dd>{decimalMoney(result.totals.cbs)}</dd></div>
      <div><dt>IBS (estadual e municipal)</dt><dd>{decimalMoney(result.totals.ibs)}</dd></div>
      {result.rates.selective && <div><dt>Imposto Seletivo</dt><dd>{decimalMoney(result.totals.selective)}</dd></div>}
    </dl>
    <p className="real-help">
      {result.informative
        ? `Só informativo: em ${result.year} IBS e CBS vão na nota com alíquotas de teste (CBS ${formatRate(result.rates.cbs)} e IBS ${formatRate(result.rates.ibs_uf)}) e não mudam o total ${noun}.`
        : `Estimativa: o total ${noun} não soma IBS, CBS e IS nesta versão; confira o preço com o contador.`}
      {' '}A base é o valor dos itens com frete e despesas, sem descontar ICMS, PIS e COFINS (a nota desconta).
      {context?.nature?.description ? ` Classificação padrão pela natureza ${context.nature.description}.` : ''}
    </p>
    {result.notices.map(notice => <p key={notice.code} className="real-help">{notice.message}</p>)}
  </section>;
}
