// Ajudantes do Documentos (documents/internal.ts) e a política de comissão do Financeiro contra o oráculo:
// text_value, decimal_value, date_value, uuid_value, price_decimals, quantity_decimals, discount_approver,
// approval_situations e erp_finance.commission_policy, com entradas válidas e inválidas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  approvalSituations,
  dateValue,
  decimalValue,
  discountApprover,
  priceDecimals,
  quantityDecimals,
  textValue,
  uuidValue,
} from "../../../src/erp/domains/documents/internal.ts";
import { commissionPolicy } from "../../../src/erp/domains/finance/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const lite = (fn) => {
  try {
    return { ok: inTransaction(f.driver, (ctx) => fn(ctx.db)) };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};
const pg = async (sql, args) => {
  try {
    return { ok: (await f.db.query(sql, args)).rows[0].v };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};
const sql = async (text, args = []) => {
  await f.db.query(text, args);
  await f.sync();
};

const VALUES = [null, "abc", "  abc  ", "", "   ", "a\nb", "a\tb", "a\u0001b", "x".repeat(10), "x".repeat(11), 5, true, ["a"], { a: 1 }, "Ágil", "2026-02-30", "2026-03-01", "1899-12-31", "2099-12-31",
  "0", "01", "1.5", "123.456", "1234567", "-1", "1.", ".5", "12345678-1234-1234-1234-123456789ABC", "12345678-1234-1234-1234-12345678", "1e3"];

test("text_value, date_value e uuid_value: mesmo valor ou erro que o Postgres", async () => {
  for (const value of VALUES)
    for (const [max, required, multiline] of [[10, false, false], [10, true, false], [5, false, true], [36, true, true]]) {
      const json = value === null ? null : JSON.stringify(value);
      assert.deepEqual(lite(() => textValue(value, max, required, multiline)), await pg("select erp_documents.text_value($1::jsonb,$2,$3,$4) v", [json, max, required, multiline]), `text ${json} ${max} ${required} ${multiline}`);
      if (!multiline) {
        assert.deepEqual(lite(() => dateValue(value, required)), await pg("select erp_documents.date_value($1::jsonb,$2)::text v", [json, required]), `date ${json} ${required}`);
        const uuid = await pg("select erp_documents.uuid_value($1::jsonb,$2)::text v", [json, required]);
        assert.deepEqual(lite(() => uuidValue(value, required)), uuid, `uuid ${json} ${required}`);
      }
    }
});

test("decimal_value e price_decimals", async () => {
  for (const value of VALUES)
    for (const [precision, digits] of [[2, 6], [4, 3], [10, 14]]) {
      const json = value === null ? null : JSON.stringify(value);
      const want = await pg("select erp_documents.decimal_value($1::jsonb,$2,$3)::text v", [json, precision, digits]);
      const got = lite(() => decimalValue(value, precision, digits));
      // numeric::text guarda as casas digitadas: o texto validado é o mesmo número.
      assert.deepEqual(got, want, `decimal ${json} ${precision} ${digits}`);
    }
  for (const price of [null, "10", "10.5", "10.50", "10.0000", "0.0001", "3.14159", "7."])
    assert.deepEqual(lite(() => priceDecimals(price)), await pg("select erp_documents.price_decimals($1) v", [price]), `price ${price}`);
});

test("quantity_decimals, discount_approver, approval_situations e commission_policy pelas preferências", async () => {
  const save = async (page, key, value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page })).items.find((item) => item.key === key);
    if (JSON.stringify(current.value) === JSON.stringify(value)) return;
    await f.rpc("erp_preferences_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: page, p_changes: JSON.stringify([{ key, expected_version: current.version, value }]) });
  };
  const check = async () => {
    assert.deepEqual(lite((db) => quantityDecimals(db)), await pg("select erp_documents.quantity_decimals() v", []), "quantity_decimals");
    assert.deepEqual(lite((db) => commissionPolicy(db)), await pg("select erp_finance.commission_policy() v", []), "commission_policy");
    assert.deepEqual(lite((db) => approvalSituations(db)), await pg("select erp_documents.approval_situations()::text[] v", []), "approval_situations");
    for (const user of [...Object.values(f.users), randomUUID(), null])
      for (const kind of ["sales_orders", "sales_proposals", "service_orders", null])
        assert.deepEqual(lite((db) => discountApprover(db, user, kind)), await pg("select erp_documents.discount_approver($1,$2) v", [user, kind]), `approver ${kind}`);
  };
  await check();
  await save("vendas-vendas", "vendas.base_comissao", ["desconto", "frete"]);
  await check();
  await save("vendas-vendas", "vendas.base_comissao", []);
  await check();
  const control = (user, permissions) =>
    sql("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,now(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1", [user, permissions, f.users.admin]);
  await control(f.users.vendas, ["vendas.pedidos_venda", "vendas.pedidos_venda.limite_desconto", "vendas.propostas"]);
  await control(f.users.consulta, ["vendas.propostas", "vendas.propostas.limite_desconto"]);
  await check();
});
