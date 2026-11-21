import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { BlingAdoptionOperationMap } from '../../../../src/erp/bling/adoption-contracts';
import type { BlingExtrasBatchEntity, BlingExtrasContractDraft, BlingExtrasPreviewItem, BlingExtrasReview, BlingExtrasStatus, BlingExtrasTwoWayEntity } from '../../../../src/erp/bling/extras-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';

type Out<K extends keyof BlingAdoptionOperationMap> = BlingAdoptionOperationMap[K]['output'];
type Options = Out<'erp_bling_extras_contract_options'>;
const time = (value: string | null) => value === null ? '—' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const day = (value: string | null) => value ? value.split('-').reverse().join('/') : '—';
const DIRECTION = { inbound: 'Receber do Bling', outbound: 'Escrever no Bling' } as const;
const BATCH: BlingExtrasBatchEntity[] = ['custom_fields', 'custom_field_values', 'price_lists', 'product_suppliers', 'product_lots', 'operation_natures'];
const PERIOD = { month: 'Mensal', quarter: 'Trimestral', year: 'Anual' } as const;
const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

function SideBySide({ bling, erp, label }: { bling: Record<string, string | null> | null; erp: Record<string, string | null> | null; label: string }) {
  const keys = [...new Set([...Object.keys(bling ?? {}), ...Object.keys(erp ?? {})])];
  if (!keys.length) return null;
  return <div className="rb-scroll" role="region" aria-label={label} tabIndex={0}><table>
    <thead><tr><th>Campo</th><th>No Bling</th><th>No ERP</th></tr></thead>
    <tbody>{keys.map(key => <tr key={key}><th scope="row">{key}</th><td>{bling?.[key] ?? '—'}</td><td>{erp ? erp[key] ?? '—' : 'Não existe ainda'}</td></tr>)}</tbody>
  </table></div>;
}

/** Aba "Outros dados" da tela Receber dados do Bling (fatia D): listas de
 * preços, naturezas, campos customizados, fornecedores e lotes de produto,
 * contratos e NFS-e. Prévia antes de adotar; pendências com os dois lados;
 * contrato vira contrato de manutenção depois de conferido; NFS-e só consulta;
 * mão dupla das listas e dos campos com interruptores desligados. */
export function ExtrasBling({ controller, administrator, client: injected, onCutover, onAdopt }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient; onCutover?(): void; onAdopt?(): void }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [status, setStatus] = useState<BlingExtrasStatus | null>(null);
  const [entity, setEntity] = useState<BlingExtrasBatchEntity>('custom_fields');
  const [preview, setPreview] = useState<Out<'erp_bling_extras_preview'> | null>(null);
  const [reviews, setReviews] = useState<BlingExtrasReview[] | null>(null);
  const [contracts, setContracts] = useState<BlingExtrasContractDraft[] | null>(null);
  const [preparing, setPreparing] = useState<Options | null>(null);
  const [form, setForm] = useState({ contact_id: '', plan_id: '', visits: '1', period: 'month' as 'month' | 'quarter' | 'year', q: '' });
  const [invoices, setInvoices] = useState<Out<'erp_bling_extras_invoices'> | null>(null), [search, setSearch] = useState('');
  const [outbox, setOutbox] = useState<Out<'erp_bling_extras_outbox'> | null>(null);
  const [asking, setAsking] = useState<{ entity: BlingExtrasTwoWayEntity; direction: 'inbound' | 'outbound' } | null>(null), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), lock = useRef(false);
  const command = () => crypto.randomUUID();

  async function task(action: () => Promise<void>) {
    if (lock.current || !alive.current || !client) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { if (alive.current) setError(adoptionFailureText(caught)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function reload() {
    const [s, o] = await Promise.all([client!.execute('erp_bling_extras_status', {}), client!.execute('erp_bling_extras_outbox', { limit: 20 })]);
    if (alive.current) { setStatus(s); setOutbox(o); }
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(reload);
    return () => { alive.current = false; };
  }, [client, administrator]);

  if (!administrator) return <section className="rb-card" aria-label="Outros dados do Bling"><h2>Outros dados do Bling</h2><p>A adoção dos outros dados do Bling é feita por um administrador do ERP. Peça a um administrador.</p></section>;
  if (!client) return <section className="rb-card" aria-label="Outros dados do Bling"><h2>Outros dados do Bling</h2><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  const texts = status?.texts ?? {};
  const row = (key: string) => status?.entities.find(item => item.entity === key);
  const current = row(entity);

  const loadPreview = (next = entity) => task(async () => {
    const [p, r] = await Promise.all([client.execute('erp_bling_extras_preview', { entity: next, limit: 25 }), client.execute('erp_bling_extras_reviews', { entity: next, limit: 25 })]);
    if (alive.current) { setPreview(p); setReviews(r.items); }
  });
  const adopt = (onlyConferred: boolean) => task(async () => {
    const ids = onlyConferred ? (preview?.items ?? []).filter(item => item.outcome === 'create' || item.outcome === 'link').map(item => item.source_id).slice(0, 25) : undefined;
    if (onlyConferred && !ids?.length) { setNotice('Nada para adotar nesta página da prévia.'); return; }
    const result = await client.execute('erp_bling_extras_adopt', { command_id: command(), entity, ...(ids ? { source_ids: ids } : {}) });
    const c = result.counts;
    setNotice(`Adotados: ${c.adopted}; ligados ao que já existia: ${c.linked}; pendentes: ${c.pending}; já vistos: ${c.skipped}.${result.more ? ' Ainda há mais: peça de novo.' : ''} ${result.messages.join(' ')}`.trim());
    const [p, r] = await Promise.all([client.execute('erp_bling_extras_preview', { entity, limit: 25 }), client.execute('erp_bling_extras_reviews', { entity, limit: 25 })]);
    setPreview(p); setReviews(r.items); await reload();
  });
  const resolve = (review: BlingExtrasReview, action: 'use_bling' | 'keep_erp' | 'ignore', record?: string) => task(async () => {
    const result = await client.execute('erp_bling_extras_resolve', { command_id: command(), entity: review.entity as BlingExtrasBatchEntity, source_id: review.source_id, action, ...(record ? { record_id: record } : {}) });
    setNotice(result.outcome === 'ignored' ? 'Registro ignorado.' : result.outcome === 'linked' ? 'Ligado ao registro do ERP.' : result.outcome === 'updated' ? 'Atualizado com a versão do Bling.' : 'Adotado.');
    setReviews((await client.execute('erp_bling_extras_reviews', { entity, limit: 25 })).items); await reload();
  });
  const loadContracts = () => task(async () => { const list = await client.execute('erp_bling_extras_contracts', { limit: 50 }); if (alive.current) setContracts(list.items); });
  const prepare = (draft: BlingExtrasContractDraft, q?: string) => task(async () => {
    const options = await client.execute('erp_bling_extras_contract_options', { source_id: draft.source_id, ...(q ? { q } : {}) });
    if (!alive.current) return;
    setPreparing(options);
    setForm(old => ({ ...old, contact_id: options.contacts.length === 1 ? options.contacts[0].id : old.contact_id, period: options.draft.period ?? old.period, q: q ?? old.q }));
  });
  const create = () => task(async () => {
    if (!preparing) return;
    const visits = Number(form.visits);
    if (!Number.isInteger(visits) || visits < 1 || visits > 999) { setError('Visitas por período: um número inteiro de 1 a 999.'); return; }
    const result = await client.execute('erp_bling_extras_contract_create', { command_id: command(), source_id: preparing.draft.source_id, version: preparing.draft.version,
      contact_id: form.contact_id, plan_id: form.plan_id, visits_per_period: visits, period: form.period });
    setNotice(result.message); setPreparing(null);
    setContracts((await client.execute('erp_bling_extras_contracts', { limit: 50 })).items); await reload();
  });
  const loadInvoices = () => task(async () => { const list = await client.execute('erp_bling_extras_invoices', { limit: 50, ...(search.trim() ? { q: search.trim() } : {}) }); if (alive.current) setInvoices(list); });
  const flip = (target: BlingExtrasTwoWayEntity, direction: 'inbound' | 'outbound', enabled: boolean) => {
    if (enabled) { setAsking({ entity: target, direction }); setAck(false); return; }
    void task(async () => { await client.execute('erp_bling_extras_switch', { command_id: command(), entity: target, direction, enabled: false }); setNotice(`Desligado: ${DIRECTION[direction]}.`); await reload(); });
  };
  const turnOn = () => task(async () => {
    if (!asking) return;
    await client.execute('erp_bling_extras_switch', { command_id: command(), entity: asking.entity, direction: asking.direction, enabled: true, acknowledged: true });
    setNotice(`Ligado: ${DIRECTION[asking.direction]}. Ficou registrado com seu nome e a hora.`); setAsking(null); setAck(false); await reload();
  });
  const outboxAction = (id: string, action: 'confirm_sent' | 'resend' | 'discard') => task(async () => {
    const result = await client.execute('erp_bling_extras_outbox_resolve', { command_id: command(), id, action });
    setNotice(result.message); await reload();
  });
  const outcomeClass = (item: BlingExtrasPreviewItem) => item.outcome === 'pending' ? 'rb-warning' : undefined;

  return <section className="rb-card" aria-label="Outros dados do Bling" aria-busy={busy}>
    <h2>Outros dados do Bling</h2>
    <p>{texts.intro}</p>
    <p className="rb-intro">{texts.collect}</p>
    <div role="status" aria-live="polite">{notice}</div>
    {error && <p role="alert">{error}</p>}
    {status && !status.available && <p role="alert">{status.unavailable_message}</p>}

    <h3>O que foi coletado</h3>
    <div className="rb-scroll" role="region" aria-label="Outros dados coletados" tabIndex={0}><table>
      <thead><tr><th>Tipo de registro</th><th>Coletados</th><th>Adotados</th><th>Pendentes</th><th>Ignorados</th><th>Aguardando</th><th>Caminho no Bling (não confirmado)</th></tr></thead>
      <tbody>{status?.entities.map(item => <tr key={item.entity}>
        <td>{item.label}{item.part_off_message && <><br /><small role="note">{item.part_off_message}</small></>}</td>
        <td>{item.collected}</td><td>{item.adopted}</td><td>{item.pending}</td><td>{item.ignored}</td><td>{item.waiting}</td>
        <td><code>{item.proposed_path}</code><br /><small>{item.doubt}</small></td>
      </tr>)}</tbody>
    </table></div>
    {onAdopt && <p>Produtos, contatos e depósitos usados aqui precisam estar adotados antes, em <button type="button" onClick={onAdopt}>Adotar cadastros</button>.</p>}

    <h3>Prévia e adoção</h3>
    <label htmlFor="extras-entity">Tipo de registro</label>
    <select id="extras-entity" value={entity} disabled={busy} onChange={event => { const next = event.target.value as BlingExtrasBatchEntity; setEntity(next); setPreview(null); setReviews(null); }}>
      {BATCH.map(key => <option key={key} value={key} disabled={row(key) ? !row(key)!.enabled : false}>{row(key)?.label ?? key}</option>)}
    </select>
    {current?.part_off_message && <p role="note">{current.part_off_message}</p>}
    {entity === 'operation_natures' && <p>{texts.natures}</p>}
    {entity === 'product_lots' && <p>{texts.lots}{!status?.cutover_on && onCutover && <> <button type="button" onClick={onCutover}>Confirmar a data de corte</button></>}</p>}
    {entity === 'product_suppliers' && <p>{texts.suppliers}</p>}
    <button type="button" disabled={busy || !current?.enabled || !status?.available} onClick={() => void loadPreview()}>Ver a prévia</button>
    {preview && <>
      <p>{preview.notice}</p>
      {!preview.items.length && <p>Nada coletado deste tipo ainda.</p>}
      {preview.items.map(item => <article key={item.source_id} className={outcomeClass(item) ?? 'rb-card'} aria-label={`Prévia: ${item.label}`}>
        <h4>{item.label} — {item.outcome_text}</h4>
        {item.reason_text && <p>{item.reason_text}</p>}
        <SideBySide bling={item.bling} erp={item.erp} label={`Bling e ERP: ${item.label}`} />
      </article>)}
      <button type="button" disabled={busy || !preview.items.some(item => item.outcome === 'create' || item.outcome === 'link')} onClick={() => void adopt(true)}>Adotar os conferidos nesta prévia</button>
      <button type="button" disabled={busy} onClick={() => void adopt(false)}>Adotar o próximo pedaço (até 25)</button>
    </>}
    {reviews && <>
      <h4>Pendências de revisão</h4>
      {!reviews.length && <p>Nenhuma pendência deste tipo.</p>}
      {reviews.map(review => <article key={review.source_id} className="rb-card" aria-label={`Pendência: ${review.source_id}`}>
        <p><strong>{review.reason_text}</strong>{review.detail ? ` ${review.detail}` : ''}</p>
        <SideBySide bling={review.bling} erp={review.erp[0]?.summary ?? null} label={`Pendência ${review.source_id}`} />
        <button type="button" disabled={busy} onClick={() => void resolve(review, 'use_bling')}>Usar a do Bling</button>
        {review.erp.map(candidate => <button key={candidate.record_id} type="button" disabled={busy} onClick={() => void resolve(review, 'keep_erp', candidate.record_id)}>Manter a do ERP e ligar</button>)}
        <button type="button" disabled={busy} onClick={() => void resolve(review, 'ignore')}>Ignorar</button>
      </article>)}
    </>}

    <h3>Contratos</h3>
    <p>{texts.contracts}</p>
    <button type="button" disabled={busy || !status?.available} onClick={() => void loadContracts()}>Ver os contratos coletados</button>
    {contracts && !contracts.length && <p>Nenhum contrato coletado.</p>}
    {contracts?.map(draft => <article key={draft.source_id} className="rb-card" aria-label={`Contrato ${draft.number ?? draft.source_id}`}>
      <h4>Contrato {draft.number ?? draft.source_id}{draft.description ? ` — ${draft.description}` : ''}</h4>
      <ul>
        <li>Cliente: {draft.customer.name ?? '—'}{draft.customer.phone ? ` · ${draft.customer.phone}` : ''}</li>
        <li>Vigência: {day(draft.starts_on)} a {draft.ends_on ? day(draft.ends_on) : 'sem data final'}</li>
        <li>Valor no Bling: {draft.value ?? '—'} · Periodicidade: {draft.periodicity ?? '—'}</li>
        <li>Situação no Bling: {draft.situation ?? '—'}</li>
      </ul>
      {draft.problems.length > 0 && <ul className="rb-warning">{draft.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {draft.link ? <p>Já virou contrato de manutenção {draft.link.number ?? ''} em {time(draft.link.linked_at)}.</p>
        : <button type="button" disabled={busy} onClick={() => void prepare(draft)}>Conferir e preparar o contrato de manutenção</button>}
    </article>)}
    {preparing && <aside className="rb-warning" role="dialog" aria-label="Criar contrato de manutenção">
      <h4>Contrato de manutenção a partir do contrato {preparing.draft.number ?? preparing.draft.source_id}</h4>
      {preparing.missing ? <p role="alert">{preparing.missing}</p> : <>
        <p>O valor e a periodicidade da cobrança vêm do plano da Mensalidade escolhido. A cobrança recorrente nasce desligada: ligue na tela do contrato quando quiser cobrar.</p>
        <label htmlFor="extras-plan">Plano da Mensalidade</label>
        <select id="extras-plan" value={form.plan_id} onChange={event => setForm({ ...form, plan_id: event.target.value })}>
          <option value="">Escolha o plano</option>
          {preparing.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} — {money(plan.amount_cents)} {plan.period_label}</option>)}
        </select>
        {!preparing.plans.length && <p role="note">Nenhum plano ativo na Mensalidade. Crie o plano lá e volte aqui.</p>}
        <label htmlFor="extras-contact-search">Buscar o cliente no atendimento (nome ou telefone)</label>
        <input id="extras-contact-search" value={form.q} onChange={event => setForm({ ...form, q: event.target.value })} />
        <button type="button" disabled={busy || !form.q.trim()} onClick={() => void prepare(preparing.draft, form.q.trim())}>Buscar</button>
        <label htmlFor="extras-contact">Cliente</label>
        <select id="extras-contact" value={form.contact_id} onChange={event => setForm({ ...form, contact_id: event.target.value })}>
          <option value="">Escolha o cliente</option>
          {preparing.contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}{contact.phone ? ` · ${contact.phone}` : ''}</option>)}
        </select>
        {!preparing.contacts.length && <p role="note">Nenhum cliente do atendimento com esse nome ou telefone. Cadastre o cliente em Contatos e busque de novo.</p>}
        <label htmlFor="extras-visits">Visitas cobertas por período</label>
        <input id="extras-visits" type="number" min={1} max={999} value={form.visits} onChange={event => setForm({ ...form, visits: event.target.value })} />
        <label htmlFor="extras-period">Período</label>
        <select id="extras-period" value={form.period} onChange={event => setForm({ ...form, period: event.target.value as 'month' | 'quarter' | 'year' })}>
          {(Object.keys(PERIOD) as (keyof typeof PERIOD)[]).map(key => <option key={key} value={key}>{PERIOD[key]}</option>)}
        </select>
        <button type="button" disabled={busy || !form.plan_id || !form.contact_id} onClick={() => void create()}>Criar o contrato de manutenção</button>
      </>}
      <button type="button" disabled={busy} onClick={() => setPreparing(null)}>Cancelar</button>
    </aside>}

    <h3>Notas de serviço (NFS-e)</h3>
    <p>{texts.invoices}</p>
    {row('service_invoices')?.part_off_message && <p role="note">{row('service_invoices')!.part_off_message}</p>}
    <label htmlFor="extras-invoice-search">Número ou tomador</label>
    <input id="extras-invoice-search" value={search} onChange={event => setSearch(event.target.value)} />
    <button type="button" disabled={busy || !row('service_invoices')?.enabled} onClick={() => void loadInvoices()}>Consultar</button>
    {invoices && <>
      <p>{invoices.read_only_message}</p>
      {!invoices.items.length && <p>Nenhuma nota de serviço encontrada.</p>}
      {invoices.items.length > 0 && <div className="rb-scroll" role="region" aria-label="Notas de serviço do Bling" tabIndex={0}><table>
        <thead><tr><th>Número</th><th>Série</th><th>Emissão</th><th>Tomador</th><th>Valor</th><th>Situação</th></tr></thead>
        <tbody>{invoices.items.map(item => <tr key={item.source_id}><td>{item.number ?? '—'}</td><td>{item.series ?? '—'}</td><td>{day(item.issued_on)}</td><td>{item.customer ?? '—'}</td><td>{item.total ?? '—'}</td><td>{item.situation ?? '—'}</td></tr>)}</tbody>
      </table></div>}
    </>}

    <h3>Mão dupla das listas e dos campos</h3>
    <p>{texts.two_way}</p>
    {!status?.cutover_on && <aside className="rb-warning" role="note"><p>A mão dupla só funciona depois do corte.</p>{onCutover && <button type="button" onClick={onCutover}>Ir para Passar a operar aqui</button>}</aside>}
    <div className="rb-scroll" role="region" aria-label="Interruptores das listas e dos campos" tabIndex={0}><table>
      <thead><tr><th>Tipo de registro</th><th>{DIRECTION.inbound}</th><th>{DIRECTION.outbound}</th><th>Na fila</th></tr></thead>
      <tbody>{status?.two_way.map(item => <tr key={item.entity}>
        <td>{item.label}{item.part_off_message && <><br /><small role="note">{item.part_off_message}</small></>}</td>
        {(['inbound', 'outbound'] as const).map(direction => <td key={direction}><label>
          <input id={`extras-${direction}-${item.entity}`} type="checkbox" checked={item[direction].enabled} disabled={busy || !status?.cutover_on || (!item.enabled && !item[direction].enabled)} onChange={event => flip(item.entity, direction, event.target.checked)} />
          {item[direction].enabled ? `Ligado desde ${time(item[direction].since)}` : 'Desligado'}</label></td>)}
        <td>{item.queued}{item.uncertain ? ` (${item.uncertain} sem confirmação)` : ''}{item.failed ? `, ${item.failed} recusado(s)` : ''}</td>
      </tr>)}</tbody>
    </table></div>
    {asking && <aside className="rb-warning" role="alertdialog" aria-label="Confirmar ligar">
      <p><strong>Ligar {DIRECTION[asking.direction]}</strong></p>
      <p>{asking.direction === 'outbound' ? texts.switch_warning_outbound : texts.switch_warning_inbound}</p>
      <label><input id="extras-ack" type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />Entendi e quero ligar</label>
      <button type="button" disabled={busy || !ack} onClick={() => void turnOn()}>Ligar</button>
      <button type="button" disabled={busy} onClick={() => { setAsking(null); setAck(false); }}>Cancelar</button>
    </aside>}
    <h4>Fila de saída</h4>
    {outbox && !outbox.items.length && <p>Nada na fila para o Bling.</p>}
    {outbox?.items.map(item => <article key={item.id} className="rb-card" aria-label={`Envio: ${item.label}`}>
      <p><strong>{item.label}</strong> — {item.state_text}{item.attempts ? ` (${item.attempts} tentativa(s))` : ''}</p>
      {item.error_text && <p>{item.error_text}</p>}
      {item.actions.map(action => <button key={action.action} type="button" disabled={busy} onClick={() => void outboxAction(item.id, action.action)}>{action.label}</button>)}
    </article>)}
    <button type="button" disabled={busy} onClick={() => void task(reload)}>Atualizar</button>
    {status && status.audit.length > 0 && <><h4>Quem ligou ou desligou</h4><ul>{status.audit.map((entry, index) => <li key={`${entry.at}-${index}`}>{time(entry.at)} — {entry.by}: {entry.detail}</li>)}</ul></>}
  </section>;
}
