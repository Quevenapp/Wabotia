// Passagem para o atendimento humano e a regra que a condiciona.
// - `handoffGate`: liberação ativa ou pagador em dia. Ligada ao gancho
//   onHandoffRequest em ./suporte.ts: toda passagem automática (menu
//   "humano", palavra-chave, bot de IA, falha do bot, anexo) sem liberação é
//   segurada e o cliente entra no fluxo do Suporte.
// - `passToTeam`: ctx.handoff ao setor das regras, com resumo e marcadores
//   para o atendente; não passa pelo gancho.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, now } from "../../types";
import type { ModuleContext } from "../api";
import {
  mensalidadeAvailable,
  situationByPayer,
  situationByPhone,
} from "../mensalidade/public";
import { phoneDigits, releaseDeadline, suporteSettings } from "./model";

/**
 * Por que uma liberação gravada como ativa não vale mais, ou null se vale:
 * - prazo absoluto vencido (7 dias "até o protocolo", 30 dias as demais);
 * - validade em horas vencida;
 * - "até o protocolo fechar": o protocolo amarrado na liberação fechou, a
 *   conversa foi resolvida (sessão nova) ou a liberação não tem protocolo;
 * - assinatura ou confirmação da equipe: o pagador deixou de estar em dia.
 */
export async function releaseEndReason(
  ctx: ModuleContext,
  c: Conversation,
  row: any,
  at: number,
): Promise<string | null> {
  if (releaseDeadline(row) <= at) return "Prazo máximo da liberação.";
  if (row.valid_until !== null) {
    if (row.valid_until <= at) return "Validade encerrada.";
  } else if (row.until_ticket) {
    if (
      !row.ticket_id ||
      c.state === "closed" ||
      (row.conv_session && row.conv_session !== c.session)
    )
      return "Atendimento resolvido.";
    const ticket = await ctx.activeTicket(c);
    if (ticket?.id !== row.ticket_id) return "Protocolo fechado.";
  } else return "Liberação sem validade.";
  if (
    (row.kind === "subscription" || row.kind === "team") &&
    row.payer_id &&
    (await mensalidadeAvailable(ctx.env, ctx.profile))
  ) {
    try {
      const situation = await situationByPayer(
        ctx.env,
        ctx.profile,
        row.payer_id,
        { at },
      );
      if (situation.status !== "em_dia")
        return "A assinatura do pagador não está mais em dia.";
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return "Pagador removido.";
    }
  }
  return null;
}

/** Encerra pelo sistema (prazo, protocolo fechado, estorno). */
export async function settleRelease(
  ctx: ModuleContext,
  row: any,
  reason: string,
  actor = "system",
) {
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE suporte_releases SET status='ended',ended_at=?,ended_by=?,reason=CASE WHEN reason='' THEN ? ELSE reason END WHERE id=? AND status='active'",
    at,
    actor,
    reason,
    row.id,
  );
  if (result.meta.changes)
    await ctx.publish(
      "suporte.release_ended",
      row.id,
      {
        release_id: row.id,
        conversation_id: row.conversation_id,
        actor,
        reason,
      },
      { key: `${row.id}:ended` },
    );
  return !!result.meta.changes;
}

/**
 * Liberação que vale agora para a conversa, ou null. Com `settle`, encerra no
 * caminho as que não valem mais (no portão e no fluxo; as leituras da API só
 * consultam).
 */
export async function activeRelease(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
  options: { settle?: boolean } = {},
) {
  const rows = await all(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE conversation_id=? AND profile_id=? AND status='active' ORDER BY created DESC LIMIT 10",
    c.id,
    ctx.profile,
  );
  for (const row of rows) {
    const ended = await releaseEndReason(ctx, c, row, at);
    if (!ended) return row;
    if (options.settle) await settleRelease(ctx, row, ended);
  }
  return null;
}

/**
 * Estado efetivo de uma liberação gravada como ativa, sem gravar nada (para
 * as listas do painel): `null` se vale, ou o motivo do fim. O encerramento
 * gravado (com o evento) acontece no próximo pedido de humano.
 */
export async function releaseEffectiveEnd(
  ctx: ModuleContext,
  row: any,
  at: number,
) {
  if (row.status !== "active") return null;
  let c: Conversation;
  try {
    c = await ctx.conversation(row.conversation_id);
  } catch {
    return "Conversa removida.";
  }
  return releaseEndReason(ctx, c, row, at);
}

/** Estorno de uma parcela da Mensalidade: encerra as liberações que ela deu. */
export async function settleByRef(
  ctx: ModuleContext,
  ref: string,
  reason: string,
) {
  const rows = await all(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE profile_id=? AND ref_id=? AND status='active'",
    ctx.profile,
    ref,
  );
  for (const row of rows) await settleRelease(ctx, row, reason, "provider");
  return rows.length;
}

/**
 * "Em dia" que vale para liberar o suporte (conferência M5): o pagador tem
 * assinatura ativa com ao menos uma parcela paga, ou criada por um
 * administrador ou por integração com billing:write. Uma assinatura recém-
 * cadastrada por atendente (sem parcela paga) não libera sozinha: antes, um
 * atendente criava pagador com o telefone de um conhecido e assinatura no
 * futuro, e o portão via "em dia".
 */
export async function trustedStanding(ctx: ModuleContext, payerId: string) {
  return !!(await one(
    ctx.env,
    `SELECT 1 FROM mensalidade_subscriptions s WHERE s.profile_id=? AND s.payer_id=? AND s.status='active' AND (
       EXISTS (SELECT 1 FROM mensalidade_installments i WHERE i.subscription_id=s.id AND i.status='paid')
       OR s.created_by IN (SELECT id FROM users WHERE role='admin')
       OR s.created_by IN (SELECT 'app:'||a.id FROM applications a WHERE EXISTS (SELECT 1 FROM json_each(a.scopes) WHERE value='billing:write'))
     ) LIMIT 1`,
    ctx.profile,
    payerId,
  ));
}

/**
 * Regra da passagem para humano: libera com liberação ativa ou pagador em
 * dia pelo telefone da conversa. Fora isso, `allowed: false` com o motivo.
 */
export async function handoffGate(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
  options: { settle?: boolean } = {},
): Promise<{ allowed: boolean; reason: string; release_id?: string }> {
  if (!(await ctx.enabled()))
    return { allowed: true, reason: "module_disabled" };
  const release = await activeRelease(ctx, c, at, options);
  if (release)
    return { allowed: true, reason: "released", release_id: release.id };
  const phone = phoneDigits(ctx.verifiedPhone(c) ?? "");
  if (
    c.chat_type !== "group" &&
    phone &&
    (await mensalidadeAvailable(ctx.env, ctx.profile))
  ) {
    const situation = await situationByPhone(ctx.env, ctx.profile, phone, at);
    if (
      situation?.status === "em_dia" &&
      (await trustedStanding(ctx, situation.payer.id))
    )
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
