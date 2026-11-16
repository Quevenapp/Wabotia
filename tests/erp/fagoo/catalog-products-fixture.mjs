// Auxiliares das fixtures de produtos do Fagoo (product-registry-fixture,
// produtos-c-fixture, produtos-d-fixture) sobre a fixture dupla: RPC portado
// roda nos dois motores; não portado (erp_catalog_product_save, contact_save,
// set_deleted…) roda no Postgres e o estado é copiado para o SQLite.
// SQL direto no Postgres (f.db.query, f.scalar com escrita) pede f.sync().
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

export async function productsFixture(options) {
  const f = await dualFixture(options);
  const { users, rpc } = f;
  const rows = async (text, args = []) => (await f.db.query(text, args)).rows;
  const productSave = (data, { user = users.admin, id = null, version = 0, command = randomUUID(), acknowledged = null } = {}) =>
    rpc("erp_catalog_product_save", {
      // O corpo chega como JSON nos dois motores (sem chaves undefined, que o structuredClone do harness manteria).
      p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data === null ? null : JSON.parse(JSON.stringify(data)),
      p_acknowledged: acknowledged,
    });
  const product = async (data, user = users.admin) => (await productSave({ kind: "P", format: "S", unit: "UN", ...data }, { user })).record;
  const contact = async (data, user = users.admin) =>
    (
      await rpc("erp_catalog_contact_save", {
        p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { person_type: "J", ...data }, p_acknowledged: null,
      })
    ).record;
  const save = async (entity, data, { user = users.admin, id = null, version = 0, command = randomUUID() } = {}) =>
    (
      await rpc("erp_catalog_save", {
        p_user_id: user, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: command, p_data: data,
      })
    ).record;
  const setDeleted = (id, version, deleted, { user = users.admin, command = randomUUID() } = {}) =>
    rpc("erp_catalog_product_set_deleted", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_deleted: deleted });
  /** Escrita direta no Postgres seguida da cópia para o SQLite. */
  const write = async (text, args = []) => {
    const r = await f.db.query(text, args);
    await f.sync();
    return r.rows[0]?.v;
  };
  const productGet = (id, user = users.admin) => rpc("erp_catalog_product_get", { p_user_id: user, p_id: id });
  const taxonomy = (kind, user = users.admin) => rpc("erp_catalog_taxonomy_list", { p_user_id: user, p_kind: kind });
  const taxonomySave = (kind, data, { user = users.admin, id = null, version = 0, command = randomUUID() } = {}) =>
    rpc("erp_catalog_taxonomy_save", { p_user_id: user, p_kind: kind, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  const taxonomyDelete = (kind, id, version, { user = users.admin, command = randomUUID() } = {}) =>
    rpc("erp_catalog_taxonomy_delete", { p_user_id: user, p_kind: kind, p_id: id, p_expected_version: version, p_command_id: command });
  const stock = async (product, warehouse, quantity, kind = quantity.startsWith("-") ? "issue" : "receipt") =>
    rpc("erp_stock_post", {
      p_user_id: users.estoque, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: "2026-10-15", p_reason: "Movimento sintético",
      p_items: [
        {
          product_id: product, warehouse_id: warehouse, quantity,
          expected_version: await f.scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [product, warehouse]),
        },
      ],
    });
  const preference = async (page, key, value) => {
    const current = (await rpc("erp_preferences_page", { p_user_id: users.admin, p_page: page })).items.find((item) => item.key === key);
    return rpc("erp_preferences_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] });
  };
  // Auxiliares da produtos-e-fixture do Fagoo (composição, depósitos, lançamento e várias preferências).
  const scalar = f.scalar;
  const version = async (id) => scalar("select version v from erp_catalog.record where id=$1", [id]);
  const preferences = async (page, values) => {
    const current = await rpc("erp_preferences_page", { p_user_id: users.admin, p_page: page });
    const changes = Object.entries(values)
      .map(([key, value]) => ({ key, current: current.items.find((i) => i.key === key), value }))
      .filter((c) => JSON.stringify(c.current.value) !== JSON.stringify(c.value))
      .map((c) => ({ key: c.key, expected_version: c.current.version, value: c.value }));
    return changes.length ? rpc("erp_preferences_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: changes }) : null;
  };
  const compose = async (id, items, { data = {}, user = users.admin, stock_type = "virtual", post_mode = "components", command = randomUUID() } = {}) => {
    const current = id ? ((await scalar("select version v from erp_stock.composition where product_id=$1", [id])) ?? 0) : 0;
    return rpc("erp_stock_product_compose", {
      p_user_id: user, p_id: id, p_expected_version: id ? await version(id) : 0, p_command_id: command,
      p_data: id ? { name: await scalar("select name v from erp_catalog.record where id=$1", [id]), ...data } : { kind: "P", format: "E", unit: "KIT", ...data },
      p_acknowledged: null,
      p_composition: { expected_version: current, stock_type, post_mode, items: items.map(([component, quantity]) => ({ component_id: component.id ?? component, quantity })) },
    });
  };
  const warehouse = async (name, ignore = false) =>
    (
      await rpc("erp_stock_warehouse_save", {
        p_user_id: users.admin, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: name, p_ignore_balance: ignore,
      })
    ).warehouse;
  const setDefault = async (target) =>
    rpc("erp_stock_warehouse_set_default", {
      p_user_id: users.admin, p_command_id: randomUUID(), p_warehouse_id: target, p_expected_version: await scalar("select version v from erp_stock.warehouse_default"),
    });
  const balanceVersion = async (item, target) =>
    (await scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)v", [item, target])) ?? 0;
  const launch = async (item, target, kind, quantity) =>
    rpc("erp_stock_launch", {
      p_user_id: users.admin, p_command_id: randomUUID(), p_kind: kind, p_product_id: item, p_warehouse_id: target, p_quantity: quantity,
      p_expected_version: await balanceVersion(item, target), p_unit_price: null, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null,
    });
  return {
    ...f, rows, productSave, product, contact, save, setDeleted, write, productGet, taxonomy, taxonomySave, taxonomyDelete, stock, preference,
    preferences, compose, warehouse, setDefault, balanceVersion, launch, version,
  };
}

export const fails = (assert, promise, code) => assert.rejects(promise, (error) => error.code === code || error.message === code);
