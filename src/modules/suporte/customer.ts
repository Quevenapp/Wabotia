// Situação do suporte pago para o próprio cliente da conversa (ferramenta de
// cliente `suporte_situacao`): está liberado, até quando, e o que falta. Só
// lê: não encerra liberação nem abre fluxo. A identidade é a conversa e o
// telefone verificado pelo canal; CPF/CNPJ digitado nunca entra aqui (A4),
// e nada do que o cliente diz ("já paguei") muda o estado: só a confirmação
// do provedor.
import { one } from "../../db";
import { type Conversation, now } from "../../types";
import type { ModuleContext } from "../api";
import {
  mensalidadeAvailable,
  sellablePlans,
  situationByPhone,
} from "../mensalidade/public";
import { stamp } from "../mensalidade/model";
import { activeRelease, handoffGate } from "./handoff";
import {
  dayLabel,
  money,
  packageValidity,
  phoneDigits,
  releaseDeadline,
  suporteSettings,
} from "./model";
import { KIND_LABELS } from "./store";

const PERIODS: Record<string, string> = {
  monthly: "mês",
  quarterly: "trimestre",
  yearly: "ano",
};

export async function customerSituation(ctx: ModuleContext, c: Conversation) {
  const at = now();
  const phone = phoneDigits(ctx.verifiedPhone(c) ?? "");
  const rel = await activeRelease(ctx, c, at);
  const gate = rel
    ? { allowed: true, reason: "released" }
    : await handoffGate(ctx, c, at);
  if (gate.allowed) {
    return {
      liberado: true,
      motivo:
        gate.reason === "subscription"
          ? "assinatura em dia"
          : gate.reason === "module_disabled"
            ? "suporte pago desligado"
            : KIND_LABELS[rel?.kind] || "liberação",
      liberacao: rel
        ? {
            ate: rel.valid_until ? stamp(rel.valid_until) : null,
            ate_o_protocolo_fechar: !rel.valid_until && !!rel.until_ticket,
            prazo_maximo: stamp(releaseDeadline(rel)),
          }
        : null,
      falta: null,
    };
  }
  // O que falta, na ordem em que o cliente resolve.
  const purchase = await one(
    ctx.env,
    "SELECT package_name,price_cents,payment_expires_at FROM suporte_purchases WHERE conversation_id=? AND profile_id=? AND status='pending' AND payment_id IS NOT NULL AND coalesce(payment_expires_at,0)>? ORDER BY created DESC LIMIT 1",
    c.id,
    ctx.profile,
    at,
  );
  const session = await one(
    ctx.env,
    "SELECT status,step,payer_id FROM suporte_sessions WHERE conversation_id=? AND profile_id=? ORDER BY updated DESC LIMIT 1",
    c.id,
    ctx.profile,
  );
  const awaitingTeam =
    session?.status === "awaiting_team" && session.step !== "group";
  const mensalidadeOn = await mensalidadeAvailable(ctx.env, ctx.profile);
  // Só pelo telefone verificado da conversa (pagador que o autorizou).
  const situation =
    phone && c.chat_type !== "group" && mensalidadeOn
      ? await situationByPhone(ctx.env, ctx.profile, phone, at)
      : null;
  const overdue =
    situation?.status === "em_atraso" && situation.open_installment
      ? {
          valor: money(situation.open_installment.amount_cents),
          vencimento: dayLabel(situation.open_installment.due_date),
        }
      : null;
  const cfg = suporteSettings(await ctx.settings());
  const packages = cfg.packages
    .filter((p) => p.active)
    .map((p) => ({
      nome: p.name,
      valor: money(p.price_cents),
      validade: packageValidity(p),
    }));
  const plans =
    cfg.offer_plans && phone && mensalidadeOn
      ? (await sellablePlans(ctx.env, ctx.profile))
          .filter((p) => !cfg.plan_ids.length || cfg.plan_ids.includes(p.id))
          .map((p) => ({
            nome: p.name,
            valor: `${money(p.amount_cents)} por ${PERIODS[p.period] || "mês"}`,
          }))
      : [];
  const falta = purchase
    ? `O pagamento do pacote ${purchase.package_name} (${money(purchase.price_cents)}) ainda não foi confirmado pelo provedor. Quando cair, o suporte é liberado sozinho.`
    : awaitingTeam
      ? "A equipe precisa confirmar o cadastro antes de liberar o atendimento."
      : overdue
        ? `A mensalidade de ${overdue.valor} venceu em ${overdue.vencimento} e está em aberto. Paga, o suporte é liberado.`
        : situation?.status === "em_dia"
          ? "A assinatura ainda não tem pagamento confirmado: a equipe confere."
          : packages.length || plans.length
            ? "Contratar um pacote avulso ou um plano para falar com um atendente."
            : "Falar com a equipe para liberar o atendimento.";
  return {
    liberado: false,
    motivo: "pagamento necessário",
    falta,
    pagamento_pendente: purchase
      ? {
          pacote: purchase.package_name,
          valor: money(purchase.price_cents),
          codigo_vale_ate: stamp(purchase.payment_expires_at),
        }
      : null,
    aguardando_equipe: awaitingTeam,
    mensalidade_em_atraso: overdue,
    ofertas: { pacotes: packages, planos: plans },
    aviso:
      "Dizer que já pagou não libera: só a confirmação do provedor. Para contratar, o cliente pede atendimento humano e escolhe no menu do suporte.",
  };
}
