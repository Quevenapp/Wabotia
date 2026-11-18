// Diferencial aleatório do B1: os escritores pequenos do Documentos (campos customizados da OS,
// aprovação do desconto, lista, numeração, ocorrência removida, cabeçalho de impressão,
// assinatura) e a prévia da cópia, misturados com save e occurrence_add. Uma coisa estragada por
// chamada (versão velha, id desconhecido, campo inválido, usuário sem permissão) e repetições.
//   node --test tests/erp/documents/b1-writers-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import "../../../src/erp/domains/index.ts";

let f;
const RPCS = ["erp_document_custom_field_save", "erp_document_custom_field_delete", "erp_document_discount_approval_save", "erp_document_list_view_save",
  "erp_document_numbering_set", "erp_document_occurrence_remove", "erp_document_print_header_save", "erp_document_signature_save", "erp_document_copy_preview"];
const ready = RPCS.every((r) => isPorted(r));
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("escritores do B1: mesmas respostas, erros e estado em sequência aleatória", { timeout: 1_800_000, skip: ready ? false : "não registrados" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261121) >>> 0;
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Cliente B1" })).id;
  const product = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Peça B1", code: "P-B1", unit: "UN", kind: "P", format: "S", price: "15" } })).record.id;
  const situations = [];
  for (const [base, name] of [["draft", "Aguardando desconto"], ["draft", "Desconto em análise"], ["open", "Aguardando PIX"]])
    situations.push((await f.rpc("erp_preferences_situation_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "sales_orders", p_situation: null, p_expected_version: 0, p_data: { active: true, base_status: base, color: "#ff8800", name } })).receipt.target);
  const fields = async () => (await f.db.query("select id, version, field_type, options from erp_documents.custom_field order by created_at, id")).rows;
  const docs = async (kind) => (await f.db.query("select id, kind, version, body from erp_documents.document where ($1::text is null or kind=$1) order by created_at, id", [kind ?? null])).rows;
  const customValues = async () => {
    const out = {};
    for (const fl of await fields()) {
      if (rand(2)) continue;
      out[fl.id] = { integer: "12", decimal: "1.5", list: fl.options[0]?.id ?? "x", text: "Texto B1", long_text: "Longo B1", boolean: true, date: "2026-10-10" }[fl.field_type];
    }
    return out;
  };
  const body = async (kind) => ({
    date: "2026-10-10", contact_id: contact, notes: pick([null, "Nota B1"]),
    items: [{ product_id: rand(3) ? product : undefined, description: "Item B1", unit: "UN", quantity: String(1 + rand(3)), unit_price: pick(["15", "7.5"]), discount_percent: "0" }].map((i) => (i.product_id ? i : (({ product_id: _p, ...r }) => r)(i))),
    installments: [], ...(kind === "service_orders" && rand(2) ? { custom_fields: await customValues() } : {}),
  });
  const run = (text, extra = {}) => ({ text, bold: false, italic: false, underline: false, color: null, background: null, size: null, ...extra });
  const rich = () => pick([null, { version: 1, blocks: [{ align: "center", indent: 0, code: false, runs: [run("Empresa B1", { bold: true })] }] }, { version: 2, blocks: [] }]);
  const KINDS = ["sales_orders", "sales_proposals", "service_orders", "purchase_orders"];
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
  const fieldData = (type, current) => ({
    field_type: type, name: pick(["Garantia", "Placa", "Setor", "garantia", "  Cor  ", ""]), hint: pick([null, "Dica"]), info: pick([null, "Info\nlonga"]),
    required: rand(2) === 0, min_length: ["integer", "text"].includes(type) && rand(3) === 0 ? 2 : null, max_length: ["integer", "text"].includes(type) && rand(3) === 0 ? pick([1, 10]) : null,
    width: pick(["small", "medium", "large", "huge"]), active: rand(5) !== 0,
    options: type === "list" ? [...(current?.options ?? []).filter(() => rand(4)), ...(rand(2) ? [{ id: null, label: pick(["Sim", "Não", "Talvez", "sim"]) }] : [])].concat(current ? [] : [{ id: null, label: "Opção A" }]) : pick([[], [], [{ id: null, label: "x" }]]),
  });
  for (let i = 0; i < 4; i++) {
    const kind = pick(KINDS);
    await call("erp_document_save", { p_user_id: u.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: await body(kind) });
  }
  const N = Number(process.env.ERP_DIFF_N || 200);
  for (let i = 0; i < N; i++) {
    const roll = rand(26);
    const user = rand(7) ? u.admin : pick([u.vendas, u.consulta, u.financeiro, u.estoque].filter(Boolean));
    const stale = rand(8) === 0;
    let name, args;
    if (roll < 3) {
      const kind = pick(KINDS);
      name = "erp_document_save";
      args = { p_user_id: u.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: await body(kind) };
    } else if (roll < 7) {
      const list = await fields();
      const current = rand(3) && list.length ? pick(list) : null;
      const type = current ? current.field_type : pick(["integer", "decimal", "list", "text", "long_text", "boolean", "date", "color"]);
      name = "erp_document_custom_field_save";
      const data = fieldData(type, current);
      args = {
        p_user_id: user, p_kind: rand(12) ? "service_orders" : "sales_orders", p_id: current?.id ?? null, p_expected_version: current ? (stale ? current.version + 1 : current.version) : 0,
        p_command_id: randomUUID(), p_data: rand(15) ? data : { ...data, extra: 1 },
      };
    } else if (roll < 8) {
      const fl = pick(await fields());
      if (!fl) continue;
      name = "erp_document_custom_field_delete";
      args = { p_user_id: user, p_kind: "service_orders", p_id: rand(10) ? fl.id : randomUUID(), p_expected_version: stale ? fl.version + 1 : fl.version, p_command_id: randomUUID() };
    } else if (roll < 10) {
      const v = (await f.db.query("select version from erp_documents.discount_approval")).rows[0]?.version ?? 0;
      name = "erp_document_discount_approval_save";
      args = { p_user_id: user, p_command_id: randomUUID(), p_expected_version: stale ? v + 1 : v, p_situations: pick([[], [situations[0]], [situations[1], situations[0]], [situations[2]], [situations[0], situations[0]], ["x"], [randomUUID()]]) };
    } else if (roll < 13) {
      const kind = pick(["sales_orders", "sales_orders", "sales_proposals", "service_orders", "purchase_orders"]);
      const v = (await f.db.query("select version from erp_documents.list_view where user_id=$1 and kind=$2", [user, kind])).rows[0]?.version ?? 0;
      const custom = kind === "sales_orders" ? rand(3) !== 0 : rand(8) === 0;
      name = "erp_document_list_view_save";
      args = {
        p_user_id: user, p_kind: kind, p_expected_version: stale ? v + 1 : v, p_command_id: randomUUID(), p_custom_view: custom,
        p_columns: kind === "sales_orders" && custom ? pick([["date", "contact"], ["total", "carrier_name", "date"], ["date", "date"], ["bogus"], []]) : pick([[], [], ["date"]]),
        p_default_statuses: pick([[], ["open"], ["draft", "open"], [situations[0]], [situations[2], "cancelled"], ["nope"]]),
      };
    } else if (roll < 15) {
      const kind = pick(KINDS);
      const n = (await f.db.query("select last_number from erp_documents.numbering where kind=$1", [kind])).rows[0]?.last_number;
      const last = n === undefined ? 1 : Number(n);
      name = "erp_document_numbering_set";
      args = { p_user_id: user, p_kind: kind, p_command_id: randomUUID(), p_expected_next_number: String(stale ? last + 2 : last + 1), p_next_number: pick([String(last + 1), String(last + 5 + rand(20)), "1", "0", "abc"]) };
    } else if (roll < 18) {
      const d = pick(await docs());
      if (!d) continue;
      name = "erp_document_occurrence_add";
      args = { p_user_id: u.admin, p_kind: d.kind, p_document_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_occurred_on: "2026-10-10", p_occurred_time: "10:15", p_text: "Contato B1", p_status: null, p_next_contact: null };
    } else if (roll < 20) {
      const o = pick((await f.db.query("select o.id, o.document_id, d.kind from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id order by o.document_id, o.sequence")).rows);
      if (!o) continue;
      name = "erp_document_occurrence_remove";
      args = { p_user_id: user, p_kind: rand(10) ? o.kind : "sales_proposals", p_document_id: o.document_id, p_occurrence_id: rand(10) ? o.id : randomUUID(), p_command_id: randomUUID() };
    } else if (roll < 22) {
      const kind = pick(KINDS);
      const v = (await f.db.query("select version from erp_documents.print_header where kind=$1", [kind])).rows[0]?.version ?? 0;
      name = "erp_document_print_header_save";
      args = { p_user_id: user, p_kind: kind, p_command_id: randomUUID(), p_expected_version: stale ? v + 1 : v, p_content: rich() };
    } else if (roll < 24) {
      const v = (await f.db.query("select version from erp_documents.user_signature where user_id=$1", [user])).rows[0]?.version ?? 0;
      name = "erp_document_signature_save";
      args = { p_user_id: user, p_command_id: randomUUID(), p_expected_version: stale ? v + 1 : v, p_greeting: pick([null, "Atenciosamente", "  ", "x".repeat(201)]), p_department: pick([null, "Vendas"]) };
    } else {
      const d = pick(await docs());
      if (!d) continue;
      name = "erp_document_copy_preview";
      args = { p_user_id: user, p_kind: rand(10) ? d.kind : pick(KINDS), p_source_id: rand(12) ? d.id : randomUUID() };
    }
    if (rand(10) === 0 && commands.length) ({ name, args } = structuredClone(pick(commands)));
    const r = await call(name, args);
    if (r && !r.replayed && args.p_command_id) commands.push(structuredClone({ name, args }));
  }
  console.log(`B1 diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  for (const rpc of ["erp_document_custom_field_save", "erp_document_list_view_save", "erp_document_numbering_set", "erp_document_occurrence_remove", "erp_document_print_header_save", "erp_document_signature_save", "erp_document_copy_preview"])
    assert.ok((outcomes[rpc] ?? 0) > 0, `${rpc} aceito ao menos uma vez`);
  assert.ok(refused > N / 20, "poucas recusas exercitadas");
});
