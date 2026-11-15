// Base dos testes da Reserva: área do service-center-fixture com o módulo
// ligado, uma pousada com dois quartos por diária e uma quadra por hora.
import { env } from "cloudflare:test";
import { perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { addDays, atClock, brasiliaDate } from "../src/modules/reserva/config";
import { configure, fixture, type Fixture } from "./service-center-fixture";

export async function reservaSetup(
  options: { enabled?: boolean; rules?: any } = {},
) {
  const f = await fixture();
  const run = (op: string, data: any = {}, actor: Actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  if (options.enabled !== false)
    await run("module.set", { id: "reserva", enabled: true });
  const ctx = modulesApi(env, f.profile, "reserva");
  if (options.enabled === false) return { f, run, ctx } as any;
  if (options.rules) await configure(f, { reserva: options.rules });
  const mar = await run("reserva.unit.save", {
    name: "Suíte Mar",
    kind: "room",
    mode: "daily",
    capacity: 2,
    price_cents: 30000,
    position: 1,
  });
  const jardim = await run("reserva.unit.save", {
    name: "Chalé Jardim",
    kind: "house",
    mode: "daily",
    capacity: 4,
    price_cents: 45000,
    position: 2,
  });
  const quadra = await run("reserva.unit.save", {
    name: "Quadra de areia",
    kind: "court",
    mode: "hourly",
    capacity: 12,
    price_cents: 8000,
    position: 3,
  });
  return { f, run, ctx, mar, jardim, quadra };
}
export type ReservaSetup = Awaited<ReturnType<typeof reservaSetup>>;

/** Um dia de Brasília daqui a `days` dias (sempre no futuro). */
export const future = (days = 5) => addDays(brasiliaDate(Date.now()), days);
export const at = atClock;
export type { Fixture };
