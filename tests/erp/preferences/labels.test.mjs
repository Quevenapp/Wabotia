// Etiquetas customizadas (migrações 149 e 230) na fixture dupla. Adaptados do Fagoo:
// - reports-labels-sql.test.mjs: "149 etiquetas…" (a parte das etiquetas; a exclusão passa por
//   erp_preferences_framework_delete, ainda só no oráculo e espelhada);
// - preferences-d-sql.test.mjs: "230 NFE-052…" (label_invoice_products e label_records).
// Fora, declarados: GRANT/has_function_privilege.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import {
  LABEL_DEFAULTS,
  sameJson,
  captureFrameworkDelete,
  parseFrameworkResult,
  parseLabels,
  captureLabelSave,
  captureLabelRecordsQuery,
  parseLabelRecords,
  parseLabelInvoiceProducts,
  captureLabelInvoiceQuery,
} from "../../../src/erp/fagoo/packages/erp-domain/src/reports-labels.mjs";
import { labelDefaults } from "../../../src/erp/domains/preferences/label-defaults.ts";

const fails = (assert, fn, code) => assert.rejects(fn, (e) => e.code === code);
const remove = async (f, target, body) => {
  const s = captureFrameworkDelete(body);
  return parseFrameworkResult(
    await f.rpc("erp_preferences_framework_delete", { p_user_id: f.users.admin, p_command_id: s.command_id, p_target: target, p_items: s.items }),
    s,
    target === "reports" ? "reports-delete" : "labels-delete",
  );
};

test("149 etiquetas: five fixed Padrões, Clonar into Customizadas, the model rules, Excluir by version and the records of what the role reads", async () => {
  const f = await dualFixture();
  try {
    const p = await f.catalog("products", { name: "Caneta azul", code: "CAN-1", unit: "UN", kind: "P", format: "S", price: "2.5", gtin: "7891234567895" });
    assert.ok(sameJson(await f.scalar("select erp_preferences.label_defaults() v"), JSON.parse(JSON.stringify(LABEL_DEFAULTS))));
    assert.ok(sameJson(labelDefaults(), JSON.parse(JSON.stringify(LABEL_DEFAULTS))), "the TS defaults are the oracle's");
    const labels = parseLabels(await f.rpc("erp_preferences_labels", { p_user_id: f.users.admin }));
    assert.deepEqual(
      labels.items.map((t) => [t.id, t.type]),
      [
        ["padrao-contato", "contato"],
        ["padrao-produto", "produto"],
        ["padrao-nota-fiscal", "nota_fiscal"],
        ["padrao-ordem-servico", "ordem_servico"],
        ["padrao-pedido-venda", "pedido_venda"],
      ],
    );
    await fails(assert, () => f.rpc("erp_preferences_labels", { p_user_id: f.users.vendas }), "42501");
    const product = labels.items[1],
      clone = captureLabelSave({ command_id: randomUUID(), id: null, expected_version: 0, data: { type: "produto", description: "Gôndola", config: product.config } });
    const save = (data, extra = {}) =>
      f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: null, p_expected_version: 0, p_data: data, ...extra });
    const created = parseFrameworkResult(
      await f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: clone.command_id, p_label: null, p_expected_version: 0, p_data: clone.data }),
      clone,
      "label-save",
    );
    assert.equal(
      (await f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: clone.command_id, p_label: null, p_expected_version: 0, p_data: clone.data })).replayed,
      true,
    );
    await fails(assert, () => save({ ...clone.data, description: "etiqueta de produto" }), "23505");
    await fails(assert, () => save({ ...clone.data, description: "gôndola" }), "23505");
    const far = structuredClone(product.config);
    far.fields[0].x = "60";
    assert.throws(() => captureLabelSave({ ...clone, command_id: randomUUID(), data: { ...clone.data, description: "Fora", config: far } }), /ERP_INVALID_INPUT/);
    await fails(assert, () => save({ ...clone.data, description: "Fora", config: far }), "22023");
    const qr = structuredClone(product.config);
    qr.label.barcode = "qrcode";
    await fails(assert, () => save({ ...clone.data, description: "QR", config: qr }), "22023");
    // Fronteiras do modelo.
    const variant = (fn) => {
      const c = structuredClone(product.config);
      fn(c);
      return c;
    };
    for (const config of [
      variant((c) => (c.label.width = "4.9")),
      variant((c) => (c.label.width = "50.55")),
      variant((c) => (c.label.width = 50)),
      variant((c) => (c.page.width = "100")),
      variant((c) => (c.page.size = "custom")),
      variant((c) => (c.fields = [])),
      variant((c) => (c.fields[0].field = "nome")),
      variant((c) => (c.fields[0].bold = "true")),
      variant((c) => delete c.label.font),
      variant((c) => (c.extra = 1)),
    ])
      await fails(assert, () => save({ ...clone.data, description: "Borda", config }), "22023");
    for (const data of [
      { ...clone.data, type: "outro" },
      { ...clone.data, description: " x" },
      { ...clone.data, description: "a".repeat(81) },
      { type: "produto", config: product.config },
    ])
      await fails(assert, () => save(data), "22023");
    const ok = await save({ ...clone.data, description: "Borda válida", config: variant((c) => ((c.page = { ...c.page, size: "custom", width: "999", height: "20" }), (c.fields[0].x = "50"))) });
    assert.equal(ok.replayed, false);
    const id = created.receipt.target,
      custom = parseLabels(await f.rpc("erp_preferences_labels", { p_user_id: f.users.admin })).items.find((t) => t.id === id);
    assert.deepEqual([custom.default, custom.version], [false, 1]);
    const moved = structuredClone(custom.config);
    moved.fields[1].y = "10.5";
    moved.page = { ...moved.page, size: "custom", width: "100", height: "150" };
    await f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: id, p_expected_version: 1, p_data: { type: "produto", description: "Gôndola", config: moved } });
    await fails(
      assert,
      () => f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: id, p_expected_version: 2, p_data: { type: "contato", description: "Gôndola", config: moved } }),
      "22023",
    );
    await fails(
      assert,
      () => f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: id, p_expected_version: 2, p_data: { type: "produto", description: "Gôndola", config: moved } }),
      "22023",
    );
    await fails(
      assert,
      () => f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: id, p_expected_version: 1, p_data: { type: "produto", description: "Gôndola 2", config: moved } }),
      "40001",
    );
    await fails(
      assert,
      () => f.rpc("erp_preferences_label_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: randomUUID(), p_expected_version: 1, p_data: { type: "produto", description: "Nenhuma", config: moved } }),
      "P0002",
    );
    await fails(assert, () => save({ ...clone.data, description: "Por vendas" }, { p_user_id: f.users.vendas }), "42501");
    await fails(assert, () => remove(f, "labels", { command_id: randomUUID(), items: [{ id, expected_version: 1 }] }), "40001");
    await remove(f, "labels", { command_id: randomUUID(), items: [{ id, expected_version: 2 }] });
    assert.equal(parseLabels(await f.rpc("erp_preferences_labels", { p_user_id: f.users.admin })).items.length, 6);
    // Records to print, by search and by the module rule of the role.
    const q = captureLabelRecordsQuery({ tipo: "produto", busca: "can" }),
      records = parseLabelRecords(await f.rpc("erp_preferences_label_records", { p_user_id: f.users.estoque, p_type: q.type, p_query: q.q }), q);
    assert.deepEqual(records.items.map((i) => [i.id, i.values.codigo, i.values.gtin]), [[p.id, "CAN-1", "7891234567895"]]);
  } finally {
    await f.close();
  }
});

async function invoiceSetup(f) {
  await f.db.query(
    "insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict(singleton) do nothing",
    [f.users.admin],
  );
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict(singleton) do nothing", [f.users.admin]);
  await f.sync();
  const nature = (
    await f.rpc("erp_fiscal_nature_execute", {
      p_user_id: f.users.admin,
      p_command_id: randomUUID(),
      p_action: "create",
      p_data: { nature: { description: "Venda sintética", direction: "1", crt: "1", presence: "1" } },
    })
  ).nature;
  const product = await f.catalog("products", { name: "Peça sintética", code: "P-1", unit: "UN", kind: "P", format: "S", price: "50", ncm: "84713012", gtin: "7891234567895" });
  const contact = await f.catalog("contacts", { name: "Cliente Sintético", document: "11222333000181" });
  const item = (over = {}) => ({
    product_id: product.id,
    description: "Peça sintética",
    code: "P-1",
    unit: "UN",
    quantity: "2.5",
    unit_price: "40",
    ncm: "84713012",
    cfop: "5102",
    icms: { origin: "0", situation: "102" },
    ...over,
  });
  const invoice = (
    await f.rpc("erp_fiscal_invoice_execute", {
      p_user_id: f.users.admin,
      p_command_id: randomUUID(),
      p_action: "create",
      p_data: {
        invoice: {
          model: "55",
          direction: "1",
          issue_type: "N",
          series: "1",
          nature_id: nature.id,
          issue_date: "2026-10-20",
          crt: "1",
          purpose: "1",
          presence: "1",
          final_consumer: false,
          recipient: { contact_id: contact.id, name: "Cliente Sintético", person_type: "J", document: "11222333000181", state: "SP", city: "Campinas", street: "Rua Sintética", number: "10" },
          items: [item(), item({ product_id: undefined, code: "AV-1", description: "Item avulso", quantity: "1", unit_price: "20" })],
        },
      },
    })
  ).invoice;
  return { product, contact, invoice };
}

test("230 NFE-052 Etiquetas customizadas print the products of a note with their quantities", async () => {
  const f = await dualFixture();
  try {
    const { invoice, product } = await invoiceSetup(f);
    const iq = captureLabelInvoiceQuery({ id: invoice.id }),
      labels = parseLabelInvoiceProducts(await f.rpc("erp_preferences_label_invoice_products", { p_user_id: f.users.admin, p_invoice_id: invoice.id }), iq);
    assert.deepEqual(
      labels.items.map((i) => [i.position, i.product_id, i.quantity, i.values.codigo, i.values.descricao, i.values.gtin]),
      [
        [1, product.id, "2.5", "P-1", "Peça sintética", "7891234567895"],
        [2, null, "1", "AV-1", "Item avulso", null],
      ],
    );
    assert.equal(Number(labels.items[0].values.preco), 50, "the product price of the cadastro");
    assert.equal(Number(labels.items[1].values.preco), 20, "without a product, the price of the note");
    await fails(assert, () => f.rpc("erp_preferences_label_invoice_products", { p_user_id: f.users.estoque, p_invoice_id: invoice.id }), "42501");
    await fails(assert, () => f.rpc("erp_preferences_label_invoice_products", { p_user_id: f.users.admin, p_invoice_id: randomUUID() }), "P0002");
    await fails(assert, () => f.rpc("erp_preferences_label_invoice_products", { p_user_id: f.users.admin, p_invoice_id: null }), "22023");
    // label_records (230): notas por número ou destinatário; a busca de cada tipo; curingas literais.
    const records = parseLabelRecords(
      await f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: "nota_fiscal", p_query: "sintético" }),
      captureLabelRecordsQuery({ tipo: "nota_fiscal", busca: "sintético" }),
    );
    assert.deepEqual(
      records.items.map((i) => [i.id, i.values.cliente, i.values.serie, i.values.endereco_cliente, i.values.cidade_uf]),
      [[invoice.id, "Cliente Sintético", "1", "Rua Sintética, 10", "Campinas/SP"]],
    );
    await fails(assert, () => f.rpc("erp_preferences_label_records", { p_user_id: f.users.vendas, p_type: "nota_fiscal", p_query: null }), "42501");
    const order = (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_body: { date: "2026-10-20", contact_id: (await f.catalog("contacts", { name: "Ana Sintética", city: "Campinas", state: "SP" })).id,
          items: [{ unit: "UN", product_id: product.id, description: "Peça sintética", quantity: "1", unit_price: "5" }] },
      })
    ).document;
    for (const [type, query] of [["produto", "peça"], ["produto", null], ["contato", "sintético"], ["contato", null], ["pedido_venda", null], ["pedido_venda", "ana"], ["pedido_venda", String(order.number)], ["ordem_servico", null], ["nota_fiscal", null]])
      assert.ok(Array.isArray((await f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: type, p_query: query })).items), `${type} ${query}`);
    const sales = await f.rpc("erp_preferences_label_records", { p_user_id: f.users.fiscal, p_type: "pedido_venda", p_query: null });
    assert.deepEqual(sales.items.map((i) => [i.values.numero, i.values.cliente, i.values.cidade_uf]), [[String(order.number), "Ana Sintética", "Campinas/SP"]]);
    assert.equal((await f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: "produto", p_query: "peça" })).items[0].values.codigo, "P-1");
    for (const bad of [" x", "x".repeat(61), "a\u0001"])
      await fails(assert, () => f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: "produto", p_query: bad }), "22023");
    await fails(assert, () => f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: "outro", p_query: null }), "22023");
    await fails(assert, () => f.rpc("erp_preferences_label_records", { p_user_id: f.users.estoque, p_type: "ordem_servico", p_query: null }), "42501");
    await fails(assert, () => f.rpc("erp_preferences_label_records", { p_user_id: f.users.inactive, p_type: "produto", p_query: null }), "42501");
    for (const literal of ["%", "_"])
      assert.equal((await f.rpc("erp_preferences_label_records", { p_user_id: f.users.admin, p_type: "produto", p_query: literal })).items.length, 0, "LIKE wildcards are literal");
    assert.equal((await f.rpc("erp_preferences_label_invoice_products", { p_user_id: f.users.consulta, p_invoice_id: invoice.id })).items.length, 2);
  } finally {
    await f.close();
  }
});
