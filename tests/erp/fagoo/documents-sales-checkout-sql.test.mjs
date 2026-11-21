// Cópia de workers/erp-api/test/sales-checkout-sql.test.mjs do Fagoo (somente
// leitura) na fixture dupla: Vendas › Logística › Checkout de pedidos e a
// situação Checkout parcial (291), erp_document_checkout_lookup, _get e _save,
// pelo Worker real. Os não portados rodam no Postgres e o estado é espelhado.
// Adaptação, só nos auxiliares: documents-e-fixture → documentsLaneFixture('E');
// as escritas diretas no Postgres (o pedido importado e convertido, a troca de
// número) são seguidas de f.sync(); a recusa do DELETE direto em
// checkout_audit fica no Postgres. O pedido "importado e convertido" do
// primeiro teste é uma linha de erp_documents.document com origin='origin' e
// authority='brufap', inserida direto: não depende de espelho nem de
// sincronização do Origin, só da coluna de proveniência (no Vinki a linha
// nunca nasce assim; a regra da busca exata é nativa e fica).
// Descartados, declarados:
// - o teste 'privileges: the checkout RPCs run only for service_role…' inteiro
//   e as três últimas linhas do primeiro teste (has_function_privilege,
//   prosecdef/proconfig e has_table_privilege, papéis do Postgres;
//   PLANO-FAGOO-MOTOR.md, seção 2);
// - a segunda metade do último teste ("the new API keeps a database before
//   291"): abre um banco parado na migração 290; o oráculo tem todas as
//   migrações e no Vinki cada instalação começa com o esquema inteiro
//   (PLANO-FAGOO.md, decisão 2). A Página inicial e as situações ficam.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f, scanned;
before(async () => {
  f = await documentsLaneFixture('E');
  scanned = await f.catalog('products', { name: 'Caneta G291', code: 'CAN-291', unit: 'UN', kind: 'P', format: 'S', price: '2', gtin: '7891234567895' });
});
after(async () => f?.close());
const read = doc => f.call(`/v1/documentos/sales_orders/${doc.id}/checkout`);
const save = (doc, view, reads, command = randomUUID(), user = f.users.admin) => f.call(`/v1/documentos/sales_orders/${doc.id}/checkout`, 'POST',
  { command_id: command, expected_version: view.order.version, checkout_version: view.checkout_version, reads }, user);
const order = () => f.create('sales_orders', { items: [f.line({ product_id: scanned.id, description: 'Caneta', code: 'CAN-291', quantity: '3', unit_price: '2' }), f.line({ product_id: f.product.id, quantity: '1' })] });

test('exact lookup includes converted imported orders and refuses ambiguous, deleted and unauthorized results', async () => {
  const doc = await order();
  const number = '900000001';
  const imported = await f.scalar(`insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
    select kind,$2::bigint,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by,'origin','brufap'
    from erp_documents.document where id=$1 returning id::text v`, [doc.id, number]);
  await f.sync();
  const path = `/v1/documentos/sales_orders/checkout?number=${number}`;
  const found = await f.call(path);
  assert.equal(found.status, 200, JSON.stringify(found.value));
  assert.deepEqual([found.value.id, found.value.number], [imported, number]);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${imported}/checkout`)).status, 200);
  assert.equal((await f.call(path, 'GET', undefined, f.users.consulta)).status, 403);
  for (const query of ['', 'number=0', 'number=01', 'number=1.5', 'number=10000000000', `number=${number}&number=${number}`, `number=${number}&origin=brufap`])
    assert.equal((await f.call(`/v1/documentos/sales_orders/checkout?${query}`)).status, 400, query);
  assert.equal((await f.call('/v1/documentos/sales_orders/checkout?number=900000002')).status, 404);
  await f.db.query('update erp_documents.document set number=$2::bigint where id=$1', [doc.id, number]); await f.sync();
  const ambiguous = await f.call(path);
  assert.deepEqual([ambiguous.status, ambiguous.value.error?.code], [409, 'ERP_DOCUMENT_CHECKOUT_AMBIGUOUS']);
  const removed = await f.call('/v1/documentos/sales_orders/lixeira', 'POST', { command_id: randomUUID(), action: 'delete', ids: [imported], reason: 'Teste de busca na lixeira' });
  assert.equal(removed.value.results?.[0]?.ok, true, JSON.stringify(removed.value));
  assert.equal((await f.call(path)).value.id, doc.id);
});

test('checkout: partial reads go to Checkout parcial and come back; all read goes to Verificado; never above the line', async () => {
  const doc = await order();
  const first = await read(doc);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const view = first.value;
  assert.deepEqual([view.available, view.checkout_version, view.reads, view.lines.length], [true, 0, [], 2]);
  const [pen, other] = view.lines;
  assert.deepEqual([pen.gtin, pen.code, pen.quantity, pen.key], ['7891234567895', 'CAN-291', '3.000000', doc.items[0].id]);
  assert.deepEqual(view.settings, { order: 'nao_ordenar', split: false, picking: false, auto_save: false, quantity_input: false });
  // Partial: Checkout parcial, with the occurrence of the situação.
  const partial = await save(doc, view, [{ key: pen.key, quantity: '2' }]);
  assert.equal(partial.status, 200, JSON.stringify(partial.value));
  assert.deepEqual([partial.value.order.status, partial.value.complete, partial.value.checkout_version, partial.value.reads], ['checkout_partial', false, 1, [{ key: pen.key, quantity: '2.000000' }]]);
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.occurrence where document_id=$1 and status_after='checkout_partial'", [doc.id]), 1);
  const list = await f.call('/v1/documentos/sales_orders?page=1&status=checkout_partial');
  assert.deepEqual([list.status, list.value.items.some(row => row.id === doc.id)], [200, true]);
  const again = (await read(doc)).value;
  assert.deepEqual(again.reads, [{ key: pen.key, quantity: '2.000000' }]);
  // Above the line, unknown line and stale versions are refused.
  assert.equal((await save(doc, again, [{ key: pen.key, quantity: '3.5' }])).value.error?.code, 'ERP_DOCUMENT_CHECKOUT_EXCEEDS');
  assert.equal((await save(doc, again, [{ key: randomUUID(), quantity: '1' }])).status, 400);
  assert.equal((await save(doc, view, [{ key: pen.key, quantity: '3' }])).status, 409, 'the version read is old');
  // Clearing every read goes back to Em aberto.
  const cleared = await save(doc, again, []);
  assert.deepEqual([cleared.status, cleared.value.order?.status], [200, 'open']);
  // Everything read: Verificado, then the checkout is closed.
  const command = randomUUID();
  const done = await save(doc, cleared.value, [{ key: pen.key, quantity: '3' }, { key: other.key, quantity: '1' }], command);
  assert.deepEqual([done.status, done.value.order?.status, done.value.complete], [200, 'verified', true], JSON.stringify(done.value));
  assert.equal((await save(doc, cleared.value, [{ key: pen.key, quantity: '3' }, { key: other.key, quantity: '1' }], command)).value.replayed, true, 'Conferir resultado');
  const closed = (await read(doc)).value;
  assert.equal(closed.available, false);
  assert.equal((await save(doc, closed, [])).value.error?.code, 'ERP_DOCUMENT_CHECKOUT_UNAVAILABLE');
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.checkout_audit where document_id=$1', [doc.id]), 3);
  await assert.rejects(() => f.db.query('delete from erp_documents.checkout_audit'), /erp_document_checkout_audit_immutable/);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${doc.id}/checkout`, 'GET', undefined, f.users.consulta)).status, 403);
});

test('review fix: a pedido edited after a partial checkout keeps only the reads of its current lines, never above them', async () => {
  const rubber = await f.catalog('products', { name: 'Borracha G291', code: 'BOR-291', unit: 'UN', kind: 'P', format: 'S', price: '1', gtin_tax: 'SEM GTIN' });
  const doc = await f.create('sales_orders', { items: [f.line({ product_id: scanned.id, description: 'Caneta', code: 'CAN-291', quantity: '3', unit_price: '2' }),
    f.line({ product_id: rubber.id, description: 'Borracha', code: 'BOR-291', quantity: '2', unit_price: '1' })] });
  const view = (await read(doc)).value;
  assert.deepEqual([view.lines[1].gtin, view.lines[1].gtin_tax, view.lines[1].code], [null, null, 'BOR-291'], 'SEM GTIN is not a code to read');
  const partial = await save(doc, view, [{ key: view.lines[0].key, quantity: '3' }, { key: view.lines[1].key, quantity: '1' }]);
  assert.equal(partial.value.order?.status, 'checkout_partial', JSON.stringify(partial.value));
  // Checkout parcial stays editable: Caneta goes down to 2 and Borracha leaves the pedido.
  const current = (await f.call(`/v1/documentos/sales_orders/${doc.id}`)).value.document;
  const edited = await f.call(`/v1/documentos/sales_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: current.version,
    data: f.data('sales_orders', { items: current.items.slice(0, 1).map(({ position, gross, discount, total, product_snapshot, ...item }) => ({ ...item, quantity: '2' })) }) });
  assert.equal(edited.status, 200, JSON.stringify(edited.value));
  const after = await read(doc);
  assert.equal(after.status, 200, JSON.stringify(after.value));
  assert.deepEqual([after.value.lines.length, after.value.reads, after.value.order.status], [1, [{ key: view.lines[0].key, quantity: '2.000000' }], 'checkout_partial']);
  const done = await save(doc, after.value, [{ key: view.lines[0].key, quantity: '2' }]);
  assert.deepEqual([done.status, done.value.order?.status, done.value.complete], [200, 'verified', true], JSON.stringify(done.value));
});

test('Desmembrar produtos Físico / Virtual: the components of the structure are the lines; the situação keeps its rules', async () => {
  const kit = await f.kit('Kit G291', [[scanned, '2'], [f.product, '1']]);
  await f.setPreference('vendas-vendas', 'vendas.checkout_desmembrar', true);
  try {
    const doc = await f.create('sales_orders', { items: [f.line({ product_id: kit.id, description: 'Kit', quantity: '2', unit_price: '30' })] });
    const view = (await read(doc)).value;
    assert.deepEqual(view.lines.map(item => [item.key, item.quantity, item.component_id]), [[`${doc.items[0].id}:${scanned.id}`, '4.000000', scanned.id], [`${doc.items[0].id}:${f.product.id}`, '2.000000', f.product.id]]);
    const done = await save(doc, view, view.lines.map(item => ({ key: item.key, quantity: item.quantity })));
    assert.deepEqual([done.status, done.value.order?.status], [200, 'verified']);
  } finally { await f.setPreference('vendas-vendas', 'vendas.checkout_desmembrar', false); }
  // Checkout parcial follows the transitions: it goes on to Em andamento or Cancelado and is editable like Em aberto.
  const doc = await order();
  const view = (await read(doc)).value;
  assert.equal((await save(doc, view, [{ key: view.lines[0].key, quantity: '1' }])).value.order?.status, 'checkout_partial');
  const partial = (await f.call(`/v1/documentos/sales_orders/${doc.id}`)).value.document;
  assert.equal(partial.status, 'checkout_partial');
  const edited = await f.call(`/v1/documentos/sales_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: partial.version,
    data: f.data('sales_orders', { notes: 'Conferência parcial', items: partial.items.map(({ position, gross, discount, total, product_snapshot, ...item }) => item) }) });
  assert.equal(edited.status, 200, JSON.stringify(edited.value));
  assert.equal((await f.transition(edited.value.document, 'in_progress')).status, 200);
  assert.equal(await f.scalar("select erp_documents.effects_transition_allowed('sales_orders','checkout_partial','verified') v"), true);
  assert.equal(await f.scalar("select erp_documents.effects_transition_allowed('sales_orders','checkout_partial','fulfilled') v"), false);
});

test('Página inicial and the situações answer with Checkout parcial (the database-before-291 half is discarded)', async () => {
  const home = await f.call('/v1/inicio');
  assert.equal(home.status, 200, JSON.stringify(home.value));
  assert.ok(home.value.documents.find(row => row.kind === 'sales_orders').statuses.some(row => row.status === 'checkout_partial'));
  const situations = await f.call('/v1/documentos/sales_orders/situacoes');
  assert.equal(situations.status, 200, JSON.stringify(situations.value));
  assert.ok(situations.value.situations.some(item => item.key === 'checkout_partial'));
});
