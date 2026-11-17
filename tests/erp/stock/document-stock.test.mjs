// Lançamento de estoque de documento (rpc/document-stock.ts) no diferencial:
// conferência, lançamento, replay e estorno do pedido de compra; itens
// ignorados; lotes informados nos itens (296); estorno depois do balanço que
// mantém o saldo (224). O documento nasce pelo erp_document_save e pelo
// erp_document_transition do oráculo (não portados; estado espelhado).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, contact;
const code = (expected) => (error) => error.code === expected && true;
const message = (expected) => (error) => error.message === expected;
const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const sql = async (text, args = []) => {
  const r = await f.db.query(text, args);
  await f.sync();
  return r;
};
const meta = { p_occurred_on: "2026-10-15", p_reason: "Lançamento sintético do documento" };

before(async () => {
  f = await dualFixture();
  u = f.users;
  contact = await f.catalog("contacts", { name: "Fornecedor do documento", person_type: "J", roles: ["customer", "supplier"] });
});
after(() => f?.close());

const product = (name, extra = {}) => f.catalog("products", { name, unit: "UN", kind: "P", format: "S", price: "10", ...extra });
const warehouse = (name) => f.catalog("warehouses", { name });
const item = (p, quantity, extra = {}) => ({ product_id: p?.id ?? null, description: "Item sintético", unit: "UN", quantity, unit_price: "5", ...extra });
const docVersion = (id) => scalar("select version v from erp_documents.document where id=$1", [id]);
const balance = (p, w) => scalar("select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [p.id, w.id]);
const transition = async (doc, status) =>
  (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: status, p_reason: "Transição sintética" })).document;
async function order(kind, items, w, statuses = kind === "purchase_orders" ? ["in_progress"] : []) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: u.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: "2026-10-15", contact_id: contact.id, warehouse_id: w.id, items },
    })
  ).document;
  for (const s of statuses) d = await transition(d, s);
  return d;
}
const scope = async (doc, user = u.estoque) => ({ p_user_id: user, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: await docVersion(doc.id) });
const preview = async (doc, extra = {}) => (await f.rpc("erp_document_stock_preview", { ...(await scope(doc)), ...meta, ...extra })).preview;
async function post(doc, { prior = null, command = randomUUID(), extra = {} } = {}) {
  const p = prior ?? (await preview(doc));
  return f.rpc("erp_document_stock_post", { ...(await scope(doc)), ...meta, p_command_id: command, p_preview_hash: p.preview_hash, p_ignored_item_ids: p.ignored.map((i) => i.id), ...extra });
}
async function reverse(doc, { command = randomUUID(), extra = {}, day = "2026-10-16" } = {}) {
  const posting = (await f.db.query("select id::text, version from erp_stock.document_posting where document_id=$1 and state='active'", [doc.id])).rows[0];
  const input = { ...(await scope(doc)), p_posting_id: posting.id, p_posting_version: posting.version, p_occurred_on: day, p_reason: "Estorno sintético do documento" };
  const p = (await f.rpc("erp_document_stock_reverse_preview", input)).preview;
  return f.rpc("erp_document_stock_reverse", { ...input, p_command_id: command, p_preview_hash: p.preview_hash, ...extra });
}

test("pedido de compra: conferência, lançamento, replay e estorno", async () => {
  const p = await product("Peça do documento"),
    service = await product("Serviço do documento", { kind: "S" }),
    w = await warehouse("Depósito do documento");
  const doc = await order("purchase_orders", [item(p, "2.5"), item(service, "1"), item(null, "3", { description: "Sem vínculo" })], w);
  const shown = await preview(doc);
  assert.equal(shown.direction, "receipt");
  assert.equal(shown.positions.length, 1);
  assert.deepEqual(shown.ignored.map((i) => i.reason).sort(), ["service", "unlinked_item"]);
  // Os itens ignorados precisam do aceite; a conferência precisa do hash.
  await assert.rejects(post(doc, { prior: shown, extra: { p_ignored_item_ids: [] } }), message("erp_document_stock_ignored_ack_required"));
  await assert.rejects(post(doc, { prior: shown, extra: { p_preview_hash: "0".repeat(64) } }), message("erp_document_stock_preview_conflict"));
  await assert.rejects(post(doc, { prior: shown, extra: { p_occurred_on: "2026-10-14" } }), message("erp_document_stock_preview_conflict"));
  const command = randomUUID();
  const posted = await post(doc, { prior: shown, command });
  assert.equal(posted.replayed, false);
  assert.equal(await balance(p, w), "2.500000");
  // O mesmo comando com os mesmos dados devolve o resultado gravado.
  const again = await f.rpc("erp_document_stock_post", {
    p_user_id: u.estoque, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: posted.document_version - 1, ...meta,
    p_command_id: command, p_preview_hash: shown.preview_hash, p_ignored_item_ids: shown.ignored.map((i) => i.id),
  });
  assert.equal(again.replayed, true);
  await assert.rejects(preview(doc), message("erp_document_stock_already_posted"));
  // Data do estorno antes do lançamento; papel sem escrita.
  await assert.rejects(reverse(doc, { day: "2026-10-14" }), message("erp_stock_reversal_date_invalid"));
  await assert.rejects(f.rpc("erp_document_stock_preview", { ...(await scope(doc, u.consulta)), ...meta }), code("42501"));
  const reversed = await reverse(doc);
  assert.equal(reversed.posting.state, "reversed");
  assert.equal(await balance(p, w), "0.000000");
  await assert.rejects(reverse(doc), (e) => e instanceof TypeError || e.code !== undefined);
  // Lança de novo depois do estorno.
  await post(doc);
  assert.equal(await balance(p, w), "2.500000");
});

test("conferência recusa composição na compra, unidade diferente e documento fora da situação", async () => {
  const w = await warehouse("Depósito das recusas");
  const p = await product("Produto da unidade");
  const doc = await order("purchase_orders", [item(p, "1", { unit: "CX" })], w);
  await assert.rejects(preview(doc), message("erp_document_stock_unit_mismatch"));
  const open = await order("purchase_orders", [item(p, "1")], w, []);
  await assert.rejects(preview(open), message("erp_document_stock_ineligible_state"));
  await assert.rejects(preview(open, { p_reason: "x" }), message("erp_stock_invalid_command"));
});

test("lotes informados nos itens: entrada, estorno e recusas (296)", async () => {
  const p = await product("Produto com lote");
  const recordVersion = await scalar("select version v from erp_catalog.record where id=$1", [p.id]);
  await f.rpc("erp_catalog_product_save", { p_user_id: u.admin, p_id: p.id, p_expected_version: recordVersion, p_command_id: randomUUID(), p_data: { name: "Produto com lote", lot_control: true }, p_acknowledged: null });
  const lot = async (code) =>
    (await f.rpc("erp_stock_lot_save", { p_user_id: u.estoque, p_command_id: randomUUID(), p_product_id: p.id, p_lot_id: null, p_expected_version: 0, p_code: code, p_manufactured_on: null, p_expires_on: "2027-01-31", p_note: null })).lot;
  const a = await lot("b-lote"),
    b = await lot("A-lote");
  const w = await warehouse("Depósito dos lotes");
  const doc = await order("purchase_orders", [item(p, "3"), item(p, "2")], w);
  const items = (await f.db.query("select id::text from erp_documents.item where document_id=$1 order by position", [doc.id])).rows.map((r) => r.id);
  const inform = (id, lots) => sql("update erp_documents.item set data=jsonb_set(data,'{lots}',$2::jsonb) where id=$1", [id, JSON.stringify(lots)]);
  await inform(items[0], [{ lot_id: a.id, quantity: "4" }]);
  await assert.rejects(preview(doc), message("erp_document_stock_lots_exceed"));
  await inform(items[0], [{ lot_id: a.id, quantity: "1" }, { lot_id: a.id.toUpperCase(), quantity: "1" }]);
  await assert.rejects(preview(doc), message("erp_document_stock_lots_invalid"));
  await inform(items[0], [{ lot_id: a.id, quantity: "1.5" }, { lot_id: b.id, quantity: 1 }]);
  await inform(items[1], [{ lot_id: a.id, quantity: "2" }]);
  const shown = await preview(doc);
  assert.deepEqual(shown.positions[0].lots.map((l) => l.code), ["A-lote", "b-lote"]);
  await post(doc, { prior: shown });
  assert.equal(await scalar("select quantity::text v from erp_stock.lot_balance where lot_id=$1 and warehouse_id=$2", [a.id, w.id]), "3.500000");
  await reverse(doc);
  assert.equal(await scalar("select quantity::text v from erp_stock.lot_balance where lot_id=$1 and warehouse_id=$2", [a.id, w.id]), "0.000000");
});

test("estorno depois do balanço mantém o saldo com os ajustes de compensação (224)", async () => {
  const page = "suprimentos-estoque",
    key = "estoque.estorno_balanco";
  const current = (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: page })).items.find((i) => i.key === key);
  await f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value: false }]) });
  const p = await product("Produto do balanço"),
    w = await warehouse("Depósito do balanço");
  const doc = await order("purchase_orders", [item(p, "5")], w);
  await post(doc);
  // Um balanço da posição depois do lançamento (o movimento do ajuste e a contagem).
  const v = await scalar("select version v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [p.id, w.id]);
  const adjusted = await f.rpc("erp_stock_post", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: "adjustment", p_occurred_on: "2026-10-15", p_reason: "Balanço sintético", p_reference: null,
    p_items: [{ product_id: p.id, warehouse_id: w.id, quantity: "1", expected_version: v }],
  });
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query("insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source) values($1,$2,$3,6,5,'count')", [adjusted.movement.id, p.id, w.id]);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
  const reversed = await reverse(doc);
  assert.equal(await balance(p, w), "6.000000");
  assert.equal(reversed.movement.kind, "reversal");
});

test("pedido de venda: lançamento e estorno", { todo: "pendente da O: erp_finance.commission_operation_sync e erp_documents.cost_apply (gatilhos adiados do documento) são stubs; o pedido de venda e a OS saem 0A000 no motor" }, async () => {
  const p = await product("Produto da venda"),
    w = await warehouse("Depósito da venda");
  await f.rpc("erp_stock_post", { p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-14", p_reason: "Saldo inicial", p_reference: null, p_items: [{ product_id: p.id, warehouse_id: w.id, quantity: "10", expected_version: 0 }] });
  const doc = await order("sales_orders", [item(p, "2")], w);
  await post(doc);
  assert.equal(await balance(p, w), "8.000000");
  await reverse(doc);
});
