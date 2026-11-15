// Agendamentos: reservar, remarcar, cancelar, confirmar e marcar ausência.
// A reserva e a remarcação são um único INSERT/UPDATE condicionado à
// ausência de outro agendamento ativo do mesmo profissional no intervalo:
// o banco aplica cada instrução de uma vez, então dois pedidos simultâneos
// nunca ficam com o mesmo horário, venham do painel, da API ou do WhatsApp.
import { all, exec, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  now as clock,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import {
  brasiliaDate,
  clockOf,
  DAY_MS,
  dayStart,
  fill,
  longDay,
  MINUTE_MS,
  type AgendaConfig,
  validDate,
} from "./config";
import { listProfessionals, listServices } from "./catalog";
import { availability, type SlotRules } from "./availability";

export type AppointmentStatus =
  "booked" | "confirmed" | "cancelled" | "no_show";
export type Source = "whatsapp" | "panel" | "api";

export interface Appointment {
  id: string;
  service_id: string;
  service_name: string;
  professional_id: string;
  professional_name: string;
  starts: number;
  ends: number;
  /** Dia e hora de Brasília, para quem mostra sem converter. */
  date: string;
  time: string;
  status: AppointmentStatus;
  conversation_id: string | null;
  contact_id: string | null;
  customer_name: string;
  customer_phone: string;
  notes: string;
  source: Source;
  price_cents: number | null;
  booked_at: number;
  reminded_at: number | null;
  confirmed_at: number | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string;
  no_show_at: number | null;
  moves: number;
  created_by: string;
  created: number;
  updated: number;
}

export function appointmentView(
  row: any,
  names: Map<string, string>,
): Appointment {
  return {
    id: row.id,
    service_id: row.service_id,
    service_name: row.service_name,
    professional_id: row.professional_id,
    professional_name: names.get(row.professional_id) || "",
    starts: row.starts,
    ends: row.ends,
    date: brasiliaDate(row.starts),
    time: clockOf(row.starts),
    status: row.status,
    conversation_id: row.conversation_id || null,
    contact_id: row.contact_id || null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    notes: row.notes,
    source: row.source,
    price_cents: row.price_cents ?? null,
    booked_at: row.booked_at,
    reminded_at: row.reminded_at ?? null,
    confirmed_at: row.confirmed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    cancelled_by: row.cancelled_by ?? null,
    cancel_reason: row.cancel_reason,
    no_show_at: row.no_show_at ?? null,
    moves: row.moves,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
  };
}

async function professionalNames(ctx: ModuleContext) {
  return new Map(
    (
      await all(
        ctx.env,
        "SELECT id,name FROM agenda_professionals WHERE profile_id=?",
        ctx.profile,
      )
    ).map((r) => [r.id as string, r.name as string]),
  );
}

export async function getAppointment(ctx: ModuleContext, id: string) {
  const row = await one(
    ctx.env,
    "SELECT * FROM agenda_appointments WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Agendamento não encontrado.");
  return appointmentView(row, await professionalNames(ctx));
}

export async function listAppointments(
  ctx: ModuleContext,
  filter: {
    from: number;
    to: number;
    professional_id?: string;
    status?: string;
    conversation_id?: string;
  },
) {
  const where = ["profile_id=?", "starts<?", "ends>?"],
    args: any[] = [ctx.profile, filter.to, filter.from];
  if (filter.professional_id) {
    where.push("professional_id=?");
    args.push(filter.professional_id);
  }
  if (filter.status) {
    const statuses = filter.status.split(",").filter(Boolean);
    requireValue(
      statuses.every((s) =>
        ["booked", "confirmed", "cancelled", "no_show"].includes(s),
      ),
      "status: booked, confirmed, cancelled ou no_show (separados por vírgula).",
    );
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (filter.conversation_id) {
    where.push("conversation_id=?");
    args.push(filter.conversation_id);
  }
  const [rows, names] = await Promise.all([
    all(
      ctx.env,
      `SELECT * FROM agenda_appointments WHERE ${where.join(" AND ")} ORDER BY starts LIMIT 2000`,
      ...args,
    ),
    professionalNames(ctx),
  ]);
  return rows.map((row) => appointmentView(row, names));
}

const isAppointment = (v: any) =>
  v &&
  typeof v === "object" &&
  "customer_phone" in v &&
  "service_id" in v &&
  "professional_id" in v;
/**
 * Respostas da Agenda para o ator (revisão M6): aplicação sem contacts:read
 * não vê o telefone do cliente; sem notes:read, não vê as observações.
 */
export function visibleAppointments(
  ctx: ModuleContext,
  actor: Actor,
  value: any,
) {
  if (ctx.mayRead(actor, "contacts") && ctx.mayRead(actor, "notes"))
    return value;
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (isAppointment(v))
      return ctx.redact(actor, v, {
        contacts: ["customer_phone"],
        notes: ["notes"],
      });
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}

/** Próximos agendamentos ativos do cliente da conversa (ou do mesmo telefone). */
export async function upcomingFor(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
) {
  // Só o telefone autenticado pelo canal (revisão M7).
  const phone = (ctx.verifiedPhone(c) || "").replace(/\D/g, "");
  const [rows, names] = await Promise.all([
    all(
      ctx.env,
      `SELECT * FROM agenda_appointments WHERE profile_id=? AND status IN ('booked','confirmed') AND ends>? AND (conversation_id=?${phone ? " OR customer_phone=?" : ""}) ORDER BY starts LIMIT 20`,
      ctx.profile,
      at,
      c.id,
      ...(phone ? [phone] : []),
    ),
    professionalNames(ctx),
  ]);
  return rows.map((row) => appointmentView(row, names));
}

// ---------------------------------------------------------------------------
// Mensagens ao cliente e eventos

export function describe(a: Appointment) {
  return {
    servico: a.service_name,
    profissional: a.professional_name,
    data: longDay(a.date),
    hora: a.time,
    nome: a.customer_name.split(" ")[0] || "",
  };
}

/** Avisa o cliente da conversa ligada ao agendamento (janela de 24 h). */
export async function notifyCustomer(
  ctx: ModuleContext,
  a: Appointment,
  text: string,
  key: string,
  actor = "system",
) {
  if (!a.conversation_id) return null;
  let c: Conversation;
  try {
    c = await ctx.conversation(a.conversation_id);
  } catch {
    return null;
  }
  return ctx.sendMessage(c, { text }, { key, actor, notification: true });
}

async function publish(
  ctx: ModuleContext,
  kind: string,
  a: Appointment,
  actor: string,
  extra: Record<string, unknown> = {},
) {
  // Chave por mudança: repetir a mesma mudança não duplica o evento.
  await ctx.publish(
    kind,
    a.id,
    {
      appointment: a,
      conversation_id: a.conversation_id,
      actor,
      ...extra,
    },
    { key: `${a.id}:${a.updated}` },
  );
}

// ---------------------------------------------------------------------------
// Reservar e remarcar

export interface BookInput {
  service_id: string;
  /** null ou "any": qualquer profissional livre. */
  professional_id?: string | null;
  starts: number;
  conversation?: Conversation | null;
  customer_name?: string;
  customer_phone?: string;
  notes?: string;
  source: Source;
  actor: string;
  rules?: SlotRules;
  /** Equipe: aceita fora do horário de trabalho e sobre bloqueios. */
  force?: boolean;
  /** Avisar o cliente da conversa (padrão: só quando não foi ele quem marcou). */
  notify?: boolean;
  /** Id do agendamento (idempotência: o mesmo id não reserva duas vezes). */
  id?: string;
}

const slotTaken = () =>
  new ApiError(
    409,
    "slot_taken",
    "Este horário acabou de ser ocupado. Escolha outro.",
  );
const slotUnavailable = () =>
  new ApiError(
    409,
    "slot_unavailable",
    "Este horário não está disponível para o serviço e o profissional escolhidos.",
  );

/** Escolhe o profissional e confere o horário contra a disponibilidade. */
async function resolveSlot(
  ctx: ModuleContext,
  config: AgendaConfig,
  input: {
    service_id: string;
    professional_id?: string | null;
    starts: number;
    rules?: SlotRules;
    force?: boolean;
    ignore?: string;
    at: number;
  },
) {
  requireValue(
    typeof input.service_id === "string" && input.service_id,
    "Informe service_id.",
  );
  requireValue(
    Number.isInteger(input.starts) && input.starts > 0,
    "Informe starts em milissegundos.",
  );
  requireValue(
    input.starts % MINUTE_MS === 0,
    "O horário precisa cair num minuto exato.",
  );
  const wanted =
    input.professional_id && input.professional_id !== "any"
      ? input.professional_id
      : null;
  if (input.force) {
    const [services, professionals] = await Promise.all([
      listServices(ctx),
      listProfessionals(ctx),
    ]);
    const service = services.find((s) => s.id === input.service_id);
    requireValue(service, "Serviço não encontrado.");
    requireValue(
      wanted,
      "Para encaixe fora do horário, escolha o profissional.",
    );
    const professional = professionals.find((p) => p.id === wanted);
    requireValue(professional, "Profissional não encontrado.");
    return {
      service,
      professional,
      ends: input.starts + service.duration_minutes * MINUTE_MS,
    };
  }
  const date = brasiliaDate(input.starts);
  const found = await availability(ctx, config, {
    serviceId: input.service_id,
    professionalId: wanted,
    dates: [date],
    now: input.at,
    rules: input.rules,
    ignore: input.ignore,
  });
  requireValue(found.service, "Serviço não encontrado.");
  if (wanted)
    requireValue(
      found.professionals.some((p) => p.id === wanted),
      "Profissional não encontrado.",
    );
  const slot = found.days[0]?.slots.find((s) => s.starts === input.starts);
  if (!slot) throw slotUnavailable();
  // "Qualquer um": quem tem menos agendamentos no dia, depois a ordem do cadastro.
  let chosen = slot.professional_ids[0];
  if (!wanted && slot.professional_ids.length > 1) {
    const counts = await all(
      ctx.env,
      "SELECT professional_id,count(*) AS n FROM agenda_appointments WHERE profile_id=? AND status IN ('booked','confirmed') AND starts>=? AND starts<?",
      ctx.profile,
      dayStart(date),
      dayStart(date) + DAY_MS,
    );
    const load = new Map(counts.map((r) => [r.professional_id, r.n]));
    chosen = [...slot.professional_ids].sort(
      (a, b) => (load.get(a) || 0) - (load.get(b) || 0),
    )[0];
  }
  return {
    service: found.service,
    professional: found.professionals.find((p) => p.id === chosen)!,
    ends: slot.ends,
  };
}

export async function book(
  ctx: ModuleContext,
  config: AgendaConfig,
  input: BookInput,
) {
  const at = clock();
  if (input.id) {
    const existing = await one(
      ctx.env,
      "SELECT id FROM agenda_appointments WHERE id=? AND profile_id=?",
      input.id,
      ctx.profile,
    );
    if (existing)
      return {
        appointment: await getAppointment(ctx, input.id),
        created: false,
      };
  }
  const slot = await resolveSlot(ctx, config, { ...input, at });
  const c = input.conversation || null;
  const contact = c ? await ctx.contact(c) : null;
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
  const id = input.id || uid();
  const inserted = await exec(
    ctx.env,
    `INSERT INTO agenda_appointments(id,profile_id,service_id,professional_id,starts,ends,status,conversation_id,contact_id,customer_name,customer_phone,notes,source,service_name,price_cents,booked_at,created_by,created,updated)
     SELECT ?,?,?,?,?,?,'booked',?,?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM agenda_appointments WHERE profile_id=? AND professional_id=? AND status IN ('booked','confirmed') AND starts<? AND ends>?)
       AND (?=1 OR NOT EXISTS (SELECT 1 FROM agenda_blocks b WHERE b.profile_id=? AND (b.professional_id IS NULL OR b.professional_id=?) AND b.starts<? AND b.ends>?))`,
    id,
    ctx.profile,
    slot.service.id,
    slot.professional.id,
    input.starts,
    slot.ends,
    c?.id || null,
    contact?.id || null,
    name,
    phone,
    notes,
    input.source,
    slot.service.name,
    slot.service.price_cents,
    at,
    input.actor,
    at,
    at,
    ctx.profile,
    slot.professional.id,
    slot.ends,
    input.starts,
    // Bloqueio criado entre a consulta e a reserva (revisão B7).
    input.force ? 1 : 0,
    ctx.profile,
    slot.professional.id,
    slot.ends,
    input.starts,
  );
  if (!inserted.meta?.changes) throw slotTaken();
  const appointment = await getAppointment(ctx, id);
  await publish(ctx, "agenda.booked", appointment, input.actor, {
    source: input.source,
  });
  if (input.notify ?? input.source !== "whatsapp")
    await notifyCustomer(
      ctx,
      appointment,
      fill(config.booked_text, describe(appointment)),
      `booked:${id}`,
      input.actor,
    );
  return { appointment, created: true };
}

const ACTIVE = ["booked", "confirmed"];

/**
 * O agendamento mudou entre a leitura e a gravação (outra pessoa, o cliente
 * ou a expiração): 409 com o motivo de agora (revisão B7).
 */
async function changedMeanwhile(ctx: ModuleContext, id: string) {
  await activeRow(ctx, id);
  return new ApiError(
    409,
    "appointment_changed",
    "Este agendamento acabou de mudar. Atualize e tente de novo.",
  );
}

async function activeRow(ctx: ModuleContext, id: string) {
  const a = await getAppointment(ctx, id);
  if (!ACTIVE.includes(a.status))
    throw new ApiError(
      409,
      "appointment_closed",
      a.status === "cancelled"
        ? "Este agendamento já foi cancelado."
        : "Este agendamento já foi encerrado.",
    );
  return a;
}

export async function move(
  ctx: ModuleContext,
  config: AgendaConfig,
  input: {
    id: string;
    starts: number;
    professional_id?: string | null;
    actor: string;
    rules?: SlotRules;
    force?: boolean;
    notify?: boolean;
  },
) {
  const at = clock();
  const before = await activeRow(ctx, input.id);
  if (
    before.starts === input.starts &&
    (!input.professional_id || input.professional_id === before.professional_id)
  )
    return before;
  const slot = await resolveSlot(ctx, config, {
    service_id: before.service_id,
    professional_id:
      input.professional_id === undefined
        ? before.professional_id
        : input.professional_id,
    starts: input.starts,
    rules: input.rules,
    force: input.force,
    ignore: before.id,
    at,
  });
  const updated = await exec(
    ctx.env,
    `UPDATE agenda_appointments SET professional_id=?,starts=?,ends=?,status='booked',booked_at=?,reminded_at=NULL,confirmed_at=NULL,moves=moves+1,updated=?
     WHERE id=? AND status IN ('booked','confirmed')
       AND NOT EXISTS (SELECT 1 FROM agenda_appointments o WHERE o.profile_id=? AND o.professional_id=? AND o.status IN ('booked','confirmed') AND o.starts<? AND o.ends>? AND o.id<>?)`,
    slot.professional.id,
    input.starts,
    slot.ends,
    at,
    at,
    before.id,
    ctx.profile,
    slot.professional.id,
    slot.ends,
    input.starts,
    before.id,
  );
  if (!updated.meta?.changes) throw slotTaken();
  const after = await getAppointment(ctx, before.id);
  await publish(ctx, "agenda.rescheduled", after, input.actor, {
    previous: {
      starts: before.starts,
      ends: before.ends,
      professional_id: before.professional_id,
    },
  });
  if (input.notify ?? true)
    await notifyCustomer(
      ctx,
      after,
      `Seu agendamento foi remarcado: ${after.service_name} com ${after.professional_name}, ${longDay(after.date)} às ${after.time}.`,
      `moved:${after.id}:${after.moves}`,
      input.actor,
    );
  return after;
}

export async function cancel(
  ctx: ModuleContext,
  config: AgendaConfig,
  input: { id: string; actor: string; reason?: string; notify?: boolean },
) {
  const before = await activeRow(ctx, input.id);
  const reason = String(input.reason ?? "").trim();
  requireValue(Array.from(reason).length <= 300, "Motivo até 300 caracteres.");
  const at = clock();
  const done = await exec(
    ctx.env,
    "UPDATE agenda_appointments SET status='cancelled',cancelled_at=?,cancelled_by=?,cancel_reason=?,updated=? WHERE id=? AND status IN ('booked','confirmed')",
    at,
    input.actor,
    reason,
    at,
    before.id,
  );
  // Corrida (revisão B7): sem linha mudada, nada de evento nem aviso.
  if (!done.meta?.changes) throw await changedMeanwhile(ctx, before.id);
  const after = await getAppointment(ctx, before.id);
  await publish(ctx, "agenda.cancelled", after, input.actor, { reason });
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

export async function confirm(
  ctx: ModuleContext,
  input: { id: string; actor: string },
) {
  const before = await activeRow(ctx, input.id);
  if (before.status === "confirmed") return before;
  const at = clock();
  // Só o horário que foi lido: remarcado no meio, não confirma o antigo.
  const done = await exec(
    ctx.env,
    "UPDATE agenda_appointments SET status='confirmed',confirmed_at=?,updated=? WHERE id=? AND status='booked' AND starts=? AND professional_id=?",
    at,
    at,
    before.id,
    before.starts,
    before.professional_id,
  );
  if (!done.meta?.changes) throw await changedMeanwhile(ctx, before.id);
  const after = await getAppointment(ctx, before.id);
  await publish(ctx, "agenda.confirmed", after, input.actor);
  return after;
}

export async function noShow(
  ctx: ModuleContext,
  input: { id: string; actor: string; at?: number },
) {
  const before = await activeRow(ctx, input.id);
  const at = input.at ?? clock();
  requireValue(
    before.starts <= at,
    "Só dá para marcar ausência depois do início do horário.",
  );
  const done = await exec(
    ctx.env,
    "UPDATE agenda_appointments SET status='no_show',no_show_at=?,updated=? WHERE id=? AND status IN ('booked','confirmed') AND starts=?",
    at,
    at,
    before.id,
    before.starts,
  );
  if (!done.meta?.changes) throw await changedMeanwhile(ctx, before.id);
  const after = await getAppointment(ctx, before.id);
  await publish(ctx, "agenda.no_show", after, input.actor);
  return after;
}

/** Datas a consultar: `date` (um dia) ou `from_date`..`to_date` (até 31). */
export function datesOf(query: Record<string, string>) {
  const from = query.date || query.from_date;
  requireValue(validDate(from), "Informe date no formato AAAA-MM-DD.");
  const to = query.date ? from : query.to_date || from;
  requireValue(validDate(to) && to >= from, "to_date no formato AAAA-MM-DD.");
  const dates: string[] = [];
  for (let d = from; d <= to;) {
    dates.push(d);
    requireValue(dates.length <= 31, "Consulte até 31 dias por vez.");
    d = new Date(Date.parse(d + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10);
  }
  return dates;
}
