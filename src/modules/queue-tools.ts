// Fila presencial no bot (ferramenta de cliente "minha senha"). A Fila é do
// núcleo (src/queue.ts); aqui fica só a rota de leitura da conversa e a
// ferramenta, no contrato dos módulos (onRead + onMcpTool), para o bot que
// atende o cliente com o ator interno preso à conversa.
import { conversationTicket } from "../queue";
import { onMcpTool, onRead } from "./api";

onRead("queue", "queue/conversations/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  const c = await ctx.conversation(params.id, actor);
  return conversationTicket(ctx.env, ctx.profile, c.id);
});

onMcpTool("queue", {
  name: "queue_minha_senha",
  description:
    "Senha da fila presencial do cliente da conversa, de hoje: código, fila, estado (aguardando, chamada, em atendimento), quantas pessoas estão na frente e a espera estimada em minutos. Sem senha ativa: senha null. Só consulta.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  customer: "read",
  call: (a, profile) => ({
    path: `/profiles/${profile}/queue/conversations/${a.conversation_id}`,
  }),
});
