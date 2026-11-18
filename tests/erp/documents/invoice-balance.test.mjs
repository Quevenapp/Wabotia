// erp_document_invoice_balance (B4) contra o oráculo pela RPC: o acesso (usuários, pedido de outro
// tipo, id desconhecido) e o saldo do Fiscal (nota parcial, cancelada, excluída e cheia, semeadas direto).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, product;
before(async () => {
  f = await dualFixture();
  product = await f.catalog("products", { name: "Produto do saldo", unit: "UN", kind: "P", format: "S", price: "10.0000" });
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
async function doc(kind = "sales_orders") {
  const contact = await f.catalog("contacts", { name: `Cliente ${randomUUID().slice(0, 8)}`, person_type: "J", roles: ["customer", "supplier"] });
  const r = await f.rpc("erp_document_save", {
    p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: {
      date: "2026-11-11", contact_id: contact.id, installments: [],
      items: [
        { product_id: product.id, description: "Item com saldo", unit: "UN", quantity: "2.5", unit_price: "10", discount_percent: "0" },
        { description: "Item avulso", unit: "CX", quantity: "3", unit_price: "4", discount_percent: "0" },
      ],
    },
  });
  const id = r.document?.id ?? r.id;
  const items = (await f.db.query("select id from erp_documents.item where document_id=$1 order by position", [id])).rows.map((x) => x.id);
  return { id, items };
}
let at = 0;
async function invoice(document, { status = 1, deleted = false, number = null } = {}) {
  const id = randomUUID();
  const created = new Date(Date.UTC(2026, 10, 12, 10, 0, ++at)).toISOString();
  await seed(
    `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,deleted_at,deleted_by,delete_reason)
     values($1,'55','1','N','2',$2,1,$3,'Venda','2026-11-12','1','1','1',false,'{"name":"Cliente"}','[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',1,$4,$4,$5,$6,$7,$8)`,
    [id, status, number, f.users.admin, created, deleted ? created : null, deleted ? f.users.admin : null, deleted ? "Lixeira" : null],
  );
  await seed("insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [id, document]);
  return id;
}
const link = (inv, document, item, quantity) =>
  seed(
    `insert into erp_fiscal_invoices.invoice_order_item(invoice_id,document_id,invoice_position,document_item_id,quantity,product_id,command_id,created_by)
     values($1,$2,1,$3,$4,null,$5,$6)`,
    [inv, document, item, quantity, randomUUID(), f.users.admin],
  );
const users = () => [f.users.admin, f.users.vendas, f.users.consulta, f.users.financeiro, f.users.estoque, f.users.fiscal].filter(Boolean);
/** Todos os usuários: resposta ou erro iguais nos dois motores (o f.rpc compara). */
async function every(id) {
  const out = [];
  for (const user of users()) {
    try {
      out.push(await f.rpc("erp_document_invoice_balance", { p_user_id: user, p_document_id: id }));
    } catch (e) {
      if (/divergem/.test(e.message)) throw e;
      out.push(e.message);
    }
  }
  return out;
}

test("saldo de faturamento: sem nota, parcial (cancelada e excluída não valem), cheia; acesso igual ao oráculo", async () => {
  const none = await doc();
  const [empty] = await every(none.id);
  assert.equal(empty.scope, "document_invoice_balance");
  assert.deepEqual(empty.invoices, []);

  const partial = await doc();
  await link(await invoice(partial.id, { number: 7 }), partial.id, partial.items[0], "1.5");
  await link(await invoice(partial.id, { status: 3, number: 8 }), partial.id, partial.items[0], "0.5");
  await link(await invoice(partial.id, { deleted: true }), partial.id, partial.items[1], "1");
  const [b] = await every(partial.id);
  assert.deepEqual(b.items.map((i) => [i.ordered, i.invoiced, i.remaining]), [["2.5000", "1.5000", "1.0000"], ["3.0000", "0.0000", "3.0000"]]);

  const whole = await doc();
  const full = await invoice(whole.id, { number: 9 });
  assert.equal((await every(whole.id))[0].full_invoice_id, full);

  const proposal = await doc("sales_proposals");
  assert.equal((await every(proposal.id))[0], "erp_document_not_found");
  assert.equal((await every(randomUUID()))[0], "erp_document_not_found");
  assert.equal((await every(null))[0], "erp_document_not_found");
});
