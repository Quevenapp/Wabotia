import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { api, fixture } from "../harness/f3-local.mjs";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { ERP_SCHEMA_VERSION, WB_ROUTINE_DDL } from "../../../src/erp/schema/migrate.ts";
import { nextHour } from "../../../src/erp/scheduler/routines.ts";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { createCommercialNfeLifecycle } from "../../../src/erp/domains/fiscal/comnfe/lifecycle.ts";
import { commercialNfeReadSlots } from "../../../src/erp/domains/fiscal/comnfe/reads.ts";
import { COM1_TABLES, com1Hash, com1Reference, savePreparation } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";

const now = Date.parse("2026-11-19T12:20:00Z");
function coordinator(f, erp, background = []) {
  const values = new Map(erp ? [["kind", "erp"], ["erp_profile", f.profile], ["erp_parts", {
    profile: f.profile, revision: "1", expires_at: now + 360_000, parts: normalizeErpParts(),
  }]] : [["profile", f.profile]]);
  let alarm = null;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) {
      if (typeof key === "string") values.set(key, value);
      else for (const [k, v] of Object.entries(key)) values.set(k, v);
    },
    async delete(key) { return values.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(at) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    async transaction(run) { return run(storage); },
    transactionSync: run => f.driver.transaction(run),
    sql: {
      get databaseSize() { return Number(f.lite.prepare("PRAGMA page_count").get().page_count) * 4096; },
      exec(sql, ...params) {
        const result = f.driver.exec(sql, ...params);
        return { ...result, toArray: () => result.rows };
      },
    },
  };
  if (erp) {
    // freshLite já aplica o DDL corrente; o hub precisa também do marcador.
    f.lite.exec("CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT");
    f.lite.prepare("INSERT OR REPLACE INTO erp_meta VALUES('schema_version',?)").run(String(ERP_SCHEMA_VERSION));
  }
  const ctx = { storage, id: { name: erp ? `erp:${f.profile}` : f.profile },
    waitUntil: work => background.push(work), getWebSockets: () => [], blockConcurrencyWhile: run => run() };
  return { instance: new api.Coordinator(ctx, f.env), storage };
}

function pendingBling(f) {
  f.driver.exec(`INSERT INTO wb_bling_control(id,revision,generation,authorization_revision,credential_revision,
    collect_enabled,state,account_id,selection,approved_by,approved_at,approval_hash,credential_status,updated_at)
    VALUES(1,1,1,1,1,1,'ready','account',?,?,?,?,'ready',?)`,
    JSON.stringify([{ key: "contacts", selected: true, from: null, to: null }]), f.actor.id, now, "a".repeat(64), now);
}

function pendingNfe(f, t) {
  const fingerprint = com1Hash("cofre simulado"), clock = new Clock();
  t.after(installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: "11222333000181", version: "0.12.0", checked_at: String(BigInt(now) * 1000n), compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao"], series: [{ environment: "homologacao", series: 1 }] })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  const identity = { actor: { user_id: f.actor.id, session_id: f.actor.sessionId, erp_role: "admin",
    name: "Pessoa", email: null, is_agent: false, verified_factor: true, aal: "aal2" }, people: [] };
  identity.people = [identity.actor];
  const environment = { identity, parts: normalizeErpParts() };
  const order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0,
    p_command_id: randomUUID(), p_body: { date: "2026-11-19", contact_id: f.customer.id,
      items: [{ description: "Serviço", unit: "UN", quantity: "1", unit_price: "10" }] } }).document;
  const view = inTransaction(f.driver, ctx => savePreparation(ctx, {
    command_id: randomUUID(), args: { order: order.id }, document_id: order.id,
    expected_document_version: order.version, environment: "homologacao", connection_fingerprint: fingerprint,
    snapshot: {}, tax_sources: {}, commercial_hash: com1Hash(order), source_fingerprint: com1Hash(order),
    body: { ambiente: "homologacao", referencia: com1Reference(order.id, 1) }, calculation: {}, blockers: [],
  }), clock, environment).emission;
  t.after(installCommercialNfeSlots({ ...commercialNfeReadSlots,
    ...createCommercialNfeLifecycle({ sourceFingerprint: (_ctx, revision) => revision.source_fingerprint }) }));
  const bridge = { async call(name, input) {
    return callRpc(f.driver, name, { ...(name === "erp_com1_record" ? {} : { p_user_id: f.actor.id }), p_input: input }, clock,
      name === "erp_com1_record" ? { ...environment, identity: { actor: null, people: null } } : environment);
  } };
  // Uma emissão interrompida existe antes da acordada, com a posse vencida.
  f.rpc("erp_com1_claim", { p_input: { emission_id: view.id, command_id: randomUUID(),
    action: "emit", expected_version: view.version, body_revision: 1, body_hash: view.revision.body_hash,
    connection_fingerprint: fingerprint } });
  const calls = [];
  const service = createCommercialNfeService({}, { bridge, vault: async () => ({ fingerprint, context: {}, provider: {
    async find() {
      calls.push("find");
      return { kind: "nfe", status: "rejected", provider_ref: "nota-simulada", reference: view.reference,
        environment: "homologacao", series: "1", number: 1, access_key: null, protocol: null,
        issued_at: null, authorized_at: null, total: 10, messages: [], xml_available: false, replayed: false };
    },
    async emit() { assert.fail("retomada deve consultar a referência existente"); },
  } }) });
  return { id: view.id, calls, async resume() {
    const current = await bridge.call("erp_com1_get", { emission_id: view.id });
    return service.resume({ emission_id: view.id, command_id: randomUUID(), expected_version: current.version, body_revision: 1 });
  } };
}

test("mesma acordada: coleta pendente não segura a fila F3 nem a retomada NF-e, e operacional vem primeiro", async t => {
  let tick = now - 61_000;
  t.mock.method(Date, "now", () => tick);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("nenhum HTTP real é permitido"); });
  const f = await fixture(t); await f.quote(); f.due();
  const event = f.events().at(-1), fiscal = pendingNfe(f, t);
  tick = now; // A posse fiscal vence pelo relógio, sem alterar recibos imutáveis.
  pendingBling(f);
  const background = [], erp = coordinator(f, true), area = coordinator(f, false, background);
  const errors = [];
  t.mock.method(console, "error", message => errors.push(message));
  let started, release;
  const mounted = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => sql === "SELECT value FROM instance_settings WHERE key='public_origin'"
    ? { async first() { started(); await barrier; return { value: "https://installation.invalid" }; } } : prepare(sql);
  assert.equal(f.delivery(event).state, "pending");
  assert.equal(f.lite.prepare(`SELECT status FROM ${COM1_TABLES.emission} WHERE id=?`).get(fiscal.id).status, "enviando");
  const waking = erp.instance.alarm();
  try {
    await mounted;
    assert.deepEqual(f.lite.prepare("SELECT purpose,status FROM erp_platform__task ORDER BY purpose").all().map(r => ({ ...r })), [
      { purpose: "export_cleanup", status: "queued" }, { purpose: "notifications_generate", status: "done" },
    ]);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM wb_bling_unit").get().n, 0, "coleta adiada após a rodada operacional");
    // O alarme da área drena F3; NF-e retoma por comando explícito, não por
    // rotina automática. Ambos usam o mesmo SQLite ERP durante a espera Bling.
    const [, resumed] = await Promise.all([area.instance.alarm(), fiscal.resume()]);
    await Promise.all(background);
    assert.equal(f.delivery(event).state, "done");
    assert.equal(f.calls.filter(name => name === "erp_module_apply").length, 1);
    assert.equal(resumed.status, "rejeitada");
    assert.deepEqual(fiscal.calls, ["find"]);
    assert.deepEqual(errors, []);
  } finally { release(); await waking; }
  assert.deepEqual(errors, []);
  assert.equal(await erp.storage.getAlarm(), now + 1000, "coleta não adia a limpeza operacional já vencida");
  assert.equal(f.lite.prepare("SELECT count(*) n FROM wb_bling_unit").get().n, 0);
  assert.deepEqual(f.lite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Coordinator ERP com coleta ausente ou desligada não lê D1/R2/HTTP extra", async t => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("HTTP de coleta desligada"); });
  for (const configured of [false, true]) {
    const f = await fixture(t);
    if (configured) f.driver.exec("INSERT INTO wb_bling_control(updated_at) VALUES(?)", now);
    const erp = coordinator(f, true);
    // Mantém as rotinas futuras: esta é uma acordada verdadeiramente ociosa.
    f.lite.exec(WB_ROUTINE_DDL);
    for (const id of ["platform.schedule", "retention"]) f.driver.exec("INSERT INTO wb_routine(id,next_run_us) VALUES(?,?)", id, String(BigInt(nextHour(now)) * 1000n));
    f.env.DB = new Proxy({}, { get() { assert.fail("D1 de coleta desligada"); } });
    f.env.MEDIA = new Proxy({}, { get() { assert.fail("R2 de coleta desligada"); } });
    await erp.instance.alarm();
    assert.equal(await erp.storage.getAlarm(), nextHour(now));
    assert.equal(f.lite.prepare("SELECT count(*) n FROM wb_bling_unit").get().n, 0);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM wb_bling_audit").get().n, 0);
  }
});
