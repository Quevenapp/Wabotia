// erp_fiscal_invoices.sales_balance (fiscal/public.ts, salesBalance; pedido da O
// para o erp_document_invoice_balance, B4 do Documentos) contra o oráculo:
// nota parcial que vale, nota cancelada e nota excluída (não valem), nota
// cheia e pedido sem nota. As notas e os vínculos são semeados direto (o
// partial_create é do F2c).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { quantityText, salesBalance } from "../../../src/erp/domains/fiscal/public.ts";

let f, product;
before(async () => {
  f = await dualFixture();
  product = await f.catalog("products", { name: "Produto faturado", unit: "UN", kind: "P", format: "S", price: "10.0000" });
});
after(async () => f?.close());

async function seed(sql, args) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}
/** Pedido de venda com dois itens (2,5 e 3), gravado pelo motor; devolve o id e os ids dos itens. */
async function order() {
  const contact = await f.catalog("contacts", { name: `Cliente ${randomUUID().slice(0, 8)}`, person_type: "J", roles: ["customer"] });
  const r = await f.rpc("erp_document_save", {
    p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: {
      date: "2026-11-11", contact_id: contact.id,
      items: [
        { product_id: product.id, description: "Item com saldo", unit: "UN", quantity: "2.5", unit_price: "10", discount_percent: "0" },
        { product_id: null, description: "Item avulso", unit: "CX", quantity: "3", unit_price: "4", discount_percent: "0" },
      ],
      installments: [],
    },
  });
  const id = r.document?.id ?? r.id;
  const items = (await f.db.query("select id from erp_documents.item where document_id=$1 order by position", [id])).rows.map((x) => x.id);
  return { id, items };
}
let at = 0;
async function invoice(doc, { status = 1, deleted = false, number = null } = {}) {
  const id = randomUUID();
  const created = new Date(Date.UTC(2026, 10, 12, 10, 0, ++at)).toISOString();
  await seed(
    `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,deleted_at,deleted_by,delete_reason)
     values($1,'55','1','N','2',$2,1,$3,'Venda','2026-11-12','1','1','1',false,'{"name":"Cliente"}','[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',1,$4,$4,$5,$6,$7,$8)`,
    [id, status, number, f.users.admin, created, deleted ? created : null, deleted ? f.users.admin : null, deleted ? "Lixeira" : null],
  );
  await seed("insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [id, doc]);
  return id;
}
async function link(inv, doc, item, position, quantity) {
  await seed(
    `insert into erp_fiscal_invoices.invoice_order_item(invoice_id,document_id,invoice_position,document_item_id,quantity,product_id,command_id,created_by)
     values($1,$2,$3,$4,$5,null,$6,$7)`,
    [inv, doc, position, item, quantity, randomUUID(), f.users.admin],
  );
}
const balance = (doc) =>
  f.dual(
    "sales_balance",
    async () => (await f.db.query("select erp_fiscal_invoices.sales_balance($1) b", [doc])).rows[0].b,
    () => salesBalance(f.driver, doc),
  );

test("quantity_text: trunca em 4 casas, como o to_char do oráculo", () => {
  assert.equal(quantityText(2_500_000n, 6), "2.5000");
  assert.equal(quantityText(1_234_567n, 6), "1.2345");
  assert.equal(quantityText(0n, 4), "0.0000");
  assert.equal(quantityText(null), null);
});

test("pedido sem nota, com nota parcial (cancelada e excluída não valem) e com nota cheia", async () => {
  const none = await order();
  const empty = await balance(none.id);
  assert.equal(empty.full_invoice_id, null);
  assert.deepEqual(empty.invoices, []);

  const partial = await order();
  const p1 = await invoice(partial.id, { number: 7 });
  await link(p1, partial.id, partial.items[0], 1, "1.5");
  const p2 = await invoice(partial.id, { status: 3, number: 8 });
  await link(p2, partial.id, partial.items[0], 1, "0.5");
  const p3 = await invoice(partial.id, { deleted: true });
  await link(p3, partial.id, partial.items[1], 1, "1");
  const b = await balance(partial.id);
  assert.equal(b.full_invoice_id, null);
  assert.deepEqual(
    b.items.map((i) => [i.ordered, i.invoiced, i.remaining]),
    [["2.5000", "1.5000", "1.0000"], ["3.0000", "0.0000", "3.0000"]],
  );
  assert.deepEqual(b.invoices.map((n) => [n.partial, n.counts, n.status]), [[true, true, 1], [true, false, 3]]);

  const whole = await order();
  const full = await invoice(whole.id, { number: 9 });
  const w = await balance(whole.id);
  assert.equal(w.full_invoice_id, full);
  assert.deepEqual(w.items.map((i) => [i.invoiced, i.remaining]), [["2.5000", "0.0000"], ["3.0000", "0.0000"]]);
});
