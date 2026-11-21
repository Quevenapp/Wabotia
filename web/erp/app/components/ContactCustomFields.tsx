import { useEffect, useRef, useState } from 'react';
import {
  ContactFieldsError, contactFieldDraftValue, contactFieldText, contactFieldsAvailable, contactFieldsCall, contactFieldsPayload,
  type ContactField, type ContactFieldView,
} from '../lib/contact-fields';

// Campos próprios do contato (Preferências › Cadastros › Configurações de clientes e fornecedores › Campos próprios de contato).
// No cadastro (fora da ficha): editáveis, com a mesma validação do servidor, salvos à parte como a Cobrança do contato.
// Na ficha do atendimento (cartão do ERP): só leitura e sem campo sensível não liberado; quem pode editar abre a edição ali mesmo,
// que lê o cadastro inteiro (sensível inclusive) só enquanto edita.
type Pending = { command: string; values: Record<string, string | null>; uncertain: boolean };

export function ContactCustomFields({ contactId, embedded = false, writable = false }: { contactId: string | null; embedded?: boolean; writable?: boolean }) {
  const [editing, setEditing] = useState(!embedded);
  const [view, setView] = useState<ContactFieldView | null>(null), [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({}), [error, setError] = useState(''), [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [pending, setPending] = useState<Pending | null>(null), [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const available = contactFieldsAvailable();
  const audience = embedded && !editing ? 'ficha' : 'cadastro';
  useEffect(() => {
    if (!available || !contactId) return;
    const current = new AbortController(); setLoadError('');
    void contactFieldsCall<ContactFieldView>(`/contato/${encodeURIComponent(contactId)}?para=${audience}`, { signal: current.signal }).then(value => {
      if (current.signal.aborted) return;
      if (!Array.isArray(value.fields) || !value.values || typeof value.values !== 'object') throw new ContactFieldsError('Resposta inválida do servidor. Tente de novo.');
      setView(value); setDraft(Object.fromEntries(value.fields.map(field => [field.id, contactFieldDraftValue(field, value.values[field.id])])));
    }).catch(failure => { if (!current.signal.aborted && !(failure instanceof Error && failure.name === 'AbortError')) setLoadError(failure instanceof Error ? failure.message : 'Não deu para carregar os campos próprios.'); });
    return () => current.abort();
  }, [available, contactId, audience, reload]);
  useEffect(() => () => request.current?.abort(), []);

  // Fora do painel da área (demonstração), os campos próprios não existem: nada aparece.
  if (!available) return null;
  if (!contactId) return embedded ? null : <section className="contact-section contact-custom-fields" aria-label="Campos próprios"><h3 className="catalog-group-title">Campos próprios</h3>
    <p className="real-help">Salve o cadastro para preencher os campos próprios.</p></section>;
  if (loadError) return <section className="contact-section contact-custom-fields" aria-label="Campos próprios"><h3 className="catalog-group-title">Campos próprios</h3>
    <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p></section>;
  if (!view) return null;
  // Sem nenhum campo para este tipo de contato, a seção não ocupa espaço.
  if (!view.fields.length && !view.hidden) return null;

  const send = async (attempt: Pending) => {
    if (request.current) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setNotice(''); setPending(attempt);
    try {
      const result = await contactFieldsCall<ContactFieldView & { saved: boolean }>(`/contato/${encodeURIComponent(contactId)}`, { method: 'PUT', body: { command_id: attempt.command, valores: attempt.values }, signal: current.signal });
      if (current.signal.aborted) return;
      setPending(null); setFieldErrors({}); setNotice('Campos próprios salvos.');
      setView(result); setDraft(Object.fromEntries(result.fields.map(field => [field.id, contactFieldDraftValue(field, result.values[field.id])])));
      if (embedded) setEditing(false);
    } catch (failure) {
      if (current.signal.aborted || (failure instanceof Error && failure.name === 'AbortError')) return;
      const known = failure instanceof ContactFieldsError && failure.status >= 400 && failure.status < 500;
      if (known) {
        setPending(null); setError(failure.message);
        setFieldErrors(Object.fromEntries(failure.fields.filter(item => item.field_id).map(item => [item.field_id!, item.message])));
      } else { setPending({ ...attempt, uncertain: true }); setError('Não deu para confirmar se os campos foram salvos. Use “Conferir resultado” para repetir o mesmo pedido sem duplicar.'); }
    } finally { if (request.current === current) { request.current = null; setBusy(false); } }
  };
  const save = () => {
    if (busy || pending?.uncertain) return;
    const checked = contactFieldsPayload(view.fields, draft);
    if ('error' in checked) { setError(checked.error); setFieldErrors({ [checked.field]: checked.error }); document.getElementById(`contact-field-${checked.field}`)?.focus(); return; }
    void send({ command: crypto.randomUUID(), values: checked.values, uncertain: false });
  };
  const hiddenNote = view.hidden > 0 && <p className="real-help">{view.hidden === 1 ? '1 campo sensível não aparece aqui.' : `${view.hidden} campos sensíveis não aparecem aqui.`} O administrador decide em Preferências › Cadastros.</p>;

  if (embedded && !editing) return <section className="contact-section contact-custom-fields" aria-label="Campos próprios"><h3 className="catalog-group-title">Campos próprios</h3>
    {notice && <p className="real-success" role="status">{notice}</p>}
    <dl className="contact-grid contact-custom-values">{view.fields.map(field => <div key={field.id}><dt>{field.name}</dt><dd>{contactFieldText(field, view.values[field.id]) || '—'}</dd></div>)}</dl>
    {hiddenNote}
    {writable && <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => { setNotice(''); setEditing(true); }}>Editar campos próprios</button></div>}
  </section>;

  const locked = !writable || busy || Boolean(pending?.uncertain);
  const control = (field: ContactField) => {
    const id = `contact-field-${field.id}`, value = draft[field.id] ?? '', bad = fieldErrors[field.id];
    const common = { id, value, disabled: locked, 'aria-invalid': bad ? true : undefined, 'aria-describedby': bad ? `${id}-error` : undefined,
      onChange: (event: { target: { value: string } }) => { setDraft(previous => ({ ...previous, [field.id]: event.target.value })); setFieldErrors(previous => { const { [field.id]: _gone, ...rest } = previous; return rest; }); } };
    if (field.field_type === 'list') return <select {...common}><option value="">Selecione</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
    if (field.field_type === 'boolean') return <select {...common}><option value="">Não informado</option><option value="true">Sim</option><option value="false">Não</option></select>;
    if (field.field_type === 'date') return <input {...common} type="date" min="1900-01-01" max="2100-12-31" />;
    return <input {...common} type="text" inputMode={field.field_type === 'number' ? 'decimal' : undefined} maxLength={field.field_type === 'number' ? 24 : 255} autoComplete="off" />;
  };
  return <section className="contact-section contact-custom-fields" aria-label="Campos próprios"><h3 className="catalog-group-title">Campos próprios</h3>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    <div className="contact-grid">{view.fields.map(field => <div className="form-field" key={field.id}>
      <label htmlFor={`contact-field-${field.id}`}>{field.name}{field.required ? ' *' : ''}{field.sensitive && <span className="status-badge status-neutral" title="Campo sensível: fora das listagens, da ficha do atendimento, da IA e dos bots, salvo se o administrador liberar."> Sensível</span>}</label>
      {control(field)}
      {fieldErrors[field.id] && <small id={`contact-field-${field.id}-error`} className="preference-invalid" role="alert">{fieldErrors[field.id]}</small>}
    </div>)}</div>
    {hiddenNote}
    {writable && <div className="real-editor-actions">
      {pending?.uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send(pending)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
        : <button type="button" className="primary-button" disabled={locked} onClick={save}>{busy ? 'Salvando…' : 'Salvar campos próprios'}</button>}
      {embedded && <button type="button" className="secondary-button" disabled={busy || Boolean(pending?.uncertain)} onClick={() => { setError(''); setFieldErrors({}); setEditing(false); }}>Cancelar</button>}
    </div>}
    {!writable && <p className="real-help">Seu papel no ERP só consulta os contatos.</p>}
    <p className="real-help">Os campos próprios são salvos à parte do restante do cadastro.</p>
  </section>;
}
