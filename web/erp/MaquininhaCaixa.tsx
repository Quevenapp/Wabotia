// Frente de caixa › Cartão na maquininha: com a maquininha integrada ligada e o caixa com terminal, "Finalizar venda" com
// parcelas na forma de débito ou crédito da maquininha salva a venda, manda o valor para a maquininha do caixa e mostra
// "Aguardando pagamento na maquininha". Aprovado, a Frente de caixa finaliza a venda pelo comando de sempre, com bandeira,
// parcelas, autorização e NSU na observação da parcela. Recusado ou cancelado, a venda continua aberta com o motivo.
// Resposta que não chegou nunca é reenviada às cegas: o mesmo comando é conferido no servidor, que consulta o provedor.
import { useEffect, useRef, useState } from 'react';
import { Modal } from './app/components/Modal';
import {
  cancelTerminalPayment, chargeTerminal, resendTerminalPayment, terminalApiAvailable, terminalPayment, terminalSalePayments, terminalSettings,
  type TerminalKind, type TerminalPayment, type TerminalSettings,
} from './maquininha-api.ts';
import './maquininha.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';
const money = (cents: string | bigint) => { const value = BigInt(cents); return `R$ ${(value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(value % 100n).padStart(2, '0')}`; };
const POLL_MS = 2_000;

/** A configuração da maquininha para a Frente de caixa (null fora do painel da área, desligada ou sem leitura). */
export function useTerminalConfig(scope: string): TerminalSettings | null {
  const [value, setValue] = useState<{ scope: string; settings: TerminalSettings | null }>({ scope: '', settings: null });
  useEffect(() => {
    if (!scope || !terminalApiAvailable()) return;
    const request = new AbortController();
    terminalSettings(request.signal).then(settings => setValue({ scope, settings: settings.ligado ? settings : null }), () => { if (!request.signal.aborted) setValue({ scope, settings: null }); });
    return () => request.abort();
  }, [scope]);
  return value.scope === scope ? value.settings : null;
}

/** A maquininha do caixa, quando a integração está pronta para ele. */
export const terminalForStore = (settings: TerminalSettings | null, store: string | null | undefined) =>
  settings?.ligado && store ? settings.caixas.find(item => item.id === store && item.terminal) ?? null : null;

type Step = { kind: 'loading' } | { kind: 'choose' } | { kind: 'payment'; payment: TerminalPayment } | { kind: 'unknown'; error: string };

/**
 * Diálogo do caixa: escolhe as parcelas (crédito), envia, acompanha e devolve o pagamento aprovado. A venda já está salva.
 * Ao abrir, retoma a cobrança da venda que ainda está em andamento ou aprovada sem a venda finalizada (nunca envia outra por cima).
 */
export function TerminalChargeDialog({ saleId, saleNumber, store, terminalName, kind, amountCents, maxInstallments, finishing, onApproved, onClose }: {
  saleId: string; saleNumber: string | null; store: string; terminalName: string; kind: TerminalKind; amountCents: bigint; maxInstallments: number; finishing: boolean;
  onApproved: (payment: TerminalPayment) => void; onClose: (notice: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'loading' }), [installments, setInstallments] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmResend, setConfirmResend] = useState(false);
  const command = useRef<string>(globalThis.crypto.randomUUID());
  const approved = useRef(onApproved); approved.current = onApproved;
  const delivered = useRef<string | null>(null);

  const show = (payment: TerminalPayment) => {
    setStep({ kind: 'payment', payment });
    if (payment.situacao === 'aprovado' && delivered.current !== payment.id) { delivered.current = payment.id; approved.current(payment); }
  };
  // Retoma a cobrança da venda em andamento (ou aprovada sem finalizar).
  useEffect(() => {
    const request = new AbortController();
    terminalSalePayments(saleId, request.signal).then(({ pagamentos }) => {
      const open = pagamentos.find(item => item.em_andamento || (item.situacao === 'aprovado' && !item.venda_concluida));
      if (open) show(open); else setStep({ kind: 'choose' });
    }, reason => { if (!request.signal.aborted) { setStep({ kind: 'choose' }); setError(message(reason)); } });
    return () => request.abort();
  }, [saleId]);
  // Acompanha a cobrança: pergunta ao servidor (que consulta o provedor) de 2 em 2 segundos enquanto estiver em andamento.
  const current = step.kind === 'payment' ? step.payment : null;
  useEffect(() => {
    if (!current?.em_andamento) return;
    const request = new AbortController();
    const timer = globalThis.setTimeout(() => {
      terminalPayment(current.id, request.signal).then(({ pagamento }) => show(pagamento), reason => { if (!request.signal.aborted) { setError(message(reason)); setStep({ kind: 'payment', payment: { ...current } }); } });
    }, POLL_MS);
    return () => { request.abort(); globalThis.clearTimeout(timer); };
  }, [current]);

  const send = async () => {
    setBusy(true); setError('');
    try { show((await chargeTerminal({ venda: saleId, caixa: store, tipo: kind, parcelas: kind === 'debito' ? 1 : installments, comando: command.current })).pagamento); }
    catch (reason) {
      const uncertain = Boolean((reason as { uncertain?: boolean }).uncertain);
      // Sem resposta: o mesmo comando, conferido de novo, nunca cria outra cobrança.
      if (uncertain) setStep({ kind: 'unknown', error: message(reason) });
      else setError(message(reason) || 'A cobrança não foi para a maquininha.');
    } finally { setBusy(false); }
  };
  const act = async (run: () => Promise<{ pagamento: TerminalPayment }>, fallback: string) => {
    setBusy(true); setError('');
    try { show((await run()).pagamento); } catch (reason) { setError(message(reason) || fallback); } finally { setBusy(false); setConfirmResend(false); }
  };
  const again = () => { command.current = globalThis.crypto.randomUUID(); delivered.current = null; setStep({ kind: 'choose' }); setError(''); };
  const closed = (payment: TerminalPayment | null) => payment && ['recusado', 'cancelado', 'erro'].includes(payment.situacao)
    ? `A venda continua aberta: ${payment.motivo ?? payment.situacao_rotulo}` : '';
  const pending = current?.em_andamento ?? false;
  const title = current?.situacao === 'aprovado' ? 'Pagamento aprovado na maquininha' : pending ? 'Aguardando pagamento na maquininha' : 'Cartão na maquininha';

  const actions = <>
    {step.kind === 'choose' && <>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onClose('')}>Voltar para a venda</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Enviando…' : 'Enviar para a maquininha'}</button>
    </>}
    {step.kind === 'unknown' && <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir a cobrança'}</button>}
    {current && pending && <>
      {current.pode_reenviar && !confirmResend && <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmResend(true)}>Não apareceu na maquininha</button>}
      {current.pode_cancelar && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => cancelTerminalPayment(current.id), 'A cobrança não foi cancelada.')}>Cancelar cobrança</button>}
    </>}
    {current && ['recusado', 'cancelado', 'erro'].includes(current.situacao) && <>
      <button type="button" className="secondary-button" onClick={() => onClose(closed(current))}>Voltar para a venda</button>
      <button type="button" className="primary-button" onClick={again}>Cobrar de novo</button>
    </>}
    {current?.situacao === 'aprovado' && <>
      <button type="button" className="secondary-button" disabled={finishing} onClick={() => onClose('O pagamento na maquininha já foi aprovado: use “Finalizar venda” para concluir (a maquininha não cobra de novo).')}>Voltar para a venda</button>
      <button type="button" className="primary-button" disabled={finishing} onClick={() => approved.current(current)}>{finishing ? 'Finalizando a venda…' : 'Finalizar a venda'}</button>
    </>}
  </>;

  return <Modal title={title} onClose={() => { if (!pending && !busy && current?.situacao !== 'aprovado' && step.kind !== 'unknown') onClose(closed(current)); }} actions={actions}>
    <div className="maquininha-caixa">
      <p className="maquininha-valor">{kind === 'debito' ? 'Débito' : 'Crédito'} · <strong>{money(current?.valor_centavos ?? amountCents)}</strong>{saleNumber ? ` · venda nº ${saleNumber}` : ''}</p>
      <p className="real-help">Maquininha: {terminalName}</p>
      {step.kind === 'loading' && <p role="status">Conferindo se esta venda já tem cobrança na maquininha…</p>}
      {step.kind === 'choose' && kind === 'credito' && <label>Parcelas no cartão
        <select value={installments} disabled={busy} onChange={event => setInstallments(Number(event.target.value))}>
          {Array.from({ length: Math.max(1, maxInstallments) }, (_, index) => index + 1).map(n => <option key={n} value={n}>{n === 1 ? 'À vista (1x)' : `${n}x de ${money(amountCents / BigInt(n))}`}</option>)}
        </select></label>}
      {step.kind === 'choose' && <p className="real-help">O valor vai para a maquininha do caixa. O cliente passa ou aproxima o cartão nela.</p>}
      {step.kind === 'unknown' && <p className="real-alert" role="alert">{step.error || 'A resposta não chegou.'} A cobrança pode ter ido para a maquininha: use “Conferir a cobrança” (não envia outra).</p>}
      {current && <div className={`maquininha-situacao maquininha-${current.situacao}`} role="status" aria-live="polite">
        <strong>{current.situacao_rotulo}</strong>
        {current.motivo && <span>{current.motivo}</span>}
        {current.situacao === 'aprovado' && <span>{current.observacao}</span>}
        {pending && <span className="real-help">Esta tela confere sozinha. Não feche a venda nem cobre de outro jeito enquanto a maquininha mostra a cobrança.</span>}
      </div>}
      {confirmResend && current && <div className="real-alert" role="alertdialog" aria-label="Confirmar reenvio">
        <p>Confirme olhando a maquininha: a cobrança de {money(current.valor_centavos)} não apareceu nela. Se apareceu, espere o cliente pagar.</p>
        <div className="maquininha-acoes">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmResend(false)}>Apareceu, vou esperar</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void act(() => resendTerminalPayment(current.id), 'A cobrança não foi enviada de novo.')}>Não apareceu, enviar de novo</button>
        </div></div>}
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
