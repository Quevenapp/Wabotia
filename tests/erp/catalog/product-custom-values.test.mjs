// erp_catalog.product_custom_values (custom_values de productDetailData)
// contra o oráculo: value é TEXT e o jsonb_object_agg devolve cada valor como
// string JSON, mesmo "123", "true" ou uma data (achado da G no product_get).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { productDetailData } from "../../../src/erp/domains/catalog/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

test("custom_values: cada valor sai como texto", async () => {
  const product = await f.catalog("products", { name: "Produto com campos", unit: "UN", kind: "P", format: "S", price: "1" });
  const values = ["Premium", "123", "true", "2026-11-16", "null", '{"a":1}', " espaço "];
  for (const [i, value] of values.entries()) {
    const field = (
      await f.db.query(
        "insert into erp_catalog.custom_field(module,field_type,name,required,width,grouped,active,version,created_by,updated_by) values('products','text',$1,false,'medium',false,true,1,$2,$2) returning id::text v",
        [`Campo ${i}`, f.users.admin],
      )
    ).rows[0].v;
    await f.db.query("insert into erp_catalog.product_custom_value(record_id,field_id,value) values($1,$2,$3)", [product.id, field, value]);
  }
  await f.sync();
  const out = await f.dual(
    "product_custom_values",
    async () => (await f.db.query("select erp_catalog.product_custom_values($1) v", [product.id])).rows[0].v,
    () => inTransaction(f.driver, (ctx) => productDetailData(ctx.db, product.id, false).custom_values),
  );
  assert.deepEqual(Object.values(out).sort(), [...values].sort());
});
