// Reserva e check-in (módulo "reserva"): registra rotas, comandos e ganchos
// no núcleo (src/modules/api.ts). Regras em units.ts (cadastros). Uso:
// docs/RESERVA.md.
import {
  ApiError,
  requireValue,
  type Actor,
  type Conversation,
} from "../../types";
import {
  onCommand,
  onConversationTurn,
  onMenuChoice,
  onRead,
  onRoute,
  onSettingsSave,
  type ModuleContext,
} from "../api";
import { reservaTurn, startBooking, startMine } from "./chat";
import {
  addDays,
  brasiliaDate,
  clockOf,
  DAY_MS,
  dayStart,
  depositFor,
  reservaConfig,
  validDate,
  validateReservaConfig,
} from "./config";
import {
  hourlySlots,
  occupancy,
  periodOf,
  periodRefusal,
  refusalMessage,
} from "./availability";
import {
  cancelBooking,
  changeBooking,
  confirmBooking,
  createBooking,
  getBooking,
  listBookings,
} from "./bookings";
import {
  archiveUnit,
  deleteBlock,
  getUnit,
  listBlocks,
  listUnits,
  saveBlock,
  saveUnit,
} from "./units";

const MODULE = "reserva";

export async function config(ctx: ModuleContext) {
  return reservaConfig((await ctx.settings())?.reserva);
}

const read = (ctx: ModuleContext, actor: Actor) =>
  ctx.access(actor, "conversations:read");

/** Intervalo de datas (from_date..to_date, inclusive), padrão: 30 dias. */
export function dateRange(query: Record<string, string>, at: number) {
  const from = query.from_date || brasiliaDate(at);
  requireValue(validDate(from), "from_date no formato AAAA-MM-DD.");
  const to = query.to_date || addDays(from, 30);
  requireValue(
    validDate(to) && to >= from,
    "to_date no formato AAAA-MM-DD, igual ou depois de from_date.",
  );
  requireValue(to <= addDays(from, 92), "Consulte até 93 dias por vez.");
  return { from, to, starts: dayStart(from), ends: dayStart(addDays(to, 1)) };
}

// ---------------------------------------------------------------------------
// WhatsApp

// Próxima mensagem do cliente: respostas da conversa da Reserva (chat.ts).
onConversationTurn(MODULE, (ctx, c, turn) => reservaTurn(ctx, c, turn));

async function unavailable(
  ctx: ModuleContext,
  c: Conversation,
  error: unknown,
  key: string,
) {
  if (!(error instanceof ApiError)) throw error;
  await ctx.sendMessage(
    c,
    {
      text: "A reserva não está disponível agora. Envie MENU para ver as opções.",
    },
    { key: `menu-unavailable:${key}` },
  );
}

// Item de menu "Fazer reserva".
onMenuChoice("reserva", async (ctx, c, _item, { rowId }) => {
  try {
    await startBooking(ctx, c, { key: `menu:${rowId}` });
  } catch (error) {
    await unavailable(ctx, c, error, rowId);
  }
});

// Item de menu "Minhas reservas".
onMenuChoice("reserva_mine", async (ctx, c, _item, { rowId }) => {
  try {
    await startMine(ctx, c, { key: `menu:${rowId}` });
  } catch (error) {
    await unavailable(ctx, c, error, rowId);
  }
});

// ---------------------------------------------------------------------------
// Regras e cadastros

onSettingsSave(MODULE, "reserva", validateReservaConfig);

// GET /profiles/:profile/reserva: regras (com os padrões) e unidades.
onRead(MODULE, "reserva", async (ctx, actor) => {
  read(ctx, actor);
  return { config: await config(ctx), units: await listUnits(ctx) };
});
onRead(MODULE, "reserva/units", async (ctx, actor) => {
  read(ctx, actor);
  return { data: await listUnits(ctx) };
});
onRead(MODULE, "reserva/units/:id", async (ctx, actor, { params }) => {
  read(ctx, actor);
  return getUnit(ctx, params.id);
});
onRoute(MODULE, {
  method: "POST",
  path: "reserva/units",
  op: "reserva.unit.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "reserva/units/:id",
  op: "reserva.unit.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "reserva/units/:id",
  op: "reserva.unit.delete",
});
onCommand(MODULE, "reserva.unit.save", (ctx, actor, data) =>
  saveUnit(ctx, actor, data),
);
onCommand(MODULE, "reserva.unit.delete", (ctx, actor, data) =>
  archiveUnit(ctx, actor, data.id),
);

onRead(MODULE, "reserva/blocks", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const range = dateRange(query, Date.now());
  return { data: await listBlocks(ctx, range.starts, range.ends) };
});
onRoute(MODULE, {
  method: "POST",
  path: "reserva/blocks",
  op: "reserva.block.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "reserva/blocks/:id",
  op: "reserva.block.delete",
});
onCommand(MODULE, "reserva.block.save", (ctx, actor, data) =>
  saveBlock(ctx, actor, data),
);
onCommand(MODULE, "reserva.block.delete", (ctx, actor, data) =>
  deleteBlock(ctx, actor, data.id),
);

// ---------------------------------------------------------------------------
// Disponibilidade e calendário

const flag = (value: unknown) => value === "1" || value === "true";

// GET /reserva/availability
// Por diária: ?start_date=&end_date= (ou nights) [&guests=&unit_id=&staff=1]
// → cada unidade por diária com available, reason e valores.
// Por hora: ?date=&duration_minutes= [&unit_id=&staff=1] → horários livres.
onRead(MODULE, "reserva/availability", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const rules = await config(ctx);
  const at = Date.now();
  const staff = flag(query.staff);
  const units = (await listUnits(ctx, !staff)).filter(
    (u) => !query.unit_id || u.id === query.unit_id,
  );
  if (query.date !== undefined) {
    requireValue(validDate(query.date), "date no formato AAAA-MM-DD.");
    const duration = Number(query.duration_minutes || rules.min_hours * 60);
    requireValue(
      Number.isInteger(duration) && duration >= 15 && duration <= 1440,
      "duration_minutes de 15 a 1440.",
    );
    return {
      date: query.date,
      duration_minutes: duration,
      units: await Promise.all(
        units
          .filter((u) => u.mode === "hourly")
          .map(async (u) => ({
            unit_id: u.id,
            name: u.name,
            capacity: u.capacity,
            price_cents: u.price_cents,
            slots: (
              await hourlySlots(ctx, rules, u, query.date, duration, at, {
                staff,
              })
            ).map((s) => ({ ...s, time: clockOf(s.starts) })),
          })),
      ),
    };
  }
  const guests = query.guests !== undefined ? Number(query.guests) : undefined;
  requireValue(
    guests === undefined || (Number.isInteger(guests) && guests >= 1),
    "guests: número de pessoas.",
  );
  const daily = units.filter((u) => u.mode === "daily");
  const results = await Promise.all(
    daily.map(async (u) => {
      const period = periodOf(rules, u, {
        start_date: query.start_date,
        end_date: query.end_date,
        nights: query.nights !== undefined ? Number(query.nights) : undefined,
      });
      const refusal = await periodRefusal(ctx, rules, u, period, at, {
        guests,
        staff,
      });
      return {
        unit_id: u.id,
        name: u.name,
        capacity: u.capacity,
        available: !refusal,
        reason: refusal,
        message: refusal ? refusalMessage(refusal, rules, u) : null,
        price_cents: period.price_cents,
        deposit_cents: depositFor(rules, period.price_cents),
        nights: period.nights,
      };
    }),
  );
  return {
    start_date: query.start_date,
    end_date: results[0]
      ? addDays(query.start_date, results[0].nights!)
      : query.end_date,
    units: results,
  };
});

// GET /reserva/calendar?from_date=&to_date= [&unit_id=]: ocupação por
// unidade e dia, com as reservas do período.
onRead(MODULE, "reserva/calendar", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const from = query.from_date || brasiliaDate(Date.now());
  requireValue(validDate(from), "from_date no formato AAAA-MM-DD.");
  const range = dateRange(
    { from_date: from, to_date: query.to_date || addDays(from, 13) },
    Date.now(),
  );
  const units = (await listUnits(ctx)).filter(
    (u) => !query.unit_id || u.id === query.unit_id,
  );
  const [bookings, occ] = await Promise.all([
    listBookings(ctx, {
      from: range.starts,
      to: range.ends,
      status: "pending_payment,confirmed,completed",
      unit_id: query.unit_id,
      limit: 1000,
    }),
    occupancy(ctx, range.starts, range.ends),
  ]);
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  return {
    from_date: range.from,
    to_date: range.to,
    days,
    units: units.map((u) => ({
      unit_id: u.id,
      name: u.name,
      mode: u.mode,
      active: u.active,
      cells: days.map((date) => {
        const s = dayStart(date),
          e = s + DAY_MS;
        const here = bookings.filter(
          (b) => b.unit_id === u.id && b.starts < e && b.ends > s,
        );
        const blocked = occ.blocks.filter(
          (b) =>
            (!b.unit_id || b.unit_id === u.id) && b.starts < e && b.ends > s,
        );
        const state = blocked.some((b) => b.starts <= s && b.ends >= e)
          ? "blocked"
          : u.mode === "daily" && here.length
            ? here[0].status
            : here.length || blocked.length
              ? "partial"
              : "free";
        return {
          date,
          state,
          booking_ids: here.map((b) => b.id),
          block_ids: blocked.map((b) => b.id),
        };
      }),
    })),
    bookings,
  };
});

// ---------------------------------------------------------------------------
// Reservas

onRead(MODULE, "reserva/bookings", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const range =
    query.from_date || query.to_date ? dateRange(query, Date.now()) : null;
  return {
    data: await listBookings(ctx, {
      from: range?.starts,
      to: range?.ends,
      status: query.status,
      unit_id: query.unit_id,
      conversation_id: query.conversation_id,
      q: query.q,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  };
});
onRead(MODULE, "reserva/bookings/:id", async (ctx, actor, { params }) => {
  read(ctx, actor);
  return getBooking(ctx, params.id);
});

/** Conversa opcional da reserva feita pela equipe ou por integração. */
async function linkedConversation(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  if (id === undefined || id === null || id === "") return null;
  requireValue(typeof id === "string", "conversation_id inválido.");
  const c = await ctx.conversation(id, actor);
  requireValue(
    c.chat_type !== "group",
    "Ligue a reserva à conversa direta do cliente.",
  );
  return c;
}
export const sourceOf = (actor: Actor): "panel" | "api" =>
  actor.kind === "user" ? "panel" : "api";
const bool = (value: unknown, what: string) => {
  requireValue(
    value === undefined || typeof value === "boolean",
    `${what}: verdadeiro ou falso.`,
  );
  return value as boolean | undefined;
};

onRoute(MODULE, {
  method: "POST",
  path: "reserva/bookings",
  op: "reserva.book",
});
onCommand(MODULE, "reserva.book", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const conversation = await linkedConversation(
    ctx,
    actor,
    data.conversation_id,
  );
  requireValue(
    conversation ||
      (typeof data.customer_name === "string" && data.customer_name.trim()),
    "Informe conversation_id ou customer_name.",
  );
  return (
    await createBooking(ctx, await config(ctx), {
      ...data,
      id: `cmd-${requestId}`,
      conversation,
      source: sourceOf(actor),
      actor: actor.id,
      staff: true,
      force: bool(data.force, "force"),
      deposit: bool(data.deposit, "deposit") ?? false,
      notify: bool(data.notify, "notify"),
    })
  ).booking;
});

onRoute(MODULE, {
  method: "PATCH",
  path: "reserva/bookings/:id",
  op: "reserva.change",
});
onCommand(MODULE, "reserva.change", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return changeBooking(ctx, await config(ctx), {
    ...data,
    actor: actor.id,
    staff: true,
    force: bool(data.force, "force"),
    notify: bool(data.notify, "notify"),
  });
});

onRoute(MODULE, {
  method: "POST",
  path: "reserva/bookings/:id/cancel",
  op: "reserva.cancel",
});
onCommand(MODULE, "reserva.cancel", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return cancelBooking(ctx, await config(ctx), {
    id: data.id,
    actor: actor.id,
    reason: data.reason,
    notify: bool(data.notify, "notify"),
  });
});

onRoute(MODULE, {
  method: "POST",
  path: "reserva/bookings/:id/confirm",
  op: "reserva.confirm",
});
onCommand(MODULE, "reserva.confirm", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return confirmBooking(ctx, await config(ctx), {
    id: data.id,
    actor: actor.id,
    notify: bool(data.notify, "notify"),
  });
});
