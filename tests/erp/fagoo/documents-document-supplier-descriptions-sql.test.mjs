// Cópia de workers/erp-api/test/document-supplier-descriptions-sql.test.mjs do
// Fagoo (somente leitura) na fixture dupla: "Exibir descrição do produto no
// fornecedor" das impressões (294, erp_document_supplier_descriptions), pelo
// Worker real. Os não portados rodam no Postgres e o estado é espelhado.
// Adaptação, só nos auxiliares: documents-e-fixture → documentsLaneFixture('E');
// o INSERT direto de erp_catalog.product_supplier é seguido de f.sync(); o
// `vendas2` do original é f.users.vendedor (papel vendas, outra pessoa).
// O teste do 502: o original troca a função no Postgres por uma que acrescenta
// um item fora do contrato. erp_document_supplier_descriptions é portado e o
// motor TS não veria a troca (o diferencial acusaria a diferença que o próprio
// teste criou); aqui a mesma resposta fora do contrato é montada no fetch do
// Worker (f.hooks.answer), sobre a resposta real conferida nos dois motores.
// Descartado, declarado: o teste 'privileges: erp_document_supplier_descriptions
// runs only for service_role' inteiro (prosecdef/proconfig/provolatile e
// has_function_privilege, papéis do Postgres; PLANO-FAGOO-MOTOR.md, seção 2).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f, supplierA, supplierB, other;
before(async () => {
  f = await documentsLaneFixture('E');
  supplierA = await f.catalog('contacts', { name: 'Fornecedor G294 A' });
  supplierB = await f.catalog('contacts', { name: 'Fornecedor G294 B' });
  other = await f.catalog('products', { name: 'Produto G294 sem descrição', unit: 'UN', kind: 'P', format: 'S', price: '5' });
  await f.db.query(`insert into erp_catalog.product_supplier(record_id,position,supplier_id,description,code,is_default) values
    ($1,1,$2,'Parafuso 3/8 zincado',null,false),($1,2,$3,E'Parafuso\tsextavado',null,true),($4,1,$2,'   ',null,true)`, [f.product.id, supplierA.id, supplierB.id, other.id]);
  await f.sync();
});
after(async () => f?.close());
const read = (kind, id, user = f.users.admin) => f.call(`/v1/documentos/${kind}/${id}/descricoes-fornecedor`, 'GET', undefined, user);

test('sales use the default supplier; the pedido de compra its own supplier; items without a description are left out', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id }), f.line({ product_id: other.id }), f.line()] });
  const r = await read('sales_orders', sale.id);
  assert.equal(r.status, 200, JSON.stringify(r.value));
  assert.deepEqual(r.value.items, [{ item_id: sale.items[0].id, product_id: f.product.id, description: 'Parafuso sextavado' }], 'control characters become a space');
  assert.deepEqual([r.value.kind, r.value.document_id, r.value.data_mode, r.value.operational_effects], ['sales_orders', sale.id, 'erp_native', false]);
  const order = await f.create('purchase_orders', { contact_id: supplierA.id });
  assert.deepEqual((await read('purchase_orders', order.id)).value.items.map(item => item.description), ['Parafuso 3/8 zincado']);
  const fromOther = await f.create('purchase_orders', { contact_id: f.contact.id });
  assert.deepEqual((await read('purchase_orders', fromOther.id)).value.items.map(item => item.description), ['Parafuso sextavado'], 'not a supplier of the product: the default one');
});

test('refusals: query string, unknown document, another kind, profile without read and a contact out of the seller scope', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id })] });
  assert.equal((await f.call(`/v1/documentos/sales_orders/${sale.id}/descricoes-fornecedor?x=1`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${sale.id}/descricoes-fornecedor`, 'POST', {})).status, 405);
  assert.equal((await read('sales_orders', '00000000-0000-4000-8000-000000000294')).status, 404);
  assert.equal((await read('purchase_orders', sale.id)).status, 404, 'the id of another kind is not found');
  const order = await f.create('purchase_orders', { contact_id: supplierA.id });
  assert.equal((await read('purchase_orders', order.id, f.users.vendas)).status, 403, 'Vendas does not read pedidos de compra');
  await f.seller(f.users.vendas2, { name: 'Vendedor G294' });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try { assert.equal((await read('sales_orders', sale.id, f.users.vendas2)).status, 404); }
  finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
});

test('the Worker refuses a response out of contract (502)', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id })] });
  // A resposta real (dos dois motores) || {items:[{item_id,product_id aleatórios, description 'a\nb'}]}, como a função trocada do original.
  f.hooks.answer = (name, value) => name === 'erp_document_supplier_descriptions' ? { ...value, items: [{ item_id: randomUUID(), product_id: randomUUID(), description: 'a\nb' }] } : value;
  try { assert.equal((await read('sales_orders', sale.id)).status, 502); }
  finally { f.hooks.answer = null; }
});
