// public.erp_finance_payment_methods: formas de pagamento oferecidas a uma
// conta a receber ou a pagar (padrão do propósito primeiro).
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { bool, cmpText, pgLower, requireAccess, uuidArg } from "../internal.ts";

const dec = (v: unknown, scale: number) => (v === null || v === undefined ? null : formatScaled(fromColumn(v), scale));

export function erpFinancePaymentMethods(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const kind = (a.p_kind as string | null) ?? null;
  requireAccess(ctx.db, user, false);
  if (kind === null || !["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_query");
  const rows = ctx.db
    .exec(
      `SELECT id, description, payment_type, account_id, interest_rate, fine_rate, fee_type, fee_rate, CAST(fee_fixed AS TEXT) fee_fixed, settlement_days, business_days, ${kind === "receivable" ? "default_receipt" : "default_payment"} purpose_default
         FROM "erp_catalog__payment_method" WHERE active=1 AND deleted_at IS NULL AND applicable IN ('ambos', ?)`,
      kind === "receivable" ? "recebimentos" : "pagamentos",
    )
    .rows.map((f): Record<string, unknown> => ({ ...f, purpose_default: bool(f.purpose_default) }))
    .sort(
      (x, y) =>
        Number(y.purpose_default) - Number(x.purpose_default) ||
        cmpText(pgLower(String(x.description)), pgLower(String(y.description))) ||
        cmpText(String(x.id), String(y.id)),
    )
    .slice(0, 200);
  return {
    entity: "payment_methods",
    kind,
    items: rows.map((f) => ({
      id: f.id,
      description: f.description,
      payment_type: f.payment_type,
      account_id: f.account_id,
      interest_rate: dec(f.interest_rate, 4),
      fine_rate: dec(f.fine_rate, 4),
      fee_type: f.fee_type,
      fee_rate: dec(f.fee_rate, 4),
      fee_fixed: dec(f.fee_fixed, 2),
      is_default: f.purpose_default,
      settlement_days: f.settlement_days,
      business_days: bool(f.business_days),
    })),
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_payment_methods", erpFinancePaymentMethods);
