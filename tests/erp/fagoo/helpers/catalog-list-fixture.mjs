// A interface de workers/erp-api/test/helpers/catalog-list-parity-fixture.mjs
// do Fagoo (db, users, rows, scalar, rpc, save, page, check, saveChecked,
// stock) sobre a fixture dupla.
import { randomUUID } from "node:crypto";
import { dualFixture } from "../../harness/dual-fixture.mjs";

export async function catalogListParityFixture() {
  const f = await dualFixture();
  const users = f.users;
  const rows = async (sql, args = []) => (await f.db.query(sql, args)).rows;
  const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v;
  const rpc = (name, args) => f.rpc(name, args);
  const save = async (entity, data, { user = users.admin, id = null, version = 0, command = randomUUID() } = {}) =>
    (await rpc("erp_catalog_save", { p_user_id: user, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: command, p_data: data })).record;
  const page = (entity, args = {}, user = users.admin) =>
    entity === "products"
      ? rpc("erp_catalog_product_page", { p_user_id: user, ...args })
      : rpc("erp_catalog_page", { p_user_id: user, p_entity: entity, ...args });
  const check = (entity, data, { id = null, user = users.admin } = {}) =>
    rpc("erp_catalog_check", { p_user_id: user, p_entity: entity, p_id: id, p_data: data });
  const saveChecked = (entity, data, acknowledged, { user = users.admin, id = null, version = 0, command = randomUUID() } = {}) =>
    rpc("erp_catalog_save_checked", {
      p_user_id: user, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: command, p_data: data, p_acknowledged: acknowledged,
    });
  const stock = async (product, warehouse, quantity, kind = quantity.startsWith("-") ? "issue" : "receipt") =>
    rpc("erp_stock_post", {
      p_user_id: users.estoque, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: "2026-10-15", p_reason: "Movimento sintético096",
      p_items: [{
        product_id: product, warehouse_id: warehouse, quantity,
        expected_version: await scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [product, warehouse]),
      }],
      p_reference: null,
    });
  // SQL direto de escrita (o teste original ajusta created_at/updated_at assim)
  // é espelhado no SQLite em seguida, como pede a adaptação (f.sync()).
  const db = {
    query: async (sql, args) => {
      const r = await f.db.query(sql, args);
      if (/^\s*(insert|update|delete|with)\b/i.test(sql)) await f.sync();
      return r;
    },
    exec: (sql) => f.db.exec(sql),
  };
  return { ...f, db, users, rows, scalar, rpc, save, page, check, saveChecked, stock, close: () => f.close() };
}
