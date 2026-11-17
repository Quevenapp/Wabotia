// erp_finance.titles_mark_returned e o gatilho commission_return_capture (finance/title-returns.ts)
// contra o oráculo: chamada direta nos dois motores numa transação desfeita, comparando o
// resultado (ou o erro) e as linhas de title, title_return e commission_adjustment.
// Cenários: entradas inválidas uma a uma, conta aberta, cancelada, baixada, já devolvida por
// outro comando e pelo mesmo (repetição), inexistente, e a conta de pedido de venda com operação
// de comissão (o ajuste de devolução). O lançamento do pedido (erp_document_finance_post) roda só
// no Postgres e é espelhado até o B5.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { rowJson } from "../../src/erp/engine/row-json.ts";
import { titlesMarkReturned } from "../../src/erp/domains/finance/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const VOLATILE = ["created_at", "updated_at", "id"];
const clean = (rows, keep = []) =>
  rows
    .map((r) => {
      const o = { ...r };
      for (const k of VOLATILE) if (!keep.includes(k)) delete o[k];
      return o;
    })
    .sort((a, b) => (JSON.stringify(a.title_id ?? a.source_key ?? a.id) < JSON.stringify(b.title_id ?? b.source_key ?? b.id) ? -1 : 1));
const cleanResult = (r) => (r && r.items ? { ...r, items: r.items.map((i) => (i ? clean([i], ["id"])[0] : i)) } : r);

async function compare(args, titles, label) {
  const [actor, command, list, source] = args;
  await f.db.query("begin");
  let pg;
  try {
    const r = (await f.db.query("select erp_finance.titles_mark_returned($1,$2,$3::uuid[],$4::jsonb) v", [actor, command, list, source === undefined ? null : JSON.stringify(source)])).rows[0].v;
    pg = {
      r: cleanResult(r),
      titles: clean((await f.db.query("select to_jsonb(t) j from erp_finance.title t where id=any($1::uuid[])", [titles])).rows.map((x) => x.j), ["id"]),
      returns: clean((await f.db.query("select to_jsonb(r) j from erp_finance.title_return r where title_id=any($1::uuid[])", [titles])).rows.map((x) => x.j)),
      adj: clean((await f.db.query("select to_jsonb(a) - 'operation_id' j from erp_finance.commission_adjustment a")).rows.map((x) => x.j)),
    };
  } catch (e) {
    pg = { err: `${e.code}:${e.message}` };
  }
  await f.db.query("rollback");
  let lite, captured;
  try {
    inTransaction(f.driver, (ctx) => {
      const r = titlesMarkReturned(ctx, actor, command, list, source === undefined ? null : source);
      const q = (sql, ...p) => ctx.db.exec(sql, ...p).rows;
      const ids = JSON.stringify(titles);
      captured = {
        r: cleanResult(JSON.parse(JSON.stringify(r))),
        titles: clean(q(`SELECT * FROM "erp_finance__title" WHERE id IN (SELECT value FROM json_each(?))`, ids).map((x) => rowJson("erp_finance__title", x)), ["id"]),
        returns: clean(q(`SELECT * FROM "erp_finance__title_return" WHERE title_id IN (SELECT value FROM json_each(?))`, ids).map((x) => rowJson("erp_finance__title_return", x))),
        adj: clean(q('SELECT * FROM "erp_finance__commission_adjustment"').map((x) => {
          const j = rowJson("erp_finance__commission_adjustment", x);
          delete j.operation_id;
          return j;
        })),
      };
      throw new Error("rollback");
    });
  } catch (e) {
    lite = captured ?? { err: `${e.code}:${e.message}` };
  }
  assert.deepEqual(lite, pg, label);
  return pg;
}

test("titles_mark_returned: mesmo resultado e linhas que o Postgres", async () => {
  const u = f.users;
  const sql = async (text, args = []) => {
    const r = await f.db.query(text, args);
    await f.sync();
    return r;
  };
  const contact = (await f.catalog("contacts", { roles: ["customer"], name: "Cliente devolução" })).id;
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa devolução", start_on: "2020-01-01", opening_cents: "0" } })).record.id;
  const titleOf = async (description, cents) => {
    await f.rpc("erp_finance_title_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create", p_data: { kind: "receivable", contact_id: contact, description, issued_on: "2026-10-01", competence_on: "2026-10-01", total_cents: String(cents), installments: [{ amount_cents: String(cents), due_on: "2026-10-10" }] } });
    return (await f.db.query("select id, version from erp_finance.title where description=$1", [description])).rows[0];
  };
  const open = await titleOf("Devolução aberta", 1000);
  const settled = await titleOf("Devolução baixada", 500);
  await f.rpc("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "settle", p_data: { id: settled.id, expected_version: settled.version, account_id: account, posted_on: "2026-10-10", principal_cents: "100" } });
  const gone = await titleOf("Devolução cancelada", 700);
  await sql("update erp_finance.title set cancelled=true, version=version+1 where id=$1", [gone.id]);
  // Pedido de venda confirmado com vendedor (operação de comissão) e contas lançadas.
  const sellerContact = await f.catalog("contacts", { name: "Vendedora devolução" });
  const seller = (await f.rpc("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: sellerContact.id })).seller.id;
  await sql("update erp_catalog.seller set commission_rule='parcial',commission_mode='fixa',commission_rate=10 where id=$1", [seller]);
  let d = (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-10-10", contact_id: contact, seller_id: seller, items: [{ description: "Item devolução", unit: "UN", quantity: "3", unit_price: "33.33", discount_percent: "0" }], installments: [{ due_date: "2026-11-10", amount: "49.99" }, { due_date: "2026-12-10", amount: "50.00" }] } })).document;
  for (const status of d.status === "draft" ? ["open", "verified"] : ["verified"])
    d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: "sales_orders", p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: "Teste" })).document;
  const scope = { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: d.id, p_expected_version: d.version };
  await f.rpc("erp_document_finance_post", { ...scope, p_command_id: randomUUID(), p_preview_hash: (await f.rpc("erp_document_finance_preview", scope)).preview.preview_hash });
  const docTitles = (await f.db.query("select l.title_id id from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id where p.document_id=$1 order by l.position", [d.id])).rows.map((r) => r.id);
  assert.equal(docTitles.length, 2, "o pedido lançou duas contas");
  const all = [open.id, settled.id, gone.id, ...docTitles];
  const src = { kind: "pos_return", id: "dev-1", label: "Devolução PDV 1" };
  const cmd = randomUUID();
  for (const [args, label] of [
    [[u.financeiro, cmd, [open.id], { kind: "x", id: "a" }], "kind inválido"],
    [[u.financeiro, cmd, [open.id], { kind: "pos_return", id: "" }], "id vazio"],
    [[u.financeiro, cmd, [open.id], { kind: "pos_return", id: "a\u0001" }], "id com controle"],
    [[u.financeiro, cmd, [open.id], { kind: "pos_return", id: "a", label: 5 }], "label não texto"],
    [[u.financeiro, cmd, [open.id], { kind: "pos_return", id: "a", extra: 1 }], "chave a mais"],
    [[u.financeiro, cmd, [open.id, open.id], src], "contas repetidas"],
    [[u.financeiro, cmd, [], src], "lista vazia"],
    [[u.financeiro, cmd, [open.id], [1]], "origem não objeto"],
    [[randomUUID(), cmd, [open.id], src], "ator sem papel"],
    [[u.financeiro, cmd, [randomUUID()], src], "conta inexistente"],
    [[u.financeiro, cmd, [settled.id], src], "conta baixada"],
    [[u.financeiro, cmd, [open.id, gone.id], src], "aberta e cancelada"],
    [[u.financeiro, cmd, docTitles, { kind: "document_return", id: d.id }], "contas do pedido: ajuste de comissão"],
    [[u.financeiro, cmd, [docTitles[0]], { kind: "pos_return", id: "dev-2", label: "Parcial" }], "uma conta do pedido"],
  ])
    await compare(args, all, label);
  // Já devolvida: a mesma conta por outro comando e pelo mesmo.
  await sql("select erp_finance.titles_mark_returned($1,$2,$3::uuid[],$4::jsonb)", [u.financeiro, cmd, [docTitles[0]], JSON.stringify(src)]);
  await compare([u.financeiro, cmd, [docTitles[0], docTitles[1]], src], all, "repetição de parte, outra nova");
  await compare([u.financeiro, randomUUID(), [docTitles[0]], src], all, "já devolvida por outro comando");
  const adj = await compare([u.financeiro, cmd, docTitles, src], all, "o resto do pedido");
  assert.ok(adj.adj?.some((a) => a.kind === "return"), "houve ajuste de devolução");
});
