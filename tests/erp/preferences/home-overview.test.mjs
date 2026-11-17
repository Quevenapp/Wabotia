// Início: erp_home_summary, _overview e _top_products na fixture dupla. Adaptados do Fagoo:
// - home-company-c-sql.test.mjs: "189 Top 5 SKUs…" (GRANT fora);
// - home-shortcut-catalog-sql.test.mjs: "152 the home charts accept 7D, 3M and 6M…";
// - casos próprios do resumo e do período: papéis, pedidos por situação, títulos por vencimento, baixas com tarifa,
//   rascunhos de NF-e e o período customizado. Títulos, baixas e rascunhos entram por SQL direto e passam pela cópia.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { captureTopProductsQuery, parseTopProducts } from "../../../src/erp/fagoo/packages/erp-domain/src/system-profile.mjs";
import { homePeriodRange } from "../../../src/erp/fagoo/workers/erp-api/src/home.mjs";

const fails = (fn, code) => assert.rejects(fn, (e) => e.code === code);
const day = async (f, offset = 0) => f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date+$1::integer)::text v", [offset]);
async function documentOf(f, kind, { contact, date, items, statuses = [] }) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date, contact_id: contact, items: items.map((i) => ({ unit: "UN", ...i })) },
    })
  ).document;
  for (const s of statuses)
    d = (
      await f.rpc("erp_document_transition", {
        p_user_id: f.users.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: "Transição sintética",
      })
    ).document;
  return d;
}

test("189 Top 5 SKUs of the home period: by quantity, cancelled orders out, period rules of the overview", async () => {
  const f = await dualFixture();
  try {
    const a = await f.catalog("contacts", { name: "Cliente Top" });
    const today = await day(f);
    const products = [];
    for (const [name, code] of [["Caneta", "CAN"], ["Lápis", "LAP"], ["Borracha", "BOR"], ["Régua", "REG"], ["Cola", "COL"], ["Tesoura", "TES"]])
      products.push(await f.catalog("products", { name, code, unit: "UN", kind: "P", format: "S", price: "1" }));
    await documentOf(f, "sales_orders", { contact: a.id, date: today, items: products.map((p, i) => ({ product_id: p.id, description: p.name, quantity: String(i + 1), unit_price: "2" })) });
    await documentOf(f, "sales_orders", { contact: a.id, date: today, statuses: ["cancelled"], items: [{ product_id: products[0].id, description: "Caneta", quantity: "100", unit_price: "1" }] });
    const q = captureTopProductsQuery({ periodo: "hoje" }),
      v = parseTopProducts(await f.rpc("erp_home_top_products", { p_user_id: f.users.vendas, p_period: q.key, p_from: q.from, p_to: q.to }), q);
    assert.deepEqual(
      v.items.map((p) => [p.code, p.units, p.total_cents]),
      [["TES", "6.000000", "1200"], ["COL", "5.000000", "1000"], ["REG", "4.000000", "800"], ["BOR", "3.000000", "600"], ["LAP", "2.000000", "400"]],
    );
    assert.deepEqual([v.from, v.to], [today, today]);
    await fails(() => f.rpc("erp_home_top_products", { p_user_id: f.users.financeiro, p_period: "hoje", p_from: null, p_to: null }), "42501");
    await fails(() => f.rpc("erp_home_top_products", { p_user_id: f.users.inactive, p_period: "hoje", p_from: null, p_to: null }), "42501");
    assert.equal((await f.rpc("erp_home_top_products", { p_user_id: f.users.estoque, p_period: "hoje", p_from: null, p_to: null })).items.length, 5, "estoque reads sales orders and products");
    for (const [p, from, to] of [["7D", null, null], ["hoje", "2026-10-01", null], ["customizado", "2026-10-02", "2026-10-01"], ["customizado", "2025-01-01", "2026-10-01"], ["customizado", "2026-02-30", "2026-03-01"], ["customizado", "2026-1-01", "2026-03-01"], [null, null, null]])
      await fails(() => f.rpc("erp_home_top_products", { p_user_id: f.users.admin, p_period: p, p_from: from, p_to: to }), "22023");
    assert.equal((await f.rpc("erp_home_top_products", { p_user_id: f.users.admin, p_period: "customizado", p_from: "2020-01-01", p_to: "2020-12-31" })).items.length, 0);
  } finally {
    await f.close();
  }
});

test("152 the home charts accept 7D, 3M and 6M with the same ranges as the Worker; other keys stay refused", async () => {
  const f = await dualFixture();
  try {
    for (const key of ["hoje", "7d", "30d", "3m", "6m", "12m"]) {
      const v = await f.rpc("erp_home_overview", { p_user_id: f.users.admin, p_period: key, p_from: null, p_to: null });
      assert.deepEqual([v.period.from, v.period.to], homePeriodRange(key, v.business_date), key);
    }
    const six = await f.rpc("erp_home_overview", { p_user_id: f.users.admin, p_period: "6m", p_from: null, p_to: null });
    assert.equal(six.period.grain, "month");
    assert.equal(six.period.points.length, 6);
    for (const key of ["1d", "7D", "24m"]) await fails(() => f.rpc("erp_home_overview", { p_user_id: f.users.admin, p_period: key, p_from: null, p_to: null }), "22023");
  } finally {
    await f.close();
  }
});

test("resumo e período: papéis, pedidos por situação, títulos por vencimento, tarifas das baixas e rascunhos de NF-e", async () => {
  const f = await dualFixture();
  try {
    const today = await day(f);
    const c = await f.catalog("contacts", { name: "Cliente do resumo" });
    const p = await f.catalog("products", { name: "Produto do resumo", unit: "UN", kind: "P", format: "S", price: "1" });
    const o1 = await documentOf(f, "sales_orders", { contact: c.id, date: today, items: [{ product_id: p.id, description: "Produto do resumo", quantity: "2", unit_price: "10.5" }] });
    const o2 = await documentOf(f, "sales_orders", { contact: c.id, date: await day(f, -40), items: [{ product_id: p.id, description: "Produto do resumo", quantity: "1", unit_price: "3" }] });
    const o3 = await documentOf(f, "sales_proposals", { contact: c.id, date: today, items: [{ product_id: p.id, description: "Produto do resumo", quantity: "1", unit_price: "1" }] });
    const title = (kind, due, amount, settled, cancelled = false) =>
      f.db.query(
        "insert into erp_finance.title(id,group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents,cancelled) values($1,$2,1,1,$3,$4,'Título sintético',$5::date-30,$5::date,$6,$7,$8)",
        [randomUUID(), randomUUID(), kind, c.id, due, amount, settled, cancelled],
      );
    await title("receivable", await day(f, -5), 15000, 2500);
    await title("receivable", today, 1000, 0);
    await title("receivable", await day(f, 3), 700, 0);
    await title("receivable", await day(f, 30), 900, 0, true);
    await title("payable", await day(f, 20), 1200, 1200);
    await title("payable", await day(f, -70), 400, 0);
    await f.db.query(
      "insert into erp_fiscal_drafts.draft(id,model,environment,status,version,source_document_id,source_document_version,snapshot,snapshot_hash,preparation) values($1,'55','2','draft',1,$7,1,$2,$3,'{}'),($4,'55','2','draft',1,$8,1,$5,$3,'{}'),($6,'65','2','draft',1,$9,1,$2,$3,'{}')",
      [randomUUID(), JSON.stringify({ totals: { total: "10.005" } }), "a".repeat(64), randomUUID(), JSON.stringify({ totals: { total: 2.5 } }), randomUUID(), o1.id, o2.id, o3.id],
    );
    await f.sync();
    for (const user of [f.users.admin, f.users.consulta, f.users.vendas, f.users.financeiro, f.users.estoque, f.users.fiscal])
      await f.rpc("erp_home_summary", { p_user_id: user });
    await fails(() => f.rpc("erp_home_summary", { p_user_id: f.users.inactive }), "42501");
    const admin = await f.rpc("erp_home_summary", { p_user_id: f.users.admin });
    const rec = admin.finance.titles.find((t) => t.kind === "receivable").buckets;
    assert.deepEqual(rec.map((b) => [b.bucket, b.count, b.balance_cents]), [["overdue", 1, "12500"], ["today", 1, "1000"], ["next_7_days", 1, "700"], ["later", 0, "0"]]);
    assert.equal((await f.rpc("erp_home_summary", { p_user_id: f.users.vendas })).finance, null);
    for (const user of [f.users.admin, f.users.vendas, f.users.financeiro, f.users.fiscal])
      for (const [period, from, to] of [["30d", null, null], ["12m", null, null], ["customizado", await day(f, -45), await day(f, 25)], ["customizado", await day(f, -100), await day(f, 10)]])
        await f.rpc("erp_home_overview", { p_user_id: user, p_period: period, p_from: from, p_to: to });
    const month = await f.rpc("erp_home_overview", { p_user_id: f.users.admin, p_period: "30d", p_from: null, p_to: null });
    assert.equal(month.period.sales.count, 1);
    assert.equal(month.period.sales.statuses.reduce((n, s) => n + Number(s.total_cents), 0), 2100);
    assert.deepEqual([month.period.receivable.count, month.period.receivable.total_cents, month.period.payable.count], [2, "16000", 0], "30d termina hoje: os vencimentos futuros ficam fora");
    assert.equal(month.period.points.length, 30);
    assert.deepEqual([month.period.invoices.count, month.period.invoices.total_cents], [2, "1251"], "dois rascunhos de NF-e, 10.005 arredonda para 10.01");
    await fails(() => f.rpc("erp_home_overview", { p_user_id: f.users.admin, p_period: "customizado", p_from: "2026-01-01", p_to: "2027-01-02" }), "22023");
  } finally {
    await f.close();
  }
});
