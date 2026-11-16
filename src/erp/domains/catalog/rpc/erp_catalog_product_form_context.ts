// public.erp_catalog_product_form_context: o CRT confirmado da empresa (campos fiscais do formulário).
import { one } from "../../../engine/driver.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { uuidArg } from "../pricing/args.ts";
import { requireAccess } from "../pricing/deps.ts";

registerRpc("erp_catalog_product_form_context", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  requireAccess(ctx.db, user, "products", false);
  const f = one(ctx.db, 'SELECT crt FROM "erp_company__fiscal" WHERE singleton=1 AND confirmed_at IS NOT NULL');
  return { crt: f ? (f.crt ?? null) : null, data_mode: "erp_native" };
});
