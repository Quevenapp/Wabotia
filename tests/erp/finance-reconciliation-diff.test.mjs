// Diferencial aleatório da Conciliação bancária
// (erp_finance_reconciliation_execute e _dismiss): importar e excluir extrato,
// conciliar com lançamentos, transferências e baixas, desvincular com e sem
// estorno, ocultar e mostrar, criar lançamento, transferência e baixa a partir
// da linha e descartar a sugestão, com chamadas estragadas e repetições; e as
// leituras (reconciliation_page e _candidates). Cada chamada portada roda nos
// dois motores; resposta ou erro e tabelas têm de bater.
//   node --test tests/erp/finance-reconciliation-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_reconciliation_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_reconciliation_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261137) >>> 0;
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Alfa diferencial" })).id;
  const account = async (data) => (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: data })).record;
  const banco = await account({ account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "Banco diferencial", agency: "1", account_number: "2", account_digit: "3", start_on: "2026-01-01", opening_cents: "100000" });
  const caixa = await account({ account_type: "cash", name: "Caixa diferencial", start_on: "2026-01-01", opening_cents: "0" });
  const accounts = [banco, caixa];
  const amounts = ["1500", "-1500", "30000", "-5000", "-8000", "2500"];
  const reconcile = (action, data, user = u.financeiro, command = randomUUID()) =>
    ({ name: "erp_finance_reconciliation_execute", args: { p_user_id: user, p_command_id: command, p_action: action, p_data: data } });
  const lines = async () => (await f.db.query("select id,version,state,account_id,amount_cents::text amount,statement_id from erp_finance.bank_statement_line where deleted_at is null order by created_at,id")).rows;
  const statements = async () => (await f.db.query("select id from erp_finance.bank_statement where deleted_at is null order by created_at,id")).rows.map((r) => r.id);
  const entries = async (acc) => (await f.db.query("select id from erp_finance.cash_entry where account_id=$1 and deleted_at is null order by created_at,id", [acc])).rows.map((r) => r.id);
  const movements = async (acc) => (await f.db.query("select id from erp_finance.movement where account_id=$1 and (transfer_id is not null or kind in ('payment','bank_fee')) order by created_at,id", [acc])).rows.map((r) => r.id);
  const titles = async () => (await f.db.query("select id,version,kind,(amount_cents-settled_cents)::text balance from erp_finance.title where deleted_at is null and not cancelled and settled_cents<amount_cents order by created_at,id")).rows;
  // Lançamentos e contas para casar com as linhas.
  for (const amount of amounts) {
    const value = amount.replace("-", "");
    await f.rpc("erp_finance_cash_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "entry_save", p_data: { expected_version: 0, account_id: banco.id, kind: amount.startsWith("-") ? "out" : "in", amount_cents: value, posted_on: `2026-03-0${1 + rand(9)}`, competence_on: "2026-03-01", note: `Lançamento ${amount}` } });
    await f.rpc("erp_finance_title_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create", p_data: { kind: amount.startsWith("-") ? "payable" : "receivable", contact_id: contact, description: `Conta ${amount}`, issued_on: "2026-02-01", competence_on: "2026-02-01", total_cents: value, installments: [{ amount_cents: value, due_on: "2026-03-10" }] } });
  }
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0,
    fileNo = 0;
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
  for (let i = 0; i < N; i++) {
    const ls = await lines();
    const roll = rand(24);
    if (roll === 0) {
      await call("erp_finance_reconciliation_page", { p_user_id: pick([u.consulta, u.vendas]), p_account: pick([banco.id, caixa.id, randomUUID()]), p_state: pick(["pending", "reconciled", "hidden", "x"]), p_amount_cents: pick([null, 1500, 0]), p_page: pick([1, 2]), p_limit: pick([1, 50]) });
      continue;
    }
    if (roll === 1) {
      await call("erp_finance_reconciliation_candidates", { p_user_id: u.consulta, p_account: banco.id, p_from: pick(["2026-03-01", "2026-01-01"]), p_to: pick(["2026-03-31", "2026-02-01"]), p_query: pick([null, "lanç", "15,00", "  ", "alfa", "05/03/2026"]), p_amount_cents: pick([null, 1500, 30000]) });
      continue;
    }
    let req;
    if (roll < 5 || !ls.length) {
      fileNo++;
      const n = 1 + rand(3);
      // Quase sempre válido; às vezes um campo estragado (um por vez, para exercitar a ordem das recusas também).
      const bad = (good, ...worse) => (rand(8) === 0 ? pick(worse) : good);
      // No máximo um campo estragado por linha entre posted_on, amount_cents e memo: com dois, a ordem das
      // recusas no Postgres depende do cache de planos da sessão (plano custom dobra as IMMUTABLE antes do day).
      const rows = Array.from({ length: n }, (_, k) => {
        const spoil = rand(8) === 0 ? pick(["posted_on", "amount_cents", "memo"]) : null;
        return {
          fitid: bad(rand(4) ? `F${fileNo}-${k}` : `F${rand(4)}`, "", "x\u0001"),
          posted_on: spoil === "posted_on" ? "2026-02-30" : pick(["2026-03-05", "2026-03-10", "2026-03-31"]),
          amount_cents: spoil === "amount_cents" ? pick(["0", "1,00"]) : pick(amounts),
          memo: spoil === "memo" ? "m".repeat(256) : pick(["PIX ALFA", null, "TARIFA"]),
          trntype: bad(pick(["DEBIT", "CREDIT", ""]), "debit", 7),
        };
      });
      const content = JSON.stringify(rows) + fileNo;
      req = reconcile("statement_import", { account_id: pick([banco.id, banco.id, caixa.id]), file_name: bad("marco.ofx", "", null, "a".repeat(201)), file_hash: bad(createHash("sha256").update(content).digest("hex"), createHash("sha256").update("fixo").digest("hex"), "abc", null), period_from: "2026-03-01", period_to: bad("2026-03-31", "2026-02-15"), lines: rows });
    } else if (roll === 5) {
      const s = await statements();
      req = reconcile("statement_delete", { id: s.length ? pick(s) : randomUUID() });
    } else if (roll === 6) {
      const l = pick(ls);
      const before = (await f.rpc("erp_finance_reconciliation_page", { p_user_id: u.consulta, p_account: l.account_id, p_state: "pending", p_limit: 100 })).items.find((x) => x.id === l.id);
      const target = before?.suggestion ?? { kind: "entry", id: randomUUID() };
      req = { name: "erp_finance_reconciliation_dismiss", args: { p_user_id: u.financeiro, p_command_id: randomUUID(), p_data: { line_id: l.id, expected_version: l.version, target: { kind: rand(5) ? target.kind : "title", id: target.id } } } };
    } else {
      const r2 = rand(12);
      // Na maior parte das vezes, uma linha no estado que a ação pede.
      const wanted = r2 >= 4 && r2 < 6 ? "reconciled" : r2 === 6 ? pick(["pending", "hidden"]) : "pending";
      const fit = ls.filter((x) => x.state === wanted);
      const l = fit.length && rand(5) ? pick(fit) : pick(ls);
      const base = { line_id: l.id, expected_version: l.version };
      const pool = rand(4) ? [l.account_id] : accounts.map((a) => a.id);
      if (r2 < 4) {
        const links = [];
        for (let k = 0; k < 1 + rand(2); k++) {
          const acc = pick(pool);
          if (rand(2)) { const e = await entries(acc); if (e.length) links.push({ kind: "entry", id: pick(e) }); } else { const m = await movements(acc); if (m.length) links.push({ kind: "movement", id: pick(m) }); }
        }
        if (rand(8) === 0) links.push({ kind: "title", id: randomUUID() });
        req = reconcile("line_reconcile", { ...base, links });
      } else if (r2 < 6) req = reconcile("line_unreconcile", { ...base, ...(rand(3) ? { reverse: pick([true, false, true]) } : {}), ...(rand(10) === 0 ? { reverse: null } : {}) });
      else if (r2 === 6) req = reconcile(l.state === "hidden" ? "line_show" : "line_hide", base);
      else if (r2 === 7) req = reconcile("line_create_entry", { ...base, category_id: null, contact_id: pick([contact, null]), ...(rand(3) === 0 ? { note: pick(["Nota", ""]) } : {}) });
      else if (r2 === 8) req = reconcile("line_create_transfer", { ...base, other_account_id: pick([caixa.id, banco.id, randomUUID()]) });
      else {
        const ts = await titles();
        const chosen = ts.length ? Array.from({ length: 1 + rand(2) }, () => pick(ts)) : [];
        req = reconcile("line_settle_titles", { ...base, items: chosen.map((t) => ({ id: t.id, expected_version: t.version, principal_cents: rand(4) ? t.balance : "1" })) });
      }
    }
    if (rand(6) === 0) {
      const data = req.args.p_data;
      switch (pick(["campo", "versao", "repetir", "repetir_outro", "consulta", "acao"])) {
        case "campo": data.extra = 1; break;
        case "versao": if ("expected_version" in data) data.expected_version += 1; break;
        case "repetir": if (commands.length) req = structuredClone(pick(commands)); break;
        case "repetir_outro": if (commands.length) { req = structuredClone(pick(commands)); req.args.p_user_id = u.admin; } break;
        case "consulta": req.args.p_user_id = u.consulta; break;
        case "acao": if (req.args.p_action) req.args.p_action = "line_bogus"; break;
      }
    }
    const r = await call(req.name, req.args);
    if (r && !r.replayed) commands.push(structuredClone(req));
  }
  console.log(`erp_finance_reconciliation diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 4, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
