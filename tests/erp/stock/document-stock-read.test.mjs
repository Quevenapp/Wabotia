import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { product, error, readEffects } from "./invoice-fixture.mjs";
import { order, DAY } from "./final-fixture.mjs";
let f, p, w, d;
before(async () => {
  f = await dualFixture();
  p = await product(f);
  w = await f.catalog("warehouses", { name: "Depósito escolhido" });
  d = await order(f, p, w);
});
after(() => f?.close());
const base = () => ({
  p_user_id: f.users.estoque,
  p_kind: d.kind,
  p_document_id: d.id,
  p_expected_version: d.version,
  p_warehouse_id: w.id,
  p_occurred_on: DAY,
  p_reason: "Entrada pelo depósito",
});
test("documento: leitura, prévia por depósito, lançamento, replay e CAS", async () => {
  assert.equal((await f.rpc("erp_document_stock_get", { p_user_id: f.users.estoque, p_kind: d.kind, p_document_id: d.id })).items.length, 1);
  assert.ok(
    (await f.rpc("erp_document_stock_list", { p_user_id: f.users.estoque, p_kind: d.kind, p_query: String(d.number) })).items.some((x) => x.id === d.id),
  );
  const a = base(),
    preview = (await f.rpc("erp_stock_document_warehouse_preview", a)).preview;
  const post = { ...a, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: [] };
  await assert.rejects(
    f.rpc("erp_stock_document_warehouse_post", { ...post, p_preview_hash: "0".repeat(64) }),
    error("erp_document_stock_preview_conflict", "40001"),
  );
  await assert.rejects(
    f.rpc("erp_stock_document_warehouse_post", { ...post, p_ignored_item_ids: [randomUUID()] }),
    error("erp_document_stock_ignored_ack_required"),
  );
  const r = await f.rpc("erp_stock_document_warehouse_post", post);
  assert.equal(r.warehouse_id, w.id);
  assert.equal((await f.rpc("erp_stock_document_warehouse_post", post)).replayed, true);
  await assert.rejects(f.rpc("erp_stock_document_warehouse_post", { ...post, p_reason: "Outra razão" }), error("erp_document_stock_command_conflict", "40001"));
  await assert.rejects(f.rpc("erp_stock_document_warehouse_preview", a), error("erp_document_version_conflict", "40001"));
  assert.equal((await f.rpc("erp_document_stock_get", { p_user_id: f.users.estoque, p_kind: d.kind, p_document_id: d.id, p_limit: 1 })).postings.length, 1);
  await readEffects(f, p.id);
});
test("documento: erros 22023 e papéis", async () => {
  for (const name of ["erp_document_stock_get", "erp_document_stock_list"]) {
    const a = { p_user_id: f.users.estoque, p_kind: d.kind, ...(name.endsWith("_get") ? { p_document_id: d.id } : {}) };
    for (const limit of [null, 0, 101]) await assert.rejects(f.rpc(name, { ...a, p_limit: limit }), error("erp_document_stock_invalid_query"));
    await assert.rejects(f.rpc(name, { ...a, p_kind: "x" }), error("erp_document_stock_invalid_kind"));
    for (const role of ["consulta", "vendas", "financeiro", "fiscal", "inactive"])
      await assert.rejects(f.rpc(name, { ...a, p_user_id: f.users[role] }), (e) => e.code === "42501");
  }
  for (const query of ["x\n", "a".repeat(101)])
    await assert.rejects(
      f.rpc("erp_document_stock_list", { p_user_id: f.users.estoque, p_kind: d.kind, p_query: query }),
      error("erp_document_stock_invalid_query"),
    );
  for (const name of ["erp_stock_document_warehouse_preview", "erp_stock_document_warehouse_post"]) {
    const a = { ...base(), ...(name.endsWith("_post") ? { p_command_id: randomUUID(), p_preview_hash: "0".repeat(64), p_ignored_item_ids: [] } : {}) };
    await assert.rejects(f.rpc(name, { ...a, p_warehouse_id: null }), error("erp_document_stock_warehouse_required"));
    await assert.rejects(f.rpc(name, { ...a, p_expected_version: null }), error("erp_document_stock_invalid_version"));
    for (const role of ["consulta", "vendas", "financeiro", "fiscal", "inactive"])
      await assert.rejects(f.rpc(name, { ...a, p_user_id: f.users[role] }), (e) => e.code === "42501");
  }
});

test("documento: guarda da lixeira e autoridade do espelho", async () => {
  const { seed } = await import("./invoice-fixture.mjs");
  const { insertPosting, audit } = await import("../../../src/erp/domains/stock/rpc/document-stock.ts");
  const { inTransaction } = await import("../../../src/erp/engine/registry.ts");
  const row = {
    document_id: d.id,
    document_version: d.version,
    movement_id: randomUUID(),
    snapshot: {},
    preview_hash: "0".repeat(64),
    actor: f.users.estoque,
    command_id: randomUUID(),
  };
  const insert = () =>
    f.dual(
      "document_posting_guard",
      () =>
        f.db.query(
          "insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id) values($1,$2,$3,$4,$5,$6,$7)",
          [row.document_id, row.document_version, row.movement_id, JSON.stringify(row.snapshot), row.preview_hash, row.actor, row.command_id],
        ),
      () => inTransaction(f.driver, (ctx) => insertPosting(ctx, row)),
    );
  await seed(f, "update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=$2,delete_reason='Teste da lixeira' where id=$1", [
    d.id,
    f.users.admin,
  ]);
  await assert.rejects(insert(), error("erp_document_deleted", "40001"));
  await seed(f, "update erp_documents.document set deleted_at=null,deleted_by=null,delete_reason=null,origin='origin',authority='origin' where id=$1", [d.id]);
  await assert.rejects(insert(), error("erp_document_mirror_effect_forbidden", "42501"));
  await assert.rejects(
    f.dual(
      "document_audit_guard",
      () =>
        f.db.query("insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values($1,$2,$3,$4,'post','{}')", [
          row.actor,
          row.command_id,
          d.id,
          randomUUID(),
        ]),
      () =>
        inTransaction(f.driver, (ctx) =>
          audit(ctx, { actor: row.actor, command: row.command_id, document: d.id, posting: randomUUID(), action: "post", result: {}, reason: null }),
        ),
    ),
    error("erp_document_mirror_effect_forbidden", "42501"),
  );
});

test("documento: reserva exige consumo e recebimento por item impede legado", async () => {
  const { seed } = await import("./invoice-fixture.mjs");
  const { insertPosting } = await import("../../../src/erp/domains/stock/rpc/document-stock.ts");
  const { inTransaction } = await import("../../../src/erp/engine/registry.ts");
  const reserved = await order(f, p, w, "sales_orders");
  await seed(f, "insert into erp_stock.reservation(document_id,source_document_version,snapshot,preview_hash,actor,command_id) values($1,$2,'{}',$3,$4,$5)", [
    reserved.id,
    reserved.version,
    "0".repeat(64),
    f.users.estoque,
    randomUUID(),
  ]);
  const check = async (doc, message) => {
    const r = {
      document_id: doc.id,
      document_version: doc.version,
      movement_id: randomUUID(),
      snapshot: {},
      preview_hash: "0".repeat(64),
      actor: f.users.estoque,
      command_id: randomUUID(),
    };
    await assert.rejects(
      f.dual(
        "document_posting_guard",
        () =>
          f.db.query(
            "insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id) values($1,$2,$3,$4,$5,$6,$7)",
            [r.document_id, r.document_version, r.movement_id, JSON.stringify(r.snapshot), r.preview_hash, r.actor, r.command_id],
          ),
        () => inTransaction(f.driver, (ctx) => insertPosting(ctx, r)),
      ),
      error(message, "40001"),
    );
  };
  await check(reserved, "erp_stock_use_reservation_consume");
  const purchase = await order(f, p, w),
    item = (await f.db.query("select id from erp_documents.item where document_id=$1", [purchase.id])).rows[0].id;
  await seed(f, "update erp_preferences.definition set default_value='\"data_documento\"' where key='estoque.data_lancamento'");
  const a = {
    p_user_id: f.users.estoque,
    p_document_id: purchase.id,
    p_expected_version: purchase.version,
    p_occurred_on: DAY,
    p_reason: "Recebimento por item",
    p_items: [{ item_id: item, quantity: "1" }],
  };
  const preview = (await f.rpc("erp_purchase_receipts_preview", a)).preview;
  await f.rpc("erp_purchase_receipts_receive", { ...a, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_confirm: true });
  await check(purchase, "purchase_receipt_legacy_mixing");
});
