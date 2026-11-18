// erp_stock.guard_invoice_stock_delete (stock/public.ts, guardInvoiceStockDelete;
// pedido da G para o invoice_execute do Fiscal) contra o gatilho
// protect_invoice_stock_posting do oráculo: BEFORE UPDATE OF deleted_at de
// erp_fiscal_invoices.invoice, WHEN old.deleted_at IS NULL AND new.deleted_at
// IS NOT NULL. No oráculo o UPDATE roda com os dois gatilhos BEFORE que vêm
// antes (finance_posted_invoice e guard_invoice) desligados, numa transação
// desfeita: só este gatilho decide.
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { guardInvoiceStockDelete } from "../../../src/erp/domains/stock/public.ts";

let f, warehouse;
const HASH = "b".repeat(64);
before(async () => {
  f = await dualFixture();
  warehouse = await f.catalog("warehouses", { name: "Depósito da nota" });
});
after(async () => f?.close());

/** Escrita direta sem os gatilhos (como a semeadura do harness), espelhada no SQLite. */
async function seed(sql, args) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}
/** Um movimento real (FK do lançamento), cada um num produto novo (versão física 0). */
async function movement() {
  const command = randomUUID();
  const product = await f.catalog("products", { name: `Produto da nota ${command.slice(0, 8)}`, unit: "UN", kind: "P", price: "10.0000" });
  const r = await f.rpc("erp_stock_post", {
    p_user_id: f.users.estoque, p_command_id: command, p_kind: "receipt", p_occurred_on: "2024-10-15", p_reason: "Entrada da nota",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "1", expected_version: 0 }], p_reference: null,
  });
  return { id: r.movement.id, command };
}
async function invoice(deletedAt = null) {
  const id = randomUUID();
  await seed(
    `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,deleted_at,deleted_by,delete_reason)
     values($1,'55','0','N','2',1,1,null,'Compra','2024-09-01','1','1','0',false,'{"name":"Fornecedor"}','[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',1,$2,$2,$3,$4,$5)`,
    [id, f.users.admin, deletedAt, deletedAt && f.users.admin, deletedAt && "Lixeira anterior"],
  );
  return id;
}
async function posting(invoiceId, reversed = false) {
  const m = await movement();
  const r = reversed ? await movement() : null;
  await seed(
    `insert into erp_stock.invoice_posting(invoice_id,invoice_version,source,warehouse_id,movement_id,state,snapshot,preview_hash,actor,command_id,reversal_movement_id,reversed_at,reversed_by,reversal_command_id)
     values($1,1,'invoice',$2,$3,$4,'{}',$5,$6,$7,$8,$9,$10,$11)`,
    [invoiceId, warehouse.id, m.id, reversed ? "reversed" : "active", HASH, f.users.estoque, m.command, r?.id ?? null, reversed ? new Date().toISOString() : null, reversed ? f.users.estoque : null, r?.command ?? null],
  );
}

/** Lixeira da nota (deleted_at de `before` para agora) nos dois motores. */
async function trash(id, before = null) {
  return f.dual(
    "guard_invoice_stock_delete",
    async () => {
      await f.db.exec("begin");
      try {
        await f.db.exec("alter table erp_fiscal_invoices.invoice disable trigger finance_posted_invoice");
        await f.db.exec("alter table erp_fiscal_invoices.invoice disable trigger guard_invoice");
        await f.db.query("update erp_fiscal_invoices.invoice set deleted_at=clock_timestamp(), deleted_by=$2, delete_reason='Lixeira' where id=$1", [id, f.users.admin]);
        return "ok";
      } finally {
        await f.db.exec("rollback");
      }
    },
    () =>
      inTransaction(f.driver, (ctx) => {
        guardInvoiceStockDelete(ctx.db, { deleted_at: before }, { id, deleted_at: "agora" });
        return "ok";
      }),
  );
}
const refused = (e) => e.code === "40001" && e.message === "erp_invoice_stock_posted_delete";

test("nota com lançamento de estoque ativo não vai para a lixeira", async (t) => {
  const id = await invoice();
  await posting(id);
  await t.assert.rejects(trash(id), refused);
});

test("nota sem lançamento, ou com o lançamento estornado, vai", async () => {
  await trash(await invoice());
  const reversed = await invoice();
  await posting(reversed, true);
  await trash(reversed);
});

test("nota já na lixeira (WHEN falso): o gatilho não roda", async () => {
  const stamp = "2024-09-02T10:00:00Z";
  const id = await invoice(stamp);
  await posting(id);
  await trash(id, stamp);
});
