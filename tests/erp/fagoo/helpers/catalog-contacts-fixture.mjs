// A interface de workers/erp-api/test/helpers/contacts-fixture.mjs do Fagoo
// (rpc, scalar, rows, users, save, get, page, preference) sobre a fixture
// dupla. O usuário "other" do Fagoo é o "vendedor" (papel vendas).
import { randomUUID } from "node:crypto";
import { dualFixture } from "../../harness/dual-fixture.mjs";

export async function contactsFixture() {
  const f = await dualFixture();
  const rows = async (text, args = []) => (await f.db.query(text, args)).rows;
  const scalar = async (text, args = []) => (await f.db.query(text, args)).rows[0]?.v;
  const save = (data, { user = f.users.admin, id = null, version = 0, command = randomUUID(), acknowledged = null } = {}) =>
    f.rpc("erp_catalog_contact_save", {
      p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data, p_acknowledged: acknowledged,
    });
  const get = (id, user = f.users.admin) => f.rpc("erp_catalog_contact_get", { p_user_id: user, p_id: id });
  const page = (args = {}, user = f.users.admin) => f.rpc("erp_catalog_contact_page", { p_user_id: user, ...args });
  // Preferências pelo RPC real, como faria um administrador.
  const preference = async (key, value) => {
    const pageId = "cadastros-contatos";
    const current = (await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: pageId })).items.find((i) => i.key === key);
    return f.rpc("erp_preferences_save", {
      p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: pageId, p_changes: [{ key, expected_version: current.version, value }],
    });
  };
  return { ...f, rows, scalar, save, get, page, preference };
}

export const fails = (assert, promise, code) =>
  assert.rejects(promise, (error) => error.code === code || error.message === code);
