// Cópia de workers/erp-api/test/document-signature-weight-sql.test.mjs do
// Fagoo (somente leitura) na fixture dupla, pelo Worker real: assinatura da
// proposta por usuário e casas decimais do peso (migração 199).
// Adaptação, só nos auxiliares:
// - banco com todas as migrações (o original usa a leva D, até a 203), pela
//   documents-fixture.mjs (lane 'D');
// - a fixture dupla cria um perfil (erp_access.profile) para cada pessoa; o
//   do usuário de vendas sai antes do teste, para valer o estado do original
//   (sem nome em Sistema › Usuários);
// - o INSERT direto do perfil vai com f.sync().
// Descartado, declarado: o teste "199 grants and the immutable audit" é só
// has_function_privilege (papéis do Postgres, sem equivalente no motor).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsFixture } from './documents-fixture.mjs';

let f;
before(async () => {
  f = await documentsFixture({ lane: 'D' });
  await f.write('delete from erp_access.profile where user_id=$1', [f.users.vendas]);
});
after(() => f?.close());
const save = (body, user) => f.call('/v1/documentos/sales_proposals/assinatura', 'POST', { command_id: randomUUID(), ...body }, user);

test('Assinatura: each user keeps Saudação and Departamento; CAS, replay and audit', async () => {
  const empty = await f.call('/v1/documentos/sales_proposals/assinatura', 'GET', undefined, f.users.vendas);
  assert.equal(empty.status, 200, JSON.stringify(empty.value));
  // Without a name in Sistema › Usuários nothing stands in for it: the e-mail of the user never goes into a printed proposta.
  assert.deepEqual([empty.value.greeting, empty.value.department, empty.value.version, empty.value.name], [null, null, 0, null]);
  await f.write('insert into erp_access.profile(user_id,name,version,updated_at,updated_by) values($1,$2,1,clock_timestamp(),$1)', [f.users.vendas, 'Vendedora Sintética']);
  assert.equal((await f.call('/v1/documentos/sales_proposals/assinatura', 'GET', undefined, f.users.vendas)).value.name, 'Vendedora Sintética');
  const command = randomUUID(), body = { command_id: command, expected_version: 0, greeting: 'Atenciosamente,', department: 'Comercial' };
  const saved = await f.call('/v1/documentos/sales_proposals/assinatura', 'POST', body, f.users.vendas);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual([saved.value.greeting, saved.value.department, saved.value.version, saved.value.replayed], ['Atenciosamente,', 'Comercial', 1, false]);
  assert.equal((await f.call('/v1/documentos/sales_proposals/assinatura', 'POST', body, f.users.vendas)).value.replayed, true);
  assert.equal((await save({ expected_version: 0, greeting: 'Outra', department: null }, f.users.vendas)).status, 409, 'stale version');
  assert.equal((await save({ expected_version: 1, greeting: null, department: 'Vendas' }, f.users.vendas)).value.version, 2);
  assert.equal((await f.call('/v1/documentos/sales_proposals/assinatura', 'GET', undefined, f.users.admin)).value.version, 0, 'another user has another signature');
  assert.equal((await save({ expected_version: 0, greeting: 'x', department: null }, f.users.estoque)).status, 403);
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.user_signature_audit where user_id=$1', [f.users.vendas]), 2);
  await assert.rejects(() => f.db.query('delete from erp_documents.user_signature_audit'));
  assert.equal((await save({ expected_version: 2, greeting: 'a\nb', department: null }, f.users.vendas)).status, 400);
});

test('the documents read the casas decimais of the peso', async () => {
  assert.equal((await f.call('/v1/documentos', 'GET')).value.settings.weight_decimals, 3);
  await f.setPreference('empresa-geral', 'empresa.decimais_peso', 1);
  assert.equal((await f.call('/v1/documentos', 'GET')).value.settings.weight_decimals, 1);
});
