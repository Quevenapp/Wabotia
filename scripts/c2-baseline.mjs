import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, snapshotFingerprint as cnSnapshotFingerprint, sourceFingerprint as cnSourceFingerprint } from './cn-baseline.mjs';

export const REFERENCES = Object.freeze({ legacy: '20e15da9', social: '13a9d9c3' });
export const FIXTURE_VERSION = 1;
export const FORBIDDEN_TABLES = Object.freeze(['channel_delivery_state', 'channel_public_grants', 'channel_comments',
  'telegram_callbacks', 'tiktok_send_slots', 'reviews', 'channel_sync_state', 'email_channel_addresses',
  'email_channel_inbox', 'email_channel_blocks', 'email_channel_probes']);
const forbidden = new RegExp('\\b(?:' + FORBIDDEN_TABLES.join('|') + ')\\b', 'i');
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = ['tests/cn-baseline-probe.test.ts', 'tests/c2-baseline-probe.test.ts', 'tests/service-center-fixture.ts', 'tests/setup.ts', 'vitest.config.ts'];
/** UUIDs reproduzíveis mantêm também a ordem das chaves dos índices D1.
 * O contador fica no começo: os IDs de conta que usam só 24 hex não colidem.
 * A semente por teste evita reutilizar a mesma chave nas fixtures do arquivo. */
export function deterministicUuidFactory(seed) {
  let hash = 2166136261, sequence = 0;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  const suffix = (hash >>> 0).toString(16).padStart(8, '0');
  return () => {
    assertSequence();
    return (++sequence).toString(16).padStart(8, '0') + '-' + suffix.slice(0, 4) + '-4' + suffix.slice(4, 7) +
      '-8' + suffix.slice(7) + '00-000000000000';
  };
  function assertSequence() {
    if (sequence >= 0xffffffff) throw new Error('Fixture excedeu o espaço de UUIDs.');
  }
}
// Relógio futuro impede disparos nativos concorrentes na máquina lenta.
// Tempo/UUIDs são entradas controladas; nenhum núcleo ou binding é simulado.
const clockSetup = "import { beforeEach, afterEach, vi } from 'vitest';\n" +
  deterministicUuidFactory.toString() + "\nbeforeEach(({ task }) => { vi.useFakeTimers({ toFake: ['Date'] }); " +
  "vi.setSystemTime(Date.UTC(2040, 0, 1)); vi.spyOn(crypto, 'randomUUID').mockImplementation(deterministicUuidFactory(task.name)); });\n" +
  "afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });\n";
export const probeConfig = "import config from '../../vitest.config.ts';\nexport default { ...config, cacheDir: 'output/c2-aceite/vite-cache', test: { ...config.test, cache: false, setupFiles: [...config.test.setupFiles, './output/c2-aceite/clock.setup.ts'] } };\n";
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...extraEnv, NO_COLOR: '1', CI: '1', WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  if (result.error || result.status !== 0)
    throw new Error(command + ' ' + args.join(' ') + ' falhou (' + result.status + '):\n' +
      (result.error?.message || '') + '\n' + (result.stdout || '') + '\n' + (result.stderr || ''));
  return result.stdout;
}
export function harnessHashes(root = rootDefault) {
  return Object.fromEntries(shared.map(file => [file, digest(readFileSync(path.join(root, file)))]));
}
export function sourceFingerprint(root = rootDefault) {
  const source = cnSourceFingerprint(root);
  return { ...source, sha256: digest(JSON.stringify([source.sha256, harnessHashes(root),
    digest(readFileSync(path.join(root, 'scripts/c2-baseline.mjs'))), probeConfig, clockSetup])) };
}
function snapshotFingerprint(root) {
  const source = cnSnapshotFingerprint(root);
  return { ...source, sha256: digest(JSON.stringify([source.sha256, harnessHashes(root), probeConfig, clockSetup])) };
}
/** Git somente de leitura: exporta dentro do workspace, nunca checkout/worktree. */
export function ensureBaseline(reference, root = rootDefault) {
  assert.ok(Object.values(REFERENCES).includes(reference), 'Referência não autorizada.');
  root = path.resolve(root);
  const output = path.join(root, 'output/c2-aceite');
  mkdirSync(output, { recursive: true });
  const commit = run('git', ['rev-parse', reference + '^{commit}'], root).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  const directory = mkdtempSync(path.join(output, 'baseline-' + reference + '-'));
  assert.ok(!lstatSync(directory).isSymbolicLink(), 'Snapshot não pode ser junction.');
  assert.equal(path.dirname(realpathSync(directory)), realpathSync(output), 'Snapshot fora da pasta de artefatos.');
  const archive = path.join(output, 'baseline-' + reference + '.tar');
  run('git', ['archive', '--format=tar', '--output=' + archive, commit], root);
  run('tar', ['-xf', archive, '-C', directory], root);
  // Apenas o vínculo é criado. Nada se escreve dentro de node_modules.
  symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync(path.join(directory, 'node_modules')), realpathSync(path.join(root, 'node_modules')));
  for (const file of shared) copyFileSync(path.join(root, file), path.join(directory, file));
  const files = harnessHashes(root); assert.deepEqual(harnessHashes(directory), files);
  const manifest = { reference, commit, fixtureVersion: FIXTURE_VERSION, files,
    harnessSha256: digest(JSON.stringify(files)), generatedConfigSha256: digest(probeConfig),
    clockSetupSha256: digest(clockSetup), runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    snapshotDirectory: path.relative(root, directory).replaceAll('\\', '/'), source: snapshotFingerprint(directory),
    node: process.version, platform: process.platform,
    currentLockSha256: digest(readFileSync(path.join(root, 'package-lock.json'))),
    baselineLockSha256: digest(readFileSync(path.join(directory, 'package-lock.json'))) };
  json(path.join(output, 'reference-' + reference + '.json'), manifest);
  return { directory, ...manifest };
}
const metrics = ['calls', 'statements', 'writes', 'rowsRead', 'rowsWritten'];
const requiredScenarios = {
  legacy: ['first', 'next', 'duplicate', 'second_connection', 'media', 'media_duplicate', 'reply', 'reply_duplicate',
    'alarm', 'lid', 'group', 'application', 'ambiguous', 'failure_before', 'recovery_before', 'failure_after',
    'recovery_after', 'inherit_first', 'identity_ready', 'inbound_replay', 'internal_create', 'internal_send', 'internal_replay'],
  social: ['instagram', 'facebook'].flatMap(channel => ['first', 'next', 'replay', 'media', 'media_replay', 'reply',
    'reply_replay', 'echo', 'event', 'failure_before', 'recovery_before', 'failure_after', 'recovery_after', 'alarm',
    'delivery_failure', 'forged'].map(name => channel + '.' + name)),
};
function validateCount(count, label) {
  for (const metric of [...metrics, 'metadataResults'])
    assert.ok(Number.isSafeInteger(count[metric]) && count[metric] >= 0, label + ': ' + metric + ' inválido.');
  assert.ok(Array.isArray(count.trace), label + ': rastreio ausente.');
  assert.equal(count.calls, count.trace.length, label + ': chamadas sem rastreio.');
  assert.equal(count.statements, count.trace.reduce((sum, call) => sum + call.sql.length, 0), label + ': batch sem instruções.');
  assert.equal(count.writes, count.trace.reduce((sum, call) => sum + call.writes, 0), label + ': escritas sem rastreio.');
  for (const call of count.trace) for (const sql of call.sql)
    assert.ok(typeof sql === 'string' && sql !== 'UNOBSERVED', label + ': instrução não observada.');
}
export function compareReports(base, current, { observations = false } = {}) {
  assert.equal(base.fixtureVersion, FIXTURE_VERSION); assert.equal(current.fixtureVersion, FIXTURE_VERSION);
  const key = observations ? 'observations' : 'report';
  const beforeReport = base[key] ?? {}, afterReport = current[key] ?? {};
  const names = Object.keys(beforeReport).sort(), failures = [], deltas = {};
  if (!observations) assert.ok(names.length, 'Relatório vazio não é aceite.');
  assert.deepEqual(Object.keys(afterReport).sort(), names, 'Cenários diferentes entre referência e resultado.');
  for (const name of names) {
    assert.deepEqual(Object.keys(afterReport[name]).sort(), Object.keys(beforeReport[name]).sort(), 'Fases diferentes: ' + name);
    deltas[name] = {};
    for (const [phase, before] of Object.entries(beforeReport[name])) {
      const after = afterReport[name][phase], label = name + '/' + phase;
      validateCount(before, label + '/base'); validateCount(after, label + '/resultado');
      const delta = {};
      for (const metric of metrics) {
        delta[metric] = after[metric] - before[metric];
        // Igualdade estrita. Uma redução também precisa revisão, nunca passa
        // por acaso quando alguma fase deixou de ser exercitada.
        if (!observations && delta[metric] !== 0)
          failures.push(label + '/' + metric + ': ' + before[metric] + ' -> ' + after[metric] + ' (delta ' + delta[metric] + ')');
      }
      if (!observations && before.metadataResults !== after.metadataResults)
        failures.push(label + ': cobertura de metadata mudou.');
      if (!observations) for (const metric of ['rowsRead', 'rowsWritten'])
        if (before.trace.filter(call => call[metric] != null).length !== after.trace.filter(call => call[metric] != null).length)
          failures.push(label + ': disponibilidade de ' + metric + ' mudou.');
      if (!observations) for (const [side, count] of [['base', before], ['resultado', after]])
        for (const sql of count.trace.flatMap(call => call.sql))
          if (forbidden.test(sql)) failures.push(label + '/' + side + ': acesso a tabela da segunda leva: ' + sql);
      deltas[name][phase] = delta;
    }
  }
  return { passed: failures.length === 0, failures, deltas };
}
/** Só task.meta no JSON do reporter: console do workerd não é transporte. */
export function readReports(file, groups) {
  assert.ok(existsSync(file), 'Reporter JSON ausente: ' + file);
  const text = readFileSync(file, 'utf8'); assert.ok(text.trim(), 'Reporter JSON vazio.');
  const merged = { legacy: { fixtureVersion: FIXTURE_VERSION, report: {}, observations: {} },
    social: { fixtureVersion: FIXTURE_VERSION, report: {}, observations: {} } };
  const seen = { cn: 0, legacy: 0, social: 0 };
  for (const suite of JSON.parse(text).testResults ?? []) for (const test of suite.assertionResults ?? []) {
    for (const [field, group] of [['cnBaselineReport', 'legacy'], ['c2BaselineReport', null]]) {
      if (typeof test.meta?.[field] !== 'string') continue;
      const report = JSON.parse(test.meta[field]), target = group ?? report.group;
      assert.ok(groups.includes(target), 'Grupo de relatório inesperado.');
      if (group) { assert.equal(report.fixtureVersion, 3); seen.cn++; } else {
        assert.equal(report.fixtureVersion, FIXTURE_VERSION); seen[target]++;
      }
      for (const section of ['report', 'observations']) for (const [name, phases] of Object.entries(report[section] ?? {})) {
        assert.ok(!(name in merged[target][section]), 'Cenário duplicado no reporter: ' + name);
        merged[target][section][name] = phases;
      }
    }
  }
  assert.equal(seen.cn, groups.includes('legacy') ? 1 : 0, 'É necessário exatamente um relatório CN via task.meta.');
  assert.equal(seen.legacy, groups.includes('legacy') ? 1 : 0, 'É necessário exatamente um relatório interno via task.meta.');
  assert.equal(seen.social, groups.includes('social') ? 2 : 0, 'São necessários dois relatórios sociais via task.meta.');
  for (const group of groups)
    assert.deepEqual(Object.keys(merged[group].report).sort(), [...requiredScenarios[group]].sort(), 'Matriz incompleta: ' + group);
  if (groups.includes('social')) assert.deepEqual(Object.keys(merged.social.observations).sort(),
    ['facebook.contact_profile', 'instagram.contact_profile'], 'Leitura de ficha não medida.');
  return merged;
}
export function validateProbeGroups(groups) {
  assert.equal(groups.length, 1, 'Cada medição exige um único grupo, idêntico na referência e no resultado.');
  assert.ok(Object.hasOwn(REFERENCES, groups[0]), 'Grupo de medição desconhecido.');
}
function probe(directory, commit, output, label, groups) {
  validateProbeGroups(groups);
  run(process.execPath, ['scripts/build-info.mjs'], directory, { WABOTIA_SOURCE_COMMIT: commit });
  const artifacts = path.join(directory, 'output/c2-aceite');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, 'probe.config.mjs'), probeConfig, 'utf8');
  writeFileSync(path.join(artifacts, 'clock.setup.ts'), clockSetup, 'utf8');
  const reportFile = path.join(artifacts, 'probe.vitest.json');
  writeFileSync(reportFile, '', 'utf8');
  const names = [...(groups.includes('legacy') ? ['CN_BASELINE_PROBE_V3', 'C2_LEGACY_EXTRA_V1'] : []),
    ...(groups.includes('social') ? ['C2_SOCIAL_BASELINE_V1'] : [])].join('|');
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'tests/cn-baseline-probe.test.ts', 'tests/c2-baseline-probe.test.ts',
    '--testNamePattern', names, '--config', 'output/c2-aceite/probe.config.mjs', '--configLoader', 'runner', '--cache=false',
    '--maxWorkers=1', '--testTimeout=180000', '--reporter=default', '--reporter=json', '--outputFile.json=output/c2-aceite/probe.vitest.json'];
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', CI: '1', WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const log = (result.stdout || '') + '\n' + (result.stderr || '');
  writeFileSync(path.join(output, label + '.log'), log, 'utf8');
  assert.ok(!result.error && result.status === 0, label + ': prova falhou; confira output/c2-aceite/' + label + '.log.\n' +
    (result.error?.message || '') + '\n' + log.trim().split(/\r?\n/).slice(-80).join('\n'));
  const reports = readReports(reportFile, groups);
  json(path.join(output, label + '.json'), reports);
  return reports;
}
export function selfTest() {
  for (const group of Object.keys(REFERENCES)) validateProbeGroups([group]);
  assert.throws(() => validateProbeGroups(['legacy', 'social']));
  assert.throws(() => validateProbeGroups([]));
  assert.throws(() => validateProbeGroups(['unknown']));
  const ids = deterministicUuidFactory('fixture'), repeatedIds = deterministicUuidFactory('fixture');
  const prefixes = new Set();
  let previous = '';
  for (let index = 0; index < 1024; index++) {
    const id = ids();
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(id, repeatedIds()); assert.ok(id > previous); previous = id;
    prefixes.add(id.replaceAll('-', '').slice(0, 24));
  }
  assert.equal(prefixes.size, 1024, 'IDs truncados de conta precisam continuar únicos.');
  assert.notEqual(deterministicUuidFactory('fixture')(), deterministicUuidFactory('outra fixture')());
  const count = { calls: 1, statements: 1, writes: 0, rowsRead: 2, rowsWritten: 0, metadataResults: 1,
    trace: [{ method: 'all', sql: ['SELECT id FROM messages'], writes: 0, rowsRead: 2, rowsWritten: 0 }] };
  const report = { fixtureVersion: FIXTURE_VERSION, report: { old: { worker: count } } };
  assert.ok(compareReports(report, structuredClone(report)).passed);
  for (const delta of [-1, 1]) {
    const altered = structuredClone(report); altered.report.old.worker.rowsRead += delta;
    assert.equal(compareReports(report, altered).passed, false);
  }
  const table = structuredClone(report); table.report.old.worker.trace[0].sql[0] = 'SELECT * FROM email_channel_inbox';
  assert.equal(compareReports(report, table).passed, false);
  const metadata = structuredClone(report); metadata.report.old.worker.metadataResults = 0;
  assert.equal(compareReports(report, metadata).passed, false);
  assert.throws(() => compareReports(report, { fixtureVersion: FIXTURE_VERSION, report: {} }));
  assert.throws(() => compareReports({ fixtureVersion: FIXTURE_VERSION, report: {} }, { fixtureVersion: FIXTURE_VERSION, report: {} }));
  const observed = { fixtureVersion: FIXTURE_VERSION, observations: report.report };
  const observedAfter = structuredClone(observed); observedAfter.observations.old.worker.rowsRead++;
  assert.equal(compareReports(observed, observedAfter, { observations: true }).deltas.old.worker.rowsRead, 1);
  console.log('c2-baseline: self-test passou; sem Git, Vitest, Wrangler ou rede.');
}
export function typecheck(root = rootDefault) {
  const output = path.join(root, 'output/c2-aceite'); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'typecheck.d.ts'),
    "import type { Env as WorkerEnv } from '../../src/types';\ndeclare global { namespace Cloudflare { interface Env extends WorkerEnv {} } }\n", 'utf8');
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM,DOM.Iterable',
    '--types', '@cloudflare/workers-types,vite/client', '--jsx', 'react-jsx', '--allowImportingTsExtensions',
    '--allowSyntheticDefaultImports', '--resolveJsonModule', 'tests/c2-aceite.test.ts', 'tests/c2-baseline-probe.test.ts',
    'tests/c2-orcamento.test.ts', 'node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts', 'output/c2-aceite/typecheck.d.ts'], root);
  console.log('c2-baseline: typecheck dos três testes passou; sem Vitest, Wrangler ou rede.');
}
export function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') return selfTest();
  if (process.argv.length === 3 && process.argv[2] === '--typecheck') return typecheck();
  const snapshotOnly = process.argv.length === 3 && process.argv[2] === '--snapshot-only';
  assert.ok(process.argv.length === 2 || snapshotOnly, 'Use sem argumentos, --snapshot-only, --self-test ou --typecheck.');
  const root = rootDefault, output = path.join(root, 'output/c2-aceite'), sources = sourceFingerprint(root);
  const baselines = Object.fromEntries(Object.entries(REFERENCES).map(([group, reference]) => [group, ensureBaseline(reference, root)]));
  if (snapshotOnly) {
    console.log('c2-baseline: snapshots locais e hashes em output/c2-aceite/reference-*.json; provas não executadas.');
    return;
  }
  const currentCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const base = {};
  for (const [group, baseline] of Object.entries(baselines))
    base[group] = probe(baseline.directory, baseline.commit, output, 'baseline-' + group, [group])[group];
  // Diagnóstico adicional: distingue mudanças da primeira leva de regressões
  // novas. A referência obrigatória do legado continua 20e15da9 e permanece
  // no gate abaixo; esta decomposição não perdoa nem desconta nenhum delta.
  const firstWaveLegacy = probe(baselines.social.directory, baselines.social.commit, output,
    'baseline-first-wave-legacy', ['legacy']).legacy;
  // O plugin preserva dados entre casos do mesmo arquivo. Executar os dois
  // sociais antes do interno somente no resultado acrescentava seis usuários
  // à leitura global de participantes. As duas árvores recebem a mesma seleção.
  const current = {};
  for (const group of Object.keys(baselines))
    current[group] = probe(root, currentCommit, output, 'current-' + group, [group])[group];
  json(path.join(output, 'current.json'), current);
  assert.equal(sourceFingerprint(root).sha256, sources.sha256, 'Fontes/harness mudaram durante as provas.');
  const comparison = { fixtureVersion: FIXTURE_VERSION, currentCommit, currentSources: sources, groups: {} };
  for (const [group, baseline] of Object.entries(baselines)) {
    assert.equal(snapshotFingerprint(baseline.directory).sha256, baseline.source.sha256, 'Baseline alterado durante prova.');
    assert.deepEqual(harnessHashes(root), harnessHashes(baseline.directory), 'Harness diferente entre referência e resultado.');
    comparison.groups[group] = { reference: baseline.commit, snapshotDirectory: baseline.snapshotDirectory,
      baselineSources: baseline.source, harnessSha256: baseline.harnessSha256,
      ...compareReports(base[group], current[group]),
      outsideMessagePath: compareReports(base[group], current[group], { observations: true }) };
  }
  comparison.historicalLegacy = {
    originalReference: baselines.legacy.commit, firstWaveReference: baselines.social.commit,
    snapshotDirectory: baselines.social.snapshotDirectory,
    baselineSources: baselines.social.source, harnessSha256: baselines.social.harnessSha256,
    originalToFirstWave: compareReports(base.legacy, firstWaveLegacy),
    firstWaveToCurrent: compareReports(firstWaveLegacy, current.legacy),
  };
  comparison.passed = Object.values(comparison.groups).every(group => group.passed);
  json(path.join(output, 'comparison.json'), comparison);
  for (const [group, data] of Object.entries(comparison.groups)) {
    console.log(group + ': ' + (data.passed ? 'delta zero' : 'FALHOU') + '; referência ' + data.reference);
    for (const [name, phases] of Object.entries(data.outsideMessagePath.deltas))
      console.log(name + ' (fora da mensagem): ' + JSON.stringify(phases.aggregate));
  }
  console.log('Legado desde a primeira leva (diagnóstico; gate original preservado): ' +
    (comparison.historicalLegacy.firstWaveToCurrent.passed ? 'delta zero' : 'diferenças registradas') +
    '; referência ' + baselines.social.commit);
  assert.ok(comparison.passed, 'Custo incompatível:\n' +
    Object.values(comparison.groups).flatMap(group => group.failures).join('\n'));
  console.log('c2-baseline: igualdade estrita e ausência de tabelas c2 conferidas; evidências em output/c2-aceite/.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

