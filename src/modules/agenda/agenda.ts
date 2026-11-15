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
