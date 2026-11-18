// Os gatilhos de erp_documents.document e de erp_documents.audit contra o oráculo, para todo
// escritor: o UPDATE do documento passa sempre por documents/rows.ts updateDocument (nenhum
// UPDATE, INSERT ou DELETE cru em erp_documents__document fora de rows.ts), que roda os BEFORE
// na ordem do nome, o UPDATE, os AFTER e enfileira os adiados. No oráculo o UPDATE roda com os
// gatilhos ligados numa transação desfeita; no motor, o updateDocument numa transação desfeita.
// Cobre: aa_mirror_authority (espelhado só leitura, identidade imutável), guard_trash,
// protect_document_finance, protect_document_stock, protect_reserved_document,
// protect_purchase_receipt_document, a ordem entre eles, e os adiados commission_operation_capture
// e cost_apply_capture enfileirados por tipo. A auditoria: guard_effect recusa documento espelhado.
// O resultado das capturas está em commission-operation.test.mjs e cost-apply.test.mjs; o
// ab_origin_effects e o zz_origin_sync com o Origin fora, em ../sync/origin-off.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { updateDocument, mirrorGuardEffect } from "../../../src/erp/domains/documents/public.ts";

let f, u, contact, product, warehouse;
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};
const HASH = "a".repeat(64);

before(async () => {
  f = await dualFixture();
  u = f.users;
  contact = await f.catalog("contacts", { name: "Cliente dos gatilhos", person_type: "J", roles: ["customer", "supplier"] });
  product = await f.catalog("products", { name: "Produto dos gatilhos", unit: "UN", kind: "P", format: "S", price: "5" });
  warehouse = await f.catalog("warehouses", { name: "Depósito dos gatilhos" });
});
after(() => f?.close());

let number = 700;
/** Documento com o efeito dado: posting (Estoque), finance, reservation, receipt, trash, mirror ou nenhum. */
async function documentWith(kind, effect, status = "open") {
  const id = randomUUID();
  const body = { notes: "nota", internal_notes: "interna", contact_id: contact.id, warehouse_id: warehouse.id, discount: "0" };
  const authority = effect === "mirror" ? "origin" : "brufap";
  const origin = effect === "mirror" ? "origin" : "brufap";
  await seed(
    `insert into erp_documents.document(id,kind,number,version,status,contact_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
     values($1,$2,$3,1,$4,$5,'{"name":"Cliente"}',$6::jsonb,10,$7,$7,$8,$9)`,
    [id, kind, number++, status, contact.id, JSON.stringify(body), u.admin, origin, authority],
  );
  const movement = async () =>
    (await f.rpc("erp_stock_post", {
      p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2024-10-15", p_reason: "Efeito",
      p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "1", expected_version: (await f.db.query("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [product.id, warehouse.id])).rows[0].v }],
      p_reference: null,
    })).movement.id;
  if (effect === "posting")
    await seed(
      `insert into erp_stock.document_posting(id,document_id,document_version,movement_id,state,version,snapshot,preview_hash,actor,command_id) values(gen_random_uuid(),$1,1,$2,'active',1,'{}',$3,$4,gen_random_uuid())`,
      [id, await movement(), HASH, u.admin],
    );
  if (effect === "finance")
    await seed(
      `insert into erp_finance.document_posting(id,document_id,document_version,group_id,state,version,snapshot,preview_hash,actor,command_id) values(gen_random_uuid(),$1,1,gen_random_uuid(),'active',1,'{}',$2,$3,gen_random_uuid())`,
      [id, HASH, u.admin],
    );
  if (effect === "reservation")
    await seed(
      `insert into erp_stock.reservation(id,document_id,source_document_version,version,state,snapshot,preview_hash,actor,command_id) values(gen_random_uuid(),$1,1,1,'active','{}',$2,$3,gen_random_uuid())`,
      [id, HASH, u.admin],
    );
  if (effect === "receipt")
    await seed(
      `insert into erp_purchase_receipts.receipt(id,document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash) values(gen_random_uuid(),$1,1,2,gen_random_uuid(),$2,$3,'{}',$4)`,
      [id, await movement(), u.admin, HASH],
    );
  if (effect === "trash") await seed(`update erp_documents.document set deleted_at=now(), deleted_by=$2, delete_reason='Teste da lixeira' where id=$1`, [id, u.admin]);
  return id;
}

/** Resultado do UPDATE com os gatilhos no oráculo, desfeito. */
async function pgOutcome(sql, args) {
  await f.db.exec("begin");
  try {
    await f.db.query(sql, args);
    return "ok";
  } catch (e) {
    return e.message;
  } finally {
    await f.db.exec("rollback");
  }
}
const ROLLBACK = new Error("desfaz");
/** Resultado do updateDocument no motor, desfeito; devolve também os adiados enfileirados. */
function liteOutcome(fn) {
  let queued = null;
  try {
    inTransaction(f.driver, (ctx) => {
      fn(ctx);
      queued = ctx.deferred.length;
      ctx.deferred.length = 0;
      throw ROLLBACK;
    }, f.clock);
  } catch (e) {
    if (e !== ROLLBACK && e?.message !== "desfaz") return { outcome: e.message, queued };
  }
  return { outcome: "ok", queued };
}
const docRow = (id) => f.driver.exec('SELECT * FROM "erp_documents__document" WHERE id=?', id).rows[0];

/** Casos: [rótulo, SQL do oráculo, set do motor]. */
function cases(id) {
  const o = docRow(id);
  const body = JSON.parse(o.body);
  return [
    ["observações", `update erp_documents.document set body=body||'{"notes":"outra"}'::jsonb, version=version+1, updated_at=now() where id=$1`, { body: JSON.stringify({ ...body, notes: "outra" }), version: Number(o.version) + 1, updated_at: f.clock.next().toString() }],
    ["total", `update erp_documents.document set total=11 where id=$1`, { total: 1100 }],
    ["situação cancelado", `update erp_documents.document set status='cancelled' where id=$1`, { status: "cancelled" }],
    ["tipo", `update erp_documents.document set kind='sales_proposals' where id=$1`, { kind: "sales_proposals" }],
    ["autoridade", `update erp_documents.document set authority='origin' where id=$1`, { authority: "origin" }],
    ["restaurar", `update erp_documents.document set deleted_at=null, deleted_by=null, delete_reason=null where id=$1`, { deleted_at: null, deleted_by: null, delete_reason: null }],
    ["restaurar com total", `update erp_documents.document set deleted_at=null, deleted_by=null, delete_reason=null, total=12 where id=$1`, { deleted_at: null, deleted_by: null, delete_reason: null, total: 1200 }],
    ["excluir", `update erp_documents.document set deleted_at=now(), deleted_by=$2, delete_reason='Teste da lixeira' where id=$1`, { deleted_at: f.clock.next().toString(), deleted_by: u.admin, delete_reason: "Teste da lixeira" }, [u.admin]],
  ];
}

test("updateDocument: os BEFORE de document na ordem do oráculo, para cada efeito", async () => {
  const seen = new Set();
  for (const [kind, effect] of [
    ["sales_orders", null], ["sales_orders", "mirror"], ["sales_orders", "trash"], ["sales_orders", "finance"], ["sales_orders", "posting"],
    ["sales_orders", "reservation"], ["purchase_orders", "receipt"], ["purchase_orders", "posting"], ["service_orders", "finance"],
  ]) {
    const id = await documentWith(kind, effect);
    for (const [label, sql, set, extra = []] of cases(id)) {
      const want = await pgOutcome(sql, [id, ...extra]);
      const got = liteOutcome((ctx) => updateDocument(ctx, id, set)).outcome;
      assert.equal(got, want, `${kind}/${effect ?? "sem efeito"}: ${label}`);
      seen.add(want);
    }
  }
  // Cada gatilho recusou ao menos uma vez nos dois motores.
  for (const message of [
    "erp_document_mirror_readonly", "erp_document_mirror_identity_immutable", "erp_document_deleted", "erp_document_active_finance",
    "erp_document_active_stock", "erp_document_active_reservation", "purchase_receipt_active",
  ])
    assert.ok(seen.has(message), `${message} não apareceu: ${[...seen].join(", ")}`);
});

test("updateDocument: commission_operation_capture e cost_apply_capture enfileirados por tipo", async () => {
  for (const [kind, want] of [["sales_orders", 2], ["service_orders", 1], ["purchase_orders", 0], ["sales_proposals", 0]]) {
    const id = await documentWith(kind, null);
    const o = docRow(id);
    const r = liteOutcome((ctx) => updateDocument(ctx, id, { body: o.body, version: Number(o.version) + 1 }));
    assert.equal(r.outcome, "ok", kind);
    assert.equal(r.queued, want, kind);
  }
});

test("auditoria: aa_mirror_authority (guard_effect) recusa documento espelhado", async () => {
  for (const effect of ["mirror", null]) {
    const id = await documentWith("sales_orders", effect);
    const want = await pgOutcome(
      `insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data) values($1,gen_random_uuid(),$2,'update','Teste','{}')`,
      [u.admin, id],
    );
    const got = liteOutcome((ctx) => mirrorGuardEffect(ctx.db, id)).outcome;
    assert.equal(got, want, `auditoria ${effect ?? "nativo"}`);
  }
});
