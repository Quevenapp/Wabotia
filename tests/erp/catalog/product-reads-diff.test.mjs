// Diferencial aleatório das leituras de produto (semente fixa): um catálogo
// variado (acentos, códigos com e sem caixa, GTIN, marca, NCM, tipos e
// formatos, inativos, excluídos, categorias, tags, imagens, fornecedores,
// validade, estoque em dois depósitos, um deles desconsiderado) e consultas
// aleatórias às páginas v1/v2/v3, exportações, lista por cursor, cadastro,
// prévia de reajuste, dados de compra e variações. Cada consulta roda nos dois
// motores; divergência de resposta ou erro falha o teste.
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

test("diferencial aleatório: páginas, exportações, lista, cadastro, reajuste, compra e variações", async () => {
  const r = rng(20261117);
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
      t[e.code] = (t[e.code] ?? 0) + 1;
      tally.set(last, t);
      return null;
    }
  };

  // Catálogo de apoio (gravações não portadas: Postgres, depois cópia).
  const categories = [(await f.taxonomySave("categories", { name: "Ferragens" })).item.id, (await f.taxonomySave("categories", { name: "Elétrica" })).item.id];
  const tags = [(await f.taxonomySave("tags", { name: "Promoção" })).item.id, (await f.taxonomySave("tags", { name: "Destaque" })).item.id];
  const suppliers = [
    (await f.save("contacts", { name: "Fornecedor Ácido", roles: ["supplier"] })).id,
    (await f.save("contacts", { name: "Fornecedor Beta", roles: ["supplier"] })).id,
  ];
  // Dois depósitos pela rota do estoque; o segundo com "Desconsiderar saldo deste depósito".
  const warehouses = [(await f.warehouse("Geral")).id, (await f.warehouse("Loja", true)).id];
  const names = ["Parafuso", "parafuso inox", "Ábaco", "Çedilha", "Ωmega", "Zíper", "Arruela", "Porca 10", "Ñandu", "Égua", "Kit montagem"];
  const products = [];
  for (let i = 0; i < 36; i++) {
    const data = {
      name: `${pick(names)} ${i}`,
      unit: "UN",
      kind: pick(["P", "P", "P", "S"]),
      format: pick(["S", "S", "S", "E"]),
      ...(maybe(0.7) ? { code: pick([`C-${i}`, `c-${i}`, `X${i}`, `00${i}`]) } : {}),
      ...(maybe(0.6) ? { price: pick(["10", "10.1250", "0.3333333333", "0.005", "99999999999999.9999", "1", "2.5", "0"]) } : {}),
      ...(maybe(0.4) ? { brand: pick(["Marca Á", "marca a", "Tramontina", "TRAMONTINA"]) } : {}),
      ...(maybe(0.4) ? { ncm: pick(["73181500", "7318", "85044010"]) } : {}),
      ...(maybe(0.3) ? { category_id: pick(categories) } : {}),
      ...(maybe(0.3) ? { tag_ids: [pick(tags)] } : {}),
      ...(maybe(0.25) ? { images: [{ url: `https://exemplo.test/${i}.png` }] } : {}),
      ...(maybe(0.3) ? { expiry_date: pick(["2026-12-31", "2027-02-28", "2030-01-01"]) } : {}),
      ...(maybe(0.3) ? { item_type: pick(["00", "09"]) } : {}),
      ...(maybe(0.3)
        ? { suppliers: [{ supplier_id: pick(suppliers), code: pick(["F-1", "Mont-Ábc", "x9"]), is_default: true, purchase_price: pick(["1.2", "0", "3"]), cost_price: pick(["1.3456789012", "0", "5"]) }] }
        : {}),
    };
    const saved = await attempt(f.productSave(data));
    if (!saved) continue;
    products.push(saved.record);
    if (data.kind === "P" && maybe(0.5)) await attempt(f.stock(saved.record.id, pick(warehouses), pick(["2", "-1", "0.5", "3.25"])));
  }
  assert.ok(products.length > 25, `poucos produtos: ${products.length}`);
  for (const p of products.slice(0, 4)) await f.setDeleted(p.id, p.version, true);
  await f.productSave({ active: false }, { id: products[5].id, version: products[5].version });
  // Um pai com variações para a leitura das variações.
  const parent = (await f.productSave({ name: "Camiseta", code: "CAM", unit: "UN", kind: "P", format: "V", price: "49.90" })).record;
  for (const [size, price] of [["P", "49.90"], ["M", "52"], ["G", null]])
    await attempt(
      f.rpc("erp_catalog_product_variation_add", {
        p_user_id: admin, p_command_id: randomUUID(), p_parent: parent.id, p_data: { attributes: { Tamanho: size }, ...(price ? { price } : {}) },
      }),
    );
  const ids = products.map((p) => p.id);
  const filterArgs = () => ({
    ...(maybe(0.3) ? { p_query: pick(["par", "PARAFUSO", "c-1", "ábaco", "ωmega", "10", "x1", "73", "", "  "]) } : {}),
    ...(maybe(0.4) ? { p_sort: pick(["created_desc", "name_asc", "name_desc", "code_asc", "code_desc", "price"]) } : {}),
    ...(maybe(0.2) ? { p_brand: pick(["marca a", "tramontina", "Á", "x".repeat(101)]) } : {}),
    ...(maybe(0.2) ? { p_ncm_presence: pick(["present", "missing"]) } : {}),
    ...(maybe(0.15) ? { p_ncm: pick(["73", "7318", "8"]) } : {}),
    ...(maybe(0.25) ? { p_stock: pick(["zero", "negative", "positive", "no_movements"]) } : {}),
    ...(maybe(0.15) ? { p_warehouse_id: pick([...warehouses, randomUUID()]) } : {}),
    ...(maybe(0.15) ? { p_period: pick(["created", "updated"]), p_from: pick(["2026-01-01", null]), p_to: pick(["2099-12-31", "2026-01-02"]) } : {}),
  });
  const v2Args = () => ({
    ...filterArgs(),
    ...(maybe(0.3) ? { p_situation: pick(["latest", "active", "inactive", "deleted", "all"]) } : {}),
    ...(maybe(0.25) ? { p_product_type: pick(["composition", "no_composition", "products", "simple", "with_variations", "variations", "services"]) } : {}),
    ...(maybe(0.15) ? { p_images: pick(["yes", "no"]) } : {}),
    ...(maybe(0.15) ? { p_tag: pick([...tags, "none"]) } : {}),
    ...(maybe(0.15) ? { p_category: pick([...categories, "none"]) } : {}),
    ...(maybe(0.1) ? { p_item_type: pick(["00", "09", "11"]) } : {}),
    ...(maybe(0.1) ? { p_supplier_id: pick(suppliers) } : {}),
    ...(maybe(0.1) ? { p_supplier_code: pick(["mont-abc", "F-", "x"]) } : {}),
    ...(maybe(0.1) ? { p_period: "expiry", p_from: pick(["2026-12-31", null]), p_to: pick(["2027-02-28", "2030-01-01"]) } : {}),
  });
  const users = [admin, admin, f.users.consulta, f.users.vendas, f.users.estoque, f.users.financeiro];
  for (let i = 0; i < 160; i++) {
    const user = pick(users);
    const kind = pick(["page", "v2", "v2", "v3", "export", "export2", "list", "get", "preview", "purchase", "variations"]);
    if (kind === "page")
      await attempt(rpc("erp_catalog_product_page", { p_user_id: user, p_page: pick([1, 1, 2]), p_size: pick([5, 100]), ...filterArgs(), ...(maybe(0.3) ? { p_active: pick([true, false]) } : {}), ...(maybe(0.2) ? { p_kind: pick(["P", "S", "X"]) } : {}) }));
    else if (kind === "v2") await attempt(rpc("erp_catalog_product_page_v2", { p_user_id: user, p_page: pick([1, 1, 2]), p_size: pick([5, 100]), ...v2Args() }));
    else if (kind === "v3")
      await attempt(rpc("erp_catalog_product_page_v3", { p_user_id: user, p_size: pick([10, 100]), ...v2Args(), ...(maybe(0.3) ? { p_product_type: "composition", p_component_id: pick(ids) } : {}) }));
    else if (kind === "export")
      await attempt(rpc("erp_catalog_product_export", { p_user_id: user, p_limit: pick([250, 7]), p_offset: pick([0, 0, 3]), ...v2Args(), ...(maybe(0.3) ? { p_include_deleted: true } : {}) }));
    else if (kind === "export2") await attempt(rpc("erp_catalog_product_export_v2", { p_user_id: user, ...v2Args() }));
    else if (kind === "list") {
      let cursor = null;
      for (let n = 0; n < 4; n++) {
        const page = await attempt(
          rpc("erp_catalog_product_list", {
            p_user_id: user, p_limit: pick([5, 10, 100]), p_after: cursor, ...(maybe(0.3) ? { p_query: pick(["par", "c-", "10"]) } : {}),
            ...(maybe(0.2) ? { p_brand: pick(["MARCA", "tram"]) } : {}), ...(maybe(0.2) ? { p_kind: pick(["P", "S"]) } : {}),
          }),
        );
        if (!page?.has_more) break;
        cursor = page.next_cursor;
      }
    } else if (kind === "get") await attempt(rpc("erp_catalog_product_get", { p_user_id: user, p_id: maybe(0.9) ? pick(ids) : randomUUID() }));
    else if (kind === "preview")
      await attempt(
        rpc("erp_catalog_product_price_preview", {
          p_user_id: user,
          p_rule: pick([
            { action: "increase", unit: "percent", value: "10" }, { action: "discount", unit: "percent", value: "33.3333" }, { action: "discount", unit: "amount", value: "5" },
            { action: "fix", unit: "amount", value: "2" }, { action: "fix", unit: "percent", value: "2" }, { action: "increase", unit: "amount", value: "1,5" },
            { action: "discount", unit: "percent", value: "100" }, { action: "increase", unit: "percent", value: "9999999999999.9999" },
          ]),
          p_ids: ids.filter(() => maybe(0.4)).concat(maybe(0.1) ? [randomUUID()] : []),
        }),
      );
    else if (kind === "purchase")
      await attempt(
        rpc("erp_catalog_product_purchase_info", {
          p_user_id: user, p_product_ids: ids.filter(() => maybe(0.3)).slice(0, 100), ...(maybe(0.6) ? { p_supplier_id: pick(suppliers) } : {}),
        }),
      );
    else await attempt(rpc("erp_catalog_product_variations", { p_user_id: user, p_parent: pick([parent.id, parent.id, pick(ids), randomUUID()]) }));
  }
  for (const [name, t] of [...tally].sort()) console.log(name, JSON.stringify(t));
  for (const name of ["erp_catalog_product_page_v2", "erp_catalog_product_export", "erp_catalog_product_get", "erp_catalog_product_price_preview"])
    assert.ok((tally.get(name)?.ok ?? 0) >= 3, `${name}: poucas chamadas com sucesso ${JSON.stringify(tally.get(name))}`);
});
