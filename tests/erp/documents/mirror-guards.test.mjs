// O documento espelhado do Origin nas escritas e leituras nativas, nos dois motores:
// erp_document_mirror.require_visible e os gatilhos aa_mirror_authority (guard_document,
// guard_item, guard_effect). Os documentos espelhados são semeados no oráculo como a
// sincronização faria (erp_sync.applying ligado na transação) e espelhados no motor.
// Casos: documento com authority 'origin' (só leitura) e com origin 'origin' e authority
// 'brufap' (assumido), proposta espelhada como origem de conversão, e salvar, mudar situação,
// lançar e estornar contas, faturamento agrupado e as leituras de contas, cada um comparado.
// Fora: get/list/export do documento com authority 'origin' (erp_document_mirror.detail, 0A000
// declarado no motor).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

test("documento espelhado: as guardas do espelho nos dois motores", async () => {
  const u = f.users;
  const contact = (await f.catalog("contacts", { roles: ["customer"], name: "Cliente espelho" })).id;
  const snapshot = (await f.db.query("select erp_catalog.dto($1) v", [contact])).rows[0].v;
  const mirrored = async (kind, authority, status) => {
    await f.db.query("begin");
    await f.db.query("select set_config('erp_sync.applying','on',true)");
    const id = (await f.db.query(
      `insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,origin,authority,created_by,updated_by)
       values($1,(select coalesce(max(number),0)+100 from erp_documents.document where kind=$1),$2,$3,$4::jsonb,$5::jsonb,10,'origin',$6,$7,$7) returning id`,
      [kind, status, contact, JSON.stringify(snapshot), JSON.stringify({ date: "2026-10-10", contact_id: contact, totals: { total: "10.00" }, installments: [] }), authority, u.admin],
    )).rows[0].id;
    await f.db.query("commit");
    await f.sync();
    return id;
  };
  const readOnly = await mirrored("sales_orders", "origin", "verified");
  const takenOver = await mirrored("sales_orders", "brufap", "open");
  const proposal = await mirrored("sales_proposals", "origin", "approved");
  const outcomes = [];
  const both = async (label, name, args) => {
    try {
      const r = await f.rpc(name, args);
      outcomes.push(`${label}: ok`);
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError || /divergem/.test(e.message)) throw e;
      outcomes.push(`${label}: ${e.code}:${e.message}`);
      return null;
    }
  };
  const version = async (id) => (await f.db.query("select version from erp_documents.document where id=$1", [id])).rows[0].version;
  const body = { date: "2026-10-10", contact_id: contact, items: [{ description: "Item espelho", unit: "UN", quantity: "1", unit_price: "10", discount_percent: "0" }], installments: [] };
  for (const [doc, tag] of [[readOnly, "authority origin"], [takenOver, "assumido"]]) {
    await both(`save ${tag}`, "erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: doc, p_expected_version: await version(doc), p_command_id: randomUUID(), p_body: body });
    await both(`transition ${tag}`, "erp_document_transition", { p_user_id: u.admin, p_kind: "sales_orders", p_id: doc, p_expected_version: await version(doc), p_command_id: randomUUID(), p_status: "cancelled", p_reason: "Teste espelho" });
    const scope = { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: doc, p_expected_version: await version(doc) };
    await both(`finance preview ${tag}`, "erp_document_finance_preview", { ...scope, p_plan: [{ amount_cents: "1000", due_on: "2026-11-10", method: null }] });
    await both(`finance post ${tag}`, "erp_document_finance_post", { ...scope, p_command_id: randomUUID(), p_preview_hash: "a".repeat(64), p_plan: [{ amount_cents: "1000", due_on: "2026-11-10", method: null }] });
    await both(`finance reverse ${tag}`, "erp_document_finance_reverse", { ...scope, p_posting_id: randomUUID(), p_posting_version: 1, p_command_id: randomUUID(), p_preview_hash: "a".repeat(64), p_title_versions: [], p_reason: "Teste" });
    await both(`finance list ${tag}`, "erp_document_finance_list", { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: doc, p_limit: 10 });
    await both(`finance get ${tag}`, "erp_document_finance_get", { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: doc, p_posting_id: randomUUID() });
    await both(`grouped billing ${tag}`, "erp_finance_grouped_billing_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "grouped_billing_generate",
      p_data: { items: [{ contact_id: contact, document_ids: [doc], total_cents: "1000", condition: "30", days: [30] }] } });
  }
  // Pedido novo a partir da proposta espelhada: o guard_document recusa a origem espelhada.
  await both("save from mirrored proposal", "erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { ...body, source_proposal: { id: proposal, expected_version: await version(proposal) } } });
  console.log(outcomes.join("\n"));
  assert.ok(outcomes.some((o) => o.includes("erp_document_mirror_readonly")), "o documento espelhado é só leitura");
  assert.ok(outcomes.some((o) => o.includes("erp_document_mirror_effect_forbidden")), "a origem espelhada é recusada");
});
