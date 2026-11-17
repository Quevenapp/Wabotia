// Leituras de outros domínios escritas pela P para o Catálogo
// (erp_catalog.contact_dto e contact_check_full), contra o oráculo:
// finance/public.ts categoryLabel e categoryActive (dona: O) e
// fiscal/public.ts natureDescription e natureActive (dona: G).
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { categoryActive, categoryLabel } from "../../../src/erp/domains/finance/public.ts";
import { natureActive, natureDescription } from "../../../src/erp/domains/fiscal/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));
/** Linhas de teste sem os gatilhos de guarda (como a semeadura de desvios do harness). */
async function replica(sql, args) {
  await f.db.exec("set session_replication_role = replica");
  try {
    return (await f.db.query(sql, args)).rows;
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
}
const pg = (sql, args) => async () => (await f.db.query(sql, args)).rows[0].v;

test("categoria financeira: nome (left 200) e ativa", async () => {
  const ids = [];
  for (const [name, active] of [["Vendas", true], ["Água & Luz", true], ["Inativa", false], ["x".repeat(230) + "ção", true]])
    ids.push((await replica("insert into erp_finance.category(name,kind,active,version) values($1,'receivable',$2,1) returning id::text id", [name, active]))[0].id);
  await f.sync();
  for (const id of [...ids, randomUUID(), null]) {
    await f.dual("category_label", pg("select (select left(c.name,200) from erp_finance.category c where c.id=$1) v", [id]), lite((db) => categoryLabel(db, id)));
    if (id !== null)
      await f.dual("category_active", pg("select exists(select 1 from erp_finance.category where id=$1 and active) v", [id]), lite((db) => categoryActive(db, id)));
  }
});

test("natureza de operação: descrição e ativa", async () => {
  const ids = [];
  for (const [description, active] of [["Venda de mercadoria", true], ["Devolução", false]])
    ids.push(
      (
        await replica(
          `insert into erp_fiscal_invoices.nature(description,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,
           include_freight_ipi_base,others,retentions,active,version,created_by,updated_by)
           values($1,'1','1','1',true,false,false,false,false,'{}','{}',$2,1,$3,$3) returning id::text id`,
          [description, active, f.users.admin],
        )
      )[0].id,
    );
  await f.sync();
  for (const id of [...ids, randomUUID(), null]) {
    await f.dual("nature_description", pg("select (select n.description from erp_fiscal_invoices.nature n where n.id=$1) v", [id]), lite((db) => natureDescription(db, id)));
    if (id !== null)
      await f.dual("nature_active", pg("select exists(select 1 from erp_fiscal_invoices.nature where id=$1 and active) v", [id]), lite((db) => natureActive(db, id)));
  }
});
