// Rotas, comandos e ação de conversa da Cobrança (docs/COBRANCA.md). As
// regras ficam em src/payments.ts; aqui só a ligação pela interface interna.
import { requireValue } from "../../types";
import {
  cancelPayment,
  checkPaymentAccount,
  createPayment,
  getPayment,
  getPaymentAccount,
  listPayments,
  savePaymentAccount,
} from "../../payments";
import { onCommand, onConversationAction, onRead, onRoute } from "../api";

// Conta do provedor (administrador). A leitura nunca devolve segredos.
onRead("payments", "payments/account", (ctx, actor) =>
  getPaymentAccount(ctx.env, actor, ctx.profile),
);
// Confere as credenciais no provedor (GET: não muda nada além do resultado).
onRead("payments", "payments/account/check", (ctx, actor) =>
  checkPaymentAccount(ctx.env, actor, ctx.profile),
);
onRoute("payments", {
  method: "PUT",
  path: "payments/account",
  op: "payment.account.save",
});
onCommand("payments", "payment.account.save", (ctx, actor, data) =>
  savePaymentAccount(ctx.env, actor, ctx.profile, data),
);

// Cobranças de uma conversa e consulta de uma cobrança.
onRead("payments", "payments", async (ctx, actor, { query }) => {
  requireValue(query.conversation_id, "Informe conversation_id.");
  return listPayments(ctx.env, actor, ctx.profile, query.conversation_id);
});
onRead("payments", "payments/:id", (ctx, actor, { params }) =>
  getPayment(ctx.env, actor, ctx.profile, params.id),
);
onRoute("payments", {
  method: "POST",
  path: "payments/:id/cancel",
  op: "payment.cancel",
});
onCommand("payments", "payment.cancel", (ctx, actor, data) =>
  cancelPayment(ctx.env, actor, ctx.profile, data.id),
);

// "Cobrar" na conversa: atendente com a conversa, administrador, bot com a
// conversa ou integração que a assumiu.
onConversationAction(
  "payments",
  "charge",
  async (ctx, actor, c, data, request) => {
    const bot = actor.id.startsWith("bot:");
    requireValue(
      c.owner === actor.id ||
        (actor.kind === "user" && actor.role === "admin") ||
        (bot && c.state === "ai"),
      "Assuma a conversa antes de cobrar.",
    );
    const result = await createPayment(ctx.env, {
      conversation: c,
      method: data.method,
      amount_cents: data.amount_cents,
      description: data.description,
      // Cobrança avulsa: só um módulo (ctx.charge) liga a um registro seu.
      module: null,
      ref: null,
      trigger: actor.kind === "user" && !bot ? "agent" : "bot",
      actor: actor.id,
      sourceKey: `action:${c.id}:${actor.id}:${request.requestId}`,
      expiresMinutes: Number(data.expires_minutes) || undefined,
    });
    return result.payment;
  },
);
