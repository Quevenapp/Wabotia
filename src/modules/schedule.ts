// Rodada periódica dos módulos (docs/MODULOS.md, onSchedule). Chamada pelo
// alarme do Coordinator de cada área; o cron de 5 minutos do Worker acorda
// todas as áreas, então cada módulo ligado roda ao menos a cada 5 minutos.
import type { Env } from "../types";
import { withReadCache } from "../db";
import { scheduledModules } from "./hooks";
import { moduleStates } from "./registry";
import { expireApprovals } from "../approvals";
import { expireProposals } from "../bot-actions/actions";

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
  // Prazos do núcleo na mesma rodada: pedidos de aprovação e propostas do
  // bot vencidos (src/approvals.ts, src/bot-actions).
  try {
    await expireApprovals(env, profile);
    await expireProposals(env, profile);
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "module-schedule",
        profile,
        error: String((error as Error)?.message || error).slice(0, 300),
      }),
    );
  }
  const registered = scheduledModules();
  if (!registered.length) return [];
  env = withReadCache(env);
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
