// Reserva e check-in (módulo "reserva"): registra rotas, comandos e ganchos
// no núcleo (src/modules/api.ts). Regras em units.ts (cadastros). Uso:
// docs/RESERVA.md.
import { requireValue, type Actor } from "../../types";
import {
  onCommand,
  onRead,
  onRoute,
  onSettingsSave,
  type ModuleContext,
} from "../api";
import {
  addDays,
  dayStart,
  reservaConfig,
  validDate,
  validateReservaConfig,
  brasiliaDate,
} from "./config";
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
