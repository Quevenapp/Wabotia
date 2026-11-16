// public.erp_pricing_applicable_lists e _v2: as listas vigentes que valem
// para um documento (contato, UF do documento ou do contato, vendedor e uma
// ou várias formas de pagamento).
import { raise } from "../../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { textArg, uuidArg } from "../args.ts";
import { compareText } from "../../fields.ts";
import { uuidArrayArg } from "../args.ts";
import {
  allLists,
  byFoldedName,
  categoryApplies,
  contactUf,
  leanHeader,
  requirePricing,
  UFS,
  validNow,
} from "../pricing.ts";

const invalidQuery = (): never => raise("22023", "erp_pricing_invalid_query");

export function erpPricingApplicableLists(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const contact = uuidArg(a, "p_contact_id");
  const seller = uuidArg(a, "p_seller_id");
  const method = uuidArg(a, "p_payment_method_id");
  const stateArg = textArg(a, "p_state");
  const db = ctx.db;
  requirePricing(db, user, false);
  if (stateArg !== null && !UFS.includes(stateArg)) invalidQuery();
  const state = stateArg ?? contactUf(db, contact);
  const items = allLists(db)
    .filter((l) => validNow(l) && categoryApplies(db, l, contact, seller, method === null ? [] : [method], state))
    .sort(byFoldedName((l) => l.name, (l) => l.id))
    .map((l) => leanHeader(db, l.id));
  return {
    data_mode: "erp_native",
    contact_id: contact,
    seller_id: seller,
    payment_method_id: method,
    state,
    items,
  };
}

export function erpPricingApplicableListsV2(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const contact = uuidArg(a, "p_contact_id");
  const seller = uuidArg(a, "p_seller_id");
  const methods = uuidArrayArg(a, "p_payment_method_ids");
  const stateArg = textArg(a, "p_state");
  const db = ctx.db;
  requirePricing(db, user, false);
  if (
    (stateArg !== null && !UFS.includes(stateArg)) ||
    (methods !== null &&
      (methods.length < 1 || methods.length > 20 || methods.includes(null) || new Set(methods).size !== methods.length))
  )
    invalidQuery();
  const state = stateArg ?? contactUf(db, contact);
  const ids = (methods ?? []) as string[];
  const items = allLists(db)
    .filter((l) => validNow(l) && categoryApplies(db, l, contact, seller, ids, state))
    .sort(byFoldedName((l) => l.name, (l) => l.id))
    .map((l) => leanHeader(db, l.id));
  return {
    data_mode: "erp_native",
    contact_id: contact,
    seller_id: seller,
    payment_method_ids: [...ids].sort(compareText),
    state,
    items,
  };
}

registerRpc("erp_pricing_applicable_lists", erpPricingApplicableLists);
registerRpc("erp_pricing_applicable_lists_v2", erpPricingApplicableListsV2);
