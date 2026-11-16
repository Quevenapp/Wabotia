// Agenda (módulo "agenda"): registra rotas, comandos e ganchos no núcleo
// (src/modules/api.ts). Regras em catalog.ts (cadastros). Uso: docs/AGENDA.md.
import { one } from "../../db";
import { formatBrasilia } from "../../business-time";
import { money } from "../../payments";
import {
  ApiError,
  type Actor,
  type Conversation,
  now,
  requireValue,
} from "../../types";
import {
  filteredHandlers,
  onConversationTurn,
  onMcpTool,
  onMenuChoice,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";
import { agendaTurn, startBooking, startMine } from "./chat";
import { runDue } from "./reminders";
import { sendBookingStep, sendMineStep, webStepDone } from "./webflow";
import { agendaConfig, clockOf, DAY_MS, validateAgendaConfig } from "./config";
import { availability } from "./availability";
import {
  book,
  cancel,
  confirm,
  datesOf,
  getAppointment,
  listAppointments,
  move,
  noShow,
  upcomingFor,
  visibleAppointments,
} from "./appointments";
import {
  archiveProfessional,
  archiveService,
  deleteBlock,
  listBlocks,
  listProfessionals,
  listServices,
  saveBlock,
  saveProfessional,
  saveService,
} from "./catalog";

const MODULE = "agenda";
// Toda resposta das rotas e comandos passa por visibleAppointments (M6).
const { onRead, onCommand, onConversationAction } =
  filteredHandlers(visibleAppointments);

export async function config(ctx: ModuleContext) {
  return agendaConfig((await ctx.settings())?.agenda);
}

/** Intervalo de leitura em ms (from/to), padrão: hoje até 7 dias. */
export function range(query: Record<string, string>, at: number) {
  const from = query.from ? Number(query.from) : at - DAY_MS;
  const to = query.to ? Number(query.to) : from + 8 * DAY_MS;
  requireValue(
    Number.isFinite(from) && Number.isFinite(to) && to > from,
    "Informe from e to em milissegundos, com to depois de from.",
  );
  requireValue(to - from <= 62 * DAY_MS, "Consulte até 62 dias por vez.");
  return { from, to };
}

const read = (ctx: ModuleContext, actor: Actor) =>
  ctx.access(actor, "conversations:read");

// ---------------------------------------------------------------------------
// WhatsApp

// Próxima mensagem do cliente: respostas da conversa da Agenda (chat.ts).
onConversationTurn(MODULE, (ctx, c, turn) => agendaTurn(ctx, c, turn));

/**
 * O agendamento acontece no chat (padrão) ou, com `web_page` nas regras, numa
 * página aberta pelo link (webflow.ts).
 */
const usesWebPage = async (ctx: ModuleContext) => (await config(ctx)).web_page;

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
      text: "O agendamento não está disponível agora. Envie MENU para ver as opções.",
    },
    { key: `menu-unavailable:${key}` },
  );
}

// Item de menu "Agendar horário" (service_id opcional fixa o serviço).
onMenuChoice("agenda", async (ctx, c, item, { rowId }) => {
  const serviceId =
    typeof item.service_id === "string" ? item.service_id : null;
  try {
    if (await usesWebPage(ctx))
      await sendBookingStep(ctx, c, {
        sourceKey: `menu:${rowId}`,
        trigger: "menu",
        serviceId,
      });
    else await startBooking(ctx, c, { key: `menu:${rowId}`, serviceId });
  } catch (error) {
    await unavailable(ctx, c, error, rowId);
  }
});

// Item de menu "Meus agendamentos".
onMenuChoice("agenda_mine", async (ctx, c, _item, { rowId }) => {
  try {
    if (await usesWebPage(ctx))
      await sendMineStep(ctx, c, {
        sourceKey: `menu:${rowId}`,
        trigger: "menu",
      });
    else await startMine(ctx, c, { key: `menu:${rowId}` });
  } catch (error) {
    await unavailable(ctx, c, error, rowId);
  }
});

/** Quem age na conversa: o responsável, um administrador ou o bot que atende. */
function mayActOn(actor: Actor, c: Conversation) {
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de agendar para o cliente.",
  );
  return bot;
}

// Ação do atendente: "Agendar para este cliente"
// (POST /conversations/:id/actions {action:"agenda", service_id, starts, …}).
onConversationAction(MODULE, "agenda", async (ctx, actor, c, data) => {
  const bot = mayActOn(actor, c);
  requireValue(
    c.chat_type !== "group",
    "Agende pela conversa direta do cliente.",
  );
  // Bot ou integração (agenda_agendar) age pelo cliente: valem a
  // antecedência e o prazo das regras, e não há encaixe (conferência N-7).
  const staff = !bot && actor.kind === "user";
  return (
    await book(ctx, await config(ctx), {
      service_id: data.service_id,
      professional_id: data.professional_id ?? null,
      starts: data.starts,
      conversation: c,
      notes: data.notes,
      source: sourceOf(actor),
      actor: actor.id,
      rules: { staff },
      force: staff ? staffFlag(data.force) : false,
      notify: data.notify === false ? false : undefined,
    })
  ).appointment;
});

// "Enviar link para agendar": o cliente escolhe sozinho na página do link
// (funciona também com um atendente na conversa, que segura o chat).
onConversationAction(
  MODULE,
  "agenda_link",
  async (ctx, actor, c, data, request) => {
    const bot = mayActOn(actor, c);
    requireValue(
      c.chat_type !== "group",
      "Envie pela conversa direta do cliente.",
    );
    const serviceId =
      typeof data.service_id === "string" ? data.service_id : null;
    const opened = await sendBookingStep(ctx, c, {
      sourceKey: `action:${actor.id}:${request.requestId}`,
      trigger: bot ? "module" : "agent",
      actor: actor.id,
      serviceId,
    });
    return { sent: !!opened, web_step: opened?.step || null };
  },
);

// Bot e atendente sobre os agendamentos do cliente da conversa: só os dele
// (mesma conversa ou mesmo telefone); id de outro cliente dá 404.
async function customerAppointment(
  ctx: ModuleContext,
  c: Conversation,
  id: unknown,
) {
  requireValue(typeof id === "string" && id, "Informe appointment_id.");
  const mine = await upcomingFor(ctx, c, now());
  if (!mine.some((a) => a.id === id))
    throw new ApiError(
      404,
      "not_found",
      "Agendamento não encontrado entre os do cliente desta conversa.",
    );
  return id as string;
}

// "Remarcar" e "Cancelar" pela conversa (ferramentas do bot).
onConversationAction(MODULE, "agenda_move", async (ctx, actor, c, data) => {
  const bot = mayActOn(actor, c);
  const id = await customerAppointment(ctx, c, data.appointment_id);
  return move(ctx, await config(ctx), {
    id,
    starts: data.starts,
    professional_id: data.professional_id,
    actor: actor.id,
    // Bot age pelo cliente: valem a antecedência e o prazo das regras.
    rules: { staff: !bot && actor.kind === "user" },
  });
});
onConversationAction(MODULE, "agenda_cancel", async (ctx, actor, c, data) => {
  mayActOn(actor, c);
  const id = await customerAppointment(ctx, c, data.appointment_id);
  return cancel(ctx, await config(ctx), {
    id,
    actor: actor.id,
    reason: typeof data.reason === "string" ? data.reason : "",
  });
});

// Agendamentos do cliente de uma conversa (bot: agenda_meus_agendamentos).
onRead(MODULE, "agenda/conversations/:id", async (ctx, actor, { params }) => {
  read(ctx, actor);
  const c = await ctx.conversation(params.id, actor);
  return ctx.botView(actor, { data: await upcomingFor(ctx, c, now()) });
});

onWebStepCompleted(MODULE, async (ctx, step, answers) => {
  await webStepDone(ctx, step, answers);
});

// Lembretes vencidos (gancho periódico do núcleo, ao menos a cada 5 minutos).
onSchedule(MODULE, async (ctx, { now }) => {
  await runDue(ctx, now);
});

// ---------------------------------------------------------------------------
// Configuração e cadastros

onSettingsSave(MODULE, "agenda", validateAgendaConfig);

// GET /profiles/:profile/agenda: configuração e cadastros de uma vez.
onRead(MODULE, "agenda", async (ctx, actor) => {
  read(ctx, actor);
  const [services, professionals] = await Promise.all([
    listServices(ctx),
    listProfessionals(ctx),
  ]);
  return { config: await config(ctx), services, professionals };
});
onRead(MODULE, "agenda/services", async (ctx, actor) => {
  read(ctx, actor);
  return { data: await listServices(ctx) };
});
onRead(MODULE, "agenda/professionals", async (ctx, actor) => {
  read(ctx, actor);
  return { data: await listProfessionals(ctx) };
});
onRead(MODULE, "agenda/blocks", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const { from, to } = range(query, Date.now());
  return { data: await listBlocks(ctx, from, to) };
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/services",
  op: "agenda.service.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "agenda/services/:id",
  op: "agenda.service.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "agenda/services/:id",
  op: "agenda.service.delete",
});
onCommand(MODULE, "agenda.service.save", (ctx, actor, data) =>
  saveService(ctx, actor, data),
);
onCommand(MODULE, "agenda.service.delete", (ctx, actor, data) =>
  archiveService(ctx, actor, data.id),
);

onRoute(MODULE, {
  method: "POST",
  path: "agenda/professionals",
  op: "agenda.professional.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "agenda/professionals/:id",
  op: "agenda.professional.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "agenda/professionals/:id",
  op: "agenda.professional.delete",
});
onCommand(MODULE, "agenda.professional.save", (ctx, actor, data) =>
  saveProfessional(ctx, actor, data),
);
onCommand(MODULE, "agenda.professional.delete", (ctx, actor, data) =>
  archiveProfessional(ctx, actor, data.id),
);

onRoute(MODULE, {
  method: "POST",
  path: "agenda/blocks",
  op: "agenda.block.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "agenda/blocks/:id",
  op: "agenda.block.delete",
});
onCommand(MODULE, "agenda.block.save", (ctx, actor, data) =>
  saveBlock(ctx, actor, data),
);
onCommand(MODULE, "agenda.block.delete", (ctx, actor, data) =>
  deleteBlock(ctx, actor, data.id),
);

// ---------------------------------------------------------------------------
// Disponibilidade e agendamentos

// GET /agenda/availability?service_id=&professional_id=&date= (ou
// from_date/to_date): horários livres por dia. staff=1 ignora a antecedência, não o passado.
onRead(MODULE, "agenda/availability", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const found = await availability(ctx, await config(ctx), {
    serviceId: query.service_id,
    professionalId: query.professional_id || null,
    dates: datesOf(query),
    now: Date.now(),
    rules: { staff: query.staff === "1" || query.staff === "true" },
  });
  requireValue(found.service, "Serviço não encontrado.");
  return {
    service_id: found.service.id,
    professional_id: query.professional_id || null,
    days: found.days.map((day) => ({
      date: day.date,
      slots: day.slots.map((slot) => ({
        starts: slot.starts,
        ends: slot.ends,
        time: clockOf(slot.starts),
        professional_ids: slot.professional_ids,
      })),
    })),
  };
});

onRead(MODULE, "agenda/appointments", async (ctx, actor, { query }) => {
  read(ctx, actor);
  const { from, to } = range(query, Date.now());
  return {
    data: await listAppointments(ctx, {
      from,
      to,
      professional_id: query.professional_id,
      status: query.status,
      conversation_id: query.conversation_id,
    }),
  };
});
onRead(MODULE, "agenda/appointments/:id", async (ctx, actor, { params }) => {
  read(ctx, actor);
  return getAppointment(ctx, params.id);
});

/** Conversa opcional do agendamento feito pela equipe ou por integração. */
async function linkedConversation(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  if (id === undefined || id === null || id === "") return null;
  requireValue(typeof id === "string", "conversation_id inválido.");
  return ctx.conversation(id, actor);
}
const sourceOf = (actor: Actor): "panel" | "api" =>
  actor.kind === "user" ? "panel" : "api";
const staffFlag = (value: unknown) => {
  requireValue(
    value === undefined || typeof value === "boolean",
    "force: verdadeiro ou falso.",
  );
  return value === true;
};

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments",
  op: "agenda.book",
});
onCommand(MODULE, "agenda.book", async (ctx, actor, data) => {
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
    await book(ctx, await config(ctx), {
      service_id: data.service_id,
      professional_id: data.professional_id ?? null,
      starts: data.starts,
      conversation,
      customer_name: data.customer_name,
      customer_phone: data.customer_phone,
      notes: data.notes,
      source: sourceOf(actor),
      actor: actor.id,
      rules: { staff: true },
      force: staffFlag(data.force),
      // Quem não atende a conversa agenda sem avisar o cliente (B9).
      notify:
        data.notify === false ||
        (conversation && !ctx.mayMessage(actor, conversation))
          ? false
          : undefined,
    })
  ).appointment;
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/move",
  op: "agenda.move",
});
// Aplicação que não atende a conversa remarca e cancela sem avisar o cliente
// (segunda conferência, B9).
const quietFor = async (ctx: ModuleContext, actor: Actor, id: unknown) => {
  const row = await one(
    ctx.env,
    "SELECT conversation_id FROM agenda_appointments WHERE id=? AND profile_id=?",
    String(id ?? ""),
    ctx.profile,
  );
  return !(await ctx.mayNotify(actor, row?.conversation_id ?? null));
};

onCommand(MODULE, "agenda.move", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const quiet = data.notify === false || (await quietFor(ctx, actor, data.id));
  return move(ctx, await config(ctx), {
    id: data.id,
    starts: data.starts,
    professional_id: data.professional_id,
    actor: actor.id,
    rules: { staff: true },
    force: staffFlag(data.force),
    notify: quiet ? false : undefined,
  });
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/cancel",
  op: "agenda.cancel",
});
onCommand(MODULE, "agenda.cancel", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const quiet = data.notify === false || (await quietFor(ctx, actor, data.id));
  return cancel(ctx, await config(ctx), {
    id: data.id,
    actor: actor.id,
    reason: data.reason,
    notify: quiet ? false : undefined,
  });
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/confirm",
  op: "agenda.confirm",
});
onCommand(MODULE, "agenda.confirm", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return confirm(ctx, { id: data.id, actor: actor.id });
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/no-show",
  op: "agenda.no_show",
});
onCommand(MODULE, "agenda.no_show", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return noShow(ctx, { id: data.id, actor: actor.id });
});

// ---------------------------------------------------------------------------
// Ferramentas MCP para bots (núcleo: onMcpTool). Viram chamadas à API v1 com
// a chave do bot; permissões e 409 module_disabled valem como na API.

onMcpTool("agenda", {
  name: "agenda_servicos",
  description:
    "Serviços e profissionais da Agenda da área (ids, duração, preço). Use antes de agenda_horarios_livres. Requer conversations:read.",
  input: {},
  call: (_a, profile) => ({ path: `/profiles/${profile}/agenda` }),
});
onMcpTool("agenda", {
  name: "agenda_horarios_livres",
  description:
    "Horários livres de um serviço: por dia (date AAAA-MM-DD, opcional) e profissional (opcional). Horários em Brasília; use o campo starts para agendar. Requer conversations:read.",
  input: {
    service_id: { type: "string" },
    professional_id: { type: "string" },
    date: { type: "string", description: "AAAA-MM-DD" },
  },
  required: ["service_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/agenda/availability`,
    query: {
      service_id: a.service_id,
      professional_id: a.professional_id,
      date: a.date,
    },
  }),
});
onMcpTool("agenda", {
  name: "agenda_agendar",
  description:
    "Agenda o cliente da conversa num horário livre (starts de agenda_horarios_livres). O cliente recebe a confirmação no WhatsApp. Exige a conversa assumida pelo bot. Requer conversations:write; 409 slot_taken se o horário acabou de ser ocupado.",
  input: {
    conversation_id: { type: "string" },
    service_id: { type: "string" },
    starts: { type: "integer", description: "Início em ms (Unix)." },
    professional_id: { type: "string" },
  },
  required: ["conversation_id", "service_id", "starts"],
  write: true,
  // O que o cliente confirma (src/bot-actions/describe.ts): serviço, data,
  // profissional e valor lidos daqui, nunca o texto do modelo.
  describe: async (env, profile, a) => {
    const service = await one(
      env,
      "SELECT name,price_cents FROM agenda_services WHERE id=? AND profile_id=?",
      a.service_id,
      profile,
    );
    if (!service || typeof a.starts !== "number") return null;
    const pro = a.professional_id
      ? await one(
          env,
          "SELECT name FROM agenda_professionals WHERE id=? AND profile_id=?",
          a.professional_id,
          profile,
        )
      : null;
    return [
      `Agendar: ${service.name}`,
      `Quando: ${formatBrasilia(a.starts)}`,
      ...(pro ? [`Com: ${pro.name}`] : []),
      ...(service.price_cents != null
        ? [`Valor: ${money(service.price_cents)}`]
        : []),
    ].join("\n");
  },
  call: (a, profile) => ({
    method: "POST",
    path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`,
    body: {
      action: "agenda",
      service_id: a.service_id,
      starts: a.starts,
      ...(a.professional_id ? { professional_id: a.professional_id } : {}),
    },
  }),
});
// As ferramentas abaixo só recebem conversation_id: o cliente é sempre o da
// conversa, nunca um telefone ou nome citado no texto.
onMcpTool("agenda", {
  name: "agenda_meus_agendamentos",
  description:
    "Próximos agendamentos do cliente da conversa (desta conversa ou do mesmo telefone), com id, serviço, profissional, data e hora. Requer conversations:read.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/agenda/conversations/${a.conversation_id}`,
  }),
});
onMcpTool("agenda", {
  name: "agenda_remarcar",
  description:
    "Remarca um agendamento do cliente da conversa (appointment_id de agenda_meus_agendamentos) para um horário livre (starts de agenda_horarios_livres). Agendamento de outro cliente: 404. Exige a conversa assumida pelo bot. Requer conversations:write.",
  input: {
    conversation_id: { type: "string" },
    appointment_id: { type: "string" },
    starts: { type: "integer", description: "Novo início em ms (Unix)." },
    professional_id: { type: "string" },
  },
  required: ["conversation_id", "appointment_id", "starts"],
  write: true,
  // Só agendamento desta conversa: outro cliente não aparece no texto.
  describe: async (env, profile, a) => {
    const row = await one(
      env,
      "SELECT service_name,starts FROM agenda_appointments WHERE id=? AND profile_id=? AND conversation_id=?",
      a.appointment_id,
      profile,
      a.conversation_id,
    );
    if (!row || typeof a.starts !== "number") return null;
    return [
      `Remarcar: ${row.service_name}`,
      `De: ${formatBrasilia(row.starts)}`,
      `Para: ${formatBrasilia(a.starts)}`,
    ].join("\n");
  },
  call: (a, profile) => ({
    method: "POST",
    path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`,
    body: {
      action: "agenda_move",
      appointment_id: a.appointment_id,
      starts: a.starts,
      ...(a.professional_id ? { professional_id: a.professional_id } : {}),
    },
  }),
});
onMcpTool("agenda", {
  name: "agenda_cancelar",
  description:
    "Cancela um agendamento do cliente da conversa (appointment_id de agenda_meus_agendamentos); o cliente recebe o aviso. Agendamento de outro cliente: 404. Exige a conversa assumida pelo bot. Requer conversations:write.",
  input: {
    conversation_id: { type: "string" },
    appointment_id: { type: "string" },
    reason: { type: "string" },
  },
  required: ["conversation_id", "appointment_id"],
  write: true,
  describe: async (env, profile, a) => {
    const row = await one(
      env,
      "SELECT service_name,starts FROM agenda_appointments WHERE id=? AND profile_id=? AND conversation_id=?",
      a.appointment_id,
      profile,
      a.conversation_id,
    );
    return row
      ? `Cancelar: ${row.service_name}\nQuando: ${formatBrasilia(row.starts)}`
      : null;
  },
  call: (a, profile) => ({
    method: "POST",
    path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`,
    body: {
      action: "agenda_cancel",
      appointment_id: a.appointment_id,
      ...(a.reason ? { reason: a.reason } : {}),
    },
  }),
});
