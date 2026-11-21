import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  EMAIL_PAYMENT_LABELS, EMAIL_SETUP_HINT, EmailSendError, emailButtonState, emailHistory, emailSize, newEmailKey, parseAddresses, prepareEmail, resendEmail, sendEmail,
  useEmailSituation, validAddress, type EmailDocType, type EmailPayment, type EmailPreparation, type EmailSendRecord,
} from '../lib/email-send';
import './email-send.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';

/**
 * "Enviar por e-mail": o destinatário sugerido pelo cadastro (editável), as cópias, o assunto e o texto do modelo das Preferências
 * (com as variáveis, preenchidas no envio), os anexos e os envios anteriores com Reenviar. Sem o e-mail da instalação configurado,
 * diz onde configurar. Nada sai sem a confirmação; o servidor confere tudo de novo.
 */
export function EmailSendDialog({ type, id, onClose, onSent }: { type: EmailDocType; id: string; onClose: () => void; onSent?: (record: EmailSendRecord) => void }) {
  const [prep, setPrep] = useState<EmailPreparation | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [to, setTo] = useState(''), [copies, setCopies] = useState(''), [subject, setSubject] = useState(''), [body, setBody] = useState(''), [xml, setXml] = useState(false);
  const [payment, setPayment] = useState<EmailPayment | null>(null), [busy, setBusy] = useState(''), [done, setDone] = useState<EmailSendRecord | null>(null);
  const [history, setHistory] = useState<EmailSendRecord[]>([]);
  const key = useRef(newEmailKey()), toId = useId(), ccId = useId(), subjectId = useId(), bodyId = useId(), xmlId = useId(), paymentId = useId();
  const touched = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setError('');
    prepareEmail(type, id, { pagamento: payment }, request.signal).then(value => {
      setPrep(value); setHistory(value.envios); setLoading(false);
      // Primeira leitura: os campos começam com a sugestão; depois, só o que a pessoa não mexeu.
      if (!touched.current) { setTo(value.para ?? ''); setCopies(value.copias.join(', ')); setSubject(value.modelo.assunto); setBody(value.modelo.mensagem); }
      key.current = newEmailKey();
    }, reason => { if (!request.signal.aborted) { setError(message(reason) || 'Não deu para preparar o envio.'); setLoading(false); } });
    return () => request.abort();
  }, [type, id, payment]);

  const cc = parseAddresses(copies);
  const ready = prep?.email.configurado === true;
  const problem = !prep ? '' : !ready ? prep.email.aviso ?? EMAIL_SETUP_HINT : !validAddress(to) ? 'Informe um e-mail válido para o destinatário.'
    : cc.invalid.length ? `Cópia inválida: ${cc.invalid.join(', ')}.` : cc.valid.length > 5 ? 'Use no máximo 5 cópias.' : !subject.trim() ? 'Informe o assunto.' : !body.trim() ? 'Informe a mensagem.' : '';
  const outside = prep && validAddress(to) && !prep.cadastro.includes(to.trim().toLowerCase());
  const edit = <T,>(set: (value: T) => void) => (value: T) => { touched.current = true; set(value); };

  const run = async () => {
    if (!prep || busy || problem) return;
    setBusy('enviar'); setError('');
    try {
      const chosen = prep.pagamento?.escolha;
      const result = await sendEmail(type, id, { para: to.trim().toLowerCase(), copias: cc.valid, assunto: subject, mensagem: body,
        ...(prep.xml_opcional ? { xml } : {}), ...(chosen ? { pagamento: chosen } : {}) }, key.current);
      setDone(result.envio); setHistory(list => [result.envio, ...list.filter(item => item.id !== result.envio.id)]); onSent?.(result.envio);
    } catch (reason) {
      setError(message(reason) || 'O e-mail não saiu.');
      if (!(reason instanceof EmailSendError) || reason.code !== 'erp_email_network') key.current = newEmailKey();
    } finally { setBusy(''); }
  };
  const resend = async (record: EmailSendRecord) => {
    if (busy) return;
    setBusy(record.id); setError('');
    try {
      const result = await resendEmail(type, id, record.id, newEmailKey());
      setHistory(list => [result.envio, ...list]); onSent?.(result.envio);
    } catch (reason) { setError(message(reason) || 'O e-mail não saiu de novo.'); }
    finally { setBusy(''); }
  };

  const actions = done ? <button type="button" className="primary-button" onClick={onClose}>Fechar</button>
    : <><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Cancelar</button>
      <button type="button" className="primary-button" disabled={Boolean(busy) || loading || Boolean(problem)} title={problem || undefined} onClick={() => void run()}>{busy === 'enviar' ? 'Enviando…' : 'Enviar'}</button></>;

  return <Modal title="Enviar por e-mail" onClose={() => { if (!busy) onClose(); }} actions={actions}>
    <div className="email-send">
      {!prep && loading && <p role="status">Preparando o envio…</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {prep && <>
        <p><strong>{prep.documento.titulo}</strong>{prep.documento.cliente ? <> · {prep.documento.cliente}</> : null}</p>
        {!ready && <p className="real-alert" role="alert">{prep.email.aviso ?? EMAIL_SETUP_HINT}</p>}
        {done ? <p className="email-send-done" role="status">{done.resumo} · {done.estado_rotulo}{done.motivo ? ` (${done.motivo})` : ''}.</p> : <>
          <label htmlFor={toId}>Para
            <input id={toId} type="email" inputMode="email" maxLength={254} value={to} list={`${toId}-cadastro`} disabled={Boolean(busy)} onChange={event => edit(setTo)(event.target.value)} />
            <datalist id={`${toId}-cadastro`}>{prep.cadastro.map(item => <option key={item} value={item} />)}</datalist></label>
          {prep.sem_email_no_cadastro && !to && <p className="real-help">{prep.sem_email_no_cadastro}</p>}
          {outside && <p className="real-help">Este e-mail não está no cadastro: o envio fica registrado como enviado a endereço fora do cadastro.</p>}
          <label htmlFor={ccId}>Cópias (separe por vírgula, até 5)
            <input id={ccId} type="text" inputMode="email" maxLength={600} value={copies} disabled={Boolean(busy)} onChange={event => edit(setCopies)(event.target.value)} /></label>
          {prep.pagamento && <label htmlFor={paymentId}>Como o cliente paga
            <select id={paymentId} value={prep.pagamento.escolha} disabled={Boolean(busy)} onChange={event => setPayment(event.target.value as EmailPayment)}>
              {prep.pagamento.opcoes.map(option => <option key={option} value={option}>{EMAIL_PAYMENT_LABELS[option]}</option>)}
            </select></label>}
          {prep.pagamento?.avisos.map(text => <p key={text} className="real-help">{text}</p>)}
          <label htmlFor={subjectId}>Assunto
            <input id={subjectId} type="text" maxLength={200} value={subject} disabled={Boolean(busy)} onChange={event => edit(setSubject)(event.target.value)} /></label>
          <label htmlFor={bodyId}>Mensagem
            <textarea id={bodyId} rows={8} maxLength={20000} value={body} disabled={Boolean(busy)} onChange={event => edit(setBody)(event.target.value)} /></label>
          <p className="real-help">As variáveis {prep.modelo.variaveis.join(', ')} são preenchidas no envio. O modelo de cada documento fica em Preferências.</p>
          {prep.xml_opcional && <label htmlFor={xmlId} className="email-send-check"><input id={xmlId} type="checkbox" checked={xml} disabled={Boolean(busy)} onChange={event => setXml(event.target.checked)} /> Enviar também o XML do cupom</label>}
          <section className="email-send-preview" aria-label="Prévia">
            <h3>Prévia do modelo</h3>
            <p><strong>{prep.previa.assunto}</strong></p>
            <pre>{prep.previa.mensagem}</pre>
            {prep.anexos.map(file => <p key={file.nome} className="real-help">Anexo: {file.nome} ({emailSize(file.tamanho)})</p>)}
            <p className="real-help">Remetente: {prep.remetente ?? 'o nome da instalação'}{prep.email.remetente ? ` <${prep.email.remetente}>` : ''}{prep.responder_para ? ` · respostas para ${prep.responder_para}` : ''}.</p>
          </section>
          {loading && <p role="status">Conferindo…</p>}
        </>}
        {history.length > 0 && <EmailSendList items={history} onResend={ready ? record => void resend(record) : undefined} busy={busy} />}
      </>}
    </div>
  </Modal>;
}

export function EmailSendList({ items, onResend, busy }: { items: readonly EmailSendRecord[]; onResend?: (record: EmailSendRecord) => void; busy?: string }) {
  return <section className="email-send-history" aria-label="Envios por e-mail"><h3>Envios por e-mail</h3>
    <ul>{items.map(item => <li key={item.id}>{item.resumo} · <span className={`email-send-state is-${item.estado}`}>{item.estado_rotulo}</span>{item.motivo ? ` (${item.motivo})` : ''}{item.pelo_bot ? ' · proposto pelo bot' : ''}
      {onResend && item.para && <> <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => onResend(item)}>{busy === item.id ? 'Reenviando…' : 'Reenviar'}</button></>}</li>)}</ul>
  </section>;
}

/** Botão da tela do documento, com o registro dos envios logo abaixo. Some fora do painel da área e com a parte desligada. */
export function EmailSendButton({ type, id, reason }: { type: EmailDocType; id: string; reason?: string | null }) {
  const situation = useEmailSituation(), state = emailButtonState(type, situation, reason);
  const [open, setOpen] = useState(false), [history, setHistory] = useState<EmailSendRecord[]>([]), [version, setVersion] = useState(0);
  useEffect(() => {
    if (!state) return;
    const request = new AbortController();
    emailHistory(type, id, request.signal).then(value => setHistory(value.envios), () => {});
    return () => request.abort();
  }, [type, id, version, Boolean(state)]);
  if (!state) return null;
  return <div className="email-send-entry">
    <button type="button" className="secondary-button" disabled={state.disabled} title={state.title} onClick={() => setOpen(true)}>Enviar por e-mail</button>
    {history.length > 0 && <EmailSendList items={history.slice(0, 5)} />}
    {open && <EmailSendDialog type={type} id={id} onClose={() => { setOpen(false); setVersion(value => value + 1); }} />}
  </div>;
}
