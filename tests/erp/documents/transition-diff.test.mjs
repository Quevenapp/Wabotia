// Diferencial aleatório do erp_document_transition: a proposta (sem situações, pelas transições
// do status) e os pedidos e a OS (com situações), com situações próprias, regras configuradas,
// ativas e inativas, motivo obrigatório, usuários sem permissão, versões velhas, alvo inválido e
// repetições de comando. Os documentos nascem pelo erp_document_save (nos dois motores) e a
// confirmação dispara os adiados de comissão e custo.
// Fora até o B5 e o stock_launch_date da N: regras com as ações post_stock, reverse_stock,
// post_finance e reverse_finance, e o lançamento automático de contas (preferências desligadas).
//   node --test tests/erp/documents/transition-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import "../../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_document_transition");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_document_transition: mesmas respostas, erros e estado em sequência aleatória", { timeout: 1_800_000, skip: ready ? false : "não registrado" }, async () => {
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente transição" })).id;
  const sellerContact = await f.catalog("contacts", { name: "Vendedora transição" });
  const seller = (await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: sellerContact.id })).seller.id;
  await f.db.query("update erp_catalog.seller set commission_rule='parcial',commission_mode='fixa',commission_rate=3 where id=$1", [seller]);
  await f.sync();
  const product = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Peça transição", code: "P-TR", unit: "UN", kind: "P", format: "S", price: "20" } })).record.id;
  const situation = async (kind, base, name) =>
    (await f.rpc("erp_preferences_situation_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_situation: null, p_expected_version: 0, p_data: { active: true, base_status: base, color: "#336699", name } })).receipt.target;
  const custom = {
    sales_orders: [await situation("sales_orders", "open", "Aguardando pagamento"), await situation("sales_orders", "in_progress", "Separando")],
    service_orders: [await situation("service_orders", "approved", "Aprovada pelo cliente")],
    purchase_orders: [await situation("purchase_orders", "in_progress", "Em trânsito")],
  };
  const rule = async (kind, from, to, active) => {
    const version = (await f.db.query("select coalesce((select version from erp_preferences.transition where kind=$1 and from_key=$2 and to_key=$3),0) v", [kind, from, to])).rows[0].v;
    await f.rpc("erp_preferences_transition_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_from: from, p_to: to, p_expected_version: version, p_data: { active, actions: [] } }).catch(() => null);
  };
  const BASES = {
    sales_proposals: ["draft", "open", "pending", "waiting", "approved", "rejected", "cancelled", "completed"],
    sales_orders: ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled", "checkout_partial"],
    purchase_orders: ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"],
    service_orders: ["open", "quoted", "approved", "rejected", "in_progress", "waiting_parts", "service_done", "finalized", "no_repair", "cancelled"],
  };
  const pairs = [
    ["sales_orders", "open", custom.sales_orders[0]], [custom.sales_orders[0], "verified"], ["verified", custom.sales_orders[1]], [custom.sales_orders[1], "fulfilled"],
    ["sales_orders", custom.sales_orders[0], custom.sales_orders[1]],
  ];
  for (const [kind, from, to] of [
    ["sales_orders", "open", custom.sales_orders[0]], ["sales_orders", custom.sales_orders[0], "verified"], ["sales_orders", "verified", custom.sales_orders[1]],
    ["sales_orders", custom.sales_orders[1], "fulfilled"], ["sales_orders", custom.sales_orders[0], "cancelled"], ["service_orders", "open", custom.service_orders[0]],
    ["service_orders", custom.service_orders[0], "in_progress"], ["purchase_orders", "open", custom.purchase_orders[0]], ["purchase_orders", custom.purchase_orders[0], "fulfilled"],
  ])
    await rule(kind, from, to, true);
  void pairs;
  const docs = [];
  const create = async (kind) => {
    const body = { date: "2026-10-10", contact_id: contact, items: [{ product_id: product, description: "Item transição", unit: "UN", quantity: String(1 + rand(3)), unit_price: "20", discount_percent: "0" }], installments: [] };
    if (kind !== "purchase_orders" && rand(2)) body.seller_id = seller;
    const r = await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body }).catch(() => null);
    if (r) docs.push({ id: r.document.id, kind });
  };
  for (const kind of Object.keys(BASES)) await create(kind);
  const state = async (d) => (await f.db.query("select version, status from erp_documents.document where id=$1", [d.id])).rows[0];

  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (args) => {
    try {
      const r = await f.rpc("erp_document_transition", args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${args.p_kind}:${r.document.status}`;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError || /divergem/.test(e.message)) {
        console.log(`divergência: ${JSON.stringify(args)}`);
        throw e;
      }
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  for (let i = 0; i < N; i++) {
    const roll = rand(20);
    if (roll === 0) {
      await create(pick(Object.keys(BASES)));
      continue;
    }
    if (roll === 1) {
      const kind = pick(["sales_orders", "service_orders", "purchase_orders"]);
      const keys = [...BASES[kind], ...custom[kind]];
      await rule(kind, pick(keys), pick(keys), rand(3) > 0);
      continue;
    }
    if (!docs.length) continue;
    const d = pick(docs);
    const s = await state(d);
    // As situações próprias pesam mais: o caminho das regras configuradas é o que importa.
    const own = custom[d.kind] ?? [];
    const targets = own.length && rand(5) < 2 ? own : [...BASES[d.kind], ...own, ...(rand(10) === 0 ? [randomUUID(), "x", null] : [])];
    let args = {
      p_user_id: rand(8) ? u.admin : pick([u.vendas, u.consulta, u.financeiro, u.estoque ?? u.consulta]), p_kind: d.kind, p_id: d.id,
      p_expected_version: rand(8) ? s.version : s.version - 1, p_command_id: randomUUID(), p_status: pick(targets), p_reason: pick([null, "ab", "Motivo da transição", "  Motivo  "]),
    };
    if (rand(10) === 0) args.p_kind = pick(Object.keys(BASES));
    if (rand(8) === 0 && commands.length) args = structuredClone(pick(commands));
    const r = await call(args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  const captured = (await f.db.query("select (select count(*)::int from erp_finance.commission_operation) ops, (select count(*)::int from erp_documents.item_cost_applied) costs, (select count(*)::int from erp_documents.occurrence) occurrences, (select count(*)::int from erp_documents.document_situation) situations")).rows[0];
  console.log(`erp_document_transition diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(captured)}; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 10, "poucas transições aceitas");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
