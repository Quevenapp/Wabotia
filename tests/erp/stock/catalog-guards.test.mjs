// erp_stock.composition_settings, protect_product_unit e
// protect_default_warehouse (stock/public.ts; escritas pela P para o
// Catálogo, dono: Estoque, sessão N) contra o oráculo, pela escrita do
// catálogo (erp_catalog_save / erp_catalog_set_active nos dois motores).
// A composição de kit (erp_stock.composition_apply_values) segue stub:
// o save de produto com composição ligada e kit que usa o produto devolve
// 0A000 no motor; o teste dela fica todo, pendente do Estoque.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { compositionSettings } from "../../../src/erp/domains/stock/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const save = (entity, id, version, data, user = f.users.admin) =>
  f.rpc("erp_catalog_save", { p_user_id: user, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data });
const setActive = (entity, id, version, active) =>
  f.rpc("erp_catalog_set_active", { p_user_id: f.users.admin, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_active: active });
/** Escrita direta sem os gatilhos de imutabilidade (como a semeadura de desvios do harness). */
async function replica(sql, args) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}
async function preference(key, value) {
  await replica(
    `insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values($1,$2::jsonb,1,clock_timestamp(),$3,$4)
     on conflict(key) do update set value=excluded.value,version=erp_preferences.company_value.version+1`,
    [key, JSON.stringify(value), f.users.admin, randomUUID()],
  );
}

test("composition_settings: as três preferências da composição", async () => {
  const read = () =>
    f.dual(
      "composition_settings",
      async () => (await f.db.query("select erp_stock.composition_settings() v")).rows[0].v,
      () => inTransaction(f.driver, (ctx) => compositionSettings(ctx.db)),
    );
  assert.deepEqual(await read(), { update_cost: false, update_weight: false, update_price: false });
  await preference("produtos.composicao_peso", true);
  await preference("produtos.composicao_preco", "true");
  assert.deepEqual(await read(), { update_cost: false, update_weight: true, update_price: false }, "só o booleano true liga");
  await preference("produtos.composicao_peso", false);
});

test("protect_product_unit: unidade e tipo travam depois de um lançamento do produto", async () => {
  const product = await f.catalog("products", { name: "Produto com estoque", unit: "UN", kind: "P", price: "10.0000" });
  const free = await f.catalog("products", { name: "Produto sem estoque", unit: "UN", kind: "P", price: "10.0000" });
  const warehouse = await f.catalog("warehouses", { name: "Depósito do lançamento" });
  await f.rpc("erp_stock_post", {
    p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2024-10-15", p_reason: "Movimento sintético",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "1", expected_version: 0 }], p_reference: null,
  });
  for (const data of [{ unit: "KG" }, { kind: "S" }])
    await assert.rejects(save("products", product.id, 1, data), (e) => e.code === "40001" && e.message === "erp_stock_product_unit_locked");
  assert.equal((await save("products", product.id, 1, { name: "Produto com estoque (renomeado)", unit: "UN" })).record.version, 2);
  assert.equal((await save("products", free.id, 1, { unit: "KG", kind: "S" })).record.unit, "KG", "sem lançamento muda");
});

test("protect_default_warehouse: o depósito padrão não é inativado", async () => {
  const standard = await f.catalog("warehouses", { name: "Depósito padrão sintético" });
  const other = await f.catalog("warehouses", { name: "Depósito comum sintético" });
  await replica(
    `insert into erp_stock.warehouse_default(singleton,warehouse_id,version,updated_at,updated_by,command_id) values(true,$1,1,clock_timestamp(),$2,$3)
     on conflict(singleton) do update set warehouse_id=excluded.warehouse_id,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by,command_id=excluded.command_id`,
    [standard.id, f.users.admin, randomUUID()],
  );
  await assert.rejects(setActive("warehouses", standard.id, 1, false), (e) => e.code === "22023" && e.message === "erp_stock_default_warehouse_inactive");
  assert.equal((await save("warehouses", standard.id, 1, { description: "Continua ativo" })).record.active, true, "alterar sem inativar passa");
  assert.equal((await setActive("warehouses", other.id, 1, false)).record.active, false);
  assert.equal((await setActive("warehouses", other.id, 2, true)).record.active, true);
});

test(
  "composição ligada: preço do componente recalcula o kit",
  { todo: "pendente do Estoque: erp_stock.composition_apply_values é stub; o save do componente com kit devolve 0A000 no motor" },
  async () => {
    const component = await f.catalog("products", { name: "Componente", unit: "UN", kind: "P", format: "S", price: "2.0000" });
    const kit = await f.catalog("products", { name: "Kit", unit: "UN", kind: "P", format: "E", price: "10.0000" });
    await f.rpc("erp_stock_product_compose", {
      p_user_id: f.users.admin, p_id: kit.id, p_expected_version: kit.version, p_command_id: randomUUID(),
      p_data: { name: "Kit" }, p_acknowledged: null,
      p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "components", items: [{ component_id: component.id, quantity: "2" }] },
    });
    await preference("produtos.composicao_preco", true);
    try {
      await save("products", component.id, 1, { price: "3.0000" });
    } finally {
      await preference("produtos.composicao_preco", false);
    }
  },
);
