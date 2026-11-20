import test from 'node:test';
import assert from 'node:assert/strict';
import { BANK_WRITEOFF_PATH, BANK_WRITEOFF_TEXT, BANK_WRITEOFF_WARNING, bankWriteoffAvailable, bankWriteoffBlocked, bankWriteoffBody, bankWriteoffFailure, bankWriteoffReason, bankWriteoffWhen, bankWriteoffWho, cancelRefusalText, opensBankWriteoff, titleBankWriteoff } from '../app/lib/finance-bank-writeoff.ts';
import { titleDetail } from '../app/lib/finance-title-drawer.ts';

// Synthetic only. Wabotia: "Boleto já baixado no banco" (title_bank_writeoff) na tela do Financeiro.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const title = extra => ({ id: id(1), kind: 'receivable', version: 3, group_id: id(2), installment: 1, installments: 1, contact_id: id(3), contact_name: 'Cliente', category_id: null, category_name: null, description: 'Conta', source_reference: null, issued_on: '2026-01-01', due_on: '2026-02-01', amount_cents: '1000', settled_cents: '0', balance_cents: '1000', cancelled: false, status: 'open', overdue: false, document_linked: false,
  competence_on: '2026-01-01', account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-02-01', deleted_at: null, ...extra });
const refusal = (status, extra = {}) => Object.assign(new Error('access_request_failed'), { status, ...extra });
const writeoff = extra => ({ billing_title_id: id(10), remittance_id: id(11), reason: 'Baixado no internet banking, protocolo 123', declared_by: id(12), declared_by_name: 'Ana Financeiro', declared_at: '2026-11-20T15:04:05.123456Z', ...extra });
const detail = (record, extra = {}) => ({ entity: 'titles', data_mode: 'erp_native', record, origin: null, account: null, billing: { our_number: '123', document_number: '1/1', remittance_id: id(11), remittance_sequence: 4, remittance_state: 'ready', file_generated: true }, imported: false, settled_before: false, original: null, ...extra });

test('o motivo conta como o servidor: sem espaços nas pontas, de 3 a 500 caracteres', () => {
  assert.equal(bankWriteoffReason('  ok!  '), 'ok!');
  for (const bad of ['', '  ', ' ab ', '\n\t a \n']) assert.throws(() => bankWriteoffReason(bad), /pelo menos 3 caracteres/, JSON.stringify(bad));
  assert.equal(bankWriteoffReason('x'.repeat(500)), 'x'.repeat(500));
  assert.equal(bankWriteoffReason(` ${'x'.repeat(500)} `), 'x'.repeat(500), 'as pontas não contam');
  assert.throws(() => bankWriteoffReason('x'.repeat(501)), /até 500/);
  // Caracteres, não bytes: três acentuados bastam; a rota também limita a 500 unidades de texto.
  assert.equal(bankWriteoffReason('ção'), 'ção');
  assert.equal(bankWriteoffReason('😀😀😀'), '😀😀😀');
  assert.throws(() => bankWriteoffReason('😀'.repeat(300)), /até 500/);
});

test('o cancelamento recusado com billed_locked abre a declaração; as outras recusas não', () => {
  assert.equal(opensBankWriteoff(refusal(409, { code: 'ERP_CONFLICT', field: 'billed_locked' })), true);
  for (const other of [refusal(409, { code: 'ERP_CONFLICT' }), refusal(409, { code: 'ERP_CONFLICT', field: 'version_conflict' }), refusal(400, { field: 'billed_locked' }), refusal(403), new Error('x'), null, undefined, 'billed_locked'])
    assert.equal(opensBankWriteoff(other), false);
});

test('o corpo leva command_id novo, a versão da conta e o motivo conferido', () => {
  const command = id(99);
  assert.equal(BANK_WRITEOFF_PATH, '/v1/financeiro/actions/title_bank_writeoff');
  assert.deepEqual(bankWriteoffBody(title({ version: 7 }), '  Baixado no banco em 20/11  ', command), { command_id: command, data: { id: id(1), expected_version: 7, reason: 'Baixado no banco em 20/11' } });
  assert.deepEqual(Object.keys(bankWriteoffBody(title(), 'abc', command).data), ['id', 'expected_version', 'reason'], 'exatamente as chaves que a rota aceita');
  assert.throws(() => bankWriteoffBody(title(), 'ab', command), /pelo menos 3/);
});

test('a ação só aparece na conta a receber em remessa, com Financeiro e Cobrança ligados e a permissão de cancelar', () => {
  const on = () => true, row = extra => title({ remittance: { id: id(11), sequence: 4, state: 'ready', our_number: '123' }, ...extra });
  const access = { read: true, write: true, data_mode: 'erp_native' };
  assert.equal(bankWriteoffAvailable(row(), access, on), true);
  assert.equal(bankWriteoffAvailable(row(), { ...access, permitted: ['financas', 'financas.contas_receber', 'financas.contas_receber.cancelar'] }, on), true);
  assert.equal(bankWriteoffAvailable(row(), { ...access, permitted: ['financas', 'financas.contas_receber', 'financas.contas_receber.ie'] }, on), false, 'sem cancelar');
  assert.equal(bankWriteoffAvailable(row(), { ...access, write: false }, on), false, 'somente consulta');
  assert.equal(bankWriteoffAvailable(row(), null, on), false);
  for (const block of ['erp-financeiro', 'erp-cobranca']) assert.equal(bankWriteoffAvailable(row(), access, b => b !== block), false, block);
  for (const extra of [{ remittance: null }, { kind: 'payable' }, { cancelled: true }, { settled_cents: '100' }, { deleted_at: '2026-11-20T00:00:00Z' }]) assert.equal(bankWriteoffAvailable(row(extra), access, on), false, JSON.stringify(extra));
  assert.equal(bankWriteoffBlocked(on), null);
  assert.match(bankWriteoffBlocked(b => b !== 'erp-cobranca'), /ligue Cobrança bancária em Gestão → Módulos/);
  assert.match(bankWriteoffBlocked(() => false), /ligue Financeiro e Cobrança bancária/);
});

test('as recusas conhecidas têm mensagem própria; nenhuma é "Não foi possível concluir a operação"', () => {
  const cases = [
    [refusal(403, { code: 'ERP_MFA_REQUIRED' }), /segundo fator.*Confirme que é você/],
    [refusal(403, { code: 'ERP_FORBIDDEN', field: 'permission_denied' }), /permissão de cancelar conta.*administrador/],
    [refusal(403, { code: 'ERP_FORBIDDEN' }), /permissão de cancelar conta/],
    [refusal(403, { code: 'ERP_FORBIDDEN', field: 'access_denied' }), /só consulta/],
    [refusal(409, { code: 'ERP_CONFLICT', field: 'version_conflict' }), /Recarregue/],
    [refusal(409, { code: 'ERP_CONFLICT' }), /Recarregue/],
    [refusal(409, { code: 'ERP_CONFLICT', field: 'bank_writeoff_not_applicable' }), /já não está numa remessa.*cancelamento comum/],
    [refusal(409, { code: 'ERP_CONFLICT', field: 'cancelled_title' }), /já está cancelada/],
    [refusal(409, { code: 'ERP_CONFLICT', field: 'active_payments' }), /Estorne a baixa/],
    [refusal(400, { code: 'ERP_INVALID_QUERY', field: 'reason_required' }), /3 a 500/],
    [refusal(409, { code: 'module_disabled' }), /Gestão → Módulos/],
    [refusal(404, { code: 'ERP_NOT_FOUND' }), /não foi encontrada/],
  ];
  for (const [error, expected] of cases) { const text = bankWriteoffFailure(error); assert.match(text, expected, JSON.stringify(error)); assert.doesNotMatch(text, /Não foi possível concluir/); }
  assert.match(bankWriteoffFailure(refusal(503)), /Conferir resultado/, 'resultado incerto repete o mesmo comando');
  assert.match(cancelRefusalText(refusal(409, { field: 'billed_locked' })), /Boleto já baixado no banco/);
  assert.equal(cancelRefusalText(refusal(409, { code: 'ERP_CONFLICT' })), null, 'sem causa conhecida, a mensagem geral da tela');
  assert.equal(cancelRefusalText(new Error('x')), null);
  assert.match(BANK_WRITEOFF_TEXT, /^Este boleto está numa remessa ao banco\. Confirme que ele já foi baixado no banco para cancelar a conta\.$/);
  assert.match(BANK_WRITEOFF_WARNING, /não envia a baixa ao banco/);
  for (const text of [BANK_WRITEOFF_TEXT, BANK_WRITEOFF_WARNING, ...cases.map(([error]) => bankWriteoffFailure(error))]) assert.doesNotMatch(text, /Fagoo|Origin/);
});

test('o detalhe da conta cancelada traz a declaração: quem, quando (São Paulo) e o motivo', () => {
  const read = titleDetail(detail(title({ cancelled: true, status: 'cancelled' }), { bank_writeoff: writeoff() }), id(1), 'receivable');
  assert.deepEqual(read.bank_writeoff, writeoff());
  assert.equal(bankWriteoffWho(read.bank_writeoff), 'Ana Financeiro');
  assert.equal(bankWriteoffWho({ declared_by: id(12), declared_by_name: null }), 'Usuário 10000000');
  assert.equal(bankWriteoffWhen(read.bank_writeoff.declared_at), '20/11/2026, 12:04');
  // Sem declaração a chave não aparece (respostas antigas e contas comuns).
  assert.equal('bank_writeoff' in titleDetail(detail(title()), id(1), 'receivable'), false);
  assert.equal(titleBankWriteoff({}), null);
  assert.equal(titleBankWriteoff({ bank_writeoff: null }), null);
  // Declaração em conta não cancelada, ou malformada, não é aceita.
  assert.throws(() => titleDetail(detail(title(), { bank_writeoff: writeoff() }), id(1), 'receivable'), /Não foi possível conferir/);
  for (const bad of [{ reason: '' }, { declared_by: 'x' }, { declared_at: 'ontem' }, { billing_title_id: null }, { declared_by_name: 5 }])
    assert.throws(() => titleBankWriteoff({ bank_writeoff: writeoff(bad) }), /Não foi possível conferir/, JSON.stringify(bad));
});
