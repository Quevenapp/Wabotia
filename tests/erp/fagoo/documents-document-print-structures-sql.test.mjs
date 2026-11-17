// Cópia de workers/erp-api/test/document-print-structures-sql.test.mjs do
// Fagoo (somente leitura) na fixture dupla: Estrutura dos produtos do documento
// para as impressões (240, erp_document_structures) e "Enviar informações da
// descrição detalhada dos produtos para a venda", pelo Worker real. Os não
// portados rodam no Postgres e o estado é espelhado.
// Adaptação, só nos auxiliares: documents-e-fixture → documentsLaneFixture('E');
// os UPDATE diretos de erp_catalog.product são seguidos de f.sync().
// Descartado, declarado: o teste 'privileges: erp_document_structures runs only
// for service_role' inteiro (prosecdef/proconfig e has_function_privilege,
// papéis do Postgres; PLANO-FAGOO-MOTOR.md, seção 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f;
test.before(async () => { f = await documentsLaneFixture('E'); });
test.after(async () => { await f?.close(); });
const ok = async (path, method = 'GET', body, user = f.users.admin) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.value)}`); return r.value; };

test('Estrutura: the components of each product with the quantity per unit and for the item, and the Produção of the product', async () => {
  const screw = await f.catalog('products', { name: 'Parafuso da estrutura', code: 'PAR-1', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  const kit = await f.kit('Kit de fixação', [[screw, '4']]);
  await f.db.query("update erp_catalog.product set production='third_party' where record_id=$1", [f.product.id]); await f.sync();
  const order = await f.create('sales_orders', { items: [f.line({ product_id: kit.id, description: 'Kit de fixação', quantity: '2.5' }), f.line({ product_id: f.product.id }), f.line({ code: 'LIVRE' })] });
  const read = await ok(`/v1/documentos/sales_orders/${order.id}/estrutura`, 'GET', undefined, f.users.vendas);
  assert.equal(read.items.length, 2, 'only the items with a product');
  const kitRow = read.items.find(item => item.product_id === kit.id), plain = read.items.find(item => item.product_id === f.product.id);
  assert.deepEqual(kitRow.components.map(c => [c.code, c.description, c.unit, c.quantity, c.total]), [['PAR-1', 'Parafuso da estrutura', 'UN', '4.000000', '10.000000']]);
  assert.deepEqual([plain.production, plain.components], ['third_party', []]);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${randomUUID()}/estrutura`)).status, 404);
  assert.equal((await f.call(`/v1/documentos/purchase_orders/${order.id}/estrutura`)).status, 404, 'the kind must match');
  assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/estrutura?x=1`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/service_orders/${order.id}/estrutura`, 'GET', undefined, f.users.estoque)).status, 403);
  await f.db.query("update erp_catalog.product set production=null where record_id=$1", [f.product.id]); await f.sync();
});

test('Enviar informações da descrição detalhada dos produtos para a venda: off, Gerar venda starts without it', async () => {
  const proposal = await f.create('sales_proposals', { items: [f.line({ product_id: f.product.id, detailed_description: 'Descrição detalhada sintética' })] });
  let draft = await ok(`/v1/documentos/sales_orders/a-partir-da-proposta/${proposal.id}`);
  assert.equal(draft.data.items[0].detailed_description, 'Descrição detalhada sintética', 'on by default (the Origin default)');
  await f.setPreference('vendas-propostas', 'propostas.enviar_descricao_venda', false);
  try {
    draft = await ok(`/v1/documentos/sales_orders/a-partir-da-proposta/${proposal.id}`);
    assert.equal(draft.data.items[0].detailed_description, null);
    const service = await ok(`/v1/documentos/service_orders/a-partir-da-proposta/${proposal.id}`);
    assert.equal(service.data.items[0].detailed_description, 'Descrição detalhada sintética', 'the OS keeps it');
  } finally { await f.setPreference('vendas-propostas', 'propostas.enviar_descricao_venda', true); }
});
