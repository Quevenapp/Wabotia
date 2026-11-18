// Portão de acesso do vendedor (migração 241): o subteste "the seller save writes the access-gate
// flag of the linked users" de workers/erp-api/test/contact-seller-gate-sql.test.mjs do Fagoo, no
// nível do RPC e na fixture dupla. O original confere as chamadas que o Worker faz ao Supabase Auth
// (app_metadata.brufap_access_gate); aqui as mesmas decisões são conferidas no access_gates da
// resposta do erp_catalog_seller_save, comparada nos dois motores, inclusive na repetição do comando.
// Fora: privilégios do Postgres, o leitor estrito do Worker e o seletor de transportador (outro RPC).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { auxFixture, fails } from "../catalog/aux-fixture.mjs";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};
const WINDOWS = [{ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }];
const gates = (r) => Object.fromEntries(r.access_gates.map((g) => [g.user_id, g.gate_required]));

test("o save do vendedor diz o portão das pessoas vinculadas antes e agora; a repetição relê", async () => {
  const f = await auxFixture();
  try {
    const save = (args) =>
      f.rpc("erp_catalog_seller_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, ...args });
    const created = await save({
      p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_contact: { name: "Vendedora com horário" },
      p_settings: { ...SETTINGS, user_id: f.users.vendas, access_hours_enabled: true, access_windows: WINDOWS },
    });
    assert.deepEqual(gates(created), { [f.users.vendas]: true });
    assert.deepEqual(created.access_users, [f.users.vendas]);
    // Passar o vendedor para outra pessoa: o portão sai da primeira e entra na segunda.
    const command = randomUUID();
    const args = {
      p_command_id: command, p_id: created.seller.id, p_expected_version: created.seller.version, p_contact_expected_version: created.contact.version,
      p_contact: { name: "Vendedora com horário" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor, access_hours_enabled: true, access_windows: WINDOWS },
    };
    const moved = await save(args);
    assert.deepEqual(gates(moved), { [f.users.vendas]: false, [f.users.vendedor]: true });
    // A mesma resposta de novo ("Conferir resultado"): o portão é relido.
    const again = await save(args);
    assert.equal(again.replayed, true);
    assert.deepEqual(gates(again), { [f.users.vendas]: false, [f.users.vendedor]: true });
    await fails(assert, save({ ...args, p_settings: { ...args.p_settings, notes: "outro" } }), "40001");
    // Sem horário, a segunda pessoa não precisa mais do portão.
    const off = await save({
      p_id: created.seller.id, p_expected_version: moved.seller.version, p_contact_expected_version: moved.contact.version,
      p_contact: { name: "Vendedora com horário" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor },
    });
    assert.deepEqual(gates(off), { [f.users.vendedor]: false });
    // Horário próprio da pessoa (Sistema › Usuários): o portão fica, mesmo sem o do vendedor.
    await f.db.query(
      "insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',true,$2::jsonb,null,1,clock_timestamp(),$3)",
      [f.users.vendedor, JSON.stringify(WINDOWS), f.users.admin],
    );
    await f.sync();
    const later = await save({
      p_id: created.seller.id, p_expected_version: off.seller.version, p_contact_expected_version: off.contact.version,
      p_contact: { name: "Vendedora com horário" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor, notes: "Outra nota" },
    });
    assert.deepEqual(gates(later), { [f.users.vendedor]: true });
    // A repetição do primeiro comando também relê: agora a segunda pessoa tem horário próprio.
    assert.deepEqual(gates(await save(args)), { [f.users.vendas]: false, [f.users.vendedor]: true });
    // Pessoa já vinculada a outro vendedor, inativa ou inexistente.
    await fails(assert, save({ p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_contact: { name: "Outra" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor } }), "23505");
    for (const u of [f.users.inactive, randomUUID()])
      await fails(assert, save({ p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_contact: { name: "Outra" }, p_settings: { ...SETTINGS, user_id: u } }), "22023");
  } finally { await f.close(); }
});
