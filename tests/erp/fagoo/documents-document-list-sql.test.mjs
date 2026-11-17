// Cópia de workers/erp-api/test/document-list-sql.test.mjs do Fagoo (somente
// leitura) na fixture dupla: a listagem de documentos com a paridade do Origin
// (095), erp_document_list chamado direto e a projeção estrita do Worker real
// (documentsOperation/documentsResponse, cópia em src/erp/fagoo). Os não
// portados rodam no Postgres e o estado é espelhado.
// Adaptações, só nos auxiliares:
// - purchase-receipts-fixture (sobre a stock-reservation-fixture, PGlite com a
//   cadeia até a 090 e as migrações 015/016/022/095 aplicadas no before) →
//   documentsLaneFixture('B'), banco com todas as migrações; os auxiliares das
//   duas fixtures que o teste usa (order, transition, physical, execute,
//   purchase, selection, receive, legacyPost, com o produto, o depósito e o
//   contato sintéticos 070) são reescritos aqui sobre f.rpc, com as mesmas
//   chamadas;
// - `select public.erp_document_list(...)` → f.rpc('erp_document_list');
// - os INSERT diretos em erp_finance.document_posting e
//   erp_fiscal_drafts.draft são seguidos de f.sync();
// - a recusa esperada (`code`) relança a divergência dos motores, para ela
//   nunca passar como "recusa com outro código".
// Descartado, declarado: do primeiro teste, a metade de privilégios
// (has_function_privilege e prosecdef, papéis do Postgres;
// PLANO-FAGOO-MOTOR.md, seção 2); ficam a conferência de uma só
// erp_document_list e de que a assinatura legada sumiu.
// Comportamento mudado por migração posterior (o oráculo tem todas):
// - 202610200129: o pedido de venda novo nasce "Em aberto" (não "Em
//   digitação"). Os auxiliares `order` e `transition` pulam a mudança para a
//   situação em que o documento já está (o original pedia draft → open, hoje
//   recusado); no teste dos filtros do painel, s1 fica em 'open' e não em
//   'draft': o filtro open+verified traz s1, s2 e s3, e o filtro 'draft' não
//   traz nenhum;
// - 202610200277: o recebimento do pedido de compra usa a data de lançamento
//   do pedido (erp_documents.stock_launch_date: hoje ou a data prevista/data,
//   pela preferência) e recusa outra; o auxiliar `receive` manda essa data em
//   vez da fixa '2026-10-15' do original.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsLaneFixture } from './documents-lanes-fixture.mjs';
import { documentsOperation, documentsResponse, documentsRoute } from '../../../src/erp/fagoo/workers/erp-api/src/documents.mjs';

const DIVERGE = /os motores divergem/;
const code = expected => error => { if (DIVERGE.test(error?.message ?? '')) throw error; return error.code === expected; };
let f;
async function list(args = {}, user = f.users.admin) {
  return f.rpc('erp_document_list', { p_user_id: user, p_kind: 'sales_orders', ...args });
}
const save = async (kind, body) => (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
const line = (price, product = null) => ({ ...(product ? { product_id: product.id } : {}), description: 'Item sintético', unit: 'UN', quantity: '1', unit_price: price });
const ids = page => page.items.map(row => row.id);
// The Origin screen always sends a page and an order; without them the 015 UUID cursor contract applies.
const origin = (args = {}, user) => list({ p_order: 'date_desc', ...(args.p_after ? {} : { p_page: 1 }), ...args }, user);
const numbers = page => page.items.map(row => Number(row.number));
let alfa, gama, w1, w2, p1;

/** Os auxiliares da stock-reservation-fixture e da purchase-receipts-fixture do Fagoo, sobre f.rpc. */
async function stockHelpers(f) {
  const { users } = f;
  const scalar = async (sql, args = []) => { const row = (await f.db.query(sql, args)).rows[0]; return row?.value ?? row?.v; };
  const product = await f.catalog('products', { name: 'Peça sintética070', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  const warehouse = await f.catalog('warehouses', { name: 'Depósito sintético070' });
  const contact = await f.catalog('contacts', { name: 'Contato sintético070' });
  // 129: a document already in the target situação is not moved again (draft → open no longer exists for pedidos).
  const transition = async (doc, status) => doc.status === status ? doc
    : (await f.rpc('erp_document_transition', { p_user_id: users.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Transição sintética' })).document;
  const order = async ({ quantity = '2', items, kind = 'sales_orders' } = {}) => {
    let d = (await f.rpc('erp_document_save', { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-15', contact_id: contact.id, warehouse_id: warehouse.id, items: items ?? [{ product_id: product.id, description: 'Peça sintética', unit: 'UN', quantity, unit_price: '1' }] } })).document;
    for (const s of kind === 'sales_orders' ? ['open', 'verified'] : ['in_progress']) d = await transition(d, s);
    return d;
  };
  const physical = async (quantity, { kind = quantity.startsWith('-') ? 'issue' : 'receipt', command = randomUUID(), target = warehouse.id, extra = {} } = {}) =>
    f.rpc('erp_stock_post', { p_user_id: users.estoque, p_command_id: command, p_kind: kind, p_occurred_on: '2026-10-15', p_reason: 'Movimento sintético070', p_items: [{ product_id: product.id, warehouse_id: target, quantity, expected_version: await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)value', [product.id, target]) }], ...extra });
  const input = (d, action = 'reserve', r = null) => ({ p_user_id: users.estoque, p_document_id: d.id, p_expected_version: d.version, p_action: action, p_occurred_on: '2026-10-15', p_reason: 'Reserva sintética revisada', p_reservation_id: r?.id ?? null, p_reservation_version: r?.version ?? null });
  const preview = async (d, action = 'reserve', r = null) => (await f.rpc('erp_stock_reservation_preview', input(d, action, r))).preview;
  const execute = async (d, { action = 'reserve', reservation = null, prior = null, command = randomUUID(), patch = {} } = {}) => {
    const p = prior ?? await preview(d, action, reservation);
    const args = { ...input(d, action, reservation), p_command_id: command, p_preview_hash: p.preview_hash, p_ignored_item_ids: action === 'reserve' ? p.ignored.map(i => i.id) : null, ...patch };
    const out = await f.rpc('erp_stock_reservation_apply', args); d.version = out.current.document.version; return { ...out, args, preview: p };
  };
  const purchase = async (options = {}) => order({ kind: 'purchase_orders', ...options });
  const selection = async (d, quantity = '1') => (await f.db.query('select id from erp_documents.item where document_id=$1 order by position', [d.id])).rows.map(x => ({ item_id: x.id, quantity }));
  // 277: the receipt date is the launch date of the pedido (erp_documents.stock_launch_date); another date is refused.
  const launchDate = async d => scalar('select erp_documents.stock_launch_date($1)::text v', [d.id]);
  const receiptInput = (d, items, day, extra = {}) => ({ p_user_id: users.estoque, p_document_id: d.id, p_expected_version: d.version, p_occurred_on: day, p_reason: 'Conferência sintética090', p_items: items, ...extra });
  const receiptPreview = async (d, items, extra = {}) => (await f.rpc('erp_purchase_receipts_preview', receiptInput(d, items, await launchDate(d), extra))).preview;
  const receive = async (d, items, { prior, command = randomUUID(), patch = {} } = {}) => {
    const p = prior ?? await receiptPreview(d, items), args = { ...receiptInput(d, items, await launchDate(d)), p_command_id: command, p_preview_hash: p.preview_hash, p_confirm: true, ...patch };
    const out = await f.rpc('erp_purchase_receipts_receive', args); d.version = out.current.document.version; return { ...out, args, preview: p };
  };
  const legacyPreview = async d => (await f.rpc('erp_document_stock_preview', { p_user_id: users.estoque, p_kind: 'purchase_orders', p_document_id: d.id, p_expected_version: d.version, p_occurred_on: '2026-10-15', p_reason: 'Integral sintético018' })).preview;
  const legacyPost = async (d, { prior, command = randomUUID() } = {}) => {
    const p = prior ?? await legacyPreview(d);
    const out = await f.rpc('erp_document_stock_post', { p_user_id: users.estoque, p_kind: 'purchase_orders', p_document_id: d.id, p_expected_version: d.version, p_command_id: command, p_preview_hash: p.preview_hash, p_occurred_on: '2026-10-15', p_reason: 'Integral sintético018', p_ignored_item_ids: p.ignored.map(x => x.id) });
    d.version = out.document_version; return out;
  };
  return { scalar, order, transition, physical, execute, purchase, selection, receive, legacyPost };
}

before(async () => {
  const base = await documentsLaneFixture('B');
  f = { ...base, ...(await stockHelpers(base)) };
  alfa = await f.catalog('contacts', { name: 'Cliente Alfa Sintético', trade_name: 'Fantasia Beta Sintética', document: '12.345.678/0001-90', email: 'compras@alfa.invalid', city: 'Piracicaba', state: 'SP' });
  gama = await f.catalog('contacts', { name: 'Cliente Gama Sintético', document: '98765432100', email: 'gama@exemplo.invalid', city: 'Limeira', state: 'MG' });
  w1 = await f.catalog('warehouses', { name: 'Depósito Norte sintético' }); w2 = await f.catalog('warehouses', { name: 'Depósito Sul sintético' });
  p1 = await f.catalog('products', { name: 'Peça filtrável sintética', unit: 'UN', kind: 'P', format: 'S' });
});
after(() => f?.close());

test('095 keeps one private list overload, legacy named arguments and membership checks', async () => {
  assert.equal(await f.scalar("select count(*)::int value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_document_list'"), 1);
  assert.equal(await f.scalar("select to_regprocedure('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text)') is null value"), true);
  await assert.rejects(() => list({ p_kind: 'purchase_orders' }, f.users.vendas), code('42501'));
  await assert.rejects(() => list({}, randomUUID()), code('42501'));
  await f.order(); await f.order();
  const legacy = await list({ p_status: 'verified', p_limit: 1 });
  assert.equal(legacy.page, null); assert.equal(legacy.order, 'id'); assert.equal(legacy.has_more, true); assert.equal(legacy.next_cursor, legacy.items[0].id);
  const next = await list({ p_status: 'verified', p_limit: 1, p_after: legacy.next_cursor });
  assert.ok(next.items[0].id > legacy.items[0].id, 'legacy cursor callers keep ascending UUID pages'); assert.equal(next.total_count, 2);
  await assert.rejects(() => list({ p_status: 'open', p_statuses: ['open'] }), code('22023'));
});

test('newest first by date then number, numbered pages and exact totals over the whole filtered set', async () => {
  const contact = await f.catalog('contacts', { name: 'Ordem sintética Delta' });
  const made = [];
  for (const [date, price] of [['2026-10-01', '0.10'], ['2026-10-15', '0.20'], ['2026-10-15', '1234.56'], ['2026-09-30', '0.01'], ['2026-10-15', '0.07']]) made.push(await save('sales_orders', { date, contact_id: contact.id, items: [line(price)] }));
  const byDate = made.slice().sort((a, b) => b.date.localeCompare(a.date) || Number(b.number) - Number(a.number));
  const all = await origin({ p_query: 'delta', p_limit: 100 });
  assert.deepEqual(ids(all), byDate.map(row => row.id));
  assert.equal(all.total_count, 5); assert.equal(all.total_amount, '1234.94'); assert.equal(all.has_more, false); assert.equal(all.next_cursor, null);
  const first = await origin({ p_query: 'delta', p_limit: 2, p_page: 1 }), third = await origin({ p_query: 'delta', p_limit: 2, p_page: 3 }), beyond = await origin({ p_query: 'delta', p_limit: 2, p_page: 4 });
  assert.deepEqual(ids(first), byDate.slice(0, 2).map(row => row.id)); assert.equal(first.has_more, true); assert.equal(first.next_cursor, byDate[1].id);
  assert.deepEqual(ids(third), [byDate[4].id]); assert.equal(third.has_more, false);
  assert.deepEqual(ids(beyond), []); assert.equal(beyond.has_more, false);
  for (const page of [first, third, beyond]) { assert.equal(page.total_count, 5); assert.equal(page.total_amount, '1234.94'); }
  assert.deepEqual(numbers(await origin({ p_query: 'delta', p_order: 'number_asc' })), made.map(row => Number(row.number)));
  assert.deepEqual(numbers(await origin({ p_query: 'delta', p_order: 'number_desc' })), made.map(row => Number(row.number)).reverse());
  assert.deepEqual(ids(await origin({ p_query: 'delta', p_order: 'date_asc' })), byDate.slice().reverse().map(row => row.id));
  // The keyset cursor follows the same order and visits every row once, for callers that page with `after`.
  for (const order of ['date_desc', 'date_asc', 'number_asc']) {
    const expected = ids(await origin({ p_query: 'delta', p_order: order })), seen = []; let cursor = null;
    do { const page = await list({ p_query: 'delta', p_order: order, p_limit: 2, p_after: cursor }); assert.equal(page.page, null); assert.equal(page.total_count, 5); seen.push(...ids(page)); cursor = page.next_cursor; } while (cursor);
    assert.deepEqual(seen, expected, order);
  }
  for (const args of [{ p_page: 1, p_after: made[0].id }, { p_page: 0 }, { p_page: 100001 }, { p_order: 'total_desc' }, { p_order: null }, { p_after: randomUUID() }, { p_limit: 101 }])
    await assert.rejects(() => origin({ p_query: 'delta', ...args }), code('22023'), JSON.stringify(args));
});

test('search covers number, name, fantasia, e-mail and CPF/CNPJ with or without mask, never internal notes', async () => {
  const a = await save('sales_proposals', { date: '2026-10-10', contact_id: alfa.id, items: [line('5')], internal_notes: 'NOTA_PRIVADA_SINTETICA' });
  const g = await save('sales_proposals', { date: '2026-10-11', contact_id: gama.id, items: [line('7')] });
  const search = async q => ids(await list({ p_kind: 'sales_proposals', p_query: q }));
  for (const q of ['12345678000190', '12.345.678/0001-90', '345.678/0001', 'compras@ALFA', 'fantasia beta', 'Cliente Alfa']) assert.deepEqual(await search(q), [a.id], q);
  for (const q of ['987.654.321-00', '98765432100', 'gama@exemplo']) assert.deepEqual(await search(q), [g.id], q);
  assert.ok((await search(a.number)).includes(a.id));
  // Short numbers search document numbers only; CPF/CNPJ digits need at least five digits.
  assert.deepEqual(await search('9876'), []);
  for (const q of ['NOTA_PRIVADA_SINTETICA', "' or true --", '%']) assert.deepEqual(await search(q), [], q);
});

test('panel filters: multi situação, date types, depósito, produto, cidade/UF and kind-specific text', async () => {
  const contact = await f.catalog('contacts', { name: 'Filtro sintético Épsilon', city: 'Piracicaba', state: 'sp' });
  const s1 = await save('sales_orders', { date: '2026-08-01', expected_date: '2026-08-20', contact_id: contact.id, warehouse_id: w1.id, items: [line('1', p1)] });
  let s2 = await save('sales_orders', { date: '2026-08-02', expected_date: '2026-09-05', contact_id: contact.id, warehouse_id: w2.id, items: [line('2')] });
  s2 = await f.transition(s2, 'open'); let s3 = await save('sales_orders', { date: '2026-08-03', contact_id: contact.id, items: [line('3')] });
  s3 = await f.transition(await f.transition(s3, 'open'), 'verified');
  const q = { p_query: 'épsilon' };
  // 129: s1 is born "Em aberto" too, so it is in the open+verified filter and nothing is in 'draft'.
  assert.deepEqual(new Set(ids(await list({ ...q, p_statuses: ['open', 'verified'] }))), new Set([s1.id, s2.id, s3.id]));
  assert.deepEqual(ids(await list({ ...q, p_statuses: ['draft'] })), []);
  for (const statuses of [[], ['open', 'open'], ['finalized'], ['open', 'NULL']]) await assert.rejects(() => list({ ...q, p_statuses: statuses }), code('22023'), JSON.stringify(statuses));
  assert.deepEqual(ids(await list({ ...q, p_date_type: 'expected_date', p_date_from: '2026-08-15', p_date_to: '2026-08-31' })), [s1.id]);
  assert.deepEqual(ids(await list({ ...q, p_date_type: 'expected_date', p_date_from: '2026-09-01' })), [s2.id]);
  assert.equal((await list({ ...q, p_date_type: 'date', p_date_from: '2026-08-02', p_date_to: '2026-08-03' })).total_count, 2);
  await assert.rejects(() => list({ ...q, p_date_type: 'next_contact' }), code('22023'));
  await assert.rejects(() => list({ ...q, p_date_type: 'expected_date', p_date_from: '2026-09-02', p_date_to: '2026-09-01' }), code('22023'));
  assert.deepEqual(ids(await list({ ...q, p_warehouse_id: w2.id })), [s2.id]);
  assert.deepEqual(ids(await list({ ...q, p_product_id: p1.id })), [s1.id]);
  assert.equal((await list({ ...q, p_city: '  PIRACI ', p_state: 'SP' })).total_count, 3);
  assert.equal((await list({ ...q, p_state: 'MG' })).total_count, 0);
  for (const args of [{ p_state: 'sp' }, { p_state: 'XX' }, { p_city: '   ' }, { p_city: 'a\nb' }, { p_technician: 'x' }, { p_internal_note: 'x' }, { p_city: 'x'.repeat(101) }])
    await assert.rejects(() => list({ ...q, ...args }), code('22023'), JSON.stringify(args));
  const proposal = await save('sales_proposals', { date: '2026-08-04', next_contact: '2026-08-30', contact_id: contact.id, items: [line('4')] });
  assert.deepEqual(ids(await list({ ...q, p_kind: 'sales_proposals', p_date_type: 'next_contact', p_date_from: '2026-08-30', p_date_to: '2026-08-30' })), [proposal.id]);
  const os = await save('service_orders', { date: '2026-08-05', contact_id: contact.id, items: [], equipment: 'Bomba sintética', serial_number: 'SN-SINT-01', technician: 'Técnico Sintético' });
  for (const args of [{ p_technician: 'técnico sint' }, { p_equipment: 'BOMBA' }, { p_serial_number: 'sint-01' }]) assert.deepEqual(ids(await list({ ...q, p_kind: 'service_orders', ...args })), [os.id], JSON.stringify(args));
  await assert.rejects(() => list({ ...q, p_kind: 'service_orders', p_city: 'Piracicaba' }), code('22023'));
  const purchase = await save('purchase_orders', { date: '2026-08-06', contact_id: contact.id, items: [line('6')], internal_notes: 'Conferir lote sintético na chegada' });
  assert.deepEqual(ids(await list({ ...q, p_kind: 'purchase_orders', p_internal_note: 'LOTE sintético' })), [purchase.id]);
  assert.equal((await list({ ...q, p_kind: 'purchase_orders', p_internal_note: 'inexistente' })).total_count, 0);
});

test('row indicators come from existing effects only; the nota indicator is visible to admin and fiscal only', async () => {
  const contact = await f.catalog('contacts', { name: 'Indicador sintético Zeta' });
  let proposal = await save('sales_proposals', { date: '2026-07-01', contact_id: contact.id, warehouse_id: w1.id, items: [line('10')], internal_notes: 'x'.repeat(300) });
  proposal = await f.transition(await f.transition(proposal, 'open'), 'approved');
  const converted = await f.rpc('erp_proposal_convert', { p_user_id: f.users.admin, p_id: proposal.id, p_expected_version: proposal.version, p_command_id: randomUUID() });
  const sale = converted.sale;
  await f.db.query("insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id) values($1,$2,$3,'{}'::jsonb,$4,$5,$6)", [sale.id, sale.version, randomUUID(), 'a'.repeat(64), f.users.admin, randomUUID()]);
  await f.db.query("insert into erp_fiscal_drafts.draft(model,source_document_id,source_document_version,snapshot,snapshot_hash,preparation) values('55',$1,$2,'{}'::jsonb,$3,'{}'::jsonb)", [sale.id, sale.version, 'b'.repeat(64)]);
  await f.sync();
  const rows = async (kind, user = f.users.admin) => (await list({ p_kind: kind, p_query: 'zeta' }, user)).items;
  const [saleRow] = await rows('sales_orders');
  assert.equal(saleRow.id, sale.id); assert.equal(saleRow.source_proposal_id, proposal.id); assert.equal(saleRow.source_proposal_number, proposal.number);
  assert.equal(saleRow.finance_active, true); assert.equal(saleRow.stock_active, false); assert.equal(saleRow.fiscal_draft, true);
  assert.equal(saleRow.warehouse_name, 'Depósito Norte sintético'); assert.equal(saleRow.internal_notes.length, 280);
  assert.equal((await rows('sales_orders', f.users.fiscal))[0].fiscal_draft, true);
  for (const role of ['consulta', 'vendas', 'financeiro', 'estoque']) assert.equal((await rows('sales_orders', f.users[role]))[0].fiscal_draft, null, role);
  // Reservation and depósito name follow the stock read profiles (009): financeiro reads the order, not the stock.
  for (const role of ['consulta', 'vendas', 'fiscal', 'estoque']) { const [own] = await rows('sales_orders', f.users[role]); assert.equal(own.warehouse_name, 'Depósito Norte sintético', role); assert.equal(own.reservation_active, false, role); }
  const [finance] = await rows('sales_orders', f.users.financeiro);
  assert.equal(finance.warehouse_name, null); assert.equal(finance.reservation_active, null); assert.equal(finance.warehouse_id, saleRow.warehouse_id); assert.equal(finance.finance_active, true);
  const [proposalRow] = await rows('sales_proposals');
  assert.equal(proposalRow.status, 'completed'); assert.equal(proposalRow.fiscal_draft, null); assert.equal(proposalRow.template, false);
  await f.physical('20'); const reserved = await f.order(); await f.execute(reserved);
  const reservedRow = (await list({ p_kind: 'sales_orders', p_query: reserved.number })).items.find(row => row.id === reserved.id);
  assert.equal(reservedRow.reservation_active, true); assert.equal(reservedRow.stock_active, false);
  assert.equal((await list({ p_kind: 'sales_orders', p_query: reserved.number }, f.users.financeiro)).items.find(row => row.id === reserved.id).reservation_active, null, 'financeiro never learns about stock reservations');
  const legacy = await f.purchase({ quantity: '2' }); await f.legacyPost(legacy);
  const received = await f.purchase({ quantity: '2' }); await f.receive(received, await f.selection(received));
  const purchases = (await list({ p_kind: 'purchase_orders', p_limit: 100 })).items;
  const legacyRow = purchases.find(row => row.id === legacy.id), receivedRow = purchases.find(row => row.id === received.id);
  assert.equal(legacyRow.stock_active, true); assert.equal(legacyRow.receipt_active, false);
  assert.equal(receivedRow.receipt_active, true); assert.equal(receivedRow.reservation_active, false); assert.equal(receivedRow.fiscal_draft, null);
});

test('real SQL pages cross the strict worker projection; tampered rows are rejected', async () => {
  const request = path => { const url = new URL(`https://api.example.test${path}`); const route = documentsRoute(url.pathname); return { route, url }; };
  // Page 9 lies past the end of the five delta orders: an empty page, never a 502.
  for (const path of ['/v1/documentos/sales_orders?limit=2&page=1&q=delta', '/v1/documentos/sales_orders?limit=2&page=9&q=delta', '/v1/documentos/sales_orders?limit=100&page=1&q=zeta', '/v1/documentos/purchase_orders?limit=100&page=1', '/v1/documentos/sales_proposals?limit=100&page=1&order=number_asc&status=completed,approved']) {
    const { route, url } = request(path); const operation = await documentsOperation(new Request(url), route, url.searchParams);
    const raw = await list({ ...operation.args, p_user_id: f.users.admin });
    const projected = documentsResponse(raw, route, operation);
    assert.equal(projected.total_count, raw.total_count, path); assert.equal(projected.items.length, raw.items.length);
    assert.doesNotMatch(JSON.stringify(projected), /snapshot|"notes"|PRIVATE|Item sintético|unit_price/, 'only the internal note preview leaves the list, never the body, items or public notes');
    if (raw.items.length) {
      for (const tamper of [{ fiscal_draft: route.kind === 'sales_orders' ? 'yes' : true }, { finance_active: null }, { internal_notes: 'x'.repeat(281) }, { source_proposal_number: raw.items[0].source_proposal_id ? null : '1' }])
        assert.throws(() => documentsResponse({ ...raw, items: [{ ...raw.items[0], ...tamper }, ...raw.items.slice(1)] }, route, operation), error => error.status === 502, JSON.stringify(tamper));
      // A total smaller than the rows already listed cannot come from the same filtered set.
      assert.throws(() => documentsResponse({ ...raw, total_count: (raw.page - 1) * raw.limit + raw.items.length - 1 }, route, operation), error => error.status === 502);
    }
    assert.throws(() => documentsResponse({ ...raw, has_more: !raw.has_more }, route, operation), error => error.status === 502);
    assert.throws(() => documentsResponse({ ...raw, page: 2 }, route, operation), error => error.status === 502);
    assert.throws(() => documentsResponse({ ...raw, total_amount: '1.5' }, route, operation), error => error.status === 502);
  }
});

test('names and the internal note preview are limited in characters, so emoji never turn a page into a 502', async () => {
  const contact = await f.catalog('contacts', { name: `Emoji sintético ${'😀'.repeat(100)}` });
  const doc = await save('sales_orders', { date: '2026-06-01', contact_id: contact.id, items: [line('1')], internal_notes: '😀'.repeat(300) });
  const url = new URL('https://api.example.test/v1/documentos/sales_orders?limit=100&page=1&q=emoji'), route = documentsRoute(url.pathname);
  const operation = await documentsOperation(new Request(url), route, url.searchParams);
  const [projected] = documentsResponse(await list({ ...operation.args, p_user_id: f.users.admin }), route, operation).items;
  assert.equal(projected.id, doc.id); assert.equal([...projected.internal_notes].length, 280); assert.equal(projected.internal_notes.length, 560);
  assert.equal(projected.contact_name, contact.name);
});
