// Agenda no WhatsApp: serviço → profissional (ou qualquer um) → dia →
// horário → confirmação, e "Meus agendamentos" (remarcar, cancelar). Cada
// pergunta sai como botões (até 3) ou lista (até 10) nas linhas oficiais e
// como texto numerado nas linhas QR; mais de 9 opções viram páginas ("Mais
// opções"). A pergunta aberta fica em agenda_chats.
//
// `agendaTurn` recebe a resposta seguinte do cliente pelo gancho
// onConversationTurn do núcleo. Com `web_page` nas regras, o item de menu usa
// a página do link (webflow.ts) em vez desta conversa.
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
  agendaConfig,
  clockOf,
  fill,
  longDay,
  MINUTE_MS,
  money,
  shortDay,
  type AgendaConfig,
} from "./config";
import { listProfessionals, listServices } from "./catalog";
import { availability, bookableDates, eligible } from "./availability";
import {
  book,
  cancel,
  confirm,
  describe,
  getAppointment,
  move,
  upcomingFor,
  type Appointment,
} from "./appointments";

/** Uma pergunta vale por 30 minutos. */
export const CHAT_TTL_MS = 30 * MINUTE_MS;
/** Opções por página; a décima linha da lista é "Mais opções". */
export const PAGE_SIZE = 9;
/** Dias examinados ao procurar dias com horário livre. */
const DAYS_SCANNED = 62;

export type Step =
  | "service"
  | "professional"
  | "day"
  | "time"
  | "confirm"
  | "mine"
  | "manage"
  | "reminder";

export interface Option {
  id: string;
  title: string;
  description?: string;
}
export interface ChatData {
  service_id?: string;
  /** null: qualquer profissional; ausente: ainda não escolhido. */
  professional_id?: string | null;
  date?: string;
  starts?: number;
  page?: number;
  reschedule_id?: string;
  appointment_id?: string;
  /** Item de menu com serviço fixo. */
  fixed_service?: boolean;
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

// ---------------------------------------------------------------------------
// Estado

export async function loadState(
  ctx: ModuleContext,
  conversationId: string,
): Promise<ChatState | null> {
  const row = await one(
    ctx.env,
    "SELECT * FROM agenda_chats WHERE conversation_id=? AND profile_id=?",
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
export async function saveState(
  ctx: ModuleContext,
  c: Conversation,
  state: ChatState,
) {
  await exec(
    ctx.env,
    "INSERT INTO agenda_chats(conversation_id,profile_id,step,data,token,expires_at,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET step=excluded.step,data=excluded.data,token=excluded.token,expires_at=excluded.expires_at,updated=excluded.updated",
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
    "DELETE FROM agenda_chats WHERE conversation_id=? AND profile_id=?",
    conversationId,
    ctx.profile,
  );

// ---------------------------------------------------------------------------
// Envio de perguntas

/**
 * Conteúdo de uma pergunta: botões de resposta (até 3 opções curtas) ou
 * lista nas linhas oficiais; o texto numerado sempre vai em `text`.
 */
export function questionPayload(
  body: string,
  options: Option[],
  ids: string[],
  native: boolean,
) {
  const text = `${body}\n${options
    .map(
      (o, i) =>
        `${i + 1}. ${o.title}${o.description ? ` - ${o.description}` : ""}`,
    )
    .join("\n")}\nResponda com o número da opção. Envie MENU para sair.`;
  if (!native) return { text };
  if (
    options.length <= 3 &&
    options.every((o) => Array.from(o.title).length <= 20)
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

async function ask(
  ctx: ModuleContext,
  c: Conversation,
  step: Step,
  data: ChatData,
  body: string,
  options: Option[],
  key: string,
  at: number,
  expiresAt = at + CHAT_TTL_MS,
) {
  const token = uid().replace(/-/g, "").slice(0, 10);
  const payload = questionPayload(
    body,
    options,
    options.map((o) => `agenda:${token}:${o.id}`),
    await interactiveLine(ctx.env, c),
  );
  await saveState(ctx, c, {
    step,
    data: { ...data, options },
    token,
    expires_at: expiresAt,
  });
  await ctx.sendMessage(c, payload, { key });
}

async function say(
  ctx: ModuleContext,
  c: Conversation,
  text: string,
  key: string,
) {
  await ctx.sendMessage(c, { text }, { key });
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
// Perguntas do agendamento

interface Flow {
  ctx: ModuleContext;
  c: Conversation;
  config: AgendaConfig;
  key: string;
  at: number;
}

async function catalog(ctx: ModuleContext) {
  const [services, professionals] = await Promise.all([
    listServices(ctx, true),
    listProfessionals(ctx, true),
  ]);
  return {
    services: services.filter((s) => eligible(s, professionals).length),
    professionals,
  };
}

async function askService(flow: Flow, data: ChatData, prefix = "") {
  const { services } = await catalog(flow.ctx);
  if (data.service_id) {
    if (services.some((s) => s.id === data.service_id))
      return askProfessional(flow, data, prefix);
    delete data.service_id;
  }
  if (!services.length) {
    await clearState(flow.ctx, flow.c.id);
    return say(
      flow.ctx,
      flow.c,
      "No momento não há horários para agendar por aqui. Envie MENU para ver as outras opções.",
      flow.key,
    );
  }
  if (services.length === 1)
    return askProfessional(
      flow,
      { ...data, service_id: services[0].id, page: 0 },
      prefix,
    );
  const options = services.map((s) => ({
    id: s.id,
    title: s.name,
    description: [
      `${s.duration_minutes} min`,
      s.price_cents !== null ? money(s.price_cents) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return ask(
    flow.ctx,
    flow.c,
    "service",
    data,
    prefix + flow.config.intro_text,
    paged(options, data.page || 0),
    flow.key,
    flow.at,
  );
}

async function askProfessional(flow: Flow, data: ChatData, prefix = "") {
  const { services, professionals } = await catalog(flow.ctx);
  const service = services.find((s) => s.id === data.service_id);
  if (!service) {
    await clearState(flow.ctx, flow.c.id);
    return say(
      flow.ctx,
      flow.c,
      "Este serviço não está disponível para agendar agora. Envie MENU para ver as opções.",
      flow.key,
    );
  }
  const candidates = eligible(service, professionals);
  if (data.professional_id !== undefined || candidates.length <= 1)
    return askDay(
      flow,
      {
        ...data,
        professional_id:
          data.professional_id !== undefined
            ? data.professional_id
            : candidates[0].id,
        page: 0,
      },
      prefix,
    );
  const options: Option[] = [
    { id: "any", title: "Qualquer um", description: "Primeiro horário livre" },
    ...candidates.map((p) => ({ id: p.id, title: p.name })),
  ];
  return ask(
    flow.ctx,
    flow.c,
    "professional",
    data,
    `${prefix}Com quem você quer ${service.name}?`,
    paged(options, data.page || 0),
    flow.key,
    flow.at,
  );
}

async function names(ctx: ModuleContext, data: ChatData) {
  const [services, professionals] = await Promise.all([
    listServices(ctx),
    listProfessionals(ctx),
  ]);
  return {
    service: services.find((s) => s.id === data.service_id),
    professional: data.professional_id
      ? professionals.find((p) => p.id === data.professional_id)
      : null,
  };
}

async function askDay(flow: Flow, data: ChatData, prefix = "") {
  const dates = bookableDates(flow.config, flow.at).slice(0, DAYS_SCANNED);
  const found = await availability(flow.ctx, flow.config, {
    serviceId: data.service_id!,
    professionalId: data.professional_id || null,
    dates,
    now: flow.at,
    ignore: data.reschedule_id,
  });
  const days = found.days.filter((d) => d.slots.length);
  const { service, professional } = await names(flow.ctx, data);
  if (!days.length) {
    await clearState(flow.ctx, flow.c.id);
    return say(
      flow.ctx,
      flow.c,
      `${prefix}Não há horários livres para ${service?.name}${professional ? ` com ${professional.name}` : ""} nos próximos dias. Envie MENU para ver as opções.`,
      flow.key,
    );
  }
  const options = days.map((d) => ({
    id: d.date,
    title: shortDay(d.date),
    description: `${d.slots.length} ${d.slots.length === 1 ? "horário" : "horários"}, a partir de ${clockOf(d.slots[0].starts)}`,
  }));
  return ask(
    flow.ctx,
    flow.c,
    "day",
    data,
    `${prefix}Qual dia para ${service?.name}${professional ? ` com ${professional.name}` : ""}?`,
    paged(options, data.page || 0),
    flow.key,
    flow.at,
  );
}

async function askTime(flow: Flow, data: ChatData, prefix = "") {
  const found = await availability(flow.ctx, flow.config, {
    serviceId: data.service_id!,
    professionalId: data.professional_id || null,
    dates: [data.date!],
    now: flow.at,
    ignore: data.reschedule_id,
  });
  const slots = found.days[0]?.slots || [];
  if (!slots.length)
    return askDay(
      flow,
      { ...data, page: 0 },
      `${prefix}Os horários de ${longDay(data.date!)} acabaram. `,
    );
  const options = slots.map((s) => ({
    id: String(s.starts),
    title: clockOf(s.starts),
  }));
  return ask(
    flow.ctx,
    flow.c,
    "time",
    data,
    `${prefix}Horários livres em ${longDay(data.date!)}:`,
    paged(options, data.page || 0),
    flow.key,
    flow.at,
  );
}

async function askConfirm(flow: Flow, data: ChatData) {
  const { service, professional } = await names(flow.ctx, data);
  const price =
    service?.price_cents !== null && service?.price_cents !== undefined
      ? ` Valor: ${money(service.price_cents)}.`
      : "";
  return ask(
    flow.ctx,
    flow.c,
    "confirm",
    data,
    `${data.reschedule_id ? "Remarcar para" : "Confirma"} ${service?.name}${professional ? ` com ${professional.name}` : ""}, ${longDay(data.date!)} às ${clockOf(data.starts!)}?${price}`,
    [
      { id: "yes", title: "Confirmar" },
      { id: "other", title: "Outro horário" },
      { id: "no", title: "Desistir" },
    ],
    flow.key,
    flow.at,
  );
}

async function finish(flow: Flow, data: ChatData) {
  const { ctx, c, config } = flow;
  let appointment: Appointment;
  try {
    if (data.reschedule_id) {
      const before = await getAppointment(ctx, data.reschedule_id);
      if (!canChange(before, config, flow.at)) return tooLate(flow, before);
      appointment = await move(ctx, config, {
        id: data.reschedule_id,
        starts: data.starts!,
        professional_id: data.professional_id ?? null,
        actor: "customer",
        notify: false,
      });
    } else
      appointment = (
        await book(ctx, config, {
          id: `wa-${flow.key.split(":").pop()}`,
          service_id: data.service_id!,
          professional_id: data.professional_id ?? null,
          starts: data.starts!,
          conversation: c,
          source: "whatsapp",
          actor: "customer",
          notify: false,
        })
      ).appointment;
  } catch (error) {
    if (
      error instanceof ApiError &&
      ["slot_taken", "slot_unavailable"].includes(error.code)
    )
      return askTime(
        flow,
        { ...data, page: 0 },
        "Esse horário acabou de ser ocupado. ",
      );
    if (error instanceof ApiError && error.code === "appointment_closed") {
      await clearState(ctx, c.id);
      return say(ctx, c, error.message, flow.key);
    }
    throw error;
  }
  await clearState(ctx, c.id);
  return say(
    ctx,
    c,
    data.reschedule_id
      ? `Remarcado! ${appointment.service_name} com ${appointment.professional_name}, ${longDay(appointment.date)} às ${appointment.time}.`
      : fill(config.booked_text, describe(appointment)),
    `${data.reschedule_id ? "moved" : "booked"}:${appointment.id}:${appointment.moves}`,
  );
}

// ---------------------------------------------------------------------------
// Meus agendamentos

export const canChange = (a: Appointment, config: AgendaConfig, at: number) =>
  a.starts - config.customer_change_hours * 3600000 > at;

function tooLate(flow: Flow, a: Appointment) {
  return clearState(flow.ctx, flow.c.id).then(() =>
    say(
      flow.ctx,
      flow.c,
      `Faltam menos de ${flow.config.customer_change_hours} ${flow.config.customer_change_hours === 1 ? "hora" : "horas"} para ${a.service_name} (${longDay(a.date)} às ${a.time}). Para mudar, fale com a equipe.`,
      flow.key,
    ),
  );
}

async function askMine(flow: Flow) {
  const upcoming = await upcomingFor(flow.ctx, flow.c, flow.at);
  if (!upcoming.length) {
    await clearState(flow.ctx, flow.c.id);
    return say(
      flow.ctx,
      flow.c,
      "Você não tem agendamentos marcados. Envie MENU para agendar.",
      flow.key,
    );
  }
  return ask(
    flow.ctx,
    flow.c,
    "mine",
    {},
    "Seus agendamentos:",
    upcoming.slice(0, PAGE_SIZE).map((a) => ({
      id: a.id,
      title: `${shortDay(a.date)} ${a.time}`,
      description: `${a.service_name} com ${a.professional_name}${a.status === "confirmed" ? " (confirmado)" : ""}`,
    })),
    flow.key,
    flow.at,
  );
}

async function askManage(flow: Flow, id: string) {
  const a = await getAppointment(flow.ctx, id);
  if (!["booked", "confirmed"].includes(a.status)) return askMine(flow);
  if (!canChange(a, flow.config, flow.at)) return tooLate(flow, a);
  return ask(
    flow.ctx,
    flow.c,
    "manage",
    { appointment_id: a.id },
    `${a.service_name} com ${a.professional_name}, ${longDay(a.date)} às ${a.time}. O que você quer fazer?`,
    [
      { id: "move", title: "Remarcar" },
      { id: "cancel", title: "Cancelar horário" },
      { id: "back", title: "Voltar" },
    ],
    flow.key,
    flow.at,
  );
}

async function customerCancel(flow: Flow, id: string) {
  const a = await getAppointment(flow.ctx, id);
  if (!["booked", "confirmed"].includes(a.status)) {
    await clearState(flow.ctx, flow.c.id);
    return say(
      flow.ctx,
      flow.c,
      "Este agendamento já foi encerrado.",
      flow.key,
    );
  }
  if (!canChange(a, flow.config, flow.at)) return tooLate(flow, a);
  const done = await cancel(flow.ctx, flow.config, {
    id,
    actor: "customer",
    reason: "Cancelado pelo cliente no WhatsApp",
    notify: false,
  });
  await clearState(flow.ctx, flow.c.id);
  return say(
    flow.ctx,
    flow.c,
    fill(flow.config.cancelled_text, describe(done)) +
      " Se quiser marcar outro, envie MENU.",
    `cancelled:${id}`,
  );
}

async function startReschedule(flow: Flow, id: string) {
  const a = await getAppointment(flow.ctx, id);
  if (!["booked", "confirmed"].includes(a.status)) return askMine(flow);
  if (!canChange(a, flow.config, flow.at)) return tooLate(flow, a);
  return askProfessional(flow, {
    service_id: a.service_id,
    reschedule_id: a.id,
    page: 0,
  });
}

async function customerConfirm(flow: Flow, id: string) {
  const a = await getAppointment(flow.ctx, id);
  await clearState(flow.ctx, flow.c.id);
  if (!["booked", "confirmed"].includes(a.status))
    return say(
      flow.ctx,
      flow.c,
      "Este agendamento já foi encerrado.",
      flow.key,
    );
  await confirm(flow.ctx, { id, actor: "customer" });
  return say(
    flow.ctx,
    flow.c,
    `Confirmado! Até ${longDay(a.date)} às ${a.time}.`,
    `confirmed:${id}`,
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
    config: agendaConfig((await ctx.settings())?.agenda),
    key,
    at,
  };
}

/** Item de menu "Agendar horário" (ou remarcação já escolhida). */
export async function startBooking(
  ctx: ModuleContext,
  c: Conversation,
  options: { key: string; serviceId?: string | null; at?: number },
) {
  const flow = await flowFor(ctx, c, options.key, options.at ?? clock());
  return askService(flow, {
    page: 0,
    ...(options.serviceId
      ? { service_id: options.serviceId, fixed_service: true }
      : {}),
  });
}

/** Item de menu "Meus agendamentos". */
export async function startMine(
  ctx: ModuleContext,
  c: Conversation,
  options: { key: string; at?: number },
) {
  return askMine(await flowFor(ctx, c, options.key, options.at ?? clock()));
}

/** Ids dos botões do lembrete: valem mesmo sem pergunta aberta. */
export const reminderReply = (id: string, action: string) =>
  `agenda:remind:${id}:${action}`;
export const REMINDER_OPTIONS: Option[] = [
  { id: "confirm", title: "Confirmar" },
  { id: "move", title: "Remarcar" },
  { id: "cancel", title: "Cancelar" },
];

async function reminderAction(
  flow: Flow,
  appointmentId: string,
  action: string,
): Promise<boolean> {
  let a: Appointment;
  try {
    a = await getAppointment(flow.ctx, appointmentId);
  } catch {
    await say(flow.ctx, flow.c, "Agendamento não encontrado.", flow.key);
    return true;
  }
  if (a.conversation_id !== flow.c.id) return false;
  if (action === "confirm") await customerConfirm(flow, a.id);
  else if (action === "move") await startReschedule(flow, a.id);
  else if (action === "cancel") await customerCancel(flow, a.id);
  else return false;
  return true;
}

/**
 * Resposta do cliente com a pergunta da Agenda aberta (ou botão do
 * lembrete). Devolve true quando tratou; false deixa a mensagem para o menu
 * e o bot (MENU, VOLTAR, outra conversa, pergunta vencida).
 */
export async function agendaTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: Turn,
  at = clock(),
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const flow = await flowFor(ctx, c, `turn:${turn.rowId}`, at);
  const reminder = /^agenda:remind:([^:]+):(\w+)$/.exec(turn.replyId || "");
  if (reminder) return reminderAction(flow, reminder[1], reminder[2]);
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
  let choice: string | null = null;
  if (turn.replyId) {
    const prefix = `agenda:${state.token}:`;
    if (!turn.replyId.startsWith("agenda:")) {
      // Toque em outra mensagem interativa (menu, fila): sai da Agenda.
      await clearState(ctx, c.id);
      return false;
    }
    choice = turn.replyId.startsWith(prefix)
      ? turn.replyId.slice(prefix.length)
      : null;
    if (!choice || !options.some((o) => o.id === choice)) {
      await say(
        ctx,
        c,
        "Essa opção é de uma mensagem anterior. Use a última mensagem ou envie MENU para sair.",
        flow.key,
      );
      return true;
    }
  } else if (/^\d+$/.test(value))
    choice = options[Number(value) - 1]?.id || null;
  else choice = options.find((o) => plain(o.title) === value)?.id || null;
  if (!choice) {
    // O lembrete não prende a conversa: outra mensagem segue o caminho normal.
    if (state.step === "reminder") {
      await clearState(ctx, c.id);
      return false;
    }
    await say(
      ctx,
      c,
      "Não entendi. Responda com o número de uma das opções ou envie MENU para sair.",
      flow.key,
    );
    return true;
  }
  const data = { ...state.data };
  delete data.options;
  if (choice === "more" || choice === "first") {
    data.page = choice === "more" ? (data.page || 0) + 1 : 0;
    const again: Record<string, (f: Flow, d: ChatData) => Promise<unknown>> = {
      service: askService,
      professional: askProfessional,
      day: askDay,
      time: askTime,
    };
    await (again[state.step] || askService)(flow, data);
    return true;
  }
  switch (state.step) {
    case "service":
      await askProfessional(flow, { ...data, service_id: choice, page: 0 });
      break;
    case "professional":
      await askDay(flow, {
        ...data,
        professional_id: choice === "any" ? null : choice,
        page: 0,
      });
      break;
    case "day":
      await askTime(flow, { ...data, date: choice, page: 0 });
      break;
    case "time":
      await askConfirm(flow, { ...data, starts: Number(choice) });
      break;
    case "confirm":
      if (choice === "yes") await finish(flow, data);
      else if (choice === "other")
        await askDay(flow, { ...data, page: 0, starts: undefined });
      else {
        await clearState(ctx, c.id);
        await say(
          ctx,
          c,
          data.reschedule_id
            ? "Tudo bem, o agendamento continua como estava."
            : "Tudo bem, nada foi agendado. Envie MENU para ver as opções.",
          flow.key,
        );
      }
      break;
    case "mine":
      await askManage(flow, choice);
      break;
    case "manage":
      if (choice === "move") await startReschedule(flow, data.appointment_id!);
      else if (choice === "cancel")
        await customerCancel(flow, data.appointment_id!);
      else await askMine(flow);
      break;
    case "reminder":
      await reminderAction(flow, data.appointment_id!, choice);
      break;
  }
  return true;
}

/** Pergunta do lembrete com Confirmar, Remarcar e Cancelar. */
export async function reminderQuestion(
  ctx: ModuleContext,
  c: Conversation,
  a: Appointment,
  text: string,
  at: number,
) {
  const payload = questionPayload(
    text,
    REMINDER_OPTIONS,
    REMINDER_OPTIONS.map((o) => reminderReply(a.id, o.id)),
    await interactiveLine(ctx.env, c),
  );
  // Para responder com número nas linhas QR. Não toma o lugar de um
  // agendamento em andamento.
  const open = await loadState(ctx, c.id);
  if (!open || open.expires_at <= at || open.step === "reminder")
    await saveState(ctx, c, {
      step: "reminder",
      data: { appointment_id: a.id, options: REMINDER_OPTIONS },
      token: "remind",
      expires_at: Math.min(a.starts, at + 24 * 3600000),
    });
  return payload;
}
