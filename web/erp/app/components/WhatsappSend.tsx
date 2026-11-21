import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  MODE_LABELS, NO_LINE, PAYMENT_LABELS, WINDOW_LABELS, WhatsappSendError, newKey, prepareWhatsapp, sendWhatsapp, sizeLabel, useWhatsappLines, whatsappButtonState, whatsappHistory,
  type WhatsappDocType, type WhatsappPayment, type WhatsappPreparation, type WhatsappSendRecord,
} from '../lib/whatsapp-send';
import './whatsapp-send.css';

const OTHER = 'outro';
const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';

/**
 * "Enviar pelo WhatsApp": o cliente do documento e os telefones do cadastro, a linha da área, a prévia da mensagem e do anexo e como o
 * envio sai pela regra do WhatsApp (janela de 24 horas, modelo aprovado). Fora da janela sem modelo, oferece copiar o link. Nada sai
 * sem a confirmação; o servidor confere tudo de novo.
 */
export function WhatsappSendDialog({ type, id, onClose, onSent }: { type: WhatsappDocType; id: string; onClose: () => void; onSent?: (record: WhatsappSendRecord) => void }) {
  const [prep, setPrep] = useState<WhatsappPreparation | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState<string | null>(null), [typed, setTyped] = useState(''), [checkedTyped, setCheckedTyped] = useState(''), [line, setLine] = useState<string | null>(null), [xml, setXml] = useState(false);
  const [busy, setBusy] = useState<'' | 'enviar' | 'copiar_link'>(''), [done, setDone] = useState<WhatsappSendRecord | null>(null), [link, setLink] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const [payment, setPayment] = useState<WhatsappPayment | null>(null);
  const key = useRef(newKey()), phoneName = useId(), typedId = useId(), lineId = useId(), xmlId = useId(), paymentId = useId();
  const target = phone === OTHER ? checkedTyped : phone;

  useEffect(() => {
    // "Outro número" ainda sem número conferido: nada a consultar.
    if (prep && phone === OTHER && !checkedTyped) return;
    const request = new AbortController();
    setLoading(true); setError('');
    prepareWhatsapp(type, id, { telefone: target || null, linha: line, xml, pagamento: payment }, request.signal).then(value => {
      setPrep(value); setLoading(false);
      if (phone === null) setPhone(value.telefones[0]?.digitos ?? OTHER);
      if (line === null && value.destino) setLine(value.destino.linha);
      // Cada escolha nova é um envio novo (outra chave de repetição).
      key.current = newKey();
    }, reason => { if (!request.signal.aborted) { setError(message(reason) || 'Não deu para preparar o envio.'); setLoading(false); } });
    return () => request.abort();
  }, [type, id, target, line, xml, payment]);

  const run = async (acao: 'enviar' | 'copiar_link') => {
    const destination = prep?.destino;
    if (!destination || busy) return;
    setBusy(acao); setError('');
    try {
      const chosen = prep?.previa.pagamento?.escolha;
      const result = await sendWhatsapp(type, id, { telefone: destination.digitos, linha: destination.linha, ...(prep?.previa.xml_opcional ? { xml } : {}), ...(chosen ? { pagamento: chosen } : {}), acao }, key.current);
      setDone(result.envio); setLink(result.url); onSent?.(result.envio);
    } catch (reason) { setError(message(reason) || 'O envio não saiu.'); if (reason instanceof WhatsappSendError && reason.code !== 'erp_conversa_network') key.current = newKey(); }
    finally { setBusy(''); }
  };
  const copy = async () => { if (!link) return; try { await globalThis.navigator?.clipboard?.writeText(link); setCopied(true); } catch { setCopied(false); } };
  const destination = phone === OTHER && !checkedTyped ? null : prep?.destino ?? null;
  const blocked = !destination || destination.modo === 'bloqueado';
  const actions = done ? <button type="button" className="primary-button" onClick={onClose}>Fechar</button>
    : <><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Cancelar</button>
      {destination?.pode_copiar_link && <button type="button" className="secondary-button" disabled={Boolean(busy) || loading} onClick={() => void run('copiar_link')}>{busy === 'copiar_link' ? 'Criando link…' : 'Copiar link'}</button>}
      <button type="button" className="primary-button" disabled={Boolean(busy) || loading || blocked} title={blocked ? destination?.motivo ?? prep?.conectar ?? undefined : undefined} onClick={() => void run('enviar')}>{busy === 'enviar' ? 'Enviando…' : 'Enviar'}</button></>;

  return <Modal title="Enviar pelo WhatsApp" onClose={() => { if (!busy) onClose(); }} actions={actions}>
    <div className="whatsapp-send">
      {!prep && loading && <p role="status">Preparando o envio…</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {prep && <>
        <p><strong>{prep.documento.titulo}</strong>{prep.documento.cliente ? <> · {prep.documento.cliente}</> : null}</p>
        {done ? <div className="whatsapp-send-done" role="status">
          <p>{done.resumo} · {done.estado_rotulo}{done.motivo ? ` (${done.motivo})` : ''}.</p>
          {link && <><p>Link de leitura (vale por alguns dias e mostra só este documento):</p>
            <div className="whatsapp-send-link"><input readOnly value={link} aria-label="Link do documento" onFocus={event => event.currentTarget.select()} />
              <button type="button" className="secondary-button" onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</button></div></>}
        </div> : <>
          <fieldset className="whatsapp-send-phones"><legend>Para qual número</legend>
            {prep.telefones.map(item => <label key={item.digitos}><input type="radio" name={phoneName} checked={phone === item.digitos} disabled={Boolean(busy)} onChange={() => setPhone(item.digitos)} /> {item.numero}</label>)}
            {!prep.telefones.length && <p className="real-help">O cadastro do cliente não tem telefone. Digite o número abaixo.</p>}
            <label><input type="radio" name={phoneName} checked={phone === OTHER} disabled={Boolean(busy)} onChange={() => setPhone(OTHER)} /> Outro número</label>
            {phone === OTHER && <div className="whatsapp-send-typed">
              <label htmlFor={typedId}>Número com DDD</label>
              <input id={typedId} inputMode="tel" maxLength={30} value={typed} disabled={Boolean(busy)} onChange={event => setTyped(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setCheckedTyped(typed.trim()); } }} />
              <button type="button" className="secondary-button" disabled={!typed.trim() || Boolean(busy)} onClick={() => setCheckedTyped(typed.trim())}>Conferir</button>
            </div>}
            {destination?.fora_do_cadastro && <p className="real-help">Este número não está no cadastro do cliente: o envio fica registrado como enviado a número fora do cadastro.</p>}
          </fieldset>
          {prep.linhas.length ? <label htmlFor={lineId}>Linha de WhatsApp
            <select id={lineId} value={line ?? ''} disabled={Boolean(busy)} onChange={event => setLine(event.target.value)}>
              {prep.linhas.map(item => <option key={item.id} value={item.id}>{item.nome}{item.numero ? ` · ${item.numero}` : ''}{item.tipo === 'qr' ? ' (QR)' : ''}</option>)}
            </select></label> : <p className="real-alert" role="alert">{prep.conectar ?? NO_LINE}.</p>}
          {prep.previa.pagamento && <label htmlFor={paymentId}>Como o cliente paga
            <select id={paymentId} value={prep.previa.pagamento.escolha} disabled={Boolean(busy)} onChange={event => setPayment(event.target.value as WhatsappPayment)}>
              {prep.previa.pagamento.opcoes.map(option => <option key={option} value={option}>{PAYMENT_LABELS[option]}</option>)}
            </select></label>}
          {prep.previa.pagamento?.avisos.map(text => <p key={text} className="real-help">{text}</p>)}
          {prep.previa.xml_opcional && <label htmlFor={xmlId} className="whatsapp-send-check"><input id={xmlId} type="checkbox" checked={xml} disabled={Boolean(busy)} onChange={event => setXml(event.target.checked)} /> Enviar também o XML da nota</label>}
          <section className="whatsapp-send-preview" aria-label="Prévia">
            <h3>Prévia</h3>
            <pre>{prep.previa.texto}</pre>
            {prep.previa.anexos.map(file => <p key={file.nome} className="real-help">Anexo: {file.nome} ({sizeLabel(file.tamanho)})</p>)}
          </section>
          {destination && <div className={destination.modo === 'bloqueado' ? 'real-alert' : 'real-help'} role="status">
            <p>{WINDOW_LABELS[destination.janela]} {MODE_LABELS[destination.modo]}</p>
            {destination.motivo && <p>{destination.motivo}</p>}
            {destination.conversa_nova && destination.modo !== 'bloqueado' && <p>Não há conversa com este número nesta linha: abre uma nova, atribuída a você.</p>}
          </div>}
          {loading && <p role="status">Conferindo…</p>}
        </>}
        {prep.envios.length > 0 && <WhatsappSendList items={prep.envios} />}
      </>}
    </div>
  </Modal>;
}

export function WhatsappSendList({ items }: { items: readonly WhatsappSendRecord[] }) {
  return <section className="whatsapp-send-history" aria-label="Envios pelo WhatsApp"><h3>Envios pelo WhatsApp</h3>
    <ul>{items.map(item => <li key={item.id}>{item.resumo} · <span className={`whatsapp-send-state is-${item.estado}`}>{item.estado_rotulo}</span>{item.motivo ? ` (${item.motivo})` : ''}{item.pelo_bot ? ' · proposto pelo bot' : ''}</li>)}</ul>
  </section>;
}

/** Botão da tela do documento, com o registro dos envios logo abaixo. Some fora do painel da área e com a parte desligada. */
export function WhatsappSendButton({ type, id, reason }: { type: WhatsappDocType; id: string; reason?: string | null }) {
  const lines = useWhatsappLines(), state = whatsappButtonState(type, lines, reason);
  const [open, setOpen] = useState(false), [history, setHistory] = useState<WhatsappSendRecord[]>([]), [version, setVersion] = useState(0);
  useEffect(() => {
    if (!state) return;
    const request = new AbortController();
    whatsappHistory(type, id, request.signal).then(value => setHistory(value.envios), () => {});
    return () => request.abort();
  }, [type, id, version, Boolean(state)]);
  if (!state) return null;
  return <div className="whatsapp-send-entry">
    <button type="button" className="secondary-button" disabled={state.disabled} title={state.title} onClick={() => setOpen(true)}>Enviar pelo WhatsApp</button>
    {state.disabled && state.title === NO_LINE && <span className="real-help"> {NO_LINE}.</span>}
    {history.length > 0 && <WhatsappSendList items={history.slice(0, 5)} />}
    {open && <WhatsappSendDialog type={type} id={id} onClose={() => { setOpen(false); setVersion(value => value + 1); }} />}
  </div>;
}
