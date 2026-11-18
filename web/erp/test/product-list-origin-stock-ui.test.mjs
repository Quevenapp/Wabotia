import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { exportColumns, exportCsv } from '../app/lib/product-form-model.ts';

// Wabotia: Origin fora (motor 91213b8). O motor manda origin_stock sempre nulo; a lista, a impressão e a exportação mostram só o
// estoque nativo, sem as linhas, filtros e colunas do saldo observado no Origin (202610220008). Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '93000000-0000-4000-8000-0000000000aa', warehouse = '93000000-0000-4000-8000-0000000000bb';
const noMovements = { state: 'no_movements', quantity: null, warehouse: null };

test('export keeps only the native Estoque', () => {
  const columns = exportColumns('standard', []), names = columns.map(([name]) => name);
  assert.equal(names.filter(name => name === 'Estoque').length, 1);
  assert.equal(names.some(name => /Origin/.test(name)), false);
  assert.deepEqual(exportColumns('custom', []).map(([name]) => name), ['ID', 'Código', 'Descrição']);
  const csv = exportCsv([{ id: 'x', name: 'A', stock: '2.000000', origin_stock: null }], columns).split('\r\n');
  assert.equal(csv[1].split(';').length, names.length);
});

function server(page) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method });
      if (path === '/v1/cadastros') return { data_mode: 'erp_native', read: ['products'], write: [] };
      const params = new URLSearchParams(path.split('?')[1] ?? '');
      return { entity: 'products', page: Number(params.get('page')), size: Number(params.get('size')), total: page.items.length, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native', ...page };
    },
    async stockPositions() { return { items: [{ id: warehouse, name: 'Geral', active: true }], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
  };
  return { calls, controller };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const cells = view => view.nodes().filter(node => node.type === 'td' && String(node.props.className || '').includes('catalog-stock')).map(node => textOf(node.props.children));
const product = (n, stock) => ({ id: `93000000-0000-4000-8000-00000000000${n}`, entity: 'products', version: 1, active: true, name: `Produto ${n}`, code: `QA-${n}`, unit: 'UN', price: '1.5000', kind: 'P', format: 'S', source: null, stock, origin_stock: null });

test('product list shows only the native stock, with the native filters, and only reads', async () => {
  const { calls, controller } = server({ items: [product(1, noMovements), product(2, { state: 'recorded', quantity: '2.000000', warehouse: null })], origin_stock: null });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(cells(view), ['Sem lançamentos', '2']);
    assert.doesNotMatch(view.text(), /Origin \(físico\)/);
    const options = view.input('catalog-stock-filter').props.children[1];
    assert.deepEqual(options.map(option => option.props.value), ['zero', 'negative', 'positive', 'no_movements']);
    await view.change('catalog-stock-filter', 'positive'); await view.change('catalog-warehouse-filter', warehouse); await view.submit();
    const last = new URLSearchParams(calls.filter(call => call.path.startsWith('/v1/cadastros/products?')).at(-1).path.split('?')[1]);
    assert.deepEqual([last.get('stock'), last.get('warehouse_id')], ['positive', warehouse]);
    assert.ok(view.find(node => node.type?.name === 'AppliedChips').props.chips.some(chip => chip.label === 'Estoque: Maior que zero (Geral)'));
    assert.equal(calls.some(call => call.method && call.method !== 'GET'), false, 'opening and filtering the list never writes');
  } finally { view.unmount(); }
});
