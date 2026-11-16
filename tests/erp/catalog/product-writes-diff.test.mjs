// Diferencial aleatório das gravações de produto (semente fixa): inclusão e
// alteração com o detalhe (datas, decimais, URLs, DUN, fornecedores, tags,
// imagens, campos customizados), exclusão e restauração, variações e os
// reajustes (selecionados e filtrados) e a atualização de venda e custo.
// Cada chamada roda nos dois motores; divergência de resposta, erro ou
// tabela falha o teste.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { productsFixture } from "../fagoo/catalog-products-fixture.mjs";

let f;
before(async () => {
  f = await productsFixture();
});
after(async () => f?.close());

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("diferencial aleatório: produto (cadastro e detalhe), exclusão, variações e preços", async () => {
  const r = rng(20261118);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const maybe = (p) => r() < p;
  const admin = f.users.admin;
  const tally = new Map();
  let last = "?";
  const rpc = (name, args) => {
    last = name;
    return f.rpc(name, args);
  };
  const attempt = async (promise) => {
    try {
      const out = await promise;
      tally.set(last, { ...(tally.get(last) ?? {}), ok: (tally.get(last)?.ok ?? 0) + 1 });
      return out;
    } catch (e) {
      if (!e.code || e.code === "ERR_ASSERTION") throw e;
      const t = tally.get(last) ?? {};
      t[`${e.code}:${e.message}`] = (t[`${e.code}:${e.message}`] ?? 0) + 1;
      tally.set(last, t);
      return null;
    }
  };
  const category = (await f.taxonomySave("categories", { name: "Ferragens" })).item.id;
  const sub = (await f.taxonomySave("categories", { name: "Parafusos", parent_id: category })).item.id;
  const group = (await f.taxonomySave("product_groups", { name: "Fixadores" })).item.id;
  const tags = [(await f.taxonomySave("tags", { name: "Promoção" })).item.id, (await f.taxonomySave("tags", { name: "Destaque" })).item.id];
  const suppliers = [(await f.save("contacts", { name: "Fornecedor A", roles: ["supplier"] })).id, (await f.save("contacts", { name: "Fornecedor B", roles: ["supplier"] })).id];
  const field = await f.rpc("erp_catalog_custom_field_save", {
    p_user_id: admin, p_command_id: randomUUID(), p_id: null, p_expected_version: 0,
    p_data: { module: "products", field_type: "text", name: "Material", required: false, grouped: false, active: true },
  }).catch(() => null);
  const fieldId = field?.item?.id ?? field?.field?.id ?? null;

  const products = new Map(); // id → versão
  const detail = () => ({
    ...(maybe(0.3) ? { expiry_date: pick(["2027-02-28", "2027-02-30", "1899-01-01", null, "27-02-01"]) } : {}),
    ...(maybe(0.2) ? { free_shipping: pick([true, false, null, "sim"]) } : {}),
    ...(maybe(0.3) ? { notes: pick(["Obs\tcom tab", "Linha 1\nLinha 2", "a\u0001", null, "x".repeat(2001), "  "]) } : {}),
    ...(maybe(0.2) ? { external_link: pick(["https://exemplo.test/p", "ftp://x.test", "http://a b", null]) } : {}),
    ...(maybe(0.2) ? { crossdocking_days: pick(["3", "0", "10000", "03", null, 3]) } : {}),
    ...(maybe(0.3) ? { category_id: pick([category, sub, group, null, randomUUID()]) } : {}),
    ...(maybe(0.15) ? { product_group_id: pick([group, category, null]) } : {}),
    ...(maybe(0.15) ? { fci_number: pick(["b01f70af-10bf-4b1f-848c-65ff57f616fe", "nao-e-fci", null]) } : {}),
    ...(maybe(0.2) ? { item_type: pick(["00", "09", "11", null]) } : {}),
    ...(maybe(0.25) ? { tax_percent: pick(["12.5", "100", "100.01", "1.23456", "0", null]) } : {}),
    ...(maybe(0.15) ? { icms_st_retention_base: pick(["10", "1.234", "9999999999999.99"]) } : {}),
    ...(maybe(0.15) ? { ipi_seal_code: pick(["971-001", "a b", null]) } : {}),
    ...(maybe(0.15) ? { items_per_box_decimal: pick(["12", "1.5", "999999.999999", "0", "1234567"]) } : {}),
    ...(maybe(0.1) ? { lot_control: pick([true, false, "sim"]) } : {}),
    ...(maybe(0.2) ? { dun_codes: pick([[{ code: "17891234567892", quantity: "12" }], [{ code: "123", quantity: "1" }], [{ code: "17891234567892", quantity: "0" }], []]) } : {}),
    ...(maybe(0.3)
      ? {
          suppliers: pick([
            [{ supplier_id: suppliers[0], is_default: true, purchase_price: pick(["1.2", "0", "99999999999999.9999999999"]), cost_price: pick(["1.3456789012", null, "5"]), warranty_months: pick(["12", null, "1000"]) }],
            [{ supplier_id: suppliers[0], is_default: true }, { supplier_id: suppliers[1], is_default: false, code: "F-2" }],
            [{ supplier_id: suppliers[0], is_default: true }, { supplier_id: suppliers[1], is_default: true }],
            [{ supplier_id: suppliers[0] }],
            [],
          ]),
        }
      : {}),
    ...(maybe(0.2) ? { tag_ids: pick([[tags[0]], tags, [tags[0], tags[0]], [], [category]]) } : {}),
    ...(maybe(0.2) ? { images: pick([[{ url: "https://exemplo.test/a.png" }], [{ url: "http://inseguro.test/a.png" }], [{ url: "https://a.test/x y.png" }], []]) } : {}),
    ...(fieldId && maybe(0.15) ? { custom_values: pick([{ [fieldId]: "Aço" }, { [fieldId]: null }, { [fieldId]: "  " }, { [randomUUID()]: "x" }]) } : {}),
  });
  const baseData = () => ({
    ...(maybe(0.8) ? { name: pick(["Parafuso", "Porca", "Ábaco", "Ωmega", "Kit", "", "x".repeat(201)]) + ` ${Math.floor(r() * 99)}` } : {}),
    ...(maybe(0.6) ? { code: pick([`C-${Math.floor(r() * 30)}`, `c-${Math.floor(r() * 30)}`, "", null]) } : {}),
    ...(maybe(0.6) ? { price: pick(["10", "10.1250", "0.3333333333", "99999999999999.9999", "1,5", "-1", null]) } : {}),
    ...(maybe(0.4) ? { unit: pick(["UN", "KG", "CX"]) } : {}),
    ...(maybe(0.3) ? { kind: pick(["P", "S", "X"]) } : {}),
    ...(maybe(0.3) ? { format: pick(["S", "S", "V", "E"]) } : {}),
    ...(maybe(0.2) ? { gtin: pick(["7891234567895", "SEM GTIN", "123"]) } : {}),
    ...(maybe(0.1) ? { active: pick([true, false, "true"]) } : {}),
  });
  const users = [admin, admin, admin, admin, f.users.estoque, f.users.vendas];
  for (let i = 0; i < 50; i++) {
    const out = await attempt(
      rpc("erp_catalog_product_save", {
        p_user_id: pick(users), p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_data: { name: `Base ${i}`, unit: "UN", kind: "P", format: pick(["S", "S", "V"]), ...(maybe(0.35) ? baseData() : {}), ...(maybe(0.5) ? detail() : {}) },
        p_acknowledged: maybe(0.2) ? pick([[], ["duplicate_code"], ["duplicate_code", "duplicate_gtin"], ["x"]]) : null,
      }),
    );
    if (out?.record) products.set(out.record.id, out.record.version);
  }
  assert.ok(products.size > 10, `poucos produtos: ${products.size}`);
  const ids = () => [...products.keys()];
  const refresh = (out) => {
    if (out?.record?.id) products.set(out.record.id, out.record.version);
  };
  for (let i = 0; i < 140; i++) {
    const op = pick(["save", "save", "save", "delete", "variation", "adjust", "adjust", "prices"]);
    const user = pick(users);
    if (op === "save") {
      const id = pick(ids());
      const command = randomUUID();
      const args = {
        p_user_id: user, p_id: id, p_expected_version: maybe(0.9) ? products.get(id) : products.get(id) + 1, p_command_id: command,
        p_data: maybe(0.1) ? {} : { ...(maybe(0.5) ? baseData() : {}), ...detail() },
        p_acknowledged: maybe(0.15) ? ["duplicate_code"] : null,
      };
      refresh(await attempt(rpc("erp_catalog_product_save", args)));
      if (maybe(0.15)) refresh(await attempt(rpc("erp_catalog_product_save", args)));
    } else if (op === "delete") {
      const id = pick(ids());
      refresh(
        await attempt(
          rpc("erp_catalog_product_set_deleted", { p_user_id: user, p_id: id, p_expected_version: products.get(id), p_command_id: randomUUID(), p_deleted: pick([true, true, false, null]) }),
        ),
      );
    } else if (op === "variation") {
      const out = await attempt(
        rpc("erp_catalog_product_variation_add", {
          p_user_id: user, p_command_id: randomUUID(), p_parent: pick(ids()),
          p_data: {
            attributes: pick([{ Tamanho: pick(["P", "M", "G"]) }, { Cor: "Azul", Tamanho: "M" }, { " Cor ": " Azul " }, {}, { Cor: 1 }]),
            code: pick([`SKU-${i}`, null, `C-${Math.floor(r() * 30)}`]), ...(maybe(0.5) ? { price: pick(["12", "0.5", "x"]) } : {}),
          },
        }),
      );
      if (out?.child_id) products.set(out.child_id, 1);
    } else if (op === "adjust") {
      const rule = pick([
        { action: "increase", unit: "percent", value: "10" }, { action: "discount", unit: "amount", value: "5" }, { action: "fix", unit: "amount", value: "2" },
        { action: "increase", unit: "percent", value: "9999999999999.9999" }, { action: "discount", unit: "percent", value: "100" },
      ]);
      const sel = ids().filter(() => maybe(0.2)).slice(0, 10);
      await attempt(
        rpc(
          "erp_catalog_product_price_adjust",
          maybe(0.6) && sel.length
            ? { p_user_id: user, p_command_id: randomUUID(), p_rule: rule, p_items: sel.map((id) => ({ id, expected_version: maybe(0.9) ? products.get(id) : 99 })) }
            : {
                p_user_id: user, p_command_id: randomUUID(), p_rule: rule,
                p_filters: pick([{ query: "parafuso" }, { situation: "active" }, { category: "none" }, { situation: "deleted" }, { product_type: "simple", ncm_presence: "missing" }, { from: "2026-02-30" }]),
              },
        ),
      );
      // Reajuste muda versões: relê.
      for (const id of ids()) {
        const v = await f.scalar("select version v from erp_catalog.record where id=$1", [id]);
        if (v !== undefined) products.set(id, v);
      }
    } else {
      const sel = ids().filter(() => maybe(0.15)).slice(0, 5);
      if (!sel.length) continue;
      const supplier = maybe(0.6) ? pick(suppliers) : null;
      const out = await attempt(
        rpc("erp_catalog_product_prices_update", {
          p_user_id: user, p_command_id: randomUUID(), p_supplier_id: supplier,
          p_items: sel.map((id) => ({
            product_id: id, expected_version: products.get(id),
            ...(maybe(0.7) ? { price: pick(["12", "0.0001", "1,5"]) } : {}),
            ...(supplier && maybe(0.6) ? { cost_price: pick(["3", "4.25"]) } : {}),
          })),
        }),
      );
      for (const item of out?.items ?? []) products.set(item.product_id, item.version);
    }
  }
  for (const [name, t] of [...tally].sort()) console.log(name, JSON.stringify(t));
  for (const name of ["erp_catalog_product_save", "erp_catalog_product_set_deleted", "erp_catalog_product_price_adjust"])
    assert.ok((tally.get(name)?.ok ?? 0) >= 3, `${name}: poucas chamadas com sucesso ${JSON.stringify(tally.get(name))}`);
});
