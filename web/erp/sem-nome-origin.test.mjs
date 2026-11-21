import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// O sincronizador do sistema de onde o ERP veio chamava-se "Origin". O nome nunca aparece em tela:
// o que veio de fora é "importado", "de origem", "do Bling" ou "sincronizado".
// "Texto de tela" é definido como em sem-nome-fagoo.test.mjs: todo literal de texto (string, modelo e texto JSX)
// fora de comentários, exceto especificadores de módulo e atributos de identidade (className, id, aria-*).
// Só a palavra com inicial maiúscula ("Origin", "ORIGIN") é procurada: em minúsculas, "origin" é nome técnico
// (location.origin, chaves como origin_id, rotas e classes CSS), que fica como está.
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = path => readFileSync(`${root}/${path}`, 'utf8');
function walk(dir) {
  return readdirSync(`${root}/${dir}`, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}

const word = /\b(?:Origin|ORIGIN)\b/;
// Exceções técnicas completas (o texto inteiro do literal), nunca uma liberação genérica de frases com a palavra.
const technical = [
  // Cabeçalhos HTTP de CORS com nome próprio, que nenhuma pessoa lê.
  /^(?:Access-Control-Allow-Origin|Cross-Origin-[\w-]+)$/,
  // Códigos e chaves em maiúsculas com sublinhado (ERP_ORIGIN_NOT_ALLOWED, ORIGIN_NOT_PREPARED…).
  /^[A-Z0-9_]*ORIGIN[A-Z0-9_]*$/,
];
// Exceções inevitáveis, presas ao arquivo e a frases exatas: o literal só passa se, tiradas essas frases,
// a palavra não aparecer mais (uma frase nova com a palavra no mesmo arquivo continua falhando).
const unavoidable = [
  // Número de documento gravado nos títulos importados ("Origin AR 123"): é dado conferido byte a byte pela
  // importação financeira, não rótulo; trocar o texto quebraria a conferência dos títulos já gravados.
  { path: 'src/erp/fagoo/workers/erp-api/src/financial-import.mjs', phrases: ['Origin '] },
  // Textos do motor conferidos, nos testes dos dois motores, contra o oráculo SQL copiado do sistema de origem
  // (tests/erp/oracle, que não se altera): mudá-los aqui quebraria a paridade.
  // O relatório de vendas traduz o rótulo na tela (reportGroupLabel, "Vendedor importado <id>").
  { path: 'src/erp/domains/documents/rpc/erp_document_sales_report.ts', phrases: ['Vendedor Origin '] },
  // Registro de atividades: a tela traduz a descrição (RealActivity, "do sistema de origem" e "(importada)").
  { path: 'src/erp/domains/access/activity.ts', phrases: ["'Importação do financeiro do Origin'", "' (Origin)'"] },
  // Espelho de estoque e abertura de saldo: só existem com dados do sincronizador antigo, desligado no Vinki.
  { path: 'src/erp/domains/stock/rpc/mirror.ts', phrases: ['Produto Origin ', 'Depósito Origin '] },
  { path: 'src/erp/domains/stock/rpc/opening.ts', phrases: ['Saldo de abertura (Origin)', 'Abertura Origin depósito '] },
];
const allowedPhrases = (path, text) => unavoidable.some(entry => entry.path === path &&
  !word.test(entry.phrases.reduce((rest, phrase) => rest.split(phrase).join(''), text)));
// O cabeçalho HTTP "Origin" só é técnico como nome de cabeçalho: headers.get('Origin') e Vary: 'Origin'.
function headerName(node) {
  if (node.text !== 'Origin') return false;
  const parent = node.parent;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
      ['get', 'has', 'set', 'delete'].includes(parent.expression.name.text)) return true;
  return ts.isPropertyAssignment(parent) && parent.initializer === node &&
    parent.name.getText().replace(/['"]/g, '') === 'Vary';
}
const identityAttributes = new Set(['className', 'class', 'id', 'htmlFor', 'for', 'key', 'data-testid',
  'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']);

function exempt(node, path) {
  if (headerName(node)) return true;
  if (allowedPhrases(path, node.text)) return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return identityAttributes.has(parent.name.text);
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
      return parent.moduleSpecifier === node;
    if (ts.isCallExpression(parent) && parent.arguments.includes(node) &&
        (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText() === 'require')) return true;
  }
  return technical.some(pattern => pattern.test(node.text));
}

export function findings(path, text) {
  const source = path.endsWith('.html')
    ? text.replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, value => value.replace(/[^\r\n]/g, ' '))
    : text;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    /\.(tsx|html)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const failures = [];
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) &&
        word.test(node.text) && !exempt(node, path)) {
      const start = node.getStart(file);
      const raw = source.slice(start, node.end);
      const offset = Math.max(0, raw.search(word));
      const line = file.getLineAndCharacterOfPosition(start + offset).line + 1;
      failures.push(`${path}:${line}: ${node.text.trim().replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

// Fora da varredura: testes e simulados (web/erp/test, web/erp/demo, *.test.*), declarações de tipo e
// src/erp/schema, que é a documentação técnica dos desvios do porte, lida só pelo gerador do banco (scripts/erp).
const screenFile = path => /\.(?:tsx?|mts|mjs|html)$/.test(path) && !/\.d\.m?ts$/.test(path) &&
  !/(?:^|\/)(?:test|tests|demo)\//.test(path) && !/\.(?:test|check)\.m?[jt]sx?$/.test(path) &&
  !path.startsWith('src/erp/schema/');

test('telas do ERP e mensagens do servidor não exibem o nome Origin', () => {
  const paths = [
    ...walk('web/erp').filter(screenFile),
    ...walk('web/management').filter(screenFile),
    ...walk('src/erp').filter(screenFile),
    ...walk('packages/erp-domain/src/preferences').filter(screenFile),
  ];
  assert.deepEqual(paths.flatMap(path => findings(path, read(path))), []);
});

test('a guarda detecta strings, modelos, atributos e JSX, sem confundir comentários e nomes técnicos', () => {
  for (const source of [
    'const label = "ID no Origin";',
    'const label = `Referência ${nome} no Origin`;',
    'const label = `ORIGIN ${nome}`;',
    'const label = `Olá ${nome}, Origin ${outro}!`;',
    'const view = <p>Depósitos do Origin</p>;',
    'const view = <p title="Ajuda do Origin" />;',
    'const view = <input aria-label="Código Origin" />;',
    'throw new Error("Pedido do Origin não encontrado");',
    'const view = <td>{item.source ? \'Origin\' : \'ERP\'}</td>;',
    'const label = { origin: "Origin" }[source];',
  ]) {
    const result = findings('exemplo.tsx', `// Origin é a origem\n${source}`);
    assert.equal(result.length, 1, source);
    assert.match(result[0], /^exemplo\.tsx:2: .*origin/i);
  }
  // A exceção vale só para a frase listada, no arquivo listado.
  const mirror = 'src/erp/domains/stock/rpc/mirror.ts';
  assert.deepEqual(findings(mirror, 'const a = "Produto Origin " + id;'), []);
  assert.equal(findings(mirror, 'const a = "Produto Origin " + id;\nconst b = "Lote do Origin";').length, 1);
  assert.equal(findings('outro.ts', 'const a = "Produto Origin " + id;').length, 1);
  assert.equal(findings('qa.html', '<!-- Origin -->\n<!doctype html><html><title>Origin · QA</title></html>').length, 1);
  assert.deepEqual(findings('exemplo.tsx', `
    // Origin
    /* Origin */
    import OriginTopBar from './OriginTopBar';
    export { ORIGIN_SHORTCUTS } from './OriginTopBar';
    const lazy = import('./OriginTopBar');
    const keys = ['origin_id', 'origin-sync', location.origin, 'OriginTopBar', 'ORIGIN_SYNC_URL', 'Access-Control-Allow-Origin'];
    const header = request.headers.get('Origin'), vary = { Vary: 'Origin' };
    const view = <p className="origin-search-icon" id="origin-title" aria-labelledby="origin-title">{/* Origin */}Importado</p>;
  `), []);
});
