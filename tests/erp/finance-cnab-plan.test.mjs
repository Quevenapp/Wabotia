// O que o CNAB (bloco C5) usa do Financeiro: execute na mesma transação e a reserva do recibo
// que o cnab_cash_plan faz (FK adiada no Postgres). Só a mecânica do motor: o fluxo inteiro do
// crédito líquido (com o retorno do CNAB e o gatilho adiado cnab_cash_plan_check) é conferido
// contra o oráculo nos testes do C5 da sessão G.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { reserveCommand } from "../../src/erp/domains/finance/internal.ts";
import { categoryForFee, commandExists, execute, settlementMovements } from "../../src/erp/domains/finance/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

test("recibo reservado não é repetição; o settle grava o recibo final; a repetição depois devolve replayed", async () => {
  const u = f.users;
  const contact = await f.catalog("contacts", { roles: ["customer"], name: "Cliente plano CNAB" });
  const account = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa plano", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const category = (await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "payable", name: "Tarifa plano" } })).record;
  await f.rpc("erp_finance_title_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create", p_data: { kind: "receivable", contact_id: contact.id, description: "Conta plano", issued_on: "2026-10-01", competence_on: "2026-10-01", total_cents: "1000", installments: [{ amount_cents: "1000", due_on: "2026-10-10" }] } });
  const title = (await f.db.query("select id, version from erp_finance.title where description=$1", ["Conta plano"])).rows[0];
  const command = randomUUID();
  const data = { id: title.id, expected_version: title.version, account_id: account.id, posted_on: "2026-10-10", principal_cents: "1000" };
  // Só no SQLite: o estado diverge do oráculo daqui em diante, e o teste não chama mais f.rpc.
  const r = inTransaction(f.driver, (ctx) => {
    reserveCommand(ctx, command, u.admin, "");
    return execute(ctx, u.financeiro, command, "settle", data);
  });
  assert.equal(r.replayed, false);
  assert.ok(r.settlement?.id);
  const row = f.driver.exec('SELECT actor, request_hash FROM "erp_finance__command" WHERE id=?', command).rows[0];
  assert.equal(row.actor, u.financeiro, "o recibo final é do settle, não da reserva");
  assert.notEqual(row.request_hash, "", "o hash da reserva foi trocado");
  const again = inTransaction(f.driver, (ctx) => execute(ctx, u.financeiro, command, "settle", data));
  assert.equal(again.replayed, true);
  assert.equal(again.settlement.id, r.settlement.id);
  const other = inTransaction(f.driver, (ctx) => {
    try {
      return execute(ctx, u.admin, command, "settle", data);
    } catch (e) {
      return e.code;
    }
  });
  assert.equal(other, "40001", "outro ator com o mesmo comando é colisão");
  inTransaction(f.driver, (ctx) => {
    assert.equal(commandExists(ctx.db, command), true);
    assert.equal(commandExists(ctx.db, randomUUID()), false);
    assert.ok(settlementMovements(ctx.db, r.settlement.id).some((m) => m.kind === "payment" && m.delta_cents === 1000));
    assert.deepEqual(categoryForFee(ctx.db, category.id), { id: category.id, kind: "payable", active: true, version: category.version });
    assert.equal(categoryForFee(ctx.db, randomUUID()), undefined);
  });
});
