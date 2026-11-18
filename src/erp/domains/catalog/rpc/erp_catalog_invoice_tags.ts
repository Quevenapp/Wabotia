// public.erp_catalog_invoice_tags: as etiquetas de até 100 notas de uma origem
// e um modelo, na ordem pedida (marcadores da listagem de notas). Nota que a
// pessoa não enxerga recusa a consulta inteira (P0002), como no Fagoo.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// Origin: a nota espelhada se confere pelo visible do Fiscal (leitura de
// origin_sync), não por constante.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nativeVisible, requireRead, visible } from "../../fiscal/public.ts";
import { invoiceTagKeyValid, invoiceTagsData, requireInvoiceTags } from "../invoice-tags.ts";

export function erpCatalogInvoiceTags(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const origin = (a.p_origin ?? null) as string | null;
  const model = (a.p_model ?? null) as string | null;
  const ids = (a.p_ids ?? null) as (string | null)[] | null;
  const db = ctx.db;
  requireInvoiceTags(db, user, origin, false);
  requireRead(db, user);
  if (
    ids === null ||
    ids.length < 1 ||
    ids.length > 100 ||
    ids.includes(null) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !invoiceTagKeyValid(origin, model, id))
  )
    raise("22023", "erp_catalog_invalid_query");
  const keys = ids as string[];
  if (keys.some((id) => !(origin === "origin" ? visible(db, user, model === "55" ? "nfe" : "nfce", id) : nativeVisible(db, user, id))))
    raise("P0002", "erp_catalog_not_found");
  return {
    scope: "invoice_tags",
    origin,
    model,
    data_mode: "erp_native",
    items: keys.map((id) => invoiceTagsData(db, origin!, model!, id)),
  };
}

registerRpc("erp_catalog_invoice_tags", erpCatalogInvoiceTags);
