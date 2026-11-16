import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { cnabReturnAmountsQa } from '../app/qa/cnab-return-amounts-fixture.ts';
import { returnAmountRows } from '../app/lib/cnab-return-amounts.ts';
import { inspectBuildFile } from './upstream/tools/qa/check-erp-build.mjs';
test('four synthetic QA scenarios are local presentation only and detached per factory call', () => {
  const scenarios = cnabReturnAmountsQa(); assert.equal(scenarios.length, 4);
  assert.deepEqual(scenarios.map(x => returnAmountRows(x.event).length), [8, 8, 8, 2]);
  scenarios[0].event.paid_cents = '1'; assert.equal(cnabReturnAmountsQa()[0].event.paid_cents, '12000');
  assert.equal(scenarios.some(x => 'controller' in x || 'command_id' in x), false);
});
test('QA entry builds for a browser but every QA source is blocked from production artifacts', async () => {
  for (const path of ['../qa/cnab-return-amounts-qa.html', '../app/qa/cnab-return-amounts-main.tsx', '../app/qa/cnab-return-amounts-fixture.ts']) {
    assert.ok(inspectBuildFile(path, await readFile(new URL(path, import.meta.url))).failures.includes('qa_marker'));
  }
  const output = await build({ entryPoints: ['web/erp/app/qa/cnab-return-amounts-main.tsx'], bundle: true, write: false, platform: 'browser', format: 'esm', outdir: '/Volumes/Dev/tmp/cnab-return-amounts-qa', define: { 'import.meta.env.DEV': 'true' }, logLevel: 'silent' });
  const js = output.outputFiles.find(f => f.path.endsWith('.js')).text;
  assert.match(js, /LOCAL_QA_ONLY/); assert.doesNotMatch(js, /supabase\.co|\/v1\/|fetch\(/);
});
