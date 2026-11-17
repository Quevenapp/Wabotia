// Etiquetas de contato: os subtestes "153 contact tags" de workers/erp-api/test/produtos-c-tags-sql.test.mjs
// do Fagoo, na fixture dupla. Asserções iguais; só os ajudantes mudam (aux-fixture.mjs).
// Portados e comparados nos dois motores: erp_catalog_contact_tags e _contact_tags_save. O
// contact_save, contact_get, contact_set_situation, taxonomy_save, preferences_* e a
// contact_page_tagged ainda rodam só no Postgres (espelhados no SQLite).
// Fora: o subteste de grants e os de produto, página e exportação com etiquetas (outros lotes).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { auxFixture, fails } from "../catalog/aux-fixture.mjs";

test("153 contact tags: replace with the version of the tag set, add without it, replay, conflicts and the contact version untouched", async () => {
  const f = await auxFixture();
  try {
    const group = (await f.taxonomySave("tag_groups", { name: "Segmento", tag_type: "contacts" })).item;
    const a = (await f.taxonomySave("tags", { name: "Atacado", parent_id: group.id })).item;
    const b = (await f.taxonomySave("tags", { name: "Varejo", tag_type: "contacts" })).item;
    const productTag = (await f.taxonomySave("tags", { name: "Promoção", tag_type: "products" })).item;
    const contact = await f.contact({ name: "Cliente Sintético" });
    const save = (args, user = f.users.admin) =>
      f.rpc("erp_catalog_contact_tags_save", { p_user_id: user, p_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: "replace", ...args });
    const command = randomUUID();
    const first = await save({ p_command_id: command, p_tag_ids: [a.id] });
    assert.deepEqual([first.changed, first.contact.version, first.contact.tag_ids, first.contact.tags[0].group_name], [true, 1, [a.id], "Segmento"]);
    assert.equal((await save({ p_command_id: command, p_tag_ids: [a.id] })).replayed, true, "the same command answers the stored result");
    await fails(assert, save({ p_command_id: command, p_tag_ids: [b.id] }), "40001");
    await fails(assert, save({ p_tag_ids: [b.id] }), "40001");
    await fails(assert, save({ p_expected_version: 1, p_tag_ids: [productTag.id] }), "22023");
    const added = await save({ p_mode: "add", p_expected_version: null, p_tag_ids: [b.id] });
    assert.deepEqual([added.changed, added.contact.version, added.contact.tag_ids.length], [true, 2, 2]);
    const again = await save({ p_mode: "add", p_expected_version: null, p_tag_ids: [b.id] });
    assert.deepEqual([again.changed, again.contact.version], [false, 2], "adding a tag it has changes nothing");
    await fails(assert, save({ p_mode: "add", p_expected_version: 2, p_tag_ids: [b.id] }), "22023");
    await fails(assert, save({ p_mode: "add", p_expected_version: null, p_tag_ids: [] }), "22023");
    const cleared = await save({ p_expected_version: 2, p_tag_ids: [] });
    assert.deepEqual([cleared.contact.version, cleared.contact.tag_ids], [3, []]);
    assert.equal((await f.rpc("erp_catalog_contact_get", { p_user_id: f.users.admin, p_id: contact.id })).record.version, contact.version, "the contact form version did not change");
    assert.deepEqual((await f.rows("select action from erp_catalog.audit where entity='contacts' and record_id=$1 and action like 'tags%' order by id", [contact.id])).map((row) => row.action), ["tags_update", "tags_added", "tags_update"]);
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }, f.users.consulta), "42501");
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }, f.users.estoque), "42501");
    // Excluído is read-only.
    const situation = await f.rpc("erp_catalog_contact_set_situation", { p_user_id: f.users.admin, p_id: contact.id, p_expected_version: contact.version, p_command_id: randomUUID(), p_situation: "E" });
    assert.equal(situation.record.situation, "E");
    await fails(assert, save({ p_expected_version: 3, p_tag_ids: [a.id] }), "22023");
  } finally { await f.close(); }
});

test('153 contact tags respect "Contato acessível somente ao vendedor vinculado"', async () => {
  const f = await auxFixture();
  try {
    const tag = (await f.taxonomySave("tags", { name: "VIP", tag_type: "contacts" })).item;
    const sellerContact = await f.contact({ name: "Vendedora Sintética" });
    const seller = await f.scalar("insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by) values($1,$2,$3,$3) returning id v", [sellerContact.id, f.users.vendas, f.users.admin]);
    await f.sync();
    const mine = await f.contact({ name: "Cliente da vendedora", seller_id: seller });
    const other = await f.contact({ name: "Cliente de outro" });
    await f.preference("cadastros-contatos", "contatos.acesso_vendedor", true);
    const list = await f.rpc("erp_catalog_contact_tags", { p_user_id: f.users.vendas, p_ids: [mine.id, other.id] });
    assert.deepEqual(list.items.map((item) => item.contact_id), [mine.id]);
    await fails(assert, f.rpc("erp_catalog_contact_tags_save", { p_user_id: f.users.vendas, p_id: other.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: "replace" }), "42501");
    const saved = await f.rpc("erp_catalog_contact_tags_save", { p_user_id: f.users.vendas, p_id: mine.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: "replace" });
    assert.equal(saved.contact.version, 1);
    await fails(assert, f.rpc("erp_catalog_contact_tags", { p_user_id: f.users.vendas, p_ids: [mine.id, mine.id] }), "22023");
  } finally { await f.close(); }
});

test("leitura e argumentos: ordem pedida, contato inexistente, limites, uuid em maiúsculas e 50 etiquetas", async () => {
  const f = await auxFixture();
  try {
    const tags = [];
    for (let i = 0; i < 51; i++) tags.push((await f.taxonomySave("tags", { name: `Etiqueta ${String(i).padStart(2, "0")}`, tag_type: "contacts" })).item);
    const c1 = await f.contact({ name: "Primeiro" }), c2 = await f.contact({ name: "Segundo" });
    const read = (ids, user = f.users.admin) => f.rpc("erp_catalog_contact_tags", { p_user_id: user, p_ids: ids });
    // Ordem pedida, inexistente fora, contato sem etiqueta com versão 0.
    const both = await read([c2.id, randomUUID(), c1.id]);
    assert.deepEqual(both.items.map((i) => [i.contact_id, i.version, i.tag_ids]), [[c2.id, 0, []], [c1.id, 0, []]]);
    for (const ids of [[], Array.from({ length: 101 }, () => randomUUID()), [c1.id, null], null]) await fails(assert, read(ids), "22023");
    await fails(assert, read([c1.id], f.users.inactive), "42501");
    const save = (args) =>
      f.rpc("erp_catalog_contact_tags_save", { p_user_id: f.users.admin, p_id: c1.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: "replace", ...args });
    // uuid em maiúsculas vale (o mesmo id); repetido, não.
    const upper = await save({ p_tag_ids: [tags[1].id.toUpperCase(), tags[0].id] });
    assert.deepEqual(upper.contact.tag_ids, [tags[0].id, tags[1].id].sort());
    assert.deepEqual(upper.contact.tags.map((t) => t.name), ["Etiqueta 00", "Etiqueta 01"]);
    await fails(assert, save({ p_expected_version: 1, p_tag_ids: [tags[0].id, tags[0].id.toUpperCase()] }), "22023");
    for (const bad of [["nao-e-uuid"], [7], { a: 1 }, null]) await fails(assert, save({ p_expected_version: 1, p_tag_ids: bad }), "22023");
    // Texto que não é JSON: o cast para jsonb recusa nos dois motores (jsonArg).
    await fails(assert, save({ p_expected_version: 1, p_tag_ids: "texto" }), "22P02");
    for (const mode of ["trocar", null]) await fails(assert, save({ p_expected_version: 1, p_mode: mode }), "22023");
    await fails(assert, save({ p_expected_version: 2147483647, p_tag_ids: [] }), "22023");
    await fails(assert, save({ p_id: randomUUID(), p_expected_version: 0, p_tag_ids: [tags[0].id] }), "P0002");
    await fails(assert, save({ p_expected_version: 1, p_tag_ids: [randomUUID()] }), "22023");
    // 50 de uma vez passa; a 51ª pelo "add" estoura o limite do contato.
    const fifty = await save({ p_expected_version: 1, p_tag_ids: tags.slice(0, 50).map((t) => t.id) });
    assert.equal(fifty.contact.tag_ids.length, 50);
    await fails(assert, save({ p_mode: "add", p_expected_version: null, p_tag_ids: [tags[50].id] }), "22023");
    await fails(assert, save({ p_expected_version: 2, p_tag_ids: tags.map((t) => t.id) }), "22023");
    // As recusas não mexeram na versão: duas gravações que mudaram, versão 2.
    const read1 = (await read([c1.id])).items[0];
    assert.equal(read1.version, 2);
  } finally { await f.close(); }
});
