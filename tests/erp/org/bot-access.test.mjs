import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { authorizeOperation } from '../../../src/erp/bling/permissions.ts';
import { BLING_ENTITIES } from '../../../src/erp/bling/contracts.ts';
import { BLING_OPERATIONS } from '../../../src/erp/bling/schema.ts';
import { normalizeErpParts } from '../../../src/erp/parts.ts';

// Empacota somente imports locais para o Node resolver as extensões usadas pelo Worker.
const bundle = await build({ entryPoints: ['src/modules/erp/bot-access.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { ERP_BOT_OPERATIONS, erpBotOperation, erpBotOperationGranted, erpBotDelegation } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const profile = 'area-bling', now = Date.UTC(2026, 10, 20, 12), hash = 'a'.repeat(64);
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bots(id,profile_id,remote_profile,connection_id,enabled);
    CREATE TABLE connections(id,profile_id,status,config);
    CREATE TABLE bot_runs(id,profile_id,bot_id,actor,conversation_id,context);
    CREATE TABLE internal_chats(id,profile_id,member_a,member_b);
    CREATE TABLE bot_proposals(id,profile_id,actor,bot_id,run_id,mode,status,method,decided_at,path,params);
    INSERT INTO bots VALUES('bot-1','area-bling','default','connection-1',1);
    INSERT INTO connections VALUES('connection-1','area-bling','active','{}');
    INSERT INTO bot_runs VALUES('run-1','area-bling','bot-1','person-1',NULL,'{"internal_chat_id":"chat-1"}');
    INSERT INTO internal_chats VALUES('chat-1','area-bling','person-1','bot:bot-1');`);
  const env = { DB: { prepare(sql) { return { bind(...args) { return { async first() { return db.prepare(sql).get(...args) ?? null; } }; } }; } } };
  const actor = { kind: 'user', id: 'person-1', via: { kind: 'bot', bot_id: 'bot-1', run_id: 'run-1', masked: true } };
  return { db, env, actor, grant(operations) { db.prepare('UPDATE connections SET config=?').run(JSON.stringify({ bot_options: { default: { erp_operations: operations } } })); } };
}
const path = suffix => `/api/v1/profiles/${profile}/erp/v1/receber-bling${suffix}`;

test('Bling usa os descritores na concessão ERP; bot sem concessão e origem externa não alcançam', async () => {
  const f = fixture();
  try {
    for (const op of Object.values(BLING_OPERATIONS).filter(op => op.name !== 'erp_bling_oauth_callback')) {
      const route = path(op.path === '/' ? '' : op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, 'sample'));
      assert.equal(erpBotOperation(profile, op.method, route)?.id, op.name);
      assert.equal(ERP_BOT_OPERATIONS.filter(entry => entry.id === op.name).length, 1);
      assert.equal(await erpBotOperationGranted(f.env, f.actor, profile, op.name), false);
      f.grant([op.name]);
      assert.equal(await erpBotOperationGranted(f.env, f.actor, profile, op.name), true);
      if (op.method === 'GET') assert.equal(await erpBotDelegation(f.env, f.actor, profile, op.method, route), true);
      f.db.exec("UPDATE bot_runs SET conversation_id='external-conversation'");
      assert.equal(await erpBotOperationGranted(f.env, f.actor, profile, op.name), false);
      f.db.exec('UPDATE bot_runs SET conversation_id=NULL');
      assert.equal(await erpBotOperationGranted(f.env, f.actor, 'another-area', op.name), false);
      f.grant([]);
    }
  } finally { f.db.close(); }
});

test('escrita padrão exige proposta reclamada, pessoa, sessão, bot, rota e corpo exatos', async () => {
  const f = fixture(), body = { command_id: 'command-1', expected_revision: '1' };
  const actor = { ...f.actor, sessionId: 'session-1', via: { ...f.actor.via, proposal_id: 'proposal-1' } };
  try {
    f.grant(['erp_bling_disable']);
    const confirmed = value => erpBotDelegation(f.env, actor, profile, 'POST', path('/desligar'), value);
    assert.equal(await confirmed(body), false);
    f.db.prepare('INSERT INTO bot_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('proposal-1', profile, actor.id, 'bot-1', 'run-1', 'team', 'pending', 'POST', null, 'erp/v1/receber-bling/desligar', JSON.stringify(body));
    assert.equal(await confirmed(body), false);
    f.db.prepare("UPDATE bot_proposals SET status='running',decided_at=?").run(now);
    assert.equal(await confirmed(body), true);
    assert.equal(await confirmed({ ...body, expected_revision: '2' }), false);
    assert.equal(await erpBotDelegation(f.env, { ...actor, sessionId: undefined }, profile, 'POST', path('/desligar'), body), false);
    assert.equal(await erpBotDelegation(f.env, actor, profile, 'POST', path('/ligar'), body), false);
    f.grant([]);
    assert.equal(await confirmed(body), false);
  } finally { f.db.close(); }
});

test('política Bling não duplica operações; preserva dados conservadores e confirmação sensível', () => {
  const parts = normalizeErpParts({});
  const ctx = { profile, origin: 'app', clock: { now: () => now }, identity: { actor: { user_id: 'person-1', erp_role: 'admin', session_id: 'session-1', is_agent: true }, parts, partsControl: { profile, revision: '1', expires_at: now + 120000 } }, authorization: { bot: { id: 'bot-1', allowed_operations: ['erp_bling_record_get', 'erp_bling_disable'], allowed_entities: [...BLING_ENTITIES], data_scopes: ['public', 'raw', 'personal', 'sensitive'], allow_sensitive: false } } };
  const configuration = { access: { reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } } };
  const allowed = authorizeOperation(ctx, 'erp_bling_record_get', { entity: 'products', id: '1' }, configuration, hash);
  assert.deepEqual(allowed.authorization.bot.data_scopes, ['public', 'raw']);
  configuration.access.bots = [{ bot_id: 'bot-1', operations: [], entities: [...BLING_ENTITIES], data_scopes: ['public', 'raw'], allow_sensitive: false, mask_personal: true }];
  assert.doesNotThrow(() => authorizeOperation(ctx, 'erp_bling_record_get', { entity: 'products', id: '1' }, configuration, hash));
  const command = { command_id: 'command-1', expected_revision: '1' };
  assert.throws(() => authorizeOperation(ctx, 'erp_bling_disable', command, configuration, hash), { code: 'BLING_SCOPE_REQUIRED' });
  ctx.authorization.confirmation = { operation: 'erp_bling_disable', command_id: command.command_id, request_hash: hash, confirmed_by: 'person-1', expires_at: now + 60000 };
  assert.doesNotThrow(() => authorizeOperation(ctx, 'erp_bling_disable', command, configuration, hash));
  assert.throws(() => authorizeOperation({ ...ctx, origin: 'external' }, 'erp_bling_disable', command, configuration, hash));
  ctx.authorization.bot.allowed_operations = [];
  assert.throws(() => authorizeOperation(ctx, 'erp_bling_disable', command, configuration, hash));
});
