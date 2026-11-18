import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { product, error, readEffects, seed } from "./invoice-fixture.mjs";
let f, p, k, w;
before(async () => {
  f = await dualFixture();
  p = await product(f, { name: "Componente Árvore" });
  k = await product(f, { name: "Kit composição", format: "E" });
  w = await f.catalog("warehouses", { name: "Depósito composição" });
});
after(() => f?.close());
const call = (name, a) => f.rpc("erp_stock_" + name, { p_user_id: f.users.admin, ...a });
const compose = (extra = {}) => ({
  p_id: k.id,
  p_expected_version: k.version,
  p_command_id: randomUUID(),
  p_data: { name: "Kit composição salvo" },
  p_acknowledged: [],
  p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items: [{ component_id: p.id, quantity: "2" }] },
  ...extra,
});
test("composição: salvar, ler, exportar, procurar, lançar, replay, CAS e efeitos", async () => {
  const a = compose(),
    saved = await call("product_compose", a);
  assert.equal(saved.composition.version, 1);
  assert.equal((await call("product_compose", a)).replayed, true);
  await assert.rejects(call("product_compose", { ...a, p_data: { name: "Outro kit" } }), error("erp_stock_composition_conflict", "40001"));
  await assert.rejects(
    call("product_compose", compose({ p_expected_version: saved.record.version })),
    error("erp_stock_composition_version_conflict", "40001"),
  );
  const got = await call("composition_get", { p_product_id: k.id });
  assert.equal(got.items[0].quantity, "2.000000");
  assert.ok((await call("composition_components", { p_query: "árvore" })).items.some((x) => x.id === p.id));
  assert.equal((await call("composition_export", {})).items[0].component_id, p.id);
  const launch = {
    p_command_id: randomUUID(),
    p_kind: "receipt",
    p_product_id: k.id,
    p_warehouse_id: w.id,
    p_quantity: "3",
    p_expected_version: 0,
    p_unit_price: "5.125",
    p_unit_cost: "3",
    p_note: "Montagem",
  };
  const posted = await call("composition_launch", launch);
  assert.equal(posted.lines.length, 2);
  assert.equal((await call("composition_launch", launch)).replayed, true);
  await assert.rejects(call("composition_launch", { ...launch, p_quantity: "4" }), error("erp_stock_launch_conflict", "40001"));
  await assert.rejects(call("composition_launch", { ...launch, p_command_id: randomUUID() }), error("erp_stock_version_conflict", "40001"));
  assert.equal((await call("composition_launches", { p_product_id: k.id })).total, 1);
  await readEffects(f, k.id);
  await readEffects(f, p.id);
});
test("composição: consultas inválidas e papéis", async () => {
  for (const [name, a] of [
    ["composition_get", { p_product_id: null }],
    ["composition_components", { p_query: "" }],
    ["composition_components", { p_query: "x\n" }],
    ["composition_export", { p_offset: -1 }],
    ["composition_export", { p_limit: 501 }],
    ["composition_export", { p_include_deleted: null }],
    ["composition_launches", { p_product_id: k.id, p_limit: 21 }],
  ])
    await assert.rejects(call(name, a), error("erp_stock_invalid_query"));
  for (const name of ["composition_get", "composition_launches"])
    await assert.rejects(call(name, { p_product_id: randomUUID() }), error("erp_stock_product_not_found", "P0002"));
  for (const role of ["admin", "consulta", "vendas", "estoque", "fiscal", "financeiro"]) {
    // O Catálogo decide os papéis das três leituras; f.rpc compara também recusas.
    for (const [name, a] of [
      ["composition_get", { p_product_id: k.id }],
      ["composition_components", { p_query: "Componente" }],
      ["composition_export", {}],
      ["composition_launches", { p_product_id: k.id }],
    ])
      try {
        await call(name, { ...a, p_user_id: f.users[role] });
      } catch (e) {
        assert.equal(e.code, "42501");
      }
  }
  await assert.rejects(call("composition_get", { p_product_id: k.id, p_user_id: f.users.inactive }), (e) => e.code === "42501");
});
test("composição: validação da estrutura e lançamento", async () => {
  for (const patch of [
    { p_command_id: null },
    { p_data: null },
    { p_expected_version: null },
    { p_composition: {} },
    { p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "both", items: [] } },
  ])
    await assert.rejects(call("product_compose", compose(patch)), error("erp_stock_composition_invalid"));
  for (const items of [
    [{ component_id: k.id, quantity: "1" }],
    [{ component_id: p.id, quantity: "0" }],
    [{ component_id: p.id, quantity: 1 }],
    [{ component_id: p.id, quantity: "1", extra: 1 }],
    [
      { component_id: p.id, quantity: "1" },
      { component_id: p.id, quantity: "1" },
    ],
  ])
    await assert.rejects(
      call("product_compose", compose({ p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items } })),
      error("erp_stock_composition_invalid"),
    );
  await assert.rejects(
    call(
      "product_compose",
      compose({ p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items: [{ component_id: randomUUID(), quantity: "1" }] } }),
    ),
    error("erp_stock_composition_component_unavailable"),
  );
  const a = { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: k.id, p_warehouse_id: w.id, p_quantity: "1", p_expected_version: 0 };
  for (const patch of [
    { p_quantity: "0" },
    { p_quantity: "1.0000001" },
    { p_kind: null },
    { p_command_id: null },
    { p_warehouse_id: null },
    { p_expected_version: -1 },
    { p_note: "x\n" },
    { p_kind: "issue", p_unit_cost: "1" },
  ])
    await assert.rejects(call("composition_launch", { ...a, ...patch }), error("erp_stock_launch_invalid"));
  await assert.rejects(call("composition_launch", { ...a, p_unit_price: "x" }), error("erp_stock_price_invalid"));
  await assert.rejects(call("composition_launch", { ...a, p_product_id: p.id }), error("erp_stock_product_unavailable"));
  for (const role of ["consulta", "vendas", "financeiro", "fiscal", "inactive"])
    await assert.rejects(call("composition_launch", { ...a, p_user_id: f.users[role] }), (e) => e.code === "42501");
});
test.todo("erp_stock_item_components e erp_stock_item_components_save: bloqueadas por documents.public.editable (stub)");
test("composição virtual, criação e recalcular valores pelos componentes", async () => {
  const a = {
    p_id: null,
    p_expected_version: 0,
    p_command_id: randomUUID(),
    p_data: { name: "Kit virtual novo", unit: "UN", kind: "P", format: "E", price: "5" },
    p_acknowledged: [],
    p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "components", items: [{ component_id: p.id, quantity: "2" }] },
  };
  const saved = await call("product_compose", a),
    id = saved.record.id;
  assert.equal((await call("product_compose", a)).replayed, true);
  const launch = { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: id, p_warehouse_id: w.id, p_quantity: "1.5", p_expected_version: 0 };
  await assert.rejects(call("composition_launch", { ...launch, p_unit_price: "1" }), error("erp_stock_launch_invalid"));
  await call("composition_launch", launch);
  const got = await call("composition_get", { p_product_id: id });
  assert.equal(got.virtual.quantity, "4.000000");
  await seed(f, "update erp_preferences.definition set default_value='true' where key in ('produtos.composicao_preco','produtos.composicao_peso')");
  const version = (await f.db.query("select version from erp_catalog.record where id=$1", [p.id])).rows[0].version;
  const sync = {
    p_id: p.id,
    p_expected_version: version,
    p_command_id: randomUUID(),
    p_data: { price: "12.345", net_weight: "0.5", gross_weight: "0.6" },
    p_acknowledged: [],
    p_composition: null,
  };
  const changed = await call("product_compose", sync);
  assert.ok(changed.synced.some((x) => x.product_id === id));
  await call("composition_get", { p_product_id: id });
  await readEffects(f, p.id);
});
test("composição: formato, saldo próprio, componente indisponível e precisão", async () => {
  const simple = await product(f),
    other = await product(f, { format: "E" });
  await assert.rejects(
    call("product_compose", { ...compose(), p_id: simple.id, p_expected_version: simple.version, p_data: { name: "Ainda simples" } }),
    error("erp_stock_composition_format_required"),
  );
  const current = await call("composition_get", { p_product_id: k.id });
  await assert.rejects(
    call(
      "product_compose",
      compose({
        p_expected_version: current.product.version,
        p_data: { name: "Kit virtual recusado" },
        p_composition: {
          expected_version: current.composition.version,
          stock_type: "virtual",
          post_mode: "components",
          items: [{ component_id: p.id, quantity: "1" }],
        },
      }),
    ),
    error("erp_stock_composition_has_stock"),
  );
  const a = {
    p_id: other.id,
    p_expected_version: other.version,
    p_command_id: randomUUID(),
    p_data: { name: "Kit fracionário" },
    p_acknowledged: [],
    p_composition: { expected_version: 0, stock_type: "physical", post_mode: "components", items: [{ component_id: p.id, quantity: "0.000001" }] },
  };
  await call("product_compose", a);
  await assert.rejects(
    call("composition_launch", {
      p_command_id: randomUUID(),
      p_kind: "receipt",
      p_product_id: other.id,
      p_warehouse_id: w.id,
      p_quantity: "0.000001",
      p_expected_version: 0,
    }),
    error("erp_stock_composition_quantity_precision"),
  );
});
