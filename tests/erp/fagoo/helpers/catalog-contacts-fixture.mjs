// A interface de workers/erp-api/test/helpers/contacts-fixture.mjs do Fagoo
// (rpc, scalar, rows, users, save, get, page, preference) sobre a fixture
// dupla. O usuário "other" do Fagoo é o "vendedor" (papel vendas).
import { randomUUID } from "node:crypto";
import { pgSelect, pgToLite } from "../../../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../../../src/erp/schema/columns.generated.ts";
import { dualFixture } from "../../harness/dual-fixture.mjs";

const q = (id) => `"${id.replace(/"/g, '""')}"`;

/**
 * Semeadura com uuid aleatório no oráculo (gen_random_uuid na migração): os
 * tipos de contato do sistema têm ids diferentes nos dois motores e o
 * espelho do harness só copia tabela alterada. Até o harness alinhar (pedido
 * à N), a fixture copia as linhas do Postgres para o SQLite no início.
 */
async function alignSeed(f, tables) {
  f.lite.exec("PRAGMA foreign_keys=OFF");
  try {
    for (const t of tables) {
      const info = ERP_TABLES[t];
      const cols = Object.entries(info.columns).filter(([, c]) => !["fold", "computed"].includes(c.codec));
      f.lite.exec(`DELETE FROM ${q(t)}`);
      const ins = f.lite.prepare(`INSERT INTO ${q(t)} (${cols.map(([n]) => q(n)).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
      for (const r of (await f.db.query(pgSelect(info))).rows) ins.run(...cols.map(([n, c]) => pgToLite(r[n], c)));
    }
  } finally {
    f.lite.exec("PRAGMA foreign_keys=ON");
    f.lite.exec("DELETE FROM erp_changed");
  }
}

export async function contactsFixture() {
  const f = await dualFixture();
  await alignSeed(f, ["erp_catalog__contact_type"]);
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
