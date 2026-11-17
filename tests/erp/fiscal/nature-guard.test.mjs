// Gatilho guard_nature do oráculo (BEFORE UPDATE OR DELETE de
// erp_fiscal_invoices.nature) contra natures.ts guardNature, que o motor chama
// antes de cada UPDATE da natureza (erp_fiscal_natures.ts). No oráculo a
// escrita direta roda numa transação desfeita (é o único gatilho BEFORE da
// tabela); no motor, a função no inTransaction. Modelo:
// tests/erp/stock/invoice-guards.test.mjs (N).
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { guardNature, natureIdentity } from "../../../src/erp/domains/fiscal/natures.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const execute = (action, data) => f.rpc("erp_fiscal_nature_execute", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: action, p_data: data });
const create = async () =>
  (await execute("create", { nature: { description: `Natureza da guarda ${randomUUID().slice(0, 8)}`, direction: "1", crt: "1", rules: [] } })).nature;

/**
 * A mesma escrita nos dois motores: `sql` no oráculo (desfeita) e, no motor, a
 * guarda com a linha antiga e a nova montada por `change`.
 */
function attempt(id, op, sql, args, change = (o) => ({ ...o, version: Number(o.version) + 1 })) {
  return f.dual(
    "guard_nature",
    async () => {
      await f.db.exec("begin");
      try {
        await f.db.query(sql, [id, ...args]);
        return "ok";
      } finally {
        await f.db.exec("rollback");
      }
    },
    () =>
      inTransaction(f.driver, (ctx) => {
        const o = natureIdentity(ctx.db, id);
        guardNature(op, o, op === "DELETE" ? null : change(o));
        return "ok";
      }),
  );
}
const refused = (code, message) => (e) => e.code === code && e.message === message;

test("guard_nature: a versão sobe de um em um e a identidade não muda", async (t) => {
  const n = await create();
  await attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set description='Outra', version=version+1 where id=$1", []);
  await t.assert.rejects(
    attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set version=version+2 where id=$1", [], (o) => ({ ...o, version: Number(o.version) + 2 })),
    refused("40001", "erp_fiscal_nature_immutable_identity"),
  );
  await t.assert.rejects(
    attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set version=version where id=$1", [], (o) => ({ ...o })),
    refused("40001", "erp_fiscal_nature_immutable_identity"),
  );
  await t.assert.rejects(
    attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set direction='0', version=version+1 where id=$1", [], (o) => ({ ...o, direction: "0", version: Number(o.version) + 1 })),
    refused("40001", "erp_fiscal_nature_immutable_identity"),
  );
  await t.assert.rejects(
    attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set created_by=$2, version=version+1 where id=$1", [f.users.fiscal], (o) => ({
      ...o, created_by: f.users.fiscal, version: Number(o.version) + 1,
    })),
    refused("40001", "erp_fiscal_nature_immutable_identity"),
  );
});

test("guard_nature: a natureza nunca é apagada", async (t) => {
  const n = await create();
  await t.assert.rejects(attempt(n.id, "DELETE", "delete from erp_fiscal_invoices.nature where id=$1", []), refused("42501", "erp_fiscal_nature_no_delete"));
});

test("guard_nature: a natureza excluída não muda mais", async (t) => {
  const n = await create();
  await execute("delete", { id: n.id, expected_version: 1 });
  await t.assert.rejects(
    attempt(n.id, "UPDATE", "update erp_fiscal_invoices.nature set description='Volta', version=version+1 where id=$1", []),
    refused("40001", "erp_fiscal_nature_deleted"),
  );
});
