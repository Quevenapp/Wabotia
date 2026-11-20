import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../../../web/erp/test/helpers/component-recovery-harness.mjs';
import { createActivityFixture } from '../../../web/erp/app/qa/activity-fixture.ts';

test('Consulta de exclusões abre o mesmo detalhe auditado do Registro de atividades', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
  const previous = globalThis.document;
  globalThis.document = { activeElement: null, documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} };
  const f = createActivityFixture();
  const view = await mountComponent('RealActivity.tsx', { controller: f.controller, mode: 'deletions' }, { expandChildren: true });
  try {
    assert.deepEqual(f.calls, ['/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&operacao=exclusao']);
    await view.click('Ver detalhe');
    assert.equal(f.calls.at(-1), '/v1/registro-atividades/detalhe?origem=users&id=3');
    assert.match(view.text(), /Detalhes do registro.*CampoAntesDepois/s);
    await view.click('Fechar');
    assert.doesNotMatch(view.text(), /Detalhes do registro/);
  } finally { view.unmount(); globalThis.document = previous; }
});
