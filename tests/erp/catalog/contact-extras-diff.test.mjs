// Contatos, bloco "resto" (sessão P), nos dois motores: comentários,
// resumo, vendedor em lote, complemento de transportadora, opções dos
// seletores e cobrança. Cada chamada compara resposta, erro e tabelas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

/** O mesmo resultado, ou o mesmo erro, nos dois motores. */
async function same(name, args) {
  try {
    return await f.rpc(name, args);
  } catch (e) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return { error: `${e.code}:${e.message}` };
  }
}
async function seed(sql, args = []) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}

test("comentários: inclusão, repetição, conflito, recusas e lista", async () => {
  const contact = (await f.save({ name: "Contato comentado" })).record;
  const add = (args) => same("erp_catalog_contact_comment_add", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_contact_id: contact.id, p_body: "Ligar amanhã", ...args });
  const command = randomUUID();
  const first = await add({ p_command_id: command, p_body: "  Primeiro\ncomentário\t " });
  assert.equal(first.item.body, "Primeiro\ncomentário\t");
  assert.equal((await add({ p_command_id: command, p_body: "  Primeiro\ncomentário\t " })).replayed, true);
  assert.match((await add({ p_command_id: command, p_body: "Outro" })).error, /40001/);
  for (const body of ["", "   ", "a\u0001b", "x".repeat(2001), null]) assert.match((await add({ p_body: body })).error, /22023/);
  assert.match((await add({ p_contact_id: randomUUID() })).error, /P0002/);
  assert.match((await add({ p_user_id: f.users.consulta })).error, /42501/);
  for (let i = 0; i < 3; i++) await add({ p_body: `Comentário ${i}` });
  for (const user of [f.users.admin, f.users.consulta, f.users.vendas])
    await same("erp_catalog_contact_comments", { p_user_id: user, p_contact_id: contact.id });
  assert.match((await same("erp_catalog_contact_comments", { p_user_id: f.users.admin, p_contact_id: randomUUID() })).error, /P0002/);
});

test("resumo com pessoas e vendedor em lote com o escopo", async () => {
  const person = (await f.save({ name: "Pessoa de contato", person_type: "F", email: "pessoa@exemplo.com.br", phone: "(19) 3434-0000" })).record;
  const company = (await f.save({ name: "Empresa com pessoa", person_type: "J", notes: "Observação", contact_info: "Falar com Ana", persons: [person.id] })).record;
  const seller = await f.rpc("erp_catalog_seller_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_contact: { name: "Vendedor do resumo" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor },
  });
  const set = await same("erp_catalog_contact_set_seller", {
    p_user_id: f.users.admin, p_id: company.id, p_expected_version: company.version, p_command_id: randomUUID(), p_seller_id: seller.seller.id,
  });
  assert.equal(set.replayed, false);
  assert.match((await same("erp_catalog_contact_set_seller", { p_user_id: f.users.admin, p_id: company.id, p_expected_version: 0, p_command_id: randomUUID(), p_seller_id: null })).error, /22023/);
  await f.preference("contatos.acesso_vendedor", true);
  try {
    for (const user of [f.users.admin, f.users.vendedor]) {
      await same("erp_catalog_contact_summary", { p_user_id: user, p_id: company.id });
      await same("erp_catalog_contact_summary", { p_user_id: user, p_id: person.id });
    }
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
});

test("transportadora: complemento, espelho do Origin e opções dos seletores", async () => {
  const carrier = (await f.save({ name: "Transportadora pelo papel", types: ["carrier"] })).record;
  const untyped = (await f.save({ name: "Contato sem tipo", types: [] })).record;
  const customer = (await f.save({ name: "Cliente que também transporta", types: ["customer"], city: "São Carlos" })).record;
  const mirrored = (await f.save({ name: "Transportadora do Origin", types: ["supplier"] })).record;
  await seed(
    `insert into erp_catalog.origin_mirror(entity,source_id,record_id,applied_hash,latest_hash,fields) values('contacts','777',$1,$2,$2,$3::jsonb)`,
    [mirrored.id, "c".repeat(64), JSON.stringify({ source_roles: ["carrier"] })],
  );
  const complement = (args) =>
    same("erp_catalog_contact_carrier_complement", { p_user_id: f.users.admin, p_contact_id: customer.id, p_carrier: true, p_command_id: randomUUID(), ...args });
  const command = randomUUID();
  assert.equal((await complement({ p_command_id: command })).changed, true);
  assert.equal((await complement({ p_command_id: command })).replayed, true);
  assert.equal((await complement({})).changed, false);
  assert.match((await complement({ p_carrier: null })).error, /22023/);
  assert.match((await complement({ p_contact_id: randomUUID() })).error, /P0002/);
  const options = (args) => same("erp_catalog_contact_options", { p_user_id: f.users.admin, p_limit: 25, ...args });
  const carriers = await options({ p_role: "carrier" });
  const match = Object.fromEntries(carriers.items.map((i) => [i.id, i.carrier_match]));
  assert.deepEqual([match[carrier.id], match[mirrored.id], match[customer.id], match[untyped.id]], ["role", "origin", "complement", "untyped"]);
  assert.equal(carriers.items.at(-1).carrier_match, "untyped");
  await complement({ p_carrier: false });
  for (const args of [
    {}, { p_role: "carrier" }, { p_role: "customer" }, { p_role: "supplier" }, { p_role: "technician" }, { p_query: "transp" }, { p_query: "ORIGIN" },
    { p_city: " sao carlos " }, { p_city: "" }, { p_limit: 1 }, { p_limit: 2, p_role: "carrier" },
    { p_limit: 0 }, { p_limit: 51 }, { p_role: "seller" }, { p_query: "a\u0001" }, { p_city: "x".repeat(101) },
  ])
    await options(args);
  await options({ p_role: "carrier" }, f.users.consulta);
});

test("exportação, aniversariantes e lista com etiqueta", async () => {
  const births = ["1980-01-05", "1976-02-29", "1990-06-15", "2001-12-20", "1968-12-31", null];
  const ids = [];
  for (const [i, birth_date] of births.entries())
    ids.push((await f.save({ name: `Aniversariante ${i}`, person_type: "F", ...(birth_date ? { birth_date } : {}) })).record);
  const tags = (await f.rpc("erp_catalog_taxonomy_save", { p_user_id: f.users.admin, p_kind: "tag_groups", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Grupo exp", tag_type: "contacts" } })).item;
  const tag = (await f.rpc("erp_catalog_taxonomy_save", { p_user_id: f.users.admin, p_kind: "tags", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "VIP", parent_id: tags.id, tag_type: "contacts" } })).item;
  await f.rpc("erp_catalog_contact_tags_save", { p_user_id: f.users.admin, p_id: ids[0].id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: "replace" });
  const exp = (args, tagged = false) => same(tagged ? "erp_catalog_contact_export_tagged" : "erp_catalog_contact_export", { p_user_id: f.users.admin, ...args });
  for (const tagged of [false, true]) {
    for (const args of [
      {}, { p_offset: 1, p_limit: 2 }, { p_sort: "name_desc" }, { p_query: "aniversariante 3" },
      { p_kind: "birthdays", p_birth_from: "2026-01-01", p_birth_to: "2026-03-01" },
      { p_kind: "birthdays", p_birth_from: "2026-12-15", p_birth_to: "2027-01-10" },
      { p_kind: "birthdays", p_birth_from: "2026-01-01", p_birth_to: "2026-12-31" },
      { p_kind: "birthdays", p_birth_from: "2026-01-01", p_birth_to: "2027-01-02" },
      { p_kind: "birthdays", p_birth_from: "2026-01-01", p_birth_to: "2027-01-03" },
      { p_kind: "birthdays", p_birth_from: "2026-02-01", p_birth_to: "2026-01-01" },
      { p_kind: "birthdays" }, { p_birth_from: "2026-01-01", p_birth_to: "2026-02-01" }, { p_kind: "x" }, { p_offset: 10000 }, { p_limit: 101 },
    ])
      await exp(args, tagged);
  }
  for (const args of [{ p_tag: tag.id }, { p_tag: "none" }, { p_tag: "VIP" }, { p_price_list_id: randomUUID() }, { p_tag: tag.id, p_kind: "birthdays", p_birth_from: "2026-01-01", p_birth_to: "2026-01-31" }])
    await exp(args, true);
  for (const args of [{}, { p_tag: tag.id }, { p_tag: "none", p_sort: "name_asc" }, { p_tag: "x" }, { p_price_list_id: randomUUID() }, { p_query: "aniversariante", p_tag: tag.id }])
    await same("erp_catalog_contact_page_tagged", { p_user_id: f.users.admin, p_size: 100, ...args });
});

test("cobrança: leitura, gravação, versão, repetição e recusas", async () => {
  const contact = (await f.save({ name: "Contato da cobrança", email: "geral@exemplo.com.br", street: "Rua A", number: "10", city: "Piracicaba", state: "SP" })).record;
  const get = (user = f.users.admin) => same("erp_contact_billing_get", { p_user_id: user, p_contact_id: contact.id });
  const save = (args) =>
    same("erp_contact_billing_save", {
      p_user_id: f.users.admin, p_contact_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(),
      p_data: { same_as_general: false, billing_email: " cobranca@exemplo.com.br " }, ...args,
    });
  await get();
  await seed("insert into erp_catalog.contact_email_verification(contact_id,email,purpose,confirmed_at,method) values($1,'geral@exemplo.com.br','geral',now(),'link_transacional')", [contact.id]);
  await get();
  const command = randomUUID();
  const first = await save({ p_command_id: command });
  assert.equal(first.item.version, 1);
  assert.equal((await save({ p_command_id: command })).replayed, true);
  assert.match((await save({ p_command_id: command, p_data: { same_as_general: true, billing_email: null } })).error, /40001/);
  assert.match((await save({})).error, /40001/);
  await save({ p_expected_version: 1, p_data: { same_as_general: true, billing_email: "a@b.com; c@d.com" } });
  for (const data of [
    { same_as_general: true }, { same_as_general: "sim", billing_email: null }, { same_as_general: true, billing_email: 1 },
    { same_as_general: true, billing_email: null, extra: 1 }, [], null, { same_as_general: true, billing_email: "não é e-mail" },
  ])
    await save({ p_expected_version: 2, p_data: data });
  for (const v of [-1, 2147483647, null]) await save({ p_expected_version: v });
  assert.match((await same("erp_contact_billing_get", { p_user_id: f.users.admin, p_contact_id: randomUUID() })).error, /P0002/);
  await get(f.users.consulta);
});
