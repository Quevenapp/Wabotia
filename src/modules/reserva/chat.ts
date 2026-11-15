// Reserva no WhatsApp: unidade → data de entrada → diárias (ou dia →
// duração → horário, nas unidades por hora) → pessoas → resumo com valor →
// confirmação; e "Minhas reservas" (ver, cancelar dentro da política). Cada
// pergunta sai como botões (até 3 opções) ou lista nas linhas oficiais e como
// texto numerado nas linhas QR; mais de 9 opções viram páginas ("Mais
// opções"). A pergunta aberta fica em reserva_chats.
//
// `reservaTurn` recebe a resposta seguinte do cliente pelo gancho
// onConversationTurn do núcleo.
import { exec, one } from "../../db";
import {
  ApiError,
  type Conversation,
  json,
  now as clock,
  uid,
} from "../../types";
import { interactiveLine, interactivePayload } from "../../line-service";
import type { ModuleContext } from "../api";
import {
  addDays,
  brasiliaDate,
  clockOf,
  depositFor,
  fill,
  HOUR_MS,
  MINUTE_MS,
  money,
  moment,
  parseDate,
  reservaConfig,
  shortDay,
  type ReservaConfig,
} from "./config";
import { getUnit, listUnits, type Unit } from "./units";
import { depositFallbackText, requestDeposit } from "./deposit";
import {
  dailyPeriod,
  firstDay,
  freeNights,
  hourlyDays,
  hourlyPeriod,
  lastDay,
  refusalMessage,
  ruleRefusal,
  type Period,
} from "./availability";
import {
  cancelBooking,
  createBooking,
  describe,
  getBooking,
  summaryLine,
  upcomingFor,
  type Booking,
} from "./bookings";

/** Uma pergunta vale por 30 minutos. */
export const CHAT_TTL_MS = 30 * MINUTE_MS;
/** Opções por página; a décima linha da lista é "Mais opções". */
export const PAGE_SIZE = 9;
/** Dias examinados ao procurar datas livres. */
const DAYS_SCANNED = 62;

export type Step =
  | "unit"
  | "date"
  | "nights"
  | "duration"
  | "time"
  | "guests"
  | "confirm"
  | "mine"
  | "manage"
  | "cancel";

export interface Option {
  id: string;
  title: string;
  description?: string;
}
export interface ChatData {
  unit_id?: string;
  start_date?: string;
  nights?: number;
  duration?: number;
  starts?: number;
  guests?: number;
  page?: number;
  booking_id?: string;
  options?: Option[];
}
export interface ChatState {
  step: Step;
  data: ChatData;
  token: string;
  expires_at: number;
}
export interface Turn {
  text: string;
  /** Toque em botão ou lista; null quando o cliente digitou. */
  replyId?: string | null;
  rowId: string;
}

const cut = (value: string, max: number) => {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max - 1).join("") + "…";
};
const plain = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const hours = (minutes: number) =>
  minutes % 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
    : plural(minutes / 60, "hora", "horas");

// ---------------------------------------------------------------------------
// Estado

export async function loadState(
  ctx: ModuleContext,
  conversationId: string,
): Promise<ChatState | null> {
  const row = await one(
    ctx.env,
    "SELECT * FROM reserva_chats WHERE conversation_id=? AND profile_id=?",
    conversationId,
    ctx.profile,
  );
  return row
    ? {
        step: row.step,
        data: json(row.data),
        token: row.token,
        expires_at: row.expires_at,
      }
    : null;
}
async function saveState(
  ctx: ModuleContext,
  c: Conversation,
  state: ChatState,
) {
  await exec(
    ctx.env,
    "INSERT INTO reserva_chats(conversation_id,profile_id,step,data,token,expires_at,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET step=excluded.step,data=excluded.data,token=excluded.token,expires_at=excluded.expires_at,updated=excluded.updated",
    c.id,
    ctx.profile,
    state.step,
    JSON.stringify(state.data),
    state.token,
    state.expires_at,
    clock(),
  );
}
export const clearState = (ctx: ModuleContext, conversationId: string) =>
  exec(
    ctx.env,
    "DELETE FROM reserva_chats WHERE conversation_id=? AND profile_id=?",
    conversationId,
    ctx.profile,
  );

// ---------------------------------------------------------------------------
// Envio de perguntas

/**
 * Conteúdo de uma pergunta: botões de resposta (até 3 opções curtas) ou
 * lista nas linhas oficiais; o texto numerado sempre vai em `text`. Sem
 * opções (resposta digitada), só o texto.
 */
export function questionPayload(
  body: string,
  options: Option[],
  ids: string[],
  native: boolean,
) {
  const text = options.length
    ? `${body}\n${options
        .map(
          (o, i) =>
            `${i + 1}. ${o.title}${o.description ? ` - ${o.description}` : ""}`,
        )
        .join("\n")}\nResponda com o número da opção. Envie MENU para sair.`
    : `${body}\nEnvie MENU para sair.`;
  if (!native || !options.length) return { text };
  if (
    options.length <= 3 &&
    options.every((o) => Array.from(o.title).length <= 20 && !o.description)
  )
    return {
      text,
      content: {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: cut(body, 1024) },
          action: {
            buttons: options.map((o, i) => ({
              type: "reply",
              reply: { id: ids[i], title: o.title },
            })),
          },
        },
      },
    };
  const payload = interactivePayload(
    {
      type: "list",
      body: cut(body, 4096),
      button: "Escolher",
      footer: "Envie MENU para sair.",
      sections: [
        {
          rows: options.map((o, i) => ({
            id: ids[i],
            title: cut(o.title, 24),
            ...(o.description ? { description: cut(o.description, 72) } : {}),
          })),
        },
      ],
    },
    true,
  );
  return { text, content: (payload as any).content };
}

interface Flow {
  ctx: ModuleContext;
  c: Conversation;
  config: ReservaConfig;
  key: string;
  at: number;
}

async function ask(
  flow: Flow,
  step: Step,
  data: ChatData,
  body: string,
  options: Option[],
) {
  const token = uid().replace(/-/g, "").slice(0, 10);
  const payload = questionPayload(
    body,
    options,
    options.map((o) => `reserva:${token}:${o.id}`),
    await interactiveLine(flow.ctx.env, flow.c),
  );
  await saveState(flow.ctx, flow.c, {
    step,
    data: { ...data, options },
    token,
    expires_at: flow.at + CHAT_TTL_MS,
  });
  await flow.ctx.sendMessage(flow.c, payload, { key: flow.key });
}

async function say(flow: Flow, text: string, key = flow.key) {
  await flow.ctx.sendMessage(flow.c, { text }, { key });
}
async function stop(flow: Flow, text: string) {
  await clearState(flow.ctx, flow.c.id);
  await say(flow, text);
}

/** Página de opções com "Mais opções" e "Voltar ao início". */
export function paged(options: Option[], page: number) {
  const start = page * PAGE_SIZE;
  const slice = options.slice(start, start + PAGE_SIZE);
  if (options.length > start + PAGE_SIZE)
    slice.push({
      id: "more",
      title: "Mais opções",
      description: `Mais ${options.length - start - PAGE_SIZE}`,
    });
  else if (page > 0) slice.push({ id: "first", title: "Voltar ao início" });
  return slice;
}

// ---------------------------------------------------------------------------
// Perguntas da reserva

const priceLabel = (u: Unit) =>
  `${money(u.price_cents)} ${u.mode === "daily" ? "a diária" : "a hora"}`;

async function askUnit(flow: Flow, data: ChatData, prefix = "") {
  const units = await listUnits(flow.ctx, true);
  if (data.unit_id && units.some((u) => u.id === data.unit_id))
    return askDate(flow, data, prefix);
  if (!units.length)
    return stop(
      flow,
      "No momento não há unidades para reservar por aqui. Envie MENU para ver as outras opções.",
    );
  if (units.length === 1)
    return askDate(flow, { ...data, unit_id: units[0].id, page: 0 }, prefix);
  return ask(
    flow,
    "unit",
    data,
    prefix + flow.config.intro_text,
    paged(
      units.map((u) => ({
        id: u.id,
        title: u.name,
        description: `${priceLabel(u)} · até ${plural(u.capacity, "pessoa", "pessoas")}`,
      })),
      data.page || 0,
    ),
  );
}

async function unitOf(flow: Flow, data: ChatData) {
  try {
    const unit = await getUnit(flow.ctx, data.unit_id!);
    if (unit.active) return unit;
  } catch {
    // Excluída no meio da conversa.
  }
  await stop(
    flow,
    "Esta unidade não está mais disponível para reserva. Envie MENU para ver as opções.",
  );
  return null;
}

/** Datas de entrada com a estadia mínima livre (unidade por diária). */
async function checkinDates(flow: Flow, unit: Unit) {
  const from = firstDay(flow.config, flow.at);
  const last = lastDay(flow.config, flow.at);
  const nights = await freeNights(
    flow.ctx,
    unit,
    from,
    DAYS_SCANNED + flow.config.min_nights,
  );
  const dates: string[] = [];
  for (let i = 0; i < DAYS_SCANNED; i++) {
    const date = nights[i].date;
    if (date > last) break;
    if (!nights.slice(i, i + flow.config.min_nights).every((n) => n.free))
      continue;
    const period = dailyPeriod(
      flow.config,
      unit,
      date,
      addDays(date, flow.config.min_nights),
    );
    if (!ruleRefusal(flow.config, unit, period, flow.at)) dates.push(date);
  }
  return dates;
}

async function askDate(flow: Flow, data: ChatData, prefix = "") {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  if (unit.mode === "hourly") return askDay(flow, unit, data, prefix);
  const dates = await checkinDates(flow, unit);
  const options = dates.map((date) => ({ id: date, title: shortDay(date) }));
  const body = dates.length
    ? `${prefix}Qual a data de entrada em ${unit.name}? Escolha abaixo ou digite a data (ex.: ${shortDay(addDays(brasiliaDate(flow.at), 30)).slice(4)}).`
    : `${prefix}Não encontrei datas livres em ${unit.name} nos próximos dois meses. Digite a data de entrada que você quer (ex.: ${shortDay(addDays(brasiliaDate(flow.at), 70)).slice(4)}).`;
  return ask(flow, "date", data, body, paged(options, data.page || 0));
}

/** Diárias possíveis a partir da entrada (até a primeira noite ocupada). */
async function stayOptions(flow: Flow, unit: Unit, start: string) {
  const max = flow.config.max_nights;
  const nights = await freeNights(flow.ctx, unit, start, max);
  let free = 0;
  while (free < nights.length && nights[free].free) free++;
  return { free, max };
}

async function chooseDate(flow: Flow, data: ChatData, date: string) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const { free } = await stayOptions(flow, unit, date);
  const period = dailyPeriod(
    flow.config,
    unit,
    date,
    addDays(date, flow.config.min_nights),
  );
  const refusal =
    ruleRefusal(flow.config, unit, period, flow.at) ||
    (free < flow.config.min_nights ? (free ? "min_stay" : "booked") : null);
  if (refusal)
    return askDate(
      flow,
      { ...data, page: 0 },
      `${shortDay(date)}: ${refusalMessage(refusal, flow.config, unit)} `,
    );
  return askNights(flow, { ...data, start_date: date, page: 0 });
}

async function askNights(flow: Flow, data: ChatData) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const { free } = await stayOptions(flow, unit, data.start_date!);
  const options: Option[] = [];
  for (
    let n = flow.config.min_nights;
    n <= free && options.length < PAGE_SIZE;
    n++
  ) {
    const end = addDays(data.start_date!, n);
    options.push({
      id: String(n),
      title: plural(n, "diária", "diárias"),
      description: `saída ${shortDay(end)} · ${money(unit.price_cents * n)}`,
    });
  }
  if (options.length === 1)
    return askGuests(flow, { ...data, nights: flow.config.min_nights });
  return ask(
    flow,
    "nights",
    data,
    `Quantas diárias em ${unit.name}? Entrada ${moment(dailyPeriod(flow.config, unit, data.start_date!, addDays(data.start_date!, 1)).arrival_at)}.${free > options.length + flow.config.min_nights - 1 ? ` Para mais, digite o número (até ${free}).` : ""}`,
    options,
  );
}

// Unidades por hora: dia → duração → horário.

async function askDay(flow: Flow, unit: Unit, data: ChatData, prefix = "") {
  const duration = flow.config.min_hours * 60;
  const from = firstDay(flow.config, flow.at);
  const last = lastDay(flow.config, flow.at);
  const dates: string[] = [];
  for (let i = 0; i < 31; i++) {
    const date = addDays(from, i);
    if (date > last) break;
    dates.push(date);
  }
  const days = (
    await hourlyDays(flow.ctx, flow.config, unit, dates, duration, flow.at)
  ).filter((d) => d.slots.length);
  const options = days.map((d) => ({
    id: d.date,
    title: shortDay(d.date),
    description: `${plural(d.slots.length, "horário", "horários")}, a partir de ${clockOf(d.slots[0].starts)}`,
  }));
  return ask(
    flow,
    "date",
    data,
    days.length
      ? `${prefix}Qual dia para ${unit.name}? Escolha abaixo ou digite a data.`
      : `${prefix}Não há horários livres em ${unit.name} nos próximos 30 dias. Digite a data que você quer (ex.: ${shortDay(addDays(brasiliaDate(flow.at), 40)).slice(4)}).`,
    paged(options, data.page || 0),
  );
}

async function chooseDay(flow: Flow, data: ChatData, date: string) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const [day] = await hourlyDays(
    flow.ctx,
    flow.config,
    unit,
    [date],
    flow.config.min_hours * 60,
    flow.at,
  );
  if (!day.slots.length)
    return askDay(
      flow,
      unit,
      { ...data, page: 0 },
      `Não há horários livres em ${shortDay(date)}. `,
    );
  return askDuration(flow, { ...data, start_date: date, page: 0 });
}

async function askDuration(
  flow: Flow,
  data: ChatData,
  prefix = "",
): Promise<void> {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const options: Option[] = [];
  for (
    let h = flow.config.min_hours;
    h <= flow.config.max_hours && options.length < PAGE_SIZE;
    h++
  )
    options.push({
      id: String(h * 60),
      title: plural(h, "hora", "horas"),
      description: money(unit.price_cents * h),
    });
  if (options.length === 1 && !prefix)
    return askTime(flow, { ...data, duration: flow.config.min_hours * 60 });
  return ask(
    flow,
    "duration",
    data,
    `${prefix}Por quanto tempo você quer ${unit.name} em ${shortDay(data.start_date!)}?`,
    options,
  );
}

async function askTime(flow: Flow, data: ChatData, prefix = ""): Promise<void> {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const [day] = await hourlyDays(
    flow.ctx,
    flow.config,
    unit,
    [data.start_date!],
    data.duration!,
    flow.at,
  );
  if (!day.slots.length)
    return askDuration(
      flow,
      { ...data, page: 0 },
      `Não há ${hours(data.duration!)} seguidas livres em ${shortDay(data.start_date!)}. `,
    );
  const options = day.slots.map((s) => ({
    id: String(s.starts),
    title: clockOf(s.starts),
    description: `até ${clockOf(s.ends)} · ${money(s.price_cents)}`,
  }));
  return ask(
    flow,
    "time",
    data,
    `${prefix}Horários livres em ${shortDay(data.start_date!)} para ${hours(data.duration!)}:`,
    paged(options, data.page || 0),
  );
}

async function askGuests(flow: Flow, data: ChatData) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  if (unit.capacity <= 1) return askConfirm(flow, { ...data, guests: 1 });
  const options: Option[] = [];
  for (let n = 1; n <= Math.min(unit.capacity, PAGE_SIZE); n++)
    options.push({ id: String(n), title: plural(n, "pessoa", "pessoas") });
  return ask(
    flow,
    "guests",
    data,
    unit.capacity <= PAGE_SIZE
      ? `Quantas pessoas? ${unit.name} comporta até ${plural(unit.capacity, "pessoa", "pessoas")}.`
      : `Quantas pessoas? Digite o número (até ${unit.capacity}).`,
    unit.capacity <= PAGE_SIZE ? options : [],
  );
}

function periodFor(flow: Flow, unit: Unit, data: ChatData): Period {
  return unit.mode === "daily"
    ? dailyPeriod(
        flow.config,
        unit,
        data.start_date!,
        addDays(data.start_date!, data.nights!),
      )
    : hourlyPeriod(unit, data.starts!, data.duration!);
}

async function askConfirm(flow: Flow, data: ChatData) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  const period = periodFor(flow, unit, data);
  const deposit = depositFor(flow.config, period.price_cents);
  const lines = [
    "Resumo da reserva:",
    unit.name,
    unit.mode === "daily"
      ? `Entrada: ${moment(period.arrival_at)}\nSaída: ${moment(period.departure_at)}\n${plural(period.nights!, "diária", "diárias")} · ${plural(data.guests!, "pessoa", "pessoas")}`
      : `${shortDay(period.start_date)}, das ${clockOf(period.starts)} às ${clockOf(period.ends)} · ${plural(data.guests!, "pessoa", "pessoas")}`,
    `Total: ${money(period.price_cents)}`,
    ...(deposit > 0
      ? [
          `Sinal para garantir: ${money(deposit)}, pago em até ${hours(flow.config.deposit_deadline_minutes)} depois de confirmar.`,
        ]
      : []),
    ...(flow.config.cancellation_policy
      ? [`Cancelamento: ${flow.config.cancellation_policy}`]
      : []),
  ];
  return ask(flow, "confirm", data, lines.join("\n"), [
    { id: "yes", title: "Confirmar" },
    { id: "change", title: "Mudar datas" },
    { id: "no", title: "Desistir" },
  ]);
}

async function finish(flow: Flow, data: ChatData) {
  const unit = await unitOf(flow, data);
  if (!unit) return;
  let booking: Booking;
  try {
    booking = (
      await createBooking(flow.ctx, flow.config, {
        id: `wa-${flow.key.split(":").pop()}`,
        unit_id: unit.id,
        ...(unit.mode === "daily"
          ? { start_date: data.start_date, nights: data.nights }
          : { starts: data.starts, duration_minutes: data.duration }),
        guests: data.guests,
        conversation: flow.c,
        source: "whatsapp",
        actor: "customer",
        notify: false,
        at: flow.at,
      })
    ).booking;
  } catch (error) {
    if (
      error instanceof ApiError &&
      ["unit_unavailable", "unit_blocked", "outside_rules"].includes(error.code)
    )
      return askDate(
        flow,
        { unit_id: unit.id, page: 0 },
        unit.mode === "daily"
          ? "Essas datas acabaram de ser reservadas. "
          : "Esse horário acabou de ser reservado. ",
      );
    throw error;
  }
  await clearState(flow.ctx, flow.c.id);
  await afterBooked(flow, booking);
}

/**
 * Mensagem ao cliente depois de gravar. Com sinal: o texto com valor e prazo,
 * depois a cobrança (o núcleo envia o botão e o código Pix). Sem conta de
 * cobrança, a reserva segue aguardando e o cliente sabe que a equipe chama.
 */
async function afterBooked(flow: Flow, booking: Booking) {
  await say(
    flow,
    fill(
      booking.status === "confirmed"
        ? flow.config.confirmed_text
        : flow.config.pending_text,
      describe(booking),
    ),
    `booked:${booking.id}`,
  );
  if (booking.status !== "pending_payment") return;
  const { error, booking: after } = await requestDeposit(
    flow.ctx,
    flow.config,
    booking,
    flow.c,
    { actor: "customer", at: flow.at },
  );
  if (error)
    await say(flow, depositFallbackText(after), `deposit-failed:${booking.id}`);
}

// ---------------------------------------------------------------------------
// Minhas reservas

export const canCancel = (b: Booking, config: ReservaConfig, at: number) =>
  b.status === "pending_payment" ||
  b.arrival_at - config.customer_cancel_hours * HOUR_MS > at;

const statusLabel: Record<string, string> = {
  pending_payment: "aguardando o sinal",
  confirmed: "confirmada",
};

async function askMine(flow: Flow) {
  const upcoming = await upcomingFor(flow.ctx, flow.c, flow.at);
  if (!upcoming.length)
    return stop(
      flow,
      "Você não tem reservas marcadas. Envie MENU para fazer uma reserva.",
    );
  return ask(
    flow,
    "mine",
    {},
    "Suas reservas:",
    upcoming.slice(0, PAGE_SIZE).map((b) => ({
      id: b.id,
      title: `#${b.number} ${shortDay(b.start_date)}`,
      description: `${b.unit_name} · ${statusLabel[b.status] || b.status}`,
    })),
  );
}

/** Opções da reserva escolhida em Minhas reservas. */
async function manageOptions(flow: Flow, b: Booking): Promise<Option[]> {
  const options: Option[] = [];
  if (canCancel(b, flow.config, flow.at))
    options.push({ id: "cancel", title: "Cancelar reserva" });
  options.push({ id: "back", title: "Voltar" });
  return options;
}

async function askManage(flow: Flow, id: string) {
  const b = await getBooking(flow.ctx, id);
  if (!["pending_payment", "confirmed"].includes(b.status))
    return askMine(flow);
  const options = await manageOptions(flow, b);
  const lines = [
    `Reserva #${b.number} (${statusLabel[b.status]}):`,
    summaryLine(b),
    `Total: ${money(b.price_cents)}${b.deposit_cents ? ` · sinal ${money(b.deposit_cents)}${b.status === "pending_payment" && b.payment_due_at ? ` até ${moment(b.payment_due_at)}` : ""}` : ""}`,
  ];
  if (!canCancel(b, flow.config, flow.at))
    lines.push(
      `O cancelamento pelo WhatsApp vai até ${plural(flow.config.customer_cancel_hours, "hora", "horas")} antes da entrada. Para mudar agora, fale com a equipe.`,
    );
  return ask(flow, "manage", { booking_id: b.id }, lines.join("\n"), options);
}

async function askCancel(flow: Flow, id: string) {
  const b = await getBooking(flow.ctx, id);
  if (!canCancel(b, flow.config, flow.at)) return askManage(flow, id);
  return ask(
    flow,
    "cancel",
    { booking_id: b.id },
    `Cancelar a reserva #${b.number} (${summaryLine(b)})?${flow.config.cancellation_policy ? `\nPolítica de cancelamento: ${flow.config.cancellation_policy}` : ""}`,
    [
      { id: "yes", title: "Sim, cancelar" },
      { id: "no", title: "Não" },
    ],
  );
}

async function customerCancel(flow: Flow, id: string) {
  const b = await getBooking(flow.ctx, id);
  if (!["pending_payment", "confirmed"].includes(b.status))
    return stop(flow, "Esta reserva já foi encerrada.");
  if (!canCancel(b, flow.config, flow.at)) return askManage(flow, id);
  const done = await cancelBooking(flow.ctx, flow.config, {
    id,
    actor: "customer",
    reason: "Cancelada pelo cliente no WhatsApp",
    notify: false,
  });
  await clearState(flow.ctx, flow.c.id);
  await say(
    flow,
    fill(flow.config.cancelled_text, describe(done)) +
      " Se quiser reservar de novo, envie MENU.",
    `cancelled:${id}`,
  );
}

// ---------------------------------------------------------------------------
// Entradas

async function flowFor(
  ctx: ModuleContext,
  c: Conversation,
  key: string,
  at: number,
): Promise<Flow> {
  return {
    ctx,
    c,
    config: reservaConfig((await ctx.settings())?.reserva),
    key,
    at,
  };
}

/** Item de menu "Fazer reserva". */
export async function startBooking(
  ctx: ModuleContext,
  c: Conversation,
  options: { key: string; at?: number },
) {
  return askUnit(await flowFor(ctx, c, options.key, options.at ?? clock()), {
    page: 0,
  });
}

/** Item de menu "Minhas reservas". */
export async function startMine(
  ctx: ModuleContext,
  c: Conversation,
  options: { key: string; at?: number },
) {
  return askMine(await flowFor(ctx, c, options.key, options.at ?? clock()));
}

/** Resposta digitada que não é número de opção (data, diárias, pessoas). */
async function typed(
  flow: Flow,
  state: ChatState,
  data: ChatData,
  value: string,
): Promise<boolean> {
  if (state.step === "date") {
    const date = parseDate(value, brasiliaDate(flow.at));
    if (!date) return false;
    const unit = await unitOf(flow, data);
    if (!unit) return true;
    if (unit.mode === "daily") await chooseDate(flow, data, date);
    else await chooseDay(flow, data, date);
    return true;
  }
  const n = /^\d{1,4}$/.test(value) ? Number(value) : null;
  if (n === null) return false;
  if (state.step === "nights") {
    const unit = await unitOf(flow, data);
    if (!unit) return true;
    const { free } = await stayOptions(flow, unit, data.start_date!);
    if (n < flow.config.min_nights || n > free) {
      await say(
        flow,
        `Escolha de ${flow.config.min_nights} a ${free} diárias, ou envie MENU para sair.`,
      );
      return true;
    }
    await askGuests(flow, { ...data, nights: n });
    return true;
  }
  if (state.step === "guests") {
    const unit = await unitOf(flow, data);
    if (!unit) return true;
    if (n < 1 || n > unit.capacity) {
      await say(
        flow,
        `${unit.name} comporta até ${plural(unit.capacity, "pessoa", "pessoas")}. Digite um número de 1 a ${unit.capacity}.`,
      );
      return true;
    }
    await askConfirm(flow, { ...data, guests: n });
    return true;
  }
  return false;
}

/**
 * Resposta do cliente com a pergunta da Reserva aberta. Devolve true quando
 * tratou; false deixa a mensagem para o menu e o bot (MENU, VOLTAR, outra
 * conversa, pergunta vencida).
 */
export async function reservaTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: Turn,
  at = clock(),
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const flow = await flowFor(ctx, c, `turn:${turn.rowId}`, at);
  const state = await loadState(ctx, c.id);
  if (!state) return false;
  if (state.expires_at <= at) {
    await clearState(ctx, c.id);
    return false;
  }
  const value = plain(turn.text || "");
  if (!turn.replyId && ["menu", "voltar", "sair"].includes(value)) {
    await clearState(ctx, c.id);
    return false;
  }
  const options = state.data.options || [];
  const data = { ...state.data };
  delete data.options;
  let choice: string | null = null;
  if (turn.replyId) {
    if (!turn.replyId.startsWith("reserva:")) {
      // Toque em outra mensagem interativa (menu, fila): sai da Reserva.
      await clearState(ctx, c.id);
      return false;
    }
    const prefix = `reserva:${state.token}:`;
    choice = turn.replyId.startsWith(prefix)
      ? turn.replyId.slice(prefix.length)
      : null;
    if (!choice || !options.some((o) => o.id === choice)) {
      await say(
        flow,
        "Essa opção é de uma mensagem anterior. Use a última mensagem ou envie MENU para sair.",
      );
      return true;
    }
  } else if (/^\d+$/.test(value) && Number(value) <= options.length)
    choice = options[Number(value) - 1]?.id || null;
  else choice = options.find((o) => plain(o.title) === value)?.id || null;
  if (!choice) {
    if (await typed(flow, state, data, turn.text || "")) return true;
    await say(
      flow,
      options.length
        ? "Não entendi. Responda com o número de uma das opções ou envie MENU para sair."
        : "Não entendi. Responda com um número ou envie MENU para sair.",
    );
    return true;
  }
  if (choice === "more" || choice === "first") {
    data.page = choice === "more" ? (data.page || 0) + 1 : 0;
    if (state.step === "unit") await askUnit(flow, data);
    else if (state.step === "date") await askDate(flow, data);
    else if (state.step === "time") await askTime(flow, data);
    return true;
  }
  switch (state.step) {
    case "unit":
      await askDate(flow, { unit_id: choice, page: 0 });
      break;
    case "date": {
      const unit = await unitOf(flow, data);
      if (!unit) break;
      if (unit.mode === "daily") await chooseDate(flow, data, choice);
      else await chooseDay(flow, data, choice);
      break;
    }
    case "nights":
      await askGuests(flow, { ...data, nights: Number(choice) });
      break;
    case "duration":
      await askTime(flow, { ...data, duration: Number(choice), page: 0 });
      break;
    case "time":
      await askGuests(flow, { ...data, starts: Number(choice) });
      break;
    case "guests":
      await askConfirm(flow, { ...data, guests: Number(choice) });
      break;
    case "confirm":
      if (choice === "yes") await finish(flow, data);
      else if (choice === "change")
        await askDate(flow, { unit_id: data.unit_id, page: 0 });
      else
        await stop(
          flow,
          "Tudo bem, nada foi reservado. Envie MENU para ver as opções.",
        );
      break;
    case "mine":
      await askManage(flow, choice);
      break;
    case "manage":
      if (choice === "cancel") await askCancel(flow, data.booking_id!);
      else await manageChoice(flow, data, choice);
      break;
    case "cancel":
      if (choice === "yes") await customerCancel(flow, data.booking_id!);
      else await askManage(flow, data.booking_id!);
      break;
  }
  return true;
}

/** Outras opções da reserva escolhida (Voltar e as do check-in). */
async function manageChoice(flow: Flow, _data: ChatData, _choice: string) {
  await askMine(flow);
}
