// Diferencial aleatório das contas lançadas pelas notas fiscais (erp_finance_invoice_finance_*
// e erp_finance_invoice_order_titles), com a captura de comissão de cada parcela (248):
// vendedor em alíquota fixa ou por faixas de desconto, base pelas Preferências (desconto, frete,
// ST, IPI ou o total da nota), lançar, estornar, baixar uma parcela (trava o estorno) e as
// leituras, com chamadas estragadas (um campo por chamada; ERP-PORTE.md) e repetições.
// A nota é do Fiscal, ainda não portado: erp_fiscal_invoice_execute roda só no Postgres e é
// espelhada. REVISITAR QUANDO O FISCAL FOR PORTADO.
//   node --test tests/erp/finance-invoice-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_invoice_finance_post") && isPorted("erp_finance_invoice_finance_reverse");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_invoice_finance_*: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
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
  const sql = async (text, args = []) => {
    const r = await f.db.query(text, args);
    await f.sync();
    return r;
  };
  await sql("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: "SP", cnpj: "11.222.333/0001-81" }), u.admin]);
  await sql("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [u.admin]);
  const product = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Peça diferencial", code: "P-DIF", unit: "UN", kind: "P", format: "S", price: "50", ncm: "84714900" } })).record;
  const contact = await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente nota diferencial", person_type: "J", document: "12345678000190", state: "SP" });
  const nature = async (data) => (await f.rpc("erp_fiscal_nature_execute", { p_user_id: u.admin, p_command_id: randomUUID(), p_action: "create", p_data: { nature: data } })).nature;
  const saleNature = await nature({ description: "Venda dif", direction: "1", crt: "1" });
  const buyNature = await nature({ description: "Compra dif", direction: "0", crt: "1", presence: "9" });
  const sellers = [];
  for (const name of ["Vendedora fixa", "Vendedor faixas"]) {
    const c = await f.catalog("contacts", { name });
    sellers.push((await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: c.id })).seller.id);
  }
  await sql("update erp_catalog.seller set commission_rule='faturamento',commission_mode='fixa',commission_rate=7.5,commission_bands='[]' where id=$1", [sellers[0]]);
  await sql(
    `update erp_catalog.seller set commission_rule='parcial',commission_mode='descontos',commission_rate=null,
       commission_bands='[{"discount_up_to":2.5,"rate":4.25},{"discount_up_to":10,"rate":2},{"discount_up_to":100,"rate":0.3333}]' where id=$1`,
    [sellers[1]],
  );
  const category = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas por nota dif" } })).record;
  const bank = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa nota dif", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const method = (await sql(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,account_id,created_by,updated_by) values('Boleto dif','15','contas','ambos','aliquota',$1,$2,$2) returning id`, [bank.id, u.admin])).rows[0].id;

  const pref = async (page, key, value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: page })).items.find((item) => item.key === key);
    if (JSON.stringify(current.value) === JSON.stringify(value)) return;
    await f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value }]) });
  };
  let number = 7000;
  const money = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  const createInvoice = async () => {
    const entry = rand(5) === 0;
    const items = [];
    for (let i = 0, n = 1 + rand(3); i < n; i++) {
      const it = { product_id: product.id, description: "Peça diferencial", quantity: String(1 + rand(4)), unit_price: pick(["50", "33.33", "0.07", "19.9"]) };
      if (rand(2)) it.discount = pick(["0.50", "1.00", "3.33", "12.00"]);
      items.push(it);
    }
    const data = {
      model: "55", direction: entry ? "0" : "1", issue_type: "T", number: String(number++), series: "1", nature_id: entry ? buyNature.id : saleNature.id, issue_date: "2026-10-10",
      crt: "1", purpose: "1", presence: entry ? "9" : "1", final_consumer: false,
      recipient: { contact_id: contact.id, name: "Cliente nota diferencial", person_type: "J", document: "12345678000190", state: "SP" }, items,
      payment: { installments: [] },
    };
    if (!entry && rand(4)) data.seller_id = pick(sellers);
    if (rand(3) === 0) data.freight = pick(["20.00", "0.01", "7.77"]);
    let v;
    try {
      v = (await f.rpc("erp_fiscal_invoice_execute", { p_user_id: u.admin, p_command_id: randomUUID(), p_action: "create", p_data: { invoice: data, orders: [] } })).invoice;
    } catch {
      return null;
    }
    // As parcelas pelo total calculado da nota: 1 a 3, a soma às vezes errada.
    const total = Math.round(Number((await f.db.query("select totals->>'total' t from erp_fiscal_invoices.invoice where id=$1", [v.id])).rows[0].t) * 100);
    const n = 1 + rand(3);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const amount = i < n - 1 ? Math.floor(total / n) : total - Math.floor(total / n) * (n - 1);
      const p = { date: ["2026-11-10", "2026-12-10", "2027-01-10"][i], amount: money(amount), method: "15" };
      if (rand(3) === 0) p.payment_method_id = method;
      parts.push(p);
    }
    if (rand(10) === 0) parts[0].amount = money(Number(parts[0].amount.replace(".", "")) + 1);
    if (rand(15) === 0) parts[0].date = "2026-02-30";
    await f.db.query("alter table erp_fiscal_invoices.invoice disable trigger guard_invoice");
    await sql("update erp_fiscal_invoices.invoice set payment=$2::jsonb where id=$1", [v.id, JSON.stringify({ condition: null, installments: parts })]);
    await f.db.query("alter table erp_fiscal_invoices.invoice enable trigger guard_invoice");
    return v.id;
  };
  const invoices = [];
  const invoice = async (id) => (await f.db.query("select id,version from erp_fiscal_invoices.invoice where id=$1", [id])).rows[0];
  const active = async () =>
    (await f.db.query("select p.id,p.version,p.invoice_id from erp_finance.invoice_posting p where p.state='active' order by p.created_at,p.id")).rows;
  const postingTitles = async (posting) =>
    (await f.db.query("select t.id::text id,t.version from erp_finance.invoice_title l join erp_finance.title t on t.id=l.title_id where l.posting_id=$1 order by l.position", [posting])).rows;

  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : name;
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
  for (let i = 0; i < 4; i++) {
    const id = await createInvoice();
    if (id) invoices.push(id);
  }
  for (let i = 0; i < N; i++) {
    const roll = rand(24);
    const reader = pick([u.consulta, u.financeiro, u.fiscal, u.vendas]);
    if (roll < 5) {
      const id = await createInvoice();
      if (id) invoices.push(id);
      continue;
    }
    if (roll === 5) {
      const which = rand(4);
      if (which === 0) await pref("vendas-vendas", "vendas.base_comissao", pick([[], ["desconto"], ["frete"], ["desconto", "frete", "icms_st", "ipi"]]));
      else if (which === 1) await pref("notas-nfe", "nfe.base_comissao_total", rand(2) === 0);
      else await sql("update erp_catalog.seller set commission_rate=$2 where id=$1", [sellers[0], pick([7.5, 0, 12.3456, 100])]);
      continue;
    }
    if (roll === 6 && invoices.length) {
      await call("erp_finance_invoice_finance_get", { p_user_id: reader, p_invoice_id: pick([...invoices, randomUUID()]) });
      continue;
    }
    if (roll === 7 && invoices.length) {
      await call("erp_finance_invoice_finance_flags", { p_user_id: reader, p_ids: invoices.slice(-1 - rand(5)) });
      await call("erp_finance_invoice_order_titles", { p_user_id: reader, p_invoice_id: pick(invoices) });
      continue;
    }
    if (roll === 8) {
      if (rand(3)) continue;
      const ps = await active();
      if (!ps.length) continue;
      const t = pick(await postingTitles(pick(ps).id));
      await call("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "settle", p_data: { id: t.id, expected_version: t.version, account_id: bank.id, posted_on: "2026-10-20", principal_cents: "1" } });
      continue;
    }
    const user = rand(10) ? u.financeiro : pick([u.consulta, u.fiscal, u.admin]);
    let name, args;
    if (roll < 17) {
      if (!invoices.length) continue;
      const v = await invoice(pick(invoices));
      const extra = { category_id: pick([null, null, category.id]), account_id: pick([null, null, bank.id]) };
      const shown = await call("erp_finance_invoice_finance_preview", { p_user_id: rand(8) ? user : reader, p_invoice_id: v.id, p_expected_version: v.version, p_category_id: extra.category_id, p_account_id: extra.account_id });
      if (!shown) continue;
      name = "erp_finance_invoice_finance_post";
      const data = { invoice_id: v.id, expected_version: v.version, preview_hash: shown.preview.preview_hash, ...extra };
      if (rand(5) === 0) {
        const [k, value] = pick([["preview_hash", "a".repeat(64)], ["preview_hash", 1], ["expected_version", v.version + 1], ["expected_version", "1"], ["category_id", randomUUID()], ["account_id", "x"], ["invoice_id", randomUUID()], ["extra", 1]]);
        data[k] = value;
      }
      args = { p_user_id: user, p_command_id: rand(30) ? randomUUID() : null, p_data: data };
    } else {
      const ps = await active();
      if (!ps.length) continue;
      const p = pick(ps);
      const ts = await postingTitles(p.id);
      name = "erp_finance_invoice_finance_reverse";
      const data = { invoice_id: p.invoice_id, posting_id: p.id, expected_version: p.version, titles: ts.map((t) => ({ id: rand(4) ? t.id : t.id.toUpperCase(), version: t.version })), reason: pick(["Estorno diferencial", "  ok  ", "  Estorno  "]) };
      if (rand(5) === 0) {
        const [k, value] = pick([["reason", "ab"], ["reason", null], ["titles", []], ["titles", ts.slice(1).map((t) => ({ id: t.id, version: t.version }))], ["titles", ts.map((t) => ({ id: t.id, version: t.version + 1 }))],
          ["expected_version", p.version + 1], ["posting_id", randomUUID()], ["invoice_id", pick(invoices)], ["titles", [{ id: ts[0].id }]]]);
        data[k] = value;
      }
      args = { p_user_id: user, p_command_id: randomUUID(), p_data: data };
    }
    if (rand(8) === 0 && commands.length) {
      const old = pick(commands);
      name = old.name;
      args = structuredClone(old.args);
    }
    const r = await call(name, args);
    if (r && !r.replayed) commands.push({ name, args: structuredClone(args) });
  }
  const captured = (await f.db.query("select count(*)::int n, count(distinct rate)::int rates from erp_finance.commission where origin='invoice'")).rows[0];
  console.log(`erp_finance_invoice diferencial: ${N} passos, comissões ${JSON.stringify(captured)}, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok((outcomes.erp_finance_invoice_finance_post ?? 0) > 5, "poucos lançamentos");
  assert.ok((outcomes.erp_finance_invoice_finance_reverse ?? 0) > 2, "poucos estornos");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
