import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../../../web/erp/test/helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

const company = '11222333000181', supplier = '19131243000197';
const actor = '20000000-0000-4000-8000-000000000001';
const id = '10000000-0000-4000-8000-000000000001';
const keyFor = issuer => {
  const body = `352611${issuer}55001000000001100000001`;
  let sum = 0, weight = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += Number(body[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const digit = 11 - sum % 11;
  return body + (digit > 9 ? 0 : digit);
};
const key = keyFor(supplier);
const xml = (issuer = supplier, recipient = company, operation = '1') => `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${keyFor(issuer)}" versao="4.00"><ide><mod>55</mod><tpAmb>1</tpAmb><tpNF>${operation}</tpNF><serie>1</serie><nNF>1</nNF></ide><emit><CNPJ>${issuer}</CNPJ><xNome>Emitente de ensaio</xNome></emit><dest><CNPJ>${recipient}</CNPJ><xNome>Destinatário de ensaio</xNome></dest><det nItem="1"><prod><xProd>Mercadoria</xProd><qCom>1</qCom><vUnCom>10</vUnCom><vProd>10</vProd></prod></det></infNFe></NFe></nfeProc>`;
function imported(direction = '0', accessKey = key) {
  const input = normalizeInvoiceInput({ model: '55', direction, issue_type: 'T', series: '1', number: '1', nature_description: 'Compra de ensaio', issue_date: '2026-11-19', crt: '1', purpose: '1', presence: '9', final_consumer: false,
    recipient: { name: 'Fornecedor do ensaio', person_type: 'J', document: supplier }, items: [{ description: 'Mercadoria', quantity: '1', unit_price: '10' }] });
  const totals = invoiceTotals(input);
  return { ...input, id, version: 1, status: 8, environment: null, series: 1, number: 1, access_key: accessKey, protocol: '135260000000001', authorized_at: '2026-11-19T12:00:00Z', issue_type: direction === '0' ? 'X' : 'S',
    items: input.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z', deleted_at: null, delete_reason: null };
}
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
async function press(view, label) {
  const modal = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'Modal');
  let button;
  const visit = value => { if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== 'object') return; if (value.type === 'button' && text(value).trim() === label) button = value; visit(value.props?.children); };
  visit(modal.props.actions); assert.ok(button, label); assert.ok(!button.props.disabled);
  button.props.onClick(); await view.flush();
}
async function fixture(content, response = () => imported('0', /Id="NFe([0-9]{44})"/.exec(content)?.[1]), options = {}) {
  const posts = [], state = { role: 'admin' };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: state.role } }),
    async company() { options.onCompany?.(state); return { section: 'identity', data_mode: 'erp_native', record: { data: { cnpj: company } } }; },
    async fiscalInvoices(path, init) { posts.push({ path, ...init }); return { imported: true, invoice: response(posts.length), matched_items: 0, contact_matched: true }; },
    async finance() { assert.fail('efeito não deve executar sem confirmação própria'); },
    async stock() { assert.fail('efeito não deve executar sem confirmação própria'); },
  };
  const view = await mountComponent('FiscalImportDialog.tsx', { controller, entryOnly: true, initial: { name: 'nota.xml', xml: content }, onClose() {}, onOpen() {} });
  return { view, posts };
}

test('importação de Compras aceita saída do fornecedor e entrada própria, recusando saída própria antes do POST', async () => {
  for (const [content, allowed] of [[xml(), true], [xml(company, supplier, '0'), true], [xml(company, supplier), false], [xml(company, company), false], [xml(supplier, supplier), false]]) {
    const { view, posts } = await fixture(content);
    try {
      await press(view, 'Importar');
      assert.equal(posts.length, allowed ? 1 : 0);
      assert.match(view.text(), allowed ? /importada com sucesso/ : /somente notas de entrada/);
    } finally { view.unmount(); }
  }
});

test('resposta com direção divergente não libera efeitos e repete o mesmo comando', async () => {
  const { view, posts } = await fixture(xml(), attempt => imported(attempt === 1 ? '1' : '0'));
  try {
    await view.change('fiscal-import-finance', true);
    await view.change('fiscal-import-stock', true);
    await press(view, 'Importar');
    assert.match(view.text(), /Não foi possível confirmar/);
    assert.ok(!view.nodes().some(node => typeof node.type === 'function' && ['FiscalInvoiceFinance', 'InvoiceStockDialog'].includes(node.type.name)));
    await press(view, 'Conferir resultado');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.command_id, posts[1].body.command_id);
    assert.equal(posts[0].body.xml, posts[1].body.xml);
    assert.ok(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'FiscalInvoiceFinance'));
  } finally { view.unmount(); }
});

test('falha de XML e perda de papel durante conferência não enviam importação', async () => {
  for (const [content, options] of [['<!DOCTYPE nfe><nfeProc/>', {}], [xml(), { onCompany: state => { state.role = 'consulta'; } }]]) {
    const { view, posts } = await fixture(content, undefined, options);
    try { await press(view, 'Importar'); assert.equal(posts.length, 0); assert.doesNotMatch(view.text(), /importada com sucesso/); }
    finally { view.unmount(); }
  }
});
