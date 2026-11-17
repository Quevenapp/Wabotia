// Cópia de workers/erp-api/test/document-occurrences-sql.test.mjs do Fagoo
// (somente leitura) na fixture dupla: ocorrências e situações dos documentos
// (103), erp_document_occurrence_add, _occurrence_list e _transition, pelo
// Worker real. Os não portados rodam no Postgres e o estado é espelhado.
// Adaptações, só nos auxiliares:
// - o PGlite próprio do original (cadeia de documentos até a 103, papéis,
//   auth.users e o Worker com fetchImpl) → documentsLaneFixture('B'), que tem
//   o mesmo Worker real e esconde toda mensagem SQL como o original; o banco
//   tem todas as migrações;
// - as pessoas admin, viewer (consulta) e seller (vendas) do original são
//   f.users.admin, f.users.consulta e f.users.vendas;
// - o contato 'Cliente Ocorrência 103' é criado por f.catalog.
// Descartado, declarado: do teste '103 grants', a metade de privilégios
// (has_function_privilege, prosecdef, relrowsecurity e has_table_privilege,
// papéis do Postgres; PLANO-FAGOO-MOTOR.md, seção 2); fica a recusa de
// UPDATE/DELETE nas ocorrências (gatilho de imutabilidade do Postgres).
// Comportamento mudado por migração posterior (o oráculo tem todas), declarado
// também em comentário junto de cada asserção:
// - 202610200129: o pedido de venda novo nasce "Em aberto" (não "Em
//   digitação"), então draft → open é recusado (400) e não grava ocorrência; a
//   lista do segundo teste fica só com o cancelamento (sequência 1, de 'open')
//   e a ocorrência com mudança do terceiro sai de 'open'. No primeiro teste,
//   sem nenhuma ocorrência o UPDATE/DELETE não teria linha para recusar: entra
//   um passo a mais (open → in_progress, 200) antes das recusas;
// - 202610200129: o pedido de compra vai de qualquer situação para qualquer
//   (Em aberto, Em andamento, Atendido, Cancelado), então transitions() não é
//   mais igual a legacy_transitions() para purchase_orders (true → false);
// - 202610200163: com "Permite a edição da data e hora das ocorrências"
//   desligado (o padrão), a data e a hora digitadas dão lugar ao momento atual
//   (a data de hoje no relógio do banco, America/Sao_Paulo, e HH:MM).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';

let f, contact, admin, viewer, seller;
const scalar = (sql, args = []) => f.scalar(sql, args);
const call = (path, method = 'GET', body, user = admin) => f.call(path, method, body, user);
async function ok(path, method = 'GET', body, user) { const r = await call(path, method, body, user); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.value)}`); return r.value; }
const data = (extra = {}) => ({ date: '2026-10-16', contact_id: contact, items: [{ product_id: null, description: 'Item 103', detailed_description: null, code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' }], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], commercial: null, ...extra });
const create = (kind, extra) => ok(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: kind === 'service_orders' ? data({ items: [], ...extra }) : data(extra) }).then(r => r.document);
const status = (doc, target, reason = null, user) => call(`/v1/documentos/${doc.kind}/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: target, reason }, user);
const occurrences = (doc, user) => ok(`/v1/documentos/${doc.kind}/${doc.id}/ocorrencias`, 'GET', undefined, user);
const add = (doc, body, user) => call(`/v1/documentos/${doc.kind}/${doc.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: doc.version, occurred_on: '2026-10-20', occurred_time: '09:15', ...body }, user);

before(async () => {
  f = await documentsLaneFixture('B');
  ({ admin, consulta: viewer, vendas: seller } = f.users);
  contact = (await f.catalog('contacts', { name: 'Cliente Ocorrência 103' })).id;
});
after(() => f?.close());

test('103 grants: occurrence RPCs only for service_role, private helpers, immutable rows behind RLS', async () => {
  const order = await create('sales_orders');
  // 129: the pedido is born "Em aberto"; draft → open is refused and writes no occurrence.
  assert.equal((await status(order, 'open')).status, 400);
  // Added step (declared in the header): one real change, so there is a row for the immutability checks below.
  assert.equal((await status(order, 'in_progress')).status, 200);
  await assert.rejects(() => f.db.query('update erp_documents.occurrence set text=$1', ['alterado']), /immutable/);
  await assert.rejects(() => f.db.query('delete from erp_documents.occurrence'), /immutable/);
});

test('every status change writes one occurrence; the list is newest first and tells who may write', async () => {
  let order = await create('sales_orders');
  // 129: the pedido is born "Em aberto"; draft → open is refused and writes no occurrence.
  assert.equal((await status(order, 'open')).status, 400);
  order = (await status(order, 'cancelled', 'Cliente desistiu')).value.document;
  const listed = await occurrences(order);
  assert.deepEqual(listed.items.map(item => [item.sequence, item.status_before, item.status_after, item.text]), [[1, 'open', 'cancelled', 'Cliente desistiu']]);
  assert.match(listed.items[0].occurred_on, /^\d{4}-\d{2}-\d{2}$/); assert.match(listed.items[0].occurred_time, /^\d{2}:\d{2}$/);
  assert.equal(listed.items[0].actor_id, admin); assert.equal(listed.items[0].actor_role, 'admin'); assert.equal(listed.items[0].document_version, order.version);
  assert.deepEqual([listed.document.status, listed.can_write, listed.has_more], ['cancelled', true, false]);
  assert.equal((await occurrences(order, viewer)).can_write, false, 'consulta reads but does not write');
  assert.equal((await add(order, { text: 'Tentativa da consulta' }, viewer)).status, 403);
});

test('an occurrence with text only keeps the version; with another situação it moves the document once, with the typed date, time and text', async () => {
  let order = await create('sales_orders');
  const body = { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-19', occurred_time: '18:40', text: 'Cliente pediu retorno amanhã' };
  const first = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', body, seller);
  assert.equal(first.document.version, order.version); assert.equal(first.replayed, false);
  // 163: with "Permite a edição da data e hora das ocorrências" off (the default) the typed date and time give way to the current moment.
  const today = await scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date)::text v");
  assert.match(first.occurrence.occurred_time, /^\d{2}:\d{2}$/);
  assert.deepEqual([first.occurrence.occurred_on, first.occurrence.text, first.occurrence.status_after, first.occurrence.actor_role], [today, 'Cliente pediu retorno amanhã', null, 'vendas']);
  const replay = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', body, seller);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.occurrence, first.occurrence);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { ...body, text: 'Outro texto' }, seller)).status, 409, 'same command with another body');
  const moved = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '08:05', text: 'Separado no estoque', status: 'in_progress' });
  assert.equal(moved.document.status, 'in_progress'); assert.equal(moved.document.version, order.version + 1);
  // 129: the pedido was born "Em aberto"; 163: the current moment, not the typed one.
  assert.match(moved.occurrence.occurred_time, /^\d{2}:\d{2}$/);
  assert.deepEqual([moved.occurrence.sequence, moved.occurrence.status_before, moved.occurrence.status_after, moved.occurrence.text, moved.occurrence.occurred_on], [2, 'open', 'in_progress', 'Separado no estoque', today]);
  assert.equal((await occurrences(moved.document)).items.length, 2, 'one occurrence for the change, not two');
  assert.equal(await scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='transition'", [order.id]), 1);
  order = moved.document;
  assert.equal((await add(order, { text: 'Versão antiga', status: 'open' }, admin)).status, 200);
  assert.equal((await add(order, { text: 'Versão antiga de novo' })).status, 409, 'expected_version is checked');
  const later = (await ok(`/v1/documentos/sales_orders/${order.id}`)).document;
  assert.equal((await add(later, { status: 'cancelled', text: 'ok' })).status, 400, 'the text is the cancel reason and needs three characters');
  assert.equal((await add(later, { status: 'cancelled', text: 'Sem estoque' })).status, 200);
});

test('situações go from any to any, keeping the reasons of 008 and asking a reason to leave a closed situação', async () => {
  let order = await create('sales_orders');
  order = (await status(order, 'fulfilled')).value.document;
  assert.equal(order.status, 'fulfilled', 'Em digitação → Atendido directly, as in Origin');
  assert.equal((await status(order, 'in_progress')).status, 400, 'leaving Atendido needs a reason');
  order = (await status(order, 'in_progress', 'Faltou entregar')).value.document;
  assert.equal((await status(order, 'partially_fulfilled')).status, 200);
  let os = await create('service_orders');
  os = (await status(os, 'approved')).value.document;
  os = (await status(os, 'in_progress')).value.document;
  assert.equal(os.status, 'in_progress', '008 forward move keeps working without a reason');
  const quoted = await create('service_orders').then(doc => status(doc, 'approved')).then(r => r.value.document);
  assert.equal((await status(quoted, 'quoted')).status, 400, 'a new move out of Aprovada needs a reason');
  assert.equal((await status(quoted, 'quoted', 'Refazer orçamento')).status, 200);
  const proposal = await create('sales_proposals', { template: true });
  assert.equal((await status(proposal, 'approved')).status, 400, 'a model is never approved');
  assert.equal((await status(proposal, 'pending')).status, 200);
  const done = await create('sales_proposals');
  assert.equal((await status(done, 'completed')).status, 400, 'Concluído comes only from the conversion');
  // 129: Em aberto, Em andamento, Atendido and Cancelado of the pedido de compra go from any to any, so they no longer keep 008.
  assert.equal(await scalar("select (erp_documents.transitions()->'purchase_orders')=(erp_documents.legacy_transitions()->'purchase_orders') v"), false, 'purchase orders no longer keep 008');
});

test('proposal occurrence updates the próximo contato; the Worker refuses invalid occurrences before the database', async () => {
  const proposal = await create('sales_proposals');
  const saved = await ok(`/v1/documentos/sales_proposals/${proposal.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: proposal.version, occurred_on: '2026-10-20', occurred_time: '10:00', text: 'Ligar de novo', next_contact: '2026-10-27' });
  assert.equal(saved.document.next_contact, '2026-10-27'); assert.equal(saved.occurrence.next_contact, '2026-10-27');
  assert.equal(saved.document.version, proposal.version + 1);
  const order = await create('sales_orders');
  for (const body of [{ text: 'x', next_contact: '2026-10-27' }, { text: 'x', occurred_time: '9:00' }, { text: 'x', occurred_on: '2026-02-30' }, { text: 'linha\u0007' }, { text: '   ' }, {}, { text: 'x', status: 'unknown' }, { text: 'x', extra: true }, { text: 'x'.repeat(1001) }])
    assert.equal((await add(order, body)).status, 400, JSON.stringify(body));
  assert.equal((await call(`/v1/documentos/purchase_orders/${order.id}/ocorrencias`)).status, 404);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias?x=1`)).status, 400);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'PATCH', {})).status, 405);
  assert.equal((await add(order, { text: 'Linha 1\nLinha 2' })).status, 200, 'line breaks are kept');
});

test('a multi-line description with a cancel keeps the lines in the occurrence and is a valid single-line reason', async () => {
  const order = await create('sales_orders');
  const result = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '11:00', text: 'Cliente desistiu\nligou às 10h', status: 'cancelled' });
  assert.equal(result.document.status, 'cancelled'); assert.equal(result.occurrence.text, 'Cliente desistiu\nligou às 10h');
  assert.equal(await scalar("select reason v from erp_documents.audit where document_id=$1 and action='transition'", [order.id]), 'Cliente desistiu ligou às 10h');
});
