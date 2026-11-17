// Cópia de workers/erp-api/test/finance-files-sql.test.mjs do Fagoo (somente
// leitura) na fixture dupla: anexos de contas e de lançamentos de caixa (211)
// pelo Worker real, com um Storage em memória.
// Adaptação, só nos auxiliares: a fixture dupla; o bucket já existe na
// fixture; o objeto enviado entra nos dois lados por F.putObject
// (storage.objects no Postgres, ctx.objects no motor), como no
// catalog-product-images-http; o contato pela erp_catalog_save (F.catalog).
// Descartado, declarado: o primeiro teste inteiro (grants e security definer
// das funções e das tabelas; PLANO-FAGOO-MOTOR.md, seção 2).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createHandler } from '../../../src/erp/fagoo/workers/erp-api/src/index.mjs';
import { financeFileRoute } from '../../../src/erp/fagoo/workers/erp-api/src/finance-files.mjs';
import { dualFixture } from '../harness/dual-fixture.mjs';

// Synthetic data only. 211: Anexos of contas and of lançamentos de caixa on PGlite through the real Worker, with an in-memory Storage.
let F; let db; let users; let handler; let title; let entry; let alfa;
const files = new Map();
const config = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const pdf = new TextEncoder().encode('%PDF-1.4\n% sintético\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const note = new TextEncoder().encode('Comprovante sintético.\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rpc = (name, args) => F.rpc(name, args);
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
before(async () => {
  F = await dualFixture();
  db = F.db; users = { ...F.users };
  alfa = await F.catalog('contacts', { roles: ['customer', 'supplier'], name: 'Alfa Sintética' });
  title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'payable', contact_id: alfa.id, description: 'Conta com anexos', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '5000', installments: [{ amount_cents: '5000', due_on: '2026-03-10' }] } })).items[0];
  const caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa', start_on: '2020-01-01', opening_cents: '0' } })).record;
  entry = (await rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { account_id: caixa.id, kind: 'out', amount_cents: '1200', posted_on: '2026-03-02', competence_on: '2026-03-02', note: 'Lançamento sintético', expected_version: 0 } })).record;
  const fail = (status, code) => Response.json({ code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status });
  handler = createHandler({ fetchImpl: async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
    const object = /^\/storage\/v1\/object\/(?:authenticated\/)?erp-attachments\/(.+)$/.exec(pathname);
    if (object) {
      if (options.method === 'POST') {
        if (files.has(object[1])) return new Response(null, { status: 409 });
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer()); files.set(object[1], bytes);
        await F.putObject('erp-attachments', object[1], bytes.length, options.headers['Content-Type']);
        return new Response(null, { status: 200 });
      }
      const bytes = files.get(object[1]); return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) : new Response(null, { status: 404 });
    }
    try { return Response.json(await rpc(pathname.split('/').at(-1), JSON.parse(options.body))); }
    catch (e) { return fail(400, e.code); }
  } });
});
after(async () => F?.close());
const base = (kind = 'contas', id = title.id) => `/v1/anexos-financeiro/${kind}/${id}`;
async function call(path, method = 'GET', body, user = users.financeiro, type = 'application/json') {
  const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), config);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value = null; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* bytes */ }
  return { status: response.status, value, bytes, type: response.headers.get('Content-Type') };
}
const send = async (path, bytes, mime, filename, user = users.financeiro) => {
  const reserved = await call(path, 'POST', { command_id: randomUUID(), filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes) }, user);
  if (reserved.status !== 200) return reserved;
  return call(`${path}/${reserved.value.attachment.id}/upload`, 'PUT', bytes, user, mime);
};

test('211 a conta keeps its files: upload checked by SHA-256, list, download, consulta reads only, and excluding is audited', async () => {
  const sent = await send(base(), pdf, 'application/pdf', 'Boleto da conta.pdf');
  assert.equal(sent.status, 200, JSON.stringify(sent.value)); assert.equal(sent.value.attachment.status, 'ready'); assert.equal(sent.value.attachment.filename, 'anexo-Boleto-da-conta.pdf');
  assert.ok(files.has(`finance/${title.id}/${sent.value.attachment.id}/${sha(pdf)}`), 'the object key belongs to the conta');
  const listed = await call(base(), 'GET', undefined, users.consulta);
  assert.equal(listed.status, 200); assert.deepEqual(listed.value.items.map(item => [item.filename, item.owner_kind, item.status]), [['anexo-Boleto-da-conta.pdf', 'title', 'ready']]);
  const download = await call(`${base()}/${sent.value.attachment.id}/download`, 'GET', undefined, users.consulta);
  assert.equal(download.status, 200); assert.equal(download.type, 'application/octet-stream'); assert.deepEqual([...download.bytes], [...pdf]);
  assert.equal((await send(base(), note, 'text/plain', 'nota.txt', users.consulta)).status, 403, 'consulta does not send');
  for (const role of ['vendas', 'estoque', 'inactive']) assert.equal((await call(base(), 'GET', undefined, users[role])).status, 403, role);
  // A mismatched body never reaches the Storage; the same command replays.
  const command = randomUUID(), meta = { command_id: command, filename: 'nota.txt', mime_type: 'text/plain', size_bytes: note.length, sha256: sha(note) };
  const reserved = await call(base(), 'POST', meta), again = await call(base(), 'POST', meta);
  assert.equal(again.value.replayed, true); assert.equal(again.value.attachment.id, reserved.value.attachment.id);
  assert.equal((await call(base(), 'POST', { ...meta, size_bytes: 5 })).status, 409, 'the same command with other metadata conflicts');
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/upload`, 'PUT', new TextEncoder().encode('Outro conteúdo.\n'), users.financeiro, 'text/plain')).status, 400);
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/abort`, 'POST', {})).value.attachment.status, 'aborted');
  const removal = randomUUID(), deleted = await call(`${base()}/${sent.value.attachment.id}/exclusao`, 'POST', { command_id: removal });
  assert.equal(deleted.status, 200); assert.equal(deleted.value.attachment.deleted, true);
  assert.equal((await call(`${base()}/${sent.value.attachment.id}/exclusao`, 'POST', { command_id: removal })).value.replayed, true);
  assert.equal((await call(`${base()}/${sent.value.attachment.id}/download`, 'GET', undefined, users.consulta)).status, 409, 'an excluded file is never delivered again');
  assert.deepEqual((await call(base(), 'GET', undefined, users.consulta)).value.items.map(item => item.status), ['aborted']);
  assert.deepEqual((await db.query('select action from erp_finance.file_audit order by id')).rows.map(row => row.action), ['reserve', 'finalize', 'reserve', 'abort', 'delete']);
  await assert.rejects(() => db.query('delete from erp_finance.file'), /erp_attachment_no_delete/);
});

test('211 a lançamento de caixa has its own files; an excluded owner is read only and unknown owners are not found', async () => {
  const sent = await send(base('lancamentos', entry.id), note, 'text/plain', 'recibo.txt');
  assert.equal(sent.status, 200); assert.equal(sent.value.attachment.owner_kind, 'cash_entry');
  assert.equal((await call(base('lancamentos', randomUUID()))).status, 404);
  assert.equal((await call(base('contas', entry.id))).status, 404, 'a lançamento is not a conta');
  await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_delete', p_data: { id: title.id, expected_version: title.version } });
  assert.equal((await call(base(), 'GET', undefined, users.consulta)).status, 200, 'an excluded conta keeps its files for consulta');
  assert.equal((await send(base(), note, 'text/plain', 'depois.txt')).status, 409, 'but receives no new file');
  for (const path of [`/v1/anexos-financeiro/titulos/${title.id}`, `/v1/anexos-financeiro/contas/x`, `/v1/anexos-financeiro/contas/${title.id}/${randomUUID()}/apagar`]) assert.equal(financeFileRoute(path), null, path);
  assert.equal((await call(`${base('lancamentos', entry.id)}?x=1`)).status, 400);
  assert.equal((await call(base('lancamentos', entry.id), 'PUT', note, users.financeiro, 'text/plain')).status, 405);
});
