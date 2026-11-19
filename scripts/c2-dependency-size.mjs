/** Somente leitura, sem rede, Wrangler, release ou alteração da junção node_modules. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PostalMime from 'postal-mime';
import { build, version as esbuildVersion } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const dependency = lock.packages['node_modules/postal-mime'];
assert.equal(manifest.dependencies['postal-mime'], '4.2.1');
assert.equal(dependency.version, '4.2.1');
const parsed = await PostalMime.parse('From: remetente@example.test\r\nTo: destino@example.test\r\nSubject: Teste\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOlá, ação.');
assert.equal(parsed.subject, 'Teste');
assert.match(parsed.text, /Olá, ação\./);
const require = createRequire(import.meta.url);
const common = { bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' };
const baseline = await build({ ...common, stdin: { contents: 'export default async function parse(raw){return raw}', resolveDir: root, sourcefile: 'c2-size-empty.ts' } });
const functional = await build({ ...common, stdin: { contents: 'import PostalMime from "postal-mime"; export default async function parse(raw){return PostalMime.parse(raw)}', resolveDir: root, sourcefile: 'c2-size-parser.ts' } });
const bytes = result => result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);
const release = readFileSync(resolve(root, 'scripts/release.mjs'), 'utf8');
assert.match(release, /--dry-run/);
assert.match(release, /--minify/);
// O release usa Wrangler, incluindo plugins/shims e módulos adicionais. Esta
// sonda funcional não finge equivalência nem usa tamanho npm/tarball como prova.
const report = {
  version: dependency.version,
  parserFunctional: true,
  priorMimeReader: Object.keys(manifest.dependencies).filter(name => name !== 'postal-mime' && /postal|mailparser|mimemessage|emailjs-mime/i.test(name)),
  diagnostic: { bundler: `esbuild ${esbuildVersion}`, baselineBytes: bytes(baseline), parserBytes: bytes(functional), deltaBytes: bytes(functional) - bytes(baseline), entry: require.resolve('postal-mime') },
  acceptance: { status: 'blocked', baselineCommitBytes: null, isolatedPostalMimeBytes: null, finalWorkerBytes: null, totalDeltaBytes: null,
    additionalBudgetBytes: 524288, absoluteLimitBytes: 41943040,
    reason: 'O empacotamento de scripts/release.mjs exige Wrangler deploy --dry-run --minify. As regras desta máquina proíbem executar Wrangler; a sonda esbuild acima não substitui a medição do pacote Worker.' },
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
