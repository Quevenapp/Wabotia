// public.erp_catalog_contact_sales e erp_catalog_contact_history: os últimos 10
// pedidos nativos (authority 'brufap') do contato, sem acesso ao tipo de
// documento → visible=false e lista vazia; mais a cobertura do espelho
// (erp_document_mirror.report_coverage, mirrorReportCoverage dos Documentos).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { ErpError, raise } from "../../../engine/errors.ts";
import { arrow } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { mirrorReportCoverage, requireAccess as documentAccess } from "../../documents/public.ts";
import { requireAccess } from "../access.ts";
import { contactRequireVisible } from "../contact.ts";
import { compareText } from "../fields.ts";

function visibleKind(db: SqlDriver, user: string | null, kind: string): boolean {
  try {
    documentAccess(db, user, kind, false);
    return true;
  } catch (e) {
    if (e instanceof ErpError && e.code === "42501") return false;
    throw e;
  }
}

/** order by body->>'date' desc (nulos primeiro, collation C), number desc; limit 10. */
function lastDocuments(db: SqlDriver, contact: string, kind: string) {
  return db
    .exec(
      `SELECT id, CAST(number AS TEXT) number, body, status, CAST(total AS TEXT) total FROM "erp_documents__document"
       WHERE authority='brufap' AND kind=? AND contact_id=?`,
      kind, contact,
    )
    .rows.map((d): Record<string, unknown> & { date: string | null } => ({ ...(d as Record<string, unknown>), date: arrow(JSON.parse(String(d.body)), "date") as string | null }))
    .sort((x, y) => {
      if (x.date !== y.date) {
        if (x.date === null) return -1;
        if (y.date === null) return 1;
        return compareText(y.date, x.date);
      }
      if (x.number === null || x.number === undefined) return y.number === null || y.number === undefined ? 0 : -1;
      if (y.number === null || y.number === undefined) return 1;
      const a = BigInt(String(x.number)),
        b = BigInt(String(y.number));
      return a === b ? 0 : a > b ? -1 : 1;
    })
    .slice(0, 10)
    .map((d) => ({
      id: d.id,
      number: d.number ?? null,
      date: d.date,
      status: d.status,
      total: d.total === null || d.total === undefined ? null : formatScaled(fromColumn(d.total), 2),
    }));
}

function contactDocuments(ctx: RpcContext, user: string | null, contact: string | null, kind: string, scope: string, extra: Record<string, unknown>) {
  const db = ctx.db;
  if (contact === null || !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, contact))
    raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, contact);
  const visible = visibleKind(db, user, kind);
  return {
    scope,
    data_mode: "erp_native",
    contact_id: contact,
    ...extra,
    visible,
    items: visible ? lastDocuments(db, contact, kind) : [],
    ...mirrorReportCoverage(db, user, kind, null, null, contact),
  };
}

export function erpCatalogContactSales(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  requireAccess(ctx.db, user, "contacts", false);
  return contactDocuments(ctx, user, (a.p_contact_id ?? null) as string | null, "sales_orders", "contact_sales", {});
}

export function erpCatalogContactHistory(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const kind = (a.p_kind ?? null) as string | null;
  requireAccess(ctx.db, user, "contacts", false);
  if (kind === null || !["sales_orders", "purchase_orders"].includes(kind)) raise("22023", "erp_catalog_invalid_query");
  return contactDocuments(ctx, user, (a.p_contact_id ?? null) as string | null, kind, "contact_history", { kind });
}

registerRpc("erp_catalog_contact_sales", erpCatalogContactSales);
registerRpc("erp_catalog_contact_history", erpCatalogContactHistory);
