import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent, AccessError } from '../../../web/erp/test/helpers/component-recovery-harness.mjs';
import { EMPTY_LIST_FILTERS } from '../../../web/erp/app/lib/document-list-model.ts';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { orderRecipient, carrierValues } from '../../../web/erp/app/lib/fiscal-invoice-form-model.ts';

const id = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const modules = { '../../ports': 'export const erpPorts=()=>({commercialNfe:{}});' };
const component = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const controller = () => ({
  getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
  subscribe: () => () => {},
  async fiscalInvoices() { throw new AccessError(404); },
  async listPreferences() { throw new AccessError(404); },
});

test('a entrada lazy usa o wrapper; no host comercial saída nunca monta o formulário legado', async () => {
  const entry = await readFile(new URL('../../../web/erp/screens/fiscal.ts', import.meta.url), 'utf8');
  assert.match(entry, /HostedFiscalInvoices as RealFiscalInvoices/);
  for (const [screen, query, child] of [
    ['nfe', '?modelo=55', 'CommercialNfe'],
    ['nfe', `?modelo=55&nota=nova&pedido=${id}`, 'CommercialNfe'],
    ['nfe', `?modelo=55&nota=${id}`, 'LegacyFiscalArchive'],
    ['nfe', '?modelo=55&acervo=legado', 'LegacyFiscalArchive'],
    ['nfe', `?modelo=55&pedido=${id},${actor}`, 'LegacyFiscalArchive'],
    ['nfce', '?modelo=65&nota=nova', 'LegacyFiscalArchive'],
  ]) {
    const view = await mountComponent('RealFiscalInvoices.tsx', { controller: controller(), screen }, {
      componentName: 'HostedFiscalInvoices', modules, location: `/historico-fiscal${query}`,
      expandChildren: ['CommercialFiscalInvoices'],
    });
    try {
      assert.ok(component(view, child), `${screen}${query}`);
      assert.equal(component(view, 'RealFiscalInvoices'), undefined);
      assert.equal(component(view, 'FiscalInvoiceForm'), undefined);
    } finally { view.unmount(); }
  }
});

test('Compras conserva importação de pedido; hospedeiro sem porta conserva componente portado', async () => {
  const legacy = await mountComponent('RealFiscalInvoices.tsx', { controller: controller(), screen: 'nfe' }, {
    componentName: 'HostedFiscalInvoices', location: '/historico-fiscal?modelo=55',
  });
  try { assert.ok(component(legacy, 'RealFiscalInvoices')); } finally { legacy.unmount(); }
  const entry = await mountComponent('RealFiscalInvoices.tsx', { controller: controller(), screen: 'entrada' }, {
    componentName: 'HostedFiscalInvoices', modules, location: '/notas-entrada',
    expandChildren: ['RealFiscalInvoices', 'NativeListLayout'],
  });
  try {
    await entry.click('Importar Pedido XML');
    assert.equal(entry.location().search, '?tipo=purchase_orders&acao=xml');
  } finally { entry.unmount(); }
});

test('menu comercial prepara somente NF-e integral e fecha NFC-e, parcial e lote', async () => {
  const previous = globalThis.window, opened = [];
  globalThis.window = { open: (...args) => opened.push(args) };
  const row = { id, kind: 'sales_orders', number: '7', version: 3, status: 'open', date: '2026-11-19', total: '51.00',
    contact_id: actor, contact_name: 'Cliente do ensaio', created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z',
    template: false, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false };
  const view = await mountComponent('DocumentList.tsx', { controller: controller(), kind: 'sales_orders',
    access: { read: ['sales_orders'], write: ['sales_orders'] }, writable: true, today: '2026-11-19',
    page: { items: [row], total_count: 1, total_amount: '51.00' }, loading: false,
    filters: { ...EMPTY_LIST_FILTERS }, order: 'date_desc', listPage: 1, filterError: '',
    onApply() {}, onPage() {}, onOrder() {}, onReload() {}, onKind() {}, onOpen() {}, onClone() {}, onConverted() {}, onNavigate() {},
  }, { modules, expandChildren: ['NativeListLayout'] });
  try {
    const items = component(view, 'RowMenu').props.items;
    const prepare = items.find(item => item.label === 'Preparar NF-e');
    assert.equal(prepare.disabled, false); prepare.onClick(); await view.flush();
    assert.deepEqual(opened, [[`/historico-fiscal?modelo=55&pedido=${id}&versao=3`, '_blank', 'noopener']]);
    for (const label of ['Gerar NFC-e', 'Gerar nota fiscal parcial']) {
      const item = items.find(item => item.label === label);
      assert.equal(item.disabled, true); assert.match(item.title, /não são atendidas/);
      item.onClick(); await view.flush();
    }
    assert.equal(opened.length, 1);
    assert.equal(view.button('Gerar NF-e dos pedidos selecionados').disabled, true);
    assert.equal(view.button('NFC-es selecionadas').disabled, true);
    assert.equal(component(view, 'PartialInvoiceDialog'), undefined);
    assert.equal(component(view, 'FiscalOrderBatch'), undefined);
  } finally {
    view.unmount();
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

test('junção: pedido vindo de módulo permanece somente para abrir, sem preparar ou acompanhar NF-e', async () => {
  const row = { id, kind: 'sales_orders', number: '7', version: 3, status: 'in_progress', date: '2026-11-19', total: '51.00',
    contact_id: actor, contact_name: 'Cliente do módulo', created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z',
    template: false, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false };
  const opened = [];
  const view = await mountComponent('DocumentList.tsx', { controller: controller(), kind: 'sales_orders',
    access: { read: ['sales_orders'], write: ['sales_orders'] }, writable: true, today: '2026-11-19',
    page: { items: [row], total_count: 1, total_amount: '51.00' }, loading: false,
    filters: { ...EMPTY_LIST_FILTERS }, order: 'date_desc', listPage: 1, filterError: '',
    onApply() {}, onPage() {}, onOrder() {}, onReload() {}, onKind() {}, onOpen: value => opened.push(value),
    onClone() {}, onConverted() {}, onNavigate() {},
  }, { modules: { ...modules, '../../../modules/integrations/LegacyServiceOrders': `
    export const useDocumentOrigins = ids => ({ ready: true, protectedIds: ids, origins: [], host: null });
    export const DocumentOriginNotice = () => null;
  ` }, expandChildren: ['NativeListLayout'] });
  try {
    const items = component(view, 'RowMenu').props.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].disabled, false);
    assert.doesNotMatch(items[0].label, /NF-e/);
    items[0].onClick(); await view.flush();
    assert.deepEqual(opened, [id]);
    assert.equal(view.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label']?.includes('7')).props.disabled, true);
  } finally { view.unmount(); }
});

test('Compras no host bloqueia clonagem para saída e devolução inclusive em handler antigo', async () => {
  const calls = [], c = controller();
  c.fiscalInvoices = async path => {
    calls.push(path);
    if (!path.startsWith('/v1/notas-fiscais?')) throw new AccessError(404);
    return { items: [{ origin: 'brufap', id, version: 1, number: 1, series: 1, issue_date: '2026-11-19', entry_date: null,
      name: 'Fornecedor', document: '11222333000181', state: 'SP', nature: null, status: 6, status_raw: null,
      total: '51.00', total_known: true, environment: '2', issue_type: 'N', access_key: '3'.repeat(44),
      xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [] }],
      origin: 'brufap', model: '55', direction: '0', page: 1, limit: 100, order: 'date_desc', has_more: false,
      total_count: 1, total_amount: '51.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'erp_native_homologation' };
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: c, screen: 'entrada' }, {
    modules, location: '/notas-entrada', expandChildren: ['NativeListLayout'],
  });
  try {
    const items = component(view, 'RowMenu').props.items;
    for (const label of ['Clonar para saída', 'Gerar devolução']) {
      const item = items.find(item => item.label === label);
      assert.equal(item.disabled, true); assert.match(item.title, /não são atendidas/);
      item.onClick(); await view.flush();
    }
    assert.equal(component(view, 'FiscalInvoiceForm'), undefined);
    assert.equal(component(view, 'FiscalReturnDialog'), undefined);
    assert.equal(calls.includes(`/v1/notas-fiscais/${id}`), false);
  } finally { view.unmount(); }
});

function record(direction) {
  const input = normalizeInvoiceInput({ model: '55', direction, issue_type: 'N', series: '1', nature_id: actor,
    nature_description: 'Ensaio', issue_date: '2026-11-19', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Ensaio', person_type: 'J', document: '11222333000181', state: 'SP' },
    items: [{ description: 'Mercadoria', quantity: '1', unit_price: '51' }] });
  const totals = invoiceTotals(input);
  return { ...input, id, version: 1, status: 1, environment: '2', series: 1, number: null, access_key: null, protocol: null,
    authorized_at: null, items: input.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i],
      allocated: Object.fromEntries(['freight', 'insurance', 'other_expenses', 'discount'].map(key => [key, totals.allocation[key][i]])) })),
    totals: totals.totals, orders: [], created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z', deleted_at: null, delete_reason: null };
}

test('formulário de entrada recusa UUID de saída e inversão, mas abre uma entrada válida', async () => {
  for (const mode of ['outgoing_id', 'inverted', 'incoming_id']) {
    const calls = [], c = controller();
    c.fiscalInvoices = async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.includes('/contexto')) return { company: { crt: '1', state: 'SP' }, series: [], defaults: {}, preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] }, production_enabled: false };
      if (path.includes('/naturezas?')) return { items: [] };
      if (path.endsWith('/impostos')) return { settings: {}, difal_by_state: {} };
      if (path.endsWith(`/${id}`)) return { invoice: record(mode === 'incoming_id' ? '0' : '1') };
      throw new AccessError(404);
    };
    const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: c, config: { screen: 'entrada', model: '55', direction: '0' },
      directionOnly: '0', id: mode === 'inverted' ? null : id, opening: mode === 'inverted' ? { kind: 'clone_invert', record: record('0') } : null,
      today: '2026-11-19', onBack() {}, onSaved() {},
    }, { modules, location: `/notas-entrada?nota=${id}` });
    try {
      if (mode === 'incoming_id') assert.ok(view.input('fiscal-issue-type'));
      else {
        assert.match(view.text(), /edição legada de saída está fechada/);
        assert.equal(view.nodes().some(node => node.type === 'button' && node.props.children === 'Salvar'), false);
      }
      assert.ok(calls.every(call => call.method === 'GET'));
    } finally { view.unmount(); }
  }
});

test('compatibilidade numérica é explícita e nunca remove letras de CNPJ inválido', () => {
  const contact = { contact_id: id, name: 'Contato', document: '12.345.678/0001-90' };
  assert.equal(orderRecipient(contact).document, undefined);
  assert.equal(orderRecipient(contact, true).document, '12345678000190');
  assert.equal(carrierValues(contact, true).document, '12345678000190');
  for (const document of ['12ABC34501DE34', '12ABC34501DEAA']) {
    assert.equal(orderRecipient({ ...contact, document }, true).document, undefined);
    assert.equal(carrierValues({ ...contact, document }, true).document, undefined);
  }
});
