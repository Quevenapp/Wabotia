// Diferencial aleatório dos escritores do resto do B3, misturados com o save e o transition:
// erp_document_proposal_version, _notes_save, _trash (excluir e restaurar), erp_proposal_convert,
// _convert_to_service, erp_sales_order_convert_to_service, erp_document_copy,
// erp_document_checkout_save e erp_document_occurrence_add. Uma coisa estragada por chamada
// (versão velha, id desconhecido, campo inválido, usuário sem permissão) e repetições de comando.
//   node --test tests/erp/documents/b3-writers-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import "../../../src/erp/domains/index.ts";

let f;
const RPCS = ["erp_document_proposal_version", "erp_document_notes_save", "erp_document_trash", "erp_proposal_convert", "erp_proposal_convert_to_service",
  "erp_sales_order_convert_to_service", "erp_document_copy", "erp_document_checkout_save", "erp_document_occurrence_add"];
const ready = RPCS.every((r) => isPorted(r));
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("escritores do B3: mesmas respostas, erros e estado em sequência aleatória", { timeout: 1_800_000, skip: ready ? false : "não registrados" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261119) >>> 0;
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente B3" })).id;
  const product = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Peça B3", code: "P-B3", unit: "UN", kind: "P", format: "S", price: "15" } })).record.id;
  const body = () => ({ date: "2026-10-10", contact_id: contact, items: [{ product_id: rand(3) ? product : undefined, description: "Item B3", unit: "UN", quantity: String(1 + rand(3)), unit_price: pick(["15", "7.5"]), discount_percent: "0" }].map((i) => (i.product_id ? i : (({ product_id: _p, ...r }) => r)(i))), installments: [] });
  const KINDS = ["sales_orders", "sales_orders", "sales_proposals", "service_orders", "purchase_orders"];
  const docs = async (kind) => (await f.db.query("select id, kind, version, status, deleted_at from erp_documents.document where ($1::text is null or kind=$1) order by created_at, id", [kind ?? null])).rows;
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : name;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError || /divergem/.test(e.message)) {
        console.log(`divergência em ${name}: ${JSON.stringify(args).slice(0, 1500)}`);
        throw e;
      }
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  for (let i = 0; i < 6; i++)
    await call("erp_document_save", { p_user_id: u.admin, p_kind: pick(KINDS), p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body() });
  const N = Number(process.env.ERP_DIFF_N || 200);
  for (let i = 0; i < N; i++) {
    const roll = rand(24);
    const user = rand(8) ? u.admin : pick([u.vendas, u.consulta, u.financeiro]);
    const stale = rand(8) === 0;
    let name, args;
    if (roll < 3) {
      name = "erp_document_save";
      args = { p_user_id: u.admin, p_kind: pick(KINDS), p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body() };
    } else if (roll < 5) {
      const d = pick(await docs());
      if (!d) continue;
      const targets = { sales_orders: ["open", "verified", "cancelled"], sales_proposals: ["open", "approved", "cancelled", "draft"], service_orders: ["approved", "in_progress", "cancelled", "open"], purchase_orders: ["in_progress", "cancelled", "open"] }[d.kind];
      name = "erp_document_transition";
      args = { p_user_id: u.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: pick(targets), p_reason: "Motivo B3" };
    } else if (roll < 7) {
      const d = pick(await docs("sales_proposals"));
      if (!d) continue;
      name = "erp_document_proposal_version";
      args = { p_user_id: user, p_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID(), p_body: rand(6) ? body() : { ...body(), number: "5" } };
    } else if (roll < 9) {
      const d = pick((await docs()).filter((x) => x.kind !== "sales_proposals"));
      if (!d) continue;
      name = "erp_document_notes_save";
      args = { p_user_id: user, p_kind: rand(10) ? d.kind : "sales_proposals", p_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID(), p_notes: pick([null, "Nota B3", "  Nota  ", "x".repeat(4001)]), p_internal_notes: pick([null, "Interna B3"]) };
    } else if (roll < 11) {
      const kind = pick(KINDS);
      const list = (await docs(kind)).slice(0, 1 + rand(3));
      name = "erp_document_trash";
      args = { p_user_id: user, p_kind: kind, p_action: pick(["delete", "delete", "restore"]), p_command_id: randomUUID(), p_ids: rand(10) ? list.map((d) => d.id) : [randomUUID(), "x"], p_reason: pick(["Exclusão B3", "ab", null]) };
    } else if (roll < 14) {
      const d = pick(await docs("sales_proposals"));
      if (!d) continue;
      name = pick(["erp_proposal_convert", "erp_proposal_convert_to_service"]);
      args = { p_user_id: user, p_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID() };
    } else if (roll < 15) {
      const d = pick(await docs("sales_orders"));
      if (!d) continue;
      name = "erp_sales_order_convert_to_service";
      args = { p_user_id: user, p_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID() };
    } else if (roll < 17) {
      const d = pick(await docs());
      if (!d) continue;
      name = "erp_document_copy";
      args = { p_user_id: user, p_kind: d.kind, p_source_id: d.id, p_expected_source_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID(), p_body: body() };
    } else if (roll < 20) {
      const d = pick((await docs("sales_orders")).filter((x) => ["open", "checkout_partial"].includes(x.status)));
      if (!d) continue;
      const view = await f.rpc("erp_document_checkout_get", { p_user_id: u.admin, p_id: d.id }).catch(() => null);
      if (!view) continue;
      const lines = view.lines ?? view.checkout?.lines ?? [];
      const reads = lines.filter(() => rand(3)).map((l) => ({ key: l.key, quantity: pick([l.quantity, "1", "0", "0.5", "999"]) }));
      name = "erp_document_checkout_save";
      args = { p_user_id: user, p_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_checkout_version: Number(view.checkout_version ?? view.version ?? 0), p_command_id: randomUUID(), p_reads: rand(10) ? reads : [{ key: "x", quantity: "1" }] };
    } else {
      const d = pick(await docs());
      if (!d) continue;
      name = "erp_document_occurrence_add";
      args = {
        p_user_id: user, p_kind: d.kind, p_document_id: d.id, p_expected_version: stale ? d.version + 1 : d.version, p_command_id: randomUUID(),
        p_occurred_on: pick(["2026-10-10", "2026-02-30", "2099-01-01"]), p_occurred_time: pick(["10:15", "25:00", "08:00"]), p_text: pick([null, "Contato B3", "  "]),
        p_status: rand(3) ? null : pick(["open", "cancelled", "approved", randomUUID()]), p_next_contact: d.kind === "sales_proposals" && rand(2) ? "2026-12-01" : null,
      };
    }
    if (rand(10) === 0 && commands.length) ({ name, args } = structuredClone(pick(commands)));
    const r = await call(name, args);
    if (r && !r.replayed) commands.push(structuredClone({ name, args }));
  }
  console.log(`B3 diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  for (const rpc of ["erp_document_notes_save", "erp_document_trash", "erp_document_copy", "erp_document_occurrence_add"])
    assert.ok((outcomes[rpc] ?? 0) > 0, `${rpc} aceito ao menos uma vez`);
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
