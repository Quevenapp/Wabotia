// Cópia de tools/migration/test_stock_adversarial.mjs do Fagoo (somente
// leitura), rodando na fixture dupla (tests/erp/harness/dual-fixture.mjs).
// Adaptação: o banco vem da fixture (todas as migrações, não só 6) e os
// auxiliares chamam f.rpc em vez de SQL direto, para o diferencial comparar
// os dois motores a cada erp_stock_post. As asserções são as originais.
// Descartado: o teste de privilégios do Postgres (grants de service_role),
// que não existe no motor (PLANO-FAGOO-MOTOR.md, seção 2).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { stockOperation, stockResponse, stockRoute } from '../../../src/erp/fagoo/workers/erp-api/src/stock.mjs';
import { dualFixture } from '../harness/dual-fixture.mjs';

let f, db;
const users = {};
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const sqlError = code => error => error.code === code;
const catalog = async (entity, data) => (await f.rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
const balances = (product, warehouse) => f.rpc('erp_stock_balances', { p_user_id: users.stock, p_product_id: product, p_warehouse_id: warehouse });
const post = (items, { command = randomUUID(), actor = users.stock, kind = 'receipt' } = {}) => f.rpc('erp_stock_post', {
  p_user_id: actor, p_command_id: command, p_kind: kind, p_occurred_on: '2024-10-15', p_reason: 'Lançamento sintético adversarial', p_items: items, p_reference: null,
});
const reverse = (movement, versions, command = randomUUID()) => f.rpc('erp_stock_reverse', {
  p_user_id: users.stock, p_movement_id: movement, p_command_id: command, p_occurred_on: '2024-10-16', p_reason: 'Estorno sintético adversarial', p_versions: versions,
});
const line = (f, quantity, expected_version = 0, warehouse = f.warehouse) => ({ product_id: f.product, warehouse_id: warehouse, quantity, expected_version });
const version = (f, expected_version, warehouse = f.warehouse) => ({ product_id: f.product, warehouse_id: warehouse, expected_version });
async function fixture() {
  const product = await catalog('products', { name: 'Produto fictício adversarial', unit: 'UN', kind: 'P' });
  const warehouse = await catalog('warehouses', { name: 'Depósito fictício adversarial' });
  const destination = await catalog('warehouses', { name: 'Destino fictício adversarial' });
  return { product: product.id, warehouse: warehouse.id, destination: destination.id };
}
before(async () => {
  f = await dualFixture();
  db = f.db;
  users.admin = f.users.admin;
  users.stock = f.users.estoque;
});
after(async () => f?.close());

test('decimal upper bound stays exact through SQL and HTTP projection; excess leaves no command', async () => {
  const f = await fixture();
  const created = await post([line(f, '999999999999.999999')]);
  assert.equal(created.movement.items[0].balance_after, '999999999999.999999');
  assert.equal(stockResponse(created, { type: 'movements' }, { type: 'mutation' }).movement.items[0].quantity, '999999999999.999999');
  const rejected = randomUUID();
  await assert.rejects(() => post([line(f, '0.000001', 1)], { command: rejected }), sqlError('22023'));
  assert.equal(await scalar('select count(*)::int value from erp_stock.command where id=$1', [rejected]), 0);
  await post([line(f, '-999999999999.999998', 1)], { kind: 'issue' });
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '0.000001');
  assert.equal(await scalar('select sum(quantity)::text value from erp_stock.entry where product_id=$1', [f.product]), '0.000001');
});

test('a later-line failure rolls back earlier lines and the command ID can be retried with corrected input', async () => {
  const f = await fixture();
  // Force the failing position after the successful one in the database order.
  const [first, last] = [f.warehouse, f.destination].sort();
  const command = randomUUID();
  await assert.rejects(() => post([line(f, '1', 0, first), line(f, '-1', 0, last)], { kind: 'adjustment', command }), sqlError('22023'));
  assert.equal(await scalar('select count(*)::int value from erp_stock.balance where product_id=$1', [f.product]), 0);
  assert.equal(await scalar('select count(*)::int value from erp_stock.movement where command_id=$1', [command]), 0);
  assert.equal(await scalar('select count(*)::int value from erp_stock.command where id=$1', [command]), 0);
  const corrected = await post([line(f, '1', 0, first), line(f, '1', 0, last)], { kind: 'adjustment', command });
  assert.equal(corrected.replayed, false);
  assert.equal(corrected.movement.items.length, 2);
  assert.ok(corrected.movement.items.every(item => item.balance_after === '1.000000' && item.balance_version === 1));
});

test('another authorized actor cannot replay or take over an existing command', async () => {
  const f = await fixture(), command = randomUUID();
  const first = await post([line(f, '1')], { command });
  await assert.rejects(() => post([line(f, '1')], { command, actor: users.admin }), sqlError('40001'));
  assert.equal((await post([line(f, '1')], { command })).movement.id, first.movement.id);
  assert.equal((await balances(f.product, f.warehouse)).items[0].version, 1);
});

test('mixed-case duplicate positions cannot bypass SQL or HTTP uniqueness', async () => {
  const f = await fixture();
  const items = [line(f, '1'), { ...line(f, '1'), product_id: f.product.toUpperCase(), warehouse_id: f.warehouse.toUpperCase() }];
  await assert.rejects(() => post(items), sqlError('22023'));
  const url = new URL('https://api.example.test/v1/estoque/movimentos');
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), kind: 'receipt', occurred_on: '2024-10-15', reason: 'Entrada sintética', items }) });
  await assert.rejects(() => stockOperation(request, stockRoute(url.pathname), url.searchParams), error => error.status === 400);
});

test('reversal requires every original position exactly once and preserves conservation after recovery', async () => {
  const f = await fixture();
  await post([line(f, '1.000001')]);
  const transfer = await post([line(f, '-1.000001', 1), line(f, '1.000001', 0, f.destination)], { kind: 'transfer' });
  const good = [version(f, 2), version(f, 1, f.destination)];
  for (const versions of [[good[0]], [good[0], good[0]], [good[0], { ...good[1], expected_version: null }], [good[0], { ...good[1], product_id: randomUUID() }]]) {
    await assert.rejects(() => reverse(transfer.movement.id, versions), sqlError('22023'));
  }
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '0.000000');
  assert.equal((await balances(f.product, f.destination)).items[0].quantity, '1.000001');
  const reversed = await reverse(transfer.movement.id, good);
  assert.equal(reversed.movement.items.reduce((sum, item) => sum + BigInt(item.quantity.replace('.', '')), 0n), 0n);
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '1.000001');
  assert.equal((await balances(f.product, f.destination)).items[0].quantity, '0.000000');
  assert.equal(await scalar('select sum(quantity)::text value from erp_stock.entry where product_id=$1', [f.product]), '1.000001');
});
