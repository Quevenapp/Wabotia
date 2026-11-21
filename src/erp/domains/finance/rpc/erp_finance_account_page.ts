// public.erp_finance_account_page e public.erp_finance_account_detail:
// lista paginada e detalhe das Contas Financeiras.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { storeFilter } from "../../stores/public.ts";
import { accountView, byLowerThenId, btrim, charLength, CNTRL, pgLower, requireAccess, uuidArg } from "../internal.ts";

const TYPES = ["checking", "savings", "cash", "receiving", "other", "integration"];

export function erpFinanceAccountPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const page = (a.p_page as number | null);
  const limit = (a.p_limit as number | null);
  const query = (a.p_query as string | null) ?? null;
  const active = (a.p_active as boolean | null) ?? null;
  const types = (a.p_types as string[] | null) ?? null;
  const needle = query === null ? null : btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    page === null ||
    page < 1 ||
    page > 100000 ||
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (types !== null &&
      (!Array.isArray(types) ||
        types.some((t) => Array.isArray(t)) ||
        types.length < 1 ||
        types.length > 6 ||
        types.includes(null as unknown as string) ||
        new Set(types).size !== types.length ||
        types.some((t) => !TYPES.includes(t))))
  )
    raise("22023", "erp_finance_invalid_query");
  const inStore = storeFilter(ctx, user);
  const rows = db
    .exec(
      'SELECT id, name, active, account_type, institution_name, institution_code, agency, account_number FROM "erp_finance__account" WHERE deleted_at IS NULL',
    )
    .rows.filter(
      (r) =>
        // Lojas (versão 27): com duas lojas ou mais, só as contas (e caixas) das lojas que a pessoa vê.
        (inStore === null || inStore.account(r.id)) &&
        (active === null || !!r.active === active) &&
        (types === null || types.includes(String(r.account_type))) &&
        (needle === null ||
          pgLower(
            [r.name, r.institution_name, r.institution_code, r.agency, r.account_number].filter((v) => v !== null).join(" "),
          ).includes(needle)),
    )
    .sort(byLowerThenId("name"));
  const items = rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((r) => accountView(db, String(r.id)));
  return { entity: "financial_accounts", items, page, limit, total: rows.length, data_mode: "erp_native" };
}

export function erpFinanceAccountDetail(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const id = uuidArg(a.p_id);
  requireAccess(ctx.db, user, false);
  if (id === null) raise("22023", "erp_finance_invalid_query");
  const v = accountView(ctx.db, id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { entity: "financial_accounts", record: v, data_mode: "erp_native" };
}

registerRpc("erp_finance_account_page", erpFinanceAccountPage);
registerRpc("erp_finance_account_detail", erpFinanceAccountDetail);
