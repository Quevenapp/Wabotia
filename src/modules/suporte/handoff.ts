// Passagem para o atendimento humano e a regra que a condiciona.
//
// LIGAÇÃO PROVISÓRIA (pendência da sessão A): o contrato dos módulos ainda não
// tem `ctx.handoff` nem o gancho que condiciona toda passagem automática para
// humano (inclusive a decidida pelo bot de IA). Enquanto isso:
// - `passToTeam` usa `ctx.handoff` quando existir e, sem ele, a função
//   `handoff` do núcleo (src/service.ts), a mesma do item de menu "humano".
//   Ao chegar `ctx.handoff`, apague o ramo do núcleo.
// - `handoffGate` é a regra pronta para o gancho: devolve se a conversa pode
//   ir para um humano e por quê. Sem o gancho, o cliente ainda consegue pedir
//   um humano ao bot de IA (contorno relatado).
import { all, one } from "../../db";
import { ApiError, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { handoff as coreHandoff } from "../../service";
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
      // Vale enquanto houver protocolo ativo aberto depois da liberação, ou
      // até a conversa voltar da equipe sem protocolo.
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
 * Regra do gancho de passagem para humano: libera com liberação ativa ou
 * pagador em dia pelo telefone da conversa. Fora isso, `allowed: false` com o
 * motivo, e quem chamou deve oferecer o item "Atendimento humano (pago)".
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
 * Passa a conversa ao setor configurado com o resumo para o atendente
 * (motivo interno do protocolo de ausência, quando houver).
 */
export async function passToTeam(
  ctx: ModuleContext,
  c: Conversation,
  summary: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  const viaContract = (ctx as any).handoff;
  if (typeof viaContract === "function")
    return viaContract.call(ctx, c, {
      department_id: cfg.department_id,
      summary,
    });
  try {
    return await coreHandoff(
      ctx.env,
      c,
      "Suporte pago liberado",
      cfg.department_id,
      summary,
    );
  } catch (error) {
    // Setor apagado ou desligado depois de salvar as regras: equipe geral.
    if (!cfg.department_id || !(error instanceof ApiError)) throw error;
    return coreHandoff(ctx.env, c, "Suporte pago liberado", null, summary);
  }
}
