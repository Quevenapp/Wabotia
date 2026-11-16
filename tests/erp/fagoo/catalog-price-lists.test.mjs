// Listas de preço: os testes do Fagoo na fixture dupla (cada chamada a um RPC
// portado roda nos dois motores e compara resposta, erro e tabelas).
// - workers/erp-api/test/product-price-lists-sql.test.mjs (migração 121);
// - workers/erp-api/test/produtos-c-price-lists-sql.test.mjs (migração 154);
// - workers/erp-api/test/produtos-d-price-lists-sql.test.mjs (migração 192).
// Fora, declarados: os subtestes de SECURITY DEFINER, search_path e GRANT
// (121 "public RPCs are service-only…", 154 "grants and the new link tables",
// 192 "grants") — o motor não tem papéis do Postgres; o acesso é o
// require_access, provado aqui com 42501.
// Adaptação: insert direto em seller/payment_method e update direto de
// price_list/price_list_item passam por f.write (escreve no Postgres e copia).
// Mais um diferencial aleatório de listas, itens, planilha e consultas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fails, productsFixture } from "./catalog-products-fixture.mjs";

const base = {
  name: "Atacado", category: "other", list_type: "rates", factor: "10", factor_unit: "percent", direction: "discount",
  considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [],
};

test("121 price lists: ACL, exact list prices, bindings, items, custom adjust, clone and delete", async (t) => {
  const f = await productsFixture();
  const save = (data, { id = null, version = 0, command = randomUUID(), user = f.users.admin } = {}) =>
    f.rpc("erp_pricing_list_save", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  const items = (id, version, change, { command = randomUUID(), user = f.users.admin } = {}) =>
    f.rpc("erp_pricing_list_items", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_change: change });
  const get = (id, args = {}, user = f.users.admin) => f.rpc("erp_pricing_list_get", { p_user_id: user, p_id: id, ...args });
  try {
    const ids = {};
    await t.test("save: validation, unique folded names, CAS, idempotent commands and bindings", async () => {
      ids.p1 = (await f.productSave({ name: "Parafuso", code: "P1", price: "10.1250" })).record.id;
      ids.p2 = (await f.productSave({ name: "Porca", code: "P2", price: "0.3333333333" })).record.id;
      ids.free = (await f.productSave({ name: "Sem preço" })).record.id;
      ids.contact = (await f.save("contacts", { name: "Cliente sintético", roles: ["customer"] })).id;
      const command = randomUUID();
      const created = await save(base, { command });
      assert.equal(created.saved, true);
      ids.list = created.list.id;
      assert.deepEqual([created.list.rule, created.list.factor, created.list.products], ["Desconto 10 %", "10.0000", 0]);
      assert.deepEqual(await save(base, { command }), { ...created, replayed: true });
      await fails(assert, save({ ...base, name: "Outra" }, { command }), "40001");
      assert.equal((await save({ ...base, name: "ATACADO" })).reason, "duplicate_name");
      for (const bad of [
        { factor: null }, { factor: "0" }, { factor: "101" }, { factor: "1.23456" }, { category: "store" },
        { category: "seller", contacts: [ids.contact] }, { list_type: "x" }, { list_type: "period" },
        { starts_on: "2026-02-30", list_type: "period" }, { starts_on: "2026-10-02", ends_on: "2026-10-01" }, { start_time: "10:00" },
        { contacts: [ids.contact] }, { category: "contact", contacts: ["x"] }, { category: "region", regions: ["XX"] }, { name: "" },
        { extra: 1 },
      ])
        await fails(assert, save({ ...base, name: "Inválida", ...bad }), "22023");
      const updated = await save(
        { ...base, category: "contact", contacts: [ids.contact], factor: "15", direction: "increase" },
        { id: ids.list, version: 1 },
      );
      assert.deepEqual([updated.list.version, updated.list.rule, updated.list.contacts.map((c) => c.name)], [2, "Acréscimo 15 %", ["Cliente sintético"]]);
      assert.equal(
        (await save({ ...base, category: "contact", contacts: [ids.contact], factor: "15", direction: "increase" }, { id: ids.list, version: 2 })).list
          .version,
        2,
        "an unchanged save keeps the version",
      );
      await fails(assert, save(base, { id: ids.list, version: 1 }), "40001");
      await fails(assert, save(base, { user: f.users.consulta }), "42501");
      await fails(assert, f.rpc("erp_pricing_lists", { p_user_id: f.users.financeiro }), "42501");
      const period = await save({
        ...base, name: "Black Friday", list_type: "period", factor: "5", factor_unit: "amount", considers_datetime: true,
        starts_on: "2026-11-27", ends_on: "2026-11-27", start_time: "08:00", end_time: "22:00", category: "region", regions: ["SP", "MG"],
      });
      assert.deepEqual([period.list.start_time, period.list.regions, period.list.rule], ["08:00", ["MG", "SP"], "Desconto R$ 5,00"]);
      ids.period = period.list.id;
    });
    await t.test("items: list price with exact decimals rounded to cents; custom prices and the mass adjust only on custom lists", async () => {
      const added = await items(ids.list, 2, { add: [ids.p1, ids.p2, ids.free] });
      assert.equal(added.list.products, 3);
      assert.equal(added.list.version, 3);
      const page = await get(ids.list);
      assert.deepEqual(page.items.map((i) => [i.name, i.product_price, i.list_price]), [
        ["Parafuso", "10.1250", "11.64"], ["Porca", "0.3333333333", "0.38"], ["Sem preço", null, null],
      ]);
      assert.deepEqual((await get(ids.list, { p_query: "porc" })).items.map((i) => i.name), ["Porca"]);
      assert.equal((await get(ids.list, { p_limit: 1, p_offset: 1 })).items[0].name, "Porca");
      await fails(assert, items(ids.list, 3, { prices: [{ product_id: ids.p1, custom_price: "9" }] }), "22023");
      await fails(assert, items(ids.list, 2, { remove: [ids.p2] }), "40001");
      const custom = await save({ ...base, name: "Especial", list_type: "custom", factor: null });
      ids.custom = custom.list.id;
      let version = (await items(ids.custom, 1, { add: [ids.p1, ids.p2] })).list.version;
      version = (await items(ids.custom, version, { prices: [{ product_id: ids.p1, custom_price: "9.995" }] })).list.version;
      assert.deepEqual((await get(ids.custom)).items.map((i) => [i.custom_price, i.list_price]), [["9.9950", "10.00"], [null, "0.33"]]);
      version = (await items(ids.custom, version, { adjust: { action: "increase", unit: "percent", value: "10", products: [ids.p2] } })).list.version;
      assert.deepEqual((await get(ids.custom)).items.map((i) => i.custom_price), ["9.9950", "0.3700"]);
      version = (await items(ids.custom, version, { adjust: { action: "fix", unit: "amount", value: "2" } })).list.version;
      assert.deepEqual((await get(ids.custom)).items.map((i) => i.list_price), ["2.00", "2.00"]);
      for (const adjust of [
        { action: "fix", unit: "percent", value: "2" }, { action: "discount", unit: "percent", value: "101" }, { unit: "amount", value: "1" },
        { action: "increase", unit: "amount", value: "1,5" },
      ])
        await fails(assert, items(ids.custom, version, { adjust }), "22023");
      await fails(assert, save({ ...base, name: "Especial", list_type: "rates", factor: "5" }, { id: ids.custom, version }), "22023");
      ids.gone = (await f.productSave({ name: "Produto excluído", price: "1" })).record.id;
      await f.setDeleted(ids.gone, 1, true);
      await fails(assert, items(ids.custom, version, { add: [ids.gone] }), "22023");
      // A rates list never turns a missing sale price into R$ 0,00, even with a stored custom price.
      await f.write("update erp_pricing.price_list_item set custom_price=5 where list_id=$1 and product_id=$2", [ids.list, ids.free]);
      assert.equal((await get(ids.list, { p_query: "sem" })).items[0].list_price, null);
      const lists = await f.rpc("erp_pricing_product_lists", { p_user_id: f.users.vendas, p_product_id: ids.p1 });
      assert.deepEqual(lists.items.map((l) => [l.name, l.rule, l.list_price]), [["Atacado", "Acréscimo 15 %", "11.64"], ["Especial", "Customizada", "2.00"]]);
      assert.deepEqual((await f.rpc("erp_pricing_lists", { p_user_id: f.users.consulta, p_list_type: "custom" })).items.map((l) => l.name), ["Especial"]);
      assert.deepEqual((await f.rpc("erp_pricing_lists", { p_user_id: f.users.consulta, p_product_id: ids.p2 })).items.map((l) => l.name), ["Atacado", "Especial"]);
    });
    await t.test("clone and delete: idempotent, audited, with the product limit and unique names", async () => {
      const command = randomUUID();
      const clone = await f.rpc("erp_pricing_list_clone", { p_user_id: f.users.admin, p_id: ids.list, p_command_id: command, p_name: "Atacado (cópia)" });
      assert.deepEqual([clone.saved, clone.list.products, clone.list.contacts.length], [true, 3, 1]);
      assert.equal(
        (await f.rpc("erp_pricing_list_clone", { p_user_id: f.users.admin, p_id: ids.list, p_command_id: command, p_name: "Atacado (cópia)" })).replayed,
        true,
      );
      assert.equal(
        (await f.rpc("erp_pricing_list_clone", { p_user_id: f.users.admin, p_id: ids.list, p_command_id: randomUUID(), p_name: "atacado (cópia)" })).reason,
        "duplicate_name",
      );
      const removed = await f.rpc("erp_pricing_list_delete", { p_user_id: f.users.admin, p_id: clone.list.id, p_expected_version: 1, p_command_id: randomUUID() });
      assert.equal(removed.deleted, true);
      await fails(assert, get(clone.list.id), "P0002");
      assert.deepEqual((await f.rows("select action from erp_pricing.audit where list_id=$1 order by id", [clone.list.id])).map((r) => r.action), ["clone", "delete"]);
      assert.equal(await f.scalar("select count(*)::int v from erp_pricing.price_list_item where list_id=$1", [clone.list.id]), 0);
    });
  } finally {
    await f.close();
  }
});

test("154 Vendedor and Forma de pagamento: up to 30 links, only for their category, copied by Clonar lista", async () => {
  const f = await productsFixture();
  const save = (data, { id = null, version = 0, command = randomUUID(), user = f.users.admin } = {}) =>
    f.rpc("erp_pricing_list_save", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  try {
    const sellerContact = await f.contact({ name: "Vendedora Sintética" });
    const seller = await f.write("insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v", [sellerContact.id, f.users.admin]);
    const method = await f.write(
      "insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Boleto sintético','15','contas','recebimentos',$1,$1) returning id v",
      [f.users.admin],
    );
    const bySeller = await save({ ...base, category: "seller", sellers: [seller] });
    assert.deepEqual([bySeller.saved, bySeller.list.category, bySeller.list.sellers], [true, "seller", [{ id: seller, name: "Vendedora Sintética" }]]);
    const byMethod = await save({ ...base, name: "Boleto", category: "payment_method", payment_methods: [method] });
    assert.deepEqual(byMethod.list.payment_methods, [{ id: method, name: "Boleto sintético" }]);
    for (const bad of [
      { category: "other", sellers: [seller] }, { category: "seller", payment_methods: [method] }, { category: "seller", sellers: [randomUUID()] },
      { category: "seller", sellers: [seller, seller] }, { category: "payment_method", payment_methods: Array.from({ length: 31 }, () => randomUUID()) },
      { category: "store" },
    ])
      await fails(assert, save({ ...base, name: "Inválida", ...bad }), "22023");
    const moved = await save({ ...base, category: "payment_method", payment_methods: [method] }, { id: bySeller.list.id, version: 1 });
    assert.deepEqual([moved.list.version, moved.list.sellers, moved.list.payment_methods.length], [2, [], 1], "changing the category replaces the links");
    const clone = await f.rpc("erp_pricing_list_clone", { p_user_id: f.users.admin, p_id: byMethod.list.id, p_command_id: randomUUID(), p_name: "Boleto 2" });
    assert.deepEqual(clone.list.payment_methods, [{ id: method, name: "Boleto sintético" }]);
    // A 121 body (without the new keys) keeps working.
    assert.equal((await save({ ...base, name: "Antiga" })).list.sellers.length, 0);
    const listing = await f.rpc("erp_pricing_lists", { p_user_id: f.users.consulta, p_category: "payment_method" });
    assert.deepEqual(listing.items.map((item) => item.name).sort(), ["Atacado", "Boleto", "Boleto 2"]);
    assert.equal(Object.hasOwn(listing.items[0], "payment_methods"), false, "the listing stays lean");
  } finally {
    await f.close();
  }
});

test("154 a new list with the selected products (one command); deleted products and an edit with add_products are refused", async () => {
  const f = await productsFixture();
  const save = (data, { id = null, version = 0, command = randomUUID() } = {}) =>
    f.rpc("erp_pricing_list_save", { p_user_id: f.users.admin, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  try {
    const a = await f.product({ name: "Parafuso", price: "10.1250" }),
      b = await f.product({ name: "Porca", price: "0.50" });
    const command = randomUUID();
    const created = await save({ ...base, add_products: [a.id, b.id] }, { command });
    assert.deepEqual([created.list.products, created.list.version], [2, 1]);
    assert.deepEqual(await save({ ...base, add_products: [a.id, b.id] }, { command }), { ...created, replayed: true });
    const detail = await f.rpc("erp_pricing_list_get", { p_user_id: f.users.admin, p_id: created.list.id });
    assert.deepEqual(detail.items.map((item) => [item.name, item.list_price]), [["Parafuso", "9.11"], ["Porca", "0.45"]]);
    assert.equal((await f.rows("select after_data->>'added_products' v from erp_pricing.audit where list_id=$1", [created.list.id]))[0].v, "2");
    const gone = await f.product({ name: "Excluído", price: "1" });
    await f.rpc("erp_catalog_product_set_deleted", { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
    await fails(assert, save({ ...base, name: "Com excluído", add_products: [gone.id] }), "22023");
    await fails(assert, save({ ...base, name: "Repetido", add_products: [a.id, a.id] }), "22023");
    await fails(assert, save({ ...base, add_products: [b.id] }, { id: created.list.id, version: 1 }), "22023");
  } finally {
    await f.close();
  }
});

test('154 the period filter "Cadastrada em" uses São Paulo dates; the list prices of a product set follow the list and its validity', async () => {
  const f = await productsFixture();
  const save = (data) =>
    f.rpc("erp_pricing_list_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data });
  try {
    const a = await f.product({ name: "Parafuso", price: "10" }),
      b = await f.product({ name: "Arruela", price: "2" }),
      free = await f.product({ name: "Sem preço" });
    const old = (await save({ ...base, name: "Antiga", add_products: [a.id] })).list;
    const recent = (await save({ ...base, name: "Recente", factor: "1", factor_unit: "amount", direction: "increase", add_products: [a.id, free.id] })).list;
    // 2026-10-01 02:30 UTC is still 30/09 in São Paulo.
    await f.write("update erp_pricing.price_list set created_at='2026-10-01T02:30:00Z' where id=$1", [old.id]);
    const names = async (from, to) => (await f.rpc("erp_pricing_lists", { p_user_id: f.users.admin, p_from: from, p_to: to })).items.map((item) => item.name);
    assert.deepEqual(await names("2026-09-30", "2026-09-30"), ["Antiga"]);
    assert.deepEqual(await names("2026-10-01", null), ["Recente"]);
    await fails(assert, f.rpc("erp_pricing_lists", { p_user_id: f.users.admin, p_from: "2026-10-02", p_to: "2026-10-01" }), "22023");
    const prices = await f.rpc("erp_pricing_list_prices", { p_user_id: f.users.vendas, p_id: recent.id, p_product_ids: [a.id, b.id, free.id] });
    assert.deepEqual(prices.items.map((item) => [item.in_list, item.list_price]), [[true, "11.00"], [false, null], [true, null]]);
    assert.deepEqual([prices.list.rule, prices.list.valid_now], ["Acréscimo R$ 1,00", true]);
    const expired = (await save({ ...base, name: "Expirada", list_type: "period", starts_on: "2020-01-01", ends_on: "2020-01-31", add_products: [a.id] })).list;
    assert.equal((await f.rpc("erp_pricing_list_prices", { p_user_id: f.users.admin, p_id: expired.id, p_product_ids: [a.id] })).list.valid_now, false);
    await fails(assert, f.rpc("erp_pricing_list_prices", { p_user_id: f.users.admin, p_id: recent.id, p_product_ids: [a.id, a.id] }), "22023");
    await fails(assert, f.rpc("erp_pricing_list_prices", { p_user_id: f.users.admin, p_id: randomUUID(), p_product_ids: [a.id] }), "P0002");
    await fails(assert, f.rpc("erp_pricing_list_prices", { p_user_id: f.users.financeiro, p_id: recent.id, p_product_ids: [a.id] }), "42501");
  } finally {
    await f.close();
  }
});

test("192 planilha modelo: codes link products, custom prices, the summary, replay, versions and refusals", async () => {
  const f = await productsFixture();
  const save = (data, user = f.users.admin) =>
    f.rpc("erp_pricing_list_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data });
  const sheet = (list, rows, { command = randomUUID(), version = list.version, user = f.users.admin } = {}) =>
    f.rpc("erp_pricing_list_import", { p_user_id: user, p_id: list.id, p_expected_version: version, p_command_id: command, p_rows: rows });
  try {
    const a = await f.product({ name: "Parafuso", code: "PAR-1", price: "10" }),
      b = await f.product({ name: "Porca", code: "POR-1", price: "2" });
    await f.product({ name: "Arruela A", code: "ARR", price: "1" });
    await f.product({ name: "Arruela B", code: "arr", price: "1" });
    const gone = await f.product({ name: "Excluído", code: "EXC", price: "1" });
    await f.rpc("erp_catalog_product_set_deleted", { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
    const rates = (await save(base)).list;
    const command = randomUUID();
    const lines = [{ code: " par-1 " }, { code: "POR-1" }, { code: "PAR-1" }, { code: "NAO-EXISTE" }, { code: "ARR" }, { code: "EXC" }];
    const result = await sheet(rates, lines, { command });
    assert.deepEqual(
      [result.saved, result.added, result.updated, result.unchanged, result.duplicates, result.not_found, result.not_found_total, result.ambiguous,
        result.ambiguous_total, result.list.products, result.list.version],
      [true, 2, 0, 0, 1, ["NAO-EXISTE", "EXC"], 2, ["ARR"], 1, 2, 2],
    );
    assert.deepEqual(await sheet(rates, lines, { command }), { ...result, replayed: true });
    await fails(assert, sheet(rates, [{ code: "PAR-1" }], { command }), "40001");
    const detail = await f.rpc("erp_pricing_list_get", { p_user_id: f.users.admin, p_id: rates.id });
    assert.deepEqual(detail.items.map((item) => [item.name, item.list_price]), [["Parafuso", "9.00"], ["Porca", "1.80"]]);
    // Nothing new: no new version, no audit.
    const again = await sheet(result.list, [{ code: "PAR-1" }]);
    assert.deepEqual([again.added, again.unchanged, again.list.version], [0, 1, 2]);
    assert.equal(await f.scalar("select count(*)::int v from erp_pricing.audit where list_id=$1 and action='items'", [rates.id]), 1);
    await fails(assert, sheet(result.list, [{ code: "PAR-1", price: "5" }]), "22023");
    await fails(assert, sheet(rates, [{ code: "PAR-1" }]), "40001");
    // Customized list: the price of the line is the product price in the list.
    const custom = (await save({ ...base, name: "Especial", list_type: "custom", factor: null })).list;
    const priced = await sheet(custom, [{ code: "PAR-1", price: "7.5" }, { code: "POR-1", price: "" }]);
    assert.deepEqual([priced.added, priced.updated], [2, 0]);
    const repriced = await sheet(priced.list, [{ code: "PAR-1", price: "8" }, { code: "POR-1" }]);
    assert.deepEqual([repriced.added, repriced.updated, repriced.unchanged], [0, 1, 1]);
    const items = (await f.rpc("erp_pricing_list_get", { p_user_id: f.users.admin, p_id: custom.id })).items;
    assert.deepEqual(items.map((item) => [item.name, item.custom_price, item.list_price]), [["Parafuso", "8.0000", "8.00"], ["Porca", null, "2.00"]]);
    for (const bad of [
      [], [{}], [{ code: "" }], [{ code: "x".repeat(101) }], [{ code: "A", extra: 1 }], [{ code: 1 }], [{ code: "A", price: 1 }], [{ code: "A\tB" }],
      Array.from({ length: 501 }, () => ({ code: "A" })),
    ])
      await fails(assert, sheet(repriced.list, bad), "22023");
    await fails(assert, sheet(repriced.list, [{ code: "PAR-1", price: "1,5" }]), "22023");
    await fails(assert, sheet(repriced.list, [{ code: "PAR-1" }], { user: f.users.vendas }), "42501");
    await fails(assert, sheet({ id: randomUUID(), version: 1 }, [{ code: "PAR-1" }]), "P0002");
    assert.ok(a.id && b.id);
  } finally {
    await f.close();
  }
});

test("192 applicable lists: Outra, Contato, Região by the contact UF, Vendedor and Forma de pagamento, only while valid", async () => {
  const f = await productsFixture();
  const save = (data) =>
    f.rpc("erp_pricing_list_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).then((v) => v.list);
  try {
    const customer = await f.contact({ name: "Cliente SP", state: "sp" }),
      other = await f.contact({ name: "Outro cliente", state: "RJ" });
    const sellerContact = await f.contact({ name: "Vendedora" });
    const seller = await f.write("insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v", [sellerContact.id, f.users.admin]);
    const method = await f.write(
      "insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Pix sintético','17','contas','recebimentos',$1,$1) returning id v",
      [f.users.admin],
    );
    await save({ ...base, name: "Geral" });
    await save({ ...base, name: "Do cliente", category: "contact", contacts: [customer.id] });
    await save({ ...base, name: "Paulista", category: "region", regions: ["SP"] });
    await save({ ...base, name: "Da vendedora", category: "seller", sellers: [seller] });
    await save({ ...base, name: "No Pix", category: "payment_method", payment_methods: [method] });
    await save({ ...base, name: "Vencida", list_type: "period", starts_on: "2020-01-01", ends_on: "2020-12-31" });
    const names = async (args) => (await f.rpc("erp_pricing_applicable_lists", { p_user_id: f.users.vendas, ...args })).items.map((item) => item.name);
    assert.deepEqual(await names({}), ["Geral"]);
    assert.deepEqual(await names({ p_contact_id: customer.id }), ["Do cliente", "Geral", "Paulista"], "the UF of the contact");
    assert.deepEqual(await names({ p_contact_id: other.id }), ["Geral"]);
    assert.deepEqual(await names({ p_contact_id: other.id, p_state: "SP" }), ["Geral", "Paulista"], "the UF of the document wins");
    assert.deepEqual(await names({ p_seller_id: seller, p_payment_method_id: method }), ["Da vendedora", "Geral", "No Pix"]);
    const answer = await f.rpc("erp_pricing_applicable_lists", { p_user_id: f.users.vendas, p_contact_id: customer.id });
    assert.deepEqual([answer.state, answer.contact_id, Object.hasOwn(answer.items[0], "contacts"), typeof answer.items[0].rule], ["SP", customer.id, false, "string"]);
    await fails(assert, f.rpc("erp_pricing_applicable_lists", { p_user_id: f.users.vendas, p_state: "XX" }), "22023");
    await fails(assert, f.rpc("erp_pricing_applicable_lists", { p_user_id: f.users.financeiro }), "42501");
    // v2 (várias formas de pagamento), não coberta pelo teste original: o mesmo cenário nos dois motores.
    const v2 = async (args) => (await f.rpc("erp_pricing_applicable_lists_v2", { p_user_id: f.users.vendas, ...args })).items.map((item) => item.name);
    assert.deepEqual(await v2({ p_seller_id: seller, p_payment_method_ids: [randomUUID(), method] }), ["Da vendedora", "Geral", "No Pix"]);
    assert.deepEqual(await v2({ p_contact_id: customer.id, p_state: "RJ" }), ["Do cliente", "Geral"]);
    for (const ids of [[], [method, method], Array.from({ length: 21 }, () => randomUUID())])
      await fails(assert, f.rpc("erp_pricing_applicable_lists_v2", { p_user_id: f.users.vendas, p_payment_method_ids: ids }), "22023");
  } finally {
    await f.close();
  }
});
