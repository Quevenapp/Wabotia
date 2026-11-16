// Cadastro de produtos, onda D (migração 191): workers/erp-api/test/produtos-d-registry-sql.test.mjs do
// Fagoo na fixture dupla. Comparados: product_page_custom, product_get, product_form_context e as listas.
// Fora, declarados: '191 grants' (GRANT do Postgres); 'Itens p/ caixa … migration of stored values' e
// 'a product command saved before 191 still replays after the deploy' (reaplicam a migração 191 no
// Postgres: o oráculo já está no estado final); 'preference definitions' (lê o schema da página no código
// do Fagoo, fora da fixture); 'Sequencial EAN' (erp_preferences_save, não portado, recusa no próprio
// Postgres com as migrações finais; o original roda até a 193).
// Adaptação: escritas diretas em erp_company e a chamada direta de erp_catalog.document_product passam
// pela cópia do estado (f.write / f.sync).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { productsFixture as produtosDFixture, fails } from './catalog-products-fixture.mjs';

// Produtos lane, wave D (migration 191): Itens p/ caixa decimal, filtro Campos customizados (página e reajuste), código Sequencial
// EAN, contexto do formulário (CRT) e a criação automática de produtos a partir dos documentos. PGlite, dados sintéticos.
const PUBLIC = ['erp_catalog_product_page_custom', 'erp_catalog_product_form_context', 'erp_catalog_product_save', 'erp_catalog_product_price_adjust'];
const ean = body => { let sum = 0; for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1); return `${body}${(10 - (sum % 10)) % 10}`; };
const sqlCode = code => error => error.code === code;



test('191 Campos customizados filter: page by type, AND, permissions, refusals and the filtered price adjust', async () => {
  const f = await produtosDFixture();
  try {
    const field = data => f.rpc('erp_catalog_custom_field_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).then(value => value.field);
    const text = await field({ field_type: 'text', name: 'Material' }), number = await field({ field_type: 'decimal', name: 'Fator' });
    const date = await field({ field_type: 'date', name: 'Lançamento' }), flag = await field({ field_type: 'boolean', name: 'Importado' });
    const list = await field({ field_type: 'list', name: 'Cor', options: [{ label: 'Azul' }, { label: 'Verde' }] }), other = await field({ field_type: 'list', name: 'Tamanho', options: [{ label: 'P' }] });
    const [azul, verde] = list.options;
    const make = async (name, values, price = '10') => f.product({ name, price, custom_values: values });
    const a = await make('Mesa de Aço', { [text.id]: 'Aço inox', [number.id]: '1.5', [date.id]: '2026-01-10', [flag.id]: 'true', [list.id]: azul.id });
    const b = await make('Cadeira', { [text.id]: 'Madeira', [number.id]: '3', [date.id]: '2026-05-01', [flag.id]: 'false', [list.id]: verde.id });
    await make('Sem campos', {});
    const page = (custom, extra = {}, user = f.users.consulta) => f.rpc('erp_catalog_product_page_custom', { p_user_id: user, p_page: 1, p_size: 100, p_sort: 'name_asc', p_situation: 'latest', p_custom: custom, ...extra });
    const names = async (custom, extra) => (await page(custom, extra)).items.map(item => item.name);
    assert.deepEqual(await names([{ field_id: text.id, value: 'ACO' }]), ['Mesa de Aço'], 'contains, without accents or case');
    assert.deepEqual(await names([{ field_id: number.id, from: '1.5', to: '2' }]), ['Mesa de Aço']);
    assert.deepEqual(await names([{ field_id: number.id, from: '2' }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: date.id, to: '2026-03-01' }]), ['Mesa de Aço']);
    assert.deepEqual(await names([{ field_id: flag.id, value: 'false' }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: list.id, value: verde.id.toUpperCase() }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: list.id, value: azul.id }, { field_id: number.id, from: '2' }]), [], 'every filter applies');
    assert.deepEqual(await names([{ field_id: text.id, value: 'a' }], { p_query: 'cadeira' }), ['Cadeira'], 'with the other filters of the page');
    const result = await page([{ field_id: text.id, value: 'a' }], {}, f.users.vendas);
    const v2 = await f.rpc('erp_catalog_product_page_v2', { p_user_id: f.users.vendas, p_page: 1, p_size: 100, p_sort: 'name_asc', p_situation: 'latest' });
    assert.deepEqual([result.total, result.page, result.size, result.sort, result.stock_visible], [2, 1, 100, 'name_asc', v2.stock_visible]);
    assert.deepEqual(Object.keys(result.items[0]).sort(), Object.keys(v2.items.find(item => item.id === result.items[0].id)).sort(), 'the same item shape as the v2 page');
    const stocked = await page([{ field_id: text.id, value: 'a' }], {}, f.users.estoque);
    assert.deepEqual([stocked.stock_visible, stocked.items.map(row => row.stock.state)], [true, ['no_movements', 'no_movements']]);
    for (const bad of [[], [{ field_id: text.id }], [{ field_id: text.id, value: 'x', from: '1' }], [{ field_id: number.id, value: '1' }], [{ field_id: number.id, from: '3', to: '1' }],
      [{ field_id: number.id, from: '1e3' }], [{ field_id: date.id, from: '2026-02-30' }], [{ field_id: flag.id, value: 'sim' }], [{ field_id: list.id, value: other.options[0].id }],
      [{ field_id: randomUUID(), value: 'x' }], [{ field_id: text.id.toUpperCase(), value: 'x' }], [{ field_id: text.id, value: 'x', extra: 1 }], Array.from({ length: 11 }, () => ({ field_id: text.id, value: 'a' })), { field_id: text.id }])
      await fails(assert, page(bad), '22023');
    await fails(assert, page(null), '22023');
    await fails(assert, page([{ field_id: text.id, value: 'a' }], {}, f.users.inactive), '42501');
    await fails(assert, page([{ field_id: text.id, value: 'a' }], { p_stock: 'zero', p_warehouse_id: randomUUID() }), 'P0002');
    assert.deepEqual((await page([{ field_id: text.id, value: 'a' }], { p_stock: 'no_movements' })).items.map(item => item.name), ['Cadeira', 'Mesa de Aço'], 'with the stock filter');
    // Reajuste "Produtos filtrados" with the same filter: only the matching products change.
    const adjust = (filters, command = randomUUID()) => f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: command, p_rule: { action: 'increase', unit: 'amount', value: '1' }, p_items: null, p_filters: filters });
    const command = randomUUID();
    const applied = await adjust({ situation: 'latest', custom: [{ field_id: list.id, value: azul.id }] }, command);
    assert.deepEqual([applied.total, applied.applied], [1, 1]);
    assert.equal((await adjust({ situation: 'latest', custom: [{ field_id: list.id, value: azul.id }] }, command)).replayed, true);
    const prices = Object.fromEntries((await f.rows('select r.name,p.price::text price from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id')).map(row => [row.name, row.price]));
    assert.deepEqual([prices['Mesa de Aço'], prices.Cadeira], ['11.0000', '10.0000']);
    assert.equal((await adjust({ situation: 'latest', custom: null })).total, 3, 'a null custom filter is no filter');
    await fails(assert, adjust({ situation: 'latest', custom: 'x' }), '22023');
    await fails(assert, adjust({ situation: 'latest', custom: [{ field_id: randomUUID(), value: 'x' }] }), '22023');
    assert.equal(b.version, 1);
  } finally { await f.close(); }
});


test('191 form context: only the confirmed CRT, for every product reader', async () => {
  const f = await produtosDFixture();
  try {
    const context = user => f.rpc('erp_catalog_product_form_context', { p_user_id: user });
    assert.deepEqual(await context(f.users.vendas), { crt: null, data_mode: 'erp_native' });
    await f.write("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{}'::jsonb,$1)", [f.users.admin]);
    await f.write('insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,null,null,null)');
    assert.equal((await context(f.users.estoque)).crt, null, 'not confirmed: unknown');
    await f.write("update erp_company.fiscal set crt='3',confirmed_at=clock_timestamp(),confirmed_by=$1", [f.users.admin]);
    for (const user of [f.users.admin, f.users.consulta, f.users.vendas, f.users.estoque, f.users.fiscal]) assert.equal((await context(user)).crt, '3');
    await fails(assert, context(f.users.inactive), '42501');
    await fails(assert, context(randomUUID()), '42501');
  } finally { await f.close(); }
});

test('191 automatic products from documents: any profile that writes the document, preference, origin, code and replay', async () => {
  const f = await produtosDFixture();
  try {
    const call = async (user, kind, command, item) => { const v = await f.scalar('select erp_catalog.document_product($1,$2,$3,$4::jsonb)::text v', [user, kind, command, JSON.stringify(item)]); await f.sync(); return v; };
    const item = { position: 1, description: 'Serviço de montagem', code: null, unit: 'UN', unit_price: '35.5' };
    const command = randomUUID();
    assert.equal(await call(f.users.vendas, 'sales_orders', command, item), null, 'preference off: nothing is created');
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_vendas', true);
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '2');
    await f.preference('cadastros-produtos', 'produtos.codigo', 'sequencial');
    await f.product({ name: 'Existente numerado', code: '41' });
    const id = await call(f.users.vendas, 'sales_orders', command, item);
    const created = (await f.rpc('erp_catalog_product_get', { p_user_id: f.users.vendas, p_id: id })).record;
    assert.deepEqual([created.name, created.code, created.unit, created.price, created.kind, created.format, created.origin, created.active, created.version],
      ['Serviço de montagem', '42', 'UN', '35.5000', 'P', 'S', '2', true, 1]);
    assert.deepEqual(await f.rows("select actor::text a,action from erp_catalog.audit where record_id=$1", [id]), [{ a: f.users.vendas, action: 'create' }]);
    assert.equal(await call(f.users.vendas, 'sales_orders', command, item), id, 'the same document command and position return the same product');
    await fails(assert, call(f.users.vendas, 'sales_orders', command, { ...item, description: 'Outro' }), '40001');
    // An active product with the same code is linked instead of created.
    const linked = await f.product({ name: 'Parafuso', code: 'PAR-10' });
    assert.equal(await call(f.users.vendas, 'sales_orders', randomUUID(), { position: 1, description: 'Parafuso livre', code: 'par-10', unit: 'UN', unit_price: '1' }), linked.id);
    // Service orders: services (kind S) when the item says so; purchase orders: no sale price.
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_os', true);
    const service = await call(f.users.vendas, 'service_orders', randomUUID(), { position: 2, description: 'Revisão', code: 'SRV-1', unit: 'H', unit_price: '80', kind: 'S' });
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: service })).record.kind, 'S');
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_compras', true);
    const bought = await call(f.users.estoque, 'purchase_orders', randomUUID(), { position: 1, description: 'Chapa', code: 'CH-1', unit: 'KG', unit_price: '9.9' });
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: bought })).record.price, null);
    // The document write permission decides: Vendas does not write purchase orders, Financeiro writes no document.
    await fails(assert, call(f.users.vendas, 'purchase_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.financeiro, 'sales_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.inactive, 'sales_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, product_id: linked.id }), '22023');
    await fails(assert, call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, kind: 'N' }), '22023');
    await assert.rejects(call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, description: '' }), sqlCode('22023'));
  } finally { await f.close(); }
});


test('191 Controle de lote: the switch of the product is stored with the product command and refused with variations', async () => {
  const f = await produtosDFixture();
  try {
    const created = await f.product({ name: 'Leite em pó', lot_control: true });
    assert.equal(created.lot_control, true);
    const off = await f.productSave({ lot_control: false }, { id: created.id, version: created.version });
    assert.deepEqual([off.record.lot_control, off.record.version], [false, created.version + 1]);
    assert.equal((await f.productSave({ lot_control: false }, { id: created.id, version: off.record.version })).record.version, off.record.version, 'unchanged: same version');
    await fails(assert, f.productSave({ lot_control: 'sim' }, { id: created.id, version: off.record.version }), '22023');
    await fails(assert, f.productSave({ lot_control: null }, { id: created.id, version: off.record.version }), '22023');
    await assert.rejects(f.product({ name: 'Camiseta', format: 'V', lot_control: true }), error => error.code === '22023' && /lot_control_variations/.test(error.message));
    const on = await f.productSave({ lot_control: true }, { id: created.id, version: off.record.version });
    await assert.rejects(f.productSave({ format: 'V' }, { id: created.id, version: on.record.version }), error => error.code === '22023' && /lot_control_variations/.test(error.message), 'turning into variations with lots on');
    assert.equal((await f.product({ name: 'Sem lote' })).lot_control, false, 'off by default');
  } finally { await f.close(); }
});

test('191 erp_catalog_save: a new product without Origem gets the Origem padrão; contacts, edits and a given Origem do not change', async () => {
  const f = await produtosDFixture();
  try {
    const save = (entity, data, { id = null, version = 0 } = {}) => f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data }).then(value => value.record);
    assert.equal((await save('products', { name: 'Padrão 0', kind: 'P', format: 'S' })).origin, '0', 'the default of the page is 0, as in the form');
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '2');
    const product = await save('products', { name: 'Importado', kind: 'P', format: 'S' });
    assert.equal(product.origin, '2');
    assert.equal((await save('products', { name: 'Com origem', kind: 'P', format: 'S', origin: '1' })).origin, '1');
    assert.equal((await save('products', { name: 'Editado' }, { id: product.id, version: product.version })).origin, '2', 'an edit keeps the stored Origem');
    assert.equal(Object.hasOwn(await save('contacts', { name: 'Contato', person_type: 'J' }), 'origin'), false);
    const command = randomUUID(), body = { p_user_id: f.users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: command, p_data: { name: 'Repetido', kind: 'P', format: 'S' } };
    const first = await f.rpc('erp_catalog_save', body);
    assert.equal((await f.rpc('erp_catalog_save', body)).replayed, true, 'the same command replays');
    assert.equal(first.record.origin, '2');
    // "Conferir resultado" after the Origem padrão changed still replays the stored result (the request hash keeps the Origem used).
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '5');
    const again = await f.rpc('erp_catalog_save', body);
    assert.deepEqual([again.replayed, again.record.id, again.record.origin], [true, first.record.id, '2']);
    await fails(assert, f.rpc('erp_catalog_save', { ...body, p_data: { name: 'Outro corpo', kind: 'P', format: 'S' } }), '40001');
    await fails(assert, f.rpc('erp_catalog_save', { ...body, p_user_id: f.users.estoque }), '40001');
    // A new command takes the current preference.
    assert.equal((await save('products', { name: 'Novo comando', kind: 'P', format: 'S' })).origin, '5');
    // The product form path: a body without the Origem key gets the default; an explicit empty Origem stays empty.
    assert.equal((await f.product({ name: 'Integração' })).origin, '5');
    assert.equal((await f.product({ name: 'Sem origem', origin: null })).origin, null);
  } finally { await f.close(); }
});

