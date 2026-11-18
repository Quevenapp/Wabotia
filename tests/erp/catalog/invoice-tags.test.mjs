// Etiquetas de nota (bloco C, 14 de 14): erp_catalog_invoice_tags e _save nos
// dois motores, na forma atual do Fagoo (migração 202610220004: a nota espelhada
// do Origin é só leitura, erp_fiscal_mirror_readonly). Os subtestes "236" do
// produtos-e-invoice-tags-sql do Fagoo salvam em nota do Origin, o que a 2004
// passou a recusar; aqui as escritas vão para a nota nativa e a nota do Origin
// fica na leitura e na guarda. Dados sintéticos.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import { auxFixture, fails } from "./aux-fixture.mjs";

let f, urgent, review, productTag;
const HASH = "c".repeat(64);
before(async () => {
  f = await auxFixture();
  const group = (await f.taxonomySave("tag_groups", { name: "Expedição sintética", tag_type: "invoices" }, { user: f.users.fiscal })).item;
  urgent = (await f.taxonomySave("tags", { name: "Urgente", parent_id: group.id }, { user: f.users.fiscal })).item;
  review = (await f.taxonomySave("tags", { name: "Conferir", tag_type: "invoices" }, { user: f.users.fiscal })).item;
  productTag = (await f.taxonomySave("tags", { name: "Urgente", tag_type: "products" })).item;
  await f.db.exec("set session_replication_role = replica");
  try {
    for (const [entity, id] of [["nfe", "7001"], ["nfe", "7002"], ["nfce", "7101"]])
      await f.db.query(
        `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,$2,$3,$4::jsonb,$5)`,
        [entity, `notas/${entity}`, id, JSON.stringify({ id: Number(id) }), HASH],
      );
    await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin','55','7001',$1)`, [urgent.id]);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
});
after(async () => f?.close());

async function nativeNote(model = "55", deletedAt = null, recipient = { name: "Cliente sintético" }) {
  const id = randomUUID();
  await f.db.query(
    `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,deleted_at,deleted_by,delete_reason)
     values($1,$2,'1',CASE WHEN $2='65' THEN 'C' ELSE 'N' END,'2',1,1,null,'Venda','2026-10-18','1','1','1',false,$7::jsonb,'[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',1,$3,$3,$4,$5,$6)`,
    [id, model, f.users.admin, deletedAt, deletedAt && f.users.admin, deletedAt && "Lixeira sintética", JSON.stringify(recipient)],
  );
  await f.sync();
  return id;
}
const save = ({ origin = "brufap", model = "55", id, version = 0, tags, mode = "replace", user = f.users.fiscal, command = randomUUID() }) =>
  f.rpc("erp_catalog_invoice_tags_save", {
    p_user_id: user, p_origin: origin, p_model: model, p_id: id, p_expected_version: mode === "add" ? null : version,
    p_command_id: command, p_tag_ids: tags, p_mode: mode,
  });
const read = (ids, { origin = "origin", model = "55", user = f.users.consulta } = {}) =>
  f.rpc("erp_catalog_invoice_tags", { p_user_id: user, p_origin: origin, p_model: model, p_ids: ids });

test("invoice_tags e _save rodam portados nos dois motores", () => {
  for (const name of ["erp_catalog_invoice_tags", "erp_catalog_invoice_tags_save"]) assert.ok(isPorted(name), name);
});

test("leitura: notas do Origin na ordem pedida, perfis, lista inválida e nota que não existe", async () => {
  const page = await read(["7002", "7001"]);
  assert.deepEqual([page.scope, page.origin, page.model, page.data_mode], ["invoice_tags", "origin", "55", "erp_native"]);
  assert.deepEqual(page.items.map((i) => [i.invoice_id, i.version, i.tag_ids]), [["7002", 0, []], ["7001", 0, [urgent.id]]]);
  assert.equal(page.items[1].tags[0].group_name, "Expedição sintética");
  for (const user of [f.users.admin, f.users.fiscal]) assert.equal((await read(["7001"], { user })).items.length, 1);
  assert.equal((await read(["7101"], { model: "65" })).items[0].invoice_id, "7101");
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, f.users.inactive]) await fails(assert, read(["7001"], { user }), "42501");
  await fails(assert, read(["7001", "7001"]), "22023");
  await fails(assert, read([]), "22023");
  await fails(assert, read(["7001", null]), "22023");
  await fails(assert, read(["abc"]), "22023");
  await fails(assert, read(Array.from({ length: 101 }, (_, n) => String(n + 1))), "22023");
  await fails(assert, read(["7001"], { model: "57" }), "22023");
  await fails(assert, read(["7001"], { origin: "outra" }), "22023");
  await fails(assert, read(["7001"], { origin: null }), "22023");
  // Sem a carteira do vendedor, o visible do Fiscal não confere a existência: a
  // chave válida responde vazia (a recusa P0002 é da carteira, no teste abaixo).
  assert.deepEqual((await read(["7001", "999999"])).items.map((i) => [i.invoice_id, i.version, i.tag_ids.length]), [["7001", 0, 1], ["999999", 0, 0]]);
  assert.deepEqual((await read(["7101"])).items[0].tag_ids, []);
  // Nota nativa: só administrador e fiscal; a chave é o uuid minúsculo.
  await fails(assert, read([randomUUID()], { origin: "brufap", user: f.users.consulta }), "42501");
  await fails(assert, read(["7001"], { origin: "brufap", user: f.users.fiscal }), "22023");
  await fails(assert, read([randomUUID().toUpperCase()], { origin: "brufap", user: f.users.fiscal }), "22023");
});

test("escrita na nota do Origin: erp_fiscal_mirror_readonly antes de qualquer validação, sem comando guardado", async () => {
  const commands = await f.scalar("select count(*)::int v from erp_catalog.command");
  for (const user of [f.users.admin, f.users.fiscal]) {
    await fails(assert, save({ origin: "origin", id: "7001", tags: [] , user }), "42501");
    await fails(assert, save({ origin: "origin", id: "abc", tags: 5, mode: "outro", user }), "42501");
  }
  await fails(assert, save({ origin: "origin", id: "7001", tags: [], user: f.users.consulta }), "42501");
  assert.equal(await f.scalar("select count(*)::int v from erp_catalog.command"), commands);
  assert.deepEqual((await read(["7001"])).items[0].tag_ids, [urgent.id], "nada mudou");
});

test("nota nativa: versão, comando idempotente, auditoria, referências e perfis", async () => {
  const note = await nativeNote();
  const command = randomUUID();
  const first = await save({ id: note, tags: [urgent.id, review.id], command });
  assert.deepEqual(
    [first.scope, first.origin, first.changed, first.replayed, first.invoice.version, first.invoice.tags.map((t) => t.name)],
    ["invoice_tags", "brufap", true, false, 1, ["Conferir", "Urgente"]],
  );
  const again = await save({ id: note, tags: [urgent.id, review.id], command });
  assert.deepEqual([again.replayed, again.invoice.version], [true, 1]);
  await fails(assert, save({ id: note, tags: [urgent.id], command }), "40001");
  await fails(assert, save({ id: note, tags: [urgent.id], command, user: f.users.admin }), "40001");
  await fails(assert, save({ id: note, tags: [urgent.id], version: 0 }), "40001");
  const replaced = await save({ id: note, tags: [urgent.id], version: 1 });
  assert.deepEqual([replaced.invoice.version, replaced.invoice.tag_ids], [2, [urgent.id]]);
  const unchanged = await save({ id: note, tags: [urgent.id], version: 2 });
  assert.deepEqual([unchanged.changed, unchanged.invoice.version], [false, 2]);
  const added = await save({ id: note, tags: [review.id], mode: "add", user: f.users.admin });
  assert.deepEqual([added.invoice.version, added.invoice.tag_ids.length], [3, 2]);
  const same = await save({ id: note, tags: [review.id], mode: "add" });
  assert.deepEqual([same.changed, same.invoice.version], [false, 3]);
  const cleared = await save({ id: note, tags: [], version: 3 });
  assert.deepEqual([cleared.invoice.version, cleared.invoice.tag_ids], [4, []]);
  assert.deepEqual(
    (await f.rows("select action, before_data, after_data from erp_catalog.invoice_tag_audit where invoice_id=$1 order by id", [note])).map((r) => r.action),
    ["tags_update", "tags_update", "tags_added", "tags_update"],
  );
  assert.deepEqual((await read([note], { origin: "brufap", user: f.users.fiscal })).items[0].version, 4);
  // Só etiquetas de Notas fiscais; só notas nativas do modelo, não excluídas.
  await fails(assert, save({ id: note, tags: [productTag.id], version: 4 }), "22023");
  await fails(assert, save({ id: note, tags: [randomUUID()], version: 4 }), "22023");
  await fails(assert, save({ id: note, model: "65", tags: [urgent.id] }), "P0002");
  await fails(assert, save({ id: randomUUID(), tags: [urgent.id] }), "P0002");
  await fails(assert, save({ id: await nativeNote("55", "2026-10-19T10:00:00Z"), tags: [urgent.id] }), "P0002");
  assert.equal((await save({ id: await nativeNote("65"), model: "65", tags: [urgent.id] })).invoice.version, 1, "a NFC-e é o modelo 65");
  // Comando inválido.
  for (const bad of [
    { tags: [urgent.id, urgent.id], version: 4 },
    { tags: [urgent.id.toUpperCase()], version: 4 },
    { tags: [1], version: 4 },
    { tags: { id: urgent.id }, version: 4 },
    { tags: Array.from({ length: 51 }, () => randomUUID()), version: 4 },
    { tags: [], mode: "add" },
    { tags: [urgent.id], version: null },
    { tags: [urgent.id], version: -1 },
    { tags: [urgent.id], version: 2147483647 },
    { tags: [urgent.id], mode: "trocar" },
    { tags: [urgent.id], version: 4, command: null },
    { tags: [urgent.id], version: 4, id: "7001" },
    { tags: [urgent.id], version: 4, model: "57" },
  ])
    await fails(assert, save({ id: note, ...bad }), "22023");
  // add não leva versão.
  await fails(
    assert,
    f.rpc("erp_catalog_invoice_tags_save", {
      p_user_id: f.users.fiscal, p_origin: "brufap", p_model: "55", p_id: note, p_expected_version: 4,
      p_command_id: randomUUID(), p_tag_ids: [urgent.id], p_mode: "add",
    }),
    "22023",
  );
  // Perfis: consulta só lê; vendas, estoque e financeiro não veem notas.
  for (const user of [f.users.consulta, f.users.vendas, f.users.estoque, f.users.financeiro, f.users.inactive])
    await fails(assert, save({ id: note, tags: [urgent.id], version: 4, user }), "42501");
});

test("p_tag_ids em texto: o jsonb chega como veio (texto inválido dá 22P02)", async () => {
  const note = await nativeNote();
  const saved = await save({ id: note, tags: JSON.stringify([review.id]) });
  assert.deepEqual(saved.invoice.tag_ids, [review.id]);
  await fails(assert, save({ id: note, tags: "[nao-json", version: 1 }), "22P02");
});

test('carteira do vendedor ("Contato acessível somente ao vendedor vinculado"): nota fora dela dá P0002', async () => {
  const sellerContact = await f.contact({ name: "Vendedor fiscal sintético" });
  const seller = await f.scalar("insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by) values($1,$2,$3,$3) returning id v", [sellerContact.id, f.users.fiscal, f.users.admin]);
  await f.sync();
  const client = await f.contact({ name: "Cliente da carteira", seller_id: seller });
  const mine = await nativeNote("55", null, { name: "Cliente da carteira", contact_id: client.id });
  const other = await nativeNote();
  await f.preference("cadastros-contatos", "contatos.acesso_vendedor", true);
  try {
    assert.equal((await save({ id: mine, tags: [urgent.id] })).invoice.version, 1);
    assert.equal((await read([mine], { origin: "brufap", user: f.users.fiscal })).items[0].tag_ids.length, 1);
    await fails(assert, save({ id: other, tags: [urgent.id] }), "P0002");
    await fails(assert, read([mine, other], { origin: "brufap", user: f.users.fiscal }), "P0002");
    // A nota do Origin sem contato não é da carteira.
    await fails(assert, read(["7001"], { user: f.users.fiscal }), "P0002");
    // Administrador não tem carteira.
    assert.equal((await save({ id: other, tags: [urgent.id], user: f.users.admin })).invoice.version, 1);
    assert.equal((await read(["7001"], { user: f.users.admin })).items.length, 1);
  } finally {
    await f.preference("cadastros-contatos", "contatos.acesso_vendedor", false);
  }
});
