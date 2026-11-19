#!/usr/bin/env node
// Mesmo transporte da base: quatro dry-runs locais, nunca deploy ou estimativa.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptance, ADDITIONAL_BUDGET, ABSOLUTE_LIMIT, main as measure, selfTest as dependencySelfTest } from './c2-dependency-size.mjs';

export const REFERENCE = '13a9d9c3';
export const MAX_DELTA = 524_288;
export const MAX_TOTAL = 41_943_040;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function validateReport(report) {
  assert.equal(ADDITIONAL_BUDGET, MAX_DELTA);
  assert.equal(ABSOLUTE_LIMIT, MAX_TOTAL);
  assert.equal(report.baselineReference, REFERENCE, 'Referência diferente da primeira leva fechada.');
  assert.match(report.baselineCommit, /^[a-f0-9]{40}$/);
  assert.ok(report.baselineCommit.startsWith(REFERENCE));
  assert.match(report.bundler, /^wrangler /, 'Estimativa não substitui o dry-run real.');
  const sizes = report.measurements;
  for (const name of ['baseline', 'empty', 'postal', 'final']) {
    const result = sizes?.[name];
    assert.ok(result?.modules?.some(module => module.file === 'index.js'), `${name}: falta index.js.`);
    assert.ok(result.modules.every(module => Number.isSafeInteger(module.bytes) && module.bytes >= 0 && /^[a-f0-9]{64}$/.test(module.sha256)));
    assert.equal(result.bytes, result.modules.reduce((sum, module) => sum + module.bytes, 0));
    assert.ok(result.command?.includes('--dry-run') && result.command.includes('--minify'), 'Empacotamento diferente do release.');
  }
  assert.equal(sizes.baseline.main, 'src/index.ts');
  assert.equal(sizes.final.main, 'src/index.ts', 'O main de produção continua src/index.ts.');
  const budget = acceptance(sizes.baseline.bytes, sizes.postal.bytes - sizes.empty.bytes, sizes.final.bytes);
  assert.deepEqual(report.acceptance, budget, 'Relatório e módulos medidos divergem.');
  assert.equal(budget.status, 'passed', budget.failures.join('\n'));
  return budget;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    assert.equal(REFERENCE, '13a9d9c3');
    assert.equal(ADDITIONAL_BUDGET, MAX_DELTA); assert.equal(ABSOLUTE_LIMIT, MAX_TOTAL);
    await dependencySelfTest();
    assert.throws(() => validateReport({ baselineReference: '081951d6' }));
    assert.throws(() => validateReport({ baselineReference: REFERENCE, baselineCommit: REFERENCE.padEnd(40, '0'), bundler: 'esbuild' }));
    console.log('c2-bundle-check: autotestes aprovados; bytes do Worker ainda não medidos.');
    return;
  }
  assert.equal(args.length, 0, 'Use sem argumentos (verificação externa) ou --self-test (sem Wrangler).');
  const directory = join(root, 'output/c2-aceite'); mkdirSync(directory, { recursive: true });
  let report = { acceptance: { status: 'blocked' }, published: false };
  try {
    // O medidor falha fechado se o Wrangler local faltar. Não instala nada.
    report = { ...await measure(['--baseline', REFERENCE]), published: false };
    if (report.acceptance?.status !== 'passed') throw new Error(report.acceptance?.reason ?? report.acceptance?.failures?.join('\n') ?? 'Medição real incompleta.');
    validateReport(report);
  } catch (error) {
    report = { ...report, acceptance: { ...report.acceptance, status: 'failed', reason: error.message } };
    process.exitCode = 1;
  }
  writeFileSync(join(directory, 'bundle.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (report.acceptance.status !== 'passed') throw new Error(
    `Pacote não aprovado: ${report.acceptance.reason ?? 'medição incompleta'}. Consulte output/c2-aceite/bundle.json; nenhuma estimativa foi aceita.`);
  console.log(JSON.stringify(report.acceptance, null, 2));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
