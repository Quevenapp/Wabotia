// Agenda pelo passo web: usada com `web_page` nas regras e no "Enviar link
// para agendar" da equipe (o padrão é a conversa no chat, chat.ts).
// Página 1: serviço, profissional e dia. Página 2: horário. "Meus
// agendamentos": escolher o agendamento e remarcar ou cancelar. Cada página
// devolve o cliente ao WhatsApp, onde chega a próxima mensagem.
import { ApiError, type Conversation } from "../../types";
import type { Answers, WebField } from "../../web-steps";
import type { ModuleContext, WebStep } from "../api";
import {
  agendaConfig,
  clockOf,
  fill,
  longDay,
  money,
  shortDay,
  type AgendaConfig,
  validDate,
  brasiliaDate,
  dayStart,
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
} from "./appointments";
import { canChange } from "./chat";

const ANY = "Qualquer um";
const CONFIRM = "Confirmar presença";
const OTHER_DAY = "Escolher outro dia";
const TIME_CHOICES = 19;

const serviceLabel = (s: {
  name: string;
  duration_minutes: number;
  price_cents: number | null;
}) =>
  `${s.name} (${s.duration_minutes} min${s.price_cents !== null ? `, ${money(s.price_cents)}` : ""})`;

async function configOf(ctx: ModuleContext) {
  return agendaConfig((await ctx.settings())?.agenda);
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

/** Página 1: serviço, profissional e dia (ref = agendamento remarcado). */
export async function sendBookingStep(
  ctx: ModuleContext,
  c: Conversation,
  options: {
    sourceKey: string;
    trigger: "menu" | "module" | "agent";
    actor?: string;
    serviceId?: string | null;
    reschedule?: string | null;
    text?: string;
  },
) {
  const config = await configOf(ctx);
  const { services, professionals } = await catalog(ctx);
  const fixed = options.serviceId
    ? services.filter((s) => s.id === options.serviceId)
    : services;
  if (!fixed.length) {
    await ctx.sendMessage(
      c,
      {
        text: "No momento não há horários para agendar por aqui. Envie MENU para ver as outras opções.",
      },
      { key: `empty:${options.sourceKey}` },
    );
    return null;
  }
  const people = professionals.filter((p) =>
    fixed.some((s) => p.service_ids.includes(s.id)),
  );
  const fields: WebField[] = [];
  if (fixed.length > 1)
    fields.push({
      id: "servico",
      type: "choice",
      label: "Serviço",
      required: true,
      options: fixed.slice(0, 20).map(serviceLabel),
    });
  if (people.length > 1)
    fields.push({
      id: "profissional",
      type: "choice",
      label: "Profissional",
      required: true,
      options: [ANY, ...people.slice(0, 19).map((p) => p.name)],
    });
  const dates = bookableDates(config, Date.now());
  fields.push({
    id: "dia",
    type: "date",
    label: "Dia",
    required: true,
    help: `De ${shortDay(dates[0])} a ${shortDay(dates.at(-1)!)}.`,
  });
  const single = fixed.length === 1 ? fixed[0] : null;
  return ctx.openWebStep(c, {
    kind: "book",
    ref: [
      options.reschedule || "",
      single?.id || "",
      people.length === 1 ? people[0].id : "",
    ].join("|"),
    trigger: options.trigger,
    actor: options.actor || "system",
    sourceKey: options.sourceKey,
    ttlMinutes: 60,
    text:
      options.text ||
      (options.reschedule
        ? "Escolha o novo dia no link:"
        : `${config.intro_text} Escolha no link:`),
    button: "Escolher dia",
    spec: {
      title: options.reschedule ? "Remarcar horário" : "Agendar horário",
      intro: single
        ? `${serviceLabel(single)}${people.length === 1 ? ` com ${people[0].name}` : ""}.`
        : "Escolha o serviço e o dia. Os horários livres chegam no WhatsApp.",
      fields,
      submit_label: "Ver horários",
      done_text: "Pronto! Volte ao WhatsApp para escolher o horário.",
      return_text: "Recebido! Veja os horários livres:",
      ticket: "none",
    },
  });
}

/** Página 2: horário (ref = serviço|profissional ou any|dia|remarcado). */
async function sendTimeStep(
  ctx: ModuleContext,
  c: Conversation,
  config: AgendaConfig,
  choice: {
    service: string;
    professional: string | null;
    date: string;
    reschedule: string;
  },
  sourceKey: string,
) {
  const found = await availability(ctx, config, {
    serviceId: choice.service,
    professionalId: choice.professional,
    dates: [choice.date],
    now: Date.now(),
    ignore: choice.reschedule || undefined,
  });
  const slots = found.days[0]?.slots || [];
  if (!slots.length)
    return sendBookingStep(ctx, c, {
      sourceKey: `${sourceKey}:again`,
      trigger: "module",
      serviceId: choice.service,
      reschedule: choice.reschedule || null,
      text: `Não há horários livres em ${longDay(choice.date)}. Escolha outro dia no link:`,
    });
  const shown = slots.slice(0, TIME_CHOICES);
  return ctx.openWebStep(c, {
    kind: "time",
    ref: [
      choice.service,
      choice.professional || "any",
      choice.date,
      choice.reschedule,
    ].join("|"),
    trigger: "module",
    actor: "system",
    sourceKey,
    ttlMinutes: 60,
    text: `${found.service?.name}: ${slots.length} ${slots.length === 1 ? "horário livre" : "horários livres"} em ${longDay(choice.date)}. Escolha no link:`,
    button: "Escolher horário",
    spec: {
      title: "Escolha o horário",
      intro: `${found.service?.name}, ${longDay(choice.date)}.${slots.length > shown.length ? ` Mostrando os ${shown.length} primeiros horários.` : ""}`,
      fields: [
        {
          id: "horario",
          type: "choice",
          label: "Horário",
          required: true,
          options: [...shown.map((s) => clockOf(s.starts)), OTHER_DAY],
        },
      ],
      submit_label: choice.reschedule ? "Remarcar" : "Agendar",
      done_text: "Pronto! Volte ao WhatsApp.",
      return_text: "Recebido!",
      ticket: "none",
    },
  });
}

/** "Meus agendamentos" pelo passo web (ref = ids dos agendamentos). */
export async function sendMineStep(
  ctx: ModuleContext,
  c: Conversation,
  options: { sourceKey: string; trigger: "menu" | "module" },
) {
  const upcoming = await upcomingFor(ctx, c, Date.now());
  if (!upcoming.length) {
    await ctx.sendMessage(
      c,
      { text: "Você não tem agendamentos marcados. Envie MENU para agendar." },
      { key: `mine:${options.sourceKey}` },
    );
    return null;
  }
  const label = (a: (typeof upcoming)[number]) =>
    `${shortDay(a.date)} ${a.time} - ${a.service_name} com ${a.professional_name}`;
  const shown = upcoming.slice(0, 19);
  const fields: WebField[] = [];
  if (shown.length > 1)
    fields.push({
      id: "agendamento",
      type: "choice",
      label: "Agendamento",
      required: true,
      options: shown.map(label),
    });
  fields.push({
    id: "acao",
    type: "choice",
    label: "O que fazer",
    required: true,
    options: [CONFIRM, "Remarcar", "Cancelar"],
  });
  return ctx.openWebStep(c, {
    kind: "mine",
    ref: shown.map((a) => a.id).join("|"),
    trigger: options.trigger,
    actor: "system",
    sourceKey: options.sourceKey,
    ttlMinutes: 60,
    text: `Você tem ${shown.length} ${shown.length === 1 ? "agendamento" : "agendamentos"}. Para confirmar, remarcar ou cancelar, use o link:`,
    button: "Meus agendamentos",
    spec: {
      title: "Meus agendamentos",
      intro: shown.length === 1 ? label(shown[0]) + "." : undefined,
      fields,
      submit_label: "Continuar",
      done_text: "Pronto! Volte ao WhatsApp.",
      return_text: "Recebido!",
      ticket: "none",
    },
  });
}

const say = (ctx: ModuleContext, c: Conversation, text: string, key: string) =>
  ctx.sendMessage(c, { text }, { key });

/** Conclusão das páginas da Agenda (onWebStepCompleted). */
export async function webStepDone(
  ctx: ModuleContext,
  step: WebStep,
  answers: Answers,
) {
  const c = await ctx.conversation(step.conversation_id);
  const config = await configOf(ctx);
  const key = `web:${step.id}`;
  if (step.kind === "book") {
    const [reschedule, fixedService, fixedPro] = String(
      step.ref_id || "",
    ).split("|");
    const { services, professionals } = await catalog(ctx);
    const service = fixedService
      ? services.find((s) => s.id === fixedService)
      : services.find((s) => serviceLabel(s) === answers.servico);
    const chosen = String(answers.profissional || "");
    const professional =
      fixedPro || !chosen || chosen === ANY
        ? fixedPro || null
        : professionals.find((p) => p.name === chosen)?.id || "missing";
    const date = String(answers.dia || "");
    if (!service || professional === "missing" || !validDate(date))
      return sendBookingStep(ctx, c, {
        sourceKey: `${key}:again`,
        trigger: "module",
        reschedule: reschedule || null,
        text: "Esse serviço ou profissional não está mais disponível. Escolha de novo no link:",
      });
    if (professional && !eligible(service, professionals, professional).length)
      return sendBookingStep(ctx, c, {
        sourceKey: `${key}:again`,
        trigger: "module",
        serviceId: fixedService || null,
        reschedule: reschedule || null,
        text: `${professionals.find((p) => p.id === professional)?.name} não atende ${service.name}. Escolha de novo no link:`,
      });
    if (!bookableDates(config, Date.now()).includes(date))
      return sendBookingStep(ctx, c, {
        sourceKey: `${key}:again`,
        trigger: "module",
        serviceId: service.id,
        reschedule: reschedule || null,
        text: `Dá para agendar de ${shortDay(brasiliaDate(Date.now()))} até ${config.max_days_ahead} dias à frente. Escolha outro dia no link:`,
      });
    return sendTimeStep(
      ctx,
      c,
      config,
      { service: service.id, professional, date, reschedule: reschedule || "" },
      `${key}:time`,
    );
  }
  if (step.kind === "time") {
    const [service, professional, date, reschedule] = String(
      step.ref_id || "",
    ).split("|");
    const choice = String(answers.horario || "");
    if (choice === OTHER_DAY || !/^\d{2}:\d{2}$/.test(choice))
      return sendBookingStep(ctx, c, {
        sourceKey: `${key}:again`,
        trigger: "module",
        serviceId: service,
        reschedule: reschedule || null,
        text: "Escolha outro dia no link:",
      });
    const [h, m] = choice.split(":").map(Number);
    const starts = dayStart(date) + (h * 60 + m) * 60000;
    try {
      if (reschedule) {
        const before = await getAppointment(ctx, reschedule);
        if (!canChange(before, config, Date.now()))
          return say(
            ctx,
            c,
            `Faltam menos de ${config.customer_change_hours} horas para o horário. Para mudar, fale com a equipe.`,
            key,
          );
        const after = await move(ctx, config, {
          id: reschedule,
          starts,
          professional_id: professional === "any" ? null : professional,
          actor: "customer",
          notify: false,
        });
        return say(
          ctx,
          c,
          `Remarcado! ${after.service_name} com ${after.professional_name}, ${longDay(after.date)} às ${after.time}.`,
          `moved:${after.id}:${after.moves}`,
        );
      }
      const { appointment } = await book(ctx, config, {
        id: `web-${step.id}`,
        service_id: service,
        professional_id: professional === "any" ? null : professional,
        starts,
        conversation: c,
        source: "whatsapp",
        actor: "customer",
        notify: false,
      });
      return say(
        ctx,
        c,
        fill(config.booked_text, describe(appointment)),
        `booked:${appointment.id}:0`,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["slot_taken", "slot_unavailable"].includes(error.code)
      ) {
        await say(
          ctx,
          c,
          "Esse horário acabou de ser ocupado.",
          `${key}:taken`,
        );
        return sendTimeStep(
          ctx,
          c,
          config,
          {
            service,
            professional: professional === "any" ? null : professional,
            date,
            reschedule,
          },
          `${key}:retry`,
        );
      }
      if (error instanceof ApiError)
        return say(ctx, c, error.message, `${key}:error`);
      throw error;
    }
  }
  if (step.kind === "mine") {
    const ids = String(step.ref_id || "")
      .split("|")
      .filter(Boolean);
    let id = ids[0];
    if (ids.length > 1) {
      const upcoming = await upcomingFor(ctx, c, Date.now());
      id =
        upcoming.find(
          (a) =>
            `${shortDay(a.date)} ${a.time} - ${a.service_name} com ${a.professional_name}` ===
            answers.agendamento,
        )?.id || "";
    }
    if (!id || !ids.includes(id))
      return say(
        ctx,
        c,
        "Esse agendamento mudou. Envie MENU e abra Meus agendamentos de novo.",
        key,
      );
    const a = await getAppointment(ctx, id);
    if (!["booked", "confirmed"].includes(a.status))
      return say(ctx, c, "Este agendamento já foi encerrado.", key);
    if (answers.acao === CONFIRM) {
      await confirm(ctx, { id, actor: "customer" });
      return say(
        ctx,
        c,
        `Confirmado! Até ${longDay(a.date)} às ${a.time}.`,
        `confirmed:${id}`,
      );
    }
    if (!canChange(a, config, Date.now()))
      return say(
        ctx,
        c,
        `Faltam menos de ${config.customer_change_hours} horas para o horário. Para mudar, fale com a equipe.`,
        key,
      );
    if (answers.acao === "Cancelar") {
      const done = await cancel(ctx, config, {
        id,
        actor: "customer",
        reason: "Cancelado pelo cliente no WhatsApp",
        notify: false,
      });
      return say(
        ctx,
        c,
        fill(config.cancelled_text, describe(done)),
        `cancelled:${id}`,
      );
    }
    return sendBookingStep(ctx, c, {
      sourceKey: `${key}:move`,
      trigger: "module",
      serviceId: a.service_id,
      reschedule: a.id,
    });
  }
}
