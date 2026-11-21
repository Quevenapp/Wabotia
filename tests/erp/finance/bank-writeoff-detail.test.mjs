// Vinki (junção): a conta cancelada pela declaração de boleto baixado no
// banco (title_bank_writeoff) mostra no detalhe (erp_finance_title_detail)
// quem declarou, quando e o motivo, lidos da auditoria já gravada; a rota da
// erp-api repassa o campo e diz o motivo conhecido da recusa do cancelamento.
// Sem rede: motor SQLite da fatia comercial (tests/erp/comnfe/fixtures.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_DATE, COM1_PEOPLE } from "../comnfe/fixtures.mjs";
import { executeFinanceRoute, financeRefusal, parseFinanceRoute } from "../../../src/erp/fagoo/workers/erp-api/src/finance.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

const error = message => e => e.message === message;
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];
const title = (f, id) => row(f, "SELECT * FROM erp_finance__title WHERE id=?", id);
const detail = (f, id, env = {}) => f.rpc("erp_finance_title_detail", { p_id: id }, env);
const REASON = "Boleto baixado no internet banking em 20/11, protocolo 123";

function fixture(t) {
  const f = com1Fixture(t);
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas do ensaio da baixa" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa do ensaio da baixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  return f;
}
const looseTitle = f => title(f, f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
  kind: "receivable", contact_id: f.customer.id, category_id: f.category.id, description: "Conta avulsa com boleto", issued_on: COM1_DATE,
  total_cents: "10000", installments: [{ due_on: "2026-12-19", amount_cents: "10000" }] } }).items[0].id);
function bankCollection(f, titleId) {
  const remittance = randomUUID(), at = String(f.clock.next()), profile = randomUUID();
  f.db.exec("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", profile, f.account.id, "{}", "{}", "baixa-banco", 10, at, at);
  f.db.exec("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,state,snapshot,actor,created_at,purpose) VALUES(?,?,?,?,?,?,?,?,?)", remittance, profile, 1, COM1_DATE, "ready", "{}", COM1_PEOPLE.admin.user_id, at, "operational");
  const id = randomUUID();
  f.db.exec("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES(?,?,?,?,?,?,?,?)", id, titleId, profile, remittance, "controle-1", "DOC-1", "123451", "{}");
  return { id, remittance };
}
const writeoff = (f, t, command = randomUUID()) => f.rpc("erp_finance_execute", { p_command_id: command, p_action: "title_bank_writeoff",
  p_data: { id: t.id, expected_version: t.version, reason: REASON } });

test("o detalhe da conta cancelada pela declaração traz quem declarou, quando e o motivo", async t => {
  const f = fixture(t), open = looseTitle(f), billing = bankCollection(f, open.id);
  // Antes da declaração a chave não existe (aditivo: as contas comuns respondem como antes).
  assert.equal("bank_writeoff" in detail(f, open.id), false);
  assert.throws(() => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_cancel", p_data: { id: open.id, expected_version: open.version, note: "Cancelar" } }), error("erp_finance_billed_locked"));
  const done = writeoff(f, open);
  const read = detail(f, open.id);
  assert.equal(read.record.cancelled, true);
  const profile = row(f, "SELECT name FROM erp_access__profile WHERE user_id=?", COM1_PEOPLE.admin.user_id);
  assert.deepEqual(read.bank_writeoff, {
    billing_title_id: billing.id, remittance_id: billing.remittance, reason: REASON, declared_by: COM1_PEOPLE.admin.user_id,
    declared_by_name: profile?.name ?? `Usuário ${COM1_PEOPLE.admin.user_id.slice(0, 8)}`, declared_at: done.bank_writeoff.declared_at,
  });
  assert.ok(Number.isFinite(Date.parse(read.bank_writeoff.declared_at)));
  // Lida da auditoria: consultar não escreve e vale para o papel de consulta.
  const audits = row(f, "SELECT count(*) n FROM erp_finance__audit").n;
  assert.deepEqual(detail(f, open.id, { role: "consulta" }).bank_writeoff, read.bank_writeoff);
  assert.equal(row(f, "SELECT count(*) n FROM erp_finance__audit").n, audits);
  // Com a Cobrança bancária desligada a declaração continua no detalhe (é do Financeiro) e o boleto some.
  const off = detail(f, open.id, { parts: { billing: false } });
  assert.deepEqual(off.bank_writeoff, read.bank_writeoff);
  assert.ok(off.unavailable_parts.includes("billing"));

  // A rota da erp-api repassa a declaração, só em conta cancelada.
  const route = await parseFinanceRoute(new Request(`https://erp.invalid/v1/financeiro/titles/${open.id}/detalhe`));
  const projected = await executeFinanceRoute(route, { userId: COM1_PEOPLE.admin.user_id, rpc: () => read });
  assert.deepEqual(projected.bank_writeoff, read.bank_writeoff);
  await assert.rejects(() => executeFinanceRoute(route, { userId: COM1_PEOPLE.admin.user_id, rpc: () => ({ ...read, record: { ...read.record, cancelled: false } }) }));
  await assert.rejects(() => executeFinanceRoute(route, { userId: COM1_PEOPLE.admin.user_id, rpc: () => ({ ...read, bank_writeoff: { ...read.bank_writeoff, declared_by: "x" } }) }));
  const plain = looseTitle(f), plainRoute = await parseFinanceRoute(new Request(`https://erp.invalid/v1/financeiro/titles/${plain.id}/detalhe`));
  assert.equal("bank_writeoff" in await executeFinanceRoute(plainRoute, { userId: COM1_PEOPLE.admin.user_id, rpc: () => detail(f, plain.id) }), false);
});

test("a conta cancelada pelo cancelamento comum não traz declaração", t => {
  const f = fixture(t), plain = looseTitle(f);
  f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_cancel", p_data: { id: plain.id, expected_version: plain.version, note: "Cancelamento comum" } });
  const read = detail(f, plain.id);
  assert.equal(read.record.cancelled, true);
  assert.equal("bank_writeoff" in read, false);
});

test("pela erp-api: o cancelamento recusado diz billed_locked, a declaração cancela e o detalhe mostra quem, quando e o motivo", async t => {
  const f = fixture(t), open = looseTitle(f), billing = bankCollection(f, open.id), admin = COM1_PEOPLE.admin.user_id;
  const settings = { SUPABASE_URL: "https://erp.wabotia.invalid", SUPABASE_DEPLOYMENT: "self-hosted", SUPABASE_SERVICE_ROLE_KEY: "local-test", ALLOWED_ORIGINS: "" };
  const handler = createHandler({ fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") return Response.json({ id: new Headers(init.headers).get("authorization").slice(7), app_metadata: {} });
    assert.match(path, /^\/rest\/v1\/rpc\/erp_/);
    try { return Response.json(f.rpc(path.split("/").at(-1), JSON.parse(init.body))); }
    catch (e) { return Response.json({ code: e.code, message: e.message }, { status: 400 }); }
  } });
  const call = async (path, body) => { const response = await handler(new Request(`https://erp.example${path}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${admin}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), settings);
    return { status: response.status, body: await response.json() }; };
  const refused = await call("/v1/financeiro/actions/title_cancel", { command_id: randomUUID(), data: { id: open.id, expected_version: open.version, note: "Cancelar" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "ERP_CONFLICT");
  assert.equal(refused.body.error.field, "billed_locked");
  assert.doesNotMatch(JSON.stringify(refused.body), /erp_finance_/, "a mensagem do SQL não sai");
  const stale = await call("/v1/financeiro/actions/title_bank_writeoff", { command_id: randomUUID(), data: { id: open.id, expected_version: open.version + 5, reason: REASON } });
  assert.deepEqual([stale.status, stale.body.error.field], [409, "version_conflict"]);
  const done = await call("/v1/financeiro/actions/title_bank_writeoff", { command_id: randomUUID(), data: { id: open.id, expected_version: open.version, reason: REASON } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.record.cancelled, true);
  assert.equal(done.body.bank_writeoff.billing_title_id, billing.id);
  const again = await call("/v1/financeiro/actions/title_bank_writeoff", { command_id: randomUUID(), data: { id: open.id, expected_version: open.version + 1, reason: REASON } });
  assert.deepEqual([again.status, again.body.error.field], [409, "cancelled_title"]);
  const read = await call(`/v1/financeiro/titles/${open.id}/detalhe`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.bank_writeoff, { ...detail(f, open.id).bank_writeoff });
  assert.equal(read.body.bank_writeoff.reason, REASON);
  assert.equal(read.body.bank_writeoff.declared_by, admin);
  // Outra rota do Financeiro não ganha field.
  const plain = looseTitle(f), settle = await call("/v1/financeiro/actions/settle", { command_id: randomUUID(), data: { id: plain.id, expected_version: plain.version + 9,
    account_id: f.account.id, posted_on: COM1_DATE, principal_cents: "100" } });
  assert.equal(settle.status, 409);
  assert.equal("field" in settle.body.error, false);
});

test("a recusa conhecida do cancelamento e da declaração vira field; as outras rotas e mensagens não", async () => {
  const id = randomUUID(), post = async (action, data) => parseFinanceRoute(new Request(`https://erp.invalid/v1/financeiro/actions/${action}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command_id: randomUUID(), data }) }));
  const cancel = await post("title_cancel", { id, expected_version: 1, note: "Cancelar" });
  const declare = await post("title_bank_writeoff", { id, expected_version: 1, reason: REASON });
  const settle = await post("settle", { id, expected_version: 1, account_id: randomUUID(), posted_on: COM1_DATE, principal_cents: "100" });
  assert.equal(financeRefusal(cancel, "erp_finance_billed_locked"), "billed_locked");
  for (const [message, field] of [["erp_finance_bank_writeoff_not_applicable", "bank_writeoff_not_applicable"], ["erp_finance_version_conflict", "version_conflict"],
    ["erp_finance_permission_denied", "permission_denied"], ["erp_finance_access_denied", "access_denied"], ["erp_finance_cancelled_title", "cancelled_title"],
    ["erp_finance_active_payments", "active_payments"], ["erp_finance_reason_required", "reason_required"], ["erp_finance_invalid_text", "reason_required"]])
    assert.equal(financeRefusal(declare, message), field, message);
  assert.equal(financeRefusal(settle, "erp_finance_version_conflict"), null, "só cancelamento e declaração");
  assert.equal(financeRefusal(declare, "erp_finance_algo_desconhecido"), null);
  assert.equal(financeRefusal(declare, undefined), null);
  // O field cabe no formato que o painel aceita (real-access.ts: [a-z_]{1,40}).
  for (const message of ["erp_finance_billed_locked", "erp_finance_bank_writeoff_not_applicable", "erp_finance_command_conflict"]) assert.match(financeRefusal(declare, message), /^[a-z_]{1,40}$/);
});
