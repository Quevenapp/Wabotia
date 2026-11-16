// Acesso: horário de acesso, permissões finas e escopo de MFA. Portado de
// erp_access.window_open/until, windows_valid, schedule_allows/until,
// permissions_valid, mfa_in_scope/required, mfa_sensitive_keys.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { jsonType } from "../../engine/json.ts";
import { saoPauloLocal, saoPauloParts } from "../../engine/time.ts";
import { sellerAccessAllowed } from "../catalog/public.ts";
import { mfaPolicyOn, permissionKeys, permissionParent } from "./public.ts";

type Window = { start: string; end: string; days: number[] };
const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

/** erp_access.window_open(p_windows, p_at): hora e dia de São Paulo dentro de uma janela. */
export function windowOpen(windows: Window[] | null, at: bigint): boolean {
  const { hm, dow } = saoPauloParts(at);
  return (windows ?? []).some((w) => hm >= w.start && hm <= w.end && Array.isArray(w.days) && w.days.includes(dow));
}

/** erp_access.window_until: o fim (com 59 s) da janela aberta mais longa agora; null sem janela. */
export function windowUntil(windows: Window[] | null, at: bigint): bigint | null {
  const { date, hm, dow } = saoPauloParts(at);
  let best: bigint | null = null;
  for (const w of windows ?? [])
    if (hm >= w.start && hm <= w.end && w.days.includes(dow)) {
      const [h, m] = w.end.split(":").map(Number);
      const until = saoPauloLocal(date, h * 3600 + m * 60 + 59);
      if (best === null || until > best) best = until;
    }
  return best;
}

/** erp_access.windows_valid: até 10 janelas {start, end, days} com dias 0–6 crescentes. */
export function windowsValid(p: unknown): boolean {
  if (jsonType(p) !== "array" || (p as unknown[]).length > 10) return false;
  const HM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  return (p as any[]).every(
    (w) =>
      jsonType(w) === "object" &&
      Object.keys(w).length === 3 &&
      jsonType(w.start) === "string" &&
      jsonType(w.end) === "string" &&
      HM.test(w.start) &&
      HM.test(w.end) &&
      w.start < w.end &&
      jsonType(w.days) === "array" &&
      w.days.length >= 1 &&
      w.days.length <= 7 &&
      w.days.every((d: unknown, i: number) => jsonType(d) === "number" && /^[0-6]$/.test(String(d)) && (i === 0 || (d as number) > w.days[i - 1])),
  );
}

/** erp_access.permissions_valid(p text[]): chaves conhecidas, sem repetição, com o pai presente. */
export function permissionsValid(p: (string | null)[] | null): boolean {
  if (p === null) return true;
  const keys = new Set(permissionKeys());
  return (
    p.length <= keys.size &&
    new Set(p).size === p.length &&
    !p.some((k) => k === null || !keys.has(k) || (permissionParent(k) !== null && !p.includes(permissionParent(k))))
  );
}

export const MFA_SENSITIVE = [
  "financas.caixas_bancos.transferencia", "financas.contas_pagar.baixar", "financas.contas_pagar.cancelar",
  "financas.contas_receber.baixar", "financas.contas_receber.cancelar", "financas.ficha.baixar", "financas.remessas.gerar",
  "financas.retornos.ie", "financas.boletos",
];

/** erp_access.mfa_in_scope: admin, financeiro ou permissão fina sensível. */
export function mfaInScope(db: SqlDriver, user: string): boolean {
  const r = one(
    db,
    `SELECT m.role, c.permissions FROM "erp_access__membership" m LEFT JOIN "erp_access__user_control" c ON c.user_id=m.user_id WHERE m.user_id=? AND m.active=1`,
    user,
  );
  if (!r) return false;
  if (["admin", "financeiro"].includes(String(r.role))) return true;
  const perms = parse(r.permissions) as string[] | null;
  return !!perms && perms.some((k) => MFA_SENSITIVE.includes(k));
}

/** erp_access.mfa_required */
export const mfaRequired = (db: SqlDriver, user: string) => mfaPolicyOn(db) && mfaInScope(db, user);


const isAdmin = (db: SqlDriver, user: string) =>
  !!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user);

/** erp_access.schedule_allows(p_user, p_at) */
export function scheduleAllows(db: SqlDriver, user: string, at: bigint): boolean {
  if (isAdmin(db, user)) return true;
  const c = one(db, 'SELECT schedule_enabled, windows FROM "erp_access__user_control" WHERE user_id=?', user);
  const own = c ? !c.schedule_enabled || windowOpen(parse(c.windows), at) : true;
  return own && sellerAccessAllowed(db, user, at);
}

/** erp_access.schedule_until(p_user, p_at): fim da janela em vigor; null sem limite ou fechado. */
export function scheduleUntil(db: SqlDriver, user: string, at: bigint): bigint | null {
  if (!scheduleAllows(db, user, at) || isAdmin(db, user)) return null;
  const c = one(db, 'SELECT schedule_enabled, windows FROM "erp_access__user_control" WHERE user_id=?', user);
  const s = one(db, 'SELECT access_hours_enabled, access_windows FROM "erp_catalog__seller" WHERE user_id=?', user);
  const own = c?.schedule_enabled ? windowUntil(parse(c.windows), at) : null;
  const sellerWindows = s ? (parse(s.access_windows) as Window[]) : [];
  const seller = s?.access_hours_enabled && sellerWindows.length > 0 ? windowUntil(sellerWindows, at) : null;
  // coalesce(…, infinity) e least(): a janela nula sem limite; nullif(…, infinity) no fim.
  const candidates = [c?.schedule_enabled ? own : undefined, s?.access_hours_enabled && sellerWindows.length > 0 ? seller : undefined];
  let least: bigint | null = null;
  for (const v of candidates) if (v !== undefined && v !== null && (least === null || v < least)) least = v;
  return least;
}

/** Permissões do controle em ordem de permission_keys(); null para admin ou sem controle. */
export function orderedPermissions(role: string | null, permissions: string[] | null): string[] | null {
  if (role === "admin" || permissions === null) return null;
  const order = permissionKeys();
  // array_position nulo (chave desconhecida) vai para o fim, como o NULLS LAST do jsonb_agg ordenado.
  const pos = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...permissions].sort((a, b) => pos(a) - pos(b));
}
