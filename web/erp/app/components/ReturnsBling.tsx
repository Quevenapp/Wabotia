import { useEffect, useState } from 'react';
import type { BlingReturnKind, BlingReturnStage, BlingReturnsStatus } from '../../../../src/erp/bling/two-way-contracts';
import type { AdoptBlingClient } from './adopt-bling-client';

const time = (value: string | null) => value === null ? 'ainda não houve' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const TITLE: Record<BlingReturnKind, string> = { invoice: 'Nota de volta ao Bling', status: 'Situação e rastreio de volta ao Bling', webhook: 'Aviso do Bling (webhook)' };
const WARNING: Record<BlingReturnKind, string> = { invoice: 'switch_warning_invoice', status: 'switch_warning_status', webhook: 'switch_warning_webhook' };

/** Seção "Volta ao Bling" da aba Mão dupla (versão 32): nota, situação e
 * rastreio dos pedidos que vieram do Bling, e o aviso do Bling (webhook).
 * Interruptores próprios, desligados; ligar pede o aviso confirmado. */
export function ReturnsBling({ returns, client, busy, confirmed, run, onNotice }: {
  returns: BlingReturnsStatus | undefined; client: AdoptBlingClient; busy: boolean; confirmed: boolean;
  run(action: () => Promise<void>): void; onNotice(text: string): void;
}) {
  const [asking, setAsking] = useState<BlingReturnKind | null>(null), [ack, setAck] = useState(false);
  const [map, setMap] = useState<Record<BlingReturnStage, string>>({ separated: '', invoiced: '', shipped: '', delivered: '', cancelled: '' });
  const [mapError, setMapError] = useState('');
  useEffect(() => {
    if (!returns) return;
    setMap(Object.fromEntries(Object.entries(returns.status.situations).map(([stage, id]) => [stage, id ?? ''])) as Record<BlingReturnStage, string>);
  }, [returns]);
  if (!returns) return <section aria-label="Volta ao Bling"><h3>Volta ao Bling</h3><p>Esta área ainda não tem a versão do ERP com a volta ao Bling. Atualize o ERP e recarregue a página.</p></section>;
  const texts = returns.texts;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const webhookUrl = `${origin}${returns.webhook.path}`;
  const situations = () => Object.fromEntries(Object.entries(map).map(([stage, value]) => [stage, value.trim() ? value.trim() : null])) as Record<BlingReturnStage, string | null>;
  const mapValid = Object.values(map).every(value => !value.trim() || /^[1-9]\d{0,19}$/.test(value.trim()));
  const flip = (kind: BlingReturnKind, enabled: boolean) => {
    if (enabled) { setAsking(kind); setAck(false); return; }
    run(async () => {
      await client.execute('erp_bling_twoway_return_switch', { command_id: crypto.randomUUID(), kind, enabled: false });
      onNotice(`Desligado: ${TITLE[kind]}. O que já estava na fila fica parado.`);
    });
  };
  const turnOn = () => run(async () => {
    if (!asking) return;
    if (asking === 'status' && !mapValid) { setMapError('Use só o número da situação no Bling (por exemplo 9), ou deixe em branco.'); return; }
    await client.execute('erp_bling_twoway_return_switch', { command_id: crypto.randomUUID(), kind: asking, enabled: true, acknowledged: true, ...(asking === 'status' ? { situations: situations() } : {}) });
    onNotice(`Ligado: ${TITLE[asking]}. Ficou registrado com seu nome e a hora.`);
    setAsking(null); setAck(false);
  });
  const saveMap = () => run(async () => {
    if (!mapValid) { setMapError('Use só o número da situação no Bling (por exemplo 9), ou deixe em branco.'); return; }
    setMapError('');
    await client.execute('erp_bling_twoway_return_switch', { command_id: crypto.randomUUID(), kind: 'status', enabled: returns.status.enabled, ...(returns.status.enabled ? { acknowledged: true } : {}), situations: situations() });
    onNotice('Situações salvas. Valem para as próximas mudanças de etapa.');
  });
  const row = (kind: BlingReturnKind) => {
    const state = returns[kind];
    return <tr key={kind}>
      <th scope="row">{TITLE[kind]}</th>
      <td><label><input id={`return-${kind}`} type="checkbox" checked={state.enabled} disabled={busy || (!state.enabled && (kind !== 'webhook' && !confirmed || !returns.available))}
        onChange={event => flip(kind, event.target.checked)} />{state.enabled ? `Ligado desde ${time(state.since)}` : 'Desligado'}</label></td>
    </tr>;
  };

  return <section aria-label="Volta ao Bling">
    <h3>Volta ao Bling: nota, situação e rastreio</h3>
    <p>{texts.intro}</p>
    <p>{texts.invoice}</p>
    <p role="note"><strong>{texts.invoice_limit}</strong></p>
    <p>{texts.status}</p>
    <p><strong>{texts.never}</strong></p>
    {returns.part_off_message && <p role="note">{returns.part_off_message}</p>}
    {!returns.available && <p role="alert">Autorize a conta do Bling em Configuração antes de ligar.</p>}
    <div className="rb-scroll" role="region" aria-label="Interruptores da volta ao Bling" tabIndex={0}><table>
      <thead><tr><th>O que volta</th><th>Interruptor</th></tr></thead>
      <tbody>{(['invoice', 'status', 'webhook'] as const).map(row)}</tbody>
    </table></div>
    <p>Na fila: {returns.queue.pending} · em conferência: {returns.queue.uncertain} · recusados: {returns.queue.failed} · gravados no Bling: {returns.queue.done}. Os envios aparecem também na Fila de saída e as recusas em Pendências e conflitos, como os outros.</p>

    <h4>Situação do Bling para cada etapa</h4>
    <p>{texts.status_map}</p>
    <p role="note">{texts.status_warning}</p>
    <fieldset disabled={busy}><legend>Número da situação no Bling</legend>
      {returns.stages.map(({ stage, label }) => <p key={stage}><label htmlFor={`return-stage-${stage}`}>{label}</label>
        <input id={`return-stage-${stage}`} inputMode="numeric" placeholder="sem mudar" value={map[stage]} onChange={event => { setMapError(''); setMap(current => ({ ...current, [stage]: event.target.value.replace(/\D/g, '') })); }} /></p>)}
    </fieldset>
    {mapError && <p role="alert">{mapError}</p>}
    <button type="button" disabled={busy || !mapValid} onClick={() => void saveMap()}>Salvar situações</button>

    <h4>Aviso do Bling (webhook)</h4>
    <p>{texts.webhook}</p>
    <p>{texts.webhook_setup}</p>
    <label htmlFor="return-webhook-url">Endereço para cadastrar no aplicativo do Bling</label>
    <input id="return-webhook-url" readOnly value={webhookUrl} />
    <p>Último aviso: {time(returns.webhook.last_event_at)} · avisos recebidos: {returns.webhook.events}{returns.webhook.entities.length ? ` · tipos avisados: ${returns.webhook.entities.join(', ')}` : ''}.</p>

    <h4>Permissões a marcar no aplicativo do Bling</h4>
    <p>{returns.scopes.note}</p>
    <ul>
      <li>Leitura: {returns.scopes.read.join(', ') || 'nenhuma escolhida ainda'}.</li>
      <li>Escrita: {returns.scopes.write.join(', ') || 'nenhuma (nada volta ao Bling enquanto os interruptores estiverem desligados)'}.</li>
    </ul>

    {asking && <aside className="rb-warning" role="alertdialog" aria-label="Confirmar ligar">
      <p><strong>Ligar {TITLE[asking]}</strong></p>
      <p>{texts[WARNING[asking]]}</p>
      {asking === 'invoice' && <p>{texts.invoice_limit}</p>}
      {asking === 'status' && <p>{texts.status_warning}</p>}
      <label><input id="return-ack" type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />Entendi e quero ligar</label>
      <button type="button" disabled={busy || !ack} onClick={() => void turnOn()}>Ligar</button>
      <button type="button" disabled={busy} onClick={() => { setAsking(null); setAck(false); }}>Cancelar</button>
    </aside>}
  </section>;
}
