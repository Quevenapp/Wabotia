// erp_finance.commission_operation_sync (finance/document-effects.ts) contra o oráculo, chamada
// direta nos dois motores numa transação desfeita, comparando o retorno e as linhas de
// commission_operation e commission_adjustment. Cobre: criar (alíquota fixa e por faixas de
// desconto, base pelas Preferências), recalcular quando o total muda, cancelar com o ajuste,
// vendedor trocado (superseded + nova) e confirmação desfeita. Os documentos nascem pelo
// erp_document_save e mudam de situação pelo erp_document_transition, só no Postgres e espelhados.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { rowJson } from "../../../src/erp/engine/row-json.ts";
import { commissionOperationSync } from "../../../src/erp/domains/finance/document-effects.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const VOLATILE = ["id", "created_at", "ended_at", "operation_id"];
const clean = (o) => {
  const r = { ...o };
  for (const k of VOLATILE) delete r[k];
  return r;
};
const key = (r) => `${r.state ?? ""}|${r.seller_id ?? ""}|${r.source_key ?? ""}`;
const sortRows = (rows) => rows.map(clean).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

async function compare(doc, label) {
  // Postgres: a função numa transação desfeita.
  await f.db.query("begin");
  let pg;
  try {
    const before = (await f.db.query("select id from erp_finance.commission_operation where document_id=$1 and state='active'", [doc])).rows[0]?.id ?? null;
    const r = (await f.db.query("select erp_finance.commission_operation_sync($1) v", [doc])).rows[0].v;
    pg = {
      ret: r === null ? null : r === before ? "same" : "new",
      ops: sortRows((await f.db.query("select to_jsonb(o) j from erp_finance.commission_operation o where document_id=$1", [doc])).rows.map((x) => x.j)),
      adj: sortRows((await f.db.query("select to_jsonb(a) j from erp_finance.commission_adjustment a join erp_finance.commission_operation o on o.id=a.operation_id where o.document_id=$1", [doc])).rows.map((x) => x.j)),
    };
  } catch (e) {
    pg = { err: `${e.code}:${e.message}` };
  }
  await f.db.query("rollback");
  // Motor: a mesma chamada, desfeita lançando o resultado.
  let lite, captured;
  try {
    inTransaction(f.driver, (ctx) => {
      const before = ctx.db.exec(`SELECT id FROM "erp_finance__commission_operation" WHERE document_id=? AND state='active'`, doc).rows[0]?.id ?? null;
      const r = commissionOperationSync(ctx, doc);
      const out = {
        ret: r === null ? null : r === before ? "same" : "new",
        ops: sortRows(ctx.db.exec('SELECT * FROM "erp_finance__commission_operation" WHERE document_id=?', doc).rows.map((x) => rowJson("erp_finance__commission_operation", x))),
        adj: sortRows(
          ctx.db
            .exec('SELECT a.* FROM "erp_finance__commission_adjustment" a JOIN "erp_finance__commission_operation" o ON o.id=a.operation_id WHERE o.document_id=?', doc)
            .rows.map((x) => rowJson("erp_finance__commission_adjustment", x)),
        ),
      };
      captured = out;
      throw new Error("rollback");
    });
  } catch (e) {
    lite = captured ?? { err: `${e.code}:${e.message}` };
  }
  assert.deepEqual(lite, pg, label);
  return pg;
}

test("commission_operation_sync: mesmas linhas que o Postgres", async () => {
  const u = f.users;
  const sql = async (text, args = []) => {
    const r = await f.db.query(text, args);
    await f.sync();
    return r;
  };
  const contact = await f.catalog("contacts", { roles: ["customer"], name: "Cliente comissão operação" });
  const sellers = [];
  for (const name of ["Vendedora fixa op", "Vendedor faixas op"]) {
    const c = await f.catalog("contacts", { name });
    sellers.push((await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: c.id })).seller.id);
  }
  await sql("update erp_catalog.seller set commission_rule='faturamento',commission_mode='fixa',commission_rate=7.3333,commission_bands='[]' where id=$1", [sellers[0]]);
  await sql(`update erp_catalog.seller set commission_rule='parcial',commission_mode='descontos',commission_rate=null,
    commission_bands='[{"discount_up_to":5,"rate":4.25},{"discount_up_to":2.5,"rate":6},{"discount_up_to":100,"rate":0.3333}]' where id=$1`, [sellers[1]]);
  const order = async (seller, items) => {
    let d = (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: "2026-10-10", contact_id: contact.id, seller_id: seller, items, installments: [] } })).document;
    for (const status of d.status === "draft" ? ["open", "verified"] : ["verified"])
      d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: "sales_orders", p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: "Teste" })).document;
    return d.id;
  };
  const item = (price, discount = "0", quantity = "1") => ({ description: "Item op", unit: "UN", quantity, unit_price: price, discount_percent: discount });
  const docs = [
    await order(sellers[0], [item("100"), item("33.33", "0", "3")]),
    await order(sellers[1], [item("100", "2.5"), item("50", "4"), item("10.01", "40")]),
    await order(sellers[1], [item("0.07", "0")]),
  ];
  const triggers = async (on) => sql(`alter table erp_documents.document ${on ? "enable" : "disable"} trigger commission_operation_capture`);
  for (const doc of docs) await compare(doc, "operação existente, nada muda");
  for (const additions of [["desconto", "frete", "icms_st", "ipi", "taxas_pagamento"], []]) {
    await f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: "vendas-vendas",
      p_changes: JSON.stringify([{ key: "vendas.base_comissao", expected_version: (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: "vendas-vendas" })).items.find((i) => i.key === "vendas.base_comissao").version, value: additions.filter((a) => a !== "taxas_pagamento") }]) }).catch(() => null);
    await triggers(false);
    await sql(`update erp_documents.document set body=jsonb_set(jsonb_set(jsonb_set(body,'{totals,discount}','"3.335"'),'{totals,freight}','"12.34"'),'{totals,ipi}','"1.005"') where id=any($1)`, [docs]);
    await f.db.query("alter table erp_finance.commission_operation disable trigger commission_operation_frozen");
    await sql("delete from erp_finance.commission_operation where document_id=any($1)", [docs]);
    await f.db.query("alter table erp_finance.commission_operation enable trigger commission_operation_frozen");
    await triggers(true);
    for (const doc of docs) assert.equal((await compare(doc, `criar, base ${additions.join(",")}`)).ret, "new", "criou a operação");
  }
  // As operações de verdade (gravadas), para recalcular, cancelar e trocar o vendedor.
  await sql("select erp_finance.commission_operation_sync(id) from unnest($1::uuid[]) id", [docs]);
  // Recalcular: total da operação diferente do documento.
  await sql("update erp_finance.commission_operation set total_cents=1 where document_id=any($1)", [docs]);
  for (const doc of docs) assert.equal((await compare(doc, "recalcular")).ret, "same");
  // Cancelado, com e sem ajuste anterior; vendedor trocado; confirmação desfeita.
  await triggers(false);
  await sql("update erp_documents.document set status='cancelled' where id=$1", [docs[0]]);
  await sql("update erp_documents.document set body=jsonb_set(body,'{seller_id}',to_jsonb($2::text)) where id=$1", [docs[1], sellers[0]]);
  await sql("update erp_documents.document set status='open' where id=$1", [docs[2]]);
  await triggers(true);
  const [cancelled, swapped, unconfirmed] = [await compare(docs[0], "cancelado"), await compare(docs[1], "vendedor trocado"), await compare(docs[2], "desconfirmado")];
  assert.deepEqual([cancelled.ret, cancelled.adj.length, cancelled.ops.map((o) => o.state)], [null, 1, ["cancelled"]]);
  assert.deepEqual([swapped.ret, swapped.ops.map((o) => `${o.state}:${o.ended_reason}`).sort()], ["new", ["active:null", "superseded:Vendedor alterado"]]);
  assert.deepEqual([unconfirmed.ret, unconfirmed.ops.map((o) => `${o.state}:${o.ended_reason}`)], [null, ["superseded:Confirmação desfeita"]]);
  const op = (await f.db.query("select id from erp_finance.commission_operation where document_id=$1 and state='active'", [docs[0]])).rows[0];
  if (op) {
    await sql("insert into erp_finance.commission_adjustment(operation_id,kind,source_key,amount_cents,occurred_on,note) values($1,'manual','m1',-5,'2026-10-10','Ajuste')", [op.id]).catch(() => null);
    await compare(docs[0], "cancelado com ajuste anterior");
  }
  await compare(randomUUID(), "documento inexistente");
});
