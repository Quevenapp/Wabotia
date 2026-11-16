// Diferencial aleatório das Contas recorrentes (erp_finance_recurrence_execute):
// criar em todas as frequências (com dias úteis e parcelada), gerar contas,
// ativar e inativar e alterar contas em aberto e futuras, com chamadas
// estragadas (no máximo um campo por chamada; ERP-PORTE.md, ordem das recusas)
// e repetições; e as leituras (recurrence_get e recurrence_page). Cada chamada
// portada roda nos dois motores; resposta ou erro e tabelas têm de bater.
//   node --test tests/erp/finance-recurrence-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_recurrence_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_recurrence_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261138) >>> 0;
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Alfa recorrente" })).id;
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa recorrente", start_on: "2026-01-01", opening_cents: "0" } })).record;
  const category = (kind) => f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind, name: `Recorrente ${kind}` } });
  const categories = { receivable: (await category("receivable")).record.id, payable: (await category("payable")).record.id };
  const recurrences = async () => (await f.db.query("select id,version,kind,active from erp_finance.recurrence order by created_at,id")).rows;
  const titlesOf = async (rec) => (await f.db.query("select id from erp_finance.title where recurrence_id=$1 order by recurrence_on", [rec])).rows.map((r) => r.id);
  const dues = ["2026-01-31", "2026-02-28", "2026-03-06", "2026-04-03", "2026-02-16", "2026-12-25"];
  const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${name}:${args.p_action ?? "ok"}`;
      outcomes[k] = (outcomes[k] || 0) + 1;
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
  // Um campo estragado por vez.
  const spoil = (data, options) => {
    const [key, value] = pick(options);
    if (value === undefined) delete data[key];
    else data[key] = value;
  };
  for (let i = 0; i < N; i++) {
    const list = await recurrences();
    const roll = rand(20);
    if (roll === 0) {
      await call("erp_finance_recurrence_page", { p_user_id: pick([u.consulta, u.vendas]), p_kind: pick(["receivable", "payable", "x"]), p_active: pick([true, false, null]), p_query: pick([null, "alfa", "  ", "Mensal"]), p_page: pick([1, 2]), p_limit: pick([1, 100]) });
      continue;
    }
    if (roll === 1 && list.length) {
      await call("erp_finance_recurrence_get", { p_user_id: u.consulta, p_id: rand(4) ? pick(list).id : randomUUID() });
      continue;
    }
    let action, data;
    if (roll < 7 || !list.length) {
      action = "recurrence_create";
      const kind = pick(["receivable", "payable"]);
      const frequency = pick(["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "semiannual", "annual", "installments"]);
      const due = pick(dues);
      data = { kind, contact_id: contact, description: pick(["Mensalidade", "Aluguel Ágil"]), issued_on: "2026-01-02", competence_on: "2026-01-01", due_on: due, amount_cents: pick(["10000", "1"]), frequency };
      if (frequency === "weekly") data.weekday = dow(due);
      else data.due_day = Number(due.slice(8));
      if (frequency === "biweekly") data.second_day = data.due_day === 20 ? 5 : 20;
      if (frequency === "installments") data.installments = pick([2, 3, 12]);
      else if (rand(3) === 0) data.end_on = pick(["2026-06-30", "2026-12-31"]);
      if (rand(2)) data.business_days = true;
      if (rand(3) === 0) data.category_id = categories[kind];
      if (rand(4) === 0) data.account_id = account.id;
      if (rand(4) === 0) Object.assign(data, { interest_month_bp: 100, penalty_bp: 200, source_reference: "Contrato 7", bank_number: "BOLETO-1" });
      if (rand(5) === 0)
        spoil(data, [
          ["kind", "both"], ["frequency", "daily"], ["due_on", "2025-12-31"], ["end_on", "2025-01-01"], ["amount_cents", "0"], ["due_day", null], ["due_day", 32],
          ["weekday", "x"], ["weekday", 9], ["weekday", 1.5], ["business_days", null], ["business_days", "sim"], ["installments", 1], ["contact_id", randomUUID()],
          ["category_id", categories[kind === "receivable" ? "payable" : "receivable"]], ["account_id", randomUUID()], ["description", ""], ["bank_number", "x".repeat(61)],
          ["interest_month_bp", 10001], ["payment_method_id", randomUUID()], ["second_day", data.due_day ?? 1], ["issued_on", "2026-02-30"],
        ]);
    } else {
      const r = pick(list);
      const base = { id: r.id, expected_version: r.version };
      const r2 = rand(10);
      if (r2 < 6) {
        action = "recurrence_generate";
        data = base;
      } else if (r2 < 8) {
        action = "recurrence_set_active";
        data = { ...base, active: rand(4) ? !r.active : pick([r.active, "sim"]) };
      } else {
        action = "recurrence_update";
        const ts = await titlesOf(r.id);
        const changes = {};
        if (rand(2)) changes.amount_cents = pick(["12000", "5"]);
        if (rand(2)) changes.description = pick(["Reajustado", "Novo nome"]);
        if (rand(4) === 0) changes.category_id = pick([categories[r.kind], null]);
        if (rand(4) === 0) changes.account_id = pick([account.id, null]);
        if (rand(4) === 0) changes.interest_month_bp = pick([0, 150]);
        data = { ...base, from_title_id: ts.length ? pick(ts) : randomUUID(), scope: pick(["none", "following", "all"]), future: pick([true, false]), changes };
        if (rand(5) === 0) spoil(data, [["scope", "x"], ["future", "sim"], ["changes", []], ["from_title_id", randomUUID()]]);
      }
    }
    const args = { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data };
    if (rand(6) === 0) {
      switch (pick(["campo", "versao", "repetir", "repetir_outro", "consulta", "acao"])) {
        case "campo": data.extra = 1; break;
        case "versao": if ("expected_version" in data) data.expected_version += 1; break;
        case "repetir": if (commands.length) Object.assign(args, structuredClone(pick(commands))); break;
        case "repetir_outro": if (commands.length) Object.assign(args, { ...structuredClone(pick(commands)), p_user_id: u.admin }); break;
        case "consulta": args.p_user_id = u.consulta; break;
        case "acao": args.p_action = "recurrence_x"; break;
      }
    }
    const res = await call("erp_finance_recurrence_execute", args);
    if (res && !res.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance_recurrence diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
