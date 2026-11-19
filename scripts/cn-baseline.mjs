import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const REFERENCE = '20e15da9';
export const FIXTURE_VERSION = 3;
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = ['tests/cn-baseline-probe.test.ts', 'tests/service-center-fixture.ts', 'tests/setup.ts', 'vitest.config.ts'];
// O loader runner evita node_modules/.vite-temp; cacheDir mantém os outros
// artefatos fora da junção compartilhada. O wrapper é idêntico nas duas provas.
export const probeConfig = `import config from '../../vitest.config.ts';\nexport default { ...config, cacheDir: 'output/cn-aceite/vite-cache', test: { ...config.test, cache: false } };\n`;
export const digest = value => createHash('sha256').update(value).digest('hex');
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...extraEnv, NO_COLOR: '1', CI: '1', WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} falhou (${result.status}):\n${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result.stdout;
}
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
export function harnessHashes(root) {
  return Object.fromEntries(shared.map(file => [file, digest(readFileSync(path.join(root, file)))]));
}

const sourceRoots = ['src', 'migrations', 'packages'];
const sourceFiles = ['package.json', 'package-lock.json', 'wrangler.jsonc', 'scripts/build-info.mjs', ...shared];
function fingerprint(root, names) {
  const files = [...new Set(names)].sort().map(file => {
    const absolute = path.join(root, file);
    return { file, sha256: existsSync(absolute) ? digest(readFileSync(absolute)) : null };
  });
  return { sha256: digest(JSON.stringify(files)), files };
}
/** Inclui fontes novas ainda não commitadas e arquivos removidos, além do HEAD. */
export function sourceFingerprint(root = rootDefault) {
  const names = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    ...sourceRoots, ...sourceFiles, 'scripts/cn-baseline.mjs'], root).split('\0').filter(Boolean);
  return fingerprint(root, names);
}
/** Confere a árvore exportada sem perguntar ao Git do repositório pai. */
export function snapshotFingerprint(directory) {
  const files = [...sourceFiles];
  const visit = (relative) => {
    const absolute = path.join(directory, relative);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Fonte do snapshot não pode ser vínculo: ${file}.`);
      if (entry.isDirectory()) visit(file);
      else if (file !== 'src/build-info.generated.ts') files.push(file);
    }
  };
  sourceRoots.forEach(visit);
  return fingerprint(directory, files);
}

/** Somente leitura do Git; snapshot isolado, nunca checkout/worktree/branch. */
export function ensureBaseline(root = rootDefault) {
  root = path.resolve(root);
  const output = path.join(root, 'output/cn-aceite');
  mkdirSync(output, { recursive: true });
  const commit = run('git', ['rev-parse', `${REFERENCE}^{commit}`], root).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  // Nunca extrair por cima de uma prova anterior: uma fonte extra que não
  // pertence ao commit poderia sobreviver ao tar e contaminar o baseline.
  const directory = mkdtempSync(path.join(output, 'baseline-'));
  const manifestPath = path.join(output, 'baseline-reference.json');
  assert.ok(!lstatSync(directory).isSymbolicLink(), 'Snapshot não pode ser junction.');
  assert.equal(path.dirname(realpathSync(directory)), realpathSync(output), 'Snapshot fora da pasta de artefatos.');
  const archive = path.join(output, 'baseline.tar');
  run('git', ['archive', '--format=tar', `--output=${archive}`, commit], root);
  run('tar', ['-xf', archive, '-C', directory], root);
  // O destino da junção é somente lido; não instalar nem tocar em seu conteúdo.
  const modules = path.join(directory, 'node_modules');
  if (!existsSync(modules)) symlinkSync(path.join(root, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync(modules), realpathSync(path.join(root, 'node_modules')));
  for (const file of shared) copyFileSync(path.join(root, file), path.join(directory, file));
  const hashes = harnessHashes(root);
  assert.deepEqual(harnessHashes(directory), hashes);
  const manifest = { reference: REFERENCE, commit, fixtureVersion: FIXTURE_VERSION,
    harnessSha256: digest(JSON.stringify(hashes)), files: hashes,
    generatedConfigSha256: digest(probeConfig), runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    snapshotDirectory: path.relative(root, directory).replaceAll('\\', '/'), source: snapshotFingerprint(directory),
    node: process.version, platform: process.platform,
    currentLockSha256: digest(readFileSync(path.join(root, 'package-lock.json'))),
    baselineLockSha256: digest(readFileSync(path.join(directory, 'package-lock.json'))) };
  json(manifestPath, manifest);
  return { directory, commit, ...manifest };
}

export function parseReport(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const reports = lines.filter(line => line.includes('CN_BASELINE_REPORT='));
  // Formato em partes (o console do workerd não atravessa uma linha gigante):
  // CN_BASELINE_PART=<i>/<n>=<trecho ASCII>; exige todas as partes, uma vez cada.
  const parts = new Map();
  let total = 0;
  for (const line of lines) {
    const match = line.match(/CN_BASELINE_PART=(\d+)\/(\d+)=(.*)$/);
    if (!match) continue;
    const index = Number(match[1]);
    assert.ok(!parts.has(index), `Parte ${index} do relatório repetida.`);
    assert.ok(total === 0 || total === Number(match[2]), 'Partes de relatórios diferentes misturadas.');
    total = Number(match[2]);
    parts.set(index, match[3]);
  }
  if (total > 0) {
    assert.equal(reports.length, 0, 'Relatório em linha única e em partes ao mesmo tempo.');
    assert.equal(parts.size, total, 'A prova deve emitir exatamente um relatório completo.');
    let joined = '';
    for (let index = 1; index <= total; index++) joined += parts.get(index);
    reports.push('CN_BASELINE_REPORT=' + joined);
  }
  assert.equal(reports.length, 1, 'A prova deve emitir exatamente um relatório completo.');
  const report = JSON.parse(reports[0].slice(reports[0].indexOf('CN_BASELINE_REPORT=') + 'CN_BASELINE_REPORT='.length));
  assert.equal(report.fixtureVersion, FIXTURE_VERSION);
  return report;
}
export function compareReports(base, current) {
  assert.equal(base.fixtureVersion, current.fixtureVersion);
  const failures = [], deltas = {};
  const names = Object.keys(base.report).sort();
  assert.ok(names.length > 0, 'Relatório vazio não é aceite.');
  assert.deepEqual(Object.keys(current.report).sort(), names, 'Cenários diferentes entre referência e resultado.');
  for (const name of names) {
    assert.deepEqual(Object.keys(current.report[name]).sort(), Object.keys(base.report[name]).sort(), `Fases diferentes em ${name}.`);
    deltas[name] = {};
    for (const [phase, before] of Object.entries(base.report[name])) {
      const after = current.report[name][phase], delta = {};
      for (const metric of ['calls', 'statements', 'writes', 'rowsRead', 'rowsWritten']) {
        assert.ok(Number.isSafeInteger(before[metric]) && before[metric] >= 0 && Number.isSafeInteger(after[metric]) && after[metric] >= 0, `${name}/${phase}/${metric} inválido.`);
        delta[metric] = after[metric] - before[metric];
        if (delta[metric] > 0) failures.push(`${name}/${phase}/${metric}: ${before[metric]} -> ${after[metric]} (+${delta[metric]})`);
      }
      // Menos metadata não pode parecer redução de linhas lidas/escritas.
      if (before.metadataResults !== after.metadataResults)
        failures.push(`${name}/${phase}: cobertura de metadata mudou (${before.metadataResults} -> ${after.metadataResults}); revisar antes de aceitar.`);
      for (const [label, count] of [['base', before], ['resultado', after]]) {
        assert.equal(count.calls, count.trace.length, `${name}/${phase}/${label}: chamadas sem rastreio.`);
        assert.equal(count.statements, count.trace.reduce((sum, call) => sum + call.sql.length, 0), `${name}/${phase}/${label}: batch sem instruções.`);
      }
      deltas[name][phase] = delta;
    }
  }
  return { passed: failures.length === 0, failures, deltas };
}

export function assertProbePassed(result, log, label) {
  if (!result.error && result.status === 0) return;
  // A verificação externa costuma devolver somente o fim do log principal.
  // Preserve a causa do Vitest ali, além do arquivo completo por execução.
  const tail = log.trim().split(/\r?\n/).slice(-80).join('\n');
  throw new Error(`${label}: prova falhou (status ${result.status}${result.signal ? `, sinal ${result.signal}` : ''}); confira output/cn-aceite/${label}.log.\n${result.error?.message || ''}\n${tail}`);
}

/** Linhas CN_BASELINE_REPORT= a partir dos metadados gravados pelo reporter JSON. */
export function metaReportLines(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return [];
  const found = [];
  for (const suite of JSON.parse(text).testResults ?? [])
    for (const test of suite.assertionResults ?? [])
      if (typeof test.meta?.cnBaselineReport === 'string') found.push('CN_BASELINE_REPORT=' + test.meta.cnBaselineReport);
  return found;
}

function probe(directory, commit, output, label) {
  run(process.execPath, ['scripts/build-info.mjs'], directory, { WABOTIA_SOURCE_COMMIT: commit });
  const localArtifacts = path.join(directory, 'output/cn-aceite');
  mkdirSync(localArtifacts, { recursive: true });
  writeFileSync(path.join(localArtifacts, 'probe.config.mjs'), probeConfig, 'utf8');
  // A saída de console dos testes do Worker não chega ao terminal: o relatório
  // vem nos metadados do teste, gravados pelo reporter JSON do Vitest.
  const reportFile = path.join(localArtifacts, 'probe.vitest.json');
  if (existsSync(reportFile)) writeFileSync(reportFile, '', 'utf8');
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'tests/cn-baseline-probe.test.ts',
    '--config', 'output/cn-aceite/probe.config.mjs', '--configLoader', 'runner', '--cache=false',
    '--maxWorkers=1', '--testTimeout=120000',
    '--reporter=default', '--reporter=json', '--outputFile.json=output/cn-aceite/probe.vitest.json'];
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', CI: '1', WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const log = (result.stdout || '') + '\n' + (result.stderr || '');
  writeFileSync(path.join(output, `${label}.log`), log, 'utf8');
  assertProbePassed(result, log, label);
  const report = parseReport(log + '\n' + metaReportLines(reportFile).join('\n'));
  json(path.join(output, `${label}.json`), report); return report;
}

export function selfTest() {
  const count = { calls: 1, statements: 2, writes: 1, rowsRead: 0, rowsWritten: 1, metadataResults: 2,
    trace: [{ method: 'batch', sql: ['SELECT 1', 'INSERT INTO x VALUES(1)'], rowsRead: 0, rowsWritten: 1 }] };
  const base = { fixtureVersion: FIXTURE_VERSION, report: { whatsapp: { coordinator: count } } };
  assert.equal(compareReports(base, structuredClone(base)).passed, true);
  const changed = structuredClone(base); changed.report.whatsapp.coordinator.writes++;
  assert.equal(compareReports(base, changed).passed, false);
  changed.report.whatsapp.coordinator.metadataResults--;
  assert.equal(compareReports(base, changed).failures.length, 2);
  assert.throws(() => compareReports(base, { fixtureVersion: FIXTURE_VERSION, report: {} }));
  assert.throws(() => compareReports({ fixtureVersion: FIXTURE_VERSION, report: {} }, { fixtureVersion: FIXTURE_VERSION, report: {} }));
  assert.deepEqual(parseReport('CN_BASELINE_REPORT=' + JSON.stringify(base)), base);
  assert.throws(() => parseReport('sem evidência'));
  assert.throws(() => parseReport('CN_BASELINE_REPORT=' + JSON.stringify({ ...base, fixtureVersion: FIXTURE_VERSION - 1 })));
  assert.doesNotThrow(() => assertProbePassed({ status: 0 }, '', 'baseline'));
  assert.throws(() => assertProbePassed({ status: 1 }, 'AssertionError: expected 22 to be less than or equal to 20', 'baseline'),
    /baseline\.log\.[\s\S]*expected 22 to be less than or equal to 20/);
  assert.throws(() => assertProbePassed({ status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }, '', 'current'),
    /SIGTERM[\s\S]*ETIMEDOUT/);
  console.log('cn-baseline: self-test passou; não executa Git, Vitest, Wrangler ou rede.');
}
export function typecheck(root = rootDefault) {
  const output = path.join(root, 'output/cn-aceite');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'typecheck.d.ts'),
    `import type { Env as WorkerEnv } from '../../src/types';\ndeclare global { namespace Cloudflare { interface Env extends WorkerEnv {} } }\n`, 'utf8');
  const args = ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--lib', 'ES2022,DOM,DOM.Iterable', '--types', '@cloudflare/workers-types,vite/client',
    '--jsx', 'react-jsx', '--allowImportingTsExtensions', '--allowSyntheticDefaultImports', '--resolveJsonModule',
    'tests/cn-aceite.test.ts', 'tests/cn-baseline-probe.test.ts', 'tests/cn-orcamento.test.ts',
    'node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts', 'output/cn-aceite/typecheck.d.ts'];
  run(process.execPath, args, root);
  console.log('cn-baseline: typecheck dos três testes de aceite passou; não executa Git, Vitest, Wrangler ou rede.');
}
export function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  if (process.argv.length === 3 && process.argv[2] === '--typecheck') return typecheck();
  assert.equal(process.argv.length, 2, 'Opção desconhecida. Use sem argumentos, --self-test ou --typecheck.');
  const root = rootDefault, output = path.join(root, 'output/cn-aceite');
  const sources = sourceFingerprint(root);
  const baseline = ensureBaseline(root);
  const currentCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  assert.equal(sourceFingerprint(root).sha256, sources.sha256, 'As fontes ou o harness mudaram durante a criação do baseline.');
  const base = probe(baseline.directory, baseline.commit, output, 'baseline');
  const current = probe(root, currentCommit, output, 'current');
  assert.equal(sourceFingerprint(root).sha256, sources.sha256, 'As fontes ou o harness mudaram durante as provas. Repita antes do aceite.');
  assert.equal(snapshotFingerprint(baseline.directory).sha256, baseline.source.sha256, 'As fontes do baseline mudaram durante a prova.');
  assert.deepEqual(harnessHashes(root), harnessHashes(baseline.directory), 'O harness divergiu entre baseline e resultado.');
  const comparison = { reference: baseline.commit, baselineSources: baseline.source,
    snapshotDirectory: baseline.snapshotDirectory, currentCommit, currentSources: sources,
    harnessSha256: baseline.harnessSha256, fixtureVersion: FIXTURE_VERSION,
    ...compareReports(base, current) };
  json(path.join(output, 'comparison.json'), comparison);
  assert.ok(comparison.passed, 'Regressão ou evidência incomparável:\n' + comparison.failures.join('\n'));
  console.log('cn-baseline: todos os cenários sem aumento; evidências em output/cn-aceite/.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
