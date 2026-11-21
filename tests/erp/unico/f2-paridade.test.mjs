import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { ERP_PART_KEYS, normalizeErpParts } from "../../../src/erp/parts.ts";
import { ERP_DEVIATIONS, ERP_PART_BEHAVIORS } from "../../../src/erp/schema/deviations.ts";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { dualFixture } from "../harness/dual-fixture.mjs";

test("catálogo condicional é informativo, separado do oráculo e aponta testes existentes", () => {
  assert.equal(new Set(ERP_PART_BEHAVIORS.map(b => b.id)).size, ERP_PART_BEHAVIORS.length);
  for (const b of ERP_PART_BEHAVIORS) {
    assert.ok(b.rule && b.disabled_when && b.reason && b.tests.length, b.id);
    assert.ok(!ERP_DEVIATIONS.some(d => d.id === b.id), b.id);
    for (const key of ["kind", "fn", "oracle", "value", "applied"]) assert.ok(!(key in b), `${b.id}/${key}`);
    for (const reference of b.tests)
      assert.ok(readFileSync(reference.file, "utf8").includes(reference.test), `${b.id}: ${reference.file} / ${reference.test}`);
  }
});

test("ausência e nove partes ligadas produzem os mesmos DTOs, erros e tabelas", t => {
  const stamp = Date.now();
  t.mock.method(Date, "now", () => stamp);
  let serial = 0;
  t.mock.method(crypto, "randomUUID", () => `22222222-2222-4222-8222-${String(++serial).padStart(12, "0")}`);
  const admin = "11111111-1111-4111-8111-111111111111";
  const actor = { user_id: admin, erp_role: "admin", name: "Admin", email: null, verified_factor: false, session_id: null, aal: "aal1", is_agent: false };
  const run = explicit => {
    serial = 0;
    const lite = freshLite(), db = nodeDriver(lite), clock = new Clock();
    try {
      const results = [], env = { identity: { actor, people: [actor] }, ...(explicit ? { parts: normalizeErpParts() } : {}) };
      const rpc = (name, args = {}) => {
        const result = callRpc(db, name, { p_user_id: admin, ...args }, clock, env);
        results.push(result); return result;
      };
      const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: data }).record;
      const contact = catalog("contacts", { name: "Cliente da paridade" });
      const product = catalog("products", { name: "Produto da paridade", kind: "P", format: "S", unit: "UN", price: "12" });
      const args = { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_body: {
        date: "2026-11-19", contact_id: contact.id,
        items: [{ product_id: product.id, description: product.name, unit: "UN", quantity: "1", unit_price: "12" }],
        installments: [{ due_date: "2026-12-19", amount: "12" }],
      } };
      const doc = rpc("erp_document_save", args).document;
      assert.equal(rpc("erp_document_save", args).replayed, true);
      rpc("erp_document_transition", { p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: crypto.randomUUID(), p_status: "verified", p_reason: "Confirmação explícita" });
      const home = rpc("erp_home_overview", { p_period: "hoje", p_from: null, p_to: null });
      assert.ok(!("unavailable_parts" in home));
      assert.throws(() => rpc("erp_document_transition", { p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: crypto.randomUUID(), p_status: "fulfilled", p_reason: "Versão antiga" }), e => {
        assert.equal(e.message, "erp_document_version_conflict");
        results.push({ code: e.code, message: e.message });
        return true;
      });
      const tables = lite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return { results, tables: Object.fromEntries(tables.map(({ name }) => {
        const statement = lite.prepare(`SELECT * FROM "${name}"`); statement.setReadBigInts(true);
        return [name, statement.all()];
      })) };
    } finally { lite.close(); }
  };
  // + Produção (production) e Expedição (shipping): onze partes.
  // + Contratos (contracts): doze partes.
  assert.equal(ERP_PART_KEYS.length, 12);
  assert.deepEqual(run(true), run(false));
});

test("diferencial todo ligado conserva cadastro, documento, confirmação e replay no Postgres", async t => {
  const f = await dualFixture(); t.after(() => f.close());
  const contact = await f.catalog("contacts", { name: "Paridade fase 2" });
  const product = await f.catalog("products", { name: "Produto", kind: "P", format: "S", unit: "UN", price: "10" });
  const args = { p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: "2026-11-19", contact_id: contact.id, items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "1", unit_price: "10" }],
    installments: [{ due_date: "2026-12-19", amount: "10" }],
  } };
  const doc = (await f.rpc("erp_document_save", args)).document;
  assert.equal((await f.rpc("erp_document_save", args)).replayed, true);
  await f.rpc("erp_document_transition", { p_user_id: f.users.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version,
    p_command_id: randomUUID(), p_status: "verified", p_reason: "Confirmação explícita" });
  for (const role of ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"]) {
    const home = await f.rpc("erp_home_overview", { p_user_id: f.users[role], p_period: "hoje", p_from: null, p_to: null });
    assert.ok(!("unavailable_parts" in home));
  }
  assert.ok(f.stats.ported >= 11);
  assert.ok(f.stats.compared_tables > 0);
});
