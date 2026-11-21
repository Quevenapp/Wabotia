// Relatórios do ERP (Vinki, sem função no oráculo): DRE gerencial por caixa
// e competência com Custos, comparação e detalhe; gráficos de vendas,
// financeiro e estoque; lotes vencendo; pagamento da equipe e comissão do
// vendedor; parte desligada recusa antes de ler; argumentos e contrato das
// rotas. Sem rede: motor SQLite da fatia comercial (tests/erp/comnfe/fixtures.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { previousPeriod } from "../../../src/erp/domains/finance/rpc/erp_finance_dre.ts";
import { chartBuckets } from "../../../src/erp/domains/finance/rpc/erp_finance_charts.ts";
import { commissionCents } from "../../../src/erp/domains/finance/rpc/erp_finance_team.ts";
import { ERP_REPORT_OPERATIONS, erpReportOperationFor, erpReportParams } from "../../../src/erp/relatorios/contract.ts";
import { ReportArgsError, reaisToCents, reportRpcArgs } from "../../../src/erp/relatorios/args.ts";

const disabled = (e) => e.code === "module_disabled";
const code = (c) => (e) => e.code === c || e.message === c;
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];

function finance(t) {
  const f = com1Fixture(t);
  const category = (kind, name, dre_group, parent_id) => f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create",
    p_data: { kind, name, ...(parent_id ? { parent_id } : { dre_group }) } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa dos relatórios", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.sales = category("receivable", "Vendas", "gross_revenue");
  f.taxes = category("payable", "Impostos sobre vendas", "revenue_deductions");
  f.goods = category("payable", "Mercadorias", "operating_expenses");
  f.rent = category("payable", "Aluguel", "operating_expenses");
  f.loose = category("receivable", "Receita sem grupo", null);
  f.title = (kind, category_id, cents, issued_on, due_on) => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind, contact_id: f.customer.id, category_id, description: `Conta ${cents}`, issued_on, total_cents: String(cents), installments: [{ due_on, amount_cents: String(cents) }] } }).items[0];
  f.settle = (title, posted_on) => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: {
    id: title.id, expected_version: row(f, 'SELECT version FROM "erp_finance__title" WHERE id=?', title.id).version, account_id: f.account.id, posted_on,
    principal_cents: String(title.amount_cents), interest_cents: "0", penalty_cents: "0", discount_cents: "0", fee_cents: "0" } });
  return f;
}
const dre = (f, args, env) => f.rpc("erp_finance_dre", { p_args: args }, env);
const group = (view, key) => view.groups.find((g) => g.key === key);
const line = (view, key) => view.lines.find((l) => l.key === key);

test("período anterior: meses inteiros andam em meses; intervalo, no mesmo número de dias", () => {
  assert.deepEqual(previousPeriod("2026-10-01", "2026-10-31"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(previousPeriod("2026-10-01", "2026-12-31"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(previousPeriod("2026-01-01", "2026-12-31"), { from: "2025-01-01", to: "2025-12-31" });
  assert.deepEqual(previousPeriod("2026-03-05", "2026-03-14"), { from: "2026-02-23", to: "2026-03-04" });
  assert.deepEqual(chartBuckets("2026-11-04", "2026-11-17", "week").map((b) => [b.start_on, b.end_on]), [["2026-11-04", "2026-11-08"], ["2026-11-09", "2026-11-15"], ["2026-11-16", "2026-11-17"]]);
});

test("DRE: caixa e competência pelos grupos, Custos à parte, sem classificação fora do resultado, comparação e detalhe", (t) => {
  const f = finance(t);
  const sale = f.title("receivable", f.sales.id, 100000, "2026-09-20", "2026-10-05");
  const tax = f.title("payable", f.taxes.id, 8000, "2026-10-01", "2026-10-10");
  const goods = f.title("payable", f.goods.id, 40000, "2026-10-01", "2026-10-15");
  const rent = f.title("payable", f.rent.id, 15000, "2026-10-01", "2026-10-20");
  const loose = f.title("receivable", f.loose.id, 2500, "2026-10-02", "2026-10-02");
  const old = f.title("receivable", f.sales.id, 30000, "2026-09-01", "2026-09-10");
  for (const x of [sale, tax, goods, rent, loose]) f.settle(x, "2026-10-25");
  f.settle(old, "2026-09-12");
  // Mercadorias vai para Custos: só a categoria de despesa do primeiro nível.
  const marked = f.rpc("erp_finance_dre_cost_set", { p_command_id: randomUUID(), p_category_id: f.goods.id, p_cost: true });
  assert.deepEqual([marked.record.cost, marked.record.dre_group], [true, "operating_expenses"]);
  assert.throws(() => f.rpc("erp_finance_dre_cost_set", { p_command_id: randomUUID(), p_category_id: f.sales.id, p_cost: true }), code("erp_finance_dre_cost_top_payable"));
  assert.deepEqual(dre(f, { costs: true }).category_ids, [f.goods.id]);

  const cash = dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash" });
  assert.deepEqual(cash.previous, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(group(cash, "gross_revenue").amount_cents, "100000");
  assert.equal(group(cash, "gross_revenue").previous_cents, "30000");
  assert.equal(group(cash, "revenue_deductions").amount_cents, "-8000");
  assert.equal(group(cash, "costs").amount_cents, "-40000");
  assert.equal(group(cash, "operating_expenses").amount_cents, "-15000");
  assert.deepEqual(group(cash, "costs").categories.map((c) => c.name), ["Mercadorias"]);
  assert.equal(line(cash, "net_revenue").amount_cents, "92000");
  assert.equal(line(cash, "gross_profit").amount_cents, "52000");
  assert.equal(line(cash, "net_result").amount_cents, "37000");
  // Sem grupo de DRE: aparece à parte, com o valor, e não entra no resultado.
  assert.equal(cash.unclassified.amount_cents, "2500");
  assert.deepEqual(cash.unclassified.categories.map((c) => c.category_id), [f.loose.id]);

  // Competência: pela competência das contas (a venda é de setembro).
  const competence = dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "competence", compare: false });
  assert.equal(competence.previous, null);
  assert.equal(group(competence, "gross_revenue").amount_cents, "0");
  assert.equal(group(competence, "gross_revenue").previous_cents, null);
  assert.equal(line(competence, "net_result").amount_cents, "-63000");
  assert.equal(group(dre(f, { from: "2026-09-01", to: "2026-09-30", basis: "competence" }), "gross_revenue").amount_cents, "130000");

  // Detalhe da categoria até a conta.
  const detail = dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash", category_id: f.goods.id });
  assert.equal(detail.total, 1);
  assert.deepEqual([detail.items[0].source, detail.items[0].title_id, detail.items[0].amount_cents, detail.items[0].contact_name], ["settlement", goods.id, "-40000", f.customer.name]);
  assert.throws(() => dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash", category_id: randomUUID() }), code("erp_finance_not_found"));

  // Desmarcar devolve a categoria para Despesas Operacionais.
  f.rpc("erp_finance_dre_cost_set", { p_command_id: randomUUID(), p_category_id: f.goods.id, p_cost: false });
  assert.equal(group(dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash" }), "operating_expenses").amount_cents, "-55000");
  for (const args of [{ from: "2026-10-31", to: "2026-10-01", basis: "cash" }, { from: "2026-10-01", to: "2026-10-31", basis: "outro" }, { from: "2026-10-01", to: "2026-10-31", basis: "cash", extra: 1 }, { from: "2020-01-01", to: "2026-10-31", basis: "cash" }])
    assert.throws(() => dre(f, args), code("erp_finance_invalid_query"));
  // Papel e parte: consulta lê; vendas não; Financeiro desligado recusa antes de ler.
  assert.equal(dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash" }, { role: "consulta" }).entity, "dre");
  assert.throws(() => dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash" }, { role: "vendas" }), code("erp_finance_access_denied"));
  assert.throws(() => dre(f, { from: "2026-10-01", to: "2026-10-31", basis: "cash" }, { parts: { finance: false } }), disabled);
  assert.throws(() => f.rpc("erp_finance_dre_cost_set", { p_command_id: randomUUID(), p_category_id: f.goods.id, p_cost: true }, { role: "consulta" }), code("erp_finance_access_denied"));
});

test("gráficos do Financeiro: previsto e realizado por faixa e contas em aberto por vencimento", (t) => {
  const f = finance(t);
  const a = f.title("receivable", f.sales.id, 50000, "2026-10-01", "2026-10-03");
  f.title("payable", f.rent.id, 20000, "2026-10-01", "2026-10-20");
  f.settle(a, "2026-10-04");
  const flow = f.rpc("erp_finance_chart", { p_args: { report: "cash_flow", from: "2026-10-01", to: "2026-10-31", group: "month" } });
  assert.equal(flow.items.length, 1);
  assert.deepEqual([flow.items[0].forecast_in_cents, flow.items[0].forecast_out_cents, flow.items[0].realized_in_cents, flow.items[0].realized_out_cents, flow.totals.closing_cents], ["50000", "20000", "50000", "0", "50000"]);
  const due = f.rpc("erp_finance_chart", { p_args: { report: "due" } });
  assert.equal(due.totals.payable_cents, "20000");
  assert.equal(due.totals.receivable_cents, "0");
  assert.equal(due.items.reduce((n, i) => n + i.payable_count, 0), 1);
  assert.throws(() => f.rpc("erp_finance_chart", { p_args: { report: "cash_flow", from: "2025-01-01", to: "2026-12-31", group: "day" } }), code("erp_finance_invalid_query"));
  assert.throws(() => f.rpc("erp_finance_chart", { p_args: { report: "outro" } }), code("erp_finance_invalid_query"));
  assert.throws(() => f.rpc("erp_finance_chart", { p_args: { report: "due" } }, { parts: { finance: false } }), disabled);
});

test("vendas por período, vendedor e produto; sem Vendas a rotina recusa", (t) => {
  const f = com1Fixture(t);
  const args = (report) => ({ p_args: { report, from: "2026-11-01", to: "2026-11-30", group: "month" } });
  const period = f.rpc("erp_report_sales_chart", args("period"));
  assert.equal(period.order_count, 1);
  assert.equal(period.items[0].amount_cents, period.total_cents);
  const seller = f.rpc("erp_report_sales_chart", args("seller"));
  assert.deepEqual(seller.items.map((i) => [i.name, i.orders]), [["Sem vendedor", 1]]);
  const product = f.rpc("erp_report_sales_chart", args("product"));
  assert.deepEqual(product.items.map((i) => [i.product_id, i.quantity]), [[f.product.id, "2.000000"]]);
  // Cancelado fica de fora.
  f.db.exec('UPDATE "erp_documents__document" SET status=\'cancelled\' WHERE id=?', f.order.id);
  assert.equal(f.rpc("erp_report_sales_chart", args("period")).order_count, 0);
  assert.throws(() => f.rpc("erp_report_sales_chart", args("period"), { parts: { sales: false } }), disabled);
});

test("lotes vencendo: N da preferência ou 30, vencidos à parte, filtro por depósito; estoque por depósito e giro", (t) => {
  const f = com1Fixture(t);
  const warehouse = f.catalog("warehouses", { name: "Depósito Central" }), other = f.catalog("warehouses", { name: "Depósito Loja" });
  const today = f.rpc("erp_stock_lots_expiring", { p_args: {} }).today;
  const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const lot = (code, expires) => {
    const id = randomUUID(), at = String(f.clock.next());
    f.db.exec('INSERT INTO "erp_stock__lot"(id, product_id, code, code__fold, expires_on, active, version, created_at, created_by, updated_at, updated_by, command_id) VALUES(?,?,?,?,?,1,1,?,?,?,?,?)',
      id, f.product.id, code, code.toLowerCase(), expires, at, f.people.admin.user_id, at, f.people.admin.user_id, randomUUID());
    return id;
  };
  const balance = (lotId, wh, q) => f.db.exec('INSERT INTO "erp_stock__lot_balance"(lot_id, warehouse_id, quantity, version, updated_at) VALUES(?,?,?,1,?)', lotId, wh, q, String(f.clock.next()));
  balance(lot("L-SOON", day(10)), warehouse.id, 5000000);
  balance(lot("L-LATER", day(45)), warehouse.id, 1000000);
  balance(lot("L-OLD", day(-3)), other.id, 2000000);
  balance(lot("L-EMPTY", day(5)), warehouse.id, 0);
  const view = f.rpc("erp_stock_lots_expiring", { p_args: {} });
  assert.deepEqual([view.days, view.days_source], [30, "default"]);
  assert.deepEqual(view.expiring.items.map((i) => [i.code, i.warehouse_name, i.quantity, i.days_left]), [["L-SOON", "Depósito Central", "5.000000", 10]]);
  assert.deepEqual(view.expired.items.map((i) => i.code), ["L-OLD"]);
  assert.deepEqual(f.rpc("erp_stock_lots_expiring", { p_args: { days: 60 } }).expiring.items.map((i) => i.code), ["L-SOON", "L-LATER"]);
  assert.deepEqual(f.rpc("erp_stock_lots_expiring", { p_args: { warehouse_id: other.id } }).expiring.total, 0);
  // A preferência dos lotes gravada pela empresa vale como padrão.
  f.rpc("erp_preferences_save", { p_command_id: randomUUID(), p_page: "cadastros-lotes", p_changes: JSON.stringify([{ key: "lotes.dias_aviso_validade", expected_version: 0, value: 5 }]) });
  const pref = f.rpc("erp_stock_lots_expiring", { p_args: {} });
  assert.deepEqual([pref.days, pref.days_source, pref.expiring.total], [5, "preference", 0]);
  assert.throws(() => f.rpc("erp_stock_lots_expiring", { p_args: {} }, { parts: { stock: false } }), disabled);
  assert.throws(() => f.rpc("erp_stock_lots_expiring", { p_args: {} }, { role: "financeiro" }), code("erp_stock_access_denied"));

  f.db.exec('INSERT INTO "erp_stock__balance"(product_id, warehouse_id, quantity, unit, version, updated_at) VALUES(?,?,?,?,1,?)', f.product.id, warehouse.id, 8000000, "UN", String(f.clock.next()));
  const byWarehouse = f.rpc("erp_stock_chart", { p_args: { report: "warehouses" } });
  assert.deepEqual(byWarehouse.items.map((i) => [i.name, i.products, i.quantity]), [["Depósito Central", 1, "8.000000"], ["Depósito Loja", 0, "0.000000"]]);
  const turnover = f.rpc("erp_stock_chart", { p_args: { report: "turnover", from: day(-30), to: today } });
  assert.equal(turnover.total, 0);
  assert.throws(() => f.rpc("erp_stock_chart", { p_args: { report: "turnover", from: day(-30), to: day(5) } }), code("erp_stock_invalid_query"));
});

test("pagamento da equipe: conta a pagar na categoria própria, pessoa ligada, relatório e comissão conferida", (t) => {
  const f = finance(t);
  // Funcionário sem contato com o mesmo CPF: recusa com o motivo; com o contato, lança.
  const employee = f.rpc("erp_catalog_employee_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_situation: null, p_data: {
    name: "Ana da Equipe", cpf: "529.982.247-25", rg: null, job_title: "Atendente", pis: null, ctps: null, code: "F-1", phone: null, mobile: null, email: null, emergency_phone: null,
    postal_code: null, state: "SP", city: "Piracicaba", district: null, street: null, number: null, complement: null, birth_date: null, admission_date: null, salary: "2500.00", notes: null } }).item;
  const pay = (data, env) => f.rpc("erp_finance_team_pay", { p_command_id: randomUUID(), p_data: { issued_on: "2026-10-01", due_on: "2026-11-05", period_from: "2026-10-01", period_to: "2026-10-31", ...data } }, env);
  assert.throws(() => pay({ person_kind: "employee", person_id: employee.id, pay_kind: "salario", amount_cents: "250000" }), code("erp_finance_team_contact_missing"));
  const contact = f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { name: "Ana da Equipe", person_type: "F", document: "52998224725", roles: ["supplier"], taxpayer: "9" } }).record;
  const people = f.rpc("erp_finance_team_people", {});
  assert.deepEqual(people.items.filter((p) => p.kind === "employee").map((p) => [p.name, p.contact_id, p.salary_cents]), [["Ana da Equipe", contact.id, "250000"]]);
  const salary = pay({ person_kind: "employee", person_id: employee.id, pay_kind: "salario", amount_cents: "250000" });
  const title = row(f, 'SELECT t.*, c.name category, p.name parent FROM "erp_finance__title" t JOIN "erp_finance__category" c ON c.id=t.category_id JOIN "erp_finance__category" p ON p.id=c.parent_id WHERE t.id=?', salary.record.id);
  assert.deepEqual([title.kind, title.contact_id, title.amount_cents, title.category, title.parent, title.competence_on], ["payable", contact.id, 250000, "Salários", "Pessoal e equipe", "2026-10-01"]);
  assert.equal(salary.record.description, "Salário · Ana da Equipe · 10/2026");
  const vale = pay({ person_kind: "employee", person_id: employee.id, pay_kind: "vale", amount_cents: "30000" });
  const parentOf = (id) => row(f, 'SELECT parent_id FROM "erp_finance__category" WHERE id=?', id).parent_id;
  assert.equal(parentOf(vale.record.category_id), parentOf(salary.record.category_id));
  // Mesmo comando: o mesmo resultado, sem segunda conta.
  const command = randomUUID(), data = { person_kind: "employee", person_id: employee.id, pay_kind: "adiantamento", amount_cents: "10000", issued_on: "2026-10-10", due_on: "2026-10-10", period_from: "2026-10-01", period_to: "2026-10-31" };
  const first = f.rpc("erp_finance_team_pay", { p_command_id: command, p_data: data }), again = f.rpc("erp_finance_team_pay", { p_command_id: command, p_data: data });
  assert.equal(again.replayed, true);
  assert.equal(again.record.id, first.record.id);
  assert.throws(() => pay({ person_kind: "employee", person_id: employee.id, pay_kind: "comissao", amount_cents: "100" }), code("erp_finance_team_commission_seller"));
  assert.throws(() => pay({ person_kind: "employee", person_id: employee.id, pay_kind: "salario", amount_cents: "100" }, { role: "consulta" }), code("erp_finance_access_denied"));

  const report = f.rpc("erp_finance_team_report", { p_args: { from: "2026-10-01", to: "2026-10-31" } });
  assert.deepEqual(report.people.map((p) => [p.name, p.total_cents, p.by_kind.salario, p.by_kind.vale, p.by_kind.adiantamento]), [["Ana da Equipe", "290000", "250000", "30000", "10000"]]);
  assert.equal(report.items.length, 3);
  assert.equal(f.rpc("erp_finance_team_report", { p_args: { from: "2026-12-01", to: "2026-12-31" } }).items.length, 0);

  // Comissão: o pedido atendido do vendedor (5% de 51,00) e a conta a pagar no contato do vendedor.
  const seller = f.rpc("erp_catalog_seller_from_contact", { p_command_id: randomUUID(), p_contact_id: f.customer.id }).seller;
  f.db.exec('UPDATE "erp_catalog__seller" SET commission_rate=\'5.0000\' WHERE id=?', seller.id);
  f.db.exec(`UPDATE "erp_documents__document" SET status='fulfilled', body=json_set(body, '$.seller_id', ?) WHERE id=?`, seller.id, f.order.id);
  const date = row(f, `SELECT body ->> 'date' d FROM "erp_documents__document" WHERE id=?`, f.order.id).d;
  const period = { from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-28` };
  const commission = f.rpc("erp_finance_team_commission", { p_args: period });
  const mine = commission.items.find((i) => i.seller_id === seller.id);
  assert.deepEqual([mine.order_count, mine.base_cents, mine.rate, mine.commission_cents], [1, "5100", "5.0000", "255"]);
  assert.throws(() => pay({ person_kind: "seller", person_id: seller.id, pay_kind: "comissao", amount_cents: "300", period_from: period.from, period_to: period.to }), code("erp_finance_team_commission_changed"));
  const launched = pay({ person_kind: "seller", person_id: seller.id, pay_kind: "comissao", amount_cents: "255", issued_on: period.from, due_on: period.to, period_from: period.from, period_to: period.to });
  assert.equal(launched.team_payment.base_cents, "5100");
  assert.equal(row(f, 'SELECT contact_id FROM "erp_finance__title" WHERE id=?', launched.record.id).contact_id, f.customer.id);
  assert.equal(f.rpc("erp_finance_team_commission", { p_args: period }).items.find((i) => i.seller_id === seller.id).generated.length, 1);
  assert.throws(() => pay({ person_kind: "seller", person_id: seller.id, pay_kind: "comissao", amount_cents: "255", issued_on: period.from, due_on: period.to, period_from: period.from, period_to: period.to }), code("erp_finance_team_commission_exists"));
  // Comissão precisa de Vendas; sem Financeiro, nada da equipe.
  assert.throws(() => f.rpc("erp_finance_team_commission", { p_args: period }, { parts: { sales: false } }), disabled);
  assert.throws(() => f.rpc("erp_finance_team_people", {}, { parts: { finance: false } }), disabled);
  assert.equal(commissionCents(12345n, "2.5000"), 309n);
});

test("rotas: argumentos em português viram os do motor; contrato com nomes estáveis, leitura comum e lançamento sensível", async () => {
  const op = (method, path) => erpReportOperationFor(method, path);
  const command = async () => "11111111-1111-4111-8111-111111111111";
  const q = (s) => new URLSearchParams(s);
  const dreOp = op("GET", "erp-relatorios/dre");
  assert.equal(dreOp.operation.name, "erp.financeiro.dre");
  assert.deepEqual(await reportRpcArgs(dreOp.operation, dreOp.params, q("de=2026-10-01&ate=2026-10-31&regime=competencia&comparar=0"), undefined, command),
    { p_args: { from: "2026-10-01", to: "2026-10-31", basis: "competence", compare: false } });
  const detail = op("GET", "erp-relatorios/dre/categoria/sem");
  assert.deepEqual(await reportRpcArgs(detail.operation, detail.params, q("de=2026-10-01&ate=2026-10-31&pagina=2"), undefined, command),
    { p_args: { from: "2026-10-01", to: "2026-10-31", basis: "cash", category_id: "none", page: 2, limit: 50 } });
  const sales = op("GET", "erp-relatorios/graficos/vendas");
  assert.deepEqual(await reportRpcArgs(sales.operation, {}, q("relatorio=vendedor&de=2026-10-01&ate=2026-10-31"), undefined, command),
    { p_args: { report: "seller", from: "2026-10-01", to: "2026-10-31", group: "day" } });
  await assert.rejects(reportRpcArgs(sales.operation, {}, q("relatorio=outro&de=2026-10-01&ate=2026-10-31"), undefined, command), ReportArgsError);
  await assert.rejects(reportRpcArgs(sales.operation, {}, q("relatorio=periodo&de=2026-10-01&ate=2026-10-31&extra=1"), undefined, command), ReportArgsError);
  const pay = op("POST", "erp-relatorios/equipe/pagamentos");
  assert.equal(pay.operation.name, "erp.financeiro.equipe.lancar");
  assert.deepEqual(await reportRpcArgs(pay.operation, {}, q(""), { pessoa_tipo: "vendedor", pessoa: "22222222-2222-4222-8222-222222222222", tipo: "comissao", valor: "1.234,5".replace(".", ""), emissao: "2026-10-01", vencimento: "2026-11-05", periodo_de: "2026-10-01", periodo_ate: "2026-10-31" }, command),
    { p_command_id: "11111111-1111-4111-8111-111111111111", p_data: { person_kind: "seller", person_id: "22222222-2222-4222-8222-222222222222", pay_kind: "comissao", amount_cents: "123450", issued_on: "2026-10-01", due_on: "2026-11-05", period_from: "2026-10-01", period_to: "2026-10-31" } });
  assert.equal(reaisToCents("1500"), "150000");
  assert.equal(reaisToCents("0,01"), "1");
  for (const bad of ["0", "-1", "1,234", "abc", ""]) assert.throws(() => reaisToCents(bad), ReportArgsError);
  assert.equal(op("GET", "erp-relatorios/nada"), null);

  // Nomes estáveis; leituras comuns; lançar pagamento é sensível; grupos negocio e financeiro.
  const names = ERP_REPORT_OPERATIONS.map((o) => o.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["erp.financeiro.dre", "erp.financeiro.dre.categoria", "erp.negocio.vendas", "erp.financeiro.graficos", "erp.negocio.estoque", "erp.negocio.lotes_vencendo",
    "erp.financeiro.equipe.pessoas", "erp.financeiro.equipe.pagamentos", "erp.financeiro.equipe.comissoes", "erp.financeiro.equipe.lancar"]) assert.ok(names.includes(name), name);
  for (const o of ERP_REPORT_OPERATIONS) {
    assert.ok(["negocio", "financeiro"].includes(o.group), o.name);
    assert.equal(o.sensitive, o.method === "POST", o.name);
    assert.ok(o.description.length > 30 && !/Fagoo|Origin/.test(o.description + o.summary), o.name);
    assert.ok(o.parts.length >= 1, o.name);
    assert.deepEqual(erpReportParams(o).required, [...o.required]);
  }
  assert.deepEqual(ERP_REPORT_OPERATIONS.find((o) => o.name === "erp.financeiro.equipe.comissoes").parts, ["erp-financeiro", "erp-vendas"]);
});
