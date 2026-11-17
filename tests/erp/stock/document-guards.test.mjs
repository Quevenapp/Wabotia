// Guardas do Estoque sobre documento e item (stock/document-guards.ts) contra
// os gatilhos do oráculo: com lançamento, reserva ou recebimento ativo, o
// que o documento e o item ainda podem mudar. No oráculo o UPDATE/DELETE roda
// com os gatilhos ligados numa transação desfeita; no motor, a guarda recebe a
// linha antiga e a nova.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as stock from "../../../src/erp/domains/stock/public.ts";

let f, u, contact, other, product, warehouse;
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};
const MESSAGES = ["erp_document_active_stock", "erp_document_active_reservation", "purchase_receipt_active"];

before(async () => {
  f = await dualFixture();
  u = f.users;
  contact = await f.catalog("contacts", { name: "Cliente das guardas", person_type: "J", roles: ["customer", "supplier"] });
  other = await f.catalog("contacts", { name: "Outro contato", person_type: "J", roles: ["customer", "supplier"] });
  product = await f.catalog("products", { name: "Produto das guardas", unit: "UN", kind: "P", format: "S", price: "5" });
  warehouse = await f.catalog("warehouses", { name: "Depósito das guardas" });
});
after(() => f?.close());

let number = 900;
/** Documento com um item e o efeito dado (posting, reservation ou receipt). */
async function documentWith(kind, effect, status = "open") {
  const id = randomUUID(),
    item = randomUUID();
  const body = { notes: "nota", internal_notes: "interna", contact_id: contact.id, warehouse_id: warehouse.id, discount: "0" };
  await seed(
    `insert into erp_documents.document(id,kind,number,version,status,contact_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
     values($1,$2,$3,1,$4,$5,'{"name":"Cliente"}',$6::jsonb,10,$7,$7,'brufap','brufap')`,
    [id, kind, number++, status, contact.id, JSON.stringify(body), u.admin],
  );
  await seed(`insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,data) values($1,$2,1,$3,2,5,'{"unit":"UN"}')`, [item, id, product.id]);
  const movement = (await f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2024-10-15", p_reason: "Efeito",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "1", expected_version: (await f.db.query("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [product.id, warehouse.id])).rows[0].v }],
    p_reference: null,
  })).movement.id;
  if (effect === "posting")
    await seed(
      `insert into erp_stock.document_posting(id,document_id,document_version,movement_id,state,version,snapshot,preview_hash,actor,command_id) values(gen_random_uuid(),$1,1,$2,'active',1,'{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$3,gen_random_uuid())`,
      [id, movement, u.admin],
    );
  if (effect === "reservation")
    await seed(
      `insert into erp_stock.reservation(id,document_id,source_document_version,version,state,snapshot,preview_hash,actor,command_id) values(gen_random_uuid(),$1,1,1,'active','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$2,gen_random_uuid())`,
      [id, u.admin],
    );
  if (effect === "receipt")
    await seed(
      `insert into erp_purchase_receipts.receipt(id,document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash) values(gen_random_uuid(),$1,1,2,gen_random_uuid(),$2,$3,'{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
      [id, movement, u.admin],
    );
  return { id, item };
}

/** Resultado do gatilho no oráculo (só as mensagens das guardas do Estoque contam). */
async function pgOutcome(sql, args) {
  await f.db.exec("begin");
  try {
    await f.db.query(sql, args);
    return "ok";
  } catch (e) {
    return MESSAGES.includes(e.message) ? e.message : `outro:${e.message}`;
  } finally {
    await f.db.exec("rollback");
  }
}
/** Comparação só quando o oráculo respondeu pelas guardas do Estoque (ou passou); gatilho de outro domínio antes não conta. */
const same = (got, want, label) => {
  if (want.startsWith("outro:")) return;
  assert.equal(got, want, label);
};
function liteOutcome(fn) {
  try {
    inTransaction(f.driver, (ctx) => fn(ctx.db));
    return "ok";
  } catch (e) {
    return e.message;
  }
}
const docRow = (id) => f.driver.exec('SELECT * FROM "erp_documents__document" WHERE id=?', id).rows[0];
const itemRow = (id) => f.driver.exec('SELECT * FROM "erp_documents__item" WHERE id=?', id).rows[0];
/** Guardas de documento na ordem dos gatilhos do oráculo (nome). */
const docGuards = (db, op, o, n) => {
  stock.guardDocument(db, op, o, n);
  stock.guardPostedDocument(db, op, o, n);
  stock.guardReservedDocument(db, op, o, n);
};
const itemGuards = (db, op, o, n) => {
  stock.guardItem(db, op, o, n);
  stock.guardPostedItem(db, op, o, n);
  stock.guardReservedItem(db, op, o, n);
};

test("documento com efeito: observações passam; total, contato, cancelar e excluir recusam", async () => {
  for (const [kind, effect] of [["sales_orders", "posting"], ["sales_orders", "reservation"], ["purchase_orders", "receipt"], ["purchase_orders", "posting"]]) {
    const d = await documentWith(kind, effect);
    const o = docRow(d.id);
    const body = JSON.parse(o.body);
    const cases = [
      ["observações", `update erp_documents.document set body=body||'{"notes":"outra"}'::jsonb where id=$1`, { body: JSON.stringify({ ...body, notes: "outra" }) }],
      ["desconto no body", `update erp_documents.document set body=body||'{"discount":"1"}'::jsonb where id=$1`, { body: JSON.stringify({ ...body, discount: "1" }) }],
      ["contato no body", `update erp_documents.document set body=body||jsonb_build_object('contact_id',$2::text) where id=$1`, { body: JSON.stringify({ ...body, contact_id: other.id }) }, [other.id]],
      ["total", `update erp_documents.document set total=11 where id=$1`, { total: 1100 }],
      ["versão e data", `update erp_documents.document set version=2, updated_at=now() where id=$1`, { version: 2 }],
      ["situação verificado", `update erp_documents.document set status='verified' where id=$1`, { status: "verified" }],
      ["situação cancelado", `update erp_documents.document set status='cancelled' where id=$1`, { status: "cancelled" }],
    ];
    for (const [label, sql, change, extra = []] of cases) {
      const want = await pgOutcome(sql, [d.id, ...extra]);
      const got = liteOutcome((db) => docGuards(db, "UPDATE", o, { ...o, ...change }));
      assert.equal(got, want, `${kind}/${effect}: ${label}`);
    }
    const want = await pgOutcome(`delete from erp_documents.document where id=$1`, [d.id]);
    assert.equal(liteOutcome((db) => docGuards(db, "DELETE", o, null)), want, `${kind}/${effect}: excluir`);
  }
});

test("item com efeito: regravação idêntica passa; mudar, incluir e excluir recusam", async () => {
  for (const [kind, effect] of [["sales_orders", "posting"], ["sales_orders", "reservation"], ["purchase_orders", "receipt"]]) {
    const d = await documentWith(kind, effect);
    const o = itemRow(d.item);
    let want = await pgOutcome(`update erp_documents.item set quantity=quantity where id=$1`, [d.item]);
    same(liteOutcome((db) => itemGuards(db, "UPDATE", o, { ...o })), want, `${kind}/${effect}: idêntico`);
    want = await pgOutcome(`update erp_documents.item set quantity=3 where id=$1`, [d.item]);
    same(liteOutcome((db) => itemGuards(db, "UPDATE", o, { ...o, quantity: 3000000 })), want, `${kind}/${effect}: quantidade`);
    want = await pgOutcome(`delete from erp_documents.item where id=$1`, [d.item]);
    same(liteOutcome((db) => itemGuards(db, "DELETE", o, null)), want, `${kind}/${effect}: excluir item`);
    const fresh = randomUUID();
    want = await pgOutcome(`insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,data) values($1,$2,2,$3,1,5,'{"unit":"UN"}')`, [fresh, d.id, product.id]);
    same(liteOutcome((db) => itemGuards(db, "INSERT", null, { ...o, id: fresh, position: 2 })), want, `${kind}/${effect}: incluir item`);
  }
  // Sem efeito, tudo passa.
  const d = await documentWith("sales_orders", null);
  const o = docRow(d.id);
  assert.equal(liteOutcome((db) => docGuards(db, "DELETE", o, null)), "ok");
  assert.equal(stock.active(f.driver, d.id), false);
});

test("forget_item_components: troca de produto e exclusão esquecem os componentes editados", async () => {
  const d = await documentWith("sales_orders", null);
  const o = itemRow(d.item);
  await seed(`insert into erp_stock.item_component(item_id,document_id,product_id,components,version,updated_at,updated_by,command_id) values($1,$2,$3,'[{"component_id":"00000000-0000-4000-8000-000000000001","quantity":"1"}]',1,now(),$4,gen_random_uuid())`, [d.item, d.id, product.id, u.admin]);
  const count = () => Number(f.driver.exec('SELECT count(*) n FROM "erp_stock__item_component" WHERE item_id=?', d.item).rows[0].n);
  inTransaction(f.driver, (ctx) => stock.forgetItemComponents(ctx.db, "UPDATE", o, { ...o }));
  assert.equal(count(), 1);
  inTransaction(f.driver, (ctx) => stock.forgetItemComponents(ctx.db, "UPDATE", o, { ...o, product_id: randomUUID() }));
  assert.equal(count(), 0);
});
