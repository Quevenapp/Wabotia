// Vendedores (erp_catalog.seller): regras que outros domínios chamam.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { actorLabel, windowOpen } from "../access/public.ts";
import { compareText } from "./fields.ts";

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
