// Diferencial aleatório do escritor 010 do Financeiro (erp_finance_execute):
// contas e categorias simples, grupos de contas, alterar, cancelar, baixar
// (com juros, multa, desconto e tarifa), estornar e saldo inicial, com
// chamadas estragadas e repetições. Também passam pela gaveta
// (erp_finance_title_execute) e pelas leituras (title_page_v2, list, get).
// Cada chamada portada roda nos dois motores; resposta ou erro e tabelas têm
// de bater. Pulado enquanto o erp_finance_execute não estiver registrado
// (aguarda o harness ligar ids de linhas novas ausentes da resposta).
//   node --test tests/erp/finance-execute-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "erp_finance_execute ainda não registrado (harness)" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261118) >>> 0;
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
  const exec = (action, data, user = u.financeiro, command = randomUUID()) => f.rpc("erp_finance_execute", { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
  const contacts = [];
  for (const name of ["Alfa diferencial", "Beta diferencial"]) contacts.push((await f.catalog("contacts", { roles: ["customer", "supplier"], name })).id);
  const accounts = [];
  for (const [name, kind] of [["Banco", "bank"], ["Caixa", "cash"]]) accounts.push((await exec("account_save", { expected_version: 0, name: `${name} diferencial`, kind })).record);
  const categories = [];
  for (const [name, kind] of [["Receita", "receivable"], ["Despesa", "payable"]]) categories.push((await exec("category_save", { expected_version: 0, name: `${name} diferencial`, kind })).record);
  const titleRows = async () => (await f.db.query("select id,version,kind,cancelled,amount_cents::text amount,settled_cents::text settled,issued_on::text issued from erp_finance.title where deleted_at is null order by id")).rows;
  const settlementRows = async (title) => (await f.db.query("select s.id,s.posted_on::text posted from erp_finance.settlement s where s.title_id=$1 and s.kind='payment' order by s.id", [title])).rows;
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
  const day = (d) => `2026-0${1 + rand(3)}-${String(1 + rand(27)).padStart(2, "0")}`;
  for (let i = 0; i < N; i++) {
    const titles = await titleRows();
    const roll = rand(20);
    if (roll === 0) {
      await call("erp_finance_title_page_v2", { p_user_id: u.consulta, p_kind: pick(["receivable", "payable"]), p_option: pick(["issued", "open", "overdue"]), p_limit: 100 });
      continue;
    }
    if (roll === 1) {
      await call("erp_finance_list", { p_user_id: u.consulta, p_entity: pick(["titles", "accounts", "categories", "movements", "settlements"]), p_parent_id: rand(2) ? pick(accounts).id : titles.length ? pick(titles).id : null, p_limit: pick([2, 25]) });
      continue;
    }
    let action, data;
    if (roll < 7 || !titles.length) {
      action = "title_create_group";
      const kind = pick(["receivable", "payable"]);
      const n = 1 + rand(3);
      const parts = Array.from({ length: n }, () => String(100 + rand(5000)));
      const total = parts.reduce((s, p) => s + Number(p), 0);
      data = {
        kind, contact_id: pick(contacts), description: pick(["Título diferencial", "Aluguel", "Serviço Ágil", "x".repeat(241)]), issued_on: "2026-01-02",
        total_cents: String(total), installments: parts.map((p, k) => ({ amount_cents: p, due_on: `2026-0${2 + k}-10` })),
      };
      if (rand(2)) data.category_id = kind === "receivable" ? categories[0].id : categories[1].id;
      if (rand(3) === 0) data.source_reference = "Pedido 7";
    } else if (roll < 12) {
      const t = pick(titles);
      action = "settle";
      const balance = Number(t.amount) - Number(t.settled);
      data = { id: t.id, expected_version: t.version, account_id: pick(accounts).id, posted_on: pick(["2026-02-11", "2026-01-01", day()]), principal_cents: String(Math.max(1, Math.min(balance, 1 + rand(3000)))) };
      for (const k of ["interest_cents", "penalty_cents", "discount_cents", "fee_cents"]) if (rand(3) === 0) data[k] = String(rand(200));
      if (rand(2)) data.note = "Baixa diferencial";
    } else if (roll < 15) {
      const t = pick(titles);
      const s = await settlementRows(t.id);
      action = "reverse";
      data = { id: t.id, expected_version: t.version, settlement_id: s.length ? pick(s).id : randomUUID(), posted_on: pick(["2026-02-20", "2026-02-12"]), note: "Estorno diferencial" };
    } else if (roll < 17) {
      const t = pick(titles);
      action = "title_update";
      data = { id: t.id, expected_version: t.version };
      if (rand(2)) data.description = "Alterado";
      if (rand(2)) data.amount_cents = String(100 + rand(9000));
      if (rand(2)) data.due_on = pick(["2026-03-01", "2025-12-01"]);
      if (rand(3) === 0) data.category_id = pick([null, ...categories.map((c) => c.id)]);
    } else if (roll === 17) {
      const t = pick(titles);
      action = "title_cancel";
      data = { id: t.id, expected_version: t.version, note: "Cancelado" };
    } else if (roll === 18) {
      const a = pick(accounts);
      const v = Number(await f.scalar("select version value from erp_finance.account where id=$1", [a.id]));
      action = "opening";
      data = { id: a.id, expected_version: v, amount_cents: pick(["0", "-500", "100000"]), posted_on: pick(["2026-01-01", "2026-03-01"]), note: "Abertura" };
    } else {
      action = pick(["account_save", "category_save"]);
      data = action === "account_save" ? { expected_version: 0, name: `Conta ${i}`, kind: pick(["bank", "cash", "other", "x"]) } : { expected_version: 0, name: `Categoria ${i}`, kind: pick(["receivable", "payable", "both"]) };
    }
    const args = { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data };
    if (rand(5) === 0) {
      switch (pick(["campo", "versao", "repetir", "repetir_outro", "consulta", "acao", "nulo"])) {
        case "campo": data.extra = 1; break;
        case "versao": if ("expected_version" in data) data.expected_version += 1; break;
        case "repetir": if (commands.length) Object.assign(args, pick(commands)); break;
        case "repetir_outro": if (commands.length) Object.assign(args, { ...pick(commands), p_user_id: u.admin }); break;
        case "consulta": args.p_user_id = u.consulta; break;
        case "acao": args.p_action = "bordero"; break;
        case "nulo": for (const k of ["interest_cents", "principal_cents", "due_on", "note"]) if (k in data) data[k] = null; break;
      }
    }
    const r = await call("erp_finance_execute", args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance_execute diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
