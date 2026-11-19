// Regras do Meu Negócio que outros domínios usam (Documentos: save, cópia,
// lixeira, conversões e frete pago). Portado de erp_home.biz_role,
// biz_cost_visible, biz_freight e biz_unit_cost.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { toScaled } from "../../engine/dec.ts";
import { allowed as documentsAllowed, mirrorReportCoverage } from "../documents/public.ts";
import { compareText } from "./order.ts";
import { ERP_PART_KEYS, erpRequirement, erpRequirementMet, type ErpParts, type ErpRequirement } from "../../parts.ts";

/** Leituras mistas consultam o resolvedor comum antes de abrir uma fonte. */
export const queryAvailable = (parts: Readonly<ErpParts>, requirement: ErpRequirement | null) =>
  requirement !== null && erpRequirementMet(parts, requirement);

/** O DTO antigo continua idêntico quando todas as partes estão ligadas. */
export function unavailableParts(parts: Readonly<ErpParts>) {
  const unavailable_parts = ERP_PART_KEYS.filter(key => !parts[key]);
  return unavailable_parts.length ? { unavailable_parts } : {};
}

/** erp_home.biz_role(user): papel do membro ativo que lê pedidos de venda; senão 42501. */
export function bizRole(db: SqlDriver, user: string | null): string {
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r || !documentsAllowed(String(r.role), "sales_orders", false)) raise("42501", "erp_home_business_access_denied");
  return String(r!.role);
}

/** erp_home.biz_cost_visible(role): quem lê pedidos de compra vê custo. */
export const bizCostVisible = (role: string | null) => documentsAllowed(role, "purchase_orders", false);

/** erp_home.biz_freight(body): o frete do corpo em centavos (escala 2), ou 0 quando ausente ou fora do formato. */
export function bizFreight(body: unknown): bigint {
  const v = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).freight : undefined;
  const t = v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
  return t !== null && /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(t) ? toScaled(t, 2) : 0n;
}

/**
 * erp_home.biz_unit_cost(product): o preço unitário do pedido de compra mais
 * recente (não cancelado) do produto, como o texto numeric da coluna; ou null.
 * Ordem: data do corpo desc (sem data por último), criação desc, posição.
 */
export function bizUnitCost(db: SqlDriver, product: string | null): string | null {
  if (product === null) return null;
  const rows = db
    .exec(
      `SELECT json_extract(d.body,'$.date') day, CAST(d.created_at AS TEXT) created_at, i.position, i.unit_price FROM "erp_documents__document" d
       JOIN "erp_documents__item" i ON i.document_id=d.id WHERE d.kind='purchase_orders' AND d.status<>'cancelled' AND i.product_id=?`,
      product,
    )
    .rows.map((r) => ({ day: r.day === null ? null : typeof r.day === "string" ? r.day : String(r.day), created: BigInt(String(r.created_at)), position: Number(r.position), price: String(r.unit_price) }))
    .sort(
      (a, b) =>
        (a.day === null ? (b.day === null ? 0 : 1) : b.day === null ? -1 : compareText(b.day, a.day)) ||
        (a.created > b.created ? -1 : a.created < b.created ? 1 : 0) ||
        a.position - b.position,
    );
  return rows.length ? rows[0].price : null;
}

/** A cobertura legada agrega todos os donos; só é completa com ambos disponíveis. */
export function queryCoverage(ctx: import("../../engine/registry.ts").RpcContext, user: string | null, kind: string | null = null) {
  return queryAvailable(ctx.parts, erpRequirement("erp-vendas", "erp-compras")) ? mirrorReportCoverage(ctx.db, user, kind) : {};
}
