// Diferencial do Relatório de vendas (erp_document_sales_report) e das listas do filtro
// (erp_document_sales_report_options): pedidos com frete, vendedor, endereço de entrega, itens
// livres e com produto (custo no fornecedor), e filtros aleatórios (grupo, subgrupo, ordem, situação,
// UF, cidade, primeira compra, lucro em todas as bases, listas de uuid) contra o oráculo, com recusas.
//   node --test tests/erp/documents/sales-report-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import "../../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_document_sales_report") && isPorted("erp_document_sales_report_options");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("relatório de vendas: mesmas respostas e erros com filtros aleatórios", { timeout: 1_800_000, skip: ready ? false : "não registrados" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261117) >>> 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = (n) => Math.floor(next() * n);
  const pick = (a) => a[rand(a.length)];
  const u = f.users;
  const users = [u.admin, u.vendas, u.consulta, u.financeiro, u.estoque, u.fiscal].filter(Boolean);
  const supplier = (await f.catalog("contacts", { roles: ["supplier"], name: "Fornecedor SR" })).id;
  const contacts = [];
  for (const [name, city, state, district] of [["Ana SR", "Piracicaba", "SP", "Centro"], ["beto SR", "Curitiba", "PR", null], ["Caio SR", null, null, "  "]])
    contacts.push((await f.catalog("contacts", { roles: ["customer"], name, ...(city ? { city, state } : {}), ...(district !== null ? { district } : {}) })).id);
  const products = [];
  for (const [name, cost] of [["Parafuso SR", "1.3456789012"], ["Porca SR", null], ["Arruela SR", "5"]])
    products.push(
      (await f.rpc("erp_catalog_product_save", {
        p_user_id: u.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
        p_data:{ name, code: name.slice(0, 3).toUpperCase(), unit: "UN", kind: "P", format: "S", price: "10", ...(cost ? { suppliers: [{ supplier_id: supplier, is_default: true, purchase_price: "1.2", cost_price: cost }] } : {}) },
      })).record.id,
    );
  const sellerRef = (label) => ({ introduction: null, attention_to: null, seller_reference: { system: "origin", source_id: String(1 + rand(9)), label }, store_reference: null, business_unit_reference: null, transport: null });
  const days = ["2026-10-01", "2026-10-05", "2026-10-05", "2026-10-20", "2026-11-02", "2026-09-30"];
  let orders = 0;
  for (let i = 0; i < 60 && orders < 14; i++) {
    const items = Array.from({ length: 1 + rand(3) }, () => {
      const p = rand(4) ? pick(products) : null;
      return {
        ...(p ? { product_id: p } : {}), description: pick(["Item SR", "item sr", "Frete avulso", "Peça"]), unit: "UN",
        quantity: pick(["1", "2", "1.5", "0.333333", "10"]), unit_price: pick(["10", "3.33", "7.5", "0.01"]), discount_percent: pick(["0", "0", "10"]),
      };
    });
    const body = {
      date: pick(days), contact_id: pick(contacts), items, installments: [],
      ...(rand(2) ? { freight: pick(["5", "0.5", "12.34"]) } : {}),
      ...(rand(2) ? { commercial: sellerRef(pick(["Carla", "carla", "Davi", "  "])) } : {}),
      ...(rand(3) === 0 ? { expected_date: pick(days) } : {}),
      ...(rand(3) === 0 ? { delivery_address: { name: null, postal_code: null, state: "SP", city: "Piracicaba", district: pick(["Vila Rezende", "centro", " "]), street: "Rua Um", number: "1", complement: null, country: null } } : {}),
    };
    try {
      await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body });
      orders++;
    } catch (e) {
      if (/divergem/.test(e.message)) throw e;
    }
  }
  assert.ok(orders >= 10, `poucos pedidos: ${orders}`);
  // Situações variadas direto no banco dos dois lados não: cancela pelo próprio fluxo quando existir.
  const outcomes = {};
  let accepted = 0, refused = 0;
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      outcomes[name] = (outcomes[name] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError || /divergem/.test(e.message)) {
        console.log(`divergência em ${name}: ${JSON.stringify(args).slice(0, 1500)}`);
        throw e;
      }
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  const maybe = (p) => next() < p;
  const N = Number(process.env.ERP_DIFF_N || 150);
  for (let i = 0; i < N; i++) {
    const user = rand(3) ? u.admin : pick(users);
    if (rand(10) === 0) {
      await call("erp_document_sales_report_options", { p_user_id: user });
      continue;
    }
    // Um passo em quatro pode trazer valores ruins; os outros só valores válidos.
    const bad = rand(4) === 0;
    const v = (good, wrong) => (bad && maybe(0.3) ? pick(wrong) : pick(good));
    const group = v(["contact", "product", "seller", "district"], ["x"]);
    const profit = maybe(0.5);
    const filters = {
      from: v(["2026-10-01", "2026-09-01", "2026-10-05"], ["2024-01-01", "2026-13-01"]), to: pick(["2026-10-31", "2026-11-30", "2026-10-05"]),
      ...(maybe(0.7) ? { group } : {}),
      ...(maybe(0.5) ? { subgroup: v(["none", ...["contact", "product", "seller"].filter((s) => s !== group)], ["district", group]) } : {}),
      ...(maybe(0.5) ? { order: v(["name", "amount", "items", "sales"], ["bad"]) } : {}),
      ...(maybe(0.15) ? { date_type: pick(["date", "expected_date", "invoice"]) } : {}),
      ...(maybe(0.2) ? { statuses: v([["open"], ["draft", "open"], ["cancelled"]], [["open", "open"], [], ["zzz"]]) } : {}),
      ...(maybe(0.3) ? { include_freight: v([true, false], ["yes"]) } : {}),
      ...(maybe(0.15) ? { contact_id: v(contacts, ["x"]) } : {}),
      ...(maybe(0.15) ? { product_id: pick([...products, randomUUID()]) } : {}),
      ...(maybe(0.1) ? { supplier_id: pick([supplier, randomUUID()]) } : {}),
      ...(maybe(0.1) ? { city: v(["pira", "CURI"], ["x".repeat(101)]) } : {}),
      ...(maybe(0.1) ? { state: v(["sp", "PR"], ["XX"]) } : {}),
      ...(maybe(0.1) ? { without_invoice: pick([true, false]) } : {}),
      ...(maybe(0.15) ? { first_purchase: pick([true, false]) } : {}),
      ...(maybe(0.05) ? { seller_id: randomUUID() } : {}),
      ...(maybe(0.05) ? { category_ids: v([[randomUUID()], []], [["x"]]) } : {}),
      ...(maybe(0.08) ? { contact_type_ids: v([[randomUUID()], []], [["X"]]), ...(maybe(0.5) ? { contact_untyped: true } : {}) } : {}),
      ...(maybe(0.08) ? { tag_ids: pick([[randomUUID()], []]), ...(maybe(0.5) ? { untagged: pick([true, false]) } : {}) } : {}),
      ...(bad && maybe(0.1) ? { untagged: true } : {}),
      ...(profit || (bad && maybe(0.2)) ? { show_profit: profit } : {}),
      ...((profit && maybe(0.8)) || (bad && maybe(0.2)) ? { profit_base: v(["cost", "last_purchase", "last_purchase_until", "cost_until", "applied"], ["nope"]) } : {}),
      ...(bad && maybe(0.1) ? { extra: 1 } : {}),
    };
    await call("erp_document_sales_report", { p_user_id: user, p_filters: rand(40) ? filters : pick([null, [], '"x"', "7"]) });
  }
  console.log(`relatório de vendas: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok((outcomes.erp_document_sales_report ?? 0) > N / 4, "poucos relatórios aceitos");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
