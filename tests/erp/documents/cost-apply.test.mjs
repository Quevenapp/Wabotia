// erp_documents.cost_apply (documents/cost-apply.ts) contra o oráculo: chamada direta nos dois
// motores numa transação desfeita, comparando o retorno e as linhas de item_cost_applied.
// Os pedidos são confirmados com o gatilho cost_apply_capture desligado no Postgres, para que
// nenhum custo esteja gravado antes da comparação. Custos: preço de custo do fornecedor padrão,
// nenhum custo, produto sem custo e pedido não confirmado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { rowJson } from "../../../src/erp/engine/row-json.ts";
import { costApply } from "../../../src/erp/domains/documents/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const clean = (rows) => rows.map(({ applied_at: _a, ...r }) => r).sort((a, b) => (a.item_id < b.item_id ? -1 : 1));

async function compare(doc, label) {
  await f.db.query("begin");
  let pg;
  try {
    const n = (await f.db.query("select erp_documents.cost_apply($1) v", [doc])).rows[0].v;
    pg = { n, rows: clean((await f.db.query("select to_jsonb(a) j from erp_documents.item_cost_applied a where document_id=$1", [doc])).rows.map((x) => x.j)) };
  } catch (e) {
    pg = { err: `${e.code}:${e.message}` };
  }
  await f.db.query("rollback");
  let lite, captured;
  try {
    inTransaction(f.driver, (ctx) => {
      const n = costApply(ctx, doc);
      captured = { n, rows: clean(ctx.db.exec('SELECT * FROM "erp_documents__item_cost_applied" WHERE document_id=?', doc).rows.map((x) => rowJson("erp_documents__item_cost_applied", x))) };
      throw new Error("rollback");
    });
  } catch (e) {
    lite = captured ?? { err: `${e.code}:${e.message}` };
  }
  assert.deepEqual(lite, pg, label);
  return pg;
}

test("cost_apply: mesmo custo que o Postgres", async () => {
  const u = f.users;
  const sql = async (text, args = []) => {
    const r = await f.db.query(text, args);
    await f.sync();
    return r;
  };
  const contact = await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente custo" });
  const product = async (name, cost) => {
    const p = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name, code: name, unit: "UN", kind: "P", format: "S", price: "50" } })).record;
    if (cost !== null)
      await sql("insert into erp_catalog.product_supplier(record_id,position,supplier_id,cost_price,is_default) values($1,1,$2,$3,true)", [p.id, contact.id, cost]).catch(async () =>
        sql("update erp_catalog.product_supplier set cost_price=$2,is_default=true where record_id=$1", [p.id, cost]));
    return p.id;
  };
  const products = [await product("P-CUSTO-1", "12.3456789012"), await product("P-CUSTO-2", "0"), await product("P-CUSTO-3", null), await product("P-CUSTO-4", "7.5")];
  // A situação vai direto por SQL (com o gatilho desligado no Postgres): o transition, que roda nos dois motores,
  // aplicaria o custo antes da comparação.
  const order = async (items, statuses = ["open", "verified"]) => {
    let d = (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: "2026-10-10", contact_id: contact.id, items, installments: [] } })).document;
    const status = statuses[statuses.length - 1];
    if (status !== d.status) {
      await f.db.query("alter table erp_documents.document disable trigger cost_apply_capture");
      await sql("update erp_documents.document set status=$2 where id=$1", [d.id, status]);
      await f.db.query("alter table erp_documents.document enable trigger cost_apply_capture");
    }
    return d.id;
  };
  const item = (product, quantity = "1") => ({ product_id: product, description: "Item custo", unit: "UN", quantity, unit_price: "50", discount_percent: "0" });
  const docs = [
    await order(products.map((p) => item(p))),
    await order([item(products[0]), { description: "Sem produto", unit: "UN", quantity: "1", unit_price: "5", discount_percent: "0" }]),
    await order([item(products[3])], ["open"]),
  ];
  const first = await compare(docs[0], "pedido verificado: fornecedor, zero e sem custo");
  assert.ok(first.n >= 2, "custos aplicados de fato");
  await compare(docs[1], "item sem produto");
  assert.equal((await compare(docs[2], "pedido não confirmado")).n, 0);
  await compare(randomUUID(), "documento inexistente");
});
