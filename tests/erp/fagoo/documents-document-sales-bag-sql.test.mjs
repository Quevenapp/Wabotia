// Cópia de workers/erp-api/test/document-sales-bag-sql.test.mjs do Fagoo
// (somente leitura) na fixture dupla: Sacola de vendas (197) pelo Worker real,
// erp_document_sales_bag e _change. Os não portados rodam no Postgres e o
// estado é espelhado.
// Adaptação, só nos auxiliares: documents-d-fixture → documentsLaneFixture('D')
// (banco com todas as migrações, não só até a 190 mais a onda D); o UPDATE
// direto que inativa o produto é seguido de f.sync().
// Descartado, declarado: o teste '197 grants' inteiro (has_function_privilege
// e has_table_privilege, papéis do Postgres; PLANO-FAGOO-MOTOR.md, seção 2).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f;
before(async () => { f = await documentsLaneFixture('D'); });
after(() => f?.close());
const bag = user => f.call('/v1/documentos/sacola-vendas', 'GET', undefined, user);
const change = (body, user) => f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: randomUUID(), ...body }, user);

test('the bag belongs to the user: add sums, set replaces, remove and clear; commands are idempotent', async () => {
  assert.deepEqual((await bag(f.users.vendas)).value.items, []);
  const command = randomUUID();
  const added = await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '1.5' }, f.users.vendas);
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.deepEqual(added.value.items.map(i => [i.name, i.quantity, i.price]), [['Produto sintético D', '1.500000', '10.0000']]);
  const replay = await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '1.5' }, f.users.vendas);
  assert.deepEqual([replay.value.replayed, replay.value.items[0].quantity], [true, '1.500000'], 'a replay never adds again');
  assert.equal((await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '2' }, f.users.vendas)).status, 409);
  assert.equal((await change({ action: 'add', product_id: f.product.id, quantity: '0.5' }, f.users.vendas)).value.items[0].quantity, '2.000000');
  assert.equal((await change({ action: 'add', product_id: f.other.id, quantity: '3' }, f.users.vendas)).value.count, 2);
  assert.equal((await change({ action: 'set', product_id: f.product.id, quantity: '7.25' }, f.users.vendas)).value.items[0].quantity, '7.250000');
  assert.deepEqual((await bag(f.users.admin)).value.items, [], 'another user has another bag');
  assert.equal((await change({ action: 'remove', product_id: f.other.id }, f.users.vendas)).value.count, 1);
  assert.equal((await change({ action: 'clear' }, f.users.vendas)).value.count, 0);
});

test('only who includes pedidos de venda; invalid quantities and inactive products are refused', async () => {
  assert.equal((await bag(f.users.estoque)).status, 403);
  assert.equal((await change({ action: 'add', product_id: f.product.id, quantity: '1' }, f.users.consulta)).status, 403);
  for (const body of [{ action: 'add', product_id: f.product.id, quantity: '0' }, { action: 'add', product_id: f.product.id, quantity: '1,5' }, { action: 'add', product_id: f.product.id, quantity: '1.1234567' },
    { action: 'add', product_id: f.product.id }, { action: 'clear', product_id: f.product.id }, { action: 'drop', product_id: f.product.id }])
    assert.equal((await change(body, f.users.vendas)).status, 400, JSON.stringify(body));
  const inactive = await f.catalog('products', { name: 'Produto inativo', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  await f.db.query('update erp_catalog.record set active=false where id=$1', [inactive.id]); await f.sync();
  assert.equal((await change({ action: 'add', product_id: inactive.id, quantity: '1' }, f.users.vendas)).status, 400);
});
