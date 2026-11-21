// Frete: o rastreio na rodada periódica dos módulos (alarme do Coordinator da
// área, src/modules/schedule.ts; carregado por src/modules/runtime.ts). Só roda
// com a Expedição ligada; consulta poucos envios por rodada (os pedidos
// expedidos com envio contratado e consulta vencida) e cada falha só adia a
// próxima consulta daquele envio.
import { registerSchedule } from "../../modules/hooks";
import type { Env } from "../../types";
import { defaultFreightDeps, runTrackingRound } from "./service.ts";

registerSchedule("erp-expedicao", async (env: Env, profile: string, at: number) => {
  try { await runTrackingRound(env, profile, typeof at === "number" ? at : Date.now(), defaultFreightDeps(env)); }
  catch { /* tenta de novo na próxima rodada */ }
});
