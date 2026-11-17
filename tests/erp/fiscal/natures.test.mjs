// Fiscal, bloco F1: naturezas de operação e configuração tributária, nos dois
// motores. Adaptado do Fagoo (workers/erp-api/test/fiscal-natures-sql.test.mjs, 111):
// perfis, regras por imposto, versão esperada, repetição por comando, clone,
// padrões por direção, inativação, a lista e a configuração tributária.
// Fora, declarados: privilégios do Postgres (GRANT, SECURITY DEFINER, RLS) e as
// escritas diretas que provam imutabilidade (gatilhos do Postgres, SQL no teste).
// O contrato JS do Fagoo (packages/erp-domain) não é copiado: as specs e o
// check_value são conferidos contra as funções do oráculo.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { checkValue, specObject } from "../../../src/erp/domains/fiscal/core.ts";
import { NATURE_SPECS } from "../../../src/erp/domains/fiscal/natures.ts";

let f;
let product;
const code = (expected) => (error) => error.code === expected;
const execute = (action, data, { user = f.users.admin, command = randomUUID() } = {}) =>
  f.rpc("erp_fiscal_nature_execute", { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const create = (data, options) => execute("create", { nature: data }, options);
const nature = (over = {}) => ({
  description: "Venda de mercadoria sintética", direction: "1", crt: "1", presence: "1", final_consumer: true,
  others: { discount_type: "I", approx_tax_type: "table" }, retentions: { csrf: false },
  rules: [
    { tax: "icms", destinations: [], product_scope: "any", data: { situation: "102", cfop: "5102" } },
    { tax: "icms", destinations: ["RJ", "MG"], product_scope: "ncm", ncms: ["8471"], data: { situation: "101", cfop: "6102", credit_rate: "1.25" } },
    { tax: "pis", data: { situation: "49", rate: "0" } },
  ],
  ...over,
});

before(async () => {
  f = await dualFixture();
  product = await f.catalog("products", { name: "Produto fiscal sintético", unit: "UN", kind: "P", price: "1" });
});
after(() => f?.close());

test("111 as specs e o check_value são os do oráculo", async () => {
  assert.deepEqual(await f.scalar("select erp_fiscal_invoices.nature_specs() value"), NATURE_SPECS);
  const samples = [
    ["d:4:3", "12.5"], ["d:2:13", "0"], ["t:10", "  texto  "], ["m:20", "linha\nduas"], ["e:A|B", "B"], ["x:^[0-9]{4}$", "5102"],
    ["u", "ABCDEF01-2345-4789-8abc-def012345678"], ["a", "2026-02-28"], ["b", true], ["t:5", "   "],
  ];
  for (const [descriptor, value] of samples)
    assert.deepEqual(checkValue(value, descriptor), await f.scalar("select erp_fiscal_invoices.check_value($1::jsonb,$2) value", [JSON.stringify(value), descriptor]), descriptor);
  for (const [descriptor, value] of [["d:4:3", "1234"], ["d:2:13", "1.234"], ["t:3", "abcd"], ["e:A|B", "C"], ["a", "2026-02-30"], ["b", "true"], ["d:2:13", "-1"], ["t:10", "a\u0001b"]]) {
    await assert.rejects(() => f.scalar("select erp_fiscal_invoices.check_value($1::jsonb,$2) value", [JSON.stringify(value), descriptor]), code("22023"), descriptor);
    assert.throws(() => checkValue(value, descriptor), (e) => e.code === "22023", descriptor);
  }
  const value = { rate: "7", base_rate: null };
  assert.deepEqual(specObject(value, NATURE_SPECS.rules.ipi), await f.scalar("select erp_fiscal_invoices.spec_object($1::jsonb,$2::jsonb) value", [JSON.stringify(value), JSON.stringify(NATURE_SPECS.rules.ipi)]));
});

test("111 perfis: admin e fiscal gravam, consulta só lê, os outros e estranhos são recusados", async () => {
  const created = (await create(nature(), { user: f.users.fiscal })).nature;
  assert.deepEqual([created.version, created.rules.length], [1, 3]);
  await assert.rejects(() => create(nature(), { user: f.users.consulta }), code("42501"));
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, randomUUID()]) {
    await assert.rejects(() => f.rpc("erp_fiscal_nature_list", { p_user_id: user }), code("42501"));
    await assert.rejects(() => f.rpc("erp_fiscal_nature_get", { p_user_id: user, p_id: created.id }), code("42501"));
    await assert.rejects(() => f.rpc("erp_fiscal_tax_settings_get", { p_user_id: user }), code("42501"));
  }
  const read = await f.rpc("erp_fiscal_nature_get", { p_user_id: f.users.consulta, p_id: created.id });
  assert.deepEqual([read.writable, read.nature.id], [false, created.id]);
  await f.db.query("update erp_access.membership set active=false where user_id=$1", [f.users.fiscal]);
  await f.sync();
  try {
    await assert.rejects(() => execute("update", { id: created.id, expected_version: 1, nature: nature() }, { user: f.users.fiscal }), code("42501"));
  } finally {
    await f.db.query("update erp_access.membership set active=true where user_id=$1", [f.users.fiscal]);
    await f.sync();
  }
});

test("111 regras: situação obrigatória, IPI pela direção, destinos, NCM e até dez produtos existentes", async () => {
  const rule = (data) => nature({ rules: [{ tax: "icms", data }] });
  await assert.rejects(() => create(rule({ cfop: "5102" })), code("22023"), "situação obrigatória");
  await assert.rejects(() => create(rule({ situation: "00" })), code("22023"), "CST do regime normal numa natureza do Simples");
  const normal = (await create(nature({ crt: "3", rules: [{ tax: "icms", data: { situation: "00", rate: "18", deson_deduct: true } }] }))).nature;
  assert.deepEqual(normal.rules[0].data, { situation: "00", rate: "18.0000", deson_deduct: true });
  await assert.rejects(() => create(nature({ rules: [{ tax: "ipi", data: { situation: "00" } }] })), code("22023"), "CST de IPI de entrada numa natureza de saída");
  const entry = (await create(nature({ direction: "0", description: "Compra sintética", update_last_purchase_price: true, rules: [{ tax: "ipi", data: { situation: "49", framing_code: "999" } }] }))).nature;
  assert.equal(entry.update_last_purchase_price, true);
  await assert.rejects(() => create(nature({ update_last_purchase_price: true })), code("22023"), "só a entrada atualiza o preço de compra");
  for (const bad of [
    { destinations: ["SP", "SP"] }, { destinations: ["XX"] }, { destinations: [1] }, { destinations: null }, { product_scope: "ncm", ncms: [] }, { product_scope: "ncm", ncms: ["123"] },
    { product_scope: "ncm", ncms: [null] }, { product_scope: "products", product_ids: [randomUUID()] }, { product_scope: "products", product_ids: ["x"] },
    { product_scope: "any", ncms: ["8471"] }, { product_scope: "products", product_ids: Array.from({ length: 11 }, () => product.id) },
    { product_scope: "groups", group_ids: [randomUUID()] }, { product_scope: "outro" }, { extra: true },
  ])
    await assert.rejects(() => create(nature({ rules: [{ tax: "pis", data: { situation: "49" }, ...bad }] })), code("22023"), JSON.stringify(bad));
  const scoped = (await create(nature({ rules: [{ tax: "icms", destinations: ["SP", "EX"], product_scope: "products", product_ids: [product.id], data: { situation: "500" } }] }))).nature;
  assert.deepEqual(scoped.rules[0].destinations, ["EX", "SP"]);
  assert.deepEqual(scoped.rules[0].products.map((p) => p.id), [product.id]);
  const ncm = (await create(nature({ rules: [{ tax: "pis", product_scope: "ncm", ncms: ["84713012", 8471], data: { situation: "49" } }] }))).nature;
  assert.deepEqual(ncm.rules[0].ncms, ["8471", "84713012"]);
  for (const bad of [{ others: { unknown: true } }, { description: "x".repeat(61) }, { description: "   " }, { direction: 1 }, { presence: 9 }, { presence: null }, { series: 1 }, { series: "1000" }, { rules: null }, { extra: 1 }])
    await assert.rejects(() => create(nature(bad)), code("22023"), JSON.stringify(bad));
  const many = Array.from({ length: 51 }, () => ({ tax: "pis", data: { situation: "49" } }));
  await assert.rejects(() => create(nature({ rules: many })), code("22023"), "51 regras do mesmo imposto");
  const series = (await create(nature({ series: "12", presence: undefined, additional_info: "  linha\nduas  " }))).nature;
  assert.deepEqual([series.series, series.presence, series.additional_info], [12, "9", "linha\nduas"]);
});

test("111 a atualização usa a versão esperada, repete pelo comando e guarda as revisões", async () => {
  const created = (await create(nature({ description: "Natureza versionada" }))).nature;
  const command = randomUUID(),
    data = { id: created.id, expected_version: 1, nature: nature({ description: "Natureza versionada 2", rules: [{ tax: "cofins", data: { situation: "49" } }] }) };
  const first = await execute("update", data, { command });
  assert.deepEqual([first.nature.version, first.replayed], [2, false]);
  assert.deepEqual(first.nature.rules.map((r) => [r.tax, r.position]), [["cofins", 1]]);
  const again = await execute("update", data, { command });
  assert.deepEqual([again.replayed, again.nature.version], [true, 2]);
  await assert.rejects(() => execute("update", { ...data, nature: nature({ description: "Outra" }) }, { command }), code("40001"), "mesmo comando, outro corpo");
  await assert.rejects(() => execute("update", data, { command, user: f.users.fiscal }), code("40001"), "mesmo comando, outro ator");
  await assert.rejects(() => execute("update", data), code("40001"), "versão esperada vencida");
  await assert.rejects(() => execute("update", { ...data, expected_version: 2, nature: nature({ direction: "0" }) }), code("22023"), "a direção não muda");
  assert.deepEqual((await f.db.query("select version from erp_fiscal_invoices.nature_revision where nature_id=$1 order by version", [created.id])).rows.map((r) => r.version), [1, 2]);
  assert.equal(await f.scalar("select count(*)::int value from erp_fiscal_invoices.audit where entity_id=$1", [created.id]), 2);
  for (const [action, d, c] of [
    ["update", { id: created.id, expected_version: 2 }, "22023"], ["clone", { id: created.id }, "22023"], ["delete", { id: created.id, expected_version: 0 }, "22023"],
    ["delete", { id: created.id, expected_version: 2.5 }, "22023"], ["delete", { id: "x", expected_version: 2 }, "22023"], ["delete", { id: randomUUID(), expected_version: 1 }, "P0002"],
    ["set_active", { id: created.id, expected_version: 2, active: "false" }, "22023"], ["set_default", { id: created.id, expected_version: 2, code: "X" }, "22023"], ["outra", {}, "22023"],
  ])
    await assert.rejects(() => execute(action, d), code(c), `${action} ${JSON.stringify(d)}`);
  const removed = (await execute("delete", { id: created.id, expected_version: 2 })).nature;
  assert.deepEqual([removed.active, removed.version], [false, 3]);
  await assert.rejects(() => f.rpc("erp_fiscal_nature_get", { p_user_id: f.users.admin, p_id: created.id }), code("P0002"));
  await assert.rejects(() => execute("update", { ...data, expected_version: 3 }), code("P0002"));
});

test("111 clone, padrões pela direção, inativação e a lista com filtros, páginas e totais", async () => {
  const base = (await create(nature({ description: "Venda padrão sintética" }))).nature;
  const copy = (await execute("clone", { id: base.id, expected_version: 1 })).nature;
  assert.equal(copy.description, "Cópia de Venda padrão sintética");
  assert.deepEqual(copy.rules.map((r) => r.data), base.rules.map((r) => r.data));
  assert.notEqual(copy.id, base.id);
  await assert.rejects(() => execute("set_default", { id: base.id, expected_version: 1, code: "E" }), code("22023"), "padrão de compra numa natureza de saída");
  const withDefault = (await execute("set_default", { id: base.id, expected_version: 1, code: "S" })).nature;
  assert.deepEqual([withDefault.defaults, withDefault.version], [["S"], 1]);
  await assert.rejects(() => execute("set_default", { id: base.id, expected_version: 1, code: "S" }), code("40001"));
  const moved = (await execute("set_default", { id: copy.id, expected_version: 1, code: "S" })).nature;
  assert.deepEqual(moved.defaults, ["S"]);
  assert.deepEqual((await f.rpc("erp_fiscal_nature_get", { p_user_id: f.users.admin, p_id: base.id })).nature.defaults, []);
  const inactive = (await execute("set_active", { id: copy.id, expected_version: 1, active: false })).nature;
  assert.deepEqual([inactive.active, inactive.defaults], [false, []]);
  await assert.rejects(() => execute("set_active", { id: copy.id, expected_version: 2, active: false }), code("40001"));
  await assert.rejects(() => execute("set_default", { id: copy.id, expected_version: 2, code: "VF" }), code("40001"));
  const active = await f.rpc("erp_fiscal_nature_list", { p_user_id: f.users.consulta, p_query: "  PADRÃO sintética " });
  assert.deepEqual(active.items.map((i) => i.id), [base.id]);
  assert.equal(active.writable, false);
  const inactiveList = await f.rpc("erp_fiscal_nature_list", { p_user_id: f.users.admin, p_active: false });
  assert.ok(inactiveList.items.some((i) => i.id === copy.id));
  const paged = await f.rpc("erp_fiscal_nature_list", { p_user_id: f.users.admin, p_limit: 1, p_page: 2, p_direction: "1", p_crt: "1" });
  assert.equal(paged.items.length, 1);
  assert.ok(paged.total_count >= 3);
  for (const args of [{ p_limit: 101 }, { p_page: 0 }, { p_direction: "2" }, { p_crt: "5" }, { p_query: "x".repeat(121) }, { p_query: "a\u0007" }, { p_active: null }])
    await assert.rejects(() => f.rpc("erp_fiscal_nature_list", { p_user_id: f.users.admin, ...args }), code("22023"), JSON.stringify(args));
  const review = (patch = {}) => f.rpc("erp_fiscal_nature_review_confirm", { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_expected_version: 0, ...patch });
  const id = randomUUID();
  const confirmed = await review({ p_command_id: id });
  assert.deepEqual([confirmed.review.confirmed, confirmed.review.version], [true, 1]);
  assert.equal((await review({ p_command_id: id })).replayed, true);
  await assert.rejects(() => review(), code("40001"));
  await assert.rejects(() => review({ p_expected_version: -1 }), code("22023"));
  await assert.rejects(() => review({ p_user_id: f.users.consulta }), code("42501"));
  assert.equal((await f.rpc("erp_fiscal_nature_list", { p_user_id: f.users.admin })).review.version, 1);
});

test("111 configuração tributária: padrões, versão e DIFAL por UF só nas UFs permitidas", async () => {
  const initial = await f.rpc("erp_fiscal_tax_settings_get", { p_user_id: f.users.consulta });
  assert.deepEqual([initial.version, initial.settings.difal_default, initial.settings.exclude_icms_pis_cofins, initial.writable, initial.updated_at], [0, "inside", false, false, null]);
  const save = (expected, settings, states, command = randomUUID(), user = f.users.fiscal) =>
    f.rpc("erp_fiscal_tax_settings_save", { p_user_id: user, p_command_id: command, p_expected_version: expected, p_settings: settings, p_difal_by_state: states });
  await assert.rejects(() => save(0, {}, {}, randomUUID(), f.users.consulta), code("42501"));
  const command = randomUUID();
  const saved = await save(0, { exclude_icms_pis_cofins: true, difal_default: "goods" }, { MT: "double_base", PB: "single_base", SP: "default" }, command);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.difal_by_state, { MT: "double_base", PB: "single_base" });
  assert.equal(saved.settings.exclude_icms_pis_cofins, true);
  assert.equal((await save(0, { exclude_icms_pis_cofins: true, difal_default: "goods" }, { MT: "double_base", PB: "single_base", SP: "default" }, command)).replayed, true);
  await assert.rejects(() => save(0, {}, {}), code("40001"));
  for (const states of [{ SP: "double_base" }, { MT: "single_base" }, { XX: "inside" }, { SP: "unknown" }, { SP: 1 }, null, []])
    await assert.rejects(() => save(1, {}, states), code("22023"), JSON.stringify(states));
  for (const settings of [{ difal_default: "double_base" }, { outro: true }, []]) await assert.rejects(() => save(1, settings, {}), code("22023"), JSON.stringify(settings));
  await assert.rejects(() => save(null, {}, {}), code("22023"));
  const read = await f.rpc("erp_fiscal_tax_settings_get", { p_user_id: f.users.admin });
  assert.deepEqual([read.version, read.settings.difal_default, read.writable], [1, "goods", true]);
});
