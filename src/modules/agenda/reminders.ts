// Lembrete da Agenda: `runDue(ctx, now)` acha os agendamentos cujo lembrete
// venceu e envia a mensagem com Confirmar, Remarcar e Cancelar. Roda no
// gancho periódico do núcleo (onSchedule) e pode ser chamada nos testes com
// qualquer `now`.
//
// Regras:
// - Lembra quem está "booked" (não confirmado), com conversa, ainda não
//   lembrado e com início entre `now` e `now + reminder_hours`.
// - Quem marcou ou remarcou já dentro dessa janela não recebe lembrete
//   (booked_at > starts - janela): acabou de falar com a casa.
// - Envio com `notification: true`: fora da janela de 24 h da linha oficial,
//   sai pelo modelo de notificação (só o texto, com as opções numeradas).
// - A chave de envio leva o agendamento e a remarcação: repetir a rodada não
//   repete a mensagem; remarcar gera um lembrete novo.
import { all, exec } from "../../db";
import type { Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { agendaConfig, fill } from "./config";
import { appointmentView, describe } from "./appointments";
import { reminderQuestion } from "./chat";

/** Lembretes por rodada (o resto fica para a próxima, em até 5 minutos). */
export const REMINDERS_PER_RUN = 50;

export interface RunDueResult {
  sent: string[];
  failed: string[];
}

export async function runDue(
  ctx: ModuleContext,
  now: number,
  options: { chat?: boolean } = {},
): Promise<RunDueResult> {
  const result: RunDueResult = { sent: [], failed: [] };
  await exec(
    ctx.env,
    "DELETE FROM agenda_chats WHERE profile_id=? AND expires_at<=?",
    ctx.profile,
    now,
  );
  const config = agendaConfig((await ctx.settings())?.agenda);
  if (!config.reminder_hours) return result;
  const window = config.reminder_hours * 3600000;
  const rows = await all(
    ctx.env,
    `SELECT a.*, p.name AS professional_name FROM agenda_appointments a
     LEFT JOIN agenda_professionals p ON p.id=a.professional_id
     WHERE a.profile_id=? AND a.status='booked' AND a.reminded_at IS NULL
       AND a.conversation_id IS NOT NULL AND a.starts>? AND a.starts<=?
       AND a.booked_at<=a.starts-?
     ORDER BY a.starts LIMIT ${REMINDERS_PER_RUN}`,
    ctx.profile,
    now,
    now + window,
    window,
  );
  for (const row of rows) {
    const a = appointmentView(
      row,
      new Map([[row.professional_id, row.professional_name || ""]]),
    );
    let c: Conversation;
    try {
      c = await ctx.conversation(a.conversation_id!);
    } catch {
      // Conversa apagada: não há a quem lembrar.
      await exec(
        ctx.env,
        "UPDATE agenda_appointments SET reminded_at=? WHERE id=? AND reminded_at IS NULL",
        now,
        a.id,
      );
      continue;
    }
    try {
      const text = fill(config.reminder_text, describe(a));
      const payload = options.chat
        ? await reminderQuestion(ctx, c, a, text, now)
        : {
            text: `${text}\n\nPara confirmar, remarcar ou cancelar, envie MENU e escolha Meus agendamentos.`,
          };
      await ctx.sendMessage(c, payload, {
        key: `reminder:${a.id}:${a.moves}`,
        notification: true,
      });
      await exec(
        ctx.env,
        "UPDATE agenda_appointments SET reminded_at=?,updated=? WHERE id=? AND reminded_at IS NULL",
        now,
        now,
        a.id,
      );
      result.sent.push(a.id);
    } catch (error) {
      // Linha removida, cota esgotada…: tenta de novo na próxima rodada.
      console.error(
        JSON.stringify({
          component: "agenda-reminder",
          profile: ctx.profile,
          appointment: a.id,
          error: String((error as Error)?.message || error).slice(0, 300),
        }),
      );
      result.failed.push(a.id);
    }
  }
  return result;
}
