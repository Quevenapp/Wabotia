import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFieldFilters, contactFieldData, contactFieldDraft, contactFieldInput, contactFieldSheetColumns, contactFieldText, contactFieldsBase, contactFieldsPayload,
  fieldColumns, fieldFilterChip, listColumnFields, matchesFieldFilters, rowFieldValues,
} from '../app/lib/contact-fields.ts';
import { importRows, modelCsv } from '../app/lib/contact-import-model.ts';
import { setErpPorts } from '../ports.ts';

// Campos próprios de contato no painel (Wabotia, esquema do ERP versão 20): a mesma regra de valores do motor, o texto de cada
// valor, filtros, exportação e importação pela coluna com o nome do campo, e o rascunho da definição. Dados sintéticos.
const field = (id, name, field_type, extra = {}) => ({ id, name, field_type, required: false, roles: ['customer'], options: [], sensitive: false, exposed: false,
  list_column: false, list_filter: false, active: true, version: 1, ...extra });
const SIZE = field('00000000-0000-4000-8000-000000000001', 'Porte', 'list', { options: [{ id: '00000000-0000-4000-8000-0000000000a1', label: 'Pequeno' }, { id: '00000000-0000-4000-8000-0000000000a2', label: 'Grande' }], list_filter: true, list_column: true });
const VIP = field('00000000-0000-4000-8000-000000000002', 'Cliente VIP', 'boolean', { list_filter: true });
const LIMIT = field('00000000-0000-4000-8000-000000000003', 'Limite combinado', 'number', { list_filter: true });
const VISIT = field('00000000-0000-4000-8000-000000000004', 'Última visita', 'date', { required: true });
const NOTE = field('00000000-0000-4000-8000-000000000005', 'Apelido', 'text');

test('valores: a mesma regra do motor, com a mensagem que diz o que corrigir', () => {
  assert.deepEqual(contactFieldInput(LIMIT, '1500,50'), { value: '1500.5' });
  assert.deepEqual(contactFieldInput(LIMIT, '-0,00'), { value: '0' });
  assert.match(contactFieldInput(LIMIT, '1.500,50').error, /sem separador de milhar/);
  assert.deepEqual(contactFieldInput(LIMIT, '1.500,50', { sheet: true }), { value: '1500.5' }, 'na planilha o ponto de milhar sai');
  assert.deepEqual(contactFieldInput(VISIT, '05/11/2026'), { value: '2026-11-05' });
  assert.deepEqual(contactFieldInput(VISIT, '46000', { sheet: true }), { value: '2025-12-09' }, 'data do Excel');
  assert.match(contactFieldInput(VISIT, '31/02/2026').error, /data válida/);
  assert.match(contactFieldInput(VISIT, '').error, /obrigatório/);
  assert.deepEqual(contactFieldInput(VISIT, '', { sheet: true }), { value: null }, 'na importação o vazio não é recusado');
  assert.deepEqual(contactFieldInput(SIZE, 'grande'), { value: SIZE.options[1].id });
  assert.match(contactFieldInput(SIZE, 'Médio').error, /opções da lista/);
  assert.deepEqual(contactFieldInput(VIP, 'Não'), { value: 'false' });
  assert.match(contactFieldInput(NOTE, 'a\nb').error, /em uma linha/);
  assert.equal(contactFieldText(SIZE, SIZE.options[0].id), 'Pequeno');
  assert.equal(contactFieldText(VIP, 'true'), 'Sim');
  assert.equal(contactFieldText(VISIT, '2026-11-05'), '05/11/2026');
  assert.equal(contactFieldText(LIMIT, '1500.5'), '1500,5');
  const payload = contactFieldsPayload([NOTE, VISIT], { [NOTE.id]: ' Zé ', [VISIT.id]: '' });
  assert.equal(payload.field, VISIT.id);
  assert.deepEqual(contactFieldsPayload([NOTE], { [NOTE.id]: '' }), { values: { [NOTE.id]: null } }, 'vazio limpa');
});

test('lista: filtros preenchidos, texto do filtro aplicado e o mesmo filtro na exportação', () => {
  const filters = activeFieldFilters([SIZE, VIP, LIMIT, NOTE], { [SIZE.id]: { value: SIZE.options[1].id }, [VIP.id]: { value: '' }, [LIMIT.id]: { from: '100', to: '' }, [NOTE.id]: { value: 'x' } });
  assert.deepEqual(filters, [{ field_id: SIZE.id, value: SIZE.options[1].id }, { field_id: LIMIT.id, from: '100' }], 'campo sem filtro marcado fica de fora');
  assert.equal(fieldFilterChip(SIZE, filters[0]), 'Porte: Grande');
  assert.equal(fieldFilterChip(LIMIT, filters[1]), 'Limite combinado: a partir de 100');
  assert.equal(matchesFieldFilters([SIZE, LIMIT], filters, { [SIZE.id]: SIZE.options[1].id, [LIMIT.id]: '250' }), true);
  assert.equal(matchesFieldFilters([SIZE, LIMIT], filters, { [SIZE.id]: SIZE.options[1].id, [LIMIT.id]: '20' }), false);
  assert.equal(matchesFieldFilters([VIP], [{ field_id: VIP.id, value: 'false' }], {}), true, 'sem valor conta como Não');
  assert.deepEqual(listColumnFields([SIZE, VIP]).map(f => f.id), [SIZE.id]);
  const sheet = contactFieldSheetColumns([SIZE, LIMIT]);
  assert.deepEqual(sheet.header, [{ text: 'Porte' }, { text: 'Limite combinado' }]);
  assert.deepEqual(sheet.cells({ [SIZE.id]: SIZE.options[0].id, [LIMIT.id]: '10.5' }), [{ text: 'Pequeno' }, { number: '10.5' }]);
});

test('importação: coluna com o nome do campo, sem acento nem caixa; valor que não confere deixa a linha de fora', () => {
  const header = ['Nome', 'PORTE', 'cliente vip', 'Coluna estranha'];
  const columns = fieldColumns(header, [SIZE, VIP, NOTE]);
  assert.deepEqual([...columns.entries()], [[SIZE.id, 1], [VIP.id, 2]]);
  assert.deepEqual(rowFieldValues(['Ana', 'Grande', 'sim', ''], columns, [SIZE, VIP]), { values: { [SIZE.id]: SIZE.options[1].id, [VIP.id]: 'true' }, problems: [] });
  const parsed = importRows([header, ['Ana', 'Grande', 'Sim', 'x'], ['Bia', 'Médio', '', '']], [], [SIZE, VIP]);
  assert.deepEqual(parsed.unknown, ['Coluna estranha'], 'campo próprio não é coluna fora do modelo');
  assert.deepEqual(parsed.rows[0].custom, { [SIZE.id]: SIZE.options[1].id, [VIP.id]: 'true' });
  assert.equal(parsed.rows[0].problems.length, 0);
  assert.match(parsed.rows[1].problems.join(';'), /Porte/);
  // Sem campos próprios, a importação é a de antes.
  assert.equal(importRows([['Nome'], ['Ana']], []).rows[0].custom, undefined);
  assert.match(modelCsv([SIZE, VIP]), /"Porte";"Cliente VIP"\r\n$/);
  assert.doesNotMatch(modelCsv(), /Porte/);
});

test('definição: o rascunho conferido como o servidor; sensível sem liberação não vira coluna nem filtro', () => {
  assert.equal(contactFieldData({ ...contactFieldDraft(), name: '' }).field, 'name');
  assert.equal(contactFieldData({ ...contactFieldDraft(), name: 'Sem papel', roles: [] }).field, 'roles');
  assert.equal(contactFieldData({ ...contactFieldDraft(), name: 'Lista', field_type: 'list' }).field, 'options');
  assert.match(contactFieldData({ ...contactFieldDraft(), name: 'Lista', field_type: 'list', options: [{ id: null, label: 'A', key: '1' }, { id: null, label: ' a ', key: '2' }] }).error, /repetidas/);
  const sensitive = contactFieldData({ ...contactFieldDraft(), name: 'Saúde', sensitive: true, list_column: true, list_filter: true });
  assert.deepEqual([sensitive.data.list_column, sensitive.data.list_filter, sensitive.data.exposed, sensitive.exposing], [false, false, false, false]);
  const exposing = contactFieldData({ ...contactFieldDraft(), name: 'Saúde', sensitive: true, exposed: true, list_column: true });
  assert.deepEqual([exposing.data.list_column, exposing.exposing], [true, true], 'liberar pede o aviso (exposing)');
  const kept = contactFieldData(contactFieldDraft({ ...SIZE }), SIZE);
  assert.deepEqual(kept.data.options, SIZE.options, 'opções mantidas levam o id');
  assert.deepEqual(contactFieldData({ ...contactFieldDraft(), name: 'Nova', field_type: 'list', options: [{ id: 'x', label: 'Um', key: 'k' }] }, null).data.options, [{ label: 'Um' }]);
});

test('endereço da rota: só no painel da área, nunca na demonstração', () => {
  assert.equal(contactFieldsBase(), null);
  setErpPorts({ apiUrl: '/api/v1/profiles/area-1/erp', demo: false });
  assert.equal(contactFieldsBase(), '/api/v1/profiles/area-1/erp-contato-campos');
  setErpPorts({ apiUrl: '/api/v1/profiles/area-1/erp', demo: true });
  assert.equal(contactFieldsBase(), null);
  setErpPorts(null);
});
