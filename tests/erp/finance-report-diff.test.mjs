// Diferencial aleatório dos relatórios do Financeiro: erp_finance_report
// (quatro relatórios, dia e mês, com e sem conta), erp_finance_due_report,
// contact_ledger, contact_ledger_page, contact_open_titles e a lista v1
// erp_finance_title_page, intercalados com escritas (contas, baixas,
// estornos, lançamentos de caixa, transferências) que mudam o que eles leem.
// Cada chamada portada roda nos dois motores; resposta ou erro e tabelas têm
// de bater.
//   node --test tests/erp/finance-report-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_report");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("relatórios do Financeiro: mesmas respostas e erros em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261212) >>> 0;
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
  const contacts = [];
  for (const name of ["Alfa Relatório", "beta relatório", "Ícaro Ágil"]) contacts.push((await f.catalog("contacts", { roles: ["customer", "supplier"], name, document: name.startsWith("Alfa") ? "12.345.678/0001-90" : undefined })).id);
  const account = async (data) => (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: data })).record;
  const banco = await account({ account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "Banco relatório", agency: "1", account_number: "2", account_digit: "3", start_on: "2026-01-01", opening_cents: "100000" });
  const caixa = await account({ account_type: "cash", name: "Caixa relatório", start_on: "2026-02-01", opening_cents: "5000" });
  const accounts = [banco, caixa];
  const category = async (kind, name) => (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind, name } })).record.id;
  const categories = { receivable: await category("receivable", "Vendas relatório"), payable: await category("payable", "Despesas relatório") };
  const day = () => `2026-0${1 + rand(5)}-${String(1 + rand(28)).padStart(2, "0")}`;
  const titles = async () => (await f.db.query("select id,version,kind,(amount_cents-settled_cents)::text balance,settled_cents::text settled from erp_finance.title where deleted_at is null and not cancelled order by created_at,id")).rows;
  const payments = async (title) => (await f.db.query("select id from erp_finance.settlement s where s.title_id=$1 and s.kind='payment' and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id) order by created_at,id", [title])).rows;
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      outcomes[name] = (outcomes[name] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError) {
        console.log(`divergência em ${name}: ${JSON.stringify(args)}`);
        throw e;
      }
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  const reader = () => pick([u.consulta, u.financeiro, u.admin, u.vendas, u.estoque]);
  for (let i = 0; i < N; i++) {
    const roll = rand(16);
    if (roll < 5) {
      // Escritas que mudam o que os relatórios leem (portadas: rodam nos dois motores).
      const w = rand(5);
      if (w === 0 || w === 1) {
        const kind = pick(["receivable", "payable"]);
        const cents = String(100 + rand(9000));
        await call("erp_finance_title_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create", p_data: { kind, contact_id: pick(contacts), description: `Conta ${i}`, issued_on: "2026-01-02", competence_on: "2026-01-02", total_cents: cents, installments: [{ amount_cents: cents, due_on: day() }], ...(rand(2) ? { category_id: categories[kind] } : {}) } });
      } else if (w === 2) {
        const ts = (await titles()).filter((t) => t.balance !== "0");
        if (!ts.length) continue;
        const t = pick(ts);
        await call("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "settle", p_data: { id: t.id, expected_version: t.version, account_id: pick(accounts).id, posted_on: pick(["2026-03-10", "2026-04-05", "2026-02-20"]), principal_cents: t.balance, ...(rand(3) === 0 ? { interest_cents: "150", fee_cents: "50" } : {}) } });
      } else if (w === 3) {
        const ts = (await titles()).filter((t) => t.settled !== "0");
        if (!ts.length) continue;
        const t = pick(ts);
        const p = await payments(t.id);
        if (!p.length) continue;
        await call("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "reverse", p_data: { id: t.id, expected_version: t.version, settlement_id: p[0].id, posted_on: "2026-04-20", note: "Estorno" } });
      } else {
        await call("erp_finance_cash_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "entry_save", p_data: { expected_version: 0, account_id: pick(accounts).id, kind: pick(["in", "out"]), amount_cents: String(100 + rand(5000)), posted_on: pick(["2026-03-15", "2026-04-02"]), competence_on: "2026-03-01", note: "Lançamento", ...(rand(2) ? { contact_id: pick(contacts) } : {}) } });
      }
      continue;
    }
    if (roll < 9) {
      const from = pick(["2026-01-01", "2026-03-01", "2026-03-11", "2026-06-01"]);
      await call("erp_finance_report", {
        p_user_id: reader(), p_report: pick(["cash_flow", "forecast", "categories", "contacts", "x"]), p_from: from, p_to: pick(["2026-03-31", "2026-05-31", "2026-03-13", "2025-12-31"]),
        p_account: pick([null, null, banco.id, caixa.id]), p_group: pick(["month", "month", "day"]), p_page: pick([1, 2]), p_limit: pick([1, 100]),
      });
    } else if (roll === 9) {
      await call("erp_finance_due_report", { p_user_id: reader(), p_from: pick([null, "2026-03-01", "2026-02-30", "2026-3-1"]), p_to: pick([null, "2026-04-30", "2027-06-01"]) });
    } else if (roll < 12) {
      const paged = rand(2) === 0;
      await call(paged ? "erp_finance_contact_ledger_page" : "erp_finance_contact_ledger", {
        p_user_id: reader(), p_contact: rand(6) ? pick(contacts) : randomUUID(), p_scope: pick(["all", "receivable", "payable", "x"]), p_from: "2026-01-01", p_to: pick(["2026-12-31", "2025-01-01"]),
        ...(paged ? { p_page: pick([1, 2]), p_limit: pick([1, 100]) } : {}),
      });
    } else if (roll === 12) {
      await call("erp_finance_contact_open_titles", { p_user_id: reader(), p_kind: pick(["receivable", "payable", "x"]), p_contact: pick(contacts) });
    } else {
      await call("erp_finance_title_page", {
        p_user_id: reader(), p_kind: pick(["receivable", "payable"]), p_page: pick([1, 2]), p_limit: pick([2, 100]), p_order: pick(["due_asc", "due_desc"]),
        p_query: pick([null, "alfa", "345", "ÁGIL", "  "]), p_statuses: pick([null, ["open"], ["paid", "overdue"], ["partial", "cancelled"], []]),
        p_date_field: pick(["due", "issued", "settled"]), p_from: pick([null, "2026-03-01"]), p_to: pick([null, "2026-04-30"]),
        p_category: pick([null, "none", categories.receivable]), p_min_cents: pick([null, 500]), p_max_cents: pick([null, 5000]), p_document: pick([null, "conta"]),
      });
    }
  }
  console.log(`relatórios diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
