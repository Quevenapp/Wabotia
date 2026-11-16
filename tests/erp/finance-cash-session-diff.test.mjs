// Diferencial aleatório do Controle de caixa (erp_finance_cash_session_execute):
// abrir, salvar valores e conferido, fechar, reabrir, sangria, suprimento,
// excluir movimento e excluir caixa, com chamadas estragadas e repetições, e
// as leituras (cash_session_get e cash_session_page). Cada chamada portada
// roda nos dois motores; resposta ou erro e tabelas têm de bater. Pulado
// enquanto o escritor não estiver registrado (aguarda o harness ligar ids de
// linhas novas ausentes da resposta).
//   node --test tests/erp/finance-cash-session-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_cash_session_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_cash_session_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "erp_finance_cash_session_execute ainda não registrado (harness)" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261116) >>> 0;
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
  const account = async (data) => (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: data })).record;
  const accounts = [
    await account({ account_type: "cash", name: "Caixa diferencial", start_on: "2020-01-01", opening_cents: "0" }),
    await account({ account_type: "cash", name: "Caixa Ágil", start_on: "2020-01-01", opening_cents: "0" }),
    await account({ account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "Banco diferencial", agency: "1", account_number: "2", account_digit: "3", start_on: "2020-01-01", opening_cents: "0" }),
  ];
  const methods = [];
  for (const [description, type] of [["Dinheiro", "01"], ["cartão de débito", "04"], ["Cartão de crédito", "03"]])
    methods.push((await f.db.query("INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) VALUES($1,$2,'caixa','ambos',$3,$3) RETURNING id", [description, type, u.admin])).rows[0].id);
  await f.sync();
  const sessions = async () => (await f.db.query("select id,version,state,checked from erp_finance.cash_session where deleted_at is null order by id")).rows;
  const moves = async (session) => (await f.db.query("select id from erp_finance.cash_session_move where session_id=$1 order by id", [session])).rows.map((r) => r.id);
  const operators = [u.financeiro, u.admin];
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${name}:ok`;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  const values = () => Array.from({ length: rand(4) }, () => ({ payment_method_id: rand(8) ? pick(methods) : randomUUID(), amount_cents: pick(["0", "150", "7000", "-1", "1,00"]) }));
  for (let i = 0; i < N; i++) {
    const list = await sessions();
    const roll = rand(20);
    if (roll === 0) {
      await call("erp_finance_cash_session_page", { p_user_id: pick([u.consulta, u.financeiro, u.vendas]), p_state: pick(["all", "open", "closed", "checked", "x"]), p_all: pick([true, false]), p_query: pick([null, "fin", "  ", "ADM"]), p_from: pick([null, "2026-01-01"]), p_to: pick([null, "2100-12-31"]), p_page: pick([1, 2]), p_limit: pick([1, 100]) });
      continue;
    }
    if (roll === 1 && list.length) {
      await call("erp_finance_cash_session_get", { p_user_id: u.consulta, p_id: pick([pick(list).id, randomUUID()]) });
      continue;
    }
    let action, data;
    if (roll < 6 || !list.length) {
      action = "session_open";
      data = { account_id: pick(accounts).id, change_cents: pick(["0", "5000", "123", "-5"]) };
    } else {
      const s = pick(list);
      const base = { id: s.id, expected_version: s.version };
      // Na maior parte das vezes, uma ação que cabe no estado do caixa.
      const fit = rand(4) !== 0;
      const roll2 = !fit ? roll : s.state === "open" ? pick([7, 8, 9, 10, 11, 13, 15, 15]) : s.checked ? pick([13, 19]) : pick([13, 17, 17, 19]);
      if (roll2 === 13 && fit && s.state !== "open") {
        action = "session_save";
        data = { ...base, checked: !s.checked };
      } else if (roll2 < 11) {
        action = "session_move";
        data = { ...base, kind: pick(["supply", "withdrawal", "withdrawal", "x"]), amount_cents: pick(["700", "2000", "0", "1"]) };
        if (rand(2)) data.note = pick(["Troco do banco", "", "Sangria ".repeat(40), null]);
        if (rand(3) === 0) data.posted_on = pick([null, "2020-01-01", "2026-12-01"]);
      } else if (roll2 < 13) {
        const m = await moves(s.id);
        action = "session_move_delete";
        data = { ...base, move_id: m.length ? pick(m) : randomUUID() };
      } else if (roll2 < 15) {
        action = "session_save";
        data = { ...base, checked: fit ? false : pick([true, false, "sim"]) };
        if (rand(2)) data.values = values();
      } else if (roll2 < 17) {
        action = "session_close";
        data = { ...base, values: values() };
      } else if (roll2 < 19) {
        action = "session_reopen";
        data = base;
      } else {
        action = "session_delete";
        data = base;
      }
    }
    const args = { p_user_id: pick(operators), p_command_id: randomUUID(), p_action: action, p_data: data };
    if (rand(5) === 0) {
      switch (pick(["campo", "versao", "repetir", "repetir_outro", "consulta", "acao"])) {
        case "campo": data.extra = 1; break;
        case "versao": if ("expected_version" in data) data.expected_version += 1; break;
        case "repetir": if (commands.length) Object.assign(args, pick(commands)); break;
        case "repetir_outro": if (commands.length) Object.assign(args, { ...pick(commands), p_user_id: u.admin }); break;
        case "consulta": args.p_user_id = u.consulta; break;
        case "acao": args.p_action = "session_x"; break;
      }
    }
    const r = await call("erp_finance_cash_session_execute", args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance_cash_session_execute diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
