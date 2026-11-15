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
  filteredHandlers,
  onConversationTurn,
  onMcpTool,
  onMenuChoice,
  onPaymentUpdated,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";
import { reservaTurn, startBooking, startMine } from "./chat";
import { depositStatus, paymentUpdated, requestDeposit } from "./deposit";
import { runDue } from "./schedule";
import { completeCheckin, sendCheckin } from "./checkin";
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
  upcomingFor,
  visibleBookings,
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
// Toda resposta das rotas e comandos passa por visibleBookings (revisão M6).
const { onRead, onCommand, onConversationAction } =
  filteredHandlers(visibleBookings);

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

// Sinal: a cobrança mudou (pago, vencido, cancelado, estornado).
onPaymentUpdated(MODULE, async (ctx, payment, { previous }) => {
  await paymentUpdated(ctx, await config(ctx), payment, previous);
});

// Prazos do sinal, check-in, lembrete e saída (ao menos a cada 5 minutos).
onSchedule(MODULE, async (ctx, { now }) => {
  await runDue(ctx, now);
});

// Check-in concluído pelo cliente na página do link.
onWebStepCompleted(MODULE, async (ctx, step, answers) => {
  if (step.kind === "checkin" && step.ref_id)
    await completeCheckin(ctx, step.ref_id, step.id, answers);
});

// "Enviar check-in" na conversa (equipe ou bot que atende):
// POST /conversations/:id/actions {action:"reserva_checkin", booking_id?}.
onConversationAction(
  MODULE,
  "reserva_checkin",
  async (ctx, actor, c, data, { requestId }) => {
    const bot = actor.id.startsWith("bot:");
    requireValue(
      c.owner === actor.id ||
        (actor.kind === "user" && actor.role === "admin") ||
        (bot && c.state === "ai"),
      "Assuma a conversa antes de enviar o check-in.",
    );
    const rules = await config(ctx);
    const booking = data.booking_id
      ? await getBooking(ctx, data.booking_id)
      : (
          await listBookings(ctx, {
            conversation_id: c.id,
            status: "confirmed",
            from: Date.now(),
          })
        ).find((b) => b.checkin_status !== "completed");
    requireValue(
      booking && booking.conversation_id === c.id,
      "Nenhuma reserva confirmada desta conversa com check-in pendente.",
    );
    const sent = await sendCheckin(ctx, rules, booking, {
      trigger: bot ? "module" : "agent",
      actor: actor.id,
      sourceKey: `action:${actor.id}:${requestId}`,
      conversation: c,
    });
    return { status: sent.status, booking: sent.booking };
  },
);

// Reservar para o cliente da conversa (ferramenta do bot reserva_reservar):
// regras do cliente (antecedência, estadia), sinal pela Cobrança como no
// WhatsApp. POST /conversations/:id/actions {action:"reserva_book", …}.
onConversationAction(
  MODULE,
  "reserva_book",
  async (ctx, actor, c, data, { requestId }) => {
    const bot = actor.id.startsWith("bot:");
    requireValue(
      c.owner === actor.id ||
        (actor.kind === "user" && actor.role === "admin") ||
        (bot && c.state === "ai"),
      "Assuma a conversa antes de reservar para o cliente.",
    );
    requireValue(
      c.chat_type !== "group",
      "Reserve pela conversa direta do cliente.",
    );
    const rules = await config(ctx);
    const { booking, created } = await createBooking(ctx, rules, {
      id: `act-${requestId}`,
      unit_id: data.unit_id,
      start_date: data.start_date,
      end_date: data.end_date,
      nights: data.nights,
      starts: data.starts,
      duration_minutes: data.duration_minutes,
      guests: data.guests,
      conversation: c,
      source: "whatsapp",
      actor: actor.id,
      notify: true,
    });
    if (created && booking.status === "pending_payment")
      return (
        await requestDeposit(ctx, rules, booking, c, {
          actor: actor.id,
          notification: true,
        })
      ).booking;
    return booking;
  },
);

// Reservas do cliente de uma conversa (bot: reserva_minhas).
onRead(MODULE, "reserva/conversations/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  const c = await ctx.conversation(params.id, actor);
  return { data: await upcomingFor(ctx, c, Date.now()) };
});

// Ferramentas MCP para o bot de IA (núcleo: onMcpTool). As que tocam no
// cliente só recebem conversation_id: nunca outro telefone ou documento.
onMcpTool(MODULE, {
  name: "reserva_disponibilidade",
  description:
    "Unidades livres. Diárias: start_date (AAAA-MM-DD) e end_date ou nights, opcional guests e unit_id. Por hora: date (AAAA-MM-DD) e duration_minutes. Use os valores devolvidos em reserva_reservar. Requer conversations:read.",
  input: {
    start_date: { type: "string" },
    end_date: { type: "string" },
    nights: { type: "integer" },
    guests: { type: "integer" },
    unit_id: { type: "string" },
    date: { type: "string" },
    duration_minutes: { type: "integer" },
  },
  call: (a, profile) => ({
    path: `/profiles/${profile}/reserva/availability`,
    query: {
      start_date: a.start_date,
      end_date: a.end_date,
      nights: a.nights,
      guests: a.guests,
      unit_id: a.unit_id,
      date: a.date,
      duration_minutes: a.duration_minutes,
    },
  }),
});
onMcpTool(MODULE, {
  name: "reserva_reservar",
  description:
    "Reserva uma unidade para o cliente da conversa, com as regras do cliente. Diárias: unit_id, start_date e end_date ou nights; por hora: unit_id, starts (ms) e duration_minutes; opcional guests. Com sinal, o cliente recebe a cobrança. Exige a conversa assumida pelo bot. Requer conversations:write; 409 unit_unavailable se o período acabou de ser ocupado.",
  input: {
    conversation_id: { type: "string" },
    unit_id: { type: "string" },
    start_date: { type: "string" },
    end_date: { type: "string" },
    nights: { type: "integer" },
    starts: { type: "integer" },
    duration_minutes: { type: "integer" },
    guests: { type: "integer" },
  },
  required: ["conversation_id", "unit_id"],
  write: true,
  call: (a, profile) => {
    const { conversation_id, idempotency_key: _key, profile: _p, ...rest } = a;
    return {
      method: "POST",
      path: `/profiles/${profile}/conversations/${conversation_id}/actions`,
      body: { action: "reserva_book", ...rest },
    };
  },
});
onMcpTool(MODULE, {
  name: "reserva_minhas",
  description:
    "Próximas reservas do cliente da conversa (desta conversa ou do mesmo telefone): número, unidade, entrada, saída, estado e sinal. Requer conversations:read.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/reserva/conversations/${a.conversation_id}`,
  }),
});

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
  return {
    config: await config(ctx),
    units: await listUnits(ctx),
    // Sinal: se a Cobrança está pronta (aviso ao administrador no painel).
    deposit: await depositStatus(ctx),
  };
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
  const rules = await config(ctx);
  const { booking, created } = await createBooking(ctx, rules, {
    ...data,
    // requestId: único por credencial, área, operação e Idempotency-Key, só
    // hexadecimais (nunca a chave do cliente).
    id: `cmd-${requestId}`,
    conversation,
    source: sourceOf(actor),
    actor: actor.id,
    staff: true,
    force: bool(data.force, "force"),
    deposit: bool(data.deposit, "deposit") ?? false,
    notify: bool(data.notify, "notify"),
  });
  // Sinal pedido pela equipe: cobra pela conversa (modelo de notificação se
  // a janela de 24 horas estiver fechada).
  if (created && conversation && booking.status === "pending_payment")
    return (
      await requestDeposit(ctx, rules, booking, conversation, {
        actor: actor.id,
        notification: true,
      })
    ).booking;
  return booking;
});

// Enviar (de novo) o link do check-in: POST /reserva/bookings/:id/checkin.
onRoute(MODULE, {
  method: "POST",
  path: "reserva/bookings/:id/checkin",
  op: "reserva.checkin",
});
onCommand(
  MODULE,
  "reserva.checkin",
  async (ctx, actor, data, { requestId }) => {
    ctx.access(actor, "conversations:write");
    const booking = await getBooking(ctx, data.id);
    requireValue(
      booking.conversation_id,
      "Esta reserva não está ligada a uma conversa do WhatsApp.",
    );
    const c = await ctx.conversation(booking.conversation_id, actor);
    const sent = await sendCheckin(ctx, await config(ctx), booking, {
      trigger: "agent",
      actor: actor.id,
      sourceKey: `command:${actor.id}:${requestId}`,
      conversation: c,
    });
    return sent.booking;
  },
);

// Cobrar (de novo) o sinal de uma reserva aguardando pagamento, por exemplo
// depois de configurar a conta em Gestão → Cobrança.
onRoute(MODULE, {
  method: "POST",
  path: "reserva/bookings/:id/deposit",
  op: "reserva.deposit",
});
onCommand(MODULE, "reserva.deposit", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const booking = await getBooking(ctx, data.id);
  requireValue(
    booking.status === "pending_payment" && booking.deposit_cents > 0,
    "Só reservas aguardando o sinal podem ser cobradas.",
  );
  // Cobrança antes da conversa: é o que a equipe resolve no painel.
  const ready = await ctx.paymentsReady();
  if (!ready.ready) throw new ApiError(409, ready.reason!, ready.message!);
  requireValue(
    booking.conversation_id,
    "Esta reserva não está ligada a uma conversa do WhatsApp.",
  );
  const c = await ctx.conversation(booking.conversation_id, actor);
  const result = await requestDeposit(ctx, await config(ctx), booking, c, {
    actor: actor.id,
    notification: true,
  });
  if (result.error) throw result.error;
  return result.booking;
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
