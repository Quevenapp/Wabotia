// contact_type_create com a semeadura de produção (label__fold NULL nos tipos
// do sistema, achado da L; correção da semeadura com a N): o rótulo repetido
// sem acento nem caixa continua recusado (foldedKey cai no fold do valor
// quando a coluna está NULL). O SQLite fica de propósito diferente do
// Postgres nessa coluna, então a comparação é só da recusa, motor a motor.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { callRpc } from "../../../src/erp/engine/registry.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

test("tipo do sistema sem label__fold: 'cliente', 'TÉCNICO' e ' Fornecedor ' repetem rótulos ativos", async () => {
  f.lite.exec('UPDATE "erp_catalog__contact_type" SET label__fold=NULL WHERE system=1');
  for (const label of ["cliente", "TÉCNICO", " Fornecedor "]) {
    const args = { p_user_id: f.users.admin, p_command_id: randomUUID(), p_label: label };
    const pg = await f.db
      .query("select public.erp_catalog_contact_type_create(p_user_id=>$1, p_command_id=>$2, p_label=>$3) v", [args.p_user_id, args.p_command_id, label])
      .then(() => null, (e) => ({ code: e.code, message: e.message }));
    let lite = null;
    try {
      callRpc(f.driver, "erp_catalog_contact_type_create", args, f.clock);
    } catch (e) {
      lite = { code: e.code, message: e.message };
    }
    assert.deepEqual(pg, { code: "23505", message: "erp_catalog_contact_type_exists" }, `oráculo: ${label}`);
    assert.deepEqual(lite, pg, `motor: ${label}`);
  }
});
