// erp_documents.report_last_purchase_until (documents/public.ts, reportLastPurchaseUntil) contra o oráculo:
// recebimentos com e sem preço no movement_detail (revisão mais nova), entrada sem detalhe (preço pelo
// ledger_document_price), contagem de saldo só com `balances`, estorno fora, saída fora e a data limite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { toScaled } from "../../../src/erp/engine/dec.ts";
import { reportLastPurchaseUntil } from "../../../src/erp/domains/documents/public.ts";

let f, u, p, q, a;
const product = (data = {}) => f.catalog("products", { name: "Produto " + randomUUID(), unit: "UN", kind: "P", format: "S", ...data });
const warehouse = () => f.catalog("warehouses", { name: "Depósito " + randomUUID() });
const post = async (items, kind = "receipt", date = "2024-10-15") =>
  (await f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: date, p_reason: "Movimento " + kind,
    p_items: items, p_reference: "REF-" + kind,
  })).movement.id;
const line = (prod, wh, quantity, expected_version) => ({ product_id: prod.id, warehouse_id: wh.id, quantity, expected_version });
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};

before(async () => {
  f = await dualFixture();
  u = f.users;
  p = await product({ price: "15.5" });
  q = await product({ price: "2" });
  a = await warehouse();
  const m1 = await post([line(p, a, "10", 0)], "receipt", "2024-10-01");
  await post([line(p, a, "-3", 1)], "issue", "2024-10-02");
  const m3 = await post([line(p, a, "4", 2)], "receipt", "2024-10-05");
  const m4 = await post([line(p, a, "1", 3)], "adjustment", "2024-10-06");
  const m5 = await post([line(p, a, "2", 4)], "receipt", "2024-10-08");
  await post([line(q, a, "5", 0)], "receipt", "2024-10-03");
  await seed(
    "insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) values($1,$2,1,'9.99','8.5','Primeira',$3,$4,now()),($5,$2,1,'11.25',null,'Segunda',$3,$6,now()),($5,$2,2,'11.5','10','Revisada',$3,$7,now()),($8,$2,1,'12.75',null,'Contagem',$3,$9,now())",
    [m1, p.id, u.admin, randomUUID(), m3, randomUUID(), randomUUID(), m4, randomUUID()],
  );
  await seed("insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source,created_at) values($1,$2,$3,9,8,'count',now())", [m4, p.id, a.id]);
  // O recebimento de 08/10 é estornado: fica fora.
  await seed(
    "insert into erp_stock.movement(id,kind,occurred_on,reason,reference,actor,command_id,reverses_id,created_at) values(gen_random_uuid(),'reversal','2024-10-09','Estorno','REF',$1,gen_random_uuid(),$2,now())",
    [u.admin, m5],
  );
});
after(() => f?.close());

test("report_last_purchase_until: mesmo preço que o oráculo em cada data, com e sem saldos", async () => {
  const lite = (prod, until, balances) => inTransaction(f.driver, (ctx) => reportLastPurchaseUntil(ctx.db, prod, until, balances));
  const pg = async (prod, until, balances) =>
    (await f.db.query("select erp_documents.report_last_purchase_until($1,$2::date,$3)::text v", [prod, until, balances])).rows[0].v;
  const cases = [];
  for (const prod of [p.id, q.id, randomUUID()])
    for (const until of ["2024-09-30", "2024-10-01", "2024-10-04", "2024-10-05", "2024-10-06", "2024-10-31"])
      for (const balances of [true, false]) cases.push([prod, until, balances]);
  for (const [prod, until, balances] of cases) {
    const want = await pg(prod, until, balances);
    const got = lite(prod, until, balances);
    assert.equal(got, want === null ? null : toScaled(want, 10), `${prod === p.id ? "p" : prod === q.id ? "q" : "x"} ${until} ${balances}`);
  }
  assert.equal(lite(p.id, "2024-10-31", false), toScaled("11.5", 10), "a revisão mais nova do detalhe");
  assert.equal(lite(p.id, "2024-10-31", true), toScaled("12.75", 10), "a contagem de saldo, só com balances");
});
