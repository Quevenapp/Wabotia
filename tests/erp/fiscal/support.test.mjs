// Fiscal, bloco F1: leituras de apoio do formulário da nota e a estimativa de
// impostos do pedido, nos dois motores: erp_fiscal_invoice_context (empresa,
// séries, padrões, preferências das páginas de NF-e e NFC-e), _payment_methods,
// _product_groups, _contact_source e erp_fiscal_tax_estimate_context (e _v2).
// Adaptado do Fagoo (fiscal-invoice-preferences-sql.test.mjs e
// fiscal-invoice-wave-d-sql.test.mjs), só a parte destas leituras.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
let product;
const code = (expected) => (error) => error.code === expected;
const execute = (action, data, user = f.users.admin) => f.rpc("erp_fiscal_nature_execute", { p_user_id: user, p_command_id: randomUUID(), p_action: action, p_data: data });
const nature = (over = {}) => ({ description: "Natureza sintética", direction: "1", crt: "1", rules: [{ tax: "icms", data: { situation: "102", cfop: "5102" } }], ...over });
async function savePrefs(page, changes, user = f.users.admin) {
  const current = await f.rpc("erp_preferences_page", { p_user_id: user, p_page: page });
  const version = (key) => current.items.find((i) => i.key === key)?.version ?? 0;
  return f.rpc("erp_preferences_save", {
    p_user_id: user, p_command_id: randomUUID(), p_page: page,
    p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: version(key), value })),
  });
}
async function profile(contact, natureId) {
  await f.db.query(
    "insert into erp_catalog.contact_profile(record_id, operation_nature_id, taxpayer) values($1,$2,'1') on conflict(record_id) do update set operation_nature_id=excluded.operation_nature_id, taxpayer='1'",
    [contact, natureId],
  );
  await f.sync();
}

before(async () => {
  f = await dualFixture();
  product = await f.catalog("products", { name: "Produto do contexto fiscal", unit: "UN", kind: "P", price: "1", ncm: "84713012" });
});
after(() => f?.close());

test("F1 contexto da nota: empresa, padrões e as preferências das páginas de NF-e e NFC-e", async () => {
  const empty = await f.rpc("erp_fiscal_invoice_context", { p_user_id: f.users.fiscal, p_model: "55" });
  assert.deepEqual(empty.company, { crt: null, regime_confirmed: false, state: null, cnpj_present: false });
  assert.deepEqual([empty.series, empty.defaults, empty.emission_enabled, empty.operation_destination_manual], [[], {}, false, false]);
  assert.deepEqual((await f.rpc("erp_fiscal_invoice_context", { p_user_id: f.users.admin, p_model: 55 })).series, [], "o número chega ao RPC como texto");
  for (const model of [null, "57", "5"]) await assert.rejects(() => f.rpc("erp_fiscal_invoice_context", { p_user_id: f.users.admin, p_model: model }), code("22023"), String(model));
  for (const user of [f.users.consulta, f.users.vendas, randomUUID()]) await assert.rejects(() => f.rpc("erp_fiscal_invoice_context", { p_user_id: user, p_model: "55" }), code("42501"));
  await f.rpc("erp_company_save_identity", {
    p_user_id: f.users.admin, p_expected_version: 0, p_command_id: randomUUID(),
    p_data: {
      legal_name: "EMPRESA FICTICIA TESTE", trade_name: null, cnpj: "11222333000181", ie: null, postal_code: "13400-000", street: "Rua fictícia", number: "S/N", complement: null,
      district: "Centro", city: "Piracicaba", municipality_code: "3538709", state: "sp", phone: null, email: null,
    },
  });
  const fiscal = await f.rpc("erp_company_get", { p_user_id: f.users.admin, p_section: "fiscal" });
  await f.rpc("erp_company_confirm_fiscal", {
    p_user_id: f.users.admin, p_expected_version: fiscal.record.version, p_expected_identity_version: 1, p_command_id: randomUUID(), p_crt: "1", p_confirmed: true,
    p_reason: "Confirmação fictícia, só teste",
  });
  const sale = (await execute("create", { nature: nature({ description: "Venda padrão do contexto" }) })).nature;
  await execute("set_default", { id: sale.id, expected_version: 1, code: "S" });
  await savePrefs("notas-nfe", {
    "nfe.frete_por_conta": "1", "nfe.especie_padrao": "caixas", "nfe.volume_padrao": 3, "nfe.markup": "35.5", "nfe.somar_peso": true, "nfe.validacao_opcional": ["parcelas"],
    "nfe.grupo_retencao": true, "nfe.autxml_transportadora": true, "nfe.autxml_pessoas": [{ document: "11222333000181", name: "Contabilidade sintética" }],
  });
  await savePrefs("notas-nfce", { "nfce.grupo_armamento": true, "nfce.autxml_pessoas": [{ document: "12345678909", name: "" }] });
  const nfe = await f.rpc("erp_fiscal_invoice_context", { p_user_id: f.users.fiscal, p_model: "55" });
  assert.deepEqual(nfe.company, { crt: "1", regime_confirmed: true, state: "SP", cnpj_present: true });
  assert.deepEqual(nfe.defaults, { S: { id: sale.id, description: "Venda padrão do contexto" } });
  assert.deepEqual([nfe.preferences.freight_by, nfe.preferences.species, nfe.preferences.volume_quantity, nfe.preferences.markup], ["1", "caixas", 3, "35.5"]);
  assert.deepEqual([nfe.preferences.optional_installments, nfe.preferences.retention_group, nfe.operation_destination_manual], [true, true, false]);
  assert.deepEqual(nfe.preferences.autxml_people, [{ document: "11222333000181", name: "Contabilidade sintética" }]);
  const nfce = await f.rpc("erp_fiscal_invoice_context", { p_user_id: f.users.admin, p_model: "65" });
  assert.deepEqual([nfce.preferences.autxml_people, nfce.preferences.autxml_carrier, nfce.preferences.weapon_group, nfce.preferences.retention_group], [
    [{ document: "12345678909", name: "" }], false, true, false,
  ]);
  assert.equal(nfce.operation_destination_manual, false);
});

test("F1 formas de pagamento pela direção e grupos dos produtos", async () => {
  for (const direction of ["0", "1"]) {
    const v = await f.rpc("erp_fiscal_invoice_payment_methods", { p_user_id: f.users.fiscal, p_direction: direction });
    assert.equal(v.direction, direction);
  }
  for (const direction of [null, "2"]) await assert.rejects(() => f.rpc("erp_fiscal_invoice_payment_methods", { p_user_id: f.users.fiscal, p_direction: direction }), code("22023"));
  await assert.rejects(() => f.rpc("erp_fiscal_invoice_payment_methods", { p_user_id: f.users.consulta, p_direction: "1" }), code("42501"));
  const groups = await f.rpc("erp_fiscal_invoice_product_groups", { p_user_id: f.users.fiscal, p_product_ids: [product.id, randomUUID(), product.id.toUpperCase()] });
  assert.deepEqual(groups.items, [{ id: product.id, group_id: null }]);
  for (const ids of [[], Array.from({ length: 101 }, () => product.id), ["x"], [null], {}, null])
    await assert.rejects(() => f.rpc("erp_fiscal_invoice_product_groups", { p_user_id: f.users.fiscal, p_product_ids: ids }), code("22023"), JSON.stringify(ids));
});

test("F1 contato da nota: cadastro, natureza do perfil pela direção e as recusas", async () => {
  const contact = await f.catalog("contacts", { name: "CLIENTE FISCAL SINTETICO", person_type: "J", document: "11222333000181", state: "MG", city: "BELO HORIZONTE" });
  const sale = (await execute("create", { nature: nature({ description: "Venda do contato" }) })).nature;
  await profile(contact.id, sale.id);
  const out = await f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_direction: "1" });
  assert.deepEqual([out.contact.contact_id, out.contact.name, out.nature?.id, out.seller, out.writable], [contact.id, "CLIENTE FISCAL SINTETICO", sale.id, null, true]);
  assert.equal((await f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_direction: "0" })).nature, null);
  await assert.rejects(() => f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.fiscal, p_contact_id: randomUUID(), p_direction: "1" }), code("P0002"));
  await assert.rejects(() => f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.fiscal, p_contact_id: product.id, p_direction: "1" }), code("P0002"));
  await assert.rejects(() => f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_direction: "2" }), code("22023"));
  await assert.rejects(() => f.rpc("erp_fiscal_invoice_contact_source", { p_user_id: f.users.consulta, p_contact_id: contact.id, p_direction: "1" }), code("42501"));
});

test("F1 contexto da estimativa: natureza do contato ou o padrão, configuração e produtos", async () => {
  const estimate = (patch = {}, name = "erp_fiscal_tax_estimate_context_v2") =>
    f.rpc(name, { p_user_id: f.users.vendas, p_kind: "sales_orders", p_contact_id: null, p_product_ids: [product.id], ...patch });
  const contact = await f.catalog("contacts", { name: "CLIENTE ESTIMATIVA", person_type: "F", document: "12345678909", state: "rj", city: "RIO" });
  const own = (await execute("create", { nature: nature({ description: "Venda do cliente da estimativa" }) })).nature;
  const general = (await execute("create", { nature: nature({ description: "Venda geral da estimativa" }) })).nature;
  const person = (await execute("create", { nature: nature({ description: "Venda a consumidor da estimativa" }) })).nature;
  await execute("set_default", { id: general.id, expected_version: 1, code: "S" });
  const anonymous = await estimate();
  assert.deepEqual([anonymous.recipient, anonymous.nature?.id, anonymous.products], [null, general.id, [{ id: product.id, ncm: "84713012", kind: "P", group_id: null }]]);
  await execute("set_default", { id: person.id, expected_version: 1, code: "VF" });
  const consumer = await estimate({ p_contact_id: contact.id });
  assert.deepEqual([consumer.recipient, consumer.nature?.id], [{ person_type: "F", state: "RJ", ie: null, taxpayer: null }, person.id]);
  await profile(contact.id, own.id);
  const chosen = await estimate({ p_contact_id: contact.id }, "erp_fiscal_tax_estimate_context");
  assert.deepEqual([chosen.nature?.id, chosen.recipient.taxpayer, chosen.products[0].group_id], [own.id, "1", undefined]);
  assert.equal((await estimate({ p_kind: "sales_proposals" })).enabled, false);
  for (const [patch, c] of [
    [{ p_kind: "purchase_orders" }, "22023"], [{ p_product_ids: {} }, "22023"], [{ p_product_ids: ["x"] }, "22023"], [{ p_product_ids: Array.from({ length: 251 }, () => product.id) }, "22023"],
    [{ p_contact_id: randomUUID() }, "22023"], [{ p_user_id: randomUUID() }, "42501"],
  ])
    await assert.rejects(() => estimate(patch), code(c), JSON.stringify(patch).slice(0, 80));
});
