// Passagem para o atendimento humano e a regra que a condiciona.
// - `handoffGate`: liberação ativa ou pagador em dia. Ligada ao gancho
//   onHandoffRequest em ./suporte.ts: toda passagem automática (menu
//   "humano", palavra-chave, bot de IA, falha do bot, anexo) sem liberação é
//   segurada e o cliente entra no fluxo do Suporte.
// - `passToTeam`: ctx.handoff ao setor das regras, com resumo e marcadores
//   para o atendente; não passa pelo gancho.
import { all, one } from "../../db";
import { ApiError, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { mensalidadeAvailable, situationByPhone } from "../mensalidade/public";
import { suporteSettings } from "./model";

/** Liberação ativa da conversa: dentro da validade ou com o protocolo aberto. */
export async function activeRelease(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
) {
  const rows = await all(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE conversation_id=? AND profile_id=? AND status='active' ORDER BY created DESC LIMIT 10",
    c.id,
    ctx.profile,
  );
  for (const row of rows) {
    if (row.valid_until !== null && row.valid_until > at) return row;
    if (row.until_ticket) {
      // Vale enquanto houver protocolo ativo, ou enquanto a conversa estiver
      // com a equipe.
      const ticket = await one(
        ctx.env,
        "SELECT id FROM tickets WHERE conversation_id=? AND status NOT IN ('resolved','closed') LIMIT 1",
        c.id,
      );
      if (ticket || ["waiting", "human"].includes(c.state)) return row;
    }
  }
  return null;
}

/**
 * Regra da passagem para humano: libera com liberação ativa ou pagador em
 * dia pelo telefone da conversa. Fora isso, `allowed: false` com o motivo.
 */
export async function handoffGate(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
): Promise<{ allowed: boolean; reason: string; release_id?: string }> {
  if (!(await ctx.enabled()))
    return { allowed: true, reason: "module_disabled" };
  const release = await activeRelease(ctx, c, at);
  if (release)
    return { allowed: true, reason: "released", release_id: release.id };
  if (await mensalidadeAvailable(ctx.env, ctx.profile)) {
    const situation = await situationByPhone(
      ctx.env,
      ctx.profile,
      c.phone || c.external_id,
      at,
    );
    if (situation?.status === "em_dia")
      return { allowed: true, reason: "subscription" };
  }
  return { allowed: false, reason: "payment_required" };
}

/**
 * Passa a conversa ao setor das regras (ou à equipe geral) com o resumo e os
 * marcadores para o atendente. Com `key`, repetir não passa de novo.
 */
export async function passToTeam(
  ctx: ModuleContext,
  c: Conversation,
  summary: string,
  options: { flags?: string[]; key?: string } = {},
) {
  const cfg = suporteSettings(await ctx.settings());
  const request = {
    summary: Array.from(summary).slice(0, 3000).join(""),
    flags: options.flags,
    reason: "Suporte pago",
    key: options.key,
  };
  if (!cfg.department_id) return ctx.handoff(c, request);
  try {
    return await ctx.handoff(c, {
      ...request,
      target: { department_id: cfg.department_id },
    });
  } catch (error) {
    // Setor apagado ou desligado depois de salvar as regras: equipe geral.
    if (!(error instanceof ApiError)) throw error;
    return ctx.handoff(c, request);
  }
}
