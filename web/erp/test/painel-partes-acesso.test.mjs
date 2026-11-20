// Wabotia: a reconferência do mesmo ator não apaga a permissão fina já conferida
// (a aba "Lançamentos de estoque" não some e volta a cada reconferência).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessController } from '../app/lib/real-access.ts';
import { portedPermissionState } from '../../management/ported-policy.ts';

const actor = '10000000-0000-4000-8000-000000000001';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const permissionsBody = permissions => ({ scope: 'access_permissions', data_mode: 'erp_native', user_id: actor, role: 'estoque', user_type: 'normal', permissions, access: { open: true, until: null } });

function setup() {
  const s = { me: 0, fine: 0, gates: [] };
  const auth = {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: actor } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  s.controller = createAccessController(auth, 'https://api.synthetic.test', async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/me') { s.me++; return Response.json({ user_id: actor, role: 'estoque', resources: ['products'], data_mode: 'staging_readonly' }); }
    if (path === '/v1/sistema/permissoes') { s.fine++; const gate = s.gates.shift(); return gate ? gate.promise : Response.json(permissionsBody(['suprimentos.controle_estoque'])); }
    return Response.json({}, { status: 404 });
  });
  return s;
}

test('reconferência do mesmo ator mantém a última permissão conferida até a resposta nova chegar', async () => {
  const s = setup(), stop = s.controller.start();
  try {
    await tick(); s.controller.verifyPermissions(); await tick();
    const first = s.controller.getSnapshot().permissions;
    assert.equal(first.phase, 'ready');
    assert.equal(portedPermissionState('/estoque-empresa', first), 'allowed');
    const gate = deferred(); s.gates.push(gate);
    const seen = [];
    const unsubscribe = s.controller.subscribe(() => seen.push(s.controller.getSnapshot().permissions));
    s.controller.retry(); await tick();
    assert.equal(s.me, 2, 'a reconferência continua acontecendo');
    assert.equal(s.fine, 2);
    // Enquanto a resposta nova não chega, vale a última permissão conferida.
    assert.equal(s.controller.getSnapshot().permissions, first);
    assert.ok(seen.every(value => value === first), 'nenhum estado intermediário sem a permissão');
    assert.equal(portedPermissionState('/estoque-empresa', s.controller.getSnapshot().permissions), 'allowed');
    // A resposta nova tira a permissão: aí a aba some.
    gate.resolve(Response.json(permissionsBody([]))); await tick();
    const next = s.controller.getSnapshot().permissions;
    assert.equal(next.phase, 'ready'); assert.deepEqual(next.permissions, []);
    assert.equal(portedPermissionState('/estoque-empresa', next), 'denied');
    unsubscribe();
  } finally { stop(); }
});

test('a primeira conferência continua passando por "Verificando…"', async () => {
  const s = setup(), gate = deferred(); s.gates.push(gate);
  const stop = s.controller.start();
  try {
    await tick(); s.controller.verifyPermissions(); await tick();
    assert.equal(s.controller.getSnapshot().permissions.phase, 'checking');
    gate.resolve(Response.json(permissionsBody(['suprimentos.controle_estoque']))); await tick();
    assert.equal(s.controller.getSnapshot().permissions.phase, 'ready');
  } finally { stop(); }
});
