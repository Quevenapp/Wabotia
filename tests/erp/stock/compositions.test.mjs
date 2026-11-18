import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { product, error, readEffects, seed, invoice } from "./invoice-fixture.mjs";
let f, p, k, w;
before(async () => {
  f = await dualFixture();
  p = await product(f, { name: "Componente Árvore" });
  k = await product(f, { name: "Kit composição", format: "E" });
  w = await f.catalog("warehouses", { name: "Depósito composição" });
});
after(() => f?.close());
const call = (name, a) => f.rpc("erp_stock_" + name, { p_user_id: f.users.admin, ...a });
const compose = (extra = {}) => ({
  p_id: k.id,
  p_expected_version: k.version,
  p_command_id: randomUUID(),
  p_data: { name: "Kit composição salvo" },
  p_acknowledged: [],
  p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items: [{ component_id: p.id, quantity: "2" }] },
  ...extra,
});
test("composição: salvar, ler, exportar, procurar, lançar, replay, CAS e efeitos", async () => {
  const a = compose(),
    saved = await call("product_compose", a);
  assert.equal(saved.composition.version, 1);
  assert.equal((await call("product_compose", a)).replayed, true);
  await assert.rejects(call("product_compose", { ...a, p_data: { name: "Outro kit" } }), error("erp_stock_composition_conflict", "40001"));
  await assert.rejects(
    call("product_compose", compose({ p_expected_version: saved.record.version })),
    error("erp_stock_composition_version_conflict", "40001"),
  );
  const got = await call("composition_get", { p_product_id: k.id });
  assert.equal(got.items[0].quantity, "2.000000");
  assert.ok((await call("composition_components", { p_query: "árvore" })).items.some((x) => x.id === p.id));
  assert.equal((await call("composition_export", {})).items[0].component_id, p.id);
  const launch = {
    p_command_id: randomUUID(),
    p_kind: "receipt",
    p_product_id: k.id,
    p_warehouse_id: w.id,
    p_quantity: "3",
    p_expected_version: 0,
    p_unit_price: "5.125",
    p_unit_cost: "3",
    p_note: "Montagem",
  };
  const posted = await call("composition_launch", launch);
  assert.equal(posted.lines.length, 2);
  assert.equal((await call("composition_launch", launch)).replayed, true);
  await assert.rejects(call("composition_launch", { ...launch, p_quantity: "4" }), error("erp_stock_launch_conflict", "40001"));
  await assert.rejects(call("composition_launch", { ...launch, p_command_id: randomUUID() }), error("erp_stock_version_conflict", "40001"));
  assert.equal((await call("composition_launches", { p_product_id: k.id })).total, 1);
  await readEffects(f, k.id);
  await readEffects(f, p.id);
});
test("composição: consultas inválidas e papéis", async () => {
  for (const [name, a] of [
    ["composition_get", { p_product_id: null }],
    ["composition_components", { p_query: "" }],
    ["composition_components", { p_query: "x\n" }],
    ["composition_export", { p_offset: -1 }],
    ["composition_export", { p_limit: 501 }],
    ["composition_export", { p_include_deleted: null }],
    ["composition_launches", { p_product_id: k.id, p_limit: 21 }],
  ])
    await assert.rejects(call(name, a), error("erp_stock_invalid_query"));
  for (const name of ["composition_get", "composition_launches"])
    await assert.rejects(call(name, { p_product_id: randomUUID() }), error("erp_stock_product_not_found", "P0002"));
  for (const role of ["admin", "consulta", "vendas", "estoque", "fiscal", "financeiro"]) {
    // O Catálogo decide os papéis das três leituras; f.rpc compara também recusas.
    for (const [name, a] of [
      ["composition_get", { p_product_id: k.id }],
      ["composition_components", { p_query: "Componente" }],
      ["composition_export", {}],
      ["composition_launches", { p_product_id: k.id }],
    ])
      try {
        await call(name, { ...a, p_user_id: f.users[role] });
      } catch (e) {
        assert.equal(e.code, "42501");
      }
  }
  await assert.rejects(call("composition_get", { p_product_id: k.id, p_user_id: f.users.inactive }), (e) => e.code === "42501");
});
test("composição: validação da estrutura e lançamento", async () => {
  for (const patch of [
    { p_command_id: null },
    { p_data: null },
    { p_expected_version: null },
    { p_composition: {} },
    { p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "both", items: [] } },
  ])
    await assert.rejects(call("product_compose", compose(patch)), error("erp_stock_composition_invalid"));
  for (const items of [
    [{ component_id: k.id, quantity: "1" }],
    [{ component_id: p.id, quantity: "0" }],
    [{ component_id: p.id, quantity: 1 }],
    [{ component_id: p.id, quantity: "1", extra: 1 }],
    [
      { component_id: p.id, quantity: "1" },
      { component_id: p.id, quantity: "1" },
    ],
  ])
    await assert.rejects(
      call("product_compose", compose({ p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items } })),
      error("erp_stock_composition_invalid"),
    );
  await assert.rejects(
    call(
      "product_compose",
      compose({ p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items: [{ component_id: randomUUID(), quantity: "1" }] } }),
    ),
    error("erp_stock_composition_component_unavailable"),
  );
  const a = { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: k.id, p_warehouse_id: w.id, p_quantity: "1", p_expected_version: 0 };
  for (const patch of [
    { p_quantity: "0" },
    { p_quantity: "1.0000001" },
    { p_kind: null },
    { p_command_id: null },
    { p_warehouse_id: null },
    { p_expected_version: -1 },
    { p_note: "x\n" },
    { p_kind: "issue", p_unit_cost: "1" },
  ])
    await assert.rejects(call("composition_launch", { ...a, ...patch }), error("erp_stock_launch_invalid"));
  await assert.rejects(call("composition_launch", { ...a, p_unit_price: "x" }), error("erp_stock_price_invalid"));
  await assert.rejects(call("composition_launch", { ...a, p_product_id: p.id }), error("erp_stock_product_unavailable"));
  for (const role of ["consulta", "vendas", "financeiro", "fiscal", "inactive"])
    await assert.rejects(call("composition_launch", { ...a, p_user_id: f.users[role] }), (e) => e.code === "42501");
});
test("composição virtual, criação e recalcular valores pelos componentes", async () => {
  const a = {
    p_id: null,
    p_expected_version: 0,
    p_command_id: randomUUID(),
    p_data: { name: "Kit virtual novo", unit: "UN", kind: "P", format: "E", price: "5" },
    p_acknowledged: [],
    p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "components", items: [{ component_id: p.id, quantity: "2" }] },
  };
  const saved = await call("product_compose", a),
    id = saved.record.id;
  assert.equal((await call("product_compose", a)).replayed, true);
  const launch = { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: id, p_warehouse_id: w.id, p_quantity: "1.5", p_expected_version: 0 };
  await assert.rejects(call("composition_launch", { ...launch, p_unit_price: "1" }), error("erp_stock_launch_invalid"));
  await call("composition_launch", launch);
  const got = await call("composition_get", { p_product_id: id });
  assert.equal(got.virtual.quantity, "4.000000");
  await seed(f, "update erp_preferences.definition set default_value='true' where key in ('produtos.composicao_preco','produtos.composicao_peso')");
  const version = (await f.db.query("select version from erp_catalog.record where id=$1", [p.id])).rows[0].version;
  const sync = {
    p_id: p.id,
    p_expected_version: version,
    p_command_id: randomUUID(),
    p_data: { price: "12.345", net_weight: "0.5", gross_weight: "0.6" },
    p_acknowledged: [],
    p_composition: null,
  };
  const changed = await call("product_compose", sync);
  assert.ok(changed.synced.some((x) => x.product_id === id));
  await call("composition_get", { p_product_id: id });
  await readEffects(f, p.id);
});
test("composição: formato, saldo próprio, componente indisponível e precisão", async () => {
  const simple = await product(f),
    other = await product(f, { format: "E" });
  await assert.rejects(
    call("product_compose", { ...compose(), p_id: simple.id, p_expected_version: simple.version, p_data: { name: "Ainda simples" } }),
    error("erp_stock_composition_format_required"),
  );
  const current = await call("composition_get", { p_product_id: k.id });
  await assert.rejects(
    call(
      "product_compose",
      compose({
        p_expected_version: current.product.version,
        p_data: { name: "Kit virtual recusado" },
        p_composition: {
          expected_version: current.composition.version,
          stock_type: "virtual",
          post_mode: "components",
          items: [{ component_id: p.id, quantity: "1" }],
        },
      }),
    ),
    error("erp_stock_composition_has_stock"),
  );
  const a = {
    p_id: other.id,
    p_expected_version: other.version,
    p_command_id: randomUUID(),
    p_data: { name: "Kit fracionário" },
    p_acknowledged: [],
    p_composition: { expected_version: 0, stock_type: "physical", post_mode: "components", items: [{ component_id: p.id, quantity: "0.000001" }] },
  };
  await call("product_compose", a);
  await assert.rejects(
    call("composition_launch", {
      p_command_id: randomUUID(),
      p_kind: "receipt",
      p_product_id: other.id,
      p_warehouse_id: w.id,
      p_quantity: "0.000001",
      p_expected_version: 0,
    }),
    error("erp_stock_composition_quantity_precision"),
  );
});

let documentNumber = 8000;
async function componentDocument({ kind = "sales_orders", status = "in_progress", productId = k.id, warehouse = w.id } = {}) {
  const id = randomUUID(), item = randomUUID();
  const contact = await f.catalog("contacts", { name: "Cliente dos componentes", person_type: "J", roles: ["customer"] });
  await seed(f, `insert into erp_documents.document(id,kind,number,version,status,contact_id,contact_snapshot,warehouse_id,body,total,created_by,updated_by)
    values($1,$2,$3,1,$4,$5,'{"name":"Cliente"}',$6,$7,20,$8,$8)`,
    [id, kind, documentNumber++, status, contact.id, warehouse, JSON.stringify({ date: "2026-10-15", contact_id: contact.id, warehouse_id: warehouse }), f.users.admin]);
  await seed(f, `insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,data)
    values($1,$2,1,$3,2,10,'{"description":"Kit no documento","unit":"UN"}')`, [item, id, productId]);
  return { id, item, kind };
}
const componentsRead = (d, extra = {}) => call("item_components", { p_document_id: d.id, p_item_id: d.item, ...extra });
const componentsArgs = (d, extra = {}) => ({
  p_command_id: randomUUID(), p_document_id: d.id, p_expected_document_version: 1, p_item_id: d.item, p_expected_version: 0,
  p_components: [{ component_id: p.id, quantity: "3.25" }], ...extra,
});
const componentsSave = (d, extra = {}) => call("item_components_save", componentsArgs(d, extra));
const componentsPreview = async (d, version) => (await f.rpc("erp_document_stock_preview", {
  p_user_id: f.users.admin, p_kind: d.kind, p_document_id: d.id, p_expected_version: version,
  p_occurred_on: "2026-10-15", p_reason: "Conferir componentes do item",
})).preview;

test("componentes do item: leitura, inserir/alterar/restaurar, replay, CAS, auditoria e prévia do mesmo documento", async () => {
  // Saldo suficiente para conferir tanto o kit como seus componentes, sem mudar política.
  for (const id of [p.id, k.id]) await call("post", {
    p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-15", p_reason: "Saldo para componentes",
    p_items: [{ product_id: id, warehouse_id: w.id, quantity: "100", expected_version: (await f.db.query("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [id, w.id])).rows[0].v }],
  });
  for (const kind of ["sales_orders", "service_orders"]) {
    const d = await componentDocument({ kind });
    const initial = await componentsRead(d);
    assert.equal(initial.edited, false);
    assert.equal(initial.version, 0);
    assert.equal(initial.editable, true);
    assert.equal(initial.components[0].quantity, "2.000000");
    assert.equal(initial.components[0].total, "4.000000000000");
    const original = await componentsPreview(d, 1);
    const a = componentsArgs(d);
    const saved = await call("item_components_save", a);
    assert.equal(saved.replayed, false);
    assert.equal(saved.version, 1);
    assert.equal(saved.document.version, 2);
    assert.equal(saved.components[0].total, "6.500000000000");
    const replay = await call("item_components_save", a);
    assert.deepEqual(replay, { ...saved, replayed: true });
    await assert.rejects(call("item_components_save", { ...a, p_components: [{ component_id: p.id, quantity: "4" }] }), error("erp_stock_item_components_conflict", "40001"));
    await assert.rejects(call("item_components_save", { ...a, p_user_id: f.users.vendas }), error("erp_stock_item_components_conflict", "40001"));
    await assert.rejects(componentsSave(d), error("erp_document_version_conflict", "40001"));
    await assert.rejects(componentsSave(d, { p_expected_document_version: 2 }), error("erp_stock_item_components_version_conflict", "40001"));
    const reread = await componentsRead(d);
    assert.deepEqual(reread.components, saved.components);
    const edited = await componentsPreview(d, 2);
    assert.notEqual(edited.preview_hash, original.preview_hash);
    assert.equal(edited.positions.find((x) => x.product_id === p.id).quantity, "-6.500000");
    await assert.rejects(componentsPreview(d, 1), error("erp_document_version_conflict", "40001"));
    const changed = await componentsSave(d, { p_expected_document_version: 2, p_expected_version: 1, p_components: [{ component_id: p.id, quantity: "4" }] });
    assert.equal(changed.version, 2);
    assert.equal(changed.document.version, 3);
    assert.deepEqual((await componentsRead(d)).components, changed.components);
    assert.equal((await componentsPreview(d, 3)).positions.find((x) => x.product_id === p.id).quantity, "-8.000000");
    await assert.rejects(componentsSave(d, { p_expected_document_version: 3, p_expected_version: 1 }), error("erp_stock_item_components_version_conflict", "40001"));
    const restore = componentsArgs(d, { p_expected_document_version: 3, p_expected_version: 2, p_components: null });
    const restored = await call("item_components_save", restore);
    assert.equal(restored.restored, true);
    assert.equal(restored.edited, false);
    assert.equal(restored.version, 0);
    assert.equal(restored.document.version, 4);
    assert.deepEqual((await componentsRead(d)).components, initial.components);
    assert.equal((await componentsPreview(d, 4)).positions.find((x) => x.product_id === p.id).quantity, "-4.000000");
    assert.equal((await call("item_components_save", restore)).replayed, true);
    // Replay antigo continua devolvendo o recibo original, mesmo depois de restaurar.
    assert.deepEqual(await call("item_components_save", a), { ...saved, replayed: true });
    const audits = (await f.db.query("select action,before_data,after_data from erp_documents.audit where document_id=$1 order by id", [d.id])).rows;
    assert.equal(audits.length, 3);
    assert.ok(audits.every((x) => x.action === "kit_components"));
    assert.deepEqual(audits[0].before_data.components, initial.components);
    assert.deepEqual(audits[2].after_data.components, initial.components);
    assert.equal((await call("composition_get", { p_product_id: k.id })).items[0].quantity, "2.000000");
  }
});

test("componentes do item: cada 22023, limites e documentos/itens ausentes", async () => {
  const d = await componentDocument();
  for (const patch of [{ p_document_id: null }, { p_item_id: null }])
    await assert.rejects(componentsRead(d, patch), error("erp_stock_invalid_query"));
  for (const patch of [
    { p_command_id: null }, { p_document_id: null }, { p_item_id: null },
    ...[null, 0, -1, 2147483647].map((v) => ({ p_expected_document_version: v })),
    ...[null, -1, 2147483647].map((v) => ({ p_expected_version: v })),
    ...[{}, [], Array.from({ length: 101 }, () => ({ component_id: p.id, quantity: "1" })),
      [{ component_id: p.id, quantity: "1" }, { component_id: p.id, quantity: "2" }],
      [{ component_id: p.id, quantity: "1", extra: true }],
      ...[null, "x", 1, [], {}].map((j) => [j]),
      ...[null, 1, "x", p.id.toUpperCase()].map((id) => [{ component_id: id, quantity: "1" }]),
      ...[null, 1, "0", "0.000000", "-1", "01", "1e2", "1.0000001", "1000000000000"].map((quantity) => [{ component_id: p.id, quantity }]),
    ].map((p_components) => ({ p_components })),
  ]) await assert.rejects(componentsSave(d, patch), error("erp_stock_item_components_invalid"));
  for (const value of [null, [{ component_id: p.id, quantity: "2.0" }]])
    await assert.rejects(componentsSave(d, { p_components: value }), error("erp_stock_item_components_unchanged"));
  const inactive = await product(f), service = await product(f, { kind: "S" });
  await seed(f, "update erp_catalog.record set active=false where id=$1", [inactive.id]);
  for (const id of [randomUUID(), k.id, inactive.id, service.id])
    await assert.rejects(componentsSave(d, { p_components: [{ component_id: id, quantity: "1" }] }), error("erp_stock_composition_component_unavailable"));
  for (const name of ["item_components", "item_components_save"]) {
    const a = name.endsWith("_save") ? componentsArgs(d) : { p_document_id: d.id, p_item_id: d.item };
    await assert.rejects(call(name, { ...a, p_document_id: randomUUID() }), error("erp_document_not_found", "P0002"));
    await assert.rejects(call(name, { ...a, p_item_id: randomUUID() }), error("erp_document_item_not_found", "P0002"));
    const purchase = await componentDocument({ kind: "purchase_orders" });
    await assert.rejects(call(name, { ...a, p_document_id: purchase.id, p_item_id: purchase.item }), error("erp_document_not_found", "P0002"));
  }
  assert.equal((await componentsRead(d)).version, 0);
});

test("componentes do item: cada situação recusada por editable e acesso por papel", async () => {
  for (const status of ["approved", "fulfilled", "finalized", "no_repair", "cancelled", "rejected", "service_done", "partially_invoiced"]) {
    const d = await componentDocument({ kind: ["approved", "finalized", "no_repair", "service_done", "rejected"].includes(status) ? "service_orders" : "sales_orders", status });
    assert.equal((await componentsRead(d)).reason_code, "locked", status);
    await assert.rejects(componentsSave(d), error("erp_stock_item_components_locked", "40001"));
    assert.equal((await componentsRead(d)).document.version, 1);
  }
  // completed só existe em proposta, fora dos dois tipos aceitos pelos RPCs.
  // A interna também deve classificá-la como locked; o save recusa o tipo primeiro.
  const completed = await componentDocument({ kind: "sales_proposals", status: "completed" });
  await assert.rejects(componentsSave(completed), error("erp_document_not_found", "P0002"));
  const { itemComponentsDto } = await import("../../../src/erp/domains/stock/rpc/item-components.ts");
  const dto = await f.dual("item_components_dto_completed",
    async () => (await f.db.query("select erp_stock.item_components_dto($1,$2,$3) r", [f.users.admin, completed.id, completed.item])).rows[0].r,
    () => itemComponentsDto(f.driver, f.users.admin, completed.id, completed.item));
  assert.equal(dto.reason_code, "locked");
  for (const kind of ["sales_orders", "service_orders"]) {
    for (const role of ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal", "inactive"]) {
      const d = await componentDocument({ kind });
      const canRead = role !== "inactive" && (kind === "sales_orders" || !["estoque", "fiscal"].includes(role));
      if (canRead) {
        const got = await componentsRead(d, { p_user_id: f.users[role] });
        assert.equal(got.editable, ["admin", "vendas"].includes(role));
        assert.equal(got.stock_visible, role !== "financeiro");
        assert.equal(got.components[0].stock === null, role === "financeiro");
      } else await assert.rejects(componentsRead(d, { p_user_id: f.users[role] }), (e) => e.code === "42501");
      if (["admin", "vendas"].includes(role)) assert.equal((await componentsSave(d, { p_user_id: f.users[role] })).document.version, 2);
      else await assert.rejects(componentsSave(d, { p_user_id: f.users[role] }), (e) => e.code === "42501");
    }
  }
});

test("componentes do item: estrutura ausente, produto simples e modo só produto", async () => {
  const empty = await product(f, { format: "E" });
  for (const [productId, reason] of [[p.id, "not_composition"], [empty.id, "no_structure"]]) {
    const d = await componentDocument({ productId });
    assert.equal((await componentsRead(d)).reason_code, reason);
    await assert.rejects(componentsSave(d), error("erp_stock_item_components_locked", "40001"));
  }
  const d = await componentDocument();
  await seed(f, "update erp_stock.composition set post_mode='product' where product_id=$1", [k.id]);
  try {
    assert.equal((await componentsRead(d)).reason_code, "product_only");
    await assert.rejects(componentsSave(d), error("erp_stock_item_components_locked", "40001"));
  } finally { await seed(f, "update erp_stock.composition set post_mode='both' where product_id=$1", [k.id]); }
});

test("componentes do item: comando de outra família, produto antigo, lixeira e espelho", async () => {
  const d = await componentDocument();
  const command = (await f.db.query("select id from erp_stock.composition_command limit 1")).rows[0].id;
  await assert.rejects(componentsSave(d, { p_command_id: command }), error("erp_stock_item_components_conflict", "40001"));
  const docCommand = randomUUID();
  await seed(f, `insert into erp_documents.command(command_id,actor,request_hash,result) values($1,$2,$3,'{}')`,
    [docCommand, f.users.admin, "a".repeat(64)]);
  await assert.rejects(componentsSave(d, { p_command_id: docCommand }), error("erp_stock_item_components_conflict", "40001"));
  await seed(f, `insert into erp_stock.item_component(item_id,document_id,product_id,components,version,updated_by,command_id)
    values($1,$2,$3,$4,9,$5,$6)`, [d.item, d.id, p.id, JSON.stringify([{ component_id: p.id, quantity: "8" }]), f.users.admin, randomUUID()]);
  assert.equal((await componentsRead(d)).version, 0);
  assert.equal((await componentsSave(d)).version, 1);
  await seed(f, "update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=$2,delete_reason='Teste da lixeira' where id=$1", [d.id, f.users.admin]);
  await assert.rejects(componentsSave(d, { p_expected_document_version: 2, p_expected_version: 1, p_components: null }), error("erp_document_deleted", "40001"));
  assert.equal((await componentsRead(d)).edited, true);
  await seed(f, "update erp_documents.document set deleted_at=null,deleted_by=null,delete_reason=null,origin='origin',authority='origin' where id=$1", [d.id]);
  await componentsRead(d);
  await assert.rejects(componentsSave(d, { p_expected_document_version: 2, p_expected_version: 1, p_components: null }), error("erp_document_mirror_readonly", "42501"));
});

test("componentes do item: lançamento, reserva e nota fiscal impedem edição", async () => {
  const movement = (await f.db.query("select id from erp_stock.movement limit 1")).rows[0].id;
  for (const effect of ["posted", "reserved", "invoice"]) {
    const d = await componentDocument();
    if (effect === "posted") await seed(f, `insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id)
      values($1,1,$2,'{}',$3,$4,$5)`, [d.id, movement, "a".repeat(64), f.users.admin, randomUUID()]);
    if (effect === "reserved") await seed(f, `insert into erp_stock.reservation(document_id,source_document_version,snapshot,preview_hash,actor,command_id)
      values($1,1,'{}',$2,$3,$4)`, [d.id, "a".repeat(64), f.users.admin, randomUUID()]);
    if (effect === "invoice") {
      const id = await invoice(f);
      await seed(f, "insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [id, d.id]);
      await seed(f, `insert into erp_stock.invoice_posting(invoice_id,invoice_version,source,warehouse_id,movement_id,snapshot,preview_hash,actor,command_id)
        values($1,1,'invoice',$2,$3,'{}',$4,$5,$6)`, [id, w.id, movement, "a".repeat(64), f.users.admin, randomUUID()]);
    }
    assert.equal((await componentsRead(d)).reason_code, effect);
    await assert.rejects(componentsSave(d), error("erp_stock_item_components_locked", "40001"));
    assert.equal((await componentsRead(d)).document.version, 1);
  }
});

test("componentes do item: gatilhos de identidade, versão, comando e autoridade", async () => {
  const { guardItemComponent, itemComponentsReceipt, itemComponentsDto } = await import("../../../src/erp/domains/stock/rpc/item-components.ts");
  const { inTransaction } = await import("../../../src/erp/engine/registry.ts");
  const { mirrorGuardEffect } = await import("../../../src/erp/domains/documents/public.ts");
  const d = await componentDocument();
  const row = { item_id: d.item, document_id: d.id, product_id: k.id, version: 2, command_id: randomUUID() };
  await assert.rejects(f.dual("guard_item_component_insert",
    () => f.db.query(`insert into erp_stock.item_component(item_id,document_id,product_id,components,version,updated_by,command_id)
      values($1,$2,$3,$4,$5,$6,$7)`, [row.item_id, row.document_id, row.product_id, JSON.stringify([{ component_id: p.id, quantity: "3" }]), row.version, f.users.admin, row.command_id]),
    () => inTransaction(f.driver, (ctx) => guardItemComponent(ctx.db, null, row))), error("erp_stock_item_component_immutable", "40001"));
  const saved = await componentsSave(d);
  const old = f.driver.exec("select * from erp_stock__item_component where item_id=?", d.item).rows[0];
  for (const change of [{ item_id: randomUUID() }, { document_id: randomUUID() }, { product_id: p.id }, { version: 1 }, { version: 3 }, { command_id: old.command_id }]) {
    const next = { ...old, version: 2, command_id: randomUUID(), ...change };
    await assert.rejects(f.dual("guard_item_component_update",
      () => f.db.query("update erp_stock.item_component set item_id=$2,document_id=$3,product_id=$4,version=$5,command_id=$6 where item_id=$1",
        [d.item, next.item_id, next.document_id, next.product_id, next.version, next.command_id]),
      () => inTransaction(f.driver, (ctx) => guardItemComponent(ctx.db, old, next))), error("erp_stock_item_component_immutable", "40001"));
  }
  await seed(f, "update erp_documents.document set origin='origin',authority='origin' where id=$1", [d.id]);
  await assert.rejects(f.dual("item_component_authority",
    () => f.db.query("update erp_stock.item_component set version=version+1,command_id=$2 where item_id=$1", [d.item, randomUUID()]),
    () => inTransaction(f.driver, (ctx) => guardItemComponent(ctx.db, old, { ...old, version: 2, command_id: randomUUID() }))), error("erp_document_mirror_effect_forbidden", "42501"));
  await assert.rejects(f.dual("item_components_audit_authority",
    () => f.db.query("insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data) values($1,$2,$3,'kit_components','Componentes do item (kit)','{}','{}')", [f.users.admin, randomUUID(), d.id]),
    () => inTransaction(f.driver, (ctx) => itemComponentsReceipt(ctx, f.users.admin, randomUUID(), d.id, d.item, "a".repeat(64), [], saved))), error("erp_document_mirror_effect_forbidden", "42501"));
  await assert.rejects(f.dual("item_components_command_authority",
    () => f.db.query("insert into erp_stock.item_component_command(id,actor,document_id,item_id,request_hash,result) values($1,$2,$3,$4,$5,'{}')", [randomUUID(), f.users.admin, d.id, d.item, "a".repeat(64)]),
    () => inTransaction(f.driver, (ctx) => mirrorGuardEffect(ctx.db, d.id))), error("erp_document_mirror_effect_forbidden", "42501"));
  assert.equal(itemComponentsDto(f.driver, f.users.admin, d.id, d.item).version, 1);
});

test("componentes do item: substituição ordenada, decimais, total excedente e quantidade nula no espelho", async () => {
  const d = await componentDocument();
  const other = await product(f);
  const saved = await componentsSave(d, { p_components: [{ component_id: other.id, quantity: "0.000001" }, { component_id: p.id, quantity: "1.125" }] });
  assert.deepEqual(saved.components.map((x) => [x.component_id, x.quantity, x.total]), [
    [other.id, "0.000001", "0.000002000000"], [p.id, "1.125000", "2.250000000000"],
  ]);
  assert.deepEqual((await componentsRead(d)).components, saved.components);
  // O campo total é numeric(30,12) no Fagoo: o save inteiro deve desfazer se ele exceder.
  await seed(f, "update erp_documents.item set quantity=999999999999 where id=$1", [d.item]);
  await assert.rejects(componentsSave(d, { p_expected_document_version: 2, p_expected_version: 1, p_components: [{ component_id: p.id, quantity: "999999999999" }] }), error("numeric field overflow", "22003"));
  assert.equal((await componentsRead(d)).version, 1);
  await seed(f, "update erp_documents.document set origin='origin',authority='origin' where id=$1", [d.id]);
  await seed(f, "update erp_documents.item set quantity=null where id=$1", [d.item]);
  const mirrored = await componentsRead(d);
  assert.equal(mirrored.item.quantity, null);
  assert.ok(mirrored.components.every((x) => x.total === null));
});
