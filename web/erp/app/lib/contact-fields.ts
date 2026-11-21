// Campos próprios de contato (Vinki; esquema do ERP versão 20): chamadas a /api/v1/profiles/<área>/erp-contato-campos
// (src/erp/contact-fields/routes.ts), a mesma validação do motor para avisar antes de enviar, o texto de cada valor (lista,
// coluna, exportação) e a leitura das colunas da planilha de importação. O servidor confere tudo de novo (papel no ERP,
// carteira do vendedor, campo sensível). Fora do painel da área (demonstração), os campos próprios não estão disponíveis.
import { erpPorts } from '../../ports.ts';
import { textCell, numberCell, type SheetCell } from './spreadsheet-export.ts';

export type ContactFieldType = 'text' | 'number' | 'date' | 'list' | 'boolean';
export type ContactFieldRole = 'customer' | 'supplier' | 'seller' | 'carrier';
export interface ContactFieldOption { id: string; label: string }
export interface ContactField {
  id: string; name: string; field_type: ContactFieldType; required: boolean; roles: ContactFieldRole[]; options: ContactFieldOption[];
  sensitive: boolean; exposed: boolean; list_column: boolean; list_filter: boolean; active: boolean; version: number;
  // Só em Preferências › Cadastros (administrador).
  position?: number; exposed_at?: string | null; exposed_by?: string | null; exposed_by_name?: string | null; contacts?: number;
}
export interface ContactFieldList { items: ContactField[]; limit: number; permissions: { manage: boolean } }
export interface ContactFieldView { contact_id: string; roles: ContactFieldRole[]; fields: ContactField[]; values: Record<string, string>; hidden: number }
export interface ContactFieldValueError { field_id: string | null; code: string; message: string }

export const CONTACT_FIELD_TYPES: readonly ContactFieldType[] = ['text', 'number', 'date', 'list', 'boolean'];
export const CONTACT_FIELD_TYPE_LABELS: Record<ContactFieldType, string> = { text: 'Texto', number: 'Número', date: 'Data', list: 'Lista de opções', boolean: 'Sim/Não' };
export const CONTACT_FIELD_ROLES: readonly ContactFieldRole[] = ['customer', 'supplier', 'seller', 'carrier'];
export const CONTACT_FIELD_ROLE_LABELS: Record<ContactFieldRole, string> = { customer: 'Cliente', supplier: 'Fornecedor', seller: 'Vendedor', carrier: 'Transportadora' };
export const CONTACT_FIELDS_LIMIT = 60;

export class ContactFieldsError extends Error {
  readonly code: string; readonly status: number; readonly fields: ContactFieldValueError[];
  constructor(message: string, code = 'contact_fields_failed', status = 0, fields: ContactFieldValueError[] = []) {
    super(message); this.name = 'ContactFieldsError'; this.code = code; this.status = status; this.fields = fields;
  }
}

/** /api/v1/profiles/<área>/erp-contato-campos, ou null na demonstração e fora do painel. */
export function contactFieldsBase(): string | null {
  const ports = erpPorts();
  if (!ports || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-contato-campos');
}
export const contactFieldsAvailable = () => contactFieldsBase() !== null;

export async function contactFieldsCall<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const base = contactFieldsBase();
  if (!base) throw new ContactFieldsError('Os campos próprios de contato funcionam no painel da área (não na demonstração).', 'contact_fields_unavailable');
  let response: Response;
  try {
    response = await globalThis.fetch(base + path, { method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', signal: init.signal,
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ContactFieldsError(init.method && init.method !== 'GET' ? 'A resposta não chegou. Confira se a alteração ficou gravada antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'contact_fields_network');
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new ContactFieldsError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}). Tente de novo.`,
      typeof error.code === 'string' ? error.code : 'contact_fields_failed', response.status, Array.isArray(error.campos) ? error.campos : []);
  }
  return body as T;
}

// ---- Valores: a mesma regra do motor (contact-fields.ts) ----
const NUMBER = /^-?(0|[1-9]\d{0,14})(?:[.,]\d{1,6})?$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function validDay(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! && value >= '1900-01-01' && value <= '2100-12-31';
}
const excelDay = (serial: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);

/** O valor a enviar (null limpa) ou a mensagem do problema, como o servidor diria. */
export function contactFieldInput(field: Pick<ContactField, 'name' | 'field_type' | 'options' | 'required'>, raw: string | undefined, { sheet = false } = {}): { value: string | null } | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return field.required && !sheet ? { error: `Preencha o campo ${field.name}: ele é obrigatório.` } : { value: null };
  switch (field.field_type) {
    case 'text': return text.length > 255 || CONTROL.test(text) ? { error: `Confira o campo ${field.name}: até 255 caracteres, em uma linha.` } : { value: text };
    case 'number': {
      const plain = sheet && /,/.test(text) ? text.replace(/\./g, '') : text;
      if (!NUMBER.test(plain)) return { error: `Informe em ${field.name} um número com até 15 dígitos e 6 casas decimais (vírgula ou ponto, sem separador de milhar).` };
      let value = plain.replace(',', '.'); if (value.includes('.')) value = value.replace(/0+$/, '').replace(/\.$/, '');
      return { value: value === '-0' ? '0' : value };
    }
    case 'date': {
      const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
      const value = br ? `${br[3]}-${br[2]}-${br[1]}` : sheet && /^\d{4,6}(\.\d+)?$/.test(text) ? excelDay(Number(text)) : text;
      return validDay(value) ? { value } : { error: `Informe em ${field.name} uma data válida (DD/MM/AAAA).` };
    }
    case 'list': {
      const option = field.options.find(o => o.id === text) ?? field.options.find(o => fold(o.label) === fold(text));
      return option ? { value: option.id } : { error: `Escolha em ${field.name} uma das opções da lista.` };
    }
    case 'boolean': {
      const key = fold(text);
      return ['true', 'sim', 's', '1', 'x'].includes(key) ? { value: 'true' } : ['false', 'nao', 'n', '0'].includes(key) ? { value: 'false' } : { error: `Responda ${field.name} com Sim ou Não.` };
    }
  }
}

/** O texto de um valor guardado: o nome da opção, Sim/Não, DD/MM/AAAA e o número com vírgula. */
export function contactFieldText(field: Pick<ContactField, 'field_type' | 'options'>, value: string | undefined | null): string {
  if (typeof value !== 'string' || !value) return '';
  if (field.field_type === 'list') return field.options.find(o => o.id === value)?.label ?? '';
  if (field.field_type === 'boolean') return value === 'true' ? 'Sim' : value === 'false' ? 'Não' : '';
  if (field.field_type === 'date') return value.split('-').reverse().join('/');
  if (field.field_type === 'number') return value.replace('.', ',');
  return value;
}
/** O valor no campo do formulário: data como AAAA-MM-DD (input date), número com vírgula, lista e sim/não pelo valor guardado. */
export const contactFieldDraftValue = (field: ContactField, value: string | undefined) => field.field_type === 'number' ? (value ?? '').replace('.', ',') : value ?? '';

/** Corpo do PUT: todos os campos do formulário (null limpa); o primeiro problema para a tela. */
export function contactFieldsPayload(fields: readonly ContactField[], draft: Readonly<Record<string, string>>): { values: Record<string, string | null> } | { error: string; field: string } {
  const values: Record<string, string | null> = {};
  for (const field of fields) {
    const result = contactFieldInput(field, draft[field.id]);
    if ('error' in result) return { error: result.error, field: field.id };
    values[field.id] = result.value;
  }
  return { values };
}

// ---- Lista: colunas e filtros ----
export interface ContactFieldFilter { field_id: string; value?: string; from?: string; to?: string }
export const listColumnFields = (fields: readonly ContactField[]) => fields.filter(f => f.active && f.list_column);
export const listFilterFields = (fields: readonly ContactField[]) => fields.filter(f => f.active && f.list_filter);
/** Só os filtros preenchidos, no formato da rota (/lista?campos=[…]). */
export function activeFieldFilters(fields: readonly ContactField[], draft: Readonly<Record<string, { value?: string; from?: string; to?: string }>>): ContactFieldFilter[] {
  const out: ContactFieldFilter[] = [];
  for (const field of listFilterFields(fields)) {
    const item = draft[field.id]; if (!item) continue;
    if (field.field_type === 'number' || field.field_type === 'date') {
      const from = item.from?.trim() ?? '', to = item.to?.trim() ?? '';
      if (from || to) out.push({ field_id: field.id, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    } else if (item.value?.trim()) out.push({ field_id: field.id, value: item.value.trim() });
  }
  return out;
}
export function fieldFilterChip(field: ContactField, filter: ContactFieldFilter): string {
  if (field.field_type === 'number' || field.field_type === 'date') {
    const show = (v?: string) => v ? (field.field_type === 'date' ? v.split('-').reverse().join('/') : v) : '';
    return `${field.name}: ${filter.from && filter.to ? `${show(filter.from)} a ${show(filter.to)}` : filter.from ? `a partir de ${show(filter.from)}` : `até ${show(filter.to)}`}`;
  }
  if (field.field_type === 'list') return `${field.name}: ${field.options.find(o => o.id === filter.value)?.label ?? filter.value}`;
  if (field.field_type === 'boolean') return `${field.name}: ${filter.value === 'true' ? 'Sim' : 'Não'}`;
  return `${field.name}: ${filter.value}`;
}
/** O filtro aplicado num registro já lido (exportação): sem valor, sim/não conta como Não. */
export function matchesFieldFilters(fields: readonly ContactField[], filters: readonly ContactFieldFilter[], values: Readonly<Record<string, string>>): boolean {
  return filters.every(filter => {
    const field = fields.find(f => f.id === filter.field_id); if (!field) return false;
    const value = values[field.id];
    if (field.field_type === 'boolean') return filter.value === 'true' ? value === 'true' : value !== 'true';
    if (value === undefined) return false;
    if (field.field_type === 'text') return value.toLowerCase().includes((filter.value ?? '').toLowerCase());
    if (field.field_type === 'list') return value === filter.value;
    const norm = (v?: string) => { if (!v) return null; const r = contactFieldInput(field, v); return 'value' in r ? r.value : null; };
    const lo = norm(filter.from), hi = norm(filter.to);
    if (field.field_type === 'number') return (lo === null || Number(value) >= Number(lo)) && (hi === null || Number(value) <= Number(hi));
    return (lo === null || value >= lo) && (hi === null || value <= hi);
  });
}

/** Valores de muitos contatos, em lotes de 100 (colunas da lista e exportação). */
export async function contactFieldValuesFor(ids: readonly string[], signal?: AbortSignal): Promise<{ fields: ContactField[]; values: Map<string, Record<string, string>> }> {
  const values = new Map<string, Record<string, string>>(); let fields: ContactField[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const page = await contactFieldsCall<{ fields: ContactField[]; items: { id: string; values: Record<string, string> }[] }>('/valores', { method: 'POST', body: { ids: ids.slice(index, index + 100) }, signal });
    if (!Array.isArray(page.items) || !Array.isArray(page.fields)) throw new ContactFieldsError('Resposta inválida do servidor. Tente de novo.');
    fields = page.fields;
    for (const item of page.items) values.set(item.id, item.values);
  }
  if (!ids.length) fields = (await contactFieldsCall<ContactFieldList>('?para=lista', { signal })).items;
  return { fields, values };
}

// ---- Exportação: uma coluna por campo, com o nome do campo ----
export function contactFieldSheetColumns(fields: readonly ContactField[]): { header: SheetCell[]; cells: (values: Readonly<Record<string, string>> | undefined) => SheetCell[] } {
  const shown = fields.filter(f => f.active);
  return {
    header: shown.map(f => textCell(f.name)),
    cells: values => shown.map(f => { const v = values?.[f.id]; if (!v) return textCell(''); return f.field_type === 'number' ? numberCell(v) : textCell(contactFieldText(f, v)); }),
  };
}

// ---- Importação: coluna com o nome do campo ----
/** Colunas da planilha que são campos próprios (pelo nome, sem acento nem caixa). */
export function fieldColumns(header: readonly string[], fields: readonly ContactField[]): Map<string, number> {
  const byName = new Map(fields.filter(f => f.active).map(f => [fold(f.name), f.id]));
  const out = new Map<string, number>();
  header.forEach((label, index) => { const id = byName.get(fold(label)); if (id && !out.has(id)) out.set(id, index); });
  return out;
}
/** Os valores de uma linha: o que veio preenchido, já no formato guardado; problemas com o nome do campo. */
export function rowFieldValues(line: readonly string[], columns: ReadonlyMap<string, number>, fields: readonly ContactField[]): { values: Record<string, string>; problems: string[] } {
  const values: Record<string, string> = {}, problems: string[] = [];
  for (const [id, position] of columns) {
    const field = fields.find(f => f.id === id)!; const raw = (line[position] ?? '').trim(); if (!raw) continue;
    const result = contactFieldInput(field, raw, { sheet: true });
    if ('error' in result) problems.push(result.error); else if (result.value !== null) values[id] = result.value;
  }
  return { values, problems };
}

// ---- Preferências › Cadastros: rascunho da definição ----
export interface ContactFieldDraft {
  name: string; field_type: ContactFieldType; required: boolean; roles: ContactFieldRole[]; options: { id: string | null; label: string; key: string }[];
  sensitive: boolean; exposed: boolean; list_column: boolean; list_filter: boolean; active: boolean;
}
let optionKey = 0;
export const newOptionKey = () => `opcao-${++optionKey}`;
export function contactFieldDraft(field?: ContactField | null): ContactFieldDraft {
  return field ? { name: field.name, field_type: field.field_type, required: field.required, roles: [...field.roles], options: field.options.map(o => ({ id: o.id, label: o.label, key: o.id })),
    sensitive: field.sensitive, exposed: field.exposed, list_column: field.list_column, list_filter: field.list_filter, active: field.active }
    : { name: '', field_type: 'text', required: false, roles: ['customer'], options: [], sensitive: false, exposed: false, list_column: false, list_filter: false, active: true };
}
/** O rascunho conferido como o servidor confere; o pedido (data) ou o primeiro problema. */
export function contactFieldData(draft: ContactFieldDraft, original?: ContactField | null): { data: Record<string, unknown>; exposing: boolean } | { error: string; field: string } {
  const name = draft.name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60 || CONTROL.test(name)) return { error: 'Informe o nome do campo com até 60 caracteres.', field: 'name' };
  if (!draft.roles.length) return { error: 'Marque para quais tipos de contato o campo vale: cliente, fornecedor, vendedor ou transportadora.', field: 'roles' };
  const data: Record<string, unknown> = { name, field_type: draft.field_type, required: draft.required, roles: CONTACT_FIELD_ROLES.filter(r => draft.roles.includes(r)),
    sensitive: draft.sensitive, active: draft.active };
  if (draft.field_type === 'list') {
    const options = draft.options.map(o => ({ ...(o.id && original?.field_type === 'list' ? { id: o.id } : {}), label: o.label.trim().replace(/\s+/g, ' ') }));
    if (!options.length) return { error: 'Adicione ao menos uma opção à lista.', field: 'options' };
    if (options.length > 50) return { error: 'A lista aceita até 50 opções.', field: 'options' };
    if (options.some(o => !o.label || o.label.length > 60 || CONTROL.test(o.label))) return { error: 'Cada opção precisa de um nome com até 60 caracteres.', field: 'options' };
    if (new Set(options.map(o => fold(o.label))).size !== options.length) return { error: 'Há opções repetidas na lista. Deixe cada opção uma vez só.', field: 'options' };
    data.options = options;
  } else data.options = [];
  const exposed = draft.sensitive && draft.exposed;
  data.exposed = exposed;
  // Sensível sem liberação não vira coluna nem filtro.
  data.list_column = (!draft.sensitive || exposed) && draft.list_column;
  data.list_filter = (!draft.sensitive || exposed) && draft.list_filter;
  return { data, exposing: exposed && !original?.exposed };
}
