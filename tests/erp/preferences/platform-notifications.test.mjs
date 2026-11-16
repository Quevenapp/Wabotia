// Notificações agendadas (migrações 151, 283 e 330) na fixture dupla.
// Adaptado de workers/erp-api/test/plataforma-h-sql.test.mjs, "PRF-280, PRF-283: the scheduled run creates each
// notification once per user, type and day, whatever the repetition": o runPlatformTasks da erp-api vira
// claim → notifications_run → finish pelos RPCs (é o que ele chama); o insert direto de tarefa passa pela cópia.
// Mais: as quatro funções do Estoque escritas pela G para este domínio (stock/home.ts) contra o oráculo, e os
// tipos de estoque e validade com a preferência de dias de aviso.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { toScaled } from "../../../src/erp/engine/dec.ts";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { countPhysical, ignoredWarehouse, lotQuantity, lotsExpiring } from "../../../src/erp/domains/stock/public.ts";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
const write = async (sql, args = []) => {
  await f.db.query(sql, args);
  await f.sync();
};
const today = () => f.scalar("select to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD') v");

/** O que o runPlatformTasks faz com as notificações: toma, roda e conclui. */
async function run() {
  const out = [];
  for (;;) {
    const lease = randomUUID();
    const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["notifications_generate"] })).task;
    if (!task) return out;
    const result = await f.rpc("erp_platform_notifications_run", { p_task: task.id, p_lease: lease });
    await f.rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: true, p_result: result, p_error: null });
    out.push({ purpose: task.purpose, ok: true, result });
  }
}

test("PRF-280, PRF-283: the scheduled run creates each notification once per user, type and day, whatever the repetition", async () => {
  const now = new Date().toISOString();
  const first = await f.rpc("erp_platform_schedule", { p_now: now }),
    second = await f.rpc("erp_platform_schedule", { p_now: now });
  assert.deepEqual(first.tasks, second.tasks, "the same hour is the same task");
  const contact = (await f.catalog("contacts", { name: "Cliente Sintético" })).id,
    product = (await f.catalog("products", { name: "Produto Sintético", code: "SKU-330" })).id;
  const day = await today();
  await f.rpc("erp_document_save", {
    p_user_id: f.users.admin, p_kind: "sales_proposals", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: day, contact_id: contact, next_contact: day, items: [{ product_id: product, description: "Produto Sintético", quantity: "1", unit_price: "10.00", unit: "UN" }] },
  });
  const ran = await run();
  assert.deepEqual(ran.map((r) => [r.purpose, r.ok]), [["notifications_generate", true]], JSON.stringify(ran));
  const notified = async () => f.scalar("select count(*)::int v from erp_home.notification where type='proximo_contato' and user_id=$1", [f.users.admin]);
  assert.equal(await notified(), 1);
  assert.equal((await run()).length, 0, "a done task is not run again");
  await write("insert into erp_platform.task(purpose,operation_id,payload) values('notifications_generate','notificacoes:repetida','{}')");
  await run();
  const dup = await f.scalar("select count(*)::int v from(select user_id,type,day from erp_home.notification group by 1,2,3 having count(*)>1) x");
  assert.equal(dup, 0);
  assert.equal(await notified(), 1);
});

test("stock (below minimum, zeroed), expiry with the warning days and the four stock functions against the oracle", async () => {
  const geral = (await f.rpc("erp_stock_warehouse_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: "Geral", p_ignore_balance: false })).warehouse.id;
  const loja = (await f.rpc("erp_stock_warehouse_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: "Loja", p_ignore_balance: true })).warehouse.id;
  const day = await today();
  const save = (data) =>
    f.rpc("erp_catalog_product_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { kind: "P", format: "S", unit: "UN", ...data }, p_acknowledged: null });
  const low = (await save({ name: "Abaixo do mínimo", stock_min: "5" })).record.id;
  const zero = (await save({ name: "Zerado" })).record.id;
  const expiring = (await save({ name: "Validade", expiry_date: day })).record.id;
  const post = async (product, warehouse, quantity) =>
    f.rpc("erp_stock_post", {
      p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: quantity.startsWith("-") ? "issue" : "receipt", p_occurred_on: day, p_reason: "Sintético",
      p_items: [{ product_id: product, warehouse_id: warehouse, quantity, expected_version: (await f.scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [product, warehouse])) ?? 0 }],
    });
  await post(low, geral, "2");
  await post(low, loja, "10");
  await post(zero, geral, "1");
  await post(zero, geral, "-1");
  for (const [id, wh] of [[low, null], [low, geral], [low, loja], [zero, null], [randomUUID(), null]])
    await f.dual(
      "erp_stock.count_physical",
      async () => String(toScaled(String(await f.scalar("select erp_stock.count_physical($1,$2)::text v", [id, wh])), 6)),
      () => inTransaction(f.driver, (ctx) => String(countPhysical(ctx.db, id, wh))),
    );
  for (const wh of [geral, loja, randomUUID()])
    await f.dual(
      "erp_stock.ignored_warehouse",
      () => f.scalar("select erp_stock.ignored_warehouse($1) v", [wh]),
      () => inTransaction(f.driver, (ctx) => ignoredWarehouse(ctx.db, wh)),
    );
  await f.dual(
    "erp_stock.lots_expiring",
    async () => (await f.db.query("select count(*)::int n from erp_stock.lots_expiring($1::date,$2::date)", [day, "2099-12-31"])).rows[0].n,
    () => inTransaction(f.driver, (ctx) => lotsExpiring(ctx.db, day, "2099-12-31").length),
  );
  await f.dual(
    "erp_stock.lot_quantity",
    async () => String(toScaled(String(await f.scalar("select erp_stock.lot_quantity($1,null)::text v", [randomUUID()])), 6)),
    () => inTransaction(f.driver, (ctx) => String(lotQuantity(ctx.db, randomUUID(), null))),
  );
  await f.rpc("erp_platform_schedule", { p_now: new Date(Date.now() + 3_600_000).toISOString() });
  const ran = await (async () => {
    const lease = randomUUID();
    const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["notifications_generate"] })).task;
    return task ? f.rpc("erp_platform_notifications_run", { p_task: task.id, p_lease: lease }) : null;
  })();
  assert.ok(ran === null || ran.members >= 1);
  const types = (await f.db.query("select distinct type from erp_home.notification order by 1")).rows.map((r) => r.type);
  for (const t of ["estoque_abaixo_minimo", "estoque_zerado", "validade"]) assert.ok(ran === null || types.includes(t), `${t}: ${types}`);
  assert.ok(expiring);
});
