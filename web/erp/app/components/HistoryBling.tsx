import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import {
  BLING_ADOPTION_B2_ENTITIES, BLING_ADOPTION_LABELS, BLING_ADOPTION_SINGULAR,
  type BlingAdoptionB2Entity, type BlingAdoptionHistoryDocument, type BlingAdoptionHistoryItem, type BlingAdoptionStatus,
} from '../../../../src/erp/bling/adoption-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';

const brl = (cents: string | null) => cents === null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents) / 100);
const day = (value: string | null) => value === null ? '—' : value.split('-').reverse().join('/');

/** Área "Histórico do Bling": propostas, pedidos e contas que já estão
 * encerrados no Bling, só para consulta. Não fatura, não cancela, não edita. */
export function HistoryBling({ controller, administrator, client: injected, entity: initial }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient; entity?: BlingAdoptionB2Entity }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [entity, setEntity] = useState<BlingAdoptionB2Entity>(initial ?? 'sales_orders');
  const [q, setQ] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [status, setStatus] = useState<BlingAdoptionStatus | null>(null);
  const [page, setPage] = useState<{ items: BlingAdoptionHistoryItem[]; next_cursor: string | null } | null>(null);
  const [opened, setOpened] = useState<BlingAdoptionHistoryDocument | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false);

  async function task(action: () => Promise<void>) {
    if (lock.current || !alive.current || !client) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (caught) { if (alive.current) setError(adoptionFailureText(caught)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(async () => { const next = await client.execute('erp_bling_adoption_status', {}); if (alive.current) setStatus(next); });
    return () => { alive.current = false; };
  }, [client, administrator]);
  useEffect(() => { if (initial) { setEntity(initial); setPage(null); setOpened(null); } }, [initial]);

  const info = status?.entities.find(item => item.entity === entity);
  async function search(cursor?: string) {
    const result = await client!.execute('erp_bling_adoption_history', { entity, limit: 20, ...(q.trim() ? { q: q.trim() } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}) });
    if (alive.current) { setPage(result); setOpened(null); }
  }
  async function open(item: BlingAdoptionHistoryItem) {
    const result = await client!.execute('erp_bling_adoption_history_get', { entity: item.entity, source_id: item.source_id });
    if (alive.current) setOpened(result);
  }

  if (!administrator) return <section className="rb-card" aria-label="Histórico do Bling"><h2>Histórico do Bling</h2><p>Consultar o histórico do Bling exige um administrador do ERP. Peça a um administrador.</p></section>;
  if (!client) return <section className="rb-card" aria-label="Histórico do Bling"><h2>Histórico do Bling</h2><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  const off = info && !info.enabled;
  return <section aria-label="Histórico do Bling">
    <h2>Histórico do Bling</h2>
    <p className="rb-intro">Aqui ficam as propostas, os pedidos e as contas que já estão encerrados no Bling (atendidos, cancelados, faturados, pagos ou com baixa parcial). Eles ficam só para consulta: não viram documento do ERP e não podem ser faturados, cancelados nem editados. O que ainda está em aberto no Bling é adotado na aba Adotar cadastros e passa a ser operado pelo ERP.</p>
    <form className="rb-filters" onSubmit={event => { event.preventDefault(); void task(() => search()); }}>
      <label htmlFor="bling-history-entity">O que consultar</label>
      <select id="bling-history-entity" value={entity} disabled={busy} onChange={e => { setEntity(e.target.value as BlingAdoptionB2Entity); setPage(null); setOpened(null); }}>
        {BLING_ADOPTION_B2_ENTITIES.map(key => <option key={key} value={key}>{BLING_ADOPTION_LABELS[key]}</option>)}
      </select>
      <label htmlFor="bling-history-q">Número ou nome do contato</label><input id="bling-history-q" value={q} maxLength={80} disabled={busy} onChange={e => setQ(e.target.value)} />
      <label htmlFor="bling-history-from">De</label><input id="bling-history-from" type="date" value={from} disabled={busy} onChange={e => setFrom(e.target.value)} />
      <label htmlFor="bling-history-to">Até</label><input id="bling-history-to" type="date" value={to} disabled={busy} onChange={e => setTo(e.target.value)} />
      <button type="submit" disabled={busy || !!off || (!!from && !!to && from > to)}>Buscar no histórico</button>
    </form>
    {off && <p role="note">{info!.part_off_message}</p>}
    {!!from && !!to && from > to && <p role="alert">A data inicial precisa vir antes da final.</p>}
    {error && <p role="alert">{error}</p>}
    {page && <>
      <p role="status">{page.items.length ? `${page.items.length} registro(s) nesta página. Já encerrado no Bling (só consulta).` : 'Nada encontrado com esses filtros. Confira o número, o nome ou o período.'}</p>
      {page.items.length > 0 && <div className="rb-scroll" role="region" aria-label="Registros do histórico do Bling" tabIndex={0}><table><thead><tr><th>Número</th><th>Contato</th><th>{entity === 'receivables' || entity === 'payables' ? 'Vencimento' : 'Data'}</th><th>Situação no Bling</th><th>Por que está aqui</th><th>Total</th><th>Consultar</th></tr></thead><tbody>
        {page.items.map(item => <tr key={item.source_id}><td>{item.number ?? '—'}</td><td>{item.contact_name ?? '—'}</td><td>{day(item.issued_on)}</td><td>{item.situation ?? '—'}</td><td>{item.scope_text}</td><td>{brl(item.total_cents)}</td>
          <td><button type="button" disabled={busy} onClick={() => void task(() => open(item))}>Abrir {BLING_ADOPTION_SINGULAR[item.entity]} {item.number ?? item.source_id}</button></td></tr>)}
      </tbody></table></div>}
      <button type="button" disabled={busy || !page.next_cursor} onClick={() => void task(() => search(page.next_cursor!))}>Próxima página do histórico</button>
    </>}
    {opened && <article className="rb-card" aria-label="Documento do histórico do Bling">
      <h3>{BLING_ADOPTION_SINGULAR[opened.item.entity]} nº {opened.item.number ?? '—'} · já encerrado no Bling (só consulta)</h3>
      <p role="note"><strong>{opened.read_only_message}</strong></p>
      <dl className="rb-metrics">{Object.entries(opened.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
      {opened.lines.length > 0 && <div className="rb-scroll" role="region" aria-label="Itens como vieram do Bling" tabIndex={0}><table><thead><tr><th>Descrição</th><th>Código</th><th>Quantidade</th><th>Valor unitário</th><th>Total</th></tr></thead><tbody>
        {opened.lines.map((line, index) => <tr key={index}><td>{line.description ?? '—'}</td><td>{line.code ?? '—'}</td><td>{line.quantity ?? '—'}</td><td>{line.unit_price ?? '—'}</td><td>{line.total ?? '—'}</td></tr>)}
      </tbody></table></div>}
      {opened.installments.length > 0 && <div className="rb-scroll" role="region" aria-label="Parcelas como vieram do Bling" tabIndex={0}><table><thead><tr><th>Vencimento</th><th>Valor</th><th>Forma de pagamento</th><th>Observação</th></tr></thead><tbody>
        {opened.installments.map((part, index) => <tr key={index}><td>{day(part.due_on)}</td><td>{part.amount ?? '—'}</td><td>{part.method ?? '—'}</td><td>{part.note ?? '—'}</td></tr>)}
      </tbody></table></div>}
      <details><summary>Registro como veio do Bling</summary><pre>{opened.payload_text}</pre></details>
      <button type="button" onClick={() => setOpened(null)}>Fechar documento do histórico</button>
    </article>}
  </section>;
}
