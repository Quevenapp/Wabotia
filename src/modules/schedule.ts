// Rodada periódica dos módulos (docs/MODULOS.md, onSchedule). Chamada pelo
// alarme do Coordinator de cada área; o cron de 5 minutos do Worker acorda
// todas as áreas, então cada módulo ligado roda ao menos a cada 5 minutos.
import type { Env } from "../types";
import { scheduledModules } from "./hooks";
import { moduleStates } from "./registry";

/** Intervalo mínimo entre rodadas da mesma área. */
export const SCHEDULE_INTERVAL_MS = 60_000;

export interface ScheduleOutcome {
  module: string;
  ok: boolean;
  error?: string;
}

/**
 * Roda as tarefas dos módulos ligados na área, uma por vez. A falha de um
 * módulo é registrada no log e não impede os demais.
 */
export async function runModuleSchedules(
  env: Env,
  profile: string,
  now: number,
): Promise<ScheduleOutcome[]> {
  const registered = scheduledModules();
  if (!registered.length) return [];
  const states = await moduleStates(env, profile);
  const outcomes: ScheduleOutcome[] = [];
  for (const [module, handler] of registered) {
    if (!states[module]) continue;
    try {
      await handler(env, profile, now);
      outcomes.push({ module, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          component: "module-schedule",
          profile,
          module,
          error: message.slice(0, 300),
        }),
      );
      outcomes.push({ module, ok: false, error: message });
    }
  }
  return outcomes;
}
