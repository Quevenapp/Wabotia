// public.erp_catalog_payment_method_page: ordem created_at desc, id desc; a
// busca (matches sobre fold(description)) fica em TS.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { boolArg, intArg, textArg, uuidArg } from "../args.ts";
import { CNTRL, chars, matches, searchTerms } from "../fields.ts";
import { fold } from "../internal.ts";
import { paymentMethodAccess, paymentMethodAccounts, paymentMethodDto } from "../payment-method.ts";

const APPLICABLE: Record<string, string[]> = {
  pagamentos: ["pagamentos", "ambos"],
  recebimentos: ["recebimentos", "ambos"],
  ambos: ["ambos"],
};

export function erpCatalogPaymentMethodPage(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const page = intArg(a, "p_page", 1);
  const size = intArg(a, "p_size", 100);
  const query = textArg(a, "p_query");
  const applicable = textArg(a, "p_applicable");
  const account = uuidArg(a, "p_account_id");
  const active = boolArg(a, "p_active", true);
  const role = paymentMethodAccess(ctx.db, user, false);
  if (
    page === null || page < 1 || page > 100000 || size === null || size < 1 || size > 100 ||
    (query !== null && (chars(query) > 120 || CNTRL.test(query))) ||
    (applicable !== null && !(applicable in APPLICABLE))
  )
    raise("22023", "erp_catalog_invalid_query");
  const terms = searchTerms(query);
  const rows = ctx.db
    .exec(
      `SELECT id, description, applicable FROM "erp_catalog__payment_method"
       WHERE deleted_at IS NULL AND (? IS NULL OR active=?) AND (? IS NULL OR account_id=?)
       ORDER BY created_at DESC, id DESC`,
      active === null ? null : Number(active),
      active === null ? null : Number(active),
      account,
      account,
    )
    .rows.filter(
      (m) =>
        (applicable === null || APPLICABLE[applicable].includes(String(m.applicable))) &&
        (terms === null || matches(terms, fold(String(m.description)), "", "")),
    );
  return {
    entity: "payment_methods",
    page,
    size,
    total: rows.length,
    can_write: ["admin", "financeiro"].includes(role),
    data_mode: "erp_native",
    accounts: paymentMethodAccounts(ctx.db),
    items: rows.slice((page - 1) * size, page * size).map((m) => paymentMethodDto(ctx.db, String(m.id))),
  };
}

registerRpc("erp_catalog_payment_method_page", erpCatalogPaymentMethodPage);
