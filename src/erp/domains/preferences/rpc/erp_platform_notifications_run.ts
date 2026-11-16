// public.erp_platform_notifications_run(p_task, p_lease): a tarefa agendada
// que cria as notificações do dia (uma por usuário, tipo e dia), para quem
// recebe cada tipo (papel e preferência "notificacoes.<tipo>").
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { uuid } from "../args.ts";
import { NOTIFICATION_TYPES, addDays, notificationDigest, notificationRecipient } from "../home-notifications.ts";
import { taskHeld } from "../platform.ts";
import { saoPauloMidnight } from "../time.ts";

export function erpPlatformNotificationsRun(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const t = taskHeld(db, uuid(a, "p_task"), uuid(a, "p_lease"));
  if (t.purpose !== "notifications_generate") raise("22023", "erp_platform_task_input_invalid");
  const today = todaySaoPaulo();
  const a1Limit = saoPauloMidnight(addDays(today, 31));
  let created = 0;
  const members = db.exec('SELECT user_id, role FROM "erp_access__membership" WHERE active=1 ORDER BY user_id').rows;
  for (const type of NOTIFICATION_TYPES) {
    const d = notificationDigest(db, type, today, a1Limit);
    if (d.quantity <= 0) continue;
    for (const m of members) {
      if (!notificationRecipient(db, String(m.user_id), String(m.role), type)) continue;
      // ON CONFLICT(user_id, type, day) DO NOTHING: conta só as novas.
      if (one(db, 'SELECT 1 x FROM "erp_home__notification" WHERE user_id=? AND type=? AND day=?', m.user_id, type, today)) continue;
      db.exec(
        'INSERT INTO "erp_home__notification"(user_id, type, day, quantity, amount, created_at) VALUES (?,?,?,?,?,?)',
        m.user_id,
        type,
        today,
        d.quantity,
        d.amount === null ? null : d.amount.toString(),
        ctx.clock.next().toString(),
      );
      created++;
    }
  }
  return { scope: "platform_notifications", data_mode: "erp_native", day: today, created, members: members.length };
}

registerRpc("erp_platform_notifications_run", erpPlatformNotificationsRun);
