// erp_catalog.contact_scope, contact_situation, contact_situation_of e
// contact_source_situation (catalog/contact.ts) contra o oráculo.
// contact_source_situation lê o snapshot do Origin; sem contato espelhado,
// null nos dois motores (o caso espelhado está em harness/origin-seed).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  contactRequireVisible,
  contactScope,
  contactVisibleTo,
  contactSituation,
  contactSituationOf,
  contactSourceSituation,
} from "../../../src/erp/domains/catalog/public.ts";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));
const pg = (sql, args) => async () => (await f.db.query(sql, args)).rows[0].v;

test("contact_situation: ativo/inativo com o detalhe do perfil", async () => {
  for (const active of [true, false, null])
    for (const detail of ["A", "S", "I", "E", null, "x"])
      await f.dual("contact_situation", pg("select erp_catalog.contact_situation($1,$2) v", [active, detail]), () => contactSituation(active, detail));
});

test("contact_scope: só com a preferência, fora do administrador e com vendedor vinculado", async () => {
  const seller = await f.rpc("erp_catalog_seller_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_contact: { name: "Vendedora do escopo" }, p_settings: { ...SETTINGS, user_id: f.users.vendas },
  });
  const users = [f.users.admin, f.users.vendas, f.users.vendedor, f.users.consulta, f.users.inactive, randomUUID(), null];
  const scope = (user) => f.dual("contact_scope", pg("select erp_catalog.contact_scope($1)::text v", [user]), lite((db) => contactScope(db, user)));
  for (const user of users) assert.equal(await scope(user), null, "preferência desligada");
  await f.preference("contatos.acesso_vendedor", true);
  try {
    assert.equal(await scope(f.users.vendas), seller.seller.id);
    for (const user of users.filter((u) => u !== f.users.vendas)) assert.equal(await scope(user), null);
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
});

test("contact_situation_of e contact_source_situation: perfil nativo, sem Origin", async () => {
  const contact = (await f.save({ name: "Contato das situações" })).record;
  const product = await f.catalog("products", { name: "Produto não contato", unit: "UN", kind: "P", price: "1" });
  const ids = [contact.id, product.id, randomUUID(), null];
  const check = async () => {
    for (const id of ids) {
      await f.dual("contact_situation_of", pg("select erp_catalog.contact_situation_of($1) v", [id]), lite((db) => contactSituationOf(db, id)));
      await f.dual("contact_source_situation", pg("select erp_catalog.contact_source_situation($1) v", [id]), lite((db) => contactSourceSituation(db, id)));
    }
  };
  await check();
  let version = contact.version;
  for (const situation of ["S", "E", "I", "A"]) {
    version = (
      await f.rpc("erp_catalog_contact_set_situation", {
        p_user_id: f.users.admin, p_id: contact.id, p_expected_version: version, p_command_id: randomUUID(), p_situation: situation,
      })
    ).record.version;
    await check();
  }
});

test("contact_visible_to e contact_require_visible: carteira do vendedor com a preferência", async () => {
  const seller = await f.rpc("erp_catalog_seller_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_contact: { name: "Vendedor da carteira" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor },
  });
  const mine = (await f.save({ name: "Cliente da carteira" })).record;
  const other = (await f.save({ name: "Cliente de ninguém" })).record;
  await f.rpc("erp_catalog_contact_set_seller", {
    p_user_id: f.users.admin, p_id: mine.id, p_expected_version: mine.version, p_command_id: randomUUID(), p_seller_id: seller.seller.id,
  });
  const ids = [mine.id, other.id, randomUUID(), null];
  for (const scope of [null, seller.seller.id, randomUUID()])
    for (const id of ids)
      await f.dual("contact_visible_to", pg("select erp_catalog.contact_visible_to($1,$2) v", [scope, id]), lite((db) => contactVisibleTo(db, scope, id)));
  const require = (user, id) =>
    f.dual(
      "contact_require_visible",
      async () => (await f.db.query("select erp_catalog.contact_require_visible($1,$2)::text v", [user, id])).rows[0].v,
      lite((db) => (contactRequireVisible(db, user, id), "")), // void::text é ""
    );
  const check = async (blocked) => {
    for (const user of [f.users.vendedor, f.users.admin, f.users.consulta, null])
      for (const id of ids) {
        const outcome = await require(user, id).then(() => "ok", (e) => (e.code === "42501" ? e.message : Promise.reject(e)));
        if (blocked && user === f.users.vendedor && id !== mine.id) assert.equal(outcome, "erp_catalog_contact_not_visible");
        else assert.equal(outcome, "ok");
      }
  };
  await check(false);
  await f.preference("contatos.acesso_vendedor", true);
  try {
    await check(true);
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
});