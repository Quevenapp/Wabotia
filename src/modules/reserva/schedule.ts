// Rodada periódica da Reserva: `runDue(ctx, now)` roda no gancho onSchedule
// do núcleo (ao menos a cada 5 minutos) e pode ser chamada nos testes com
// qualquer `now`. Cada tarefa escolhe "o que venceu até now e ainda não foi
// feito" e marca o registro na mesma rodada; os envios usam chaves derivadas
// da reserva (e do número de alterações), então uma rodada repetida não
// repete mensagem. Mensagens ao cliente saem com `notification: true`: fora
// da janela de 24 horas da linha oficial, pelo modelo de notificação.
//
// 1. Sinal vencido: libera a unidade.
// 2. Check-in: link (ou convite) `checkin_hours_before` antes da entrada.
// 3. Lembrete: `reminder_hours` antes da entrada, para quem reservou antes
//    dessa janela.
// 4. Mensagem de saída: `checkout_minutes_before` antes da saída, até 2 horas
//    depois dela (não manda mensagem velha se o módulo ficou desligado).
// 5. Reservas com a saída no passado ficam "completed".
import { all, exec } from "../../db";
import type { Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { fill, HOUR_MS, MINUTE_MS, reservaConfig } from "./config";
import { expireDue } from "./deposit";
import { bookingView, describe, publish, type Booking } from "./bookings";
import { checkinOpen, sendCheckin } from "./checkin";

/** Envios por tarefa e rodada (o resto fica para a próxima). */
export const PER_RUN = 30;

export interface RunDueResult {
  expired: string[];
  checkin: string[];
  reminded: string[];
  checkout: string[];
  completed: string[];
  failed: string[];
}

function logFailure(
  ctx: ModuleContext,
  task: string,
  id: string,
  error: unknown,
) {
  console.error(
    JSON.stringify({
      component: "reserva-schedule",
      task,
      profile: ctx.profile,
      booking: id,
      error: String((error as Error)?.message || error).slice(0, 300),
    }),
  );
}

async function conversationOf(ctx: ModuleContext, b: Booking) {
  try {
    return await ctx.conversation(b.conversation_id!);
  } catch {
    return null;
  }
}

export async function runDue(
  ctx: ModuleContext,
  now: number,
): Promise<RunDueResult> {
  const result: RunDueResult = {
    expired: [],
    checkin: [],
    reminded: [],
    checkout: [],
    completed: [],
    failed: [],
  };
  await exec(
    ctx.env,
    "DELETE FROM reserva_chats WHERE profile_id=? AND expires_at<=?",
    ctx.profile,
    now,
  );
  const config = reservaConfig((await ctx.settings())?.reserva);

  // 1. Sinal vencido: libera a unidade antes de qualquer outra coisa.
  result.expired = await expireDue(ctx, config, now);

  // 2. Check-in antes da entrada.
  if (config.checkin_enabled) {
    const rows = await all(
      ctx.env,
      `SELECT * FROM reserva_bookings WHERE profile_id=? AND status='confirmed' AND checkin_status='none'
         AND conversation_id IS NOT NULL AND arrival_at>? AND arrival_at<=?
       ORDER BY arrival_at LIMIT ${PER_RUN}`,
      ctx.profile,
      now,
      now + config.checkin_hours_before * HOUR_MS,
    );
    for (const row of rows) {
      const b = bookingView(row);
      if (!checkinOpen(config, b, now)) continue;
      const c = await conversationOf(ctx, b);
      if (!c) {
        await markCheckinSkipped(ctx, b.id, now);
        continue;
      }
      try {
        await sendCheckin(ctx, config, b, {
          trigger: "module",
          actor: "system",
          sourceKey: `checkin:${b.id}:${b.changes}`,
          at: now,
          conversation: c,
        });
        result.checkin.push(b.id);
      } catch (error) {
        logFailure(ctx, "checkin", b.id, error);
        result.failed.push(b.id);
      }
    }
  }

  // 3. Lembrete antes da entrada.
  if (config.reminder_hours) {
    const window = config.reminder_hours * HOUR_MS;
    const rows = await all(
      ctx.env,
      `SELECT * FROM reserva_bookings WHERE profile_id=? AND status='confirmed' AND reminded_at IS NULL
         AND conversation_id IS NOT NULL AND arrival_at>? AND arrival_at<=? AND created<=arrival_at-?
       ORDER BY arrival_at LIMIT ${PER_RUN}`,
      ctx.profile,
      now,
      now + window,
      window,
    );
    for (const row of rows) {
      const b = bookingView(row);
      const sent = await send(ctx, b, now, "reminded_at", async (c) => {
        const pending = checkinOpen(config, b, now);
        const text =
          fill(config.reminder_text, describe(b)) +
          (pending
            ? "\nAinda dá para fazer o check-in online: responda CHECKIN."
            : "");
        await ctx.sendMessage(
          c,
          { text },
          { key: `reminder:${b.id}:${b.changes}`, notification: true },
        );
      });
      (sent ? result.reminded : sent === null ? [] : result.failed).push(b.id);
    }
  }

  // 4. Mensagem de saída.
  if (config.checkout_message) {
    const rows = await all(
      ctx.env,
      `SELECT * FROM reserva_bookings WHERE profile_id=? AND status IN ('confirmed','completed') AND checkout_sent_at IS NULL
         AND conversation_id IS NOT NULL AND departure_at<=? AND departure_at>?
       ORDER BY departure_at LIMIT ${PER_RUN}`,
      ctx.profile,
      now + config.checkout_minutes_before * MINUTE_MS,
      now - 2 * HOUR_MS,
    );
    for (const row of rows) {
      const b = bookingView(row);
      const sent = await send(ctx, b, now, "checkout_sent_at", (c) =>
        ctx
          .sendMessage(
            c,
            { text: fill(config.checkout_text, describe(b)) },
            { key: `checkout:${b.id}:${b.changes}`, notification: true },
          )
          .then(() => undefined),
      );
      (sent ? result.checkout : sent === null ? [] : result.failed).push(b.id);
    }
  }

  // 5. Saída no passado: encerrada.
  const done = await all(
    ctx.env,
    "SELECT id FROM reserva_bookings WHERE profile_id=? AND status='confirmed' AND departure_at<=? ORDER BY departure_at LIMIT 50",
    ctx.profile,
    now,
  );
  for (const row of done) {
    const changed = await exec(
      ctx.env,
      "UPDATE reserva_bookings SET status='completed',updated=? WHERE id=? AND status='confirmed'",
      now,
      row.id,
    );
    if (!changed.meta?.changes) continue;
    const b = bookingView(
      (
        await all(ctx.env, "SELECT * FROM reserva_bookings WHERE id=?", row.id)
      )[0],
    );
    await publish(ctx, "reserva.completed", b, "system");
    result.completed.push(b.id);
  }
  return result;
}

/** Sem conversa (apagada): não há a quem enviar; não tenta de novo. */
async function markCheckinSkipped(ctx: ModuleContext, id: string, now: number) {
  await exec(
    ctx.env,
    "UPDATE reserva_bookings SET checkin_status='invited',checkin_sent_at=? WHERE id=? AND checkin_status='none'",
    now,
    id,
  );
}

/**
 * Envia e marca a coluna. true: enviado; null: sem conversa (marcado, não
 * tenta de novo); false: falhou (tenta na próxima rodada).
 */
async function send(
  ctx: ModuleContext,
  b: Booking,
  now: number,
  column: "reminded_at" | "checkout_sent_at",
  deliver: (c: Conversation) => Promise<void>,
) {
  const mark = () =>
    exec(
      ctx.env,
      `UPDATE reserva_bookings SET ${column}=? WHERE id=? AND ${column} IS NULL`,
      now,
      b.id,
    );
  const c = await conversationOf(ctx, b);
  if (!c) {
    await mark();
    return null;
  }
  try {
    await deliver(c);
    await mark();
    return true;
  } catch (error) {
    logFailure(ctx, column, b.id, error);
    return false;
  }
}
