// Seletor de vendedores (erp_catalog_seller_options): a linha do subteste "vendedores" de
// workers/erp-api/test/contacts-lane-sql.test.mjs do Fagoo que usa o seletor, na fixture dupla,
// mais busca, limite de 25, situação e a lista de pessoas do administrador. O subteste inteiro
// (seller_save, seller_get, seller_page, from_contact, contact_set_seller) entra com os blocos B e D.
// O erp_catalog_seller_save ainda roda só no Postgres (espelhado no SQLite).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { auxFixture, fails } from "../catalog/aux-fixture.mjs";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};

test("vendedores: o seletor busca por nome e código, só ativos, até 25, e o administrador vê as pessoas", async () => {
  const f = await auxFixture();
  try {
    const seller = async (contact) =>
      f.rpc("erp_catalog_seller_save", {
        p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
        p_contact_expected_version: 0, p_contact: contact, p_settings: SETTINGS,
      });
    const created = await seller({ name: "Vendedora Sintética", city: "Piracicaba", state: "SP" });
    const options = (user, query = null) => f.rpc("erp_catalog_seller_options", { p_user_id: user, p_query: query });
    // A linha original.
    assert.deepEqual((await options(f.users.estoque, "vend sint")).items.map((i) => i.name), ["Vendedora Sintética"]);
    const names = ["Ana Ábaco", "JOÃO da Silva", "Çelia Ñuñez", "Ωmega", "bruna", "Bruna", "Zé", "ana", "Ünal", "Vendedor 7"];
    for (let i = 0; i < 26; i++) await seller({ name: `${names[i % names.length]} ${String(i).padStart(2, "0")}` });
    const all = await options(f.users.admin);
    assert.equal(all.items.length, 25, "até 25");
    assert.equal(all.scope, "seller_options");
    assert.ok(all.users.length >= 7, "o administrador recebe as pessoas do ERP");
    assert.deepEqual((await options(f.users.vendas)).users, [], "os outros papéis, não");
    assert.deepEqual((await options(f.users.vendas, "joao")).items.map((i) => i.name), ["JOÃO da Silva 01", "JOÃO da Silva 11", "JOÃO da Silva 21"]);
    assert.deepEqual((await options(f.users.vendas, "  ")).items.length, 25, "busca em branco é sem filtro");
    const code = await f.scalar("select code v from erp_catalog.record where id=$1", [created.contact.id]);
    if (code) assert.deepEqual((await options(f.users.vendas, String(code))).items.map((i) => i.id), [created.seller.id]);
    // Contato inativo sai do seletor.
    await f.db.query("update erp_catalog.record set active=false where id=$1", [created.contact.id]);
    await f.sync();
    assert.deepEqual((await options(f.users.estoque, "vend sint")).items, []);
    for (const q of ["x".repeat(121), "a\u0001b"]) await fails(assert, options(f.users.admin, q), "22023");
    await fails(assert, options(f.users.inactive), "42501");
  } finally { await f.close(); }
});
