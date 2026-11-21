import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Nomes internos que nunca aparecem em tela: "Brufap" (o nome antigo do ERP) e "NFapi" (o provedor fiscal; em tela é
// "emissor de notas"). "Texto de tela" é definido como em sem-nome-origin.test.mjs: todo literal de texto (string,
// modelo e texto JSX) fora de comentários, exceto especificadores de módulo e atributos de identidade (className, id,
// aria-*). Só as grafias com maiúscula são procuradas: em minúsculas, "brufap" e "nfapi" são valores técnicos
// (origem=brufap, o identificador do provedor, nomes de arquivo), que ficam como estão.
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = path => readFileSync(`${root}/${path}`, 'utf8');
function walk(dir) {
  return readdirSync(`${root}/${dir}`, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}

const word = /\b(?:Brufap|BRUFAP|NFapi|NFAPI)\b/;
// Exceções técnicas completas (o texto inteiro do literal), nunca uma liberação genérica de frases com o nome.
const technical = [
  // Códigos e chaves em maiúsculas com sublinhado (NFAPI_TOKEN, ERP_BRUFAP_…), que nenhuma pessoa lê.
  /^[A-Z0-9_]*(?:BRUFAP|NFAPI)[A-Z0-9_]*$/,
  // Cabeçalhos HTTP do contrato do cofre (X-NFapi-…), que nenhuma pessoa lê.
  /^X-NFapi-[\w-]+$/,
];
// Exceções inevitáveis, presas ao arquivo e a frases exatas (a frase nova no mesmo arquivo continua falhando).
const unavoidable = [
  // Nome do provedor no registro interno dos provedores fiscais: diagnóstico do servidor, nunca texto de tela
  // (a tela usa "emissor de notas").
  { path: 'src/erp/emissor/nfapi-provider.ts', phrases: ['NFapi (cofre do emitente)'] },
];
const allowedPhrases = (path, text) => unavoidable.some(entry => entry.path === path &&
  !word.test(entry.phrases.reduce((rest, phrase) => rest.split(phrase).join(''), text)));
const identityAttributes = new Set(['className', 'class', 'id', 'htmlFor', 'for', 'key', 'data-testid',
  'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']);

function exempt(node, path) {
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
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) &&
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

// Fora da varredura: testes e simulados, declarações de tipo, src/erp/schema (documentação técnica do porte, lida só
// pelo gerador do banco), a cópia conferida do sistema de origem (src/erp/fagoo, que não vai para a tela do Wabotia) e
// o contrato gerado do cofre (src/erp/emissor/contract).
const screenFile = path => /\.(?:tsx?|mts|mjs|html)$/.test(path) && !/\.d\.m?ts$/.test(path) &&
  !/(?:^|\/)(?:test|tests|demo|upstream)\//.test(path) && !/\.(?:test|check)\.m?[jt]sx?$/.test(path) &&
  !path.startsWith('src/erp/schema/') && !path.startsWith('src/erp/fagoo/') && !path.startsWith('src/erp/emissor/contract/');

test('telas do ERP, Preferências e mensagens do servidor não exibem "Brufap" nem "NFapi"', () => {
  const paths = [
    ...walk('web/erp').filter(screenFile),
    ...walk('web/management').filter(screenFile),
    ...walk('src/erp').filter(screenFile),
    ...walk('packages/erp-domain/src').filter(screenFile),
    'src/erp-export.ts',
  ];
  assert.deepEqual(paths.flatMap(path => findings(path, read(path))), []);
});

test('a guarda detecta strings, modelos, atributos e JSX, sem confundir comentários e valores técnicos', () => {
  for (const source of [
    'const label = "Emitido pelo Brufap";',
    'const label = `Nota ${numero} no Brufap`;',
    'const label = "Cofre NFapi";',
    'const label = `Teste a conexão com o cofre NFapi ${x}`;',
    'const view = <p>Notas do Brufap</p>;',
    'const view = <p title="Emissor (NFapi)" />;',
    'throw new Error("A NFapi recusou a nota");',
  ]) {
    const result = findings('exemplo.tsx', `// Brufap e NFapi são nomes internos\n${source}`);
    assert.equal(result.length, 1, source);
    assert.match(result[0], /^exemplo\.tsx:2: .*(?:brufap|nfapi)/i);
  }
  // A exceção vale só para a frase listada, no arquivo listado.
  const provider = 'src/erp/emissor/nfapi-provider.ts';
  assert.deepEqual(findings(provider, 'const a = { name: "NFapi (cofre do emitente)" };'), []);
  assert.equal(findings(provider, 'const a = "NFapi (cofre do emitente)";\nconst b = "Cofre NFapi";').length, 1);
  assert.equal(findings('outro.ts', 'const a = "NFapi (cofre do emitente)";').length, 1);
  assert.deepEqual(findings('exemplo.tsx', `
    // Brufap
    /* NFapi */
    import { nfapiClient } from './nfapi';
    const lazy = import('./nfapi-provider');
    const keys = ['brufap', 'origem=brufap', 'nfapi', 'NFAPI_TOKEN', 'X-NFapi-Signature'];
    const view = <p className="brufap-list" id="nfapi-title" aria-labelledby="nfapi-title">{/* Brufap */}Emissor de notas</p>;
  `), []);
});
