import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { erpPorts } from '../../ports';
import { contactEditorTitle } from '../../contact-editor-labels';
export { contactEditorTitle } from '../../contact-editor-labels';
import type { ProfileVocabulary } from '../../../contact-profile/model';
import { useReferenceOptions } from '../hooks/useReferenceOptions';
import type { PlatformPort } from '../lib/platform-model';
import { AccessError, type AccessController } from '../lib/real-access';
import { CatalogValidationError } from '../lib/catalog-base';
import { badgeClass } from '../lib/origin-list';
import {
  COUNTRY_SUGGESTIONS, FORM_SITUATION_OPTIONS, SECTION_FIELDS, contactFormValues, contactPayload, documentLabel, fieldVisible, requiredApplies, requiredFields, saoPauloToday, suggestedTaxpayer,
  type ContactField, type ContactPerson, type ContactRecord,
} from '../lib/contact-form-model';
import { SITUATION_LABELS, type ContactTypeItem, type ContactTypes } from '../lib/contact-list-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { useContactSave, warningMessage } from './ContactSave';
import { ContactTypeTags } from './ContactTypeTags';
import { ContactTagsField } from './ContactTags';
import { ContactQuickDrawer } from './ContactQuickDrawer';
import { ContactSalesHistory } from './ContactSalesHistory';
import { SellerPicker, type SellerOption } from './SellerPicker';
import { CategoryTreePicker } from './FinanceCategoryTreeSelect';
import { categoryTree, type CategoryNode } from '../lib/finance-registry-model';
import { Icon } from './Icon';
import ContactBilling from './ContactBilling';
import type { CatalogEditorProps } from './CatalogEditor';
import { aborted, errorText } from './catalog-shared';
import ContactFiles, { ContactPhoto } from './ContactFiles';
import { ContactCustomFields } from './ContactCustomFields';
import { cnpjDigits, cnpjFormValues, cnpjLookupBase, lookupCnpj, searchableCnpj, type CnpjData } from '../lib/cnpj-lookup';
import CepLookupButton from './CepLookupButton';
import './contacts.css';
import { blockEnabled, fieldEnabled, availablePayload } from '../../blocks';

// Formulário de Cliente ou Fornecedor no padrão do Origin (lane contatos, CF-00 a CF-50): página única com Dados
// cadastrais, Endereço (Geral | Cobrança), Contato, Dados adicionais (recolhível), Financeiro, Observações e Anexos
// (recolhível). Campos por Tipo da Pessoa, padrões da inclusão, dicas do Origin, obrigatórios das Preferências, avisos de
// CPF/CNPJ, command_id com "Conferir resultado", expected_version e o aviso de saída sem salvar.
type Nature = { id: string; description: string; active: boolean };
const changedAt = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : '';
const BILLING_KEYS = ['billing_postal_code', 'billing_state', 'billing_city', 'billing_district', 'billing_street', 'billing_number', 'billing_complement', 'billing_foreign_state'];
const fullRecord = (record: Record<string, unknown> | null): record is ContactRecord => Boolean(record && typeof record.credit_limit_mode === 'string' && Array.isArray(record.types));

function useOptions<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { value: T | null; error: string } {
  const [state, setState] = useState<{ value: T | null; error: string }>({ value: null, error: '' });
  useEffect(() => {
    const request = new AbortController();
    void load(request.signal).then(value => { if (!request.signal.aborted) setState({ value, error: '' }); }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ value: null, error: failure instanceof AccessError && failure.status === 403 ? 'forbidden' : 'failed' }); });
    return () => request.abort();
  }, deps);
  return state;
}

export function ContactEditor(props: CatalogEditorProps & { vocabulary?: ProfileVocabulary }) {
  const ports = erpPorts();
  const Host = ports?.contactProfileEditor;
  const hosted = Boolean(props.record && !ports?.demo && Host);
  const body = useContactEditorBody(props, hosted);
  return hosted && Host ? <Host {...props} /> : body;
}

export type RawContactEditorProps = CatalogEditorProps & { embeddedProfile?: boolean; vocabulary?: ProfileVocabulary };
/** Corpo bruto: o hospedeiro usa esta entrada e nunca reabre ContactProfile. */
export function RawContactEditor(props: RawContactEditorProps) {
  return <LoadedContactEditor key={`${props.record?.id ?? 'new'}:${props.record?.version ?? 0}`} {...props} />;
}

function LoadedContactEditor(props: RawContactEditorProps) {
  return useContactEditorBody(props);
}

function useContactEditorBody(props: RawContactEditorProps, hosted = false) {
  const { controller, writable } = props;
  const [record, setRecord] = useState<ContactRecord | null>(fullRecord(props.record) ? props.record : null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (hosted || !props.record || fullRecord(props.record)) return;
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/contatos/${props.record.id}`, { signal: request.signal }).then(value => {
      const result = value as { record?: ContactRecord };
      if (request.signal.aborted) return;
      if (result.record?.id !== props.record?.id) throw new AccessError(502);
      setRecord(result.record as ContactRecord);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setLoadError(errorText(failure)); });
    return () => request.abort();
  }, [controller, props.record?.id, hosted]);
  if (props.record && !record) return <section className="real-editor catalog-editor"><h2>{contactEditorTitle(props.vocabulary, props.record.types as string[] | undefined)}</h2>
    {loadError ? <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={props.onClose}>Voltar à listagem</button></p> : <p role="status">Carregando cadastro…</p>}</section>;
  return <ContactForm {...props} record={record} writable={writable} />;
}

function ContactForm({ controller, record, writable, onClose, onSaved, embeddedProfile, vocabulary }: RawContactEditorProps & { record: ContactRecord | null }) {
  const today = saoPauloToday();
  const [values, setValues] = useState<Record<string, string>>(() => contactFormValues(record, today));
  const [types, setTypes] = useState<string[]>(() => record?.types ?? []);
  const [persons, setPersons] = useState<ContactPerson[]>(() => record?.persons ?? []);
  const [seller, setSeller] = useState<SellerOption | null>(() => record?.seller_id ? { id: record.seller_id as string, name: record.seller_name ?? 'Vendedor', code: null } : null);
  const [invalid, setInvalid] = useState<string | null>(null), [focusKey, setFocusKey] = useState(0);
  const [addressTab, setAddressTab] = useState<'geral' | 'cobranca'>('geral'), [extraOpen, setExtraOpen] = useState(true), [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [drawer, setDrawer] = useState(false), [personQuery, setPersonQuery] = useState(''), [personOptions, setPersonOptions] = useState<ContactPerson[]>([]);
  const [contactTypes, setContactTypes] = useState<ContactTypes | null>(null);
  const [required, setRequired] = useState<string[]>([]), [codeHint, setCodeHint] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const saver = useContactSave(controller, record, onSaved);
  const countries = useReferenceOptions(controller as Partial<PlatformPort>, 'paises', values.country ?? '', { enabled: values.person_type === 'E', minLength: 1 });
  const guard = useUnsavedForm({ values, types: [...types].sort(), persons: persons.map(p => p.id), seller: seller?.id ?? null }, saver.busy || saver.uncertain);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (invalid) document.getElementById(`contact-${invalid}`)?.focus(); }, [focusKey]);
  // A refusal of the server that names a field (Campos obrigatórios, valor recusado) highlights it, as the local checks do.
  useEffect(() => {
    const key = saver.errorField; if (!key) return;
    setInvalid(key); setFocusKey(n => n + 1);
    if (BILLING_KEYS.includes(key)) setAddressTab('cobranca'); else if (SECTION_FIELDS.endereco.some(spec => spec.key === key)) setAddressTab('geral');
    if (SECTION_FIELDS.adicionais.some(spec => spec.key === key)) setExtraOpen(true);
  }, [saver.errorField, saver.error]);
  useEffect(() => {
    const request = new AbortController();
    void controller.catalog('/v1/cadastros/tipos-contato', { signal: request.signal }).then(value => { if (!request.signal.aborted && Array.isArray((value as ContactTypes).items)) setContactTypes(value as ContactTypes); }).catch(() => undefined);
    // Preferências > Configurações de clientes e fornecedores: campos obrigatórios e o código sequencial.
    void Promise.resolve().then(() => controller.preferences('/v1/preferencias/cadastros-contatos', { signal: request.signal })).then(value => {
      if (request.signal.aborted) return; const items = (value as { items?: { key: string; value: unknown }[] }).items ?? [];
      const options = items.find(item => item.key === 'contatos.campos_obrigatorios')?.value;
      setRequired(Array.isArray(options) ? requiredFields(options.filter((option): option is string => typeof option === 'string')) : []);
    }).catch(() => undefined);
    if (!record) void controller.catalog('/v1/cadastros/contatos/codigo', { signal: request.signal }).then(value => {
      const result = value as { mode?: string; next_number?: string };
      if (!request.signal.aborted && result.mode === 'sequencial') setCodeHint(`Sequencial: em branco, o código será ${result.next_number}.`);
    }).catch(() => undefined);
    return () => request.abort();
  }, [controller]);
  // Categoria (Origin CF-42): the árvore com busca of the receitas and the despesas (Financeiro > Categorias, SQL 135).
  const financeEnabled = blockEnabled('erp-financeiro'), fiscalEnabled = blockEnabled('erp-fiscal');
  const categories = useOptions<CategoryNode[]>(async signal => !financeEnabled ? [] : (await Promise.all((['receivable', 'payable'] as const).map(async kind => categoryTree(await controller.finance(`/v1/financeiro/categorias-arvore?kind=${kind}`, { signal }), kind).items))).flat(), [controller, financeEnabled]);
  const natures = useOptions<Nature[]>(async signal => !fiscalEnabled ? [] : ((await controller.fiscalInvoices('/v1/notas-fiscais/naturezas?active=true&limit=100', { signal })) as { items: Nature[] }).items, [controller, fiscalEnabled]);
  useEffect(() => {
    if (!personQuery.trim()) { setPersonOptions([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => {
      void controller.catalog(`/v1/cadastros/contatos?${new URLSearchParams({ page: '1', size: '10', q: personQuery.trim(), situation: 'all' })}`, { signal: request.signal }).then(value => {
        if (request.signal.aborted) return; const items = (value as { items?: ContactPerson[] }).items ?? [];
        setPersonOptions(items.filter(item => item.id !== record?.id && !persons.some(person => person.id === item.id)).map(item => ({ id: item.id, name: item.name, code: item.code, situation: item.situation })));
      }).catch(() => { if (!request.signal.aborted) setPersonOptions([]); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, personQuery]);

  const excluded = record?.situation === 'E';
  const locked = !writable || saver.busy || saver.uncertain || excluded;
  const person = values.person_type ?? '';
  const change = (key: string, value: string) => {
    setValues(previous => ({ ...previous, [key]: value, ...(key === 'ie_exempt' ? { taxpayer: suggestedTaxpayer(value === 'true', previous.taxpayer ?? '9'), ...(value === 'true' ? { ie: '' } : {}) } : {}) }));
    saver.setWarnings(null); if (key === invalid) { setInvalid(null); saver.setError(''); }
  };
  // Busca na Receita (pedido do dono, 21/11): CNPJ completo e válido → preenche os campos vazios; o botão refaz e sobrescreve.
  const [receita, setReceita] = useState<{ busy: boolean; note: string; error: string }>({ busy: false, note: '', error: '' });
  const receitaAsked = useRef<string>(record?.document ? cnpjDigits(String(record.document)) : '');
  const receitaRequest = useRef<AbortController | null>(null);
  const canSearchReceita = !locked && cnpjLookupBase() !== null && (person === 'J' || person === '');
  const searchReceita = (force: boolean) => {
    const cnpj = cnpjDigits(values.document ?? '');
    if (!searchableCnpj(cnpj)) { setReceita({ busy: false, note: '', error: 'Digite o CNPJ completo (14 números) para buscar na Receita.' }); return; }
    receitaAsked.current = cnpj;
    receitaRequest.current?.abort(); const request = new AbortController(); receitaRequest.current = request;
    setReceita({ busy: true, note: '', error: '' });
    void lookupCnpj(cnpj, request.signal).then((data: CnpjData) => {
      if (request.signal.aborted) return;
      setValues(previous => ({ ...previous, ...cnpjFormValues(data, previous, force) }));
      saver.setWarnings(null);
      const situacao = data.ativa === false && data.situacao ? ` Atenção: situação na Receita "${data.situacao}".` : '';
      setReceita({ busy: false, error: '', note: `Dados da Receita${data.razao_social ? ` de ${data.razao_social}` : ''} preenchidos${force ? '' : ' nos campos que estavam vazios'}. Confira antes de salvar.${situacao}` });
    }).catch(failure => { if (!aborted(failure)) setReceita({ busy: false, note: '', error: failure instanceof Error ? failure.message : 'A busca na Receita falhou.' }); });
  };
  useEffect(() => () => receitaRequest.current?.abort(), []);
  useEffect(() => {
    const cnpj = cnpjDigits(values.document ?? '');
    if (!canSearchReceita || !searchableCnpj(cnpj) || receitaAsked.current === cnpj) return;
    searchReceita(false);
  }, [values.document, canSearchReceita]);
  const isRequired = (key: string) => fieldEnabled(key) && (key === 'name' || (required.includes(key) && requiredApplies(key, values)));
  const field = (spec: ContactField, extra?: ReactNode) => {
    if (!fieldVisible(spec.key, person)) return null;
    const id = `contact-${spec.key}`, value = values[spec.key] ?? '', hintId = spec.hint ? `${id}-hint` : undefined;
    const label = spec.key === 'document' ? documentLabel(person) : spec.key === 'code' && codeHint ? 'Código' : spec.label;
    const common = { id, value, disabled: locked || (spec.key === 'ie' && values.ie_exempt === 'true'), 'aria-invalid': invalid === spec.key || undefined, 'aria-describedby': [hintId, invalid === spec.key ? 'contact-error' : null].filter(Boolean).join(' ') || undefined,
      onChange: (event: { target: { value: string } }) => change(spec.key, event.target.value) };
    const control = spec.kind === 'textarea' ? <textarea {...common} rows={4} maxLength={spec.max} />
      : spec.kind === 'select' ? <select {...common}>{(spec.key === 'person_type' && !value ? [{ value: '', label: 'Escolha o Tipo da Pessoa' }, ...spec.options!] : spec.options!).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : <input {...common} type={spec.kind === 'date' ? 'date' : spec.kind === 'tel' ? 'tel' : 'text'} inputMode={spec.kind === 'decimal' ? 'decimal' : spec.kind === 'email' ? 'email' : spec.kind === 'url' ? 'url' : undefined}
          maxLength={spec.max} autoComplete="off" list={spec.key === 'country' ? 'contact-countries' : undefined} placeholder={spec.key === 'code' && codeHint ? 'Automático' : undefined} />;
    return <div className={`form-field${spec.kind === 'textarea' ? ' real-field-wide' : ''}`} key={spec.key}>
      <label htmlFor={id}>{label}{isRequired(spec.key) ? ' *' : ''}{spec.hint && <span className="contact-hint" title={spec.hint} aria-hidden="true"><Icon name="circle-info" size={10} /></span>}{extra}</label>
      {control}
      {spec.hint && <small id={hintId} className="real-sr-only">{spec.hint}</small>}
      {spec.key === 'code' && codeHint && <small>{codeHint}</small>}
      {spec.counter && <small className="contact-counter">{value.length}/{spec.max}</small>}
    </div>;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    try { setInvalid(null); saver.save(availablePayload(contactPayload(availablePayload({ ...values, seller_id: seller?.id ?? '' }), types, persons.map(p => p.id), { required: required.filter(fieldEnabled), previous: record, today }))); }
    catch (failure) { if (failure instanceof CatalogValidationError) { setInvalid(failure.field); saver.setError(failure.message); setFocusKey(n => n + 1); if (BILLING_KEYS.includes(failure.field)) setAddressTab('cobranca'); } else throw failure; }
  };
  const typesList: readonly ContactTypeItem[] = contactTypes?.items ?? [];
  const changed = changedAt(record?.updated_at);
  const categoryList = categories.value ?? [], natureList = natures.value ?? [];
  return <section className="real-editor catalog-editor contact-editor" aria-labelledby="catalog-edit-title">
    <header className="real-editor-heading catalog-editor-heading contact-editor-heading"><div><div className="catalog-editor-title"><h2 id="catalog-edit-title" ref={heading} tabIndex={-1}>{contactEditorTitle(vocabulary, types)}</h2>
      {record && <span className={badgeClass(SITUATION_LABELS[record.situation])}>{SITUATION_LABELS[record.situation]}</span>}{!writable && <span className="real-mode">Somente consulta</span>}</div></div>
      <div className="catalog-editor-buttons"><button type="button" className="secondary-button" onClick={() => guard.confirmLeave(onClose)} disabled={saver.busy}>{writable ? 'Cancelar' : 'Voltar'}</button>
        {writable && !excluded && <button className="primary-button" disabled={locked} type="submit" form="catalog-editor-form">{saver.busy ? 'Salvando…' : 'Salvar'}</button>}</div>
      {writable && !excluded && <p className="catalog-required"><span>(*)</span> Campos obrigatórios</p>}</header>
    {excluded && <p className="real-alert" role="status">Cadastro excluído. Para editar, restaure-o na listagem com “Restaurar selecionados”.</p>}
    {record?.source && <p className="real-help">Cadastro importado. As alterações desta tela são registradas no ERP.</p>}
    {saver.error && <p className="real-alert" role="alert" id="contact-error">{saver.error}</p>}
    {saver.warnings && <div className="catalog-warnings" role="alert" aria-labelledby="contact-warnings-title"><h3 id="contact-warnings-title">Confira antes de salvar</h3><ul>{saver.warnings.items.map(item => <li key={item.code}>{warningMessage(item)}</li>)}</ul>
      {!saver.warnings.items.some(item => item.blocked) && <p>Existem cadastros antigos com duplicidade. Salve somente se tiver certeza; a confirmação fica registrada na auditoria do cadastro.</p>}
      <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => saver.setWarnings(null)}>Revisar</button>{!saver.warnings.items.some(item => item.blocked) && <button type="button" className="primary-button" disabled={saver.busy || saver.uncertain} onClick={saver.confirm}>Salvar mesmo assim</button>}</div></div>}
    {saver.uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={saver.busy} onClick={() => void saver.execute()}>{saver.busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    {/* Leva H (CTT-045): the names and cPais codes of the official NF-e country table; the fixed list only without the API. */}
    <datalist id="contact-countries">{countries.items.length ? countries.items.map(item => <option key={`${item.code}-${item.label}`} value={item.label}>{item.detail}</option>)
      : typeof (controller as Partial<PlatformPort>).platform === 'function' ? null : COUNTRY_SUGGESTIONS.map(country => <option key={country} value={country} />)}</datalist>
    <form id="catalog-editor-form" onSubmit={submit} aria-busy={saver.busy}>
      <div className="fagoo-contact-workspace">
        <aside className="fagoo-contact-outline"><p className="fagoo-eyebrow">ORGANIZAR CONTATO</p><nav aria-label="Seções do contato">{[['identity','Dados cadastrais'],['address','Endereço'],['people','Contato'],['extra','Dados adicionais'],['finance','Financeiro'],['notes','Observações'],['files','Anexos']].map(([id,label],index)=><a key={id} href={'#contact-section-'+id} onClick={event=>{event.preventDefault();const section=document.getElementById('contact-section-'+id);section?.scrollIntoView({block:'start'});section?.focus({preventScroll:true});}}><span>{String(index+1).padStart(2,'0')}</span>{label}<Icon name="chevron-right" size={13}/></a>)}</nav></aside>
      {/* Only a save in progress disables the whole form: a read-only or excluded contact still switches the address tabs,
        opens Dados adicionais / Anexos and the client history; each field below is disabled by `locked` itself. */}
      <fieldset disabled={saver.busy || saver.uncertain} className="real-editor-fields contact-form">
        <legend className="real-sr-only">Dados do cadastro</legend>
        <section className="contact-section" id="contact-section-identity" tabIndex={-1}><div className="contact-section-title"><h3 className="catalog-group-title">Dados cadastrais</h3>{changed && <span className="contact-changed">Alterado em {changed}{record?.updated_by_name ? `, por ${record.updated_by_name}` : ''}</span>}</div>
          <div className="contact-grid">
            {field(SECTION_FIELDS.cadastrais[0], record && !embeddedProfile ? <ContactSalesHistory controller={controller} contactId={record.id} /> : undefined)}
            {SECTION_FIELDS.cadastrais.slice(1, 9).map(spec => spec.key === 'document' && canSearchReceita
              ? field(spec, <button type="button" className="link-button contact-receita" disabled={receita.busy} onClick={() => searchReceita(true)} title="Busca o CNPJ na Receita e preenche nome, endereço, telefone, e-mail, inscrição estadual e regime">{receita.busy ? 'Buscando…' : 'Buscar na Receita'}</button>)
              : field(spec))}
            {(receita.note || receita.error) && <p className={receita.error ? 'real-alert contact-receita-note' : 'real-help contact-receita-note'} role="status">{receita.error || receita.note}</p>}
            {person === 'J' && <div className="form-field contact-check"><label><input type="checkbox" id="contact-ie_exempt" checked={values.ie_exempt === 'true'} disabled={locked} onChange={event => change('ie_exempt', event.target.checked ? 'true' : '')} />IE Isento</label></div>}
            {SECTION_FIELDS.cadastrais.slice(9).map(spec => field(spec))}
          </div></section>
        <section className="contact-section" id="contact-section-address" tabIndex={-1}><h3 className="catalog-group-title">Endereço</h3>
          <div className="contact-tabs" role="tablist"><button type="button" role="tab" aria-selected={addressTab === 'geral'} onClick={() => setAddressTab('geral')}>Geral</button><button type="button" role="tab" aria-selected={addressTab === 'cobranca'} onClick={() => setAddressTab('cobranca')}>Cobrança</button></div>
          <div className="contact-grid" role="tabpanel">{(addressTab === 'geral' ? SECTION_FIELDS.endereco : SECTION_FIELDS.cobranca).map(spec => spec.key === 'postal_code' || spec.key === 'billing_postal_code'
            ? [field(spec), person !== 'E' && <div className="form-field contact-cep-lookup" key={`${spec.key}-busca`}><CepLookupButton id={`contact-${spec.key}-busca`} cep={values[spec.key]} disabled={locked}
              onFound={address => { const p = spec.key === 'billing_postal_code' ? 'billing_' : ''; setValues(previous => ({ ...previous, [`${p}postal_code`]: address.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2'), [`${p}state`]: address.state, [`${p}city`]: address.city,
                ...(address.district ? { [`${p}district`]: address.district } : {}), ...(address.street ? { [`${p}street`]: address.street } : {}), ...(address.complement && !(previous[`${p}complement`] ?? '').trim() ? { [`${p}complement`]: address.complement } : {}) })); saver.setWarnings(null); }} /></div>]
            : field(spec))}
            {/* Leva H (SQL 373): use the general address, e-mail de cobrança and the address the financeiro uses; saved on its own. */}
            {addressTab === 'cobranca' && record && <ContactBilling controller={controller} contactId={record.id} writable={Boolean(writable) && !locked} />}</div></section>
        <section className="contact-section" id="contact-section-people" tabIndex={-1}><h3 className="catalog-group-title">Contato</h3>
          <div className="contact-grid">{field(SECTION_FIELDS.contato[0])}
            <div className="form-field real-field-wide contact-persons"><label htmlFor="contact-person-search">Pessoas de contato</label>
              <div className="contact-person-chips">{persons.map(item => <span key={item.id} className="contact-chip">{item.name}{item.situation === 'E' ? ' (excluído)' : ''}{!locked && <button type="button" aria-label={`Remover pessoa de contato ${item.name}`} onClick={() => setPersons(previous => previous.filter(p => p.id !== item.id))}><Icon name="xmark" size={10} /></button>}</span>)}</div>
              {!locked && persons.length < 20 && <div className="contact-person-search"><input id="contact-person-search" type="search" autoComplete="off" maxLength={120} placeholder="Pesquise um contato" value={personQuery} onChange={event => setPersonQuery(event.target.value)} />
                <button type="button" className="secondary-button" onClick={() => setDrawer(true)}><Icon name="plus" size={10} />Adicionar novo</button></div>}
              {personOptions.length > 0 && <ul className="contact-picker-options" role="listbox" aria-label="Pessoas de contato">{personOptions.map(option => <li key={option.id} role="option" aria-selected={false}><button type="button" onClick={() => { setPersons(previous => [...previous, option]); setPersonQuery(''); setPersonOptions([]); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}</div>
            {SECTION_FIELDS.contato.slice(1).map(spec => field(spec))}</div></section>
        <section className="contact-section" id="contact-section-extra" tabIndex={-1}><button type="button" className="contact-collapse" aria-expanded={extraOpen} onClick={() => setExtraOpen(!extraOpen)}><Icon name={extraOpen ? 'chevron-down' : 'chevron-right'} size={11} /><h3 className="catalog-group-title">Dados adicionais</h3></button>
          {extraOpen && <div className="contact-grid">
            {SECTION_FIELDS.adicionais.filter(spec => spec.key !== 'suframa').map(spec => field(spec))}
            <ContactTypeTags controller={controller} id="contact-types" types={typesList} selected={types} onChange={next => { setTypes(next); saver.setWarnings(null); }} onCreated={type => setContactTypes(current => current ? { ...current, items: [...current.items, type] } : current)}
              disabled={locked} canCreate={Boolean(contactTypes?.can_create)} locked={record?.seller_record_id ? ['seller'] : []} />
            <ContactTagsField controller={controller} record={record} writable={writable} />
            <div className="form-field"><label htmlFor="contact-situation">Situação</label><select id="contact-situation" value={values.situation} disabled={locked} onChange={event => change('situation', event.target.value)}>{FORM_SITUATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
            <SellerPicker controller={controller} id="contact-seller_id" label="Vendedor" value={seller} disabled={locked} onChange={next => { setSeller(next); saver.setWarnings(null); }} />
            {blockEnabled('erp-fiscal')&&<div className="form-field"><label htmlFor="contact-operation_nature_id">Natureza de Operação Padrão{isRequired('operation_nature_id') ? ' *' : ''}</label>
              {natures.error ? <input id="contact-operation_nature_id" value={record?.operation_nature_name ?? ''} readOnly disabled title="Seu perfil não consulta as naturezas de operação." />
                : <select id="contact-operation_nature_id" value={values.operation_nature_id ?? ''} disabled={locked} onChange={event => change('operation_nature_id', event.target.value)}><option value="">Selecione</option>
                  {values.operation_nature_id && !natureList.some(n => n.id === values.operation_nature_id) && <option value={values.operation_nature_id}>{record?.operation_nature_name ?? 'Natureza atual'}</option>}
                  {natureList.map(nature => <option key={nature.id} value={nature.id}>{nature.description}</option>)}</select>}
              <small className="real-help">Usada como sugestão nas notas de {(types.includes('supplier') && !types.includes('customer') ? 'Fornecedor' : vocabulary?.singular?.trim() || 'Cliente').toLocaleLowerCase('pt-BR')} quando a emissão adotar o cadastro.</small></div>}
            {field(SECTION_FIELDS.adicionais.find(spec => spec.key === 'suframa')!)}
            {/* 202610200170 (documentos lane): Foto in the private attachment storage. */}
            <ContactPhoto controller={controller} contactId={record?.id ?? null} writable={writable && !excluded} />
          </div>}</section>
        {blockEnabled('erp-financeiro')&&<section className="contact-section" id="contact-section-finance" tabIndex={-1}><h3 className="catalog-group-title">Financeiro</h3>
          <div className="contact-grid">
            <fieldset className="contact-credit real-field-wide"><legend>Limite de crédito{isRequired('credit_limit_mode') ? ' *' : ''}</legend>
              <label className="contact-switch"><input type="checkbox" role="switch" id="contact-credit_unlimited" checked={values.credit_limit_mode === 'unlimited'} disabled={locked} onChange={event => change('credit_limit_mode', event.target.checked ? 'unlimited' : 'value')} />Ilimitado</label>
              <label className="contact-switch"><input type="checkbox" role="switch" id="contact-credit_zero" checked={values.credit_limit_mode === 'zero'} disabled={locked} onChange={event => change('credit_limit_mode', event.target.checked ? 'zero' : 'value')} />Limite zero</label>
              {values.credit_limit_mode === 'value' && <div className="form-field"><label htmlFor="contact-credit_limit">Valor</label><input id="contact-credit_limit" inputMode="decimal" maxLength={20} value={values.credit_limit ?? ''} disabled={locked} aria-invalid={invalid === 'credit_limit' || undefined} onChange={event => change('credit_limit', event.target.value)} />
                <small>Para definir um limite de crédito, informe um valor maior que zero.</small></div>}
              <small className="real-help">O limite é conferido nas propostas quando o bloqueio por crédito está habilitado nas preferências. Administradores podem ultrapassá-lo; pedidos de venda não usam essa conferência.</small></fieldset>
            {field(SECTION_FIELDS.financeiro[0])}
            <div className="form-field"><label htmlFor="contact-finance_category_id">Categoria<span className="contact-hint" title="Categoria de receita/despesa" aria-hidden="true"><Icon name="circle-info" size={10} /></span></label>
              {categories.error ? <input id="contact-finance_category_id" value={record?.finance_category_name ?? 'Sem categoria'} readOnly disabled title="Seu perfil não consulta as categorias financeiras." />
                : <CategoryTreePicker id="contact-finance_category_id" items={categoryList} value={values.finance_category_id ?? ''} currentName={record?.finance_category_name} disabled={locked} onChange={next => change('finance_category_id', next)} />}</div>
          </div></section>}
        <section className="contact-section" id="contact-section-notes" tabIndex={-1}><h3 className="catalog-group-title">Observações</h3><div className="contact-grid">{field(SECTION_FIELDS.observacoes[0])}</div></section>
        {/* Wabotia: sem o painel do espelho do Origin (Leva H, 350) nem o complemento Transportador dele: Origin fora (motor 91213b8). */}
        <section className="contact-section" id="contact-section-files" tabIndex={-1}><button type="button" className="contact-collapse" aria-expanded={attachmentsOpen} onClick={() => setAttachmentsOpen(!attachmentsOpen)}><Icon name={attachmentsOpen ? 'chevron-down' : 'chevron-right'} size={11} /><h3 className="catalog-group-title">Anexos</h3></button>
          {attachmentsOpen && (record ? <ContactFiles controller={controller} contactId={record.id} writable={writable && !excluded} />
            : <p className="real-help">Salve o cadastro para anexar arquivos.</p>)}</section>
      </fieldset></div>
    </form>
    {/* Wabotia: campos próprios de contato (Preferências › Cadastros), salvos à parte; na ficha do atendimento, só leitura. */}
    <ContactCustomFields contactId={record?.id ?? null} embedded={Boolean(embeddedProfile)} writable={Boolean(writable) && !excluded} />
    {drawer &&<ContactQuickDrawer controller={controller} types={typesList} canCreateTypes={Boolean(contactTypes?.can_create)} required={required} onTypeCreated={type => setContactTypes(current => current ? { ...current, items: [...current.items, type] } : current)}
      onClose={() => setDrawer(false)} onCreated={created => { setDrawer(false); setPersons(previous => [...previous, { id: created.id, name: created.name, code: typeof created.code === 'string' ? created.code : null, situation: created.situation }]); }} />}
    <p className="real-help">Esta tela não altera estoque, contas ou documentos fiscais.</p>
  </section>;
}
