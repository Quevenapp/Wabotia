// A erp-api real, incluindo validação do DTO, sobre o motor SQLite.
// Sem rede: fetchImpl só aceita a identidade e os RPCs desta instalação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLite, nodeDriver } from '../harness/node-driver.mjs';
import { callRpc } from '../../../src/erp/engine/registry.ts';
import { Clock } from '../../../src/erp/engine/time.ts';
import '../../../src/erp/domains/index.ts';
import { createHandler } from '../../../src/erp/fagoo/workers/erp-api/src/index.mjs';
import { activityEntrySql, ENTRIES_SQL, entriesBindings } from '../../../src/erp/domains/access/activity.ts';
import { ACTIVITY_SOURCES } from '../../../src/erp/fagoo/packages/erp-domain/src/activity.mjs';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const READER = '00000000-0000-4000-8000-000000000002';
const AT = '1795089600000000'; // 19/11/2026, 09h em São Paulo.
const PERIOD = 'de=2026-11-01&ate=2026-11-19';
const env = { SUPABASE_URL: 'https://erp.wabotia.invalid', SUPABASE_DEPLOYMENT: 'self-hosted', SUPABASE_SERVICE_ROLE_KEY: 'local-test', ALLOWED_ORIGINS: '' };

function fixture(parts) {
  const db = freshLite(), raw = nodeDriver(db), statements = [], rpcs = [];
  const driver = { ...raw, exec(sql, ...args) {
    assert.doesNotMatch(sql, /\?[0-9]+/, 'o SQL enviado ao SqlStorage usa parâmetros anônimos');
    assert.ok(args.length <= 100, 'limite de parâmetros do SqlStorage');
    statements.push(sql); return raw.exec(sql, ...args);
  } };
  for (const [id, role] of [[ADMIN, 'admin'], [READER, 'consulta']]) {
    db.prepare('INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,?,1,?,?)').run(id, role, AT, AT);
    db.prepare('INSERT INTO erp_access__profile(user_id,name,version,updated_at,updated_by) VALUES(?,?,1,?,?)').run(id, role, AT, ADMIN);
  }
  const handler = createHandler({ fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/v1/user') return Response.json({ id: new Headers(init.headers).get('authorization').slice(7), app_metadata: {} });
    assert.match(path, /^\/rest\/v1\/rpc\/erp_/);
    const name = path.split('/').at(-1); rpcs.push(name);
    try { return Response.json(callRpc(driver, name, JSON.parse(init.body), new Clock(BigInt(AT)), { parts })); }
    catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 400 }); }
  } });
  return {
    db, statements, rpcs,
    async get(path, actor = ADMIN) {
      statements.length = 0; rpcs.length = 0;
      const response = await handler(new Request('https://erp.example' + path, { headers: { Authorization: 'Bearer ' + actor } }), env);
      return { status: response.status, body: await response.json() };
    },
  };
}

function seed(db) {
  for (const [index, name] of ['Ação arquivada A', 'Ação arquivada B'].entries()) {
    const id = `00000000-0000-4000-8000-00000000001${index}`;
    db.prepare('INSERT INTO erp_catalog__record(id,entity,name,code,active,created_by,updated_by,created_at,updated_at) VALUES(?,\'contacts\',?,?,0,?,?,?,?)')
      .run(id, name, 'ATV-' + index, ADMIN, ADMIN, AT, AT);
    for (const [n, action] of ['create', 'archive'].entries()) {
      db.prepare('INSERT INTO erp_catalog__audit(id,actor,command_id,entity,record_id,action,before_data,after_data,created_at) VALUES(?,?,?,\'contacts\',?,?,?,?,?)')
        .run(index * 2 + n + 1, ADMIN, crypto.randomUUID(), id, action, n ? JSON.stringify({ name, active: true }) : null, JSON.stringify({ name, active: !n }), String(BigInt(AT) + BigInt(index * 2 + n)));
    }
  }
}

test('atividades e exclusões abrem com DTO válido; uma operação e duas consultas no banco vazio', async () => {
  const f = fixture();
  try {
    for (const suffix of ['', '&operacao=exclusao']) {
      const response = await f.get('/v1/registro-atividades?' + PERIOD + suffix);
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.body.scope, 'activity');
      assert.equal(response.body.operation, suffix ? 'exclusao' : null);
      assert.deepEqual(response.body.items, []);
      assert.deepEqual(f.rpcs, ['erp_activity_list']);
      assert.equal(f.statements.length, 2);
    }
  } finally { f.db.close(); }
});

test('atividade: administrador obrigatório nas duas consultas e no detalhe', async () => {
  const f = fixture();
  try {
    for (const path of ['/v1/registro-atividades?' + PERIOD, '/v1/registro-atividades?' + PERIOD + '&operacao=exclusao', '/v1/registro-atividades/detalhe?origem=catalog&id=1']) {
      const response = await f.get(path, READER);
      assert.equal(response.status, 403, JSON.stringify(response));
      assert.equal(response.body.error.code, 'ERP_ACCESS_DENIED');
    }
  } finally { f.db.close(); }
});

test('atividade: Base desligada recusa as duas consultas e o detalhe no motor', async () => {
  const f = fixture({ customers: false });
  try {
    for (const name of ['erp_activity_list', 'erp_activity_detail']) {
      assert.throws(() => callRpc(nodeDriver(f.db), name, name.endsWith('list')
        ? { p_user_id: ADMIN, p_from: '2026-11-01', p_to: '2026-11-19', p_module: null, p_operation: null, p_actor: null, p_query: null, p_limit: 100, p_offset: 0 }
        : { p_user_id: ADMIN, p_source: 'catalog', p_entry_id: '1' }, new Clock(BigInt(AT)), { parts: { customers: false } }), { code: 'module_disabled' });
    }
  } finally { f.db.close(); }
});

test('as duas telas filtram, paginam e abrem antes/depois pela erp-api; partes suspensas preservam a consulta Base', async () => {
  const f = fixture({ fiscal: false, billing: false, pos: false });
  try {
    seed(f.db);
    for (const suffix of ['', '&operacao=exclusao']) {
      const query = '/v1/registro-atividades?' + PERIOD + '&modulo=clientes_fornecedores&usuario=' + ADMIN + '&q=a%C3%A7%C3%A3o&limit=1' + suffix;
      const first = await f.get(query);
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal(first.body.total, suffix ? 2 : 4);
      assert.equal(first.body.has_more, true);
      assert.equal(first.body.items[0].id, '4');
      const next = await f.get(query + '&offset=1');
      assert.equal(next.status, 200, JSON.stringify(next));
      assert.equal(next.body.items[0].id, suffix ? '2' : '3');
      const detail = await f.get('/v1/registro-atividades/detalhe?origem=catalog&id=4');
      assert.equal(detail.status, 200, JSON.stringify(detail));
      assert.equal(detail.body.available, true);
      assert.equal(detail.body.before.active, true);
      assert.equal(detail.body.after.active, false);
      assert.ok(!f.statements.some(sql => sql.includes('UNION ALL')), 'detalhe por chave não consulta outras fontes');
    }
  } finally { f.db.close(); }
});

test('cada fonte tem busca de detalhe por id; o cadastro usa a chave primária', () => {
  const f = fixture();
  try {
    for (const source of ACTIVITY_SOURCES) {
      const sql = activityEntrySql(source);
      assert.ok(sql, source);
      assert.doesNotMatch(sql, /UNION ALL|created_at[<>]|\?[0-9]/);
      assert.equal((sql.match(/\?/g) ?? []).length, 1);
      const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + sql).all('1');
      if (source === 'catalog') assert.ok(plan.some(row => /SEARCH a USING INTEGER PRIMARY KEY/.test(row.detail)), JSON.stringify(plan));
    }
  } finally { f.db.close(); }
});

test('a composição das 36 fontes preserva ordem global, filtros e páginas entre o primeiro e o último grupo', async () => {
  const f = fixture();
  try {
    seed(f.db);
    f.db.prepare('INSERT INTO erp_documents__user_signature_audit(id,user_id,command_id,after_data,created_at) VALUES(1,?,?,?,?)')
      .run(ADMIN, crypto.randomUUID(), '{}', String(BigInt(AT) + 4n));
    const file = crypto.randomUUID();
    f.db.prepare(`INSERT INTO erp_company__file(id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,created_at)
      VALUES(?,?,?,?,?,'text/plain',1,?,'ready',?)`)
      .run(file, crypto.randomUUID(), ADMIN, 'a'.repeat(64), 'arquivo da empresa.txt', 'b'.repeat(64), AT);
    for (const [index, time] of [BigInt(AT) + 5n, BigInt(AT) + 86_400_000_000n].entries()) {
      f.db.prepare("INSERT INTO erp_company__file_audit(id,file_id,actor,action,created_at) VALUES(?,?,?,'delete',?)")
        .run(index + 1, file, ADMIN, String(time));
    }
    const first = await f.get('/v1/registro-atividades?' + PERIOD + '&limit=2');
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.body.total, 6, 'o evento do dia seguinte fica fora do período');
    assert.equal(first.body.has_more, true);
    assert.deepEqual(first.body.items.map(item => item.source), ['company_files', 'user_signatures']);
    const next = await f.get('/v1/registro-atividades?' + PERIOD + '&limit=2&offset=2');
    assert.deepEqual(next.body.items.map(item => [item.source, item.id]), [['catalog', '4'], ['catalog', '3']]);
    const deleted = await f.get('/v1/registro-atividades?' + PERIOD + '&operacao=exclusao&limit=2');
    assert.equal(deleted.body.total, 3);
    assert.deepEqual(deleted.body.items.map(item => item.source), ['company_files', 'catalog']);
    const filtered = await f.get('/v1/registro-atividades?' + PERIOD + '&modulo=anexos&usuario=' + ADMIN + '&q=empresa');
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.items[0].source, 'company_files');
    const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + ENTRIES_SQL).all(...entriesBindings(AT, String(BigInt(AT) + 100n)));
    assert.ok(!plan.some(row => /MATERIALIZE/.test(row.detail)), 'a árvore não materializa tabelas intermediárias');
  } finally { f.db.close(); }
});
