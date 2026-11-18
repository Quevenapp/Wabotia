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

test("excluir etiqueta de nota tira das notas espelhadas do Origin (versão e trilha)", async () => {
  const keep = (await f.taxonomySave("tags", { name: "Fica", tag_type: "invoices" })).item;
  const gone = (await f.taxonomySave("tags", { name: "Sai da nota", tag_type: "invoices" })).item;
  await f.db.exec("set session_replication_role = replica");
  try {
    for (const [entity, id] of [["nfe", "123"], ["nfce", "77"], ["nfe", "9"]])
      await f.db.query(
        `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,$1,$2,'{}'::jsonb,$3)`,
        [entity, id, "c".repeat(64)],
      );
    // NF-e 123 com as duas etiquetas e versão 2; NFC-e 77 só com a que sai; NF-e 9 só com a que fica.
    for (const [model, id, tag] of [["55", "123", keep.id], ["55", "123", gone.id], ["65", "77", gone.id], ["55", "9", keep.id]])
      await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin',$1,$2,$3)`, [model, id, tag]);
    await f.db.query(
      `insert into erp_catalog.invoice_tag_state(origin,model,invoice_id,version,updated_by,updated_at) values('origin','55','123',2,$1,now())`,
      [f.users.admin],
    );
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
  assert.equal((await f.taxonomyDelete("tags", gone.id, gone.version)).deleted, true);
  const left = (await f.db.query("select count(*)::int v from erp_catalog.invoice_tag where tag_id=$1", [gone.id])).rows[0].v;
  assert.equal(left, 0);
});
