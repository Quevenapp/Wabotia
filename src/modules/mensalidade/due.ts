// Rodada periódica da Mensalidade (onSchedule em ./mensalidade.ts). Recebe o
// instante `at` da rodada; tudo é idempotente, então rodadas repetidas ou
// atrasadas não duplicam parcelas nem avisos.
import type { ModuleContext } from "../api";
import { generateInstallments, markOverdue } from "./installments";
import { runNotices } from "./billing";

export async function runDue(
  ctx: ModuleContext,
  at: number,
  options: { notices?: boolean } = {},
) {
  const created = await generateInstallments(ctx, at);
  const overdue = await markOverdue(ctx, at);
  if (options.notices === false) return { created, overdue };
  return { created, overdue, notices: await runNotices(ctx, at) };
}
