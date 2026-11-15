// Rodada periódica da Reserva: `runDue(ctx, now)` roda no gancho onSchedule
// do núcleo (ao menos a cada 5 minutos) e pode ser chamada nos testes com
// qualquer `now`. Cada tarefa escolhe "o que venceu até now e ainda não foi
// feito" e marca o registro na mesma rodada; os envios usam chaves derivadas
// da reserva, então uma rodada repetida não repete mensagem.
import { exec } from "../../db";
import type { ModuleContext } from "../api";
import { reservaConfig } from "./config";
import { expireDue } from "./deposit";

export interface RunDueResult {
  expired: string[];
}

export async function runDue(
  ctx: ModuleContext,
  now: number,
): Promise<RunDueResult> {
  await exec(
    ctx.env,
    "DELETE FROM reserva_chats WHERE profile_id=? AND expires_at<=?",
    ctx.profile,
    now,
  );
  const config = reservaConfig((await ctx.settings())?.reserva);
  // Sinal vencido: libera a unidade antes de qualquer outra coisa.
  const expired = await expireDue(ctx, config, now);
  return { expired };
}
