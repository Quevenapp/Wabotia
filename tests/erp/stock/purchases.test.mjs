import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { product, error, readEffects, seed } from "./invoice-fixture.mjs";
import { order, DAY } from "./final-fixture.mjs";
let f, p, w, d, item;
before(async () => {
  f = await dualFixture();
  p = await product(f);
  w = await f.catalog("warehouses", { name: "Compras final" });
  d = await order(f, p, w);
  item = (await f.db.query("select id from erp_documents.item where document_id=$1", [d.id])).rows[0].id;
});
after(() => f?.close());
const call = (name, a) => f.rpc("erp_stock_" + name, { p_user_id: f.users.estoque, ...a });
const base = () => ({
  p_document_id: d.id,
  p_expected_version: d.version,
  p_warehouse_id: w.id,
  p_occurred_on: DAY,
  p_reason: "Receber compra",
  p_items: [{ item_id: item, quantity: "2" }],
});
test("compras: prévia, receber, replay, conflito e estornar tudo", async () => {
  // A preferência de data é do documento, para não depender do dia da execução.
  await seed(f, "update erp_preferences.definition set default_value='\"data_documento\"' where key='estoque.data_lancamento'");
  const a = base(),
    preview = (await call("purchase_receive_preview", a)).preview;
  const command = { ...a, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_confirm: true };
  await assert.rejects(call("purchase_receive", { ...command, p_preview_hash: "0".repeat(64) }), error("purchase_receipt_preview_changed", "40001"));
  const r = await call("purchase_receive", command);
  assert.equal(r.current.items[0].remaining_quantity, "3.000000");
  assert.equal((await call("purchase_receive", command)).replayed, true);
  await assert.rejects(call("purchase_receive", { ...command, p_reason: "Outra razão" }), error("purchase_receipt_command_conflict", "40001"));
  await assert.rejects(call("purchase_receive_preview", a), (e) => e.code === "40001");
  await readEffects(f, p.id);
  const reverse = { p_command_id: randomUUID(), p_document_id: d.id, p_expected_version: r.receipt.document_version };
  const reversed = await call("purchase_reverse_all", reverse);
  assert.equal(reversed.reversed.length, 1);
  assert.equal((await call("purchase_reverse_all", reverse)).replayed, true);
  await assert.rejects(
    call("purchase_reverse_all", { ...reverse, p_expected_version: reverse.p_expected_version + 1 }),
    error("erp_stock_purchase_reverse_conflict", "40001"),
  );
  await assert.rejects(
    call("purchase_reverse_all", { ...reverse, p_command_id: randomUUID(), p_expected_version: reversed.document_version }),
    error("erp_stock_purchase_nothing_to_reverse"),
  );
  await readEffects(f, p.id);
});
test("compras: validações de recebimento, estorno e papéis", async () => {
  d.version = (await f.db.query("select version from erp_documents.document where id=$1", [d.id])).rows[0].version;
  const a = base(),
    write = { ...a, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64), p_confirm: true };
  for (const name of ["purchase_receive_preview", "purchase_receive"])
    await assert.rejects(call(name, { ...(name.endsWith("_preview") ? a : write), p_warehouse_id: null }), error("purchase_receipt_warehouse_conflict"));
  for (const patch of [{ p_command_id: null }, { p_confirm: false }, { p_preview_hash: null }])
    await assert.rejects(call("purchase_receive", { ...write, ...patch }), error("purchase_receipt_input_invalid"));
  const reverse = { p_document_id: d.id, p_expected_version: 1, p_command_id: randomUUID() };
  for (const patch of [{ p_document_id: null }, { p_command_id: null }, { p_expected_version: 0 }, { p_expected_version: 2147483647 }])
    await assert.rejects(call("purchase_reverse_all", { ...reverse, ...patch }), error("erp_stock_purchase_reverse_invalid"));
  for (const role of ["consulta", "vendas", "fiscal", "financeiro", "inactive"])
    for (const [name, args] of [
      ["purchase_receive_preview", a],
      ["purchase_receive", write],
      ["purchase_reverse_all", reverse],
    ])
      await assert.rejects(call(name, { ...args, p_user_id: f.users[role] }), (e) => e.code === "42501");
});
test("compras: relatório e sugestão com dados, filtros e validações", async () => {
  const report = { p_date_from: "2026-10-01", p_date_to: "2026-10-31", p_statuses: ["in_progress"], p_group: "supplier" };
  assert.equal((await call("report_purchase_orders", report)).totals.orders, 1);
  assert.equal((await call("report_purchase_orders", { ...report, p_group: "product" })).items[0].quantity, "5.000000");
  await order(f, p, w, "sales_orders");
  const suggestion = {
    p_user_id: f.users.admin,
    p_date_from: "2026-10-01",
    p_date_to: "2026-10-31",
    p_coverage: 60,
    p_purchase_statuses: ["in_progress"],
    p_sales_statuses: ["draft", "open"],
  };
  assert.equal((await call("purchase_suggestion", suggestion)).total, 1);
  await call("purchase_suggestion", { ...suggestion, p_reserve: true, p_warehouse_id: w.id, p_brand: "" });
  for (const patch of [{ p_date_from: null }, { p_date_to: "1900-01-01" }, { p_statuses: [] }, { p_group: "x" }])
    await assert.rejects(call("report_purchase_orders", { ...report, ...patch }), error("erp_stock_invalid_query"));
  for (const patch of [
    { p_coverage: 0 },
    { p_coverage: null },
    { p_reserve: null },
    { p_purchase_statuses: [] },
    { p_sales_statuses: ["x"] },
    { p_brand: "x\n" },
  ])
    await assert.rejects(call("purchase_suggestion", { ...suggestion, ...patch }), error("erp_stock_invalid_query"));
  await assert.rejects(call("purchase_suggestion", { ...suggestion, p_warehouse_id: randomUUID() }), error("erp_stock_warehouse_not_found", "P0002"));
  await assert.rejects(call("purchase_suggestion", { ...suggestion, p_supplier_id: randomUUID() }), error("erp_stock_supplier_not_found", "P0002"));
  for (const role of ["admin", "consulta", "estoque", "financeiro", "fiscal"]) await call("report_purchase_orders", { ...report, p_user_id: f.users[role] });
  for (const role of ["vendas", "inactive"])
    await assert.rejects(call("report_purchase_orders", { ...report, p_user_id: f.users[role] }), (e) => e.code === "42501");
});

test("compras: estorno total de recebimento existente, replay e versão", async () => {
  const own = await product(f),
    doc = await order(f, own, w);
  const itemId = (await f.db.query("select id from erp_documents.item where document_id=$1", [doc.id])).rows[0].id;
  const args = {
    p_user_id: f.users.estoque,
    p_document_id: doc.id,
    p_expected_version: doc.version,
    p_occurred_on: DAY,
    p_reason: "Recebimento para estorno",
    p_items: [{ item_id: itemId, quantity: "2" }],
  };
  const preview = (await f.rpc("erp_purchase_receipts_preview", args)).preview;
  const received = await f.rpc("erp_purchase_receipts_receive", { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_confirm: true });
  const reverse = { p_document_id: doc.id, p_expected_version: received.receipt.document_version, p_command_id: randomUUID() };
  const r = await call("purchase_reverse_all", reverse);
  assert.equal(r.reversed.length, 1);
  assert.equal((await call("purchase_reverse_all", reverse)).replayed, true);
  await assert.rejects(
    call("purchase_reverse_all", { ...reverse, p_expected_version: reverse.p_expected_version + 1 }),
    error("erp_stock_purchase_reverse_conflict", "40001"),
  );
  await assert.rejects(call("purchase_reverse_all", { ...reverse, p_command_id: randomUUID() }), error("purchase_receipt_document_changed", "40001"));
  await assert.rejects(
    call("purchase_reverse_all", { ...reverse, p_command_id: randomUUID(), p_expected_version: r.document_version }),
    error("erp_stock_purchase_nothing_to_reverse"),
  );
  await readEffects(f, own.id);
});

test("compras: efeitos e recibos recusam documento sob autoridade Origin", async () => {
  const { mirrorGuardEffect } = await import("../../../src/erp/domains/documents/public.ts");
  const { inTransaction } = await import("../../../src/erp/engine/registry.ts");
  const doc = await order(f, p, w);
  await seed(f, "update erp_documents.document set origin='origin',authority='origin' where id=$1", [doc.id]);
  for (const table of ["receipt", "reversal", "command"]) {
    const id = randomUUID(),
      cmd = randomUUID(),
      movement = randomUUID();
    const sql =
      table === "command"
        ? "insert into erp_purchase_receipts.command(id,actor,document_id,action,request_hash,result) values($1,$2,$3,'receive',$4,'{}')"
        : `insert into erp_purchase_receipts.${table}(id,actor,document_id,source_document_version,document_version,command_id,movement_id,snapshot,preview_hash${table === "reversal" ? ",receipt_id" : ""}) values($1,$2,$3,1,2,$4,$5,'{}',$6${table === "reversal" ? ",$7" : ""})`;
    const args =
      table === "command"
        ? [id, f.users.estoque, doc.id, "0".repeat(64)]
        : [id, f.users.estoque, doc.id, cmd, movement, "0".repeat(64), ...(table === "reversal" ? [randomUUID()] : [])];
    await assert.rejects(
      f.dual(
        `purchase_${table}_authority`,
        () => f.db.query(sql, args),
        () => inTransaction(f.driver, (ctx) => mirrorGuardEffect(ctx.db, doc.id)),
      ),
      error("erp_document_mirror_effect_forbidden", "42501"),
    );
  }
});
