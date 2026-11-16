// Conteúdo estruturado recebido do WhatsApp (src/whatsapp-inbound.ts):
// resposta de Flow ("flow_reply") e carrinho do catálogo ("order"). Tratado no
// processInbox antes do menu e do bot: o resumo em texto nunca abre o menu nem
// vira pergunta ao bot.
//
//   1. flow_reply com flow_token de um passo web desta conversa: conclui o passo
//      (mesmas regras do link: uso único, validade, retorno no WhatsApp).
//   2. Módulos que tratam o tipo (src/modules/api.ts, onInboundContent).
//   3. Sem dono: a conversa com o bot vai para a equipe, com o resumo como
//      pedido; com atendente, a mensagem fica no histórico para ele.
import { ApiError, type Conversation, type Env } from "./types";
import { enqueue, handoff } from "./service";
import { completeWebStepByFlow } from "./web-steps";
import { inboundHandlersFor } from "./modules/hooks";

export const structuredTypes = ["flow_reply", "order"] as const;
export const isStructured = (content: any) =>
  structuredTypes.includes(content?.type);

async function say(env: Env, c: Conversation, text: string, key: string) {
  try {
    await enqueue(
      env,
      c,
      "system",
      "text",
      { text, automation: "web_step" },
      key,
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
}

/**
 * Localização enviada pelo cliente: oferecida aos módulos (onInboundContent
 * "location"), sem tratamento padrão. true quando um módulo tratou.
 */
export async function moduleLocation(
  env: Env,
  c: Conversation,
  row: { id: string },
  data: any,
) {
  for (const handler of inboundHandlersFor("location"))
    if (await handler(env, c, data.content, row.id)) return true;
  return false;
}

export async function structuredInbound(
  env: Env,
  c: Conversation,
  row: { id: string },
  data: any,
  automation: boolean,
) {
  const content = data.content || {};
  if (content.type === "flow_reply") {
    const matched = await completeWebStepByFlow(env, c, content.flow_reply);
    if (matched) {
      const { result } = matched;
      // Concluído: completeWebStep já enviou o retorno.
      if (!result.ok)
        await say(
          env,
          c,
          result.reason === "invalid"
            ? "Algumas respostas obrigatórias não chegaram. Abra o formulário de novo pelo mesmo botão e envie outra vez."
            : result.reason === "rejected"
              ? result.message
              : result.reason === "used"
                ? "Já recebemos as respostas deste formulário. Obrigado!"
                : "Este formulário expirou. Envie MENU para ver as opções.",
          `flow-reply:${row.id}`,
        );
      return "web_step";
    }
  }
  for (const handler of inboundHandlersFor(content.type))
    if (await handler(env, c, content, row.id)) return "module";
  if (automation && c.state === "ai")
    await handoff(
      env,
      c,
      content.type === "order"
        ? "Pedido pelo catálogo do WhatsApp"
        : "Formulário do WhatsApp respondido",
      null,
      String(data.text || "").slice(0, 3800),
      true,
      { source: "structured", rowId: row.id },
    );
  return "team";
}
