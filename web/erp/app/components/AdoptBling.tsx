import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import {
  BLING_ADOPTION_LABELS,
  type BlingAdoptionEntity, type BlingAdoptionLink, type BlingAdoptionReview, type BlingAdoptionStatus, type BlingAdoptionSummary,
} from '../../../../src/erp/bling/adoption-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';

const JOB_LABELS = { idle: 'Nenhum lote pedido', running: 'Adotando em lote', paused: 'Pausado', done: 'Lote concluído' } as const;
const MODE_LABELS = { created: 'Cadastro criado a partir do Bling', linked: 'Ligado a um cadastro que já existia', updated: 'Cadastro existente atualizado com a do Bling' } as const;
const time = (value: string | null) => value === null ? '—' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const number = (value: number) => new Intl.NumberFormat('pt-BR').format(value);

/** Área "Adotar cadastros" da tela Receber dados do Bling: transforma o
 * coletado em cadastros do ERP, com revisão. Nada é enviado ao Bling. */
export function AdoptBling({ controller, administrator, client: injected }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [status, setStatus] = useState<BlingAdoptionStatus | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [chosen, setChosen] = useState<BlingAdoptionEntity[]>([]);
  const [view, setView] = useState<{ entity: BlingAdoptionEntity; kind: 'pending' | 'ignored' | 'links' } | null>(null);
  const [reviews, setReviews] = useState<{ items: BlingAdoptionReview[]; next_cursor: string | null } | null>(null);
  const [links, setLinks] = useState<{ items: BlingAdoptionLink[]; next_cursor: string | null } | null>(null);
  const alive = useRef(true), lock = useRef(false);
  const command = () => crypto.randomUUID();

  async function reload() {
    if (!client) return;
    const next = await client.execute('erp_bling_adoption_status', {});
    if (alive.current) setStatus(next);
    return next;
  }
  async function task(action: () => Promise<void>) {
    if (lock.current || !alive.current || !client) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { if (alive.current) setError(adoptionFailureText(caught)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(async () => { await reload(); });
    return () => { alive.current = false; };
  }, [client, administrator]);
  // Progresso na tela enquanto o lote roda no servidor.
  useEffect(() => {
    if (status?.job.state !== 'running' || !client) return;
    const timer = setInterval(() => { if (!lock.current) void reload().catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [status?.job.state, client]);

  async function open(entity: BlingAdoptionEntity, kind: 'pending' | 'ignored' | 'links', cursor?: string) {
    if (!client) return;
    setView({ entity, kind });
    if (kind === 'links') { const page = await client.execute('erp_bling_adoption_links', { entity, limit: 20, ...(cursor ? { cursor } : {}) }); if (alive.current) { setLinks(page); setReviews(null); } }
    else { const page = await client.execute('erp_bling_adoption_reviews', { entity, state: kind, limit: 20, ...(cursor ? { cursor } : {}) }); if (alive.current) { setReviews(page); setLinks(null); } }
  }
  async function refreshView() { await reload(); if (view) await open(view.entity, view.kind); }
  const resolve = (review: BlingAdoptionReview, action: 'use_bling' | 'keep_erp' | 'ignore', record_id?: string) => task(async () => {
    const result = await client!.execute('erp_bling_adoption_resolve', { command_id: command(), entity: review.entity, source_id: review.source_id, action, ...(record_id ? { record_id } : {}) });
    setNotice(result.outcome === 'ignored' ? 'Registro ignorado. Ele não será adotado no lote.' : result.outcome === 'linked' ? 'Ligado ao cadastro do ERP, sem mudar os dados dele.' : result.outcome === 'updated' ? 'Cadastro do ERP atualizado com a do Bling e ligado.' : 'Cadastro criado no ERP a partir da do Bling.');
    await refreshView();
  });

  if (!administrator) return <section className="rb-card" aria-label="Adotar cadastros"><h2>Adotar cadastros</h2><p>Adotar cadastros do Bling exige um administrador do ERP. Peça a um administrador para fazer a adoção.</p></section>;
  if (!client) return <section className="rb-card" aria-label="Adotar cadastros"><h2>Adotar cadastros</h2><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  const job = status?.job;
  const enabled = status?.entities.filter(item => item.enabled) ?? [];
  const blocked = busy || !status?.available;
  return <section aria-label="Adotar cadastros">
    <h2>Adotar cadastros</h2>
    <p className="rb-intro">Aqui o que foi coletado do Bling vira cadastro do ERP, passando pelas mesmas regras de quem cadastra à mão. Antes de criar, procuramos um cadastro que já exista para não duplicar. Nada é enviado ao Bling. Pedidos, notas, títulos, lançamentos e saldos ficam para uma próxima etapa.</p>
    <dl className="rb-metrics" aria-label="Estados de um registro">
      <div><dt>Coletado</dt><dd>Está no acervo e ainda não virou cadastro do ERP.</dd></div>
      <div><dt>Adotado</dt><dd>Virou cadastro do ERP e fica ligado ao registro do Bling.</dd></div>
      <div><dt>Pendente de revisão</dt><dd>Não deu para adotar sozinho (dado inválido ou parecido com outro cadastro). Você decide.</dd></div>
    </dl>
    <div role="status" aria-live="polite">{!status ? 'Carregando a adoção…' : `${JOB_LABELS[job!.state]}.`}{job && job.state !== 'idle' && ` Processados ${number(job.counts.processed)}: ${number(job.counts.adopted)} criados, ${number(job.counts.linked)} ligados, ${number(job.counts.pending)} pendentes. Última atualização: ${time(job.updated_at)}.`}{job?.current && job.state !== 'done' && ` Agora: ${BLING_ADOPTION_LABELS[job.current]}.`}{notice && <p>{notice}</p>}</div>
    {job?.stop && <p role="alert">O lote parou: {job.stop.message}</p>}
    {status && !status.available && <p role="alert">{status.unavailable_message}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="rb-scroll" role="region" aria-label="Adoção por entidade" tabIndex={0}><table><thead><tr><th>Adotar</th><th>Entidade</th><th>Coletados ainda não adotados</th><th>Adotados</th><th>Pendentes de revisão</th><th>Ignorados</th><th>Consultar</th></tr></thead><tbody>
      {status?.entities.map(item => <tr key={item.entity}>
        <td><input type="checkbox" id={`adopt-${item.entity}`} aria-label={`Incluir ${item.label} no lote`} disabled={blocked || !item.enabled || job?.state === 'running'} checked={chosen.includes(item.entity)} onChange={e => setChosen(previous => e.target.checked ? [...previous, item.entity] : previous.filter(entity => entity !== item.entity))} /></td>
        <td><label htmlFor={`adopt-${item.entity}`}>{item.label}</label>{!item.enabled && <p role="note">{item.part_off_message}</p>}</td>
        <td>{number(item.waiting)} de {number(item.collected)} coletados</td><td>{number(item.adopted)}</td><td>{number(item.pending)}</td><td>{number(item.ignored)}</td>
        <td><button type="button" disabled={busy || !item.pending} onClick={() => void task(() => open(item.entity, 'pending'))}>Ver pendências de {item.label}</button><button type="button" disabled={busy || !item.adopted} onClick={() => void task(() => open(item.entity, 'links'))}>Ver adotados de {item.label}</button><button type="button" disabled={busy || !item.ignored} onClick={() => void task(() => open(item.entity, 'ignored'))}>Ver ignorados de {item.label}</button></td>
      </tr>)}
    </tbody></table></div>
    <p>A adoção segue a ordem: categorias antes de produtos, contatos antes de vendedores. Roda em partes pequenas no servidor e pode ser pausada; um registro com problema vira pendência e não para o lote.</p>
    <div className="rb-actions">
      <button type="button" disabled={blocked || !chosen.length || job?.state === 'running' || chosen.some(entity => !enabled.some(item => item.entity === entity))} onClick={() => void task(async () => { const result = await client.execute('erp_bling_adoption_start', { command_id: command(), entities: chosen }); setStatus(previous => previous && { ...previous, job: result.job }); setNotice('Adoção em lote pedida. O progresso aparece aqui.'); await reload(); })}>Adotar em lote as entidades marcadas</button>
      <button type="button" disabled={busy || job?.state !== 'running'} onClick={() => void task(async () => { await client.execute('erp_bling_adoption_pause', { command_id: command() }); setNotice('Lote pausado. O que já foi adotado continua adotado.'); await reload(); })}>Pausar a adoção</button>
      <button type="button" disabled={blocked || job?.state !== 'paused' || !job.entities.length || job.entities.some(entity => !enabled.some(item => item.entity === entity))} onClick={() => void task(async () => { await client.execute('erp_bling_adoption_start', { command_id: command(), entities: job!.entities }); setNotice('Adoção retomada de onde parou.'); await reload(); })}>Retomar a adoção</button>
      <button type="button" disabled={busy} onClick={() => void task(refreshView)}>Atualizar a adoção</button>
    </div>
    {view && reviews && <section className="rb-card" aria-label={`${view.kind === 'pending' ? 'Pendências' : 'Ignorados'} de ${BLING_ADOPTION_LABELS[view.entity]}`}>
      <h3>{view.kind === 'pending' ? 'Pendentes de revisão' : 'Ignorados'}: {BLING_ADOPTION_LABELS[view.entity]}</h3>
      {!reviews.items.length && <p>Nada aqui agora.</p>}
      {reviews.items.map(review => <ReviewCard key={review.source_id} review={review} busy={busy} updatable={!!status?.entities.find(item => item.entity === review.entity)?.updatable} onResolve={(action, record) => void resolve(review, action, record)} />)}
      <button type="button" disabled={busy || !reviews.next_cursor} onClick={() => void task(() => open(view.entity, view.kind, reviews.next_cursor!))}>Próximas pendências</button>
    </section>}
    {view && links && <section className="rb-card" aria-label={`Adotados de ${BLING_ADOPTION_LABELS[view.entity]}`}>
      <h3>Adotados: {BLING_ADOPTION_LABELS[view.entity]}</h3>
      <p>Desligar do Bling só remove o vínculo. O cadastro do ERP continua como está e o lote não liga de novo sozinho.</p>
      <div className="rb-scroll" role="region" aria-label="Cadastros adotados" tabIndex={0}><table><thead><tr><th>No ERP</th><th>ID no Bling</th><th>Como foi adotado</th><th>Versão coletada</th><th>Quando</th><th>Ação</th></tr></thead><tbody>
        {links.items.map(link => <tr key={link.source_id}><td>{link.summary?.['Nome'] ?? 'Cadastro não encontrado no ERP'}</td><td>{link.source_id}</td><td>{MODE_LABELS[link.mode]}</td><td>{link.source_version}</td><td>{time(link.adopted_at)}</td>
          <td><button type="button" disabled={busy} onClick={() => void task(async () => { if (!window.confirm('Desligar este cadastro do Bling? O cadastro do ERP continua; só o vínculo sai.')) return; await client.execute('erp_bling_adoption_unlink', { command_id: command(), entity: link.entity, source_id: link.source_id }); setNotice('Vínculo removido. O cadastro do ERP continua.'); await refreshView(); })}>Desligar do Bling {link.source_id}</button></td></tr>)}
      </tbody></table></div>
      <button type="button" disabled={busy || !links.next_cursor} onClick={() => void task(() => open(view.entity, 'links', links.next_cursor!))}>Próximos adotados</button>
    </section>}
  </section>;
}

function ReviewCard({ review, busy, updatable, onResolve }: { review: BlingAdoptionReview; busy: boolean; updatable: boolean; onResolve(action: 'use_bling' | 'keep_erp' | 'ignore', record?: string): void }) {
  const keys = [...new Set([...Object.keys(review.bling ?? {}), ...review.erp.flatMap(candidate => Object.keys(candidate.summary))])];
  const cell = (summary: BlingAdoptionSummary | null, key: string) => summary?.[key] ?? '—';
  return <article className="rb-card">
    <h4>ID no Bling {review.source_id} · versão coletada {review.source_version}</h4>
    <p><strong>Motivo:</strong> {review.reason_text}{review.detail && ` ${review.detail}`}</p>
    {!review.bling && <p>Os dados deste registro não estão no acervo como registro próprio (por exemplo, uma variação de produto) ou ele saiu do acervo. Dá para ignorar ou ligar a um cadastro do ERP.</p>}
    <div className="rb-scroll" role="region" aria-label={`Comparação do registro ${review.source_id}`} tabIndex={0}><table><thead><tr><th>Campo</th><th>No Bling</th>{review.erp.map((candidate, index) => <th key={candidate.record_id}>No ERP {review.erp.length > 1 ? `(opção ${index + 1})` : ''}</th>)}</tr></thead><tbody>
      {keys.map(key => <tr key={key}><th scope="row">{key}</th><td>{cell(review.bling, key)}</td>{review.erp.map(candidate => <td key={candidate.record_id}>{cell(candidate.summary, key)}</td>)}</tr>)}
    </tbody></table></div>
    <div className="rb-actions">
      {review.erp.map((candidate, index) => <span key={candidate.record_id}>
        <button type="button" disabled={busy} onClick={() => onResolve('keep_erp', candidate.record_id)}>Manter a do ERP e ligar{review.erp.length > 1 ? ` (opção ${index + 1})` : ''}</button>
        {updatable && review.bling && <button type="button" disabled={busy} onClick={() => onResolve('use_bling', candidate.record_id)}>Usar a do Bling neste cadastro{review.erp.length > 1 ? ` (opção ${index + 1})` : ''}</button>}
      </span>)}
      {review.bling && <button type="button" disabled={busy} onClick={() => onResolve('use_bling')}>{review.erp.length ? 'Usar a do Bling num cadastro novo' : 'Usar a do Bling'}</button>}
      {review.state === 'pending' && <button type="button" disabled={busy} onClick={() => onResolve('ignore')}>Ignorar</button>}
    </div>
  </article>;
}
