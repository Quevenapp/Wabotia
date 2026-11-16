// Vendedores (erp_catalog.seller): regras que outros domínios chamam.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { windowOpen } from "../access/public.ts";

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
