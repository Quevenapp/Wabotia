// Cópia de workers/erp-api/test/financeiro-h-commissions-sql.test.mjs do
// Fagoo (somente leitura) na fixture dupla: o relatório de comissões da 370
// (estimada, elegível pelo recebimento, ajustada por devolução e cancelamento,
// paga). O pedido, a confirmação e o lançamento do documento não são do
// Financeiro: rodam no Postgres e o estado é espelhado.
// Adaptação, só nos auxiliares: a fixture dupla; document, transition e
// preference como os do financeiroHFixture, por RPC; SQL direto de escrita
// seguido de F.sync(); a chamada HTTP do relatório pelo finance.mjs do Worker
// (parseFinanceRoute e executeFinanceRoute) em vez do index.mjs.
// Descartado, declarado:
// - o primeiro teste (congelamento da operação na confirmação comercial): só
//   chama RPCs do domínio Documentos (erp_document_commission_operation,
//   erp_document_seller_commission); fica para quem portar Documentos;
// - no segundo, a aba Comissões do documento (/v1/documentos/.../comissao,
//   domínio Documentos) e a conferência de grants das tabelas;
// - o terceiro (recusa de substituir função alterada pela migração): é do
//   processo de migração do Postgres, não do motor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseFinanceRoute, executeFinanceRoute } from '../../../src/erp/fagoo/workers/erp-api/src/finance.mjs';
import { dualFixture } from '../harness/dual-fixture.mjs';

const fails = async (fn, code) => assert.rejects(fn, e => e.code === code);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

async function setup() {
  const F = await dualFixture();
  const users = F.users;
  const rpc = (name, args) => F.rpc(name, args);
  const sql = async (text, args = []) => { const r = await F.db.query(text, args); await F.sync(); return r; };
  const preference = async (page, key, value) => {
    const current = (await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: page })).items.find(item => item.key === key);
    return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value }]) });
  };
  const transition = async (doc, status) => (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Transição sintética' })).document;
  const document = async (kind, { contact, items, date, body = {} }) =>
    (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date, contact_id: contact, ...body, items: items.map(i => ({ unit: 'UN', ...i })) } })).document;
  const client = (await F.catalog('contacts', { name: 'Cliente Sintético' })).id, sellerContact = (await F.catalog('contacts', { name: 'Vendedora Sintética' })).id;
  const seller = (await rpc('erp_catalog_seller_from_contact', { p_user_id: users.admin, p_command_id: randomUUID(), p_contact_id: sellerContact })).seller.id;
  await sql("update erp_catalog.seller set commission_rule='parcial',commission_mode='fixa',commission_rate=5 where id=$1", [seller]);
  await preference('vendas-propostas', 'propostas.exibir_ipi_st', true);
  const account = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2020-01-01', opening_cents: '0' } })).record;
  // Itens 600 + 400, desconto do pedido 100, frete 50, IPI 20 e ICMS ST 10: total 980.
  const order = (body = {}) => document('sales_orders', { contact: client, date: today, body: { seller_id: seller, discount_mode: 'amount', discount_value: '100', freight: '50', tax_ipi: '20', tax_icms_st: '10',
    installments: [{ due_date: '2099-01-10', amount: '490.00' }, { due_date: '2099-02-10', amount: '490.00' }], ...body },
    items: [{ description: 'Peça A', quantity: '1', unit_price: '600' }, { description: 'Peça B', quantity: '1', unit_price: '400' }] });
  const operations = id => F.db.query('select state,rule,base_cents::text base,rate::text rate,estimated_cents::text estimated,policy from erp_finance.commission_operation where document_id=$1 order by created_at', [id]).then(r => r.rows);
  const view = async id => (await rpc('erp_document_commission_operation', { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: id }));
  const post = async document => {
    const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
    const preview = await rpc('erp_document_finance_preview', scope);
    return rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  };
  const confirm = async d => transition(d.status === 'draft' ? await transition(d, 'open') : d, 'verified');
  const call = async (path, user) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`)), { userId: user, rpc: (name, args) => rpc(name, args) });
  return { F, users, rpc, sql, seller, account, order, operations, view, post, confirm, transition, call };
}

test('H 370: eligible pro rata to the receipt, adjusted by a returned conta and by a cancelled sale; the report shows estimated, eligible, paid and adjusted', async () => {
  const { F, users, rpc, sql, seller, account, order, operations, view, post, confirm, transition, call } = await setup(); try {
    let d = await confirm(await order());
    const posted = await post(d);
    // The parcelas of the ledger (171) read the frozen base: 450 + 450, commission 22,50 each.
    const rows = (await F.db.query('select base_cents::text base,commission_cents::text c from erp_finance.commission where document_id=$1 order by position', [d.id])).rows;
    assert.deepEqual(rows.map(r => [r.base, r.c]), [['45000', '2250'], ['45000', '2250']]);
    await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: posted.titles[0].id, expected_version: 1, account_id: account.id, posted_on: today, principal_cents: '49000' } });
    let v = (await view(d.id)).operation;
    assert.deepEqual([v.estimated_cents, v.received_cents, v.eligible_cents, v.adjusted_cents], ['4500', '49000', '2250', '0'], 'half received: R$ 22,50 of R$ 45,00');
    // The second parcela is returned (281): adjustment of its share, once.
    const mark = () => sql("insert into erp_finance.title_return(title_id,source,actor,command_id) values($1,$2,$3,$4) on conflict do nothing", [posted.titles[1].id, { kind: 'document_return', id: 'x', label: 'Devolução sintética' }, users.admin, randomUUID()]);
    await mark(); await mark();
    v = (await view(d.id)).operation;
    assert.deepEqual([v.adjusted_cents, v.net_cents, v.eligible_cents, v.adjustments.length], ['-2250', '2250', '2250', 1]);
    // Reprocessing the same confirmation keeps one operation.
    d = await transition({ ...d, version: (await F.db.query('select version v from erp_documents.document where id=$1', [d.id])).rows[0].v }, 'in_progress');
    assert.equal((await operations(d.id)).filter(o => o.state === 'active').length, 1);
    // A cancelled sale is adjusted to zero.
    const c = await confirm(await order());
    await transition(c, 'cancelled');
    const ended = (await rpc('erp_finance_commission_report', { p_user_id: users.consulta, p_from: today, p_to: today, p_seller_id: null, p_state: 'cancelled', p_page: 1, p_limit: 100 }));
    assert.deepEqual(ended.items.map(i => [i.state, i.estimated_cents, i.adjusted_cents, i.net_cents]), [['cancelled', '4500', '-4500', '0']]);
    // A payment of the seller's statement counts as paid in the report.
    await rpc('erp_finance_commission_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'commission_payment',
      p_data: { seller_id: seller, month: `${today.slice(0, 7)}-01`, posted_on: today, account_id: account.id, amount_cents: '2250', description: 'Pagamento sintético' } });
    const report = await rpc('erp_finance_commission_report', { p_user_id: users.consulta, p_from: today, p_to: today, p_seller_id: seller, p_state: 'all', p_page: 1, p_limit: 100 });
    assert.equal(report.total, 2);
    assert.deepEqual(report.sellers.map(s => [s.name, s.operations, s.estimated_cents, s.adjusted_cents, s.eligible_cents, s.paid_cents]), [['Vendedora Sintética', 2, '9000', '-6750', '2250', '2250']]);
    assert.deepEqual(report.items.map(i => [i.document_number, i.base_cents, i.rate, i.seller_name]), [[d.number, '90000', '5.0000', 'Vendedora Sintética'], [c.number, '90000', '5.0000', 'Vendedora Sintética']]);
    await fails(() => rpc('erp_finance_commission_report', { p_user_id: users.estoque, p_from: today, p_to: today, p_seller_id: null, p_state: 'all', p_page: 1, p_limit: 100 }), '42501');
    await fails(() => rpc('erp_finance_commission_report', { p_user_id: users.consulta, p_from: today, p_to: '2099-01-01', p_seller_id: null, p_state: 'all', p_page: 1, p_limit: 100 }), '22023');
    // The Worker: the report, projected and checked.
    const http = await call(`/v1/financeiro/comissoes-relatorio?from=${today}&to=${today}&vendedor=${seller}`, users.consulta);
    assert.deepEqual([http.total, http.totals.eligible_cents, http.items[0].policy.additions], [2, '2250', ['desconto']]);
    await assert.rejects(() => call(`/v1/financeiro/comissoes-relatorio?from=${today}`, users.consulta), error => error.status === 400);
  } finally { await F.close(); }
});
