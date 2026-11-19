import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));
const preferences = 'packages/erp-domain/src/preferences';
const mirror = `src/erp/fagoo/${preferences}`;
const read = path => readFileSync(`${root}/${path}`, 'utf8');
function walk(dir) {
  return readdirSync(`${root}/${dir}`, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}

// Exceções técnicas completas, nunca uma liberação genérica de frases com a marca.
const technical = [
  /^fagoo:system-update-progress$/,
  /^X-Fagoo-[\w-]+$/,
  /^\/_fagoo\/(?:[\w/.-]*)$/,
  /^fagoo_agt_[\w-]*$/,
  /^fagoo-erp$/,
  /^(?:https?:\/\/)?fagoo\.invalid\/?$/,
  /^FAGOO_[A-Z0-9_]+$/,
  /^fagoo-origin-sync$/,
  /^fagoo\/wabotia\/v1\/$/,
];
// Referências a id são técnicas tanto na definição quanto em seus consumidores.
const identityAttributes = new Set(['className', 'class', 'id', 'htmlFor', 'for',
  'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']);

function exempt(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return identityAttributes.has(parent.name.text);
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
      return parent.moduleSpecifier === node;
    if (ts.isCallExpression(parent) && parent.arguments.includes(node) &&
        (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText() === 'require')) return true;
  }
  if (technical.some(pattern => pattern.test(node.text))) return true;
  return node.text === 'fagoo' && ts.isPropertyAssignment(node.parent) &&
    node.parent.name.getText().replace(/['"]/g, '') === 'client';
}

function findings(path, text) {
  // O parser descarta comentários JS/TS, inclusive dentro de expressões JSX,
  // sem confundir URLs ou marcadores de comentário dentro de strings com comentários.
  // HTML usa a mesma árvore JSX; mascarar comentários/doctype preserva as linhas.
  const source = path.endsWith('.html')
    ? text.replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, value => value.replace(/[^\r\n]/g, ' '))
    : text;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    /\.(tsx|html)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const failures = [];
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) &&
        /fagoo/i.test(node.text) && !exempt(node)) {
      const start = node.getStart(file);
      const raw = source.slice(start, node.end);
      const offset = Math.max(0, raw.search(/fagoo/i));
      const line = file.getLineAndCharacterOfPosition(start + offset).line + 1;
      const snippet = node.text.trim().replace(/\s+/g, ' ');
      failures.push(`${path}:${line}: ${snippet}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

test('textos do painel, QA e Preferências não exibem o nome antigo', () => {
  const paths = [
    ...walk('web/erp/app').filter(path => /\.tsx?$/.test(path)),
    ...walk('web/erp/qa'),
    ...walk(preferences),
    ...walk(mirror),
  ];
  assert.deepEqual(paths.flatMap(path => findings(path, read(path))), []);
});

test('a guarda detecta strings, modelos, atributos e JSX, sem confundir comentários', () => {
  for (const source of [
    'const label = "Bem-vindo ao Fagoo";',
    'const label = `Bem-vindo ao ${nome} no faGOO`;',
    'const label = `FAGOO ${nome}`;',
    'const label = `Olá ${nome}, FAGOO ${outro}!`;',
    'const view = <p>Bem-vindo ao fagoo</p>;',
    'const view = <p title="Ajuda do FAGOO" />;',
    'const label = "https://example.test/Fagoo";',
    'const label = "// Fagoo /* visível */";',
    'const label = "Fagoo usa fagoo:system-update-progress";',
  ]) {
    const result = findings('exemplo.tsx', `// Fagoo é a origem\n${source}`);
    assert.equal(result.length, 1, source);
    assert.match(result[0], /^exemplo\.tsx:2: .*fagoo/i);
  }
  assert.equal(findings('qa.html', '<!-- Fagoo -->\n<!doctype html><html><title>FAGOO · QA</title></html>').length, 1);
  assert.deepEqual(findings('exemplo.tsx', `
    // Fagoo
    /* Fagoo */
    import { FagooBrand } from './FagooBrand';
    export { FagooBrand } from './FagooBrand';
    const lazy = import('./FagooBrand');
    const config = { client: 'fagoo', service: 'fagoo-origin-sync' };
    const keys = ['fagoo:system-update-progress', 'X-Fagoo-Token', '/_fagoo/',
      'fagoo_agt_', 'fagoo-erp', 'https://fagoo.invalid', 'FAGOO_KEY', 'fagoo/wabotia/v1/'];
    const view = <p className={\`fagoo-brand \${active ? 'fagoo-active' : ''}\`}
      id="fagoo-title" aria-labelledby="fagoo-title">{/* Fagoo */}ERP</p>;
  `), []);
});

test('Preferências mantém os mesmos arquivos comuns e conteúdo idêntico nas duas árvores', () => {
  // Antes desta alteração só estas três declarações existiam exclusivamente no painel.
  const panelOnly = ['catalog.d.mts', 'core.d.mts', 'dto.d.mts'];
  const commonBefore = [
    'catalog.mjs', 'core.mjs', 'dto.mjs', 'fields.mjs',
    ...['cadastros-contatos', 'cadastros-lotes', 'cadastros-produtos',
      'central-notificacoes', 'certificado-digital', 'contabilidade-contador',
      'empresa-armazenamento', 'empresa-geral', 'financas-pagar', 'financas-receber',
      'meu-negocio', 'notas-nfce', 'notas-nfe', 'servicos-os', 'sistema-interface',
      'suprimentos-compras', 'suprimentos-estoque', 'vendas-frente-caixa',
      'vendas-propostas', 'vendas-vendas'].map(name => `pages/${name}.mjs`),
  ].sort();
  const panelFiles = walk(preferences).map(path => path.slice(preferences.length + 1)).sort();
  const mirrorFiles = walk(mirror).map(path => path.slice(mirror.length + 1)).sort();
  assert.deepEqual(panelFiles.filter(path => panelOnly.includes(path)), panelOnly);
  assert.deepEqual(panelFiles.filter(path => !panelOnly.includes(path)), mirrorFiles);
  for (const path of commonBefore) assert.ok(mirrorFiles.includes(path), `arquivo comum removido: ${path}`);
  for (const path of mirrorFiles) assert.equal(read(`${preferences}/${path}`), read(`${mirror}/${path}`), path);
});
