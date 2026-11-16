// Diferencial aleatório do Faturamento agrupado (erp_finance_grouped_billing_*):
// pedidos de venda de dois clientes (o Documentos ainda roda só no Postgres e
// é espelhado), gerar contas pela condição, excluir, baixar uma parcela (trava
// a exclusão) e as leituras (page, candidates e documents), com chamadas
// estragadas (um campo por chamada; ERP-PORTE.md) e repetições. As notas
// fiscais ficam de fora: dependem do domínio Fiscal.
// Com ERP_DIFF_N=600 aparece a regra 8 do ERP-FASE0 (identity): um gerar que
// falha no segundo cliente consome o número do faturamento no Postgres e o
// SQLite o reaproveita; o próximo sucesso diverge em items[n].number. Pedido à
// N: sequência no motor que não volta com a transação, ou máscara no harness.
//   node --test tests/erp/finance-grouped-billing-diff.test.mjs
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_grouped_billing_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_grouped_billing_*: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261174) >>> 0;
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
  const contacts = [];
  for (const name of ["Alfa Agrupado", "beta agrupado"]) contacts.push((await f.catalog("contacts", { roles: ["customer", "supplier"], name })).id);
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa agrupado", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const order = async (contact, price) => {
    let d = (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: today, contact_id: contact, items: [{ description: "Item", unit: "UN", quantity: "1", unit_price: price, discount_percent: "0" }], installments: [] } })).document;
    for (const status of d.status === "draft" ? ["open", "verified"] : ["verified"])
      d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: "sales_orders", p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: "Teste" })).document;
    return d;
  };
  const free = async (contact) => (await f.db.query(
    `select d.id,(d.total*100)::bigint::text cents from erp_documents.document d where d.kind='sales_orders' and d.contact_id=$1 and d.status='verified'
       and not exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=d.id and g.active) order by d.created_at,d.id`, [contact])).rows;
  const billings = async () => (await f.db.query("select id,version from erp_finance.grouped_billing where state='active' order by created_at,id")).rows;
  const titles = async () => (await f.db.query("select t.id,t.version,(t.amount_cents-t.settled_cents)::text balance from erp_finance.grouped_billing_title l join erp_finance.title t on t.id=l.title_id where not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents order by t.created_at,t.id")).rows;
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
  for (let i = 0; i < N; i++) {
    const roll = rand(20);
    const reader = pick([u.consulta, u.financeiro, u.vendas]);
    if (roll < 4) {
      await order(pick(contacts), pick(["100", "50.01", "30", "0.03"]));
      continue;
    }
    if (roll === 4) {
      await call("erp_finance_grouped_billing_page", { p_user_id: reader, p_from: pick([null, today]), p_to: pick([null, today]), p_query: pick([null, "alfa", "  "]), p_page: pick([1, 2]), p_limit: pick([1, 100]) });
      continue;
    }
    if (roll === 5) {
      const docs = (await free(pick(contacts))).map((d) => d.id);
      await call("erp_finance_grouped_billing_candidates", { p_user_id: reader, p_from: pick([today, null]), p_to: today, p_documents: rand(3) === 0 && docs.length ? docs.slice(0, 2) : null, p_query: pick([null, "BETA"]), p_page: 1, p_limit: pick([1, 100]) });
      continue;
    }
    if (roll === 6) {
      await call("erp_finance_grouped_billing_documents", { p_user_id: reader, p_contact: pick(contacts), p_from: today, p_to: pick([today, "2027-12-31"]), p_documents: null });
      continue;
    }
    if (roll === 7) {
      const ts = await titles();
      if (!ts.length) continue;
      const t = pick(ts);
      await call("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "settle", p_data: { id: t.id, expected_version: t.version, account_id: account.id, posted_on: today, principal_cents: "1" } });
      continue;
    }
    let action, data;
    if (roll < 15) {
      action = "grouped_billing_generate";
      const items = [];
      for (const contact of rand(3) === 0 ? contacts : [pick(contacts)]) {
        const docs = await free(contact);
        if (!docs.length) continue;
        const chosen = docs.slice(0, 1 + rand(Math.min(3, docs.length)));
        const total = chosen.reduce((s, d) => s + Number(d.cents), 0);
        const days = pick([[0], [30, 60], [10, 20, 30]]);
        items.push({ contact_id: contact, document_ids: chosen.map((d) => d.id), total_cents: String(total), condition: days.join(" "), days });
      }
      if (!items.length) continue;
      data = { items, ...(rand(4) === 0 ? { category_id: null } : {}) };
      if (rand(5) === 0) {
        const it = items[0];
        const [k, v] = pick([["total_cents", String(Number(it.total_cents) + 1)], ["days", [60, 30]], ["days", []], ["condition", ""], ["document_ids", []], ["contact_id", contacts.find((c) => c !== it.contact_id)], ["document_ids", [it.document_ids[0], it.document_ids[0]]]]);
        it[k] = v;
      }
    } else {
      action = "grouped_billing_delete";
      const bs = await billings();
      const b = bs.length ? pick(bs) : { id: randomUUID(), version: 1 };
      data = { id: b.id, expected_version: rand(6) ? b.version : b.version + 1 };
    }
    const args = { p_user_id: rand(10) ? u.financeiro : pick([u.consulta, u.vendas, u.admin]), p_command_id: randomUUID(), p_action: action, p_data: data };
    if (rand(8) === 0 && commands.length) Object.assign(args, structuredClone(pick(commands)));
    const r = await call("erp_finance_grouped_billing_execute", args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance_grouped_billing diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 5, "poucas chamadas aceitas");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
