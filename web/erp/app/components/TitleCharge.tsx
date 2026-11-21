import { useEffect, useId, useState } from 'react';
import { blockEnabled } from '../../blocks';
import {
  AUTO_SETTLE_WARNING, chargePreferences, confirmTitleSettlement, generateTitleCharge, pixQrSource, saveChargePreferences, titleChargeAvailable, titleChargeContext,
  type ChargeMethod, type ChargePreferences, type TitleChargeContext, type TitleChargeRecord,
} from '../lib/title-charge';
import './title-charge.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';
const when = (at: number | null) => at ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)) : null;

function ChargeItem({ item, titleId, onChange }: { item: TitleChargeRecord; titleId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const qr = pixQrSource(item.pix_qr);
  const copy = async (text: string) => { try { await globalThis.navigator?.clipboard?.writeText(text); setCopied(true); } catch { setCopied(false); } };
  const confirm = async () => {
    setBusy(true); setError('');
    try { await confirmTitleSettlement(titleId, item.id); onChange(); } catch (reason) { setError(message(reason) || 'A baixa não saiu.'); } finally { setBusy(false); }
  };
  return <li className="title-charge-item">
    <p><strong>{item.forma === 'pix' ? 'Pix' : 'Link de pagamento'}</strong> · {item.valor} · {item.baixa_rotulo}{item.pago_em ? ` · pago em ${when(item.pago_em)}` : ''}</p>
    {item.motivo && <p className="real-help">{item.motivo}</p>}
    {item.pix_copia_e_cola && <div className="whatsapp-send-link"><input readOnly value={item.pix_copia_e_cola} aria-label="Pix copia e cola" onFocus={event => event.currentTarget.select()} />
      <button type="button" className="secondary-button" onClick={() => void copy(item.pix_copia_e_cola!)}>{copied ? 'Copiado' : 'Copiar'}</button></div>}
    {qr && <img className="title-charge-qr" src={qr} alt="QR Code do Pix" width={160} height={160} />}
    {item.link && <p><a href={item.link} target="_blank" rel="noreferrer noopener">{item.forma === 'pix' ? 'Abrir a página do QR Code' : 'Abrir o link de pagamento'}</a>{item.vence_em ? ` · vale até ${when(item.vence_em)}` : ''}</p>}
    {item.pode_confirmar_baixa && <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Baixando…' : 'Confirmar baixa'}</button>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </li>;
}

/**
 * "Cobrança por Pix ou link" da conta a receber: gera pela Cobrança da área, mostra o copia e cola, o QR e o link, a situação
 * (aguardando, baixada sozinha, sugestão de baixa com um clique, pendência). Sem a Cobrança configurada, diz o que falta.
 * Some fora do painel da área, na demonstração e com o Financeiro desligado.
 */
export function TitleChargePanel({ titleId, open }: { titleId: string; open: boolean }) {
  const [context, setContext] = useState<TitleChargeContext | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState<ChargeMethod | null>(null), [version, setVersion] = useState(0);
  const available = titleChargeAvailable() && blockEnabled('erp-financeiro');
  useEffect(() => {
    if (!available) return;
    const request = new AbortController();
    titleChargeContext(titleId, request.signal).then(value => { setContext(value); setError(''); }, reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, [titleId, version, available]);
  if (!available) return null;
  const generate = async (method: ChargeMethod) => {
    setBusy(method); setError('');
    try { await generateTitleCharge(titleId, method); setVersion(value => value + 1); } catch (reason) { setError(message(reason) || 'A cobrança não foi gerada.'); } finally { setBusy(null); }
  };
  const charges = context?.cobrancas ?? [];
  return <section className="title-charge" aria-label="Cobrança por Pix ou link">
    <h3>Cobrança por Pix ou link</h3>
    {context && !context.cobranca_pronta && <p className="real-help">{context.falta}</p>}
    {context && context.cobranca_pronta && <p className="real-help">{context.baixa_automatica
      ? 'Quando o pagamento for confirmado pelo provedor, a conta é baixada sozinha.'
      : 'Quando o pagamento for confirmado pelo provedor, aparece aqui a sugestão de baixa para você confirmar.'}</p>}
    {open && context?.cobranca_pronta && context.conta.aberta && <div className="title-charge-actions">
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void generate('pix')}>{busy === 'pix' ? 'Gerando…' : 'Gerar cobrança Pix'}</button>
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void generate('link')}>{busy === 'link' ? 'Gerando…' : 'Gerar link de pagamento'}</button>
    </div>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {charges.length > 0 && <ul>{charges.slice(0, 5).map(item => <ChargeItem key={item.id} item={item} titleId={titleId} onChange={() => setVersion(value => value + 1)} />)}</ul>}
  </section>;
}

/** Preferências do Financeiro › Contas a receber: "Baixar sozinho as contas pagas por Pix ou link" (só o administrador muda). */
export function ChargeAutoSettlePreference() {
  const [prefs, setPrefs] = useState<ChargePreferences | null>(null), [error, setError] = useState(''), [saved, setSaved] = useState(''), [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(''), [method, setMethod] = useState(''), [asking, setAsking] = useState(false);
  const accountId = useId(), methodId = useId();
  useEffect(() => {
    if (!titleChargeAvailable() || !blockEnabled('erp-financeiro')) return;
    const request = new AbortController();
    chargePreferences(request.signal).then(value => { setPrefs(value); setAccount(value.conta_financeira ?? ''); setMethod(value.forma_pagamento ?? ''); },
      reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, []);
  if (!titleChargeAvailable() || !blockEnabled('erp-financeiro')) return null;
  const save = async (body: Parameters<typeof saveChargePreferences>[0], done: string) => {
    setBusy(true); setError(''); setSaved('');
    try { const value = await saveChargePreferences(body); setPrefs(value); setSaved(done); setAsking(false); }
    catch (reason) { setError(message(reason) || 'A preferência não foi salva.'); } finally { setBusy(false); }
  };
  const choice = { conta_financeira: account || null, forma_pagamento: method || null };
  return <section className="title-charge-preference" aria-label="Baixa das contas pagas por Pix ou link">
    <h2>Baixar sozinho as contas pagas por Pix ou link</h2>
    {!prefs && !error && <p role="status">Carregando…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {prefs && <>
      <p>{prefs.baixar_sozinho ? `Ligada${prefs.ligada_em ? ` desde ${when(prefs.ligada_em)}` : ''}: o Financeiro baixa sozinho as contas pagas por Pix ou link da Cobrança.`
        : 'Desligada: o pagamento confirmado vira uma sugestão de baixa, que a pessoa confirma com um clique na conta.'}</p>
      {!prefs.cobranca_pronta && <p className="real-help">{prefs.falta}</p>}
      <label htmlFor={accountId}>Conta financeira das baixas
        <select id={accountId} value={account} disabled={!prefs.pode_mudar || busy} onChange={event => setAccount(event.target.value)}>
          <option value="">Escolha a conta</option>
          {prefs.contas.filter(item => item.ativa || item.id === account).map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
        </select></label>
      <label htmlFor={methodId}>Forma de pagamento registrada na baixa
        <select id={methodId} value={method} disabled={!prefs.pode_mudar || busy} onChange={event => setMethod(event.target.value)}>
          <option value="">Sem forma de pagamento</option>
          {prefs.formas.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
        </select></label>
      {prefs.pode_mudar ? <div className="title-charge-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(choice, 'Conta e forma salvas.')}>Salvar conta e forma</button>
        {prefs.baixar_sozinho
          ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save({ ...choice, baixar_sozinho: false }, 'Baixa automática desligada.')}>Desligar</button>
          : <button type="button" className="primary-button" disabled={busy || !account} title={account ? undefined : 'Escolha a conta financeira antes de ligar.'} onClick={() => setAsking(true)}>Ligar</button>}
      </div> : <p className="real-help">Só o administrador da área muda esta preferência.</p>}
      {asking && <div className="real-alert" role="alertdialog" aria-label="Aviso">
        <p>{AUTO_SETTLE_WARNING}</p>
        <div className="title-charge-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setAsking(false)}>Cancelar</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void save({ ...choice, baixar_sozinho: true, confirmo: true }, 'Baixa automática ligada.')}>Entendi, ligar</button>
        </div></div>}
      {saved && <p role="status">{saved}</p>}
    </>}
  </section>;
}
