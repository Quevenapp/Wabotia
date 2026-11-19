/** Offline; sem argumentos mede com o Wrangler local em dry-run.
 * --diagnostic-only e --self-test NÃO executam Wrangler. Artefatos em output/;
 * node_modules é somente lido. Nunca instala, publica ou altera fontes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import PostalMime from 'postal-mime';
import { build, version as esbuildVersion } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Último commit antes de c2-base, já com o aceite fechado da primeira leva.
export const BASELINE_REFERENCE = 'fd005428';
export const ADDITIONAL_BUDGET = 524288;
export const ABSOLUTE_LIMIT = 41943040;
const sources = ['src', 'packages', 'migrations', 'package.json', 'package-lock.json', 'tsconfig.json', 'wrangler.jsonc', 'scripts/build-info.mjs'];
const digest = value => createHash('sha256').update(value).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const safeRelative = value => typeof value === 'string' && !!value && !isAbsolute(value) && !value.split(/[\\/]/).includes('..');
export function localEnvironment(input, extra = {}) {
  const environment = { ...input, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', ...extra };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'CLOUDFLARE_ENV'])
    delete environment[key];
  return environment;
}
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: localEnvironment(process.env, extraEnv) });
  if (result.error || result.status !== 0) throw new Error(
    `${command === process.execPath ? 'node' : command} ${args.join(' ')} falhou (${result.status}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return result.stdout;
}
function sourceFiles() {
  return run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sources], root)
    .split('\0').filter(file => file && existsSync(join(root, file))).sort();
}
function fingerprint(files) { return digest(JSON.stringify(files.map(file => [file, digest(readFileSync(join(root, file)))]))); }
function installedWrangler() {
  try {
    const manifest = require.resolve('wrangler/package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
    const cli = bin && resolve(dirname(manifest), bin);
    return cli && existsSync(cli) ? { version: pkg.version, cli } : null;
  } catch { return null; }
}
export function dryRunArgs(cli, config, outdir) {
  return [cli, 'deploy', '--dry-run', '--minify', '--outdir', outdir, '--config', config];
}
export function acceptance(baseline, isolated, final) {
  assert.ok([baseline, isolated, final].every(value => Number.isSafeInteger(value) && value > 0), 'Medição incompleta, vazia ou inválida.');
  const delta = final - baseline;
  const failures = [
    ...(delta > ADDITIONAL_BUDGET ? [`Acréscimo ${delta} excede o orçamento de ${ADDITIONAL_BUDGET} bytes.`] : []),
    ...(final > ABSOLUTE_LIMIT ? [`Total ${final} excede o teto absoluto de ${ABSOLUTE_LIMIT} bytes.`] : []),
  ];
  return { status: delta <= ADDITIONAL_BUDGET && final <= ABSOLUTE_LIMIT ? 'passed' : 'failed',
    baselineCommitBytes: baseline, isolatedPostalMimeBytes: isolated, finalWorkerBytes: final, totalDeltaBytes: delta,
    additionalBudgetBytes: ADDITIONAL_BUDGET, absoluteLimitBytes: ABSOLUTE_LIMIT, failures };
}
// Mesmo critério de scripts/release.mjs: todos os módulos exceto mapas e README.
export function moduleFile(name) { return !name.endsWith('.map') && name.split('/').at(-1) !== 'README.md'; }
function moduleSizes(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), 'O pacote não pode conter vínculos.');
    return entry.isDirectory() ? moduleSizes(directory, file) : moduleFile(file)
      ? [{ file, bytes: statSync(join(directory, file)).size, sha256: digest(readFileSync(join(directory, file))) }] : [];
  });
}
function attachDependencies(directory) {
  const modules = join(directory, 'node_modules');
  symlinkSync(join(root, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync(modules), realpathSync(join(root, 'node_modules')));
}
function configFor(directory, main, file, assetDirectory) {
  const errors = [];
  const config = parseJsonc(readFileSync(join(directory, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  assert.equal(errors.length, 0, 'wrangler.jsonc inválido.');
  assert.ok(!config.build?.command, 'Build customizado não é permitido pela sonda offline.');
  assert.ok(safeRelative(main), 'Entrada do Worker fora do snapshot.');
  // Assets não entram no orçamento de módulos; preserva o binding e usa pasta
  // vazia local. Todas as demais opções de empacotamento vêm do config real.
  const measured = { ...config, main: resolve(directory, main), tsconfig: resolve(directory, config.tsconfig ?? 'tsconfig.json'),
    ...(config.assets ? { assets: { ...config.assets, directory: assetDirectory } } : {}),
    d1_databases: config.d1_databases?.map(database => ({ ...database,
      ...(database.migrations_dir ? { migrations_dir: resolve(directory, database.migrations_dir) } : {}) })) };
  delete measured.$schema;
  json(file, measured);
}
function bundle(wrangler, directory, main, output, label, commit) {
  const runDirectory = join(output, label); mkdirSync(runDirectory);
  const assets = join(runDirectory, 'assets'); mkdirSync(assets);
  const config = join(runDirectory, 'wrangler.json'); configFor(directory, main, config, assets);
  const outdir = join(runDirectory, 'modules'), args = dryRunArgs(wrangler.cli, config, outdir);
  const cliHome = join(output, 'cli-home'); mkdirSync(cliHome, { recursive: true });
  const log = run(process.execPath, args, directory, { WABOTIA_SOURCE_COMMIT: commit,
    XDG_CONFIG_HOME: cliHome, XDG_CACHE_HOME: cliHome, WRANGLER_LOG_PATH: join(runDirectory, 'wrangler.log') });
  writeFileSync(join(runDirectory, 'dry-run.log'), log, 'utf8');
  const modules = moduleSizes(outdir);
  assert.ok(modules.some(module => module.file === 'index.js'), 'Empacotamento não produziu index.js, exigido pelo release.');
  return { bytes: modules.reduce((sum, module) => sum + module.bytes, 0), modules, command: ['node', ...args], main, sourceCommit: commit };
}
async function diagnostic() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['postal-mime'], '4.2.1');
  assert.equal(lock.packages['node_modules/postal-mime'].version, '4.2.1');
  let packageDirectory = dirname(require.resolve('postal-mime'));
  let installed;
  while (!installed) {
    const file = join(packageDirectory, 'package.json');
    const candidate = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (candidate?.name === 'postal-mime') { installed = candidate; break; }
    const parent = dirname(packageDirectory);
    assert.notEqual(parent, packageDirectory, 'Manifesto de postal-mime não encontrado.');
    packageDirectory = parent;
  }
  assert.equal(installed.version, '4.2.1');
  const parsed = await PostalMime.parse('From: remetente@example.test\r\nTo: destino@example.test\r\nSubject: Teste\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOlá, ação.');
  assert.equal(parsed.subject, 'Teste'); assert.match(parsed.text, /Olá, ação\./);
  const common = { bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' };
  const empty = await build({ ...common, stdin: { contents: 'export default async function parse(raw){return raw}', resolveDir: root } });
  const functional = await build({ ...common, stdin: { contents: 'import PostalMime from "postal-mime"; export default async function parse(raw){return PostalMime.parse(raw)}', resolveDir: root } });
  const bytes = result => result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);
  const release = readFileSync(join(root, 'scripts/release.mjs'), 'utf8');
  assert.match(release, /--dry-run/); assert.match(release, /--minify/);
  return { version: installed.version, parserFunctional: true, browserCatalog: await checkBrowserCatalog(),
    priorMimeReader: Object.keys(manifest.dependencies).filter(name => name !== 'postal-mime' && /postal|mailparser|mimemessage|emailjs-mime/i.test(name)),
    diagnostic: { bundler: `esbuild ${esbuildVersion}`, baselineBytes: bytes(empty), parserBytes: bytes(functional),
      deltaBytes: bytes(functional) - bytes(empty), entry: require.resolve('postal-mime') } };
}
function measure(wrangler, reference) {
  const files = sourceFiles(), before = fingerprint(files);
  const commit = run('git', ['rev-parse', '--verify', `${reference}^{commit}`], root).trim();
  const currentCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  assert.match(commit, /^[a-f0-9]{40}$/); assert.match(currentCommit, /^[a-f0-9]{40}$/);
  const outputRoot = join(root, 'output/c2-dependency-size'); mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, 'run-'));
  const baseline = join(output, 'baseline'), current = join(output, 'current'); mkdirSync(baseline); mkdirSync(current);
  const archive = join(output, 'baseline.tar');
  run('git', ['archive', '--format=tar', `--output=${archive}`, commit, ...sources], root);
  run('tar', ['-xf', archive, '-C', baseline], root);
  for (const file of files) {
    assert.ok(safeRelative(file) && !lstatSync(join(root, file)).isSymbolicLink(), 'Fonte fora do snapshot.');
    mkdirSync(dirname(join(current, file)), { recursive: true }); copyFileSync(join(root, file), join(current, file));
  }
  for (const [directory, sourceCommit] of [[baseline, commit], [current, currentCommit]]) {
    attachDependencies(directory);
    run(process.execPath, ['scripts/build-info.mjs'], directory, { WABOTIA_SOURCE_COMMIT: sourceCommit });
  }
  const baseMain = parseJsonc(readFileSync(join(baseline, 'wrangler.jsonc'), 'utf8')).main;
  const finalMain = parseJsonc(readFileSync(join(current, 'wrangler.jsonc'), 'utf8')).main;
  const measurements = { baseline: bundle(wrangler, baseline, baseMain, output, 'baseline-worker', commit) };
  // Entradas funcionais idênticas no MESMO Worker de referência. A diferença
  // isolada é parse(raw) devolver o texto ou executar o parser, sem tree shaking.
  for (const [label, parser] of [['empty', 'async raw => raw'], ['postal', 'async raw => PostalMime.parse(raw)']]) {
    const probeDirectory = join(baseline, `.c2-size/${label}`); mkdirSync(probeDirectory, { recursive: true });
    let entry = relative(probeDirectory, resolve(baseline, baseMain)).split(sep).join('/');
    if (!entry.startsWith('.')) entry = `./${entry}`;
    const code = `${label === 'postal' ? 'import PostalMime from "postal-mime";\n' : ''}import Worker from ${JSON.stringify(entry)};\nexport * from ${JSON.stringify(entry)};\nconst parse = ${parser};\nexport default { ...Worker, async fetch(request, env, ctx) { if(new URL(request.url).pathname === '/__c2_size_probe') return new Response(JSON.stringify(await parse(await request.text()))); return Worker.fetch(request, env, ctx); } };\n`;
    writeFileSync(join(probeDirectory, 'index.ts'), code, 'utf8');
    measurements[label] = bundle(wrangler, baseline, `.c2-size/${label}/index.ts`, output, `probe-${label}`, commit);
  }
  measurements.final = bundle(wrangler, current, finalMain, output, 'final-worker', currentCommit);
  assert.equal(fingerprint(sourceFiles()), before, 'Fontes alteradas durante a medição; repita o aceite.');
  return { bundler: `wrangler ${wrangler.version}`, baselineReference: reference, baselineCommit: commit,
    currentCommit, currentSourceSha256: before, artifactDirectory: relative(root, output).split(sep).join('/'),
    assets: 'Excluídos da soma, como em modulesTotal de scripts/release.mjs; binding conservado.', measurements,
    acceptance: acceptance(measurements.baseline.bytes, measurements.postal.bytes - measurements.empty.bytes, measurements.final.bytes) };
}
/** O painel importa o catálogo compartilhado. Um import dinâmico do kernel
 * também entra no grafo do browser e deve falhar aqui, sem externalizar o Worker. */
async function checkBrowserCatalog() {
  const result = await build({ entryPoints: [join(root, 'src/channels.ts'), join(root, 'web/channel-extensions.ts')],
    bundle: true, write: false, outdir: join(root, 'output/c2-browser-probe'), metafile: true,
    format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
  assert.deepEqual(inputs.filter(file => /(?:^|\/)src\/(?:channel-extension-kernel|coordinator|security|index)\.ts$/.test(file)), [],
    'O catálogo web alcançou o núcleo do Worker. Corrija o import; não externalize módulos do servidor.');
  return { status: 'passed', bundledInputs: inputs.length, workerRuntimeIncluded: false };
}
export async function selfTest() {
  const environment = localEnvironment({ CLOUDFLARE_ENV: 'production', CF_API_TOKEN: 'synthetic', PATH: 'local' }, { CLOUDFLARE_API_KEY: 'synthetic' });
  assert.equal(environment.PATH, 'local');
  for (const key of ['CLOUDFLARE_ENV', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY']) assert.equal(environment[key], undefined);
  const configErrors = [];
  parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), configErrors, { allowTrailingComma: true });
  assert.deepEqual(configErrors, [], 'A sonda deve aceitar o JSONC real, inclusive vírgulas finais.');
  assert.deepEqual(dryRunArgs('cli', 'config', 'out'), ['cli', 'deploy', '--dry-run', '--minify', '--outdir', 'out', '--config', 'config']);
  assert.equal(moduleFile('index.js'), true); assert.equal(moduleFile('module.wasm'), true);
  assert.equal(moduleFile('index.js.map'), false); assert.equal(moduleFile('sub/README.md'), false);
  assert.equal(acceptance(100, 20, 120).status, 'passed');
  assert.equal(acceptance(100, 20, 101 + ADDITIONAL_BUDGET).status, 'failed');
  assert.equal(acceptance(ABSOLUTE_LIMIT, 20, ABSOLUTE_LIMIT + 1).status, 'failed');
  assert.throws(() => acceptance(null, 20, 120)); assert.throws(() => acceptance(100, 0, 120));
  assert.equal(safeRelative('../outside'), false); assert.equal(safeRelative('src/index.ts'), true);
  await checkBrowserCatalog();
  console.log('c2-dependency-size: self-test passou; sem Wrangler, rede ou escrita.');
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  const diagnosticOnly = args.length === 1 && args[0] === '--diagnostic-only';
  const reference = args.length === 2 && args[0] === '--baseline' ? args[1] : BASELINE_REFERENCE;
  assert.ok(args.length === 0 || diagnosticOnly || args.length === 2 && args[0] === '--baseline' && /^[a-zA-Z0-9_./-]+$/.test(reference) && !reference.startsWith('-'), 'Use sem argumentos, --baseline <commit>, --diagnostic-only ou --self-test.');
  let report = { acceptance: { status: 'blocked', baselineCommitBytes: null, isolatedPostalMimeBytes: null,
    finalWorkerBytes: null, totalDeltaBytes: null, additionalBudgetBytes: ADDITIONAL_BUDGET, absoluteLimitBytes: ABSOLUTE_LIMIT } };
  try {
    report = { ...report, ...await diagnostic() };
    if (diagnosticOnly) report.acceptance.reason = 'Somente diagnóstico solicitado; Wrangler não executado. Isto não comprova o orçamento do Worker.';
    else {
      const wrangler = installedWrangler();
      assert.ok(wrangler, 'Wrangler local indisponível. Prepare-o no ambiente de verificação; nenhuma instalação automática ou acesso à rede foi tentado.');
      report = { ...report, ...measure(wrangler, reference) };
    }
  } catch (error) { report.acceptance.reason = `Medição real bloqueada: ${error.message}`; }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!diagnosticOnly && report.acceptance.status !== 'passed' || diagnosticOnly && !report.parserFunctional) process.exitCode = 1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
