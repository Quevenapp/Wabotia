// Ajudantes do produtos-c-fixture do Fagoo (workers/erp-api/test/helpers) sobre
// a fixture dupla: product, contact, taxonomySave/Delete/taxonomy, preference
// e rows. Os RPCs ainda não portados (contact_save, taxonomy_*,
// preferences_*) rodam no Postgres e o SQLite recebe o espelho; os portados
// rodam nos dois motores e são comparados. Sessão B (auxiliares do Catálogo).
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

export async function auxFixture() {
  const f = await dualFixture();
  const users = f.users;
  const product = async (data, user = users.admin) =>
    (
      await f.rpc("erp_catalog_product_save", {
        p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_data: { kind: "P", format: "S", unit: "UN", ...data }, p_acknowledged: null,
      })
    ).record;
  const contact = async (data, user = users.admin) =>
    (
      await f.rpc("erp_catalog_contact_save", {
        p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_data: { person_type: "J", ...data }, p_acknowledged: null,
      })
    ).record;
  const taxonomySave = (kind, data, { user = users.admin, id = null, version = 0, command = randomUUID() } = {}) =>
    f.rpc("erp_catalog_taxonomy_save", {
      p_user_id: user, p_kind: kind, p_id: id, p_expected_version: version, p_command_id: command, p_data: data,
    });
  const taxonomyDelete = (kind, id, version, { user = users.admin, command = randomUUID() } = {}) =>
    f.rpc("erp_catalog_taxonomy_delete", { p_user_id: user, p_kind: kind, p_id: id, p_expected_version: version, p_command_id: command });
  const taxonomy = (kind, user = users.admin) => f.rpc("erp_catalog_taxonomy_list", { p_user_id: user, p_kind: kind });
  const preference = async (page, key, value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: users.admin, p_page: page })).items.find((i) => i.key === key);
    return f.rpc("erp_preferences_save", {
      p_user_id: users.admin, p_command_id: randomUUID(), p_page: page,
      p_changes: [{ key, expected_version: current.version, value }],
    });
  };
  const rows = async (text, args = []) => (await f.db.query(text, args)).rows;
  /** Permissões finas (Sistema › Usuários › Permissões) de uma pessoa. */
  const restrict = async (user, permissions) => {
    const current = (await f.scalar("select version v from erp_access.user_control where user_id=$1", [user])) ?? 0;
    return f.rpc("erp_access_user_controls_save", {
      p_user_id: users.admin, p_command_id: randomUUID(), p_target: user, p_expected_version: current,
      p_data: { user_type: "normal", schedule: { enabled: false, windows: [] }, permissions },
    });
  };
  return Object.assign(f, { product, contact, taxonomySave, taxonomyDelete, taxonomy, preference, rows, restrict });
}

/** fails do Fagoo: código do Postgres ou mensagem. */
export const fails = (assert, promise, code) => assert.rejects(promise, (e) => e.code === code || e.message === code);
