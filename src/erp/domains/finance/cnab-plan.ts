// O que o CNAB (sessão G, bloco C5, a baixa pelo retorno) usa do Financeiro:
// erp_finance_execute dentro da mesma transação, o plano de caixa do crédito líquido
// (erp_finance.cnab_cash_plan, com o gatilho adiado cnab_cash_plan_check) e três leituras.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { assertSettlementPostings, defer, reserveCommand } from "./internal.ts";
import { erpFinanceExecute } from "./rpc/erp_finance_execute.ts";

/** public.erp_finance_execute na mesma transação: recibo, permissões, auditoria e gatilhos. */
export const execute = (ctx: RpcContext, user: string, command: string | null, action: string | null, data: unknown) =>
  erpFinanceExecute(ctx, { p_user_id: user, p_command_id: command, p_action: action, p_data: data });

export type CnabCashPlan = {
  command_id: string; event_id: string; title_id: string; account_id: string; actor: string;
  principal_cents: number; fee_cents: number; net_cash_cents: number; category_id: string; category_snapshot: unknown;
};

/**
 * INSERT em erp_finance.cnab_cash_plan. No Postgres a FK para erp_finance.command é
 * adiada (o plano vem antes do settle, que grava o recibo): aqui o recibo é reservado e o
 * erp_finance_execute desta transação não o toma por repetição. O gatilho adiado
 * cnab_cash_plan_check entra na fila do motor.
 */
export function insertCnabCashPlan(ctx: RpcContext, p: CnabCashPlan) {
  reserveCommand(ctx, p.command_id, p.actor, "");
  ctx.db.exec(
    `INSERT INTO "erp_finance__cnab_cash_plan"(command_id, event_id, title_id, account_id, actor, principal_cents, fee_cents, net_cash_cents, category_id, category_snapshot, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    p.command_id, p.event_id, p.title_id, p.account_id, p.actor, p.principal_cents, p.fee_cents, p.net_cash_cents, p.category_id,
    JSON.stringify(p.category_snapshot), ctx.clock.next().toString(),
  );
  defer(ctx, () => {
    // erp_finance.cnab_cash_plan_check
    const s = one(
      ctx.db,
      `SELECT s.id FROM "erp_finance__settlement" s JOIN "erp_cnab__operational_settlement" o ON o.settlement_id=s.id
        WHERE s.command_id=? AND s.kind='payment' AND o.command_id=? AND o.event_id=? AND json_extract(o.receipt,'$.policy')='itau109-net-credit-v1'`,
      p.command_id, p.command_id, p.event_id,
    );
    if (!s) raise("22023", "erp_finance_cnab_plan_incomplete");
    assertSettlementPostings(ctx.db, String(s.id));
  });
}

/** erp_finance.command existe (colisão de comando dá 40001 no chamador). */
export const commandExists = (db: SqlDriver, id: string) => !!one(db, 'SELECT 1 x FROM "erp_finance__command" WHERE id=?', id);

/** Movimentos de uma baixa, para o recibo: id, kind e delta_cents. */
export const settlementMovements = (db: SqlDriver, settlement: string) =>
  db.exec('SELECT id, kind, delta_cents FROM "erp_finance__movement" WHERE settlement_id=?', settlement).rows.map((r) => ({ id: String(r.id), kind: String(r.kind), delta_cents: Number(r.delta_cents) }));

/** Categoria para a tarifa do crédito líquido: kind, active e version (undefined se não existe). */
export function categoryForFee(db: SqlDriver, id: string) {
  const c = one(db, 'SELECT id, kind, active, version FROM "erp_finance__category" WHERE id=?', id);
  return c ? { id: String(c.id), kind: String(c.kind), active: c.active === 1 || c.active === true, version: Number(c.version) } : undefined;
}