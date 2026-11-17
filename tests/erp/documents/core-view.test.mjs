// Núcleo da leitura do documento (documents/internal.ts) contra o oráculo: document_view, dto,
// effect_flags, proposal_version_json, situation_json, situation_adopted e
// document_situation_json, com pedidos, propostas em versões, situações próprias, nomes de
// vendedor, categoria, transportadora, lista de preço, formas e contas das parcelas.
// Os documentos nascem pelo erp_document_save, que ainda roda só no Postgres e é espelhado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  documentDto,
  documentSituationJson,
  documentView,
  effectFlags,
  proposalVersionJson,
  situationAdopted,
  situationJson,
  situationKeyValid,
} from "../../../src/erp/domains/documents/internal.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const lite = (fn) => {
  try {
    return { ok: inTransaction(f.driver, (ctx) => fn(ctx)) };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};
const pg = async (sql, args) => {
  try {
    return { ok: (await f.db.query(sql, args)).rows[0].v };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};
const sql = async (text, args = []) => {
  const r = await f.db.query(text, args);
  await f.sync();
  return r;
};

test("núcleo da leitura do documento: mesmo JSON que o Postgres", async () => {
  const u = f.users;
  const contact = await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente núcleo" });
  const carrier = await f.catalog("contacts", { roles: ["carrier"], name: "Transportadora núcleo" }).catch(() => f.catalog("contacts", { name: "Transportadora núcleo" }));
  const sellerContact = await f.catalog("contacts", { name: "Vendedora núcleo" });
  const seller = (await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: sellerContact.id })).seller.id;
  const category = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas núcleo" } })).record;
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa núcleo", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const method = (await sql(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,account_id,created_by,updated_by) values('Pix núcleo','17','contas','ambos','aliquota',$1,$2,$2) returning id`, [account.id, u.admin])).rows[0].id;
  const save = async (kind, body) =>
    (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: "2026-10-10", contact_id: contact.id, ...body } })).document;
  const item = { description: "Item núcleo", unit: "UN", quantity: "2", unit_price: "10.5", discount_percent: "0" };
  const docs = [];
  docs.push(await save("sales_orders", { items: [item], seller_id: seller, category_id: category.id, carrier_id: carrier.id, payment_account_id: account.id,
    installments: [{ due_date: "2026-11-10", amount: "11.00", payment_method_id: method, details: { account_id: account.id, payment_type: null, card_brand: null, integration_type: null, acquirer_cnpj: null, authorization_code: null, received_amount: null, fee_amount: null, commission_fee_amount: null } }, { due_date: "2026-12-10", amount: "10.00" }] }));
  docs.push(await save("sales_orders", { items: [item, { ...item, quantity: "1" }], installments: [] }));
  docs.push(await save("purchase_orders", { items: [item], installments: [] }));
  docs.push(await save("service_orders", { items: [item] }).catch(() => null));
  const base = await save("sales_proposals", { items: [item], notes: "Primeira" });
  docs.push(base);
  let last = base;
  for (const notes of ["Segunda", "Terceira"]) {
    const fresh = (await f.db.query("select version from erp_documents.document where id=$1", [base.id])).rows[0];
    const r = await f.rpc("erp_document_proposal_version", { p_user_id: u.admin, p_id: last.id, p_expected_version: last.id === base.id ? fresh.version : last.version, p_command_id: randomUUID(), p_body: { date: "2026-10-10", contact_id: contact.id, items: [item], notes } }).catch((e) => e);
    if (r instanceof Error) break;
    last = r.document;
    docs.push(last);
  }
  docs.push(await save("sales_proposals", { items: [item] }));
  // Situação própria num pedido, e uma que não é do tipo.
  const situation = (await f.rpc("erp_preferences_situation_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "sales_orders", p_situation: null, p_expected_version: 0, p_data: { active: true, base_status: "open", color: "#ff8800", name: "Aguardando PIX" } })).receipt.target;
  const order = docs[0];
  const status = (await f.db.query("select status from erp_documents.document where id=$1", [order.id])).rows[0].status;
  await sql("insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id) values($1,'sales_orders',$2,$3,$4,$5)", [order.id, situation, status, u.admin, randomUUID()]);
  const ids = [...docs.filter(Boolean).map((d) => d.id), randomUUID()];
  for (const id of ids) {
    assert.deepEqual(lite((ctx) => documentView(ctx, id)), await pg("select erp_documents.document_view($1) v", [id]), `document_view ${id}`);
    assert.deepEqual(lite((ctx) => documentDto(ctx, id)), await pg("select erp_documents.dto($1) v", [id]), `dto ${id}`);
    assert.deepEqual(lite((ctx) => effectFlags(ctx, id)), await pg("select erp_documents.effect_flags($1) v", [id]), `effect_flags ${id}`);
    assert.deepEqual(lite((ctx) => proposalVersionJson(ctx.db, id)), await pg("select erp_documents.proposal_version_json($1) v", [id]), `proposal_version_json ${id}`);
    assert.deepEqual(lite((ctx) => documentSituationJson(ctx.db, id)), await pg("select erp_documents.document_situation_json($1) v", [id]), `document_situation_json ${id}`);
  }
  // O caso não é trivial: versões, nomes e a situação própria aparecem de fato.
  assert.equal((await pg("select erp_documents.proposal_version_json($1) v", [base.id])).ok?.versions, 3, "proposta em três versões");
  const view = (await pg("select erp_documents.document_view($1) v", [order.id])).ok;
  assert.deepEqual([view.seller_name, view.category_name, view.carrier_name, view.situation.key, Object.keys(view.payment_method_names), Object.keys(view.payment_account_names)],
    ["Vendedora núcleo", "Vendas núcleo", "Transportadora núcleo", situation, [method], [account.id]]);
  for (const kind of ["sales_orders", "purchase_orders", "service_orders", "sales_proposals", "x", null])
    for (const st of ["open", "draft", "waiting_parts", "nao_existe_status", null])
      for (const sit of [null, situation, randomUUID()]) {
        assert.deepEqual(lite((ctx) => situationJson(ctx.db, kind, st, sit)), await pg("select erp_documents.situation_json($1,$2,$3) v", [kind, st, sit]), `situation_json ${kind} ${st} ${sit}`);
        assert.deepEqual(lite((ctx) => situationAdopted(ctx.db, kind)), await pg("select erp_documents.situation_adopted($1) v", [kind]), `situation_adopted ${kind}`);
      }
  for (const kind of ["sales_orders", "purchase_orders", "service_orders", "sales_proposals", "x", null])
    for (const key of ["open", "draft", "checkout_partial", "completed", "nao_existe", situation, situation.toUpperCase(), randomUUID(), "", null])
      assert.deepEqual(lite((ctx) => situationKeyValid(ctx.db, kind, key)), await pg("select erp_documents.situation_key_valid($1,$2) v", [kind, key]), `situation_key_valid ${kind} ${key}`);
  // Sem adoção, nenhuma situação.
  await sql("delete from erp_preferences.situation_adoption where kind='purchase_orders'");
  for (const id of ids) assert.deepEqual(lite((ctx) => documentView(ctx, id)), await pg("select erp_documents.document_view($1) v", [id]), `document_view sem adoção ${id}`);
});
