// Notificações da home (sino): os tipos, o resumo do dia por tipo, quem
// recebe e os prazos das preferências. Portado de erp_home.notification_types,
// notification_digest, notification_recipient, notification_roles,
// expiring_products, expiry_days e lot_expiry_days.
import { fromColumn } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { jsonType } from "../../engine/json.ts";
import { countPhysical, lotsExpiring } from "../stock/public.ts";
import { get } from "./public.ts";

export const NOTIFICATION_TYPES = [
  "contas_pagar_atrasadas", "contas_receber_atrasadas", "estoque_abaixo_minimo", "estoque_maximo", "estoque_zerado",
  "pagamento_efetuado", "pagamento_recebido", "proximo_contato", "cliente_visitado", "validade", "certificado_a1", "lote_vencimento",
];

/** erp_home.notification_roles(p_type) */
export function notificationRoles(type: string): string[] {
  if (["contas_pagar_atrasadas", "contas_receber_atrasadas", "pagamento_efetuado", "pagamento_recebido"].includes(type))
    return ["admin", "consulta", "financeiro"];
  if (["estoque_abaixo_minimo", "estoque_maximo", "estoque_zerado", "validade", "lote_vencimento"].includes(type))
    return ["admin", "consulta", "vendas", "estoque", "fiscal"];
  if (type === "proximo_contato") return ["admin", "consulta", "financeiro", "vendas"];
  if (type === "cliente_visitado") return ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"];
  if (type === "certificado_a1") return ["admin", "fiscal"];
  return [];
}

/** erp_home.notification_recipient(p_user, p_role, p_type): a lista da preferência, ou o administrador quando vazia. */
export function notificationRecipient(db: SqlDriver, user: string, role: string, type: string): boolean {
  if (!notificationRoles(type).includes(role)) return false;
  const list = get(db, `notificacoes.${type}`) ?? [];
  if (!Array.isArray(list) || list.length === 0) return role === "admin";
  return list.includes(user);
}

/** Dias de aviso de uma preferência numérica (0 a 9999), senão 0. */
function days(db: SqlDriver, key: string) {
  const v = get(db, key);
  return jsonType(v) === "number" && /^[0-9]{1,4}$/.test(String(v)) ? Number(v) : 0;
}
export const expiryDays = (db: SqlDriver) => days(db, "produtos.dias_aviso_validade");
export const lotExpiryDays = (db: SqlDriver) => days(db, "lotes.dias_aviso_validade");

export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** erp_home.expiring_products(p_from, p_until) */
export function expiringProducts(db: SqlDriver, from: string | null, until: string) {
  return db
    .exec(
      `SELECT r.id, r.code, r.name, d.expiry_date FROM "erp_catalog__product_detail" d JOIN "erp_catalog__record" r ON r.id=d.record_id
       WHERE r.active=1 AND d.deleted_at IS NULL AND d.expiry_date IS NOT NULL AND d.expiry_date<=? AND (? IS NULL OR d.expiry_date>=?)`,
      until,
      from,
      from,
    )
    .rows.map((r) => ({ id: String(r.id), code: (r.code as string | null) ?? null, name: String(r.name), expiry_date: String(r.expiry_date) }));
}

/**
 * erp_home.notification_digest(p_type, p_today): quantidade e valor (centavos,
 * ou null) do tipo no dia.
 */
export function notificationDigest(db: SqlDriver, type: string, today: string, a1Limit: bigint): { quantity: number; amount: bigint | null } {
  const count = (sql: string, ...params: unknown[]) => Number(one(db, sql, ...params)!.n);
  if (type === "contas_pagar_atrasadas" || type === "contas_receber_atrasadas") {
    const r = one(
      db,
      `SELECT count(*) n, CAST(sum(amount_cents-settled_cents) AS TEXT) s FROM "erp_finance__title"
       WHERE kind=? AND cancelled=0 AND due_on<? AND amount_cents>settled_cents`,
      type === "contas_pagar_atrasadas" ? "payable" : "receivable",
      today,
    )!;
    return { quantity: Number(r.n), amount: r.s === null ? null : fromColumn(r.s) };
  }
  if (type === "pagamento_efetuado" || type === "pagamento_recebido") {
    const r = one(
      db,
      `SELECT count(*) n, CAST(sum(s.principal_cents) AS TEXT) s FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id
       WHERE t.kind=? AND s.kind='payment' AND s.posted_on=?
       AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" r WHERE r.reverses_id=s.id)`,
      type === "pagamento_efetuado" ? "payable" : "receivable",
      today,
    )!;
    return { quantity: Number(r.n), amount: r.s === null ? null : fromColumn(r.s) };
  }
  if (type === "estoque_abaixo_minimo" || type === "estoque_maximo" || type === "estoque_zerado") {
    let n = 0;
    for (const p of db.exec(
      `SELECT p.record_id, CAST(p.stock_min AS TEXT) stock_min, CAST(p.stock_max AS TEXT) stock_max,
       EXISTS(SELECT 1 FROM "erp_stock__balance" b WHERE b.product_id=p.record_id) positioned
       FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE r.active=1 AND coalesce(p.kind,'P')='P'`,
    ).rows) {
      const stock = countPhysical(db, String(p.record_id), null);
      const min = p.stock_min === null ? null : fromColumn(p.stock_min);
      const max = p.stock_max === null ? null : fromColumn(p.stock_max);
      if (
        (type === "estoque_abaixo_minimo" && min !== null && stock < min) ||
        (type === "estoque_maximo" && max !== null && max > 0n && stock >= max) ||
        (type === "estoque_zerado" && Number(p.positioned) === 1 && stock <= 0n)
      )
        n++;
    }
    return { quantity: n, amount: null };
  }
  if (type === "proximo_contato")
    return {
      quantity: count(
        `SELECT count(*) n FROM "erp_documents__document" d WHERE d.authority='brufap' AND d.kind='sales_proposals'
         AND d.status NOT IN ('completed','cancelled','rejected') AND d.body->>'$.next_contact'=?`,
        today,
      ),
      amount: null,
    };
  if (type === "cliente_visitado")
    return {
      quantity: count(
        `SELECT count(*) n FROM "erp_catalog__contact_profile" cp JOIN "erp_catalog__record" r ON r.id=cp.record_id
         WHERE r.active=1 AND cp.next_visit=?`,
        today,
      ),
      amount: null,
    };
  if (type === "validade") return { quantity: expiringProducts(db, today, addDays(today, expiryDays(db))).length, amount: null };
  if (type === "lote_vencimento") return { quantity: lotsExpiring(db, today, addDays(today, lotExpiryDays(db))).length, amount: null };
  if (type === "certificado_a1") {
    let n = 0;
    for (const r of db.exec(
      `SELECT c.metadata FROM "erp_a1__head" h JOIN "erp_a1__credential" c ON c.id=h.credential_id WHERE h.singleton=1`,
    ).rows) {
      const meta = JSON.parse(String(r.metadata)) as Record<string, unknown>;
      const at = typeof meta.not_after === "string" ? Date.parse(meta.not_after) : NaN;
      if (!Number.isNaN(at) && BigInt(at) * 1000n < a1Limit) n++;
    }
    return { quantity: n, amount: null };
  }
  return { quantity: 0, amount: null };
}
