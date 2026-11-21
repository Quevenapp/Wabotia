// RPCs da versão 26 da reforma tributária (structural.ts, reforma-calculo),
// só do motor, no SQLite em memória: configuração da empresa, classificação
// e Imposto Seletivo do produto, contexto do bloco das propostas e pedidos e
// o relatório do período para o contador. Sem rede.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { calculateReform } from "../../../src/erp/domains/fiscal/reform-calc.ts";

const code = (expected) => (error) => error.code === expected;
const HEX = "a".repeat(64);

test("configuração: padrão, gravação pela versão, repetição pelo comando e as recusas", t => {
  const f = com1Fixture(t);
  const empty = f.rpc("erp_fiscal_reform_settings_get");
  assert.deepEqual([empty.version, empty.settings, empty.crt, empty.regime, empty.writable], [0, { simples_regular: false, rates: {} }, "1", "simples", true]);
  assert.equal(empty.years[0].origin, "test");
  assert.equal(empty.years[1].origin, "unpublished");
  // Sem configuração da NF-e salva depois do teste de conexão, o Wabotia não sabe o que o cofre aceita.
  assert.deepEqual(empty.vault, { known: false, ibs_cbs: false, selective: false, credit_debit: false, purposes: [] });
  const command = randomUUID();
  const data = { simples_regular: true, rates: { 2027: { cbs: "8.8", ibs_uf: "", ibs_mun: null } } };
  const saved = f.rpc("erp_fiscal_reform_settings_save", { p_command_id: command, p_expected_version: 0, p_data: data });
  assert.deepEqual([saved.version, saved.settings, saved.regime], [1, { simples_regular: true, rates: { 2027: { cbs: "8.8" } } }, "simples_regular"]);
  assert.equal(saved.years[1].origin, "company");
  assert.equal(f.rpc("erp_fiscal_reform_settings_save", { p_command_id: command, p_expected_version: 0, p_data: data }).version, 1, "repetição devolve o mesmo resultado");
  assert.throws(() => f.rpc("erp_fiscal_reform_settings_save", { p_command_id: randomUUID(), p_expected_version: 0, p_data: data }), code("40001"));
  for (const bad of [{ simples_regular: "sim" }, { simples_regular: true, rates: { 2025: { cbs: "1" } } }, { simples_regular: true, rates: { 2027: { cbs: "101" } } },
    { simples_regular: true, rates: { 2027: { pis: "1" } } }, { simples_regular: true, extra: 1 }])
    assert.throws(() => f.rpc("erp_fiscal_reform_settings_save", { p_command_id: randomUUID(), p_expected_version: 1, p_data: bad }), code("22023"), JSON.stringify(bad));
  assert.throws(() => f.rpc("erp_fiscal_reform_settings_save", { p_command_id: randomUUID(), p_expected_version: 1, p_data: data }, { role: "consulta" }), code("42501"));
  assert.throws(() => f.rpc("erp_fiscal_reform_settings_get", {}, { role: "vendas" }), code("42501"));
  assert.equal(f.rpc("erp_fiscal_reform_settings_get", {}, { role: "consulta" }).writable, false);
  assert.equal(Number(f.db.exec(`SELECT count(*) n FROM "erp_fiscal_invoices__audit" WHERE action='reform_settings'`).rows[0].n), 1);
});

test("produto: classificação e Imposto Seletivo pelo hash, limpeza e recusas", t => {
  const f = com1Fixture(t);
  const id = f.product.id;
  const empty = f.rpc("erp_fiscal_reform_product_get", { p_product_id: id });
  assert.deepEqual([empty.classification, empty.selective], [null, null]);
  const saved = f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: id, p_expected_hash: empty.expected_hash,
    p_classification: { cst: "200", cclasstrib: "200030", nbs: "" }, p_selective: { cst: "000", cclasstrib: "000001", rate: "10" } });
  assert.deepEqual(saved.classification, { cst: "200", cclasstrib: "200030", nbs: null });
  assert.deepEqual(saved.selective, { cst: "000", cclasstrib: "000001", rate: "10" });
  assert.deepEqual(f.rpc("erp_fiscal_reform_product_get", { p_product_id: id }).expected_hash, saved.expected_hash);
  assert.throws(() => f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: id, p_expected_hash: empty.expected_hash,
    p_classification: { cst: "000", cclasstrib: "000001" } }), code("40001"), "hash vencido");
  for (const [classification, selective] of [
    [{ cst: "200", cclasstrib: "000001" }, null], [{ cst: "001", cclasstrib: "001001" }, null], [{ cst: "000", cclasstrib: "000001", nbs: "123" }, null],
    [{ cst: "000", cclasstrib: "000001", extra: 1 }, null], [null, { cst: "200", cclasstrib: "200001", rate: "1" }], [null, { cst: "000", cclasstrib: "000001", rate: "150" }],
  ])
    assert.throws(() => f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: id, p_expected_hash: saved.expected_hash,
      p_classification: classification, p_selective: selective }), code("22023"), JSON.stringify([classification, selective]));
  assert.throws(() => f.rpc("erp_fiscal_reform_product_get", { p_product_id: randomUUID() }), code("P0002"));
  assert.throws(() => f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: id, p_expected_hash: saved.expected_hash, p_classification: null },
    { role: "vendas" }), code("42501"));
  const cleared = f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: id, p_expected_hash: saved.expected_hash });
  assert.deepEqual([cleared.classification, cleared.selective], [null, null]);
  assert.equal(Number(f.db.exec(`SELECT count(*) n FROM "erp_fiscal_reform__product_selective"`).rows[0].n), 0);
});

test("documento: classificação resolvida por produto (do cadastro ou da natureza) para o bloco informativo", t => {
  const f = com1Fixture(t);
  const other = f.catalog("products", { name: "Outro item", unit: "UN", kind: "P", price: "10", ncm: "22030000", origin: "0" });
  const empty = f.rpc("erp_fiscal_reform_product_get", { p_product_id: f.product.id });
  f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: f.product.id, p_expected_hash: empty.expected_hash,
    p_classification: { cst: "200", cclasstrib: "200030" } });
  const context = f.rpc("erp_fiscal_reform_document_context", { p_kind: "sales_orders", p_contact_id: f.customer.id, p_product_ids: [f.product.id, other.id] });
  assert.equal(context.crt, "1");
  const byId = Object.fromEntries(context.products.map(p => [p.id, p]));
  assert.deepEqual(byId[f.product.id].classification, { cst: "200", cclasstrib: "200030", nbs: null, source: "product" });
  if (context.nature) {
    const nature = f.rpc("erp_fiscal_reform_nature_class_get", { p_nature_id: context.nature.id });
    f.rpc("erp_fiscal_reform_nature_class_save", { p_command_id: randomUUID(), p_nature_id: context.nature.id, p_expected_hash: nature.expected_hash,
      p_rules: [{ cst: "000", cclasstrib: "000001" }] });
    const again = f.rpc("erp_fiscal_reform_document_context", { p_kind: "sales_orders", p_contact_id: f.customer.id, p_product_ids: [other.id] });
    assert.deepEqual(again.products[0].classification, { cst: "000", cclasstrib: "000001", nbs: null, source: "nature" });
  } else assert.equal(byId[other.id].classification, null);
  // O painel calcula com o mesmo cálculo da NF-e.
  const result = calculateReform(context.products.map(p => ({ item_id: p.id, base: "100.00", classification: p.classification, selective: p.selective })),
    { year: 2026, crt: "3", settings: context.settings });
  assert.equal(result.items.find(i => i.item_id === f.product.id).cbs.value, "0.36");
  assert.throws(() => f.rpc("erp_fiscal_reform_document_context", { p_kind: "purchase_orders", p_product_ids: [] }), code("22023"));
});

test("relatório: IBS, CBS e IS das NF-e autorizadas por mês e classificação", t => {
  const f = com1Fixture(t);
  const at = (iso) => String(BigInt(Date.parse(iso)) * 1000n);
  const emit = (number, authorizedAt, calculation, status = "autorizada") => f.transaction(ctx => {
    const id = randomUUID(), key = `35261112345678000199550010${String(number).padStart(8, "0")}1123456789`;
    const fiscalVersion = number;
    ctx.db.exec(`INSERT INTO "erp_fiscal_vault__order_emission"(id, document_id, fiscal_version, environment, environment_confirmed, connection_fingerprint, reference,
      current_body_revision, status, provider_id, series, number, access_key, protocol, authorized_at, created_at, created_by, updated_at)
      VALUES(?,?,?,'producao',1,?,?,1,?,?,1,?,?,'135',?,?,?,?)`,
      id, f.order.id, fiscalVersion, HEX, `wb.${f.order.id}.v${fiscalVersion}`, status, `p${number}`, number, key, authorizedAt, authorizedAt, f.people.admin.user_id, authorizedAt);
    ctx.db.exec(`INSERT INTO "erp_fiscal_vault__order_revision"(emission_id, body_revision, source_document_version, snapshot, tax_sources, commercial_hash,
      source_fingerprint, body, body_hash, calculation, blockers, prepared_by, prepared_at) VALUES(?,1,1,'{}','{}',?,?,NULL,NULL,?,'[]',?,?)`,
      id, HEX, HEX, JSON.stringify(calculation), f.people.admin.user_id, authorizedAt);
  });
  const reform = (items) => ({ reform: calculateReform(items, { year: 2026, crt: "3" }) });
  emit(1, at("2026-11-03T15:00:00Z"), reform([{ item_id: "a", base: "100.00", classification: { cst: "000", cclasstrib: "000001" } },
    { item_id: "b", base: "1000.00", classification: { cst: "200", cclasstrib: "200030" } }]));
  emit(2, at("2026-11-20T15:00:00Z"), reform([{ item_id: "c", base: "51.00", classification: { cst: "000", cclasstrib: "000001" } }]));
  emit(3, at("2026-12-01T02:00:00Z"), reform([{ item_id: "d", base: "10.00", classification: { cst: "000", cclasstrib: "000001" } }])); // 30/11, 23h em São Paulo
  emit(4, at("2026-11-21T15:00:00Z"), {});
  emit(5, at("2026-10-31T15:00:00Z"), reform([{ item_id: "e", base: "999.00", classification: { cst: "000", cclasstrib: "000001" } }]));
  const report = f.rpc("erp_fiscal_reform_report", { p_from: "2026-11-01", p_to: "2026-11-30" });
  assert.deepEqual(report.lines.map(l => [l.month, l.cclasstrib, l.notes, l.items, l.base, l.cbs, l.ibs_uf, l.ibs]), [
    // Soma dos valores já arredondados por item: 0,90 + 0,46 + 0,09 de CBS; 0,10 + 0,05 + 0,01 de IBS.
    ["2026-11", "000001", 3, 3, "161.00", "1.45", "0.16", "0.16"],
    ["2026-11", "200030", 1, 1, "1000.00", "3.60", "0.40", "0.40"],
  ]);
  assert.deepEqual(report.totals, { notes: 3, base: "1161.00", cbs: "5.05", ibs_uf: "0.56", ibs_mun: "0.00", ibs: "0.56", selective: "0.00" });
  assert.equal(report.without_reform, 1);
  assert.equal(f.rpc("erp_fiscal_reform_report", { p_from: "2026-11-01", p_to: "2026-11-30", p_environment: "homologacao" }).lines.length, 0);
  for (const [from, to] of [["2026-11-30", "2026-11-01"], ["2026-01-01", "2027-12-31"], ["ontem", "hoje"]])
    assert.throws(() => f.rpc("erp_fiscal_reform_report", { p_from: from, p_to: to }), code("22023"), `${from} ${to}`);
  assert.throws(() => f.rpc("erp_fiscal_reform_report", { p_from: "2026-11-01", p_to: "2026-11-30" }, { role: "vendas" }), code("42501"));
});
