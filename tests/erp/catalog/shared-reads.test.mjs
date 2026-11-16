// erp_catalog.can_read_stock e erp_catalog.product_cost_at (catalog/cost.ts)
// contra o oráculo: papéis e permissão fina do estoque; o custo vigente no
// fim do dia em São Paulo, nas bordas da meia-noite e com empate de instante.
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { canReadStock, productCostAt } from "../../../src/erp/domains/catalog/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));

test("can_read_stock: papéis e a chave fina suprimentos.controle_estoque", async () => {
  await f.db.query(
    "insert into erp_access.user_control(user_id, permissions, version, updated_at, updated_by) values($1, $2, 1, clock_timestamp(), $3)",
    [f.users.vendas, ["cadastros.produtos"], f.users.admin],
  );
  await f.sync();
  for (const user of [...Object.values(f.users), randomUUID(), null])
    await f.dual("can_read_stock", async () => (await f.db.query("select erp_catalog.can_read_stock($1) v", [user])).rows[0].v, lite((db) => canReadStock(db, user)));
});

test("product_cost_at: custo vigente até a meia-noite seguinte em São Paulo", async () => {
  const product = await f.catalog("products", { name: "Produto com custo", unit: "UN", kind: "P", price: "10" });
  const other = await f.catalog("products", { name: "Produto sem custo", unit: "UN", kind: "P", price: "10" });
  // 2026-03-09 23:59:59 em SP = 2026-03-10T02:59:59Z; empate de instante: vale o id maior.
  for (const [at, cost] of [
    ["2026-03-01T12:00:00Z", "1.5"],
    ["2026-03-10T02:59:59Z", "2.25"],
    ["2026-03-10T03:00:00Z", "3"],
    ["2026-03-10T03:00:00Z", "3.1234567891"],
  ])
    await f.db.query(
      "insert into erp_catalog.product_cost_history(product_id, cost_price, purchase_price, valid_from, source) values($1, $2, null, $3, 'cadastro')",
      [product.id, cost, at],
    );
  await f.sync();
  for (const id of [product.id, other.id, randomUUID(), null])
    for (const day of ["2026-02-28", "2026-03-01", "2026-03-09", "2026-03-10", "2026-12-31", null])
      await f.dual(
        "product_cost_at",
        async () => (await f.db.query("select erp_catalog.product_cost_at($1, $2::date)::text v", [id, day])).rows[0].v,
        lite((db) => productCostAt(db, id, day)),
      );
});
