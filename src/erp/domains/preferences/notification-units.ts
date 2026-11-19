// O digest das notificações em unidades, para o agendador do ERP (sessão F)
// ceder a vez entre uma e outra dentro do alarme do objeto: o resumo de um
// tipo (uma vez por tipo e rodada) e a notificação de um usuário. Chamar
// notifyMember para cada membro ativo e cada tipo deixa o banco igual ao de
// erp_platform_notifications_run de uma vez (prova em
// tests/erp/preferences/notification-units.test.mjs). O
// erp_platform_notifications_run segue igual ao Fagoo, para o diferencial.
import { one, type SqlDriver } from "../../engine/driver.ts";
import type { Clock } from "../../engine/time.ts";
import { addDays, NOTIFICATION_TYPES, notificationDigest, notificationRecipient, notificationEnabled } from "./home-notifications.ts";
import { normalizeErpParts } from "../../parts.ts";
import { saoPauloMidnight } from "./time.ts";

export { NOTIFICATION_TYPES };

export interface NotificationDigest {
  quantity: number;
  /** centavos, ou null nos tipos sem valor */
  amount: bigint | null;
}

/** O resumo do tipo no dia (erp_home.notification_digest), com o corte do A1 em hoje + 31 dias. */
export function notificationDigestFor(db: SqlDriver, type: string, today: string, parts = normalizeErpParts()): NotificationDigest {
  return notificationDigest(db, type, today, saoPauloMidnight(addDays(today, 31)), parts);
}

/** Membros ativos, na ordem do erp_platform_notifications_run. */
export const activeMembers = (db: SqlDriver) =>
  db.exec('SELECT user_id, role FROM "erp_access__membership" WHERE active=1 ORDER BY user_id').rows.map((m) => ({ user_id: String(m.user_id), role: String(m.role) }));

/**
 * Grava a notificação do tipo no dia para um usuário, quando ele é
 * destinatário (papel e preferência "notificacoes.<tipo>"), o resumo tem
 * quantidade e ainda não há uma (uma por usuário, tipo e dia). Devolve true se gravou.
 */
export function notifyMember(db: SqlDriver, clock: Clock, user: string, type: string, today: string, digest: NotificationDigest, parts = normalizeErpParts()): boolean {
  if (!notificationEnabled(type, parts) || digest.quantity <= 0) return false;
  const m = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!m || !notificationRecipient(db, user, String(m.role), type, parts)) return false;
  if (one(db, 'SELECT 1 x FROM "erp_home__notification" WHERE user_id=? AND type=? AND day=?', user, type, today)) return false;
  db.exec(
    'INSERT INTO "erp_home__notification"(user_id, type, day, quantity, amount, created_at) VALUES (?,?,?,?,?,?)',
    user,
    type,
    today,
    digest.quantity,
    digest.amount === null ? null : digest.amount.toString(),
    clock.next().toString(),
  );
  return true;
}
