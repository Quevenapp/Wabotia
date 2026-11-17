// Diferencial aleatório do erp_document_save: criar e editar proposta, pedido de venda e de compra
// e OS nos dois motores, com itens com e sem produto, parcelas com forma e conta, vendedor com
// limite de desconto, categoria, transportadora, número livre, troca de contato, conversão de
// proposta, Preferências ligadas e desligadas, usuários sem permissão, versões velhas, uma
// estragada por chamada (ERP-PORTE.md) e repetições de comando. Pedidos confirmados pelo
// erp_document_transition (só no Postgres, espelhado) fazem o save disparar os adiados de
// comissão e custo nos dois motores.
// Fora: o lançamento automático de contas (B5), com as preferências vendas.contas_automaticas_pedido
// e compras.automacao_contas_pagar desligadas.
//   node --test tests/erp/documents/save-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import "../../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_document_save");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_document_save: mesmas respostas, erros e estado em sequência aleatória", { timeout: 1_800_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261117) >>> 0;
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
  const pref = async (page, key, value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: page })).items.find((i) => i.key === key);
    if (!current || JSON.stringify(current.value) === JSON.stringify(value)) return;
    await f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value }]) }).catch(() => null);
  };
  const contacts = [];
  for (const name of ["Cliente save A", "Cliente save B"]) contacts.push((await f.catalog("contacts", { roles: ["customer", "supplier"], name })).id);
  const carrier = (await f.catalog("contacts", { name: "Transportadora save" })).id;
  const sellers = [];
  for (const name of ["Vendedora save", "Vendedor save limite"]) {
    const c = await f.catalog("contacts", { name });
    sellers.push((await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: c.id })).seller.id);
  }
  await sql("update erp_catalog.seller set commission_rule='parcial',commission_mode='fixa',commission_rate=5 where id=$1", [sellers[0]]);
  await sql("update erp_catalog.seller set user_id=$2,discount_limit=5,allow_unregistered_products=false where id=$1", [sellers[1], u.vendas]);
  const products = [];
  for (const [name, price] of [["Peça save 1", "50"], ["Peça save 2", "12.5"]])
    products.push((await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name, code: name, unit: "UN", kind: "P", format: "S", price } })).record.id);
  const receita = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Receita save" } })).record.id;
  const despesa = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "payable", name: "Despesa save" } })).record.id;
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa save", start_on: "2020-01-01", opening_cents: "0" } })).record.id;
  const method = (await sql(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,account_id,created_by,updated_by) values('Pix save','17','contas','ambos','aliquota',$1,$2,$2) returning id`, [account, u.admin])).rows[0].id;

  const KINDS = ["sales_orders", "sales_orders", "sales_proposals", "purchase_orders", "service_orders"];
  const item = (kind) => {
    const it = { description: pick(["Item save", "Serviço save"]), unit: "UN", quantity: pick(["1", "2", "0.5", "3"]), unit_price: pick(["10", "33.33", "0.07", "100"]), discount_percent: pick(["0", "0", "2.5", "10"]) };
    if (rand(3)) it.product_id = pick(products);
    return it;
  };
  const body = (kind, contact) => {
    const b = { date: pick(["2026-10-10", "2026-11-01"]), contact_id: contact, items: Array.from({ length: 1 + rand(3) }, () => item(kind)), installments: [] };
    if (kind !== "purchase_orders" && rand(2)) b.seller_id = pick(sellers);
    if (kind !== "sales_proposals" && rand(3) === 0) b.category_id = kind === "purchase_orders" ? despesa : receita;
    if (rand(4) === 0) b.carrier_id = carrier;
    if (rand(3) === 0) b.notes = pick(["Observação save", "  ", null]);
    if (rand(4) === 0) b.installments = [{ due_date: "2026-12-10", amount: "1.00", payment_method_id: method }];
    return b;
  };
  const docs = async () => (await f.db.query("select id,kind,version,status from erp_documents.document where deleted_at is null order by created_at,id")).rows;

  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${name}:${args.p_kind}`;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError || /divergem/.test(e.message)) {
        console.log(`divergência em ${name}: ${JSON.stringify(args).slice(0, 2000)}`);
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
      const which = rand(6);
      if (which === 0) await pref("vendas-vendas", "vendas.produtos_nao_cadastrados", rand(2) === 0);
      else if (which === 1) await pref("vendas-vendas", "vendas.vendedor_obrigatorio", rand(2) === 0);
      else if (which === 2) await pref("vendas-vendas", "vendas.editar_numero", rand(2) === 0);
      else if (which === 3) await pref("servicos-os", "os.itens_repetidos", rand(2) === 0);
      else if (which === 4) await pref("empresa-geral", "empresa.decimais_preco_saida", pick([2, 4, 10]));
      else await pref("vendas-propostas", "propostas.proximo_contato_obrigatorio", rand(2) === 0);
      continue;
    }
    if (roll === 1) {
      // Confirmar ou mudar a situação (só no Postgres): pedidos verificados disparam os adiados no save seguinte.
      const ds = (await docs()).filter((d) => ["sales_orders", "service_orders"].includes(d.kind) && ["open", "draft"].includes(d.status));
      if (!ds.length) continue;
      const d = pick(ds);
      const target = d.kind === "sales_orders" ? (d.status === "draft" ? "open" : "verified") : "approved";
      await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: target, p_reason: "Teste" }).catch(() => null);
      continue;
    }
    const user = rand(8) ? u.admin : pick([u.vendas, u.consulta, u.financeiro]);
    let args;
    if (roll < 11) {
      const kind = pick(KINDS);
      const b = body(kind, pick(contacts));
      args = { p_user_id: user, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: b };
      if (rand(6) === 0) b.number = String(1 + rand(30));
      if (rand(8) === 0 && kind !== "purchase_orders") {
        const props = (await docs()).filter((d) => d.kind === "sales_proposals");
        if (props.length && ["sales_orders", "service_orders"].includes(kind)) {
          const p = pick(props);
          b.source_proposal = { id: p.id, expected_version: rand(5) ? p.version : p.version + 1 };
        }
      }
    } else {
      const ds = await docs();
      if (!ds.length) continue;
      const d = pick(ds);
      const b = body(d.kind, pick(contacts));
      if (rand(3) === 0) b.refresh_contact = true;
      if (rand(6) === 0) b.number = String(1 + rand(30));
      // A edição manda os campos que o documento já tem (require_commercial_input e as extensões).
      const current = (await f.db.query("select erp_documents.dto($1) v", [d.id])).rows[0].v;
      for (const k of Object.keys(current)) if (!(k in b) && !["id", "kind", "number", "status", "version", "effect_flags", "contact_snapshot", "source_proposal_id", "created_at", "updated_at", "items", "origin", "authority", "readonly", "totals"].includes(k)) b[k] = current[k];
      args = { p_user_id: user, p_kind: d.kind, p_id: d.id, p_expected_version: rand(6) ? d.version : d.version - 1, p_command_id: randomUUID(), p_body: b };
    }
    if (rand(5) === 0) {
      // Uma coisa estragada por chamada.
      const b = args.p_body;
      const [k, v] = pick([
        ["contact_id", randomUUID()], ["contact_id", "x"], ["seller_id", randomUUID()], ["category_id", randomUUID()], ["carrier_id", randomUUID()], ["date", "2026-02-30"],
        ["items", [{ ...item(args.p_kind), quantity: "-1" }]], ["items", [{ ...item(args.p_kind), product_id: randomUUID() }]], ["items", "x"], ["number", "0"], ["number", 5],
        ["installments", [{ due_date: "2026-12-10", amount: "1.00", payment_method_id: randomUUID() }]], ["refresh_contact", false], ["source_proposal", { id: randomUUID(), expected_version: 1 }], ["extra_field", 1],
      ]);
      b[k] = v;
    }
    if (rand(10) === 0) args.p_body = pick([null, [], "x"]);
    if (rand(8) === 0 && commands.length) args = structuredClone(pick(commands));
    const r = await call("erp_document_save", args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  const captured = (await f.db.query("select (select count(*)::int from erp_finance.commission_operation) ops, (select count(*)::int from erp_documents.item_cost_applied) costs, (select count(*)::int from erp_documents.document) docs")).rows[0];
  console.log(`erp_document_save diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(captured)}; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 4, "poucas gravações aceitas");
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
