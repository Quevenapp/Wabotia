// Rodada periódica da Mensalidade (onSchedule em ./mensalidade.ts). Recebe o
// instante `at` da rodada; tudo é idempotente, então rodadas repetidas ou
// atrasadas não duplicam parcelas nem avisos.
import type { ModuleContext } from "../api";
import { generateInstallments, markOverdue } from "./installments";

export async function runDue(ctx: ModuleContext, at: number) {
  const created = await generateInstallments(ctx, at);
  const overdue = await markOverdue(ctx, at);
  return { created, overdue };
}
