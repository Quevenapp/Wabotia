import { useEffect, useId, useState } from 'react';
import {
  askBank, boletoApiAvailable, boletoContext, boletoPdf, cancelBoleto, changeBoletoDue, confirmBoletoSettlement, registerBoleto,
  type BoletoContext, type BoletoRecord,
} from '../lib/boleto-api';
import './boleto-api.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';
const day = (iso: string | null) => iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso ?? '';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await globalThis.navigator?.clipboard?.writeText(value); setCopied(true); } catch { setCopied(false); } };
  return <div className="boleto-api-copy"><input readOnly value={value} aria-label={label} onFocus={event => event.currentTarget.select()} />
    <button type="button" className="secondary-button" onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</button></div>;
}

function BoletoDetail({ titleId, item, onChange }: { titleId: string; item: BoletoRecord; onChange: (value?: BoletoRecord) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [mode, setMode] = useState<'' | 'vencimento' | 'baixar'>('');
  const [due, setDue] = useState(item.vencimento), [reason, setReason] = useState('');
  const dueId = useId(), reasonId = useId();
  const run = async (what: string, action: () => Promise<{ boleto: BoletoRecord } | void>) => {
    setBusy(what); setError('');
    try { const result = await action(); setMode(''); onChange(result ? result.boleto : undefined); } catch (reason) { setError(message(reason) || 'O banco não respondeu.'); } finally { setBusy(''); }
  };
  const openPdf = () => run('pdf', async () => {
    const url = URL.createObjectURL(await boletoPdf(titleId));
    globalThis.open?.(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  return <div className="boleto-api-detail">
    <p><strong>{item.banco_nome}</strong>{item.homologacao ? ' (homologação, sem valor)' : ''} · {item.valor} · vence {day(item.vencimento)} · {item.situacao_rotulo}</p>
    {item.situacao === 'pago' && <p>{item.baixa_rotulo}{item.pago_em ? ` · pago em ${day(item.pago_em)}` : ''}{item.valor_pago ? ` · ${item.valor_pago}` : ''}{item.pago_por === 'pix' ? ' pelo Pix do boleto' : ''}</p>}
    {item.motivo && <p className="real-help">{item.motivo}</p>}
    {item.nosso_numero && <p className="real-help">Nosso número: {item.nosso_numero}</p>}
    {item.linha_digitavel && <><span className="boleto-api-label">Linha digitável</span><CopyField label="Linha digitável" value={item.linha_digitavel} /></>}
    {item.pix_copia_e_cola && <><span className="boleto-api-label">Pix do boleto (copia e cola)</span><CopyField label="Pix copia e cola do boleto" value={item.pix_copia_e_cola} /></>}
    <div className="boleto-api-actions">
      {item.pdf && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void openPdf()}>{busy === 'pdf' ? 'Gerando…' : 'Abrir PDF do boleto'}</button>}
      {(item.situacao === 'registrado' || item.situacao === 'incerto') && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('banco', () => askBank(titleId))}>{busy === 'banco' ? 'Consultando…' : 'Consultar no banco'}</button>}
      {item.pode_mudar && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setMode(mode === 'vencimento' ? '' : 'vencimento')}>Alterar vencimento</button>}
      {item.pode_mudar && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setMode(mode === 'baixar' ? '' : 'baixar')}>Baixar no banco</button>}
      {item.pode_confirmar_baixa && <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run('baixa', () => confirmBoletoSettlement(titleId))}>{busy === 'baixa' ? 'Baixando…' : 'Confirmar baixa'}</button>}
    </div>
    {mode === 'vencimento' && <div className="boleto-api-form">
      <label htmlFor={dueId}>Novo vencimento no banco</label>
      <input id={dueId} type="date" value={due} onChange={event => setDue(event.target.value)} />
      <p className="real-help">Muda só no banco: a conta no Financeiro continua com o vencimento dela.</p>
      <button type="button" className="primary-button" disabled={Boolean(busy) || !due} onClick={() => void run('vencimento', () => changeBoletoDue(titleId, due))}>{busy === 'vencimento' ? 'Enviando…' : 'Enviar ao banco'}</button>
    </div>}
    {mode === 'baixar' && <div className="boleto-api-form">
      <label htmlFor={reasonId}>Por que baixar o boleto no banco?</label>
      <input id={reasonId} maxLength={200} value={reason} onChange={event => setReason(event.target.value)} />
      <p className="real-help">Depois da baixa o cliente não consegue mais pagar este boleto. A conta continua em aberto no Financeiro.</p>
      <button type="button" className="primary-button" disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => void run('baixar', () => cancelBoleto(titleId, reason.trim()))}>{busy === 'baixar' ? 'Baixando…' : 'Baixar no banco'}</button>
    </div>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </div>;
}

/**
 * "Boleto pelo banco" da conta a receber: registra pela API do banco da conta financeira, mostra linha digitável, Pix do boleto
 * híbrido, PDF, situação no banco e a baixa (sugestão com um clique, baixada sozinha ou pendência). Sem conta financeira pela API,
 * diz onde configurar. Some fora do painel da área, na demonstração e com a Cobrança bancária desligada.
 */
export function TitleBoletoPanel({ titleId, open }: { titleId: string; open: boolean }) {
  const [context, setContext] = useState<BoletoContext | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  const [account, setAccount] = useState(''), accountId = useId();
  const available = boletoApiAvailable();
  useEffect(() => {
    if (!available) return;
    const request = new AbortController();
    boletoContext(titleId, request.signal).then(value => { setContext(value); setError(''); setAccount(current => current || value.contas_financeiras.find(item => item.pronta)?.id || ''); },
      reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, [titleId, version, available]);
  if (!available) return null;
  const ready = context?.contas_financeiras.filter(item => item.pronta) ?? [];
  const chosen = context?.contas_financeiras.find(item => item.id === account);
  const live = context?.boleto && ['registrado', 'incerto', 'registrando', 'pago'].includes(context.boleto.situacao) ? context.boleto : null;
  const register = async () => {
    setBusy(true); setError('');
    try { await registerBoleto(titleId, account || null); setVersion(value => value + 1); } catch (reason) { setError(message(reason) || 'O boleto não foi registrado.'); setVersion(value => value + 1); } finally { setBusy(false); }
  };
  if (context && !context.contas_financeiras.length && !context.boleto) return <section className="boleto-api" aria-label="Boleto pelo banco">
    <h3>Boleto pelo banco</h3><p className="real-help">{context.falta}</p></section>;
  return <section className="boleto-api" aria-label="Boleto pelo banco">
    <h3>Boleto pelo banco</h3>
    {!context && !error && <p role="status">Carregando…</p>}
    {context?.boleto && <BoletoDetail key={context.boleto.id} titleId={titleId} item={context.boleto} onChange={() => setVersion(value => value + 1)} />}
    {open && context && context.conta.aberta && (!live || live.situacao === 'incerto') && <div className="boleto-api-form">
      {context.contas_financeiras.length > 1 && <><label htmlFor={accountId}>Conta financeira do boleto</label>
        <select id={accountId} value={account} onChange={event => setAccount(event.target.value)}>
          {context.contas_financeiras.map(item => <option key={item.id} value={item.id} disabled={!item.pronta}>{item.banco_nome}{item.ambiente === 'sandbox' ? ' (homologação)' : ''}{item.pronta ? '' : ' — falta configurar'}</option>)}
        </select></>}
      {chosen && !chosen.pronta && <p className="real-help">{chosen.falta}</p>}
      {!ready.length && context.contas_financeiras[0]?.falta && <p className="real-help">{context.contas_financeiras[0].falta}</p>}
      <p className="real-help">O boleto sai com o saldo e o vencimento da conta. Quando o banco confirmar o pagamento, aparece aqui a sugestão de baixa (ou a conta é baixada sozinha, se o administrador ligou a opção nas Preferências de Contas a receber).</p>
      <button type="button" className="primary-button" disabled={busy || !ready.length || (chosen ? !chosen.pronta : false)} onClick={() => void register()}>
        {busy ? 'Registrando no banco…' : live?.situacao === 'incerto' ? 'Conferir e registrar de novo' : 'Registrar boleto no banco'}</button>
    </div>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {context && context.historico.length > 0 && <details><summary>Boletos anteriores desta conta</summary><ul>{context.historico.map(item =>
      <li key={item.id}>{item.banco_nome} · {item.valor} · vence {day(item.vencimento)} · {item.situacao_rotulo}{item.motivo ? ` · ${item.motivo}` : ''}</li>)}</ul></details>}
  </section>;
}
