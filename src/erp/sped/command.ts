// Obrigações em arquivo, o que roda pelos ganchos dos módulos (carregado por
// src/modules/runtime.ts): no agendador do módulo ERP, os pedidos de envio ao
// contador que esperam o pacote do período ficar pronto com o arquivo dentro.
// Falha de uma área não para as outras nem o agendador.
import type { Env } from "../../types";
import { registerScheduleExtension } from "../../modules/hooks";
import { runPendingSends } from "./service.ts";

registerScheduleExtension("erp", async (env: Env, profile: string, at: number) => {
  try { await runPendingSends(env, profile, typeof at === "number" ? at : Date.now()); } catch { /* tenta de novo na próxima passada */ }
});
