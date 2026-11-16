// Portão da fase 0, item (a): o que o erp_stock_post não exercita.
//   node --test tests/erp/cross-domain.test.mjs
// 1. Chamada entre domínios com o mesmo command_id: erp_documents.auto_products
//    (parte do erp_document_save) chama erp_catalog.document_product com o
//    comando do DOCUMENTO; o catálogo grava o recibo em erp_catalog.command,
//    a mesma tabela do erp_catalog_save, com escopo (md5 do comando + posição).
//    O mesmo id é usado antes num erp_catalog_save: sem o escopo, colidiria.
// 2. Validação pesada de jsonb: erp_catalog.validate_data (contatos,
//    produtos, depósitos) isolada, com objetos aleatórios, contra o PGlite.
// Tudo nos dois motores: resposta (ou erro) e tabelas tocadas iguais.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { autoProducts } from "../../src/erp/domains/documents/internal.ts";
import { validateData } from "../../src/erp/domains/catalog/internal.ts";
import { scopedCommand } from "../../src/erp/domains/catalog/public.ts";

const f = await dualFixture();
const { users } = f;

const auto = (user, kind, command, items) =>
  f.dual(
    "erp_documents.auto_products",
    async () =>
      (await f.db.query("select erp_documents.auto_products($1::uuid,$2::text,$3::uuid,$4::jsonb) v", [user, kind, command, JSON.stringify(items)]))
        .rows[0].v,
    () => inTransaction(f.driver, (ctx) => autoProducts(ctx, user, kind, command, structuredClone(items)), f.clock),
  );
const fails = async (promise, code, message) => {
  await assert.rejects(promise, (e) => e.code === code && (!message || e.message === message));
};

test.after(() => f.close());

test("documento chama o catálogo com o próprio comando; recibo com escopo", async () => {
  await f.rpc("erp_preferences_save", {
    p_user_id: users.admin,
    p_command_id: randomUUID(),
    p_page: "cadastros-produtos",
    p_changes: [
      { key: "produtos.cadastro_auto_compras", expected_version: 0, value: true },
      { key: "produtos.cadastro_auto_vendas", expected_version: 0, value: true },
    ],
  });
  const command = randomUUID();
  // O mesmo id já foi recibo de um erp_catalog_save (mesma tabela de recibos).
  const existing = (
    await f.rpc("erp_catalog_save", {
      p_user_id: users.admin,
      p_entity: "products",
      p_id: null,
      p_expected_version: 0,
      p_command_id: command,
      p_data: { name: "Porca já cadastrada", code: "PRC-1", unit: "UN", kind: "P" },
    })
  ).record;
  const items = [
    { position: 1, description: "Parafuso sextavado", unit: "UN", unit_price: "12.5", quantity: "2" },
    { position: 2, description: "Porca", code: "prc-1", unit: "UN", unit_price: "1" },
    { position: 3, product_id: existing.id, description: "Já tem produto", unit: "UN", unit_price: "3" },
    { position: 4, description: "  Arruela de pressão  ", unit: "PC", unit_price: "99999999999999.9999999999" },
    { position: 5, description: "Serviço avulso", unit: "H", unit_price: 80, kind: "S" },
  ];
  const out = await auto(users.vendas, "sales_orders", command, items);
  assert.equal(out[1].product_id, existing.id, "código igual (sem caixa) usa o cadastro");
  assert.equal(out[2].product_id, existing.id);
  const created = [out[0].product_id, out[3].product_id, out[4].product_id];
  assert.ok(created.every((id) => id && id !== existing.id));
  // Três recibos no catálogo com escopo, mais o do erp_catalog_save com o id puro.
  const receipts = await f.db.query("select command_id from erp_catalog.command where command_id = any($1::uuid[])", [
    [command, ...[1, 4, 5].map((p) => scopedCommand("document-auto-product", command, String(p)))],
  ]);
  assert.equal(receipts.rows.length, 4);
  // Repetição: mesmos produtos, nada novo.
  const again = await auto(users.vendas, "sales_orders", command, items);
  assert.deepEqual(again.map((i) => i.product_id), out.map((i) => i.product_id));
  // Mesmo comando e posição com outro conteúdo: conflito no recibo do catálogo.
  await fails(auto(users.vendas, "sales_orders", command, [{ ...items[0], description: "Outro" }]), "40001", "erp_catalog_command_conflict");
  // Compra: o preço não vai para o cadastro; papel de vendas não grava compra.
  const purchase = await auto(users.admin, "purchase_orders", randomUUID(), [{ position: 1, description: "Matéria-prima", unit: "KG", unit_price: "7" }]);
  assert.ok(purchase[0].product_id);
  await fails(auto(users.vendas, "purchase_orders", randomUUID(), [{ position: 1, description: "X", unit: "UN" }]), "42501", "erp_catalog_access_denied");
});

test("itens inválidos: a mesma recusa nos dois motores", async () => {
  const bad = [
    [{ position: 1, unit: "UN" }, "erp_catalog_name_required"],
    [{ position: 1, description: "x".repeat(201), unit: "UN" }, "erp_catalog_invalid_text"],
    [{ position: 1, description: "Tab\tno nome", unit: "UN" }, "erp_catalog_invalid_text"],
    [{ position: 1, description: "Unidade longa", unit: "U".repeat(17) }, "erp_catalog_invalid_text"],
    [{ position: 1, description: "Preço", unit: "UN", unit_price: "1.12345678901" }, "erp_unit_price_invalid"],
    [{ position: 1, description: "Preço", unit: "UN", unit_price: "-1" }, "erp_unit_price_invalid"],
    [{ position: 1, description: "Preço", unit: "UN", unit_price: "0123" }, "erp_unit_price_invalid"],
    [{ position: 1, description: "Preço", unit: "UN", unit_price: "100000000000000" }, "erp_unit_price_invalid"],
    [{ position: 1, description: "Tipo", unit: "UN", kind: "X" }, "erp_catalog_invalid_command"],
    [{ position: 1, description: "Código", code: "c".repeat(101), unit: "UN" }, "erp_catalog_invalid_text"],
  ];
  for (const [item, message] of bad) await fails(auto(users.admin, "sales_orders", randomUUID(), [item]), "22023", message);
});

/** Gerador de objetos para validate_data (mulberry32, semente fixa). */
function generator(seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const text = ["Nome", "  com espaços  ", "", " ", "Ação ç", "linha\nnova", "tab\tx", "ctl\u0001x", "c1\u0085x", "x".repeat(200), "x".repeat(201), null, 5, true, ["a"], { a: 1 }];
  const pools = {
    measure: ["0", "1.5", "012", "1.1234567", "999999999999.999999", "1000000000000", "-1", "1.", null, 1.5],
    count: ["0", "999999", "1000000", "01", "-1", "1.0", null, 3],
    price: ["0", "12.5", "1.2345000000", "0.0000000001", "99999999999999.9999999999", "100000000000000", "1.12345678901", "-1", "01", null, 7, "1e3"],
    roles: [["customer"], ["supplier", "customer", "supplier"], ["carrier", "x"], [], "customer", [1], ["customer", "supplier", "carrier", "customer"], null],
    kind: ["P", "S", "N", "X", "", null],
    format: ["S", "V", "E", "s", null],
    person_type: ["J", "F", "E", "X"],
    condition: ["new", "used", "refurbished", "unspecified", "old"],
    production: ["own", "third_party", "x"],
    dimension_unit: ["m", "cm", "mm", "km"],
    origin: ["0", "8", "9", "a", ""],
    gtin_tax: ["SEM GTIN", "12345678", "1234567890123", "123", "abc"],
    cest: ["1234567", "123", " 1234567 "],
    state: ["SP", "S", "SPX"],
  };
  const keys = {
    contacts: ["name", "code", "trade_name", "person_type", "document", "ie", "email", "phone", "mobile", "postal_code", "street", "number", "complement", "district", "city", "state", "roles"],
    products: ["name", "code", "unit", "price", "kind", "format", "description", "ncm", "gtin", "brand", "condition", "production", "net_weight", "gross_weight", "width", "height", "depth", "dimension_unit", "volumes", "items_per_box", "gtin_tax", "stock_min", "stock_max", "location", "cest", "origin", "additional_info"],
    warehouses: ["name", "code", "description"],
  };
  // Metade dos objetos só com valores válidos: o caminho de aceitação também conta.
  const valid = {
    measure: ["0", "1.5", "999999999999.999999", "0.000001", null],
    count: ["0", "999999", "12", null],
    price: ["0", "12.5", "1.2345000000", "0.0000000001", "99999999999999.9999999999", null],
    roles: [["customer"], ["supplier", "customer", "supplier"], [], ["carrier", "customer"]],
    kind: ["P", "S", "N", null],
    format: ["S", "V", "E"],
    person_type: ["J", "F", "E"],
    condition: ["new", "used"],
    production: ["own", "third_party"],
    dimension_unit: ["m", "cm", "mm"],
    origin: ["0", "8"],
    gtin_tax: ["SEM GTIN", "12345678", "1234567890123"],
    cest: ["1234567", " 1234567 "],
    state: ["SP", "RJ"],
    ncm: ["12345678", "123"],
    gtin: ["SEM GTIN", "1234567890123", "12"],
  };
  let strict = false;
  const value = (k) => {
    if (strict) {
      if (["net_weight", "gross_weight", "width", "height", "depth", "stock_min", "stock_max"].includes(k)) return pick(valid.measure);
      if (["volumes", "items_per_box"].includes(k)) return pick(valid.count);
      if (valid[k]) return pick(valid[k]);
      if (k === "name") return pick(["Produto teste", "  Nome  ", "Ação ç"]);
      return pick(["Texto", "  com espaços  ", "Ação ç", null, "x"]);
    }
    if (rand() < 0.15) return pick(text);
    if (["net_weight", "gross_weight", "width", "height", "depth", "stock_min", "stock_max"].includes(k)) return pick(pools.measure);
    if (["volumes", "items_per_box"].includes(k)) return pick(pools.count);
    if (k === "price") return pick(pools.price);
    if (pools[k]) return pick(pools[k]);
    if (k === "name") return pick(["Produto teste", "  Nome  ", "", null, "N".repeat(200)]);
    return pick(text.slice(0, 7));
  };
  return () => {
    strict = rand() < 0.5;
    const entity = strict ? pick(["products", "products", "contacts", "warehouses"]) : pick(["products", "products", "contacts", "warehouses", "x"]);
    const all = keys[entity] ?? keys.products;
    const data = {};
    for (const k of all) if (rand() < 0.3) data[k] = value(k);
    if (strict) return { entity, data, full: rand() < 0.5 };
    if (rand() < 0.08) data[pick(["extra", "id", "record_id"])] = "x";
    if (rand() < 0.03) data.description = "d".repeat(17000);
    return { entity, data: rand() < 0.03 ? pick([null, [], "x"]) : data, full: rand() < 0.6 };
  };
}

test("validate_data: objetos aleatórios, mesmo resultado ou mesmo erro", async () => {
  const next = generator(Number(process.env.ERP_DIFF_SEED || 20261116));
  const n = Number(process.env.ERP_DIFF_N || 400);
  const tally = {};
  for (let i = 0; i < n; i++) {
    const { entity, data, full } = next();
    let r;
    try {
      r = await f.dual(
        "erp_catalog.validate_data",
        async () =>
          (await f.db.query("select erp_catalog.validate_data($1,$2::jsonb,$3) v", [entity, data === null ? null : JSON.stringify(data), full])).rows[0].v,
        () => inTransaction(f.driver, () => validateData(entity, structuredClone(data), full), f.clock),
      );
      tally.ok = (tally.ok ?? 0) + 1;
    } catch (e) {
      if (!e.code || e.code === "ERR_ASSERTION") throw e; // divergência ou falha do teste
      tally[e.message] = (tally[e.message] ?? 0) + 1;
    }
    void r;
  }
  console.log(`validate_data diferencial: ${n} objetos; ${JSON.stringify(tally)}`);
  assert.ok(tally.ok > n / 10, "parte relevante aceita");
  assert.ok(Object.keys(tally).length > 8, "variedade de recusas");
});
