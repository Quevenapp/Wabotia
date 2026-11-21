import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { BlingAdoptionOperationMap } from '../../../../src/erp/bling/adoption-contracts';
import type { BlingTwoWayDirection, BlingTwoWayEntity, BlingTwoWayIssue, BlingTwoWayStatus } from '../../../../src/erp/bling/two-way-contracts';
import { adoptionFailureText, createPanelAdoptBlingClient, type AdoptBlingClient } from './adopt-bling-client';

type Out<K extends keyof BlingAdoptionOperationMap> = BlingAdoptionOperationMap[K]['output'];
const time = (value: string | null) => value === null ? 'ainda não houve' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const DIRECTION = { inbound: 'Receber do Bling', outbound: 'Escrever no Bling' } as const;
const IN_COUNTS: Record<string, string> = { applied: 'mudança(s) aplicada(s) no ERP', adopted: 'registro(s) novo(s) adotado(s)', conflicts: 'conflito(s)', failed: 'recusada(s) pelo ERP' };
const OUT_COUNTS: Record<string, string> = { queued: 'mudança(s) posta(s) na fila', confirmed: 'gravada(s) no Bling', failed: 'recusada(s) pelo Bling', uncertain: 'conferida(s) por falta de resposta' };
const counted = (counts: Record<string, number>, words: Record<string, string>) => {
  const parts = Object.entries(words).filter(([key]) => Number(counts[key]) > 0).map(([key, word]) => `${counts[key]} ${word}`);
  return parts.length ? parts.join(', ') : 'nada ainda';
};
const OPEN_STATES = new Set(['pending', 'sending', 'uncertain']);

/** Aba "Mão dupla" da tela Receber dados do Bling: interruptores por tipo de
 * registro e sentido (todos começam desligados), a última rodada em cada
 * sentido, a fila de saída, as pendências e os conflitos. Ligar pede o aviso. */
export function TwoWayBling({ controller, administrator, client: injected, onCutover }: { controller: AccessController; administrator: boolean; client?: AdoptBlingClient; onCutover?(): void }) {
  const client = useMemo(() => { try { return injected ?? createPanelAdoptBlingClient(controller); } catch { return null; } }, [injected, controller]);
  const [status, setStatus] = useState<BlingTwoWayStatus | null>(null);
  const [queue, setQueue] = useState<Out<'erp_bling_twoway_queue'> | null>(null);
  const [issues, setIssues] = useState<Out<'erp_bling_twoway_issues'> | null>(null);
  const [asking, setAsking] = useState<{ entity: BlingTwoWayEntity; direction: BlingTwoWayDirection } | null>(null), [ack, setAck] = useState(false);
  const [pace, setPace] = useState(''), [remote, setRemote] = useState<Record<string, string>>({});
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
    const [s, q, i] = await Promise.all([client!.execute('erp_bling_twoway_status', {}), client!.execute('erp_bling_twoway_queue', { limit: 20 }), client!.execute('erp_bling_twoway_issues', { limit: 20 })]);
    if (!alive.current) return;
    setStatus(s); setQueue(q); setIssues(i);
    setPace(current => current || String(s.pace_minutes));
  }
  useEffect(() => {
    alive.current = true;
    if (administrator && client) void task(reload);
    return () => { alive.current = false; };
  }, [client, administrator]);
  useEffect(() => {
    if (!client || !queue?.items.some(item => OPEN_STATES.has(item.state))) return;
    const timer = setInterval(() => { if (!lock.current) void reload().catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, [queue, client]);

  if (!administrator) return <section className="rb-card" aria-label="Mão dupla"><h2>Mão dupla</h2><p>A mão dupla com o Bling é configurada por um administrador do ERP. Peça a um administrador.</p></section>;
  if (!client) return <section className="rb-card" aria-label="Mão dupla"><h2>Mão dupla</h2><p role="alert">A sessão do ERP não está pronta. Recarregue a página e tente de novo.</p></section>;
  const texts = status?.texts ?? {};
  const confirmed = !!status?.cutover.confirmed;

  const flip = (entity: BlingTwoWayEntity, direction: BlingTwoWayDirection, enabled: boolean) => {
    if (enabled) { setAsking({ entity, direction }); setAck(false); setNotice(''); return; }
    void task(async () => {
      await client.execute('erp_bling_twoway_switch', { command_id: command(), entity, direction, enabled: false });
      setNotice(`Desligado: ${DIRECTION[direction]} para ${status?.entities.find(e => e.entity === entity)?.label.toLowerCase() ?? entity}. O que já estava na fila fica parado.`);
      await reload();
    });
  };
  const turnOn = () => task(async () => {
    if (!asking) return;
    await client.execute('erp_bling_twoway_switch', { command_id: command(), entity: asking.entity, direction: asking.direction, enabled: true, acknowledged: true });
    setNotice(`Ligado: ${DIRECTION[asking.direction]} para ${status?.entities.find(e => e.entity === asking.entity)?.label.toLowerCase() ?? asking.entity}. Ficou registrado com seu nome e a hora.`);
    setAsking(null); setAck(false);
    await reload();
  });
  const savePace = () => task(async () => {
    const minutes = Number(pace);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) { setError('Use um número inteiro de 5 a 1440 minutos.'); return; }
    await client.execute('erp_bling_twoway_pace', { command_id: command(), minutes });
    setNotice(`Ritmo salvo: a coleta procura o que mudou no Bling a cada ${minutes} minutos.`);
    await reload();
  });
  const resolve = (issue: BlingTwoWayIssue, action: BlingTwoWayIssue['actions'][number]['action']) => task(async () => {
    const id = remote[issue.key]?.trim();
    const result = await client.execute('erp_bling_twoway_resolve', { command_id: command(), key: issue.key, action, ...(action === 'confirm_sent' && id ? { remote_id: id } : {}) });
    setNotice(result.message);
    await reload();
  });
  const paceValid = /^\d{1,4}$/.test(pace) && Number(pace) >= 5 && Number(pace) <= 1440;

  return <section className="rb-card" aria-label="Mão dupla" aria-busy={busy}>
    <h2>Mão dupla</h2>
    <p>{texts.intro}</p>
    <p><strong>{texts.never}</strong></p>
    <p>{texts.conflict}</p>
    <p>{texts.uncertain}</p>
    <p>{texts.not_sent}</p>
    <p className="rb-intro">Os três estados do dado continuam valendo: o <strong>bruto</strong> guarda o que veio do Bling, o <strong>espelho histórico</strong> só mostra (aba Acervo e Histórico do Bling) e o <strong>adotado</strong> é o registro do ERP. A mão dupla só mexe nos adotados e nos criados aqui depois do corte.</p>
    <div role="status" aria-live="polite">{notice}</div>
    {error && <p role="alert">{error}</p>}
    {status && !status.available && <p role="alert">{status.unavailable_message}</p>}
    {status && !confirmed && <aside className="rb-warning" role="alert"><p>{texts.no_cutover}</p>{onCutover && <button type="button" onClick={onCutover}>Ir para Passar a operar aqui</button>}</aside>}

    <h3>Interruptores</h3>
    <p>Cada tipo de registro tem um interruptor para cada sentido. Todos começam desligados; ligar pede que você confirme o aviso e fica registrado.</p>
    <div className="rb-scroll" role="region" aria-label="Interruptores da mão dupla" tabIndex={0}><table>
      <thead><tr><th>Tipo de registro</th><th>{DIRECTION.inbound}</th><th>{DIRECTION.outbound}</th><th>Na fila</th><th>Pendências</th></tr></thead>
      <tbody>{status?.entities.map(entity => <tr key={entity.entity}>
        <td>{entity.label}{entity.part_off_message && <><br /><small role="note">{entity.part_off_message}</small></>}</td>
        {(['inbound', 'outbound'] as const).map(direction => <td key={direction}>
          <label><input id={`twoway-${direction}-${entity.entity}`} type="checkbox" checked={entity[direction].enabled} disabled={busy || !confirmed || (!entity.enabled && !entity[direction].enabled)}
            onChange={event => flip(entity.entity, direction, event.target.checked)} />{entity[direction].enabled ? `Ligado desde ${time(entity[direction].since)}` : 'Desligado'}</label>
        </td>)}
        <td>{entity.queued}{entity.uncertain ? ` (${entity.uncertain} em conferência)` : ''}{entity.failed ? `, ${entity.failed} recusado(s)` : ''}</td>
        <td>{entity.issues}</td>
      </tr>)}</tbody>
    </table></div>
    {asking && <aside className="rb-warning" role="alertdialog" aria-label="Confirmar ligar">
      <p><strong>Ligar {DIRECTION[asking.direction]} para {status?.entities.find(e => e.entity === asking.entity)?.label.toLowerCase()}</strong></p>
      <p>{asking.direction === 'outbound' ? texts.switch_warning_outbound : texts.switch_warning_inbound}</p>
      {asking.direction === 'outbound' && <p>{texts.outbound}</p>}
      {asking.direction === 'inbound' && <p>{texts.inbound}</p>}
      <label><input id="twoway-ack" type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />Entendi e quero ligar</label>
      <button type="button" disabled={busy || !ack} onClick={() => void turnOn()}>Ligar</button>
      <button type="button" disabled={busy} onClick={() => { setAsking(null); setAck(false); }}>Cancelar</button>
    </aside>}

    <h3>Ritmo da coleta contínua</h3>
    <p>De quantos em quantos minutos a coleta procura o que mudou no Bling (de 5 minutos a 24 horas = 1440). Ritmo mais rápido usa mais chamadas do limite diário da conta.</p>
    <label htmlFor="twoway-pace">Minutos entre as rodadas</label>
    <input id="twoway-pace" type="number" min={5} max={1440} value={pace} onChange={event => setPace(event.target.value)} />
    <button type="button" disabled={busy || !paceValid || Number(pace) === status?.pace_minutes} onClick={() => void savePace()}>Salvar ritmo</button>
    {!paceValid && pace !== '' && <p role="alert">Use um número inteiro de 5 a 1440 minutos.</p>}

    <h3>Última rodada</h3>
    {status && <ul>
      <li>{DIRECTION.inbound}: {time(status.last_in.at)}. Até agora: {counted(status.last_in.counts, IN_COUNTS)}.</li>
      <li>{DIRECTION.outbound}: {time(status.last_out.at)}. Até agora: {counted(status.last_out.counts, OUT_COUNTS)}.</li>
    </ul>}

    <h3>Fila de saída</h3>
    {queue && !queue.items.length && <p>Nada na fila para o Bling.</p>}
    {queue && queue.items.length > 0 && <div className="rb-scroll" role="region" aria-label="Fila de saída para o Bling" tabIndex={0}><table>
      <thead><tr><th>Registro</th><th>O que vai fazer</th><th>Situação</th><th>Tentativas</th><th>Motivo</th></tr></thead>
      <tbody>{queue.items.map(item => <tr key={item.id}><td>{item.label}</td><td>{item.op_text}</td><td>{item.state_text}</td><td>{item.attempts}{item.checks ? ` (${item.checks} conferência(s))` : ''}</td><td>{item.error_text ?? '—'}</td></tr>)}</tbody>
    </table></div>}
    <button type="button" disabled={busy} onClick={() => void task(reload)}>Atualizar</button>

    <h3>Pendências e conflitos</h3>
    {issues && !issues.items.length && <p>Nenhuma pendência. ERP e Bling estão de acordo no que a mão dupla acompanha.</p>}
    {issues?.items.map(issue => {
      const keys = [...new Set([...Object.keys(issue.erp ?? {}), ...Object.keys(issue.bling ?? {})])];
      return <article key={issue.key} className="rb-card" aria-label={`Pendência: ${issue.label}`}>
        <h4>{issue.kind_text}: {issue.label}</h4>
        <p>{issue.reason}</p>
        {keys.length > 0 && <div className="rb-scroll" role="region" aria-label="Os dois lados" tabIndex={0}><table>
          <thead><tr><th>Campo</th><th>No ERP</th><th>No Bling</th></tr></thead>
          <tbody>{keys.map(key => <tr key={key}><th scope="row">{key}</th><td>{issue.erp?.[key] ?? '—'}</td><td>{issue.bling?.[key] ?? '—'}</td></tr>)}</tbody>
        </table></div>}
        {issue.actions.some(a => a.action === 'confirm_sent') && <p><label htmlFor={`twoway-remote-${issue.key}`}>Id do registro no Bling (se entrou e era uma criação)</label>
          <input id={`twoway-remote-${issue.key}`} inputMode="numeric" value={remote[issue.key] ?? ''} onChange={event => setRemote(current => ({ ...current, [issue.key]: event.target.value.replace(/\D/g, '') }))} /></p>}
        {issue.actions.map(action => <button key={action.action} type="button" disabled={busy} onClick={() => void resolve(issue, action.action)}>{action.label}</button>)}
      </article>;
    })}

    <h3>Quem ligou ou desligou</h3>
    {status && !status.audit.length && <p>Nenhum interruptor foi mexido ainda.</p>}
    {status && status.audit.length > 0 && <ul>{status.audit.map((entry, index) => <li key={`${entry.at}-${index}`}>{time(entry.at)} — {entry.by}: {entry.detail}</li>)}</ul>}
  </section>;
}
