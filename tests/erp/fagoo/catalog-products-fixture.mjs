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
      p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data, p_acknowledged: acknowledged,
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
  return { ...f, rows, productSave, product, contact, save, setDeleted, write };
}

export const fails = (assert, promise, code) => assert.rejects(promise, (error) => error.code === code || error.message === code);
