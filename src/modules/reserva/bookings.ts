// Reservas: criar, alterar, cancelar, confirmar. A criação e a alteração são
// um único INSERT/UPDATE condicionado à ausência de outra reserva ativa da
// mesma unidade no intervalo (e de bloqueio, salvo `force`): o banco aplica
// cada instrução de uma vez, então dois pedidos simultâneos nunca ficam com a
// mesma unidade, venham do painel, da API ou do WhatsApp. Os comandos ainda
// rodam serializados no Coordinator da área.
import { all, exec, one } from "../../db";
import {
  ApiError,
  type Conversation,
  json,
  now as clock,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import {
  brasiliaDate,
  clockOf,
  depositFor,
  fill,
  money,
  moment,
  type ReservaConfig,
} from "./config";
import { getUnit, type Unit } from "./units";
import {
  ACTIVE,
  ACTIVE_SQL,
  periodOf,
  periodRefusal,
  refusalError,
  type Period,
  type PeriodInput,
} from "./availability";

export type BookingStatus =
  "pending_payment" | "confirmed" | "cancelled" | "expired" | "completed";
export type Source = "whatsapp" | "panel" | "api";
export const STATUSES: BookingStatus[] = [
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
  "completed",
];

export interface Booking {
  id: string;
  number: number;
  unit_id: string;
  unit_name: string;
  mode: "daily" | "hourly";
  /** Dia de entrada e de saída em Brasília (por hora: o mesmo dia). */
  start_date: string;
  end_date: string;
  starts: number;
  ends: number;
  arrival_at: number;
  departure_at: number;
  /** "14:00" e "12:00" em Brasília, para quem mostra sem converter. */
  arrival_time: string;
  departure_time: string;
  nights: number | null;
  duration_minutes: number | null;
  guests: number;
  status: BookingStatus;
  conversation_id: string | null;
  contact_id: string | null;
  customer_name: string;
  customer_phone: string;
  notes: string;
  source: Source;
  price_cents: number;
  deposit_cents: number;
  payment_id: string | null;
  payment_status: string | null;
  payment_error: string | null;
  payment_due_at: number | null;
  paid_at: number | null;
  confirmed_at: number | null;
  confirmed_by: string | null;
  checkin_status: "none" | "invited" | "sent" | "completed";
  checkin_step_id: string | null;
  checkin_sent_at: number | null;
  checkin_at: number | null;
  checkin_answers: Record<string, string | boolean> | null;
  reminded_at: number | null;
  checkout_sent_at: number | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string;
  changes: number;
  created_by: string;
  created: number;
  updated: number;
}

export function bookingView(row: any): Booking {
  const daily = row.mode === "daily";
  return {
    id: row.id,
    number: row.number,
    unit_id: row.unit_id,
    unit_name: row.unit_name,
    mode: row.mode,
    start_date: brasiliaDate(row.starts),
    end_date: daily ? brasiliaDate(row.ends) : brasiliaDate(row.ends - 1),
    starts: row.starts,
    ends: row.ends,
    arrival_at: row.arrival_at,
    departure_at: row.departure_at,
    arrival_time: clockOf(row.arrival_at),
    departure_time: clockOf(row.departure_at),
    nights: daily ? Math.round((row.ends - row.starts) / 86400000) : null,
    duration_minutes: daily
      ? null
      : Math.round((row.ends - row.starts) / 60000),
    guests: row.guests,
    status: row.status,
    conversation_id: row.conversation_id || null,
    contact_id: row.contact_id || null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    notes: row.notes,
    source: row.source,
    price_cents: row.price_cents,
    deposit_cents: row.deposit_cents,
    payment_id: row.payment_id || null,
    payment_status: row.payment_status || null,
    payment_error: row.payment_error || null,
    payment_due_at: row.payment_due_at ?? null,
    paid_at: row.paid_at ?? null,
    confirmed_at: row.confirmed_at ?? null,
    confirmed_by: row.confirmed_by ?? null,
    checkin_status: row.checkin_status,
    checkin_step_id: row.checkin_step_id || null,
    checkin_sent_at: row.checkin_sent_at ?? null,
    checkin_at: row.checkin_at ?? null,
    checkin_answers: row.checkin_answers
      ? json(row.checkin_answers, null)
      : null,
    reminded_at: row.reminded_at ?? null,
    checkout_sent_at: row.checkout_sent_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    cancelled_by: row.cancelled_by ?? null,
    cancel_reason: row.cancel_reason,
    changes: row.changes,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
  };
}

export async function getBooking(ctx: ModuleContext, id: string) {
  const row = await one(
    ctx.env,
    "SELECT * FROM reserva_bookings WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Reserva não encontrada.");
  return bookingView(row);
}

export async function listBookings(
  ctx: ModuleContext,
  filter: {
    from?: number;
    to?: number;
    status?: string;
    unit_id?: string;
    conversation_id?: string;
    q?: string;
    limit?: number;
  },
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  if (filter.from !== undefined) {
    where.push("ends>?");
    args.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("starts<?");
    args.push(filter.to);
  }
  if (filter.status) {
    const statuses = filter.status.split(",").filter(Boolean);
    requireValue(
      statuses.every((s) => STATUSES.includes(s as BookingStatus)),
      `status: ${STATUSES.join(", ")} (separados por vírgula).`,
    );
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (filter.unit_id) {
    where.push("unit_id=?");
    args.push(filter.unit_id);
  }
  if (filter.conversation_id) {
    where.push("conversation_id=?");
    args.push(filter.conversation_id);
  }
  const q = (filter.q || "").trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    const number = /^#?\d{1,7}$/.test(q) ? Number(q.replace("#", "")) : null;
    where.push(
      `(customer_name LIKE ?${digits.length >= 4 ? " OR customer_phone LIKE ?" : ""}${number !== null ? " OR number=?" : ""})`,
    );
    args.push(`%${q.replace(/[%_]/g, "")}%`);
    if (digits.length >= 4) args.push(`%${digits}%`);
    if (number !== null) args.push(number);
  }
  const limit = Math.min(Math.max(filter.limit || 500, 1), 1000);
  const rows = await all(
    ctx.env,
    `SELECT * FROM reserva_bookings WHERE ${where.join(" AND ")} ORDER BY starts LIMIT ${limit}`,
    ...args,
  );
  return rows.map(bookingView);
}

/** Próximas reservas ativas do cliente da conversa (ou do mesmo telefone). */
export async function upcomingFor(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
) {
  const phone = (c.phone || "").replace(/\D/g, "");
  const rows = await all(
    ctx.env,
    `SELECT * FROM reserva_bookings WHERE profile_id=? AND status IN ${ACTIVE_SQL} AND departure_at>? AND (conversation_id=?${phone ? " OR customer_phone=?" : ""}) ORDER BY starts LIMIT 20`,
    ctx.profile,
    at,
    c.id,
    ...(phone ? [phone] : []),
  );
  return rows.map(bookingView);
}

// ---------------------------------------------------------------------------
// Mensagens ao cliente e eventos

export function describe(b: Booking) {
  return {
    numero: `#${b.number}`,
    unidade: b.unit_name,
    entrada: moment(b.arrival_at),
    saida: moment(b.departure_at),
    nome: b.customer_name.split(" ")[0] || "",
    valor: money(b.price_cents),
    sinal: money(b.deposit_cents),
    prazo: b.payment_due_at ? moment(b.payment_due_at) : "",
  };
}

/** Resumo de uma linha: "Suíte Mar · sex 20/11 a dom 22/11 · 2 diárias". */
export function summaryLine(b: Booking) {
  const stay =
    b.mode === "daily"
      ? `${moment(b.arrival_at)} a ${moment(b.departure_at)} · ${b.nights} ${b.nights === 1 ? "diária" : "diárias"}`
      : `${moment(b.arrival_at)} a ${clockOf(b.departure_at)}`;
  return `${b.unit_name} · ${stay}`;
}

/** Avisa o cliente da conversa ligada à reserva (janela de 24 h). */
export async function notifyCustomer(
  ctx: ModuleContext,
  b: Booking,
  text: string,
  key: string,
  actor = "system",
) {
  if (!b.conversation_id) return null;
  let c: Conversation;
  try {
    c = await ctx.conversation(b.conversation_id);
  } catch {
    return null;
  }
  return ctx.sendMessage(c, { text }, { key, actor, notification: true });
}

export async function publish(
  ctx: ModuleContext,
  kind: string,
  b: Booking,
  actor: string,
  extra: Record<string, unknown> = {},
) {
  await ctx.publish(kind, b.id, {
    booking: b,
    conversation_id: b.conversation_id,
    actor,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Criar

export interface BookInput extends PeriodInput {
  /** Id da reserva (idempotência: o mesmo id não reserva duas vezes). */
  id?: string;
  unit_id: string;
  guests?: unknown;
  conversation?: Conversation | null;
  customer_name?: unknown;
  customer_phone?: unknown;
  notes?: unknown;
  source: Source;
  actor: string;
  /** Equipe: sem antecedência, estadia máxima e passo de horários. */
  staff?: boolean;
  /** Equipe: aceita sobre um bloqueio (nunca sobre outra reserva). */
  force?: boolean;
  /** Pedir o sinal das regras (padrão: só pelo WhatsApp). */
  deposit?: boolean;
  /** Avisar o cliente da conversa (padrão: só quando não foi ele quem reservou). */
  notify?: boolean;
  at?: number;
}

export function guestsOf(value: unknown, unit: Unit) {
  if (value === undefined || value === null) return 1;
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= 1000,
    "guests: número de pessoas de 1 a 1000.",
  );
  return value as number;
}

function customerOf(
  input: { customer_name?: unknown; customer_phone?: unknown; notes?: unknown },
  c: Conversation | null,
  contact: { name?: string; phone?: string } | null,
) {
  const name = String(
    input.customer_name ?? contact?.name ?? c?.title ?? "",
  ).trim();
  const phone = String(
    input.customer_phone ?? contact?.phone ?? c?.phone ?? "",
  ).replace(/\D/g, "");
  requireValue(
    Array.from(name).length <= 120 && phone.length <= 20,
    "Nome até 120 caracteres e telefone até 20 dígitos.",
  );
  const notes = String(input.notes ?? "").trim();
  requireValue(
    Array.from(notes).length <= 1000,
    "Observação até 1000 caracteres.",
  );
  return { name, phone, notes };
}

/** Confere o período contra as regras e a ocupação (lança a recusa). */
export async function requireFree(
  ctx: ModuleContext,
  config: ReservaConfig,
  unit: Unit,
  period: Period,
  at: number,
  options: {
    guests?: number;
    staff?: boolean;
    force?: boolean;
    ignore?: string;
  },
) {
  const refusal = await periodRefusal(ctx, config, unit, period, at, options);
  if (refusal) throw refusalError(refusal, config, unit);
}

/** Sinal desta reserva conforme as regras (0 = sem sinal). */
export function depositOf(
  config: ReservaConfig,
  period: Period,
  input: {
    deposit?: boolean;
    source: Source;
    conversation?: Conversation | null;
  },
) {
  const wanted = input.deposit ?? input.source === "whatsapp";
  if (!wanted || !input.conversation) return 0;
  return depositFor(config, period.price_cents);
}

export async function createBooking(
  ctx: ModuleContext,
  config: ReservaConfig,
  input: BookInput,
) {
  const at = input.at ?? clock();
  if (input.id) {
    const existing = await one(
      ctx.env,
      "SELECT id FROM reserva_bookings WHERE id=? AND profile_id=?",
      input.id,
      ctx.profile,
    );
    if (existing)
      return { booking: await getBooking(ctx, input.id), created: false };
  }
  requireValue(
    typeof input.unit_id === "string" && input.unit_id,
    "Informe unit_id.",
  );
  const unit = await getUnit(ctx, input.unit_id);
  requireValue(
    !(await one(
      ctx.env,
      "SELECT 1 FROM reserva_units WHERE id=? AND archived=1",
      unit.id,
    )),
    "Esta unidade foi excluída.",
  );
  const period = periodOf(config, unit, input);
  const guests = guestsOf(input.guests, unit);
  await requireFree(ctx, config, unit, period, at, {
    guests,
    staff: input.staff,
    force: input.force,
  });
  const c = input.conversation || null;
  const contact = c ? await ctx.contact(c) : null;
  const customer = customerOf(input, c, contact);
  const deposit = depositOf(config, period, input);
  const status: BookingStatus = deposit > 0 ? "pending_payment" : "confirmed";
  const due = deposit > 0 ? at + config.deposit_deadline_minutes * 60000 : null;
  const id = input.id || uid();
  const inserted = await exec(
    ctx.env,
    `INSERT INTO reserva_bookings(id,profile_id,number,unit_id,unit_name,mode,starts,ends,arrival_at,departure_at,guests,status,conversation_id,contact_id,customer_name,customer_phone,notes,source,price_cents,deposit_cents,payment_due_at,confirmed_at,confirmed_by,created_by,created,updated)
     SELECT ?,?,(SELECT coalesce(max(number),0)+1 FROM reserva_bookings WHERE profile_id=?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM reserva_bookings WHERE profile_id=? AND unit_id=? AND status IN ${ACTIVE_SQL} AND starts<? AND ends>?)
       AND (? OR NOT EXISTS (SELECT 1 FROM reserva_blocks WHERE profile_id=? AND (unit_id IS NULL OR unit_id=?) AND starts<? AND ends>?))`,
    id,
    ctx.profile,
    ctx.profile,
    unit.id,
    unit.name,
    unit.mode,
    period.starts,
    period.ends,
    period.arrival_at,
    period.departure_at,
    guests,
    status,
    c?.id || null,
    contact?.id || null,
    customer.name,
    customer.phone,
    customer.notes,
    input.source,
    period.price_cents,
    deposit,
    due,
    status === "confirmed" ? at : null,
    status === "confirmed" ? input.actor : null,
    input.actor,
    at,
    at,
    ctx.profile,
    unit.id,
    period.ends,
    period.starts,
    input.force ? 1 : 0,
    ctx.profile,
    unit.id,
    period.ends,
    period.starts,
  );
  if (!inserted.meta?.changes) {
    // Outro pedido gravou primeiro: diga o motivo atual.
    const refusal = await periodRefusal(ctx, config, unit, period, at, {
      staff: true,
      force: input.force,
    });
    throw refusalError(refusal || "booked", config, unit);
  }
  const booking = await getBooking(ctx, id);
  await publish(ctx, "reserva.created", booking, input.actor, {
    source: input.source,
  });
  if (booking.status === "confirmed")
    await publish(ctx, "reserva.confirmed", booking, input.actor);
  if (input.notify ?? input.source !== "whatsapp")
    await notifyCustomer(
      ctx,
      booking,
      fill(
        booking.status === "confirmed"
          ? config.confirmed_text
          : config.pending_text,
        describe(booking),
      ),
      `created:${id}`,
      input.actor,
    );
  return { booking, created: true };
}

// ---------------------------------------------------------------------------
// Alterar, cancelar, confirmar

export async function activeBooking(ctx: ModuleContext, id: string) {
  const b = await getBooking(ctx, id);
  if (!ACTIVE.includes(b.status))
    throw new ApiError(
      409,
      "booking_closed",
      b.status === "cancelled"
        ? "Esta reserva já foi cancelada."
        : b.status === "expired"
          ? "Esta reserva foi liberada porque o sinal não foi pago no prazo."
          : "Esta reserva já foi encerrada.",
    );
  return b;
}

export interface ChangeInput extends PeriodInput {
  id: string;
  unit_id?: string;
  guests?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  notes?: unknown;
  actor: string;
  staff?: boolean;
  force?: boolean;
  notify?: boolean;
  at?: number;
}

/** Muda unidade, datas ou horário, pessoas e dados do cliente. */
export async function changeBooking(
  ctx: ModuleContext,
  config: ReservaConfig,
  input: ChangeInput,
) {
  const at = input.at ?? clock();
  const before = await activeBooking(ctx, input.id);
  const unit = await getUnit(ctx, input.unit_id || before.unit_id);
  const moved =
    unit.id !== before.unit_id ||
    ["start_date", "end_date", "nights", "starts", "duration_minutes"].some(
      (k) => (input as any)[k] !== undefined,
    );
  const period = periodOf(config, unit, {
    start_date: input.start_date ?? before.start_date,
    end_date:
      input.end_date ??
      (input.nights !== undefined ? undefined : before.end_date),
    nights: input.nights,
    starts: input.starts ?? before.starts,
    duration_minutes: input.duration_minutes ?? before.duration_minutes,
  });
  const guests =
    input.guests !== undefined ? guestsOf(input.guests, unit) : before.guests;
  if (moved || guests !== before.guests)
    await requireFree(ctx, config, unit, period, at, {
      guests,
      staff: input.staff,
      force: input.force,
      ignore: before.id,
    });
  const customer = customerOf(
    {
      customer_name: input.customer_name ?? before.customer_name,
      customer_phone: input.customer_phone ?? before.customer_phone,
      notes: input.notes ?? before.notes,
    },
    null,
    null,
  );
  const updated = await exec(
    ctx.env,
    `UPDATE reserva_bookings SET unit_id=?,unit_name=?,mode=?,starts=?,ends=?,arrival_at=?,departure_at=?,guests=?,price_cents=?,customer_name=?,customer_phone=?,notes=?,
       reminded_at=CASE WHEN ? THEN NULL ELSE reminded_at END,
       checkout_sent_at=CASE WHEN ? THEN NULL ELSE checkout_sent_at END,
       changes=changes+1,updated=?
     WHERE id=? AND profile_id=? AND status IN ${ACTIVE_SQL}
       AND NOT EXISTS (SELECT 1 FROM reserva_bookings o WHERE o.profile_id=? AND o.unit_id=? AND o.id<>? AND o.status IN ${ACTIVE_SQL} AND o.starts<? AND o.ends>?)
       AND (? OR NOT ? OR NOT EXISTS (SELECT 1 FROM reserva_blocks WHERE profile_id=? AND (unit_id IS NULL OR unit_id=?) AND starts<? AND ends>?))`,
    unit.id,
    unit.name,
    unit.mode,
    period.starts,
    period.ends,
    period.arrival_at,
    period.departure_at,
    guests,
    moved ? period.price_cents : before.price_cents,
    customer.name,
    customer.phone,
    customer.notes,
    moved ? 1 : 0,
    moved ? 1 : 0,
    at,
    before.id,
    ctx.profile,
    ctx.profile,
    unit.id,
    before.id,
    period.ends,
    period.starts,
    input.force ? 1 : 0,
    moved ? 1 : 0,
    ctx.profile,
    unit.id,
    period.ends,
    period.starts,
  );
  if (!updated.meta?.changes) {
    await activeBooking(ctx, before.id);
    throw refusalError("booked", config, unit);
  }
  const after = await getBooking(ctx, before.id);
  await publish(ctx, "reserva.changed", after, input.actor, {
    previous: {
      unit_id: before.unit_id,
      starts: before.starts,
      ends: before.ends,
      guests: before.guests,
      price_cents: before.price_cents,
    },
  });
  if (moved && (input.notify ?? true))
    await notifyCustomer(
      ctx,
      after,
      `Sua reserva #${after.number} foi alterada: ${summaryLine(after)}.`,
      `changed:${after.id}:${after.changes}`,
      input.actor,
    );
  return after;
}

export async function cancelBooking(
  ctx: ModuleContext,
  config: ReservaConfig,
  input: { id: string; actor: string; reason?: unknown; notify?: boolean },
) {
  const before = await activeBooking(ctx, input.id);
  const reason = String(input.reason ?? "").trim();
  requireValue(Array.from(reason).length <= 300, "Motivo até 300 caracteres.");
  const at = clock();
  const done = await exec(
    ctx.env,
    `UPDATE reserva_bookings SET status='cancelled',cancelled_at=?,cancelled_by=?,cancel_reason=?,updated=? WHERE id=? AND profile_id=? AND status IN ${ACTIVE_SQL}`,
    at,
    input.actor,
    reason,
    at,
    before.id,
    ctx.profile,
  );
  if (!done.meta?.changes) await activeBooking(ctx, before.id);
  // Sinal ainda aberto: cancela a cobrança para o cliente não pagar uma
  // reserva cancelada. Se já tiver sido paga, segue o caminho de
  // reserva.payment_late (deposit.ts).
  if (before.status === "pending_payment" && before.payment_id)
    try {
      await ctx.cancelCharge(before.payment_id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  const after = await getBooking(ctx, before.id);
  await publish(ctx, "reserva.cancelled", after, input.actor, { reason });
  if (input.notify ?? true)
    await notifyCustomer(
      ctx,
      after,
      fill(config.cancelled_text, describe(after)),
      `cancelled:${after.id}`,
      input.actor,
    );
  return after;
}

/**
 * Confirmação pela equipe (sinal pago por fora, cortesia). O cliente nunca
 * confirma pelo chat: o sinal só confirma pela cobrança (deposit.ts).
 */
export async function confirmBooking(
  ctx: ModuleContext,
  config: ReservaConfig,
  input: { id: string; actor: string; notify?: boolean },
) {
  const before = await activeBooking(ctx, input.id);
  if (before.status === "confirmed") return before;
  const at = clock();
  await exec(
    ctx.env,
    "UPDATE reserva_bookings SET status='confirmed',confirmed_at=?,confirmed_by=?,updated=? WHERE id=? AND profile_id=? AND status='pending_payment'",
    at,
    input.actor,
    at,
    before.id,
    ctx.profile,
  );
  const after = await getBooking(ctx, before.id);
  await publish(ctx, "reserva.confirmed", after, input.actor, {
    by: "staff",
  });
  if (input.notify ?? true)
    await notifyCustomer(
      ctx,
      after,
      fill(config.confirmed_text, describe(after)),
      `confirmed:${after.id}`,
      input.actor,
    );
  return after;
}
