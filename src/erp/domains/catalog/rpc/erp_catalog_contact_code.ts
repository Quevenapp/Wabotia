// public.erp_catalog_contact_code: modo do código de contato (preferência
// contatos.codigo), próximo número e o maior já usado.
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import * as preferences from "../../preferences/public.ts";
import { requireAccess } from "../access.ts";
import { contactCodeCounter, highestContactCode } from "../contact-code.ts";

/** erp_preferences.get(key) #>> '{}' */
const prefText = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === "string" ? value : jsonbText(value);

export function contactCode(ctx: RpcContext, user: string | null) {
  const role = requireAccess(ctx.db, user, "contacts", false);
  const counter = contactCodeCounter(ctx.db);
  const max = highestContactCode(ctx.db);
  return {
    scope: "contact_code",
    data_mode: "erp_native",
    mode: prefText(preferences.get(ctx.db, "contatos.codigo")) ?? "manual",
    next_number: (counter?.next ?? max + 1n).toString(),
    version: counter?.version ?? 0,
    highest_used: max.toString(),
    can_edit: role === "admin",
  };
}

registerRpc("erp_catalog_contact_code", (ctx: RpcContext, a: RpcArgs) => contactCode(ctx, ((a.p_user_id ?? null) as string | null)));
