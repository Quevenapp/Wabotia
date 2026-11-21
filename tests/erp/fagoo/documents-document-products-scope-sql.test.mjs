// Cópia de workers/erp-api/test/document-products-scope-sql.test.mjs do Fagoo
// (somente leitura) na fixture dupla: produtos automáticos para todo perfil
// que grava o documento, escopo do vendedor nos documentos, filtro Componente
// e as situações Venda Agenciada e Faturado parcialmente (238 e 245), pelo
// Worker real. Os não portados rodam no Postgres e o estado é espelhado.
// Adaptação, só nos auxiliares: documents-e-fixture → documentsLaneFixture('E');
// os UPDATE/DELETE diretos em erp_catalog.seller e contact_profile são
// seguidos de f.sync(); o `vendas2` do original é f.users.vendedor (papel
// vendas, outra pessoa).
// Descartados, declarados:
// - do primeiro teste, a metade de privilégios (prosecdef/proconfig e
//   has_function_privilege, papéis do Postgres; PLANO-FAGOO-MOTOR.md, seção 2);
//   fica a conferência de que a assinatura antiga de erp_document_list sumiu;
// - o teste 'publication: the new API keeps answering a database still on 233'
//   inteiro: abre um banco parado na migração 233; o oráculo tem todas as
//   migrações e no Vinki cada instalação começa com o esquema inteiro
//   (PLANO-FAGOO.md, decisão 2), não há banco "antes da 238" a atender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f;
test.before(async () => { f = await documentsLaneFixture('E'); });
test.after(async () => { await f?.close(); });
const ok = async (path, method = 'GET', body, user = f.users.admin) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.value)}`); return r.value; };
const save = (doc, data, user = f.users.admin) => f.call(`/v1/documentos/${doc.kind}/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data }, user);
const editable = doc => ({ ...f.data(doc.kind), ...Object.fromEntries(Object.entries(doc).filter(([key]) => ['date', 'contact_id', 'warehouse_id', 'discount_mode', 'discount_value', 'freight', 'other_expenses', 'installments', 'commercial'].includes(key))),
  items: doc.items.map(item => ({ id: item.id, product_id: item.product_id, description: item.description, detailed_description: item.detailed_description ?? null, code: item.code, unit: item.unit, quantity: item.quantity, unit_price: item.unit_price, discount_percent: item.discount_percent })) });

test('the old list signature is gone (the privileges half of the original test is discarded)', async () => {
  assert.equal(await f.scalar("select to_regprocedure('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid)') v"), null);
});

test('Cadastrar automaticamente produtos: the free item becomes a product for Vendas too (pedido, proposta and OS)', async () => {
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', true);
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_os', true);
  const order = await f.create('sales_orders', { items: [f.line({ code: 'AUTO-E1', description: 'Peça automática E', unit_price: '12.5' })] }, f.users.vendas);
  const product = order.items[0].product_id;
  assert.ok(product, 'vendas now registers the product of the free item');
  assert.deepEqual(await f.scalar("select jsonb_build_object('name',r.name,'code',r.code,'price',p.price::text,'kind',p.kind) v from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=$1", [product]),
    { name: 'Peça automática E', code: 'AUTO-E1', price: '12.5000', kind: 'P' });
  assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and action='create' and actor=$2", [product, f.users.vendas]), 1, 'audited with the actor of the document');
  const proposal = await f.create('sales_proposals', { items: [f.line({ code: 'auto-e1', description: 'Outra descrição' })] }, f.users.vendas);
  assert.equal(proposal.items[0].product_id, product, 'the same code links to the product');
  const service = await f.create('service_orders', { items: [f.line({ code: 'AUTO-OS-E1', description: 'Peça da OS' })] }, f.users.vendas);
  assert.ok(service.items[0].product_id);
  // A vendedor without "Permite incluir produtos não cadastrados" keeps the 164 refusal (the free item is not turned into a product).
  const sellerId = await f.seller(f.users.vendas2, { allow: false });
  const refused = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { items: [f.line({ code: 'AUTO-E2' })] }) }, f.users.vendas2);
  assert.equal(refused.status, 400);
  assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where code='AUTO-E2'"), 0);
  await f.db.query('update erp_catalog.seller set allow_unregistered_products=true where id=$1', [sellerId]); await f.sync();
  assert.ok((await f.create('sales_orders', { items: [f.line({ code: 'AUTO-E2' })] }, f.users.vendas2)).items[0].product_id);
  await f.db.query('delete from erp_catalog.seller where id=$1', [sellerId]); await f.sync();
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', false);
  const free = await f.create('sales_orders', { items: [f.line({ code: 'AUTO-E3' })] }, f.users.vendas);
  assert.equal(free.items[0].product_id, null, 'with the preference off the item stays free');
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_os', false);
});

test('Contato acessível somente ao vendedor vinculado: list, read, save, history and export follow the seller of the contact', async () => {
  const sellerId = await f.seller(f.users.vendas, { allow: true, name: 'Vendedor escopo' });
  const mine = await f.catalog('contacts', { name: 'Cliente do vendedor' }), other = await f.catalog('contacts', { name: 'Cliente de outro' });
  await f.assign(mine.id, sellerId);
  const a = await f.create('sales_orders', { contact_id: mine.id }), b = await f.create('sales_orders', { contact_id: other.id });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try {
    const listed = await ok('/v1/documentos/sales_orders?page=1&limit=100', 'GET', undefined, f.users.vendas);
    assert.ok(listed.items.some(row => row.id === a.id)); assert.ok(!listed.items.some(row => row.id === b.id));
    assert.ok(listed.items.every(row => row.contact_id === mine.id), 'only the contacts of the seller');
    assert.equal((await f.call(`/v1/documentos/sales_orders/${b.id}`, 'GET', undefined, f.users.vendas)).status, 404);
    assert.equal((await f.call(`/v1/documentos/sales_orders/${a.id}`, 'GET', undefined, f.users.vendas)).status, 200);
    assert.equal((await save(b, editable(b), f.users.vendas)).status, 404, 'a document of another contact is not edited');
    assert.equal((await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { contact_id: other.id }) }, f.users.vendas)).status, 400);
    assert.equal((await f.create('sales_orders', { contact_id: mine.id }, f.users.vendas)).contact_id, mine.id);
    assert.equal((await f.call(`/v1/documentos/sales_orders/historico?contact_id=${other.id}`, 'GET', undefined, f.users.vendas)).status, 404);
    assert.equal((await f.call(`/v1/documentos/sales_orders/historico?contact_id=${mine.id}`, 'GET', undefined, f.users.vendas)).status, 200);
    const exported = await ok('/v1/documentos/sales_orders/exportacao?from=2026-10-01&to=2026-10-31&page=1', 'GET', undefined, f.users.vendas);
    assert.ok(exported.items.every(row => row.contact_name === 'Cliente do vendedor') && exported.items.length >= 2);
    // The administrador is never scoped.
    assert.ok((await ok('/v1/documentos/sales_orders?page=1&limit=100')).items.some(row => row.id === b.id));
  } finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
  assert.ok((await ok('/v1/documentos/sales_orders?page=1&limit=100', 'GET', undefined, f.users.vendas)).items.some(row => row.id === b.id), 'without the preference every contact');
  await f.db.query('update erp_catalog.contact_profile set seller_id=null where seller_id=$1', [sellerId]);
  await f.db.query('delete from erp_catalog.seller where id=$1', [sellerId]);
  await f.sync();
});

test('Componente: the pedidos with a product whose structure has the component', async () => {
  const component = await f.catalog('products', { name: 'Parafuso componente', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  const kit = await f.kit('Kit com parafuso', [[component, '4']]);
  const withKit = await f.create('sales_orders', { items: [f.line({ product_id: kit.id, description: 'Kit com parafuso' })] });
  const plain = await f.create('sales_orders');
  const listed = await ok(`/v1/documentos/sales_orders?page=1&limit=100&component_id=${component.id}`);
  assert.deepEqual(listed.items.map(row => row.id), [withKit.id]); assert.equal(listed.total_count, 1);
  assert.ok(!listed.items.some(row => row.id === plain.id));
  assert.equal((await f.call(`/v1/documentos/sales_proposals?page=1&component_id=${component.id}`)).status, 400, 'only the pedidos de venda');
  assert.equal((await f.call('/v1/documentos/sales_orders?page=1&component_id=nao-e-uuid')).status, 400);
});

test('Venda Agenciada and Faturado parcialmente: transitions, editing, effects and the Gerenciador', async () => {
  const order = await f.create('sales_orders');
  let moved = await f.transition(order, 'agency_sale');
  assert.equal(moved.status, 200, JSON.stringify(moved.value)); let doc = moved.value.document;
  assert.equal(doc.status, 'agency_sale');
  const edited = await save(doc, { ...editable(doc), notes: 'Venda agenciada editada' });
  assert.equal(edited.status, 200, 'Venda Agenciada is editable'); doc = edited.value.document;
  assert.deepEqual((await ok('/v1/documentos/sales_orders?page=1&status=agency_sale')).items.map(row => row.id), [doc.id]);
  moved = await f.transition(doc, 'fulfilled'); assert.equal(moved.status, 200); doc = moved.value.document;
  moved = await f.transition(doc, 'agency_sale'); assert.equal(moved.status, 200); doc = moved.value.document;
  assert.equal((await f.transition(doc, 'partially_invoiced')).status, 400, 'Faturado parcialmente comes only from Atendido parcialmente');
  for (const status of ['in_progress', 'partially_fulfilled', 'partially_invoiced']) { moved = await f.transition(doc, status); assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.value)}`); doc = moved.value.document; }
  assert.equal((await save(doc, editable(doc))).status, 409, 'Faturado parcialmente is locked like Atendido');
  assert.equal((await f.transition(doc, 'open')).status, 400);
  moved = await f.transition(doc, 'partially_fulfilled'); assert.equal(moved.status, 200);
  // With an active effect only the forward moves of 017 and the new pair stay open.
  assert.equal(await f.scalar("select erp_documents.effects_transition_allowed('sales_orders','partially_fulfilled','partially_invoiced') v"), true);
  assert.equal(await f.scalar("select erp_documents.effects_transition_allowed('sales_orders','partially_invoiced','partially_fulfilled') v"), true);
  assert.equal(await f.scalar("select erp_documents.effects_transition_allowed('sales_orders','in_progress','agency_sale') v"), false);
  const situations = await ok('/v1/documentos/sales_orders/situacoes');
  assert.deepEqual(['agency_sale', 'partially_invoiced'].map(key => situations.situations.find(item => item.key === key)?.name), ['Venda Agenciada', 'Faturado parcialmente']);
  // Página inicial: the summary by situação keeps answering with the new situações.
  const home = await ok('/v1/inicio');
  const sales = home.documents.find(row => row.kind === 'sales_orders');
  assert.ok(sales.statuses.some(row => row.status === 'agency_sale') && sales.statuses.some(row => row.status === 'partially_invoiced'));
  const period = await ok('/v1/inicio?periodo=30d');
  assert.ok(period.period.sales.statuses.some(row => row.status === 'partially_invoiced'));
});
