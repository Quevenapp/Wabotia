import { drainIntegrationOutbox } from "../integrations/consumer";
import { logIntegrationError } from "../integrations/privacy";
// Rodada periódica dos módulos (docs/MODULOS.md, onSchedule). Chamada pelo
// alarme do Coordinator de cada área; o cron de 5 minutos do Worker acorda
// todas as áreas, então cada módulo ligado roda ao menos a cada 5 minutos.
import type { Env } from "../types";
import { withReadCache } from "../db";
import { scheduledModules } from "./hooks";
import { moduleStates } from "./registry";
import { expireApprovals } from "../approvals";

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
  background?: (work: Promise<void>) => void,
): Promise<ScheduleOutcome[]> {
  env = withReadCache(env);
  const states = await moduleStates(env, profile);
  // Só quem possui waitUntil agenda o consumidor; a rodada não o aguarda.
  // Reutiliza a leitura acima e mantém custo zero de fila com Base desligada.
  if (states.erp && background) background(drainIntegrationOutbox(env, profile).catch(logIntegrationError));
  // Pedidos de aprovação vencidos (src/approvals.ts): o módulo decide ou o
  // cliente é avisado e vai para a equipe. Uma consulta por rodada. As
  // propostas do bot vencem na leitura e na confirmação, sem rodada.
  try {
    await expireApprovals(env, profile);
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
