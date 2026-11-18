// Taxonomia nos dois motores (sessão P): erp_catalog_taxonomy_list/save/delete
// para categorias, grupos de produto, grupos de etiquetas e etiquetas; as
// recusas do gatilho erp_catalog_taxonomy_type_guard (tipo fixo, pai de outro
// tipo) e os desvínculos do excluir (produto com categoria e etiqueta, contato
// com etiqueta). Cada chamada compara resposta e tabelas tocadas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { auxFixture } from "./aux-fixture.mjs";

let f;
before(async () => {
  f = await auxFixture();
});
after(async () => f?.close());

async function fails(promise, code, message) {
  await assert.rejects(promise, (e) => e.code === code && (message === undefined || e.message === message));
}

test("lista, inclusão, renomear e excluir em cada tipo", async () => {
  const group = (await f.taxonomySave("product_groups", { name: "Ferragens" })).item;
  const parent = (await f.taxonomySave("categories", { name: "Ferramentas" })).item;
  const child = (await f.taxonomySave("categories", { name: "Furadeiras", parent_id: parent.id })).item;
  const tagGroup = (await f.taxonomySave("tag_groups", { name: "Campanhas", tag_type: "products" })).item;
  const tag = (await f.taxonomySave("tags", { name: "Promo", parent_id: tagGroup.id, tag_type: "products" })).item;
  for (const kind of ["categories", "product_groups", "tag_groups", "tags"]) await f.taxonomy(kind);
  const renamed = (await f.taxonomySave("categories", { name: "Ferramentas elétricas" }, { id: parent.id, version: parent.version })).item;
  await fails(f.taxonomySave("categories", { name: "De novo" }, { id: parent.id, version: parent.version }), "40001");
  const blocked = await f.taxonomyDelete("categories", renamed.id, renamed.version);
  assert.equal(blocked.deleted, false);
  await f.taxonomyDelete("categories", child.id, child.version);
  await f.taxonomyDelete("tags", tag.id, tag.version);
  await f.taxonomyDelete("product_groups", group.id, group.version);
  for (const kind of ["categories", "product_groups", "tags"]) await f.taxonomy(kind);
});

test("gatilho taxonomy_type_guard: tipo fixo e pai de outro tipo", async () => {
  const products = (await f.taxonomySave("tag_groups", { name: "Grupo de produtos", tag_type: "products" })).item;
  const contacts = (await f.taxonomySave("tag_groups", { name: "Grupo de contatos", tag_type: "contacts" })).item;
  await fails(f.taxonomySave("tags", { name: "Fora do grupo", parent_id: products.id, tag_type: "contacts" }), "22023", "erp_catalog_taxonomy_parent_invalid");
  const tag = (await f.taxonomySave("tags", { name: "Cliente ouro", parent_id: contacts.id, tag_type: "contacts" })).item;
  await fails(
    f.taxonomySave("tags", { name: "Cliente ouro", parent_id: contacts.id, tag_type: "products" }, { id: tag.id, version: tag.version }),
    "22023",
    "erp_catalog_taxonomy_type_fixed",
  );
  await fails(f.taxonomySave("tag_groups", { name: "Grupo de contatos", tag_type: "products" }, { id: contacts.id, version: contacts.version }), "22023", "erp_catalog_taxonomy_type_fixed");
});

test("excluir tira a categoria e a etiqueta do produto e a etiqueta do contato", async () => {
  const category = (await f.taxonomySave("categories", { name: "Para excluir" })).item;
  const productTags = (await f.taxonomySave("tag_groups", { name: "Etiquetas de produto", tag_type: "products" })).item;
  const productTag = (await f.taxonomySave("tags", { name: "Sai", parent_id: productTags.id, tag_type: "products" })).item;
  await f.product({ name: "Produto com categoria", category_id: category.id, tag_ids: [productTag.id] });
  const contactTags = (await f.taxonomySave("tag_groups", { name: "Etiquetas de contato", tag_type: "contacts" })).item;
  const contactTag = (await f.taxonomySave("tags", { name: "Sai também", parent_id: contactTags.id, tag_type: "contacts" })).item;
  const contact = await f.contact({ name: "Contato com etiqueta" });
  await f.rpc("erp_catalog_contact_tags_save", {
    p_user_id: f.users.admin, p_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [contactTag.id], p_mode: "replace",
  });
  assert.equal((await f.taxonomyDelete("categories", category.id, category.version)).deleted, true);
  assert.equal((await f.taxonomyDelete("tags", productTag.id, productTag.version)).deleted, true);
  assert.equal((await f.taxonomyDelete("tags", contactTag.id, contactTag.version)).deleted, true);
});
