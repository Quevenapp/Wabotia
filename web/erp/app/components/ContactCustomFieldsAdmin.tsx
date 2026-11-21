import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  CONTACT_FIELD_ROLES, CONTACT_FIELD_ROLE_LABELS, CONTACT_FIELD_TYPES, CONTACT_FIELD_TYPE_LABELS, ContactFieldsError, contactFieldData, contactFieldDraft,
  contactFieldsAvailable, contactFieldsCall, newOptionKey, type ContactField, type ContactFieldDraft, type ContactFieldList,
} from '../lib/contact-fields';

// Preferências › Cadastros › Configurações de clientes e fornecedores › Campos próprios de contato (Wabotia): os campos que a
// empresa cria para clientes, fornecedores, vendedores e transportadoras. Tipo, obrigatório, para quais tipos de contato, coluna e
// filtro da lista e o campo sensível. Liberar um campo sensível mostra o aviso e fica registrado. Só o administrador altera.
const when = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : '';
type Pending = { path: string; method: string; body: Record<string, unknown>; uncertain: boolean };

export default function ContactCustomFieldsAdmin() {
  const [list, setList] = useState<ContactFieldList | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<{ field: ContactField | null } | null>(null), [removing, setRemoving] = useState<ContactField | null>(null);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null);
  const request = useRef<AbortController | null>(null);
  const available = contactFieldsAvailable();
  useEffect(() => {
    if (!available) return;
    const current = new AbortController();
    void contactFieldsCall<ContactFieldList>('?para=admin', { signal: current.signal }).then(value => { if (!current.signal.aborted) { setList(value); setError(''); } })
      .catch(async failure => {
        if (current.signal.aborted || (failure instanceof Error && failure.name === 'AbortError')) return;
        // Quem não é administrador consulta a lista sem os dados de uso.
        if (failure instanceof ContactFieldsError && failure.status === 403) {
          try { const value = await contactFieldsCall<ContactFieldList>('?para=cadastro', { signal: current.signal }); if (!current.signal.aborted) { setList(value); setError(''); } return; } catch { /* mostra a primeira recusa */ }
        }
        if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Não deu para carregar os campos próprios.');
      });
    return () => current.abort();
  }, [available, reload]);
  useEffect(() => () => request.current?.abort(), []);
  // Fora do painel da área (demonstração), os campos próprios não existem: a seção não aparece.
  if (!available) return null;
  const manage = Boolean(list?.permissions.manage);

  const send = async (attempt: Pending, done: (result: any) => void) => {
    if (request.current) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setNotice(''); setPending(attempt);
    try {
      const result = await contactFieldsCall<any>(attempt.path, { method: attempt.method, body: attempt.body, signal: current.signal });
      if (current.signal.aborted) return;
      setPending(null); done(result);
    } catch (failure) {
      if (current.signal.aborted || (failure instanceof Error && failure.name === 'AbortError')) return;
      if (failure instanceof ContactFieldsError && failure.status >= 400 && failure.status < 500) { setPending(null); setError(failure.message); }
      else { setPending({ ...attempt, uncertain: true }); setError('Não deu para confirmar se a alteração ficou gravada. Use “Conferir resultado” para repetir o mesmo pedido.'); }
    } finally { if (request.current === current) { request.current = null; setBusy(false); } }
  };
  const afterSave = (result: { saved?: boolean; reason?: string; contacts?: number; field?: ContactField }) => {
    if (result.saved) { setEditing(null); setNotice(`Campo “${result.field?.name}” salvo.`); setReload(n => n + 1); return; }
    setError(result.reason === 'duplicate_name' ? 'Já existe um campo com este nome. Escolha outro nome.'
      : result.reason === 'limit' ? 'O limite é de 60 campos próprios de contato. Inative ou exclua um campo que não usa mais.'
        : result.reason === 'type_in_use' ? `O tipo não pode mudar: ${result.contacts} contato(s) já têm este campo preenchido. Crie um campo novo.`
          : result.reason === 'option_in_use' ? `Uma opção removida está em uso em ${result.contacts} contato(s). Troque o valor nesses contatos antes de removê-la.`
            : 'O campo não foi salvo. Confira os dados e tente de novo.');
  };
  const toggleActive = (field: ContactField) => void send({ path: `/${field.id}`, method: 'PATCH', body: { command_id: crypto.randomUUID(), expected_version: field.version, data: { active: !field.active } }, uncertain: false }, afterSave);

  return <section className="preference-section contact-fields-admin" aria-labelledby="contact-fields-admin-title">
    <h3 id="contact-fields-admin-title">Campos próprios de contato</h3>
    <p className="real-help">Crie campos que a sua empresa precisa no cadastro de clientes, fornecedores, vendedores e transportadoras. Eles aparecem no cadastro do contato e na ficha do atendimento, podem virar coluna e filtro da lista e entram na exportação e na importação de contatos (coluna com o nome do campo).</p>
    <p className="real-help">Campo sensível (saúde, documento pessoal, renda…) só aparece no cadastro do contato: fica fora das listagens, da exportação, da ficha do atendimento, da IA e dos bots, a menos que você libere aquele campo.</p>
    {error && <p className="real-alert" role="alert">{error}{!list && <button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button>}</p>}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {pending?.uncertain && !editing && <p><button type="button" className="primary-button" disabled={busy} onClick={() => void send(pending, pending.method === 'POST' && pending.path.endsWith('/excluir') ? afterRemove : afterSave)}>Conferir resultado</button></p>}
    {list === null && !error ? <p role="status">Carregando campos próprios…</p> : list && <>
      {!manage && <p className="real-notice">Somente o administrador do ERP cria e altera campos próprios. Você pode consultar os campos atuais.</p>}
      {list.items.length === 0 ? <p className="real-help">Nenhum campo próprio de contato ainda.</p>
        : <div className="table-scroll" tabIndex={0} role="region" aria-label="Campos próprios de contato"><table className="data-table real-table origin-table"><thead><tr>
          <th scope="col">Nome</th><th scope="col">Tipo</th><th scope="col">Vale para</th><th scope="col">Lista</th><th scope="col">Situação</th>{manage && <th scope="col" className="row-actions">Ações</th>}</tr></thead>
          <tbody>{list.items.map(field => <tr key={field.id}>
            <td>{field.name}{field.required ? ' *' : ''}{field.sensitive && <span className="status-badge status-neutral" title={field.exposed ? `Liberado${field.exposed_by_name ? ` por ${field.exposed_by_name}` : ''}${field.exposed_at ? ` em ${when(field.exposed_at)}` : ''}.` : 'Fora das listagens, da ficha, da IA e dos bots.'}> {field.exposed ? 'Sensível · liberado' : 'Sensível'}</span>}</td>
            <td>{CONTACT_FIELD_TYPE_LABELS[field.field_type]}{field.field_type === 'list' ? ` (${field.options.length})` : ''}</td>
            <td>{field.roles.map(role => CONTACT_FIELD_ROLE_LABELS[role]).join(', ')}</td>
            <td>{[field.list_column && 'coluna', field.list_filter && 'filtro'].filter(Boolean).join(' e ') || '—'}</td>
            <td>{field.active ? 'Ativo' : 'Inativo'}{typeof field.contacts === 'number' ? ` · ${field.contacts} contato(s)` : ''}</td>
            {manage && <td className="row-actions"><button type="button" className="text-button" disabled={busy || Boolean(pending?.uncertain)} onClick={() => { setError(''); setNotice(''); setEditing({ field }); }}>Editar</button>
              <button type="button" className="text-button" disabled={busy || Boolean(pending?.uncertain)} onClick={() => toggleActive(field)}>{field.active ? 'Inativar' : 'Ativar'}</button>
              <button type="button" className="text-button" disabled={busy || Boolean(pending?.uncertain)} onClick={() => { setError(''); setRemoving(field); }}>Excluir</button></td>}
          </tr>)}</tbody></table></div>}
      {manage && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy || Boolean(pending?.uncertain) || list.items.length >= list.limit} onClick={() => { setError(''); setNotice(''); setEditing({ field: null }); }}>Adicionar campo</button>
        {list.items.length >= list.limit && <span className="real-help">Limite de {list.limit} campos atingido.</span>}</div>}
    </>}
    {editing && <FieldDialog field={editing.field} busy={busy} pending={pending} error={error} onClose={() => { if (!busy) { setEditing(null); setPending(null); setError(''); } }}
      onSave={attempt => void send(attempt, afterSave)} />}
    {removing && <Modal title="Excluir campo próprio" onClose={() => { if (!busy) setRemoving(null); }} actions={<>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setRemoving(null)}>Cancelar</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void send({ path: `/${removing.id}/excluir`, method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: removing.version }, uncertain: false }, afterRemove)}>{busy ? 'Excluindo…' : 'Excluir'}</button></>}>
      <p>Excluir o campo “{removing.name}”? Campo já preenchido em algum contato não pode ser excluído: inative-o para ele sair do cadastro sem perder os valores.</p>
    </Modal>}
  </section>;

  function afterRemove(result: { deleted?: boolean; contacts?: number }) {
    setRemoving(null);
    if (result.deleted) { setNotice('Campo excluído.'); setReload(n => n + 1); }
    else setError(`O campo está preenchido em ${result.contacts} contato(s) e não pode ser excluído. Use “Inativar” para tirá-lo do cadastro sem perder os valores.`);
  }
}

function FieldDialog({ field, busy, pending, error, onClose, onSave }: { field: ContactField | null; busy: boolean; pending: Pending | null; error: string; onClose: () => void; onSave: (attempt: Pending) => void }) {
  const [draft, setDraft] = useState<ContactFieldDraft>(() => contactFieldDraft(field)), [problem, setProblem] = useState(''), [ack, setAck] = useState(false);
  const set = <K extends keyof ContactFieldDraft>(key: K, value: ContactFieldDraft[K]) => { setDraft(previous => ({ ...previous, [key]: value })); setProblem(''); };
  const exposing = draft.sensitive && draft.exposed && !field?.exposed;
  const typeLocked = Boolean(field && (field.contacts ?? 0) > 0);
  const submit = () => {
    if (pending?.uncertain) { onSave(pending); return; }
    const checked = contactFieldData(draft, field);
    if ('error' in checked) { setProblem(checked.error); document.getElementById(`contact-field-admin-${checked.field}`)?.focus(); return; }
    if (checked.exposing && !ack) { setProblem('Para liberar um campo sensível, leia o aviso e marque a confirmação.'); return; }
    const data = { ...checked.data, ...(checked.exposing ? { exposure_ack: true } : {}) };
    onSave(field ? { path: `/${field.id}`, method: 'PATCH', body: { command_id: crypto.randomUUID(), expected_version: field.version, data }, uncertain: false }
      : { path: '', method: 'POST', body: { command_id: crypto.randomUUID(), data }, uncertain: false });
  };
  return <Modal title={field ? 'Editar campo próprio' : 'Adicionar campo próprio'} onClose={onClose} actions={<>
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancelar</button>
    <button type="button" className="primary-button" disabled={busy} onClick={submit}>{busy ? 'Salvando…' : pending?.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    <div className="contact-field-dialog">
      {(problem || error) && <p className="real-alert" role="alert">{problem || error}</p>}
      <fieldset disabled={busy || Boolean(pending?.uncertain)}>
        <div className="form-field"><label htmlFor="contact-field-admin-name">Nome do campo *</label><input id="contact-field-admin-name" maxLength={60} value={draft.name} onChange={event => set('name', event.target.value)} autoComplete="off" /></div>
        <div className="form-field"><label htmlFor="contact-field-admin-type">Tipo</label><select id="contact-field-admin-type" value={draft.field_type} disabled={typeLocked}
          title={typeLocked ? 'Já há contatos com este campo preenchido: o tipo não muda.' : undefined} onChange={event => set('field_type', event.target.value as ContactFieldDraft['field_type'])}>
          {CONTACT_FIELD_TYPES.map(type => <option key={type} value={type}>{CONTACT_FIELD_TYPE_LABELS[type]}</option>)}</select></div>
        {draft.field_type === 'list' && <fieldset className="form-field" id="contact-field-admin-options" tabIndex={-1}><legend>Opções da lista *</legend>
          {draft.options.map((option, index) => <div key={option.key} className="contact-person-search">
            <input aria-label={`Opção ${index + 1}`} maxLength={60} value={option.label} onChange={event => set('options', draft.options.map(item => item.key === option.key ? { ...item, label: event.target.value } : item))} />
            <button type="button" className="text-button" onClick={() => set('options', draft.options.filter(item => item.key !== option.key))}>Remover</button></div>)}
          {draft.options.length < 50 && <button type="button" className="secondary-button" onClick={() => set('options', [...draft.options, { id: null, label: '', key: newOptionKey() }])}>Adicionar opção</button>}</fieldset>}
        <fieldset className="form-field" id="contact-field-admin-roles" tabIndex={-1}><legend>Vale para *</legend>
          {CONTACT_FIELD_ROLES.map(role => <label key={role}><input type="checkbox" checked={draft.roles.includes(role)} onChange={event => set('roles', event.target.checked ? [...draft.roles, role] : draft.roles.filter(item => item !== role))} />{CONTACT_FIELD_ROLE_LABELS[role]}</label>)}</fieldset>
        <label><input type="checkbox" checked={draft.required} onChange={event => set('required', event.target.checked)} />Obrigatório no cadastro do contato</label>
        <label><input type="checkbox" checked={draft.sensitive} onChange={event => { set('sensitive', event.target.checked); if (!event.target.checked) set('exposed', false); }} />Campo sensível</label>
        {draft.sensitive && <div className="real-notice">
          <p>Campo sensível só aparece no cadastro do contato. Fica fora das listagens, da exportação, da ficha do atendimento, da IA e dos bots.</p>
          <label><input type="checkbox" checked={draft.exposed} onChange={event => { set('exposed', event.target.checked); setAck(false); }} />Liberar este campo para listagens, exportação, ficha do atendimento, IA e bots</label>
          {field?.exposed && field.exposed_at && <p className="real-help">Liberado{field.exposed_by_name ? ` por ${field.exposed_by_name}` : ''} em {when(field.exposed_at)}.</p>}
          {exposing && <div role="alert"><p><strong>Atenção:</strong> liberado, o valor deste campo passa a aparecer na lista de contatos, na exportação, na ficha do atendimento e pode ser lido pela IA e pelos bots que têm acesso aos contatos. A liberação fica registrada com o seu nome e a data.</p>
            <label><input type="checkbox" checked={ack} onChange={event => { setAck(event.target.checked); setProblem(''); }} />Li o aviso e quero liberar este campo</label></div>}
        </div>}
        <label title={draft.sensitive && !draft.exposed ? 'Campo sensível não liberado não vira coluna.' : undefined}><input type="checkbox" checked={draft.list_column && (!draft.sensitive || draft.exposed)} disabled={draft.sensitive && !draft.exposed} onChange={event => set('list_column', event.target.checked)} />Mostrar como coluna na lista de contatos</label>
        <label title={draft.sensitive && !draft.exposed ? 'Campo sensível não liberado não vira filtro.' : undefined}><input type="checkbox" checked={draft.list_filter && (!draft.sensitive || draft.exposed)} disabled={draft.sensitive && !draft.exposed} onChange={event => set('list_filter', event.target.checked)} />Usar como filtro da lista de contatos</label>
        <label><input type="checkbox" checked={draft.active} onChange={event => set('active', event.target.checked)} />Ativo</label>
      </fieldset>
    </div>
  </Modal>;
}
