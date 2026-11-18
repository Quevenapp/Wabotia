import {
  modulesApi,
  onBinaryRead,
  onBinaryUpload,
  onCommand,
  onMcpTool,
  onRead,
  onRoute,
  type ModuleContext,
} from "../api";
import { registerScheduleExtension, registerTurnExtension } from "../hooks";
import {
  osExtensions,
  OS_EXTENSION_ITEM_LIMIT,
  OS_EXTENSION_SQL_BUDGET,
  type DueBudget,
  type DueResult,
  type OsExtension,
} from "./extensions";

class DueLimitError extends Error {}

/** Um orçamento compartilhado; a próxima rodada retoma trabalho que sobrou. */
export async function runExtensionsDue(
  ctx: ModuleContext,
  at: number,
  extensions: readonly OsExtension[] = osExtensions,
): Promise<DueResult> {
  // Sem tipos personalizados não há filhos habilitados. Reutiliza a leitura
  // de configuração do agendador legado, preservando seu custo e comportamento.
  if (extensions === osExtensions && !(await ctx.settings()).os_work_types?.length)
    return { processed: 0, has_more: false };
  let remaining = OS_EXTENSION_SQL_BUDGET,
    processed = 0,
    has_more = false;
  let failure: Error | undefined;
  const budget: DueBudget = {
    get remaining() {
      return remaining;
    },
    consume(instructions) {
      if (
        !Number.isSafeInteger(instructions) ||
        instructions < 0 ||
        instructions > remaining
      )
        throw new DueLimitError("Orçamento D1 das extensões de OS excedido.");
      remaining -= instructions;
    },
  };
  for (const extension of extensions) {
    if (!extension.runDue) continue;
    if (!remaining || processed >= OS_EXTENSION_ITEM_LIMIT) {
      has_more = true;
      continue;
    }
    const limit = OS_EXTENSION_ITEM_LIMIT - processed;
    try {
      const result = await extension.runDue(ctx, { now: at, budget, limit });
      if (
        !Number.isSafeInteger(result.processed) ||
        result.processed < 0 ||
        result.processed > limit
      )
        throw new DueLimitError(
          `Limite de itens da extensão ${extension.id} excedido.`,
        );
      processed += result.processed;
      has_more ||= result.has_more;
    } catch (error) {
      // O SQL já consumido continua debitado. A falha não pode impedir os
      // próximos filhos nem perder a tentativa seguinte; não expor seu texto.
      has_more = true;
      failure ||=
        error instanceof DueLimitError
          ? error
          : new Error(`Falha no agendamento da extensão ${extension.id}.`);
    }
  }
  if (has_more) await ctx.wake({ modules: true });
  if (failure) throw failure;
  return { processed, has_more };
}

for (const extension of osExtensions) {
  for (const command of extension.commands)
    onCommand("os", command.op, command.handler);
  for (const route of extension.writes) onRoute("os", route);
  for (const route of extension.reads) onRead("os", route.path, route.handler);
  for (const route of extension.binaryReads || [])
    onBinaryRead("os", route.path, route.handler);
  for (const route of extension.binaryUploads || [])
    onBinaryUpload("os", route.path, route.handler);
  for (const tool of extension.tools || []) onMcpTool("os", tool);
}
// Complementa o gancho legado; nunca substitui o runDue de reminders.ts.
registerScheduleExtension("os", async (env, profile, at) => {
  await runExtensionsDue(modulesApi(env, profile, "os"), at);
});
registerTurnExtension("os", async (env, c, turn) => {
  if (!osExtensions.some((extension) => extension.onConversationTurn))
    return false;
  const ctx = modulesApi(env, c.profile_id, "os");
  if (!(await ctx.enabled())) return false;
  if (!(await ctx.settings()).os_work_types?.length) return false;
  for (const extension of osExtensions)
    if (await extension.onConversationTurn?.(ctx, c, turn)) return true;
  return false;
});
