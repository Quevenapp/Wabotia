import { useEffect, useState } from 'react';
import {
  contactFieldText, contactFieldsAvailable, contactFieldsCall, contactFieldValuesFor, listColumnFields, listFilterFields,
  type ContactField, type ContactFieldList,
} from '../lib/contact-fields';

// Campos próprios de contato na lista de Clientes e fornecedores (Vinki): as definições que a lista pode usar (campo sensível só
// depois de liberado pelo administrador), os valores das colunas da página e os campos do painel de filtros.
export type FieldFilterDraft = Record<string, { value?: string; from?: string; to?: string }>;

/** Definições ativas que a lista vê; vazio na demonstração ou quando a leitura falha (a lista segue sem elas). */
export function useContactFieldDefinitions(enabled: boolean): ContactField[] {
  const [fields, setFields] = useState<ContactField[]>([]);
  useEffect(() => {
    if (!enabled || !contactFieldsAvailable()) return;
    const request = new AbortController();
    void contactFieldsCall<ContactFieldList>('?para=lista', { signal: request.signal }).then(value => { if (!request.signal.aborted && Array.isArray(value.items)) setFields(value.items); }).catch(() => undefined);
    return () => request.abort();
  }, [enabled]);
  return fields;
}

/** Valores das colunas de campos próprios para os contatos da página. */
export function useContactFieldColumnValues(ids: readonly string[], fields: readonly ContactField[], key: string): { values: Map<string, Record<string, string>>; failed: boolean } {
  const [state, setState] = useState<{ key: string; values: Map<string, Record<string, string>>; failed: boolean }>({ key: '', values: new Map(), failed: false });
  const wanted = listColumnFields(fields).length > 0 && ids.length > 0;
  const signature = `${key}:${ids.join(',')}`;
  useEffect(() => {
    if (!wanted) return;
    const request = new AbortController();
    void contactFieldValuesFor(ids, request.signal).then(result => { if (!request.signal.aborted) setState({ key: signature, values: result.values, failed: false }); })
      .catch(() => { if (!request.signal.aborted) setState({ key: signature, values: new Map(), failed: true }); });
    return () => request.abort();
  }, [wanted, signature]);
  return state.key === signature ? state : { values: new Map(), failed: false };
}

export const fieldCellText = (field: ContactField, values: Readonly<Record<string, string>> | undefined) => contactFieldText(field, values?.[field.id]) || '—';

/** Campos de filtro (texto contém; número e data de/até; lista e sim/não pela opção). */
export function ContactFieldFilterInputs({ fields, draft, onChange }: { fields: readonly ContactField[]; draft: FieldFilterDraft; onChange: (next: FieldFilterDraft) => void }) {
  const shown = listFilterFields(fields);
  if (!shown.length) return null;
  const set = (id: string, change: { value?: string; from?: string; to?: string }) => onChange({ ...draft, [id]: { ...draft[id], ...change } });
  return <fieldset className="contact-field-filters"><legend>Campos próprios</legend>{shown.map(field => {
    const id = `contact-field-filter-${field.id}`, item = draft[field.id] ?? {};
    if (field.field_type === 'number' || field.field_type === 'date') {
      const type = field.field_type === 'date' ? 'date' : 'text';
      return <div className="form-field" key={field.id}><span id={`${id}-label`}>{field.name}</span>
        <span className="contact-person-search"><input aria-label={`${field.name}: de`} type={type} inputMode={field.field_type === 'number' ? 'decimal' : undefined} maxLength={24} value={item.from ?? ''} onChange={event => set(field.id, { from: event.target.value })} />
          <input aria-label={`${field.name}: até`} type={type} inputMode={field.field_type === 'number' ? 'decimal' : undefined} maxLength={24} value={item.to ?? ''} onChange={event => set(field.id, { to: event.target.value })} /></span></div>;
    }
    if (field.field_type === 'list' || field.field_type === 'boolean') {
      const options = field.field_type === 'list' ? field.options.map(o => ({ value: o.id, label: o.label })) : [{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não' }];
      return <div className="form-field" key={field.id}><label htmlFor={id}>{field.name}</label><select id={id} value={item.value ?? ''} onChange={event => set(field.id, { value: event.target.value })}>
        <option value="">Todos</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>;
    }
    return <div className="form-field" key={field.id}><label htmlFor={id}>{field.name}</label><input id={id} maxLength={255} value={item.value ?? ''} onChange={event => set(field.id, { value: event.target.value })} /></div>;
  })}</fieldset>;
}
