import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { BlingAdoptionOperationMap } from '../../../../src/erp/bling/adoption-contracts';
import type { BlingCutoverBalance, BlingCutoverConflict, BlingCutoverStatus } from '../../../../src/erp/bling/cutover-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';
import { brDay, brl, centsFromText, centsText, downloadCutoverPackage, saveFile } from './cutover-bling-client';

type Out<K extends keyof BlingAdoptionOperationMap> = BlingAdoptionOperationMap[K]['output'];
const SCOPES = { paid: 'Pagas ou recebidas', cancelled: 'Canceladas', returned: 'Devolvidas', other: 'Outras encerradas' } as const;
const ACCOUNT = { receivables: 'Contas a receber', payables: 'Contas a pagar' } as const;
const STOCK_STATES = { waiting: 'Aguardando', partial: 'Em andamento', posted: 'Gravado', blocked: 'Depósito não adotado' } as const;
const PACKAGE_STATES = { running: 'Montando', done: 'Pronto', failed: 'Falhou' } as const;
const time = (value: string | null) => value === null ? '—' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const thisMonth = (day: string) => day.slice(0, 7);

/** Área "Passar a operar aqui": a data de corte e as etapas que fecham a
 * passagem do Bling para o ERP. Nada é escrito no Bling. */
export function CutoverBling({ controller, administrator, client: injected, onAdopt }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient; onAdopt?(): void }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [status, setStatus] = useState<BlingCutoverStatus | null>(null), [date, setDate] = useState(''), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [summary, setSummary] = useState<Out<'erp_bling_cutover_accounts_summary'> | null>(null);
  const [partials, setPartials] = useState<Out<'erp_bling_cutover_partials'> & { entity: 'receivables' | 'payables' } | null>(null);
  const [balances, setBalances] = useState<Out<'erp_bling_cutover_balances'> | null>(null), [typed, setTyped] = useState<Record<string, string>>({});
  const [stock, setStock] = useState<Out<'erp_bling_cutover_stock'> | null>(null), [onlyIssues, setOnlyIssues] = useState(true);
  const [packages, setPackages] = useState<Out<'erp_bling_cutover_packages'> | null>(null), [month, setMonth] = useState('');
  const [conflicts, setConflicts] = useState<Out<'erp_bling_cutover_conflicts'> | null>(null);
  const [report, setReport] = useState<Out<'erp_bling_cutover_report'> | null>(null), [why, setWhy] = useState<Record<string, string>>({});
  const alive = useRef(true), lock = useRef(false);
  const command = () => crypto.randomUUID();

  async function task(action: () => Promise<void>) {
    if (lock.current || !alive.current || !client) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { if (alive.current) setError(adoptionFailureText(caught)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function reload(proposed?: string) {
    const next = await client!.execute('erp_bling_cutover_status', proposed ? { cutover_on: proposed } : {});
    if (!alive.current) return next;
    setStatus(next);
    if (!date && next.proposed_on) setDate(next.proposed_on);
    return next;
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(async () => { await reload(); });
    return () => { alive.current = false; };
  }, [client, administrator]);
  useEffect(() => {
    if (!packages?.items.some(item => item.state === 'running') || !client) return;
    const timer = setInterval(() => { if (!lock.current) void client.execute('erp_bling_cutover_packages', {}).then(next => alive.current && setPackages(next)).catch(() => undefined); }, 4000);
    return () => clearInterval(timer);
  }, [packages, client]);

  if (!administrator) return <section className="rb-card" aria-label="Passar a operar aqui"><h2>Passar a operar aqui</h2><p>Passar a operar no ERP exige um administrador do ERP. Peça a um administrador.</p></section>;
  if (!client) return <section className="rb-card" aria-label="Passar a operar aqui"><h2>Passar a operar aqui</h2><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  const cut = status?.cutover, confirmed = !!cut && cut.state !== 'none', concluded = cut?.state === 'concluded';
  const step = (key: string) => status?.steps.find(item => item.key === key);
  const blocked = status?.checks.filter(check => ['archive', 'date', 'job'].includes(check.key) && !check.ok) ?? [];
  const texts = status?.texts ?? {};

  const confirm = () => task(async () => {
    const result = await client.execute('erp_bling_cutover_confirm', { command_id: command(), cutover_on: date, acknowledged: true });
    setNotice(`Data de corte confirmada: a partir de ${brDay(result.cutover.cutover_on)} o ERP passa a valer. Siga as etapas abaixo.`); setAck(false);
    await reload();
  });
  const loadAccounts = () => task(async () => {
    const [s, p] = await Promise.all([client.execute('erp_bling_cutover_accounts_summary', {}), client.execute('erp_bling_cutover_partials', { entity: partials?.entity ?? 'receivables', limit: 20 })]);
    if (alive.current) { setSummary(s); setPartials({ ...p, entity: partials?.entity ?? 'receivables' }); }
  });
  const showPartials = (entity: 'receivables' | 'payables', cursor?: string) => task(async () => {
    const p = await client.execute('erp_bling_cutover_partials', { entity, limit: 20, ...(cursor ? { cursor } : {}) });
    if (alive.current) setPartials({ ...p, entity });
  });
  const adoptPartials = () => task(async () => {
    let adopted = 0, pending = 0;
    for (let round = 0; round < 200; round++) {
      const result = await client.execute('erp_bling_cutover_partials_adopt', { command_id: command() });
      adopted += result.adopted; pending += result.pending;
      if (!result.remaining || !alive.current) break;
    }
    setNotice(`${adopted} conta(s) parcial(is) adotada(s) pelo saldo${pending ? `; ${pending} ficaram pendentes, com o motivo na lista` : ''}.`);
    const [s, p] = await Promise.all([client.execute('erp_bling_cutover_accounts_summary', {}), client.execute('erp_bling_cutover_partials', { entity: partials?.entity ?? 'receivables', limit: 20 })]);
    if (alive.current) { setSummary(s); setPartials({ ...p, entity: partials?.entity ?? 'receivables' }); }
    await reload();
  });
  const loadBalances = () => task(async () => {
    const next = await client.execute('erp_bling_cutover_balances', {});
    if (!alive.current) return;
    setBalances(next);
    setTyped(Object.fromEntries(next.items.map(item => [item.source_id, typed[item.source_id] ?? centsText(item.posted_cents ?? item.computed_cents)])));
  });
  const postBalance = (item: BlingCutoverBalance) => task(async () => {
    const cents = centsFromText(typed[item.source_id] ?? '');
    if (cents === null) { setError(`Informe o saldo da conta ${item.name ?? item.source_id} em reais, por exemplo 1.234,56.`); return; }
    const result = await client.execute('erp_bling_cutover_balance_post', { command_id: command(), source_id: item.source_id, confirmed_cents: cents, computed_cents: item.computed_cents });
    setNotice(`Saldo de abertura de ${result.item.name ?? 'conta'} gravado: ${brl(result.item.posted_cents)} em ${brDay(result.item.posted_on)}.`);
    await loadBalancesQuiet(); await reload();
  });
  async function loadBalancesQuiet() { const next = await client!.execute('erp_bling_cutover_balances', {}); if (alive.current) setBalances(next); }
  const loadStock = (warehouse?: string, cursor?: string, issues = onlyIssues) => task(async () => {
    const next = await client.execute('erp_bling_cutover_stock', { ...(warehouse ? { warehouse } : {}), only_issues: issues ? 'sim' : 'nao', ...(cursor ? { cursor } : {}) });
    if (alive.current) setStock(next);
  });
  const postStock = (source: string, hash: string, name: string | null) => task(async () => {
    let lines = 0, round = 0, remaining = 1;
    let preview = hash;
    while (remaining && round++ < 300 && alive.current) {
      const result = await client.execute('erp_bling_cutover_stock_post', { command_id: command(), warehouse: source, preview_hash: preview });
      lines += result.posted_lines; remaining = result.remaining; preview = result.warehouse.preview_hash;
    }
    setNotice(`Estoque de abertura de ${name ?? 'depósito'} gravado: ${lines} produto(s) na data de corte.`);
    const next = await client.execute('erp_bling_cutover_stock', { warehouse: source, only_issues: onlyIssues ? 'sim' : 'nao' });
    if (alive.current) setStock(next);
    await reload();
  });
  const loadPackages = () => task(async () => { const next = await client.execute('erp_bling_cutover_packages', {}); if (alive.current) setPackages(next); });
  const startPackage = () => task(async () => {
    const result = await client.execute('erp_bling_cutover_package_start', { command_id: command(), month });
    setNotice(`Pacote de ${result.package.month.split('-').reverse().join('/')} em montagem. Ele fica pronto aos poucos; esta lista se atualiza sozinha.`);
    const next = await client.execute('erp_bling_cutover_packages', {}); if (alive.current) setPackages(next);
  });
  const download = (target: string) => task(async () => { const file = await downloadCutoverPackage(target); saveFile(file.blob, file.filename); });
  const loadConflicts = (cursor?: string) => task(async () => { const next = await client.execute('erp_bling_cutover_conflicts', { limit: 20, ...(cursor ? { cursor } : {}) }); if (alive.current) setConflicts(next); });
  const resolve = (item: BlingCutoverConflict, action: 'keep_erp' | 'use_bling') => task(async () => {
    const result = await client.execute('erp_bling_cutover_conflict_resolve', { command_id: command(), entity: item.entity, source_id: item.source_id, action });
    setNotice(result.outcome === 'updated' ? 'O cadastro do ERP recebeu a versão nova do Bling.' : 'O ERP ficou como está. Esta mudança do Bling foi marcada como vista.');
    const next = await client.execute('erp_bling_cutover_conflicts', { limit: 20 }); if (alive.current) setConflicts(next);
    await reload();
  });
  const loadReport = () => task(async () => { const next = await client.execute('erp_bling_cutover_report', {}); if (alive.current) setReport(next); });
  const justify = (key: string) => task(async () => {
    const text = (why[key] ?? '').trim();
    if (text.length < 5) { setError('Escreva por que esta diferença pode ficar como está (pelo menos 5 letras).'); return; }
    await client.execute('erp_bling_cutover_justify', { command_id: command(), key, text });
    setWhy(current => ({ ...current, [key]: '' })); setNotice('Justificativa registrada.');
    const next = await client.execute('erp_bling_cutover_report', {}); if (alive.current) setReport(next);
  });
  const conclude = () => task(async () => {
    const result = await client.execute('erp_bling_cutover_conclude', { command_id: command() });
    setNotice(`Corte concluído em ${time(result.cutover.concluded_at)}. Daqui para a frente o ERP é o sistema que vale; a coleta do Bling continua só para consulta e conflitos.`);
    await reload(); const next = await client.execute('erp_bling_cutover_report', {}); if (alive.current) setReport(next);
  });

  const off = (key: string) => { const s = step(key); return s && !s.enabled ? <p role="note">{s.part_off_message}</p> : null; };
  return <section aria-label="Passar a operar aqui" className="rb-cutover">
    <h2>Passar a operar aqui</h2>
    <p className="rb-intro">{texts.date ?? 'Escolha a data a partir da qual o ERP passa a valer.'}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}

    <article className="rb-card" aria-label="Data de corte">
      <h3>1. Data de corte</h3>
      {confirmed ? <p><strong>Data de corte confirmada: {brDay(cut!.cutover_on)}</strong> ({concluded ? `corte concluído em ${time(cut!.concluded_at)}` : `confirmada em ${time(cut!.confirmed_at)}`}).{cut!.can_change_date && !concluded ? ' Enquanto nenhuma etapa gravar nada, você ainda pode confirmar outra data.' : ' A data não muda mais.'}</p>
        : <p>Nenhuma data confirmada ainda. Nenhuma etapa do corte roda sem ela.</p>}
      {(!confirmed || (cut!.can_change_date && !concluded)) && <form className="rb-filters" onSubmit={event => { event.preventDefault(); void task(async () => { await reload(date); }); }}>
        <label htmlFor="bling-cutover-date">Data de corte</label>
        <input id="bling-cutover-date" type="date" value={date} max={status?.today} disabled={busy} onChange={e => setDate(e.target.value)} />
        <button type="submit" disabled={busy || !date}>Ver conferência antes de confirmar</button>
      </form>}
      {status && <>
        <h4>O que falta adotar</h4>
        {status.missing.length ? <div className="rb-scroll" role="region" aria-label="O que falta adotar" tabIndex={0}><table><thead><tr><th>Entidade</th><th>Aguardando</th><th>Pendentes</th><th>Ignorados</th><th>Módulo</th></tr></thead><tbody>
          {status.missing.map(item => <tr key={item.entity}><td>{item.label}</td><td>{item.waiting}</td><td>{item.pending}</td><td>{item.ignored}</td><td>{item.enabled ? 'Ligado' : item.part_off_message}</td></tr>)}
        </tbody></table></div> : <p>Nada aguardando, pendente ou ignorado na adoção.</p>}
        {onAdopt && status.missing.length > 0 && <button type="button" onClick={onAdopt}>Ir para Adotar cadastros</button>}
        <h4>Conferência antes de confirmar</h4>
        <ul className="rb-checks">{status.checks.map(check => <li key={check.key}><strong>{check.ok ? 'Certo' : 'Atenção'}:</strong> {check.label}. {check.message}</li>)}</ul>
        {(!confirmed || (cut!.can_change_date && !concluded)) && <>
          <label><input id="bling-cutover-ack" type="checkbox" checked={ack} disabled={busy} onChange={e => setAck(e.target.checked)} /> Entendi: a partir de {date ? brDay(date) : 'a data escolhida'} o ERP passa a valer; o Bling continua vivo só para consulta.</label>
          <button type="button" disabled={busy || !ack || !date || blocked.length > 0 || date !== status.proposed_on} onClick={() => void confirm()}>Confirmar data de corte</button>
          {date && date !== status.proposed_on && <p role="note">Clique em "Ver conferência antes de confirmar" para conferir esta data.</p>}
        </>}
      </>}
    </article>

    {status && <article className="rb-card" aria-label="Etapas do corte"><h3>Etapas</h3>
      <ol className="rb-steps">{status.steps.map(item => <li key={item.key}><strong>{item.label}</strong> — {item.done ? 'feito' : 'a fazer'}. {item.enabled ? item.summary : item.part_off_message}</li>)}</ol>
      {status.conflicts > 0 && <p role="note">{status.conflicts} mudança(s) no Bling em registros já adotados esperam a sua decisão (seção Mudanças no Bling depois do corte).</p>}
    </article>}

    {confirmed && <>
      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !summary && step('partials')?.enabled) void loadAccounts(); }}>
        <summary><h3>2. Contas parciais, pagas e canceladas</h3></summary>
        {off('partials')}
        <p>{texts.partials}</p>
        <button type="button" disabled={busy || !step('partials')?.enabled || concluded} onClick={() => void adoptPartials()}>Adotar contas parciais pelo saldo</button>
        <button type="button" disabled={busy || !step('partials')?.enabled} onClick={() => void loadAccounts()}>Atualizar contas</button>
        {summary && <>
          <ul>{summary.partials.map(p => <li key={p.entity}>{ACCOUNT[p.entity]}: {p.count} parcial(is), saldo em aberto {brl(p.balance_cents)}; {p.adopted} adotada(s), {p.waiting} aguardando, {p.pending} pendente(s).</li>)}</ul>
          <h4>Pagas e canceladas (ficam no histórico)</h4>
          <p role="status">{summary.matches ? 'O resumo bate com os totais do acervo.' : 'O resumo não bate com o acervo: há contas que ainda não passaram pela adoção. Rode a adoção de contas e atualize.'}{summary.truncated ? ' Mostrando os primeiros 3.000 grupos.' : ''}</p>
          <div className="rb-scroll" role="region" aria-label="Totais das contas encerradas" tabIndex={0}><table><thead><tr><th>Tipo</th><th>Situação</th><th>Quantidade</th><th>Total no resumo</th><th>Total no acervo</th></tr></thead><tbody>
            {summary.totals.filter((t, i) => t.count || summary.acervo[i].count).map((t, i) => { const a = summary.acervo.find(x => x.entity === t.entity && x.scope === t.scope)!; return <tr key={`${t.entity}-${t.scope}-${i}`}><td>{ACCOUNT[t.entity]}</td><td>{SCOPES[t.scope]}</td><td>{t.count}</td><td>{brl(t.total_cents)}</td><td>{brl(a.total_cents)}</td></tr>; })}
          </tbody></table></div>
          <div className="rb-scroll" role="region" aria-label="Resumo por mês e categoria" tabIndex={0}><table><thead><tr><th>Tipo</th><th>Mês</th><th>Categoria</th><th>Situação</th><th>Quantidade</th><th>Total</th></tr></thead><tbody>
            {summary.rows.map((r, i) => <tr key={i}><td>{ACCOUNT[r.entity]}</td><td>{r.month ? r.month.split('-').reverse().join('/') : 'Sem data'}</td><td>{r.category}</td><td>{SCOPES[r.scope]}</td><td>{r.count}</td><td>{brl(r.total_cents)}</td></tr>)}
          </tbody></table></div>
        </>}
        {partials && <>
          <h4>Contas parciais</h4>
          <label htmlFor="bling-partials-entity">Mostrar</label>
          <select id="bling-partials-entity" value={partials.entity} disabled={busy} onChange={e => void showPartials(e.target.value as 'receivables' | 'payables')}><option value="receivables">Contas a receber</option><option value="payables">Contas a pagar</option></select>
          {partials.items.length ? <div className="rb-scroll" role="region" aria-label="Contas parciais" tabIndex={0}><table><thead><tr><th>Número</th><th>Contato</th><th>Vencimento</th><th>Valor original</th><th>Já pago</th><th>Saldo</th><th>No ERP</th></tr></thead><tbody>
            {partials.items.map(item => <tr key={item.source_id}><td>{item.number ?? '—'}</td><td>{item.contact_name ?? '—'}</td><td>{brDay(item.due_on)}</td><td>{brl(item.amount_cents)}</td><td>{brl(item.paid_cents)}</td><td>{brl(item.balance_cents)}</td>
              <td>{item.state === 'adopted' ? 'Adotada pelo saldo' : item.state === 'pending' ? `Pendente: ${item.detail ?? 'veja o motivo'}` : 'Aguardando'}</td></tr>)}
          </tbody></table></div> : <p>Nenhuma conta parcial aqui.</p>}
          <button type="button" disabled={busy || !partials.next_cursor} onClick={() => void showPartials(partials.entity, partials.next_cursor!)}>Próximas contas parciais</button>
        </>}
      </details>

      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !balances && step('balances')?.enabled) void loadBalances(); }}>
        <summary><h3>3. Saldos de abertura das contas financeiras</h3></summary>
        {off('balances')}
        <p>{texts.balances}</p>
        <button type="button" disabled={busy || !step('balances')?.enabled} onClick={() => void loadBalances()}>Atualizar saldos</button>
        {balances && (balances.items.length ? <div className="rb-scroll" role="region" aria-label="Saldos de abertura" tabIndex={0}><table><thead><tr><th>Conta</th><th>Calculado do Bling</th><th>Como foi calculado</th><th>Saldo no ERP em {brDay(balances.cutover_on)}</th><th>Saldo de abertura</th><th>Situação</th></tr></thead><tbody>
          {balances.items.map(item => <tr key={item.source_id}><td>{item.name ?? `Conta ${item.source_id}`}</td><td>{brl(item.computed_cents)}</td><td>{item.computed_note}</td><td>{brl(item.erp_cents_at_cutover)}</td>
            <td>{item.state === 'posted' ? brl(item.posted_cents) : <><label htmlFor={`bling-balance-${item.source_id}`} className="rb-sr">Saldo de abertura de {item.name ?? item.source_id}</label><input id={`bling-balance-${item.source_id}`} inputMode="decimal" value={typed[item.source_id] ?? ''} disabled={busy || concluded} placeholder="0,00" onChange={e => setTyped(current => ({ ...current, [item.source_id]: e.target.value }))} /></>}</td>
            <td>{item.state === 'posted' ? `Gravado em ${brDay(item.posted_on)}` : <button type="button" disabled={busy || concluded} onClick={() => void postBalance(item)}>Confirmar e gravar saldo de {item.name ?? item.source_id}</button>}</td></tr>)}
        </tbody></table></div> : <p>Nenhuma conta financeira adotada do Bling. Adote as contas financeiras em Adotar cadastros.</p>)}
      </details>

      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !stock && step('stock')?.enabled) void loadStock(); }}>
        <summary><h3>4. Estoque de abertura</h3></summary>
        {off('stock')}
        <p><strong>{texts.stock}</strong></p>
        <button type="button" disabled={busy || !step('stock')?.enabled} onClick={() => void loadStock(stock?.lines?.warehouse)}>Atualizar prévia</button>
        {stock && <>
          {!stock.negative_allowed && <p role="note">O ERP não aceita estoque negativo (Preferências → Estoque): saldos negativos do Bling ficam de fora e aparecem na conferência.</p>}
          {stock.warehouses.length ? <div className="rb-scroll" role="region" aria-label="Estoque de abertura por depósito" tabIndex={0}><table><thead><tr><th>Depósito</th><th>Produtos</th><th>Prontos</th><th>Sem cadastro adotado</th><th>Negativos</th><th>Diferenças com o ERP</th><th>Não entram</th><th>Valorizado</th><th>Situação</th><th>Ações</th></tr></thead><tbody>
            {stock.warehouses.map(w => <tr key={w.source_id}><td>{w.name ?? w.source_id}</td><td>{w.products}</td><td>{w.ready}</td><td>{w.without_product}</td><td>{w.negatives}</td><td>{w.differences}</td><td>{w.unsupported}</td><td>{brl(w.valued_cents)}</td><td>{STOCK_STATES[w.state]}{w.posted_lines ? ` (${w.posted_lines} gravado[s])` : ''}</td>
              <td><button type="button" disabled={busy} onClick={() => void loadStock(w.source_id)}>Ver produtos de {w.name ?? w.source_id}</button>
                {w.state !== 'posted' && w.state !== 'blocked' && <button type="button" disabled={busy || concluded || !w.ready} onClick={() => void postStock(w.source_id, w.preview_hash, w.name)}>Gravar estoque de abertura de {w.name ?? w.source_id}</button>}</td></tr>)}
          </tbody></table></div> : <p>Nenhum saldo de estoque coletado do Bling.</p>}
          {stock.lines && <>
            <label><input id="bling-stock-issues" type="checkbox" checked={onlyIssues} disabled={busy} onChange={e => { setOnlyIssues(e.target.checked); void loadStock(stock.lines!.warehouse, undefined, e.target.checked); }} /> Mostrar só produtos com aviso</label>
            <div className="rb-scroll" role="region" aria-label="Produtos do depósito" tabIndex={0}><table><thead><tr><th>Produto</th><th>Código</th><th>Saldo no Bling</th><th>Saldo no ERP</th><th>Ajuste</th><th>Custo</th><th>Aviso</th><th>Situação</th></tr></thead><tbody>
              {stock.lines.items.map(line => <tr key={line.product_source_id}><td>{line.name ?? `Produto ${line.product_source_id}`}</td><td>{line.code ?? '—'}</td><td>{line.target}</td><td>{line.erp_now ?? '—'}</td><td>{line.delta ?? '—'}</td><td>{line.unit_cost ?? '—'}</td><td>{line.issue_text ?? '—'}</td><td>{line.state === 'posted' ? 'Gravado' : line.state === 'skipped' ? 'Não entra' : 'Aguardando'}</td></tr>)}
            </tbody></table></div>
            {!stock.lines.items.length && <p>Nenhum produto com aviso neste depósito.</p>}
            <button type="button" disabled={busy || !stock.lines.next_cursor} onClick={() => void loadStock(stock.lines!.warehouse, stock.lines!.next_cursor!)}>Próximos produtos</button>
          </>}
        </>}
      </details>

      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !packages && step('package')?.enabled) void loadPackages(); }}>
        <summary><h3>5. Notas emitidas no Bling e pacote do contador</h3></summary>
        {off('package')}
        <p>{texts.invoices} A lista fica em <strong>Fiscal → Notas emitidas no Bling</strong>.</p>
        <p>{texts.package}</p>
        <form className="rb-filters" onSubmit={event => { event.preventDefault(); void startPackage(); }}>
          <label htmlFor="bling-package-month">Mês</label>
          <input id="bling-package-month" type="month" value={month} max={cut?.cutover_on ? thisMonth(cut.cutover_on) : undefined} disabled={busy || !step('package')?.enabled} onChange={e => setMonth(e.target.value)} />
          <button type="submit" disabled={busy || !month || !step('package')?.enabled}>Gerar pacote do mês</button>
        </form>
        {packages && (packages.items.length ? <div className="rb-scroll" role="region" aria-label="Pacotes do contador" tabIndex={0}><table><thead><tr><th>Mês</th><th>Situação</th><th>Notas</th><th>Com XML</th><th>Sem XML</th><th>Tamanho</th><th>Atualizado</th><th>Arquivo</th></tr></thead><tbody>
          {packages.items.map(p => <tr key={p.month}><td>{p.month.split('-').reverse().join('/')}</td><td>{PACKAGE_STATES[p.state]}{p.error ? `: ${p.error}` : ''}</td><td>{p.notes}</td><td>{p.with_xml}</td><td>{p.without_xml}</td><td>{new Intl.NumberFormat('pt-BR').format(p.bytes)} bytes</td><td>{time(p.updated_at)}</td>
            <td>{p.state === 'done' ? <button type="button" disabled={busy} onClick={() => void download(p.month)}>Baixar pacote de {p.month.split('-').reverse().join('/')}</button> : '—'}</td></tr>)}
        </tbody></table></div> : <p>Nenhum pacote gerado ainda.</p>)}
      </details>

      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !conflicts) void loadConflicts(); }}>
        <summary><h3>6. Mudanças no Bling depois do corte{status && status.conflicts ? ` (${status.conflicts})` : ''}</h3></summary>
        <p>{texts.conflicts}</p>
        <button type="button" disabled={busy} onClick={() => void loadConflicts()}>Atualizar mudanças</button>
        {conflicts && (conflicts.items.length ? conflicts.items.map(item => <article key={`${item.entity}-${item.source_id}`} className="rb-review" aria-label={`Mudança em ${item.label}`}>
          <h4>{item.label}: versão {item.from_version} → {item.to_version} ({time(item.changed_at)})</h4>
          <div className="rb-compare"><dl><dt>Bling agora</dt>{Object.entries(item.bling ?? {}).map(([k, v]) => <dd key={k}>{k}: {v ?? '—'}</dd>)}</dl><dl><dt>ERP</dt>{Object.entries(item.erp ?? {}).map(([k, v]) => <dd key={k}>{k}: {v ?? '—'}</dd>)}</dl></div>
          <button type="button" disabled={busy} onClick={() => void resolve(item, 'keep_erp')}>Manter o ERP como está</button>
          {item.can_use_bling && <button type="button" disabled={busy} onClick={() => void resolve(item, 'use_bling')}>Usar a versão nova do Bling</button>}
        </article>) : <p>Nenhuma mudança esperando decisão.</p>)}
        {conflicts?.next_cursor && <button type="button" disabled={busy} onClick={() => void loadConflicts(conflicts.next_cursor!)}>Próximas mudanças</button>}
      </details>

      <details className="rb-card" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !report) void loadReport(); }}>
        <summary><h3>7. Conferência final</h3></summary>
        <p>{texts.report}</p>
        <button type="button" disabled={busy} onClick={() => void loadReport()}>Atualizar conferência</button>
        {report && <>
          <div className="rb-scroll" role="region" aria-label="Conferência por entidade" tabIndex={0}><table><thead><tr><th>Entidade</th><th>No Bling</th><th>Adotados</th><th>No histórico</th><th>Pendentes</th><th>Ignorados</th><th>Aguardando</th></tr></thead><tbody>
            {report.entities.map(e => <tr key={e.key}><td>{e.label}</td><td>{e.bling}</td><td>{e.adopted}</td><td>{e.history}</td><td>{e.pending}</td><td>{e.ignored}</td><td>{e.waiting}</td></tr>)}
          </tbody></table></div>
          <div className="rb-scroll" role="region" aria-label="Conferência em dinheiro" tabIndex={0}><table><thead><tr><th>O quê</th><th>Bling</th><th>ERP</th><th>Diferença</th><th>Explicação</th></tr></thead><tbody>
            {report.money.map(m => <tr key={m.key}><td>{m.label}</td><td>{brl(m.bling_cents)}</td><td>{brl(m.erp_cents)}</td><td>{brl(m.difference_cents)}</td><td>{m.explanation}</td></tr>)}
          </tbody></table></div>
          <h4>Diferenças {report.blocking ? `(${report.blocking} sem justificativa)` : '(todas resolvidas ou justificadas)'}</h4>
          {report.differences.map(d => <article key={d.key} className="rb-review" aria-label={d.label}>
            <h5>{d.label} — {d.count} item(ns){d.cents ? `, ${brl(d.cents)}` : ''}: {d.justified ? 'justificada' : 'sem justificativa'}</h5>
            <p>{d.explanation}</p>
            {d.justification && <p>Justificativa: “{d.justification.text}” ({time(d.justification.at)}).</p>}
            {d.items.length > 0 && <ul>{d.items.map(item => <li key={item.key}>{item.label}{item.detail ? ` — ${item.detail}` : ''}{item.justified ? ' (justificado)' : ''}</li>)}</ul>}
            {!d.justified && !concluded && <><label htmlFor={`bling-why-${d.key}`}>Por que pode ficar assim</label><textarea id={`bling-why-${d.key}`} maxLength={2000} value={why[d.key] ?? ''} disabled={busy} onChange={e => setWhy(current => ({ ...current, [d.key]: e.target.value }))} />
              <button type="button" disabled={busy} onClick={() => void justify(d.key)}>Registrar justificativa</button></>}
          </article>)}
          {!concluded && <button type="button" disabled={busy || !report.can_conclude} onClick={() => void conclude()}>Concluir o corte</button>}
          {!concluded && !report.can_conclude && <p role="note">Resolva ou justifique cada diferença para concluir.</p>}
        </>}
      </details>
    </>}
  </section>;
}
