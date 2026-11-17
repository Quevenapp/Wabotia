// Vendedores (erp_catalog.seller): regras que outros domínios chamam.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { actorLabel, windowOpen } from "../access/public.ts";
import { compareText } from "./fields.ts";
import { fromColumn, formatScaled } from "../../engine/dec.ts";
import { raise } from "../../engine/errors.ts";
import { jsonTimestamp } from "../../engine/time.ts";

/**
 * erp_catalog.seller_access_allowed(p_user_id, p_at): o usuário vinculado a
 * um vendedor com horário de acesso só entra dentro de uma janela (hora e
 * dia de São Paulo, pela windowOpen do Acesso). Sem vendedor, sem horário
 * ligado ou sem janelas: liberado.
 */
export function sellerAccessAllowed(db: SqlDriver, user: string | null, at: bigint): boolean {
  if (user === null) return true;
  const s = one(db, 'SELECT access_hours_enabled, access_windows FROM "erp_catalog__seller" WHERE user_id=?', user);
  if (!s) return true;
  const windows = JSON.parse(String(s.access_windows));
  return !Number(s.access_hours_enabled) || windows.length === 0 || windowOpen(windows, at);
}

/**
 * erp_catalog.seller_users(): as pessoas ativas do ERP (até 500, por data de
 * entrada e id), para vincular um vendedor a um usuário.
 * Porte da sessão B (auxiliares do Catálogo).
 */
export function sellerUsers(db: SqlDriver): Record<string, unknown>[] {
  return db
    .exec('SELECT user_id, role, CAST(created_at AS TEXT) created_at FROM "erp_access__membership" WHERE active=1')
    .rows.sort((a, b) => {
      const x = BigInt(String(a.created_at)),
        y = BigInt(String(b.created_at));
      return x < y ? -1 : x > y ? 1 : compareText(String(a.user_id), String(b.user_id));
    })
    .slice(0, 500)
    .map((m) => ({ user_id: m.user_id, name: actorLabel(db, String(m.user_id)), role: m.role }));
}

/**
 * erp_catalog.seller_access(p_user_id, p_write): ler vendedores é de admin,
 * consulta, vendas e financeiro; escrever, só do administrador. Devolve o papel.
 * Porte da sessão B (auxiliares do Catálogo).
 */
export function sellerAccess(db: SqlDriver, user: string | null, write: boolean): string {
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const role = (m?.role as string | undefined) ?? null;
  if (role === null || !(write ? role === "admin" : ["admin", "consulta", "vendas", "financeiro"].includes(role)))
    raise("42501", "erp_catalog_access_denied");
  return role!;
}

/** erp_catalog.seller_dto(p_id): as configurações do vendedor (decimais em texto com 4 casas). */
export function sellerDto(db: SqlDriver, id: string): Record<string, unknown> | null {
  const s = one(
    db,
    `SELECT id, contact_id, CAST(version AS TEXT) version, user_id, allow_unregistered_products, view_stock, access_hours_enabled,
     access_windows, modules, commission_rule, commission_mode, CAST(commission_rate AS TEXT) commission_rate, commission_bands,
     CAST(discount_limit AS TEXT) discount_limit, notes, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at
     FROM "erp_catalog__seller" WHERE id=?`,
    id,
  );
  if (!s) return null;
  const dec = (v: unknown) => (v === null ? null : formatScaled(fromColumn(v), 4));
  return {
    id: s.id,
    contact_id: s.contact_id,
    version: Number(s.version),
    user_id: s.user_id,
    user_name: s.user_id === null ? null : actorLabel(db, String(s.user_id)),
    allow_unregistered_products: !!Number(s.allow_unregistered_products),
    view_stock: !!Number(s.view_stock),
    access_hours_enabled: !!Number(s.access_hours_enabled),
    access_windows: JSON.parse(String(s.access_windows)),
    modules: JSON.parse(String(s.modules)),
    commission_rule: s.commission_rule,
    commission_mode: s.commission_mode,
    commission_rate: dec(s.commission_rate),
    commission_bands: JSON.parse(String(s.commission_bands)),
    discount_limit: dec(s.discount_limit),
    notes: s.notes,
    created_at: jsonTimestamp(String(s.created_at)),
    updated_at: jsonTimestamp(String(s.updated_at)),
  };
}
