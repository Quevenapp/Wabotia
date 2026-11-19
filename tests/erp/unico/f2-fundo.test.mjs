import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { Clock, todaySaoPaulo } from "../../../src/erp/engine/time.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { applyErpPartsSnapshot, currentErpParts } from "../../../src/erp/parts-control.ts";
import { runRound, claimEligibleTask, releaseBlockedTask, nextWake } from "../../../src/erp/scheduler/dispatch.ts";
import { nextHour } from "../../../src/erp/scheduler/routines.ts";
import { NOTIFICATION_TYPES, notificationDigest, notificationEnabled } from "../../../src/erp/domains/preferences/home-notifications.ts";
import { notificationDigestFor, notifyMember } from "../../../src/erp/domains/preferences/notification-units.ts";

const all = normalizeErpParts();
const realNow = Date.now;
let now, lite, db, clock, sequence;
beforeEach(() => {
  now = Date.parse("2026-11-19T15:20:00Z");
  Date.now = () => now; sequence = 0;
  lite = freshLite(); db = nodeDriver(lite); clock = new Clock();
});
afterEach(() => { Date.now = realNow; lite.close(); });
const round = (options = {}) => runRound(db, { parts: all, routines: [], clock, now: () => now, elapsed: () => 0, yieldTurn: async () => {}, ...options });
const task = (payload = {}, purpose = "notifications_generate") => {
  const id = randomUUID();
  const due = String(BigInt(now - 1000 + sequence++) * 1000n);
  db.exec(`INSERT INTO erp_platform__task(id,purpose,operation_id,payload,next_attempt_at,created_at)
    VALUES(?,?,?,?,?,?)`, id, purpose, id, JSON.stringify(payload), due, due);
  return id;
};
const row = id => db.exec('SELECT status,attempts,error_code,lease_token,started_at,progress FROM erp_platform__task WHERE id=?', id).rows[0];
const attempts = id => db.exec('SELECT * FROM erp_platform__task_attempt WHERE task_id=?', id).rows;
const snapshot = (revision, parts, expires = now + 360_000) => ({ profile: "area", revision, expires_at: expires, parts });
function kv() {
  const data = new Map();
  const store = { get: async key => data.get(key), put: async (key, value) => { data.set(key, structuredClone(value)); }, transaction: async fn => fn(store) };
  return store;
}

test("KV: revisão antiga não reativa, mapa da mesma revisão é imutável, renovação só estende e expiração fecha", async () => {
  const storage = kv();
  await applyErpPartsSnapshot(storage, "area", snapshot("2", all, now + 60_000));
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot("1", all)), { code: "erp_parts_stale" });
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot("2", normalizeErpParts({ finance: false }))), { code: "erp_parts_stale" });
  now += 30_000;
  await applyErpPartsSnapshot(storage, "area", snapshot("2", all));
  assert.equal((await currentErpParts(storage, "area")).expires_at, now + 360_000);
  await applyErpPartsSnapshot(storage, "area", snapshot("2", all, now + 10_000));
  assert.equal((await currentErpParts(storage, "area")).expires_at, now + 360_000);
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot("3", all, now + 360_001)), { code: "erp_parts_unavailable" });
  await assert.rejects(applyErpPartsSnapshot(storage, "outra", snapshot("3", all)), { code: "erp_parts_unavailable" });
  now += 360_000;
  assert.equal(await currentErpParts(storage, "area"), null);
  await applyErpPartsSnapshot(storage, "area", snapshot("3", normalizeErpParts({ customers: false })));
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot("2", all)), { code: "erp_parts_stale" });
});

test("Base desligada ou estado ausente não toca SQLite nem agenda continuação", async () => {
  const noDb = { exec: () => assert.fail("não pode consultar SQLite"), transaction: () => assert.fail("não pode executar") };
  for (const options of [{ parts: normalizeErpParts({ customers: false }) }, { parts: all, readParts: async () => null }]) {
    const result = await runRound(noDb, options);
    assert.deepEqual(result, { units: 0, more: false, nextWake: null, routines: [], tasks: [], fileDue: false });
  }
});

test("seleção e claim filtram payload persistido; tarefa bloqueada não esconde a elegível da mesma finalidade", async () => {
  const finance = task({ type: "contas_pagar_atrasadas" });
  const sales = task({ type: "proximo_contato" });
  const ran = [];
  const result = await round({ parts: normalizeErpParts({ finance: false }), handlers: {
    notifications_generate: (_db, t, _clock, parts) => { ran.push(t.id); assert.equal(parts.finance, false); return {}; },
  } });
  assert.deepEqual(ran, [sales]);
  assert.deepEqual([row(finance).status, row(finance).attempts, attempts(finance).length], ["queued", 0, 0]);
  assert.equal(row(sales).status, "done");
  assert.equal(result.nextWake, null);
  const again = await round({ parts: normalizeErpParts({ finance: false }) });
  assert.deepEqual([again.units, again.more, again.nextWake, again.fileDue], [0, false, null, false]);
});

test("desligamento após claim devolve à espera sem tentativa, erro, progresso ou efeito; outra parte continua", async () => {
  const finance = task({ type: "contas_receber_atrasadas" });
  const sales = task({ type: "proximo_contato" });
  let parts = all;
  const ran = [];
  const result = await round({ readParts: async () => parts,
    yieldTurn: async () => { parts = normalizeErpParts({ finance: false }); },
    handlers: { notifications_generate: (_db, t) => { ran.push(t.id); return {}; } },
  });
  assert.deepEqual(ran, [sales]);
  assert.ok(result.tasks.some(t => t.id === finance && t.outcome === "waiting"));
  assert.deepEqual({ ...row(finance) }, { status: "queued", attempts: 0, error_code: null, lease_token: null, started_at: null, progress: "{}" });
  assert.deepEqual(attempts(finance), []);
  assert.equal(result.more, false); assert.equal(result.nextWake, null);
  await round({ handlers: { notifications_generate: (_db, t) => { ran.push(t.id); return {}; } } });
  assert.deepEqual(ran, [sales, finance]);
  assert.equal(row(finance).attempts, 1);
});

test("claim de parte ligada não expira posse de parte bloqueada, mesmo na última tentativa", async () => {
  const blocked = task({ type: "contas_pagar_atrasadas" });
  db.exec("UPDATE erp_platform__task SET max_attempts=1 WHERE id=?", blocked);
  const held = claimEligibleTask(db, randomUUID(), ["notifications_generate"], clock, all);
  assert.equal(held.id, blocked);
  now += 360_000;
  const allowed = task({ type: "cliente_visitado" });
  await round({ parts: normalizeErpParts({ finance: false }) });
  assert.equal(row(allowed).status, "done");
  assert.equal(row(blocked).status, "running");
  assert.equal(attempts(blocked)[0].outcome, null);
  releaseBlockedTask(db, held);
  assert.equal(row(blocked).attempts, 0);
  assert.equal(row(blocked).status, "queued");
});

test("expiração entre unidades preserva transação já encerrada e não executa a próxima", async () => {
  const storage = kv();
  await applyErpPartsSnapshot(storage, "area", snapshot("1", all, now + 1000));
  let ran = 0;
  const routine = { id: "teste.unidades", block: "erp", next: nextHour, step: ({ db, parts }) => {
    assert.equal(parts.customers, true);
    db.exec("INSERT INTO erp_meta(key,value) VALUES(?,?)", `unidade-${++ran}`, "concluída");
    return "more";
  } };
  db.exec("CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY,value TEXT)");
  const result = await round({ routines: [routine], readParts: async () => (await currentErpParts(storage, "area"))?.parts ?? null,
    yieldTurn: async () => { now += 1000; },
  });
  assert.equal(ran, 1);
  assert.equal(db.exec("SELECT count(*) n FROM erp_meta").rows[0].n, 1);
  assert.equal(result.nextWake, null); assert.equal(result.more, false);
});

test("parte desligada entre unidades não impede rotina de outra parte e não gera wake vazio", async () => {
  let parts = all, fiscal = 0, base = 0;
  const result = await round({ readParts: async () => parts, yieldTurn: async () => { parts = normalizeErpParts({ fiscal: false }); },
    routines: [
      { id: "fiscal", block: "erp-fiscal", next: nextHour, step: () => { fiscal++; return "more"; } },
      { id: "base", block: "erp", next: nextHour, step: () => { base++; return "done"; } },
    ],
  });
  assert.equal(fiscal, 1); assert.equal(base, 1);
  assert.equal(result.more, false); assert.equal(result.nextWake, nextHour(now));
  assert.equal(nextWake(db, [{ id: "fiscal", block: "erp-fiscal" }], parts, [], now), null);
});

test("tipos indisponíveis são filtrados antes de consultas, preferências e gravação, inclusive no executor fracionado", () => {
  const parts = normalizeErpParts({ finance: false, stock: false, products: false, sales: false, fiscal: false });
  const noDb = { exec: () => assert.fail("tipo desligado não consulta"), transaction: () => assert.fail("tipo desligado não grava") };
  for (const type of NOTIFICATION_TYPES.filter(t => t !== "cliente_visitado")) {
    assert.equal(notificationEnabled(type, parts), false);
    assert.deepEqual(notificationDigest(noDb, type, "2026-11-19", 0n, parts), { quantity: 0, amount: null });
    assert.deepEqual(notificationDigestFor(noDb, type, "2026-11-19", parts), { quantity: 0, amount: null });
    assert.equal(notifyMember(noDb, clock, randomUUID(), type, "2026-11-19", { quantity: 9, amount: 100n }, parts), false);
  }
  assert.equal(notificationEnabled("cliente_visitado", parts), true);
  assert.equal(notificationEnabled("desconhecido", all), false);
});

test("RPC de alertas passa parts: não consulta Financeiro/Estoque desligados e calcula Vendas atual sem recuperar dias", async () => {
  const admin = randomUUID();
  const identity = { actor: { user_id: admin, erp_role: "admin", name: "Admin", email: null, is_agent: false,
    aal: "aal1", session_id: null, verified_factor: false }, people: null };
  identity.people = [identity.actor];
  const rpc = (name, args) => callRpc(db, name, { p_user_id: admin, ...args }, clock, { parts: all, identity });
  const contact = rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Cliente atual" } }).record;
  const product = rpc("erp_catalog_save", { p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Serviço", unit: "UN", kind: "S", format: "S" } }).record;
  rpc("erp_document_save", { p_kind: "sales_proposals", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: todaySaoPaulo(), contact_id: contact.id, next_contact: todaySaoPaulo(), items: [{ product_id: product.id, description: product.name, quantity: "1", unit_price: "10.00", unit: "UN" }] } });
  const pending = task({ day: "2020-01-01" });
  const original = db.exec;
  db.exec = (sql, ...args) => {
    assert.doesNotMatch(sql, /FROM\s+"erp_(finance|stock)__/i, "nenhuma consulta ao domínio desligado");
    return original(sql, ...args);
  };
  const result = await round({ parts: normalizeErpParts({ finance: false, stock: false }) });
  assert.equal(result.tasks[0].outcome, "done"); assert.equal(row(pending).attempts, 1);
  const alerts = db.exec("SELECT type,day,quantity FROM erp_home__notification").rows;
  assert.ok(alerts.some(n => n.type === "proximo_contato" && n.day === todaySaoPaulo() && n.quantity === 1));
  assert.ok(alerts.every(n => n.day === todaySaoPaulo()));
});

test("expiração depois do claim devolve a tarefa sem falha; próximo wake ignora requisito desconhecido", async () => {
  const storage = kv();
  await applyErpPartsSnapshot(storage, "area", snapshot("1", all, now + 1));
  const id = task();
  const result = await round({ readParts: async () => (await currentErpParts(storage, "area"))?.parts ?? null,
    yieldTurn: async () => { now++; }, handlers: { notifications_generate: () => assert.fail("autorização venceu") },
  });
  assert.equal(row(id).status, "queued"); assert.equal(row(id).attempts, 0);
  assert.deepEqual(attempts(id), []);
  assert.deepEqual([result.more, result.nextWake, result.fileDue], [false, null, false]);
  db.exec("UPDATE erp_platform__task SET payload=? WHERE id=?", JSON.stringify({ type: "tipo_desconhecido" }), id);
  const blocked = await round({ maxUnits: 0 });
  assert.deepEqual([blocked.units, blocked.more, blocked.nextWake], [0, false, null]);
});

test("devolução por suspensão não desfaz posse já substituída por outro executor", () => {
  const id = task();
  const held = claimEligibleTask(db, randomUUID(), ["notifications_generate"], clock, all);
  const other = randomUUID();
  db.exec("UPDATE erp_platform__task SET lease_token=? WHERE id=?", other, id);
  releaseBlockedTask(db, held);
  assert.equal(row(id).status, "running"); assert.equal(row(id).lease_token, other);
  assert.equal(row(id).attempts, 1); assert.equal(attempts(id).length, 1);
});
