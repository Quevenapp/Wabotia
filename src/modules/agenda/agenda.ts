// Agenda (módulo "agenda"): registra rotas, comandos e ganchos no núcleo
// (src/modules/api.ts). Regras em catalog.ts (cadastros). Uso: docs/AGENDA.md.
import { type Actor, requireValue } from "../../types";
import {
  onCommand,
  onRead,
  onRoute,
  onSettingsSave,
  type ModuleContext,
} from "../api";
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
// from_date/to_date): horários livres por dia. staff=1 ignora a antecedência.
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
      notify: data.notify === false ? false : undefined,
    })
  ).appointment;
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/move",
  op: "agenda.move",
});
onCommand(MODULE, "agenda.move", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return move(ctx, await config(ctx), {
    id: data.id,
    starts: data.starts,
    professional_id: data.professional_id,
    actor: actor.id,
    rules: { staff: true },
    force: staffFlag(data.force),
    notify: data.notify === false ? false : undefined,
  });
});

onRoute(MODULE, {
  method: "POST",
  path: "agenda/appointments/:id/cancel",
  op: "agenda.cancel",
});
onCommand(MODULE, "agenda.cancel", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  return cancel(ctx, await config(ctx), {
    id: data.id,
    actor: actor.id,
    reason: data.reason,
    notify: data.notify === false ? false : undefined,
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
