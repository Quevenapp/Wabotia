// Migrações 259/295 no diferencial, com notas semeadas como no Fiscal.
// O harness compara as tabelas tocadas; as leituras de saldo/extrato confirmam
// também os efeitos observáveis. Nenhum desvio de regra de negócio é aplicado.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import { invoice, product, seed, error, readEffects } from "./invoice-fixture.mjs";
let f, w, supplier;
before(async () => {
  for (const action of ["flags", "get", "preview", "post", "reverse_preview", "reverse", "units", "unit_save"]) assert.ok(isPorted(`erp_stock_invoice_${action}`));
  f = await dualFixture(); w = await f.catalog("warehouses", { name: "Estoque de notas" });
  supplier = await f.catalog("contacts", { name: "Fornecedor das conversões", person_type: "J", roles: ["supplier"] });
});
after(() => f?.close());
const call = (action, a) => f.rpc(`erp_stock_invoice_${action}`, { p_user_id: f.users.estoque, ...a });
const previewArgs = id => ({ p_invoice_id: id, p_expected_version: 1, p_warehouse_id: w.id });
const preview = async (id, extra = {}) => (await call("preview", { ...previewArgs(id), ...extra })).preview;
const factorArgs = (id, extra = {}) => ({ p_invoice_id: id, p_command_id: randomUUID(), p_position: 1, p_expected_version: 0, p_factor: "12", ...extra });
const note = (p, extra = {}) => invoice(f, { contact: supplier.id, items: [{ product_id: p.id, quantity: "2" }], ...extra });

test("nota: prévia, lançamento, idempotência, conflitos, estorno e novo lançamento", async () => {
  const p = await product(f), service = await product(f, { kind: "S" });
  const id = await note(p, { items: [{ product_id: p.id }, { product_id: p.id, quantity: "3" }, { product_id: service.id }, {}] });
  const empty = await call("get", { p_invoice_id: id });
  assert.equal(empty.flag.flag, null); assert.equal(empty.can_manage, true);
  const shown = await preview(id);
  assert.equal(shown.positions[0].quantity, "5.000000"); assert.equal(shown.ignored.length, 2);
  assert.deepEqual(await preview(id), shown);
  const a = { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: shown.preview_hash };
  await assert.rejects(call("post", { ...a, p_preview_hash: "0".repeat(64) }), error("erp_invoice_stock_preview_conflict", "40001"));
  await assert.rejects(preview(id, { p_expected_version: 2 }), error("erp_invoice_stock_version_conflict", "40001"));
  const posted = await call("post", a);
  assert.equal(posted.flag.flag, "S"); assert.equal(posted.posting.source, "invoice");
  assert.equal((await call("post", a)).replayed, true);
  await assert.rejects(call("post", { ...a, p_expected_version: 2 }), error("erp_invoice_stock_conflict", "40001"));
  await assert.rejects(preview(id), error("erp_invoice_stock_already_posted", "40001"));
  const flags = await call("flags", { p_ids: [randomUUID(), id] });
  assert.equal(flags.items.length, 1); assert.equal(flags.items[0].flag, "S");
  assert.equal((await call("get", { p_invoice_id: id })).block, "posted");
  await readEffects(f, p.id);
  const r = { p_invoice_id: id, p_posting_id: posted.posting.id, p_posting_version: 1 };
  await assert.rejects(call("reverse_preview", { ...r, p_posting_version: 2 }), error("erp_invoice_stock_version_conflict", "40001"));
  const rp = (await call("reverse_preview", r)).preview;
  assert.equal(rp.positions[0].quantity, "-5.000000");
  const ra = { ...r, p_command_id: randomUUID(), p_preview_hash: rp.preview_hash };
  await assert.rejects(call("reverse", { ...ra, p_preview_hash: "0".repeat(64) }), error("erp_invoice_stock_preview_conflict", "40001"));
  const reversed = await call("reverse", ra);
  assert.equal(reversed.flag.flag, null); assert.equal(reversed.posting.version, 2);
  assert.equal((await call("reverse", ra)).replayed, true);
  await assert.rejects(call("reverse", { ...ra, p_posting_version: 2 }), error("erp_invoice_stock_conflict", "40001"));
  await assert.rejects(call("reverse_preview", r), error("erp_invoice_stock_version_conflict", "40001"));
  await readEffects(f, p.id);
  assert.equal((await call("post", a)).flag.flag, null);
  const fresh = await preview(id);
  await call("post", { ...a, p_command_id: randomUUID(), p_preview_hash: fresh.preview_hash });
  await readEffects(f, p.id);
});

test("conversão do fornecedor: inclusão, alteração, remoção, recibos e prévia vencida", async () => {
  const p = await product(f), id = await note(p, { items: [{ product_id: p.id, unit: "CX" }] });
  assert.equal((await call("units", { p_invoice_id: id })).items[0].rule, null);
  await assert.rejects(preview(id), error("erp_invoice_stock_unit_mismatch"));
  const a = factorArgs(id), saved = await call("unit_save", a);
  assert.equal(saved.after.factor, "12.000000"); assert.equal(saved.units.items[0].converted_quantity, "24.000000");
  assert.equal((await call("unit_save", a)).replayed, true);
  await assert.rejects(call("unit_save", { ...a, p_factor: "6" }), error("erp_stock_unit_conversion_conflict", "40001"));
  await assert.rejects(call("unit_save", factorArgs(id)), error("erp_stock_unit_conversion_version_conflict", "40001"));
  await assert.rejects(call("unit_save", factorArgs(id, { p_expected_version: 1 })), error("erp_stock_unit_conversion_unchanged"));
  const old = await preview(id);
  const changed = await call("unit_save", factorArgs(id, { p_expected_version: 1, p_factor: "6" }));
  assert.equal(changed.after.version, 2);
  await assert.rejects(call("post", { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: old.preview_hash }), error("erp_invoice_stock_preview_conflict", "40001"));
  const fresh = await preview(id);
  assert.equal(fresh.positions[0].sources[0].factor, "6.000000");
  await call("post", { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: fresh.preview_hash });
  await readEffects(f, p.id);
  const removed = await call("unit_save", factorArgs(id, { p_expected_version: 2, p_factor: null }));
  assert.equal(removed.after, null); assert.equal(removed.units.items[0].rule, null);
});

test("unidade tributária, equivalência de unidade, conversão inexata e excessiva", async () => {
  const p = await product(f);
  const same = await note(p, { items: [{ product_id: p.id, unit: " un " }] });
  assert.equal((await call("units", { p_invoice_id: same })).total, 0);
  await preview(same);
  const tax = await note(p, { items: [{ product_id: p.id, unit: "CX", others: { tax_unit: "UN", tax_quantity: "24" } }] });
  assert.equal((await call("units", { p_invoice_id: tax })).items[0].rule, "tax_unit");
  assert.equal((await preview(tax)).positions[0].quantity, "24.000000");
  const inexact = await note(p, { items: [{ product_id: p.id, quantity: "0.0001", unit: "CX" }] });
  await call("unit_save", factorArgs(inexact, { p_factor: "0.000001" }));
  assert.equal((await call("units", { p_invoice_id: inexact })).items[0].problem, "inexact");
  await assert.rejects(preview(inexact), error("erp_invoice_stock_conversion_inexact"));
  await call("unit_save", factorArgs(inexact, { p_expected_version: 1, p_factor: "999999" }));
  const excess = await note(p, { items: [{ product_id: p.id, quantity: "99999999999", unit: "CX" }] });
  assert.equal((await call("units", { p_invoice_id: excess })).items[0].problem, "excess");
  await assert.rejects(preview(excess), error("erp_invoice_stock_conversion_inexact"));
});

test("cada RPC valida entrada e papéis de leitura/escrita", async () => {
  const p = await product(f), id = await note(p);
  for (const user of [f.users.admin, f.users.estoque, f.users.fiscal]) for (const [action, a] of [["flags", { p_ids: [id] }], ["get", { p_invoice_id: id }], ["units", { p_invoice_id: id }]]) await call(action, { ...a, p_user_id: user });
  const actions = { flags: { p_ids: [id] }, get: { p_invoice_id: id }, units: { p_invoice_id: id }, preview: previewArgs(id), post: { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) },
    reverse_preview: { p_invoice_id: id, p_posting_id: randomUUID(), p_posting_version: 1 }, reverse: { p_invoice_id: id, p_posting_id: randomUUID(), p_posting_version: 1, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }, unit_save: factorArgs(id) };
  for (const [action, a] of Object.entries(actions)) {
    const read = ["flags", "get", "units"].includes(action);
    for (const user of [f.users.consulta, f.users.vendas, f.users.financeiro, f.users.inactive, ...(read ? [] : [f.users.fiscal])]) await assert.rejects(call(action, { ...a, p_user_id: user }), error("erp_invoice_stock_access_denied", "42501"));
  }
  for (const ids of [null, [], {}, [null], ["x"], [id, id], Array(101).fill(id)]) await assert.rejects(call("flags", { p_ids: ids }), error("erp_stock_invalid_query"));
  await assert.rejects(call("units", { p_invoice_id: null }), error("erp_invoice_stock_invalid"));
  await assert.rejects(call("get", { p_invoice_id: null }), error("erp_invoice_not_found", "P0002"));
  for (const action of ["preview", "post"]) for (const patch of [{ p_expected_version: null }, { p_expected_version: 0 }, { p_warehouse_id: null }, { p_invoice_id: null }]) await assert.rejects(call(action, { ...actions[action], ...patch }), error("erp_invoice_stock_invalid"));
  for (const action of ["reverse_preview", "reverse"]) for (const patch of [{ p_posting_id: null }, { p_posting_version: null }, { p_posting_version: 0 }, { p_invoice_id: null }]) await assert.rejects(call(action, { ...actions[action], ...patch }), error("erp_invoice_stock_invalid"));
  for (const action of ["post", "reverse"]) for (const patch of [{ p_command_id: null }, { p_preview_hash: null }, { p_preview_hash: "invalid" }]) await assert.rejects(call(action, { ...actions[action], ...patch }), error("erp_invoice_stock_invalid"));
  for (const patch of [{ p_command_id: null }, { p_invoice_id: null }, { p_position: null }, { p_position: 0 }, { p_position: 991 }, { p_expected_version: null }, { p_expected_version: -1 }, { p_expected_version: 2147483647 }, { p_factor: null }, { p_factor: "0" }, { p_factor: "01" }, { p_factor: "1.0000001" }, { p_factor: "1000000" }]) await assert.rejects(call("unit_save", { ...actions.unit_save, ...patch }), error("erp_stock_unit_conversion_invalid"));
});

test("recusas da prévia e da conversão, inexistentes e colisão entre famílias", async () => {
  const p = await product(f), id = await note(p);
  await assert.rejects(preview(id, { p_warehouse_id: randomUUID() }), error("erp_stock_warehouse_unavailable"));
  await seed(f, "update erp_catalog.record set active=false where id=$1", [p.id]);
  await assert.rejects(preview(id), error("erp_stock_product_unavailable"));
  await seed(f, "update erp_catalog.record set active=true where id=$1", [p.id]);
  for (const status of [3, 10]) await assert.rejects(preview(await note(p, { status })), error("erp_invoice_stock_ineligible", "40001"));
  await assert.rejects(preview(await note(p, { items: [] })), error("erp_invoice_stock_ineligible", "40001"));
  const service = await product(f, { kind: "S" });
  await assert.rejects(preview(await note(service)), error("erp_invoice_stock_position_limit"));
  await assert.rejects(preview(await note(p, { direction: "1" })), error("erp_stock_insufficient_or_excess_quantity"));
  await assert.rejects(call("unit_save", factorArgs(id)), error("erp_stock_unit_conversion_unavailable"));
  const noSupplier = await note(p, { contact: null, items: [{ product_id: p.id, unit: "CX" }] });
  await assert.rejects(call("unit_save", factorArgs(noSupplier)), error("erp_stock_unit_conversion_unavailable"));
  await assert.rejects(call("unit_save", factorArgs(await note(p, { direction: "1" }))), error("erp_stock_unit_conversion_unavailable"));
  const missingProduct = await note(p, { items: [{}] });
  await assert.rejects(call("unit_save", factorArgs(missingProduct)), error("erp_stock_unit_conversion_unavailable"));
  const cx = await note(p, { items: [{ product_id: p.id, unit: "CX" }] });
  await assert.rejects(call("unit_save", factorArgs(cx, { p_position: 2 })), error("erp_invoice_item_not_found", "P0002"));
  const command = factorArgs(cx); await call("unit_save", command);
  await assert.rejects(call("post", { ...previewArgs(id), p_command_id: command.p_command_id, p_preview_hash: "0".repeat(64) }), error("erp_invoice_stock_conflict", "40001"));
  for (const action of ["get", "units"]) await assert.rejects(call(action, { p_invoice_id: randomUUID() }), error("erp_invoice_not_found", "P0002"));
});

test("kit na saída expande componentes; entrada e variação são recusadas", async () => {
  const component = await product(f), kit = await product(f, { format: "E" });
  await seed(f, "insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_at,updated_by,command_id) values($1,'virtual','components',1,now(),$2,$3)", [kit.id, f.users.admin, randomUUID()]);
  await seed(f, "insert into erp_stock.composition_item(product_id,version,position,component_id,quantity) values($1,1,1,$2,2.5)", [kit.id, component.id]);
  await assert.rejects(preview(await note(kit)), error("erp_invoice_stock_composition_unsupported"));
  await f.rpc("erp_stock_post", { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2024-09-01", p_reason: "Saldo para kit", p_reference: null,
    p_items: [{ product_id: component.id, warehouse_id: w.id, quantity: "10", expected_version: 0 }] });
  const id = await note(kit, { direction: "1" }), shown = await preview(id);
  assert.equal(shown.positions[0].product_id, component.id);
  assert.equal(shown.positions[0].quantity, "-5.000000");
  assert.equal(shown.positions[0].sources[0].component_quantity, "2.500000");
  await call("post", { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: shown.preview_hash });
  await readEffects(f, component.id);
  const variant = await product(f);
  await seed(f, "update erp_catalog.product set format='V' where record_id=$1", [variant.id]);
  await assert.rejects(preview(await note(variant)), error("erp_invoice_stock_composition_unsupported"));
});

test("referência lançada e reserva impedem duplicar o estoque da nota", async () => {
  const p = await product(f);
  const doc = (await f.rpc("erp_document_save", { p_user_id: f.users.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2024-09-01", contact_id: supplier.id, warehouse_id: w.id, items: [{ product_id: p.id, description: "Pedido", unit: "UN", quantity: "2", unit_price: "5" }] } })).document;
  const changed = (await f.rpc("erp_document_transition", { p_user_id: f.users.admin, p_kind: "purchase_orders", p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Iniciar compra" })).document;
  const a = { p_user_id: f.users.estoque, p_kind: "purchase_orders", p_document_id: doc.id, p_expected_version: changed.version, p_occurred_on: "2024-09-01", p_reason: "Entrada pelo pedido" };
  const shown = (await f.rpc("erp_document_stock_preview", a)).preview;
  await f.rpc("erp_document_stock_post", { ...a, p_command_id: randomUUID(), p_preview_hash: shown.preview_hash, p_ignored_item_ids: [] });
  const id = await note(p);
  await seed(f, "insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [id, doc.id]);
  assert.equal((await call("get", { p_invoice_id: id })).flag.flag, "R");
  await assert.rejects(preview(id), error("erp_invoice_stock_posted_by_reference", "40001"));
  const checkin = await f.rpc("erp_stock_checkin_get", { p_user_id: f.users.estoque, p_invoice_id: id });
  assert.deepEqual(checkin.items[0].requested, { quantity: "2.0000", prices: ["5.0000000000"] });
  const customer = await f.catalog("contacts", { name: "Cliente da reserva", person_type: "J", roles: ["customer"] });
  const sales = (await f.rpc("erp_document_save", { p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2024-09-01", contact_id: customer.id, warehouse_id: w.id, items: [{ product_id: p.id, description: "Reservado", unit: "UN", quantity: "1", unit_price: "5" }] } })).document;
  // A leitura exige somente o vínculo e a reserva ativa; semeamos esse estado.
  await seed(f, "insert into erp_stock.reservation(document_id,source_document_version,snapshot,preview_hash,actor,command_id) values($1,1,'{}',$2,$3,$4)", [sales.id, "a".repeat(64), f.users.estoque, randomUUID()]);
  const reserved = await note(p, { direction: "1" });
  await seed(f, "insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [reserved, sales.id]);
  assert.equal((await call("get", { p_invoice_id: reserved })).block, "reserved");
  await assert.rejects(preview(reserved), error("erp_invoice_stock_reserved_document", "40001"));
});

test("estorno recusa quantidade consumida; colisão de comando não altera saldo", async () => {
  const p = await product(f), id = await note(p), shown = await preview(id);
  const a = { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: shown.preview_hash };
  const posted = await call("post", a);
  await f.rpc("erp_stock_post", { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: "issue", p_occurred_on: "2024-09-01", p_reason: "Consumo da entrada", p_reference: null,
    p_items: [{ product_id: p.id, warehouse_id: w.id, quantity: "-2", expected_version: 1 }] });
  const r = { p_invoice_id: id, p_posting_id: posted.posting.id, p_posting_version: 1 };
  await assert.rejects(call("reverse_preview", r), error("erp_stock_insufficient_or_excess_quantity"));
  await assert.rejects(call("reverse", { ...r, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }), error("erp_stock_insufficient_or_excess_quantity"));
  await assert.rejects(call("unit_save", factorArgs(id, { p_command_id: a.p_command_id })), error("erp_stock_unit_conversion_conflict", "40001"));
  await readEffects(f, p.id);
});

test("soma por produto preserva o overflow do cast numeric(18,6)", async () => {
  const p = await product(f), id = await note(p, { items: Array.from({ length: 11 }, () => ({ product_id: p.id, quantity: "99999999999" })) });
  await assert.rejects(preview(id), error("numeric field overflow", "22003"));
  await assert.rejects(call("post", { ...previewArgs(id), p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }), error("numeric field overflow", "22003"));
});
