// Base dos testes da Agenda: área do service-center-fixture com o módulo
// ligado, dois serviços e duas profissionais que trabalham todos os dias.
import { env } from "cloudflare:test";
import { perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { brasiliaDate, addDays, dayStart } from "../src/modules/agenda/config";
import { fixture, type Fixture } from "./service-center-fixture";

export const week = (start = "08:00", end = "18:00") =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end }));

export async function agendaSetup(
  options: { enabled?: boolean; hours?: any[] } = {},
) {
  const f = await fixture();
  const run = (op: string, data: any = {}, actor: Actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  if (options.enabled !== false)
    await run("module.set", { id: "agenda", enabled: true });
  const ctx = modulesApi(env, f.profile, "agenda");
  if (options.enabled === false) return { f, run, ctx } as any;
  const corte = await run("agenda.service.save", {
    name: "Corte",
    duration_minutes: 30,
    price_cents: 5000,
  });
  const barba = await run("agenda.service.save", {
    name: "Barba",
    duration_minutes: 60,
  });
  const hours = options.hours || week();
  const ana = await run("agenda.professional.save", {
    name: "Ana",
    service_ids: [corte.id, barba.id],
    hours,
    position: 1,
  });
  const bia = await run("agenda.professional.save", {
    name: "Bia",
    service_ids: [corte.id],
    hours,
    position: 2,
  });
  return { f, run, ctx, corte, barba, ana, bia };
}
export type AgendaSetup = Awaited<ReturnType<typeof agendaSetup>>;

/** Um dia de Brasília daqui a `days` dias (sempre no futuro). */
export const future = (days = 3) => addDays(brasiliaDate(Date.now()), days);
/** Instante de Brasília: dia AAAA-MM-DD e "HH:MM". */
export const at = (date: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return dayStart(date) + (h * 60 + m) * 60000;
};
export type { Fixture };
