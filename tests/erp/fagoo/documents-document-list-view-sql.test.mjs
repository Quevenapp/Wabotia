// Cópia de workers/erp-api/test/document-list-view-sql.test.mjs do Fagoo
// (somente leitura) na fixture dupla, pelo Worker real: configurações por
// usuário da listagem de documentos (migração 104).
// Adaptação, só nos auxiliares:
// - banco com todas as migrações (o original aplica 13 migrações de 16/10 e a
//   104), pela documents-fixture.mjs (lane 'B': o Worker saneia toda mensagem
//   de erro, como o original);
// - as pessoas do original (admin, viewer, seller, stock) são f.users.admin,
//   .consulta, .vendas e .estoque;
// - o rpc direto do original é f.rpc.
// Asserções adaptadas, declaradas: o padrão de situações do pedido de venda
// (default_statuses, primeiro e segundo testes) é ['open'] e não
// ['draft', 'open']: a migração 129 (document_rules_numbering) refez
// erp_documents.list_view_default_statuses quando o pedido passou a nascer
// Em aberto. O oráculo, com todas as migrações, responde ['open'].
// Descartado, declarado: a parte de has_function_privilege, prosecdef,
// has_table_privilege e relrowsecurity do primeiro teste (papéis do
// Postgres e RLS, sem equivalente no motor); o resto do teste fica.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { documentsFixture } from './documents-fixture.mjs';

let f, admin, viewer, seller, stock;
const rpc = (name, args) => f.rpc(name, args);
const call = (path, method, body, user = admin) => f.call(path, method, body, user);
const view = (kind, user) => call(`/v1/documentos/${kind}/preferencias-listagem`, 'GET', undefined, user);
const save = (kind, body, user) => call(`/v1/documentos/${kind}/preferencias-listagem`, 'POST', { command_id: randomUUID(), expected_version: 0, custom_view: false, columns: [], default_statuses: [], ...body }, user);

before(async () => {
  f = await documentsFixture({ lane: 'B' });
  ({ admin, consulta: viewer, vendas: seller, estoque: stock } = f.users);
});
after(() => f?.close());

test('104 the Origin defaults: Em aberto (propostas group the open ones) and the standard columns (the grants half is discarded)', async () => {
  const orders = (await view('sales_orders')).value;
  // Adaptada (migração 129): o pedido nasce Em aberto e o padrão é só ['open']; o original esperava ['draft', 'open'].
  assert.deepEqual([orders.custom_view, orders.columns, orders.default_statuses, orders.statuses_saved, orders.version, orders.column_limit], [false, ['date', 'contact', 'total'], ['open'], false, 0, 8], 'pedidos: Em aberto also shows Em digitação, where a new Brufap order starts');
  assert.deepEqual(orders.available_columns, ['date', 'contact', 'total', 'customer_po_number', 'address', 'ship_date', 'contact_email', 'contact_phone', 'contact_document', 'carrier_name']);
  assert.deepEqual((await view('sales_proposals')).value.default_statuses, ['draft', 'open', 'pending', 'waiting']);
  assert.deepEqual((await view('service_orders')).value.columns, []);
  assert.equal((await view('purchase_orders')).status, 404, 'compras keep their own list');
  assert.equal((await view('sales_proposals', stock)).status, 403, 'estoque does not read proposals');
});

test('each user saves their own Tornar padrão and columns with CAS and the same command on retry', async () => {
  const body = { command_id: randomUUID(), expected_version: 0, custom_view: true, columns: ['date', 'contact', 'customer_po_number', 'total'], default_statuses: ['open', 'in_progress'] };
  const first = await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', body, seller);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.deepEqual([first.value.version, first.value.custom_view, first.value.columns, first.value.default_statuses, first.value.statuses_saved, first.value.replayed], [1, true, body.columns, body.default_statuses, true, false]);
  const replay = await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', body, seller);
  assert.equal(replay.value.replayed, true); assert.equal(replay.value.version, 1);
  assert.equal((await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', { ...body, columns: ['date'] }, seller)).status, 409, 'same command, other body');
  assert.equal((await save('sales_orders', { expected_version: 0, default_statuses: ['open'] }, seller)).status, 409, 'stale version');
  const second = await save('sales_orders', { expected_version: 1, default_statuses: [] }, seller);
  assert.deepEqual([second.value.version, second.value.default_statuses, second.value.statuses_saved, second.value.custom_view], [2, [], true, false], 'an empty selection is a saved "Todas"');
  // Adaptada (migração 129), como no primeiro teste: o padrão é ['open'].
  assert.deepEqual((await view('sales_orders', admin)).value.default_statuses, ['open'], 'another user keeps the Origin default');
  assert.equal((await save('service_orders', { default_statuses: ['quoted'] }, viewer)).status, 200, 'consulta keeps its own settings too');
});

test('invalid settings are refused by the Worker and by the database', async () => {
  for (const body of [{ columns: ['unknown'] }, { columns: ['date', 'date'] }, { custom_view: true, columns: [] }, { columns: Array(9).fill('date') }, { default_statuses: ['fulfilled', 'fulfilled'] }, { default_statuses: ['approved'] }, { custom_view: 'sim' }, { expected_version: -1 }, { extra: 1 }])
    assert.equal((await save('sales_orders', body)).status, 400, JSON.stringify(body));
  assert.equal((await save('sales_proposals', { custom_view: true, columns: ['date'] })).status, 400, 'propostas have no custom list');
  await assert.rejects(() => rpc('erp_document_list_view_save', { p_user_id: admin, p_kind: 'sales_orders', p_expected_version: 0, p_command_id: randomUUID(), p_custom_view: false, p_columns: ['date', 'secret'], p_default_statuses: ['open'] }), error => error.code === '22023');
  assert.equal((await call('/v1/documentos/sales_orders/preferencias-listagem?x=1')).status, 400);
});
