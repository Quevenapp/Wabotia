// Regressão do porte comercial: mesmos filtros/páginas/detalhes no PostgreSQL
// original e no SQLite. Datas explícitas não dependem do relógio do runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dualFixture } from '../harness/dual-fixture.mjs';

test('atividades e exclusões: filtro, ordem, paginação e antes/depois conferem com o oráculo', async () => {
  const f = await dualFixture();
  try {
    for (const [index, name] of ['Ação arquivada A', 'Ação arquivada B'].entries()) {
      const id = randomUUID();
      await f.db.query(`INSERT INTO erp_catalog.record(id,entity,name,code,active,created_by,updated_by,created_at,updated_at)
        VALUES($1,'contacts',$2,$3,false,$4,$4,'2026-11-19T12:00:00Z','2026-11-19T12:00:00Z')`, [id, name, 'AVULSO-' + index, f.users.admin]);
      for (const [n, action] of ['create', 'archive'].entries()) {
        await f.db.query(`INSERT INTO erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data,created_at)
          VALUES($1,$2,'contacts',$3,$4,$5,$6,$7)`, [f.users.admin, randomUUID(), id, action,
          n ? { name, active: true } : null, { name, active: !n }, `2026-11-19T12:00:00.00000${index * 2 + n}Z`]);
      }
    }
    await f.sync();
    const list = changes => f.rpc('erp_activity_list', { p_user_id: f.users.admin, p_from: '2026-11-01', p_to: '2026-11-19', p_module: 'clientes_fornecedores',
      p_operation: null, p_actor: f.users.admin, p_query: '  AÇÃO  ', p_limit: 1, p_offset: 0, ...changes });
    for (const p_operation of [null, 'exclusao']) {
      const first = await list({ p_operation });
      assert.equal(first.total, p_operation ? 2 : 4);
      assert.equal(first.items[0].description, 'Ação arquivada B');
      assert.equal(first.items[0].operation, 'exclusao');
      const second = await list({ p_operation, p_offset: 1 });
      assert.notEqual(second.items[0].id, first.items[0].id);
      assert.equal(second.items[0].description, p_operation ? 'Ação arquivada A' : 'Ação arquivada B');
      const detail = await f.rpc('erp_activity_detail', { p_user_id: f.users.admin, p_source: first.items[0].source, p_entry_id: first.items[0].id });
      assert.equal(detail.before.active, true);
      assert.equal(detail.after.active, false);
    }
    assert.equal((await list({ p_to: '2026-11-18' })).total, 0);
    await assert.rejects(list({ p_user_id: f.users.consulta }), { code: '42501' });
    await assert.rejects(f.rpc('erp_activity_detail', { p_user_id: f.users.consulta, p_source: 'catalog', p_entry_id: '1' }), { code: '42501' });
  } finally { await f.close(); }
});
