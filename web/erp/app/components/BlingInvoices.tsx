import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { BlingAdoptionOperationMap } from '../../../../src/erp/bling/adoption-contracts';
import type { BlingCutoverInvoice } from '../../../../src/erp/bling/cutover-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';
import { brDay, brl, saveFile } from './cutover-bling-client';
import './receive-bling.css';

type Page = BlingAdoptionOperationMap['erp_bling_cutover_invoices']['output'];
type Opened = BlingAdoptionOperationMap['erp_bling_cutover_invoice_get']['output'];
const MODEL = { nfe: 'NF-e', nfce: 'NFC-e' } as const;

/** Fiscal → Notas emitidas no Bling: o acervo fiscal do período antigo, só
 * consulta. Nada vira emissão nova pelo cofre; não cancela nem corrige. */
export function BlingInvoices({ controller, administrator, client: injected }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [entity, setEntity] = useState<'' | 'nfe' | 'nfce'>(''), [q, setQ] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [page, setPage] = useState<Page | null>(null), [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false);

  async function task(action: () => Promise<void>) {
    if (lock.current || !alive.current || !client) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (caught) { if (alive.current) setError(adoptionFailureText(caught)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function search(cursor?: string) {
    const result = await client!.execute('erp_bling_cutover_invoices', { limit: 20, ...(entity ? { entity } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}) });
    if (alive.current) { setPage(result); setOpened(null); }
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(() => search());
    return () => { alive.current = false; };
  }, [client, administrator]);
  const open = (item: BlingCutoverInvoice) => task(async () => {
    const result = await client!.execute('erp_bling_cutover_invoice_get', { entity: item.entity, source_id: item.source_id });
    if (alive.current) setOpened(result);
  });

  if (!administrator) return <section className="real-state-panel" aria-label="Notas emitidas no Bling"><h1>Notas emitidas no Bling</h1><p>Consultar as notas emitidas no Bling exige um administrador do ERP. Peça a um administrador.</p></section>;
  if (!client) return <section className="real-state-panel" aria-label="Notas emitidas no Bling"><h1>Notas emitidas no Bling</h1><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  return <section className="receive-bling" aria-label="Notas emitidas no Bling">
    <h1>Notas emitidas no Bling</h1>
    <p className="rb-intro"><strong>{page?.read_only_message ?? 'Notas emitidas no Bling (só consulta). Elas não viram emissão nova, não podem ser canceladas nem corrigidas por aqui.'}</strong></p>
    <form className="rb-filters" onSubmit={event => { event.preventDefault(); void task(() => search()); }}>
      <label htmlFor="bling-invoices-model">Modelo</label>
      <select id="bling-invoices-model" value={entity} disabled={busy} onChange={e => setEntity(e.target.value as '' | 'nfe' | 'nfce')}><option value="">NF-e e NFC-e</option><option value="nfe">NF-e</option><option value="nfce">NFC-e</option></select>
      <label htmlFor="bling-invoices-q">Número, chave de acesso ou destinatário</label><input id="bling-invoices-q" value={q} maxLength={80} disabled={busy} onChange={e => setQ(e.target.value)} />
      <label htmlFor="bling-invoices-from">De</label><input id="bling-invoices-from" type="date" value={from} disabled={busy} onChange={e => setFrom(e.target.value)} />
      <label htmlFor="bling-invoices-to">Até</label><input id="bling-invoices-to" type="date" value={to} disabled={busy} onChange={e => setTo(e.target.value)} />
      <button type="submit" disabled={busy || (!!from && !!to && from > to)}>Buscar notas</button>
    </form>
    {!!from && !!to && from > to && <p role="alert">A data inicial precisa vir antes da final.</p>}
    {error && <p role="alert">{error}</p>}
    {page && <>
      <p role="status">{page.items.length ? `${page.items.length} nota(s) nesta página.` : 'Nenhuma nota encontrada com esses filtros. Confira o número, a chave ou o período.'}</p>
      {page.items.length > 0 && <div className="rb-scroll" role="region" aria-label="Notas emitidas no Bling" tabIndex={0}><table><thead><tr><th>Modelo</th><th>Número</th><th>Série</th><th>Emissão</th><th>Destinatário</th><th>Chave de acesso</th><th>Valor</th><th>Situação no Bling</th><th>XML</th><th>Consultar</th></tr></thead><tbody>
        {page.items.map(item => <tr key={`${item.entity}-${item.source_id}`}><td>{MODEL[item.entity]}</td><td>{item.number ?? '—'}</td><td>{item.series ?? '—'}</td><td>{brDay(item.issued_on)}</td><td>{item.contact_name ?? '—'}</td><td className="rb-key">{item.access_key ?? '—'}</td><td>{brl(item.total_cents)}</td><td>{item.situation ?? '—'}</td><td>{item.has_xml ? 'Guardado' : 'Não coletado'}</td>
          <td><button type="button" disabled={busy} onClick={() => void open(item)}>Abrir {MODEL[item.entity]} {item.number ?? item.source_id}</button></td></tr>)}
      </tbody></table></div>}
      <button type="button" disabled={busy || !page.next_cursor} onClick={() => void task(() => search(page.next_cursor!))}>Próxima página de notas</button>
    </>}
    {opened && <article className="rb-card" aria-label="Nota emitida no Bling">
      <h2>{MODEL[opened.item.entity]} nº {opened.item.number ?? '—'} · emitida no Bling (só consulta)</h2>
      <p role="note"><strong>{opened.read_only_message}</strong></p>
      <dl className="rb-metrics">{Object.entries(opened.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
      {opened.xml.available && opened.xml.text ? <>
        <button type="button" onClick={() => saveFile(new Blob([opened.xml.text!], { type: 'application/xml' }), opened.xml.filename ?? 'nota.xml')}>Baixar XML</button>
        <details><summary>Ver XML</summary><pre>{opened.xml.text}</pre></details>
      </> : <p role="note">{opened.xml.note}</p>}
      <button type="button" onClick={() => setOpened(null)}>Fechar nota</button>
    </article>}
  </section>;
}
