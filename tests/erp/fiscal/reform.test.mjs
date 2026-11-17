// Classificação de IBS/CBS da reforma (structural.ts, reforma-classificacao):
// tabelas e RPCs só do motor, sem par no oráculo. A natureza e o produto vêm
// pela fixture dupla (RPCs portados, nos dois motores); os RPCs da reforma
// rodam só no SQLite (callRpc), com as próprias asserções.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { resolveReformClass } from "../../../src/erp/domains/fiscal/reform.ts";

let f;
let product;
let other;
let natures;
const code = (expected) => (error) => error.code === expected;
const lite = (name, args) => callRpc(f.driver, name, args, f.clock);
const get = (nature, user = f.users.consulta) => lite("erp_fiscal_reform_nature_class_get", { p_user_id: user, p_nature_id: nature });
const save = (nature, rules, expected, patch = {}) =>
  lite("erp_fiscal_reform_nature_class_save", {
    p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_nature_id: nature, p_expected_hash: expected, p_rules: rules, ...patch,
  });
const createNature = async (description) =>
  (
    await f.rpc("erp_fiscal_nature_execute", {
      p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "create",
      p_data: { nature: { description, direction: "1", crt: "1", rules: [{ tax: "icms", data: { situation: "102" } }] } },
    })
  ).nature;

before(async () => {
  f = await dualFixture();
  product = await f.catalog("products", { name: "Produto da reforma", unit: "UN", kind: "P", price: "1", ncm: "84713012" });
  other = await f.catalog("products", { name: "Outro produto da reforma", unit: "UN", kind: "P", price: "1", ncm: "22030000" });
  // Tudo o que passa pela fixture dupla vem antes: os RPCs da reforma gravam recibo e auditoria só no SQLite.
  natures = [await createNature("Venda com IBS/CBS"), await createNature("Venda para a resolução")];
});
after(() => f?.close());

test("reforma: lista vazia, gravação pelo hash, repetição pelo comando e as recusas", async () => {
  const nature = natures[0];
  const empty = get(nature.id);
  assert.deepEqual([empty.rules, empty.writable], [[], false]);
  const rules = [
    { cst: "000", cclasstrib: "000001" },
    { product_scope: "ncm", ncms: ["8471", "84"], cst: "200", cclasstrib: "200030" },
    { product_scope: "products", product_ids: [product.id], cst: "410", cclasstrib: "410004" },
  ];
  const command = randomUUID();
  const saved = save(nature.id, rules, empty.expected_hash, { p_command_id: command });
  assert.deepEqual(saved.rules.map((r) => [r.position, r.product_scope, r.cst]), [[1, "any", "000"], [2, "ncm", "200"], [3, "products", "410"]]);
  assert.deepEqual(saved.rules[1].ncms, ["84", "8471"]);
  assert.equal(save(nature.id, rules, empty.expected_hash, { p_command_id: command }).replayed, true);
  assert.throws(() => save(nature.id, rules, empty.expected_hash), code("40001"), "hash vencido");
  const current = get(nature.id, f.users.admin);
  assert.deepEqual([current.expected_hash, current.writable], [saved.expected_hash, true]);
  assert.equal(f.driver.exec(`SELECT count(*) n FROM "erp_fiscal_invoices__audit" WHERE entity_id=? AND action='reform_class'`, nature.id).rows[0].n, 1);
  for (const [bad, c] of [
    [[{ cst: "00", cclasstrib: "000001" }], "22023"],
    [[{ cst: "000", cclasstrib: "1" }], "22023"],
    [[{ cst: "000", cclasstrib: "000001" }, { cst: "001", cclasstrib: "000001" }], "22023"],
    [[{ product_scope: "ncm", ncms: [], cst: "000", cclasstrib: "000001" }], "22023"],
    [[{ product_scope: "ncm", ncms: ["123"], cst: "000", cclasstrib: "000001" }], "22023"],
    [[{ product_scope: "products", product_ids: [randomUUID()], cst: "000", cclasstrib: "000001" }], "22023"],
    [[{ product_scope: "groups", group_ids: [randomUUID()], cst: "000", cclasstrib: "000001" }], "22023"],
    [[{ ncms: ["84"], cst: "000", cclasstrib: "000001" }], "22023"],
    [[{ extra: 1, cst: "000", cclasstrib: "000001" }], "22023"],
    [Array.from({ length: 51 }, () => ({ product_scope: "ncm", ncms: ["84"], cst: "000", cclasstrib: "000001" })), "22023"],
    [{}, "22023"],
  ])
    assert.throws(() => save(nature.id, bad, current.expected_hash), code(c), JSON.stringify(bad).slice(0, 80));
  assert.throws(() => save(nature.id, rules, "x"), code("22023"));
  assert.throws(() => save(randomUUID(), [], current.expected_hash), code("P0002"));
  assert.throws(() => save(nature.id, [], current.expected_hash, { p_user_id: f.users.consulta }), code("42501"));
  assert.throws(() => get(nature.id, f.users.vendas), code("42501"));
  assert.throws(() => get(randomUUID()), code("P0002"));
  // Esvaziar a lista também passa pelo hash.
  assert.deepEqual(save(nature.id, [], current.expected_hash).rules, []);
});

test("reforma: produto > exceção por produto > NCM de prefixo mais longo > padrão", async () => {
  const nature = natures[1];
  save(
    nature.id,
    [
      { cst: "000", cclasstrib: "000001" },
      { product_scope: "ncm", ncms: ["84"], cst: "200", cclasstrib: "200001" },
      { product_scope: "ncm", ncms: ["8471"], cst: "200", cclasstrib: "200030" },
      { product_scope: "products", product_ids: [product.id], cst: "410", cclasstrib: "410004" },
    ],
    get(nature.id).expected_hash,
  );
  const resolve = (p) => inTransaction(f.driver, (ctx) => resolveReformClass(ctx.db, { natureId: nature.id, groupId: null, ...p }), f.clock);
  assert.deepEqual(resolve({ productId: product.id, ncm: "84713012" }), { cst: "410", cclasstrib: "410004", nbs: null, source: "nature" });
  assert.deepEqual(resolve({ productId: other.id, ncm: "84713012" }).cclasstrib, "200030");
  assert.deepEqual(resolve({ productId: other.id, ncm: "84990000" }).cclasstrib, "200001");
  assert.deepEqual(resolve({ productId: other.id, ncm: "22030000" }).cclasstrib, "000001");
  assert.equal(resolve({ productId: other.id, ncm: null, natureId: null }), null);
  f.driver.exec(
    `INSERT INTO "erp_fiscal_reform__product_class"(product_id, cst, cclasstrib, nbs, version, updated_by, updated_at) VALUES(?, '011', '011001', '101011100', 1, ?, ?)`,
    product.id, f.users.admin, String(BigInt(Date.now()) * 1000n),
  );
  assert.deepEqual(resolve({ productId: product.id, ncm: "84713012" }), { cst: "011", cclasstrib: "011001", nbs: "101011100", source: "product" });
});
