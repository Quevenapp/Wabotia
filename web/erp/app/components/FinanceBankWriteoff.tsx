import { useEffect, useId, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { financeMoney, type FinanceTitle } from '../lib/real-finance-model';
import { BANK_WRITEOFF_LABEL, BANK_WRITEOFF_PATH, BANK_WRITEOFF_REASON_MAX, BANK_WRITEOFF_TEXT, BANK_WRITEOFF_WARNING, bankWriteoffBody, bankWriteoffFailure, bankWriteoffWhen, bankWriteoffWho, type BankWriteoff } from '../lib/finance-bank-writeoff';
import { erpPorts } from '../../ports';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const status = (error: unknown) => error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : null;
const mfa = (error: unknown) => status(error) === 403 && (error as { code?: unknown }).code === 'ERP_MFA_REQUIRED';

/** Bloco da conta cancelada pela declaração: quem declarou, quando (São Paulo) e o motivo. */
export function BankWriteoffNotice({ writeoff }: { writeoff: BankWriteoff }) {
  return <section className="real-notice" aria-label="Boleto baixado no banco"><strong>Boleto baixado no banco</strong>
    <p>Declarado por {bankWriteoffWho(writeoff)} em {bankWriteoffWhen(writeoff.declared_at)}. A conta foi cancelada sem enviar instrução ao banco.</p>
    <p>Motivo: {writeoff.reason}</p></section>;
}

/**
 * Vinki (junção): declarar que o boleto da remessa já foi baixado no banco para cancelar a conta (title_bank_writeoff). Um command_id
 * por declaração; resultado incerto mantém o mesmo para “Conferir resultado”. Segundo fator exigido: abre o “Confirme que é você” e repete uma vez.
 */
export default function FinanceBankWriteoff({ controller, title, initialReason = '', notice, onClose, onDone }: {
  controller: Pick<AccessController, 'finance'>; title: FinanceTitle; initialReason?: string; notice?: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState(initialReason.slice(0, BANK_WRITEOFF_REASON_MAX)), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const command = useRef<{ id: string; body: ReturnType<typeof bankWriteoffBody> } | null>(null), pending = useRef<AbortController | null>(null), id = useId();
  useEffect(() => () => pending.current?.abort(), []);
  const close = () => { if (!busy) onClose(); };
  const confirm = async () => {
    if (busy || pending.current) return; setError('');
    if (!command.current) { try { const commandId = crypto.randomUUID(); command.current = { id: commandId, body: bankWriteoffBody(title, reason, commandId) }; } catch (failure) { setError((failure as Error).message); return; } }
    const operation = command.current, request = new AbortController(); pending.current = request; setBusy(true);
    const send = () => controller.finance(BANK_WRITEOFF_PATH, { method: 'POST', body: operation.body, signal: request.signal });
    try {
      try { await send(); }
      catch (failure) {
        // Segundo fator da política: a casca pede o código e a mesma declaração (mesmo command_id) vai uma vez de novo.
        const confirmIdentity = erpPorts()?.confirmIdentity;
        if (request.signal.aborted || !mfa(failure) || !confirmIdentity) throw failure;
        await confirmIdentity(); if (request.signal.aborted) return; await send();
      }
      if (request.signal.aborted) return;
      command.current = null; onDone();
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !uncertain && [400, 403, 404, 409].includes(status(failure) ?? 0);
      if (known) command.current = null; setUncertain(!known);
      setError(known ? bankWriteoffFailure(failure) : bankWriteoffFailure(null));
    } finally { if (pending.current === request) pending.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const size = [...reason.trim()].length;
  return <Modal title={BANK_WRITEOFF_LABEL} onClose={close} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={close}>{uncertain ? 'Fechar e conferir depois' : 'Voltar'}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Confirmando…' : uncertain ? 'Conferir resultado' : 'Confirmar e cancelar a conta'}</button></>}>
    <div className="finance-bank-writeoff">
      {notice && <p className="real-help">{notice}</p>}
      <p>{BANK_WRITEOFF_TEXT}</p>
      <dl className="finance-review"><div><dt>Conta</dt><dd>{title.description} · {title.contact_name}</dd></div><div><dt>Parcela</dt><dd>{title.installment}/{title.installments}</dd></div><div><dt>Valor</dt><dd>{financeMoney(title.amount_cents)}</dd></div></dl>
      <p className="real-alert" role="note">{BANK_WRITEOFF_WARNING}</p>
      <div className="form-field"><label htmlFor={id}>Motivo *</label><textarea id={id} rows={3} maxLength={BANK_WRITEOFF_REASON_MAX} required disabled={busy || uncertain} placeholder="Ex.: baixado no internet banking em 20/11, protocolo 123" value={reason} onChange={event => setReason(event.target.value)} /><small className="real-help">{size} de {BANK_WRITEOFF_REASON_MAX} caracteres (mínimo 3).</small></div>
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
