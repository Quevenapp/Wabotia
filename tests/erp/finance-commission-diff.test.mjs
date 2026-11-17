// Diferencial aleatório das Comissões (erp_finance_commission_execute):
// pagamento por caixa e por conta a pagar (a preferência é trocada no meio),
// outro lançamento, comissão manual e excluir, com chamadas estragadas (um
// campo por chamada; ERP-PORTE.md, ordem das recusas) e repetições; e as
// leituras (page, statement e report), inclusive com o vendedor vinculado ao
// usuário (contatos.acesso_vendedor). Cada chamada portada roda nos dois
// motores; resposta ou erro e tabelas têm de bater.
//   node --test tests/erp/finance-commission-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_commission_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_commission_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261171) >>> 0;
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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const thisMonth = `${today.slice(0, 7)}-01`;
  const sql = async (text, args = []) => { const r = await f.db.query(text, args); await f.sync(); return r; };
  const preference = async (page, key, value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: page })).items.find((item) => item.key === key);
    return f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value }]) });
  };
  const sellers = [];
  for (const [name, rate] of [["Vendedora Ágil", 5], ["vendedor beta", null], ["Ícaro Vendas", 2.5]]) {
    const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name })).id;
    const seller = (await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: contact })).seller.id;
    await sql("UPDATE erp_catalog.seller SET commission_rule='parcial',commission_mode='fixa',commission_rate=$2 WHERE id=$1", [seller, rate]);
    sellers.push(seller);
  }
  // O usuário de vendas fica vinculado ao primeiro vendedor (escopo do contato).
  await sql("UPDATE erp_catalog.seller SET user_id=$2 WHERE id=$1", [sellers[0], u.vendas]);
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa comissões", start_on: "2020-01-01", opening_cents: "100000" } })).record;
  const category = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "payable", name: "Comissões" } })).record.id;
  const entries = async () => (await f.db.query("select id,version from erp_finance.commission_entry where deleted_at is null order by created_at,id")).rows;
  const manuals = async () => (await f.db.query("select id,version from erp_finance.commission where deleted_at is null order by created_at,id")).rows;
  const months = [thisMonth, "2026-01-01", "2025-12-01"];
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
  const spoil = (data, options) => {
    const [key, value] = pick(options);
    if (value === undefined) delete data[key];
    else data[key] = value;
  };
  for (let i = 0; i < N; i++) {
    const roll = rand(20);
    const reader = pick([u.consulta, u.financeiro, u.vendas, u.estoque]);
    if (roll === 0) {
      await call("erp_finance_commission_page", { p_user_id: reader, p_month: pick(months), p_situation: pick(["all", "A", "I", "S", "X"]), p_with_idle: pick([true, false]), p_query: pick([null, "ágil", "  ", "VENDEDOR"]), p_page: pick([1, 2]), p_limit: pick([1, 100]) });
      continue;
    }
    if (roll === 1) {
      await call("erp_finance_commission_statement", { p_user_id: reader, p_seller: rand(6) ? pick(sellers) : randomUUID(), p_month: pick([...months, "2026-01-15"]) });
      continue;
    }
    if (roll === 2) {
      await call("erp_finance_commission_report", { p_user_id: reader, p_from: pick(["2026-01-01", today]), p_to: pick([today, "2099-01-01"]), p_seller_id: pick([null, ...sellers]), p_state: pick(["all", "active", "x"]), p_page: 1, p_limit: 100 });
      continue;
    }
    if (roll === 3) {
      await preference("financas-pagar", "financas.comissoes_contas_pagar", pick([true, false])).catch(() => null);
      if (rand(3) === 0) await preference("contatos-contatos", "contatos.acesso_vendedor", pick([true, false])).catch(() => null);
      continue;
    }
    let action, data;
    if (roll < 9) {
      action = "commission_payment";
      data = { seller_id: pick(sellers), month: pick(months), posted_on: today, category_id: pick([category, null]), account_id: pick([account.id, account.id, null]), amount_cents: pick(["1000", "250"]), description: "Pagamento de comissões" };
      if (rand(5) === 0) spoil(data, [["month", "2026-01-15"], ["amount_cents", "0"], ["description", ""], ["seller_id", randomUUID()], ["account_id", randomUUID()], ["category_id", randomUUID()], ["extra", 1]]);
    } else if (roll < 13) {
      action = "commission_entry";
      data = { seller_id: pick(sellers), month: pick(months), posted_on: today, amount_cents: pick(["500", "200"]), kind: pick(["credit", "debit"]), description: pick(["Bônus", "Adiantamento"]) };
      if (rand(5) === 0) spoil(data, [["kind", "payment"], ["month", "2101-01-01"], ["description", "x\u0001"], ["amount_cents", "1,00"]]);
    } else if (roll < 16) {
      action = "commission_manual";
      data = { seller_id: pick(sellers), due_on: today, credit_on: pick([today, "2026-01-10"]), parcel_cents: pick(["10000", "15", "333"]) };
      if (rand(2)) data.rate = pick(["5", "2.5", "100", "0.0001", "33.3333"]);
      if (rand(3) === 0) data.description = pick(["Ajuste", ""]);
      if (rand(5) === 0) spoil(data, [["rate", "101"], ["rate", 5], ["rate", "1.23456"], ["due_on", "2026-02-30"], ["parcel_cents", "0"]]);
    } else {
      action = "commission_delete";
      const target = pick(["entry", "commission", "x"]);
      const list = target === "commission" ? await manuals() : await entries();
      const row = list.length ? pick(list) : { id: randomUUID(), version: 1 };
      data = { target, id: row.id, expected_version: rand(6) ? row.version : row.version + 1 };
    }
    const args = { p_user_id: rand(10) ? u.financeiro : pick([u.consulta, u.admin]), p_command_id: randomUUID(), p_action: action, p_data: data };
    if (rand(8) === 0 && commands.length) Object.assign(args, structuredClone(pick(commands)));
    const r = await call("erp_finance_commission_execute", args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance_commission diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
