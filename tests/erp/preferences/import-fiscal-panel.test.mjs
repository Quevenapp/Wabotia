// Telas da importação fiscal (versão 28): o modelo .XLSX tem as instruções em
// português na primeira aba e a leitura pula essa aba; textos das recusas;
// cada tela pertence à parte que a grava (some com ela desligada).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCREEN_TEMPLATES, readSpreadsheet, reasonText, autoMapping, IMPORT_TEMPLATES } from '../../../web/erp/app/lib/spreadsheet-import.ts';
import { textCell, toXlsxBook } from '../../../web/erp/app/lib/spreadsheet-export.ts';
import { requirementOf } from '../../../web/erp/modules.ts';
import { erpImportOwner, erpImportRequirement, erpRouteRequirement } from '../../../src/erp/parts-requirements.ts';

const KINDS = ['product_taxes', 'natures', 'opening_balances'];

test('modelos .XLSX: instruções na primeira aba e a planilha de dados na segunda', async () => {
  for (const kind of KINDS) {
    const template = SCREEN_TEMPLATES[kind], xlsx = template.model('xlsx');
    const text = new TextDecoder().decode(xlsx);
    assert.match(text, /<sheet name="Instruções" sheetId="1" r:id="rId1"\/><sheet name="Planilha" sheetId="2" r:id="rId2"\/>/, kind);
    assert.match(text, /Como preencher/);
    assert.match(text, new RegExp(IMPORT_TEMPLATES[kind].title));
    const cells = await readSpreadsheet('modelo.xlsx', xlsx);
    assert.deepEqual(cells, [IMPORT_TEMPLATES[kind].columns.map((c) => c.label)], kind);
    const csv = await readSpreadsheet('modelo.csv', new TextEncoder().encode(template.model('csv')));
    assert.deepEqual(cells, csv, kind);
  }
});

test('planilha de outro sistema com várias abas continua lendo a primeira; aba Instruções é pulada', async () => {
  const book = toXlsxBook([{ name: 'Dados', rows: [[textCell('Conta financeira')], [textCell('Caixa')]] }, { name: 'Outra', rows: [[textCell('x')]] }]);
  assert.deepEqual(await readSpreadsheet('a.xlsx', book), [['Conta financeira'], ['Caixa']]);
  const model = toXlsxBook([{ name: 'Instruções', rows: [[textCell('Leia')]] }, { name: 'Saldos', rows: [[textCell('Conta financeira'), textCell('Data'), textCell('Saldo')], [textCell('Caixa'), textCell('31/12/2025'), textCell('10,5')]] }]);
  const cells = await readSpreadsheet('saldos.xlsx', model), template = SCREEN_TEMPLATES.opening_balances;
  const parsed = template.parse(cells, autoMapping(template, cells[0]), { types: [] });
  assert.deepEqual(parsed.items.map((i) => [i.data, i.problems]), [[{ account: 'Caixa', date: '2025-12-31', balance: '10.5' }, []]]);
  assert.equal(template.identity(parsed.items[0]), 'Caixa · 31/12/2025');
});

test('recusas em palavras do dono do negócio', () => {
  const text = (kind, reason) => reasonText(kind, { reason, field: reason.split(':')[1] ?? null });
  assert.equal(text('product_taxes', 'erp_preferences_import_cest_without_ncm:cest'), 'CEST: o produto precisa ter NCM: informe o NCM na mesma linha');
  assert.equal(text('product_taxes', 'erp_preferences_import_not_found:gtin'), 'GTIN/EAN: não encontrado no ERP');
  assert.equal(text('product_taxes', 'erp_preferences_import_required:nature'), 'Natureza de operação: informe a natureza ou defina a padrão em Naturezas de operação');
  assert.equal(text('product_taxes', 'erp_preferences_import_icms_regime:icms_situation'), 'ICMS: CST/CSOSN: use CST na natureza do Regime normal e CSOSN na do Simples Nacional');
  assert.equal(text('natures', 'erp_preferences_import_required:crt'), 'Regime tributário: obrigatório');
  assert.match(text('opening_balances', 'erp_preferences_import_before_start:date'), /^Data: data anterior ao início da conta/);
  assert.equal(text('opening_balances', 'erp_preferences_import_not_found:account'), 'Conta financeira: não encontrado no ERP');
  for (const kind of KINDS) assert.doesNotMatch(text(kind, 'erp_preferences_import_rules_full:icms_situation'), /Não foi possível/);
});

test('cada tela e rota pertence à parte que grava', () => {
  assert.deepEqual(['fiscal-produtos', 'naturezas-operacao', 'saldos-iniciais'].map((slug) => requirementOf(`/preferencias/importacoes/${slug}`)?.owner),
    ['erp-fiscal', 'erp-fiscal', 'erp-financeiro']);
  assert.deepEqual(erpImportRequirement('product_taxes').all.toSorted(), ['erp', 'erp-fiscal', 'erp-produtos'].toSorted());
  assert.deepEqual(KINDS.map(erpImportOwner), ['erp-fiscal', 'erp-fiscal', 'erp-financeiro']);
  assert.equal(erpImportOwner('lots'), 'erp-estoque');
  for (const slug of ['fiscal-produtos', 'naturezas-operacao', 'saldos-iniciais'])
    assert.ok(erpRouteRequirement('POST', new URL(`https://internal/v1/importacoes/${slug}/lote`)), slug);
});
