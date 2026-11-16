// erp_catalog.allowed, require_access e detail_uuid contra o oráculo (a
// leitura de contatos e produtos passa por erp_access.resources_for_role).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dualFixture, ROLES } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { allowed, detailUuid, requireAccess } from "../../../src/erp/domains/catalog/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));

test("allowed e require_access: papéis, entidades, escrita e a chave .ie", async () => {
  // Sem a chave .ie de produtos para o estoque (controle fino de permissões).
  await f.db.query(
    "insert into erp_access.user_control(user_id, permissions, version, updated_at, updated_by) values($1, $2, 1, clock_timestamp(), $3)",
    [f.users.estoque, ["cadastros.produtos"], f.users.admin],
  );
  await f.sync();
  await assert.rejects(
    f.dual(
      "require_access",
      async () => (await f.db.query("select erp_catalog.require_access($1,'products',true) v", [f.users.estoque])).rows[0].v,
      lite((db) => requireAccess(db, f.users.estoque, "products", true)),
    ),
    (e) => e.code === "42501",
    "sem a chave .ie de produtos, o estoque não inclui nem edita",
  );
  let compared = 0;
  for (const role of [...ROLES.filter((r) => r !== "inactive" && r !== "vendedor"), null, "outro"])
    for (const entity of ["contacts", "products", "warehouses", "sales_orders", null])
      for (const write of [true, false, null]) {
        await f.dual("allowed", async () => (await f.db.query("select erp_catalog.allowed($1,$2,$3) v", [role, entity, write])).rows[0].v, () => allowed(role, entity, write));
        compared++;
      }
  for (const [name, user] of Object.entries(f.users))
    for (const entity of ["contacts", "products", "warehouses", "x"])
      for (const write of [true, false, null]) {
        await f
          .dual(
            "require_access",
            async () => (await f.db.query("select erp_catalog.require_access($1,$2,$3) v", [user, entity, write])).rows[0].v,
            lite((db) => requireAccess(db, user, entity, write)),
          )
          .catch((e) => assert.equal(e.code, "42501"));
        compared++;
      }
  assert.ok(compared > 60);
});

test("detail_uuid", async () => {
  for (const value of [null, "0F8FAD5B-D9CB-469F-A165-70867728950E", "0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5bd9cb469fa16570867728950e", "x", 5, ["a"], { a: 1 }, ""])
    await f
      .dual(
        "detail_uuid",
        async () => (await f.db.query("select erp_catalog.detail_uuid($1::jsonb)::text v", [value === null ? null : JSON.stringify(value)])).rows[0].v,
        () => detailUuid(value),
      )
      .catch((e) => assert.equal(e.code, "22023"));
});
