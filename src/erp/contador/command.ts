// Para o contador, o que roda pelos ganchos dos módulos (carregado por
// src/modules/runtime.ts):
// - o comando do Coordinator da área que põe a mensagem com o link na fila
//   do WhatsApp (as mesmas peças do envio de documentos do ERP,
//   src/erp/conversa: linha da área, regra da janela de 24 horas e o modelo de
//   aviso fora dela);
// - o envio automático do mês anterior, no agendador do módulo ERP (uma
//   extensão: o agendador próprio do ERP continua o da cobrança).
import { exec } from "../../db";
import { ApiError, now, type Actor, type Env } from "../../types";
import { registerCommand, registerScheduleExtension } from "../../modules/hooks";
import { conversationByPhone, enqueue } from "../../service";
import { assertCanWrite, decisionFor, lineConversation, whatsappLines } from "../conversa/service.ts";
import type { LineInfo } from "../conversa/rules.ts";
import { CONTADOR_WHATSAPP_COMMAND, runAutoSend } from "./service.ts";

registerCommand(CONTADOR_WHATSAPP_COMMAND, async (env: Env, actor: Actor, profile: string, data: any) => {
  const id = typeof data?.envio_id === "string" ? data.envio_id : "";
  const phone = typeof data?.phone === "string" && /^\d{8,15}$/.test(data.phone) ? data.phone : "";
  const text = typeof data?.text === "string" ? data.text.slice(0, 2000) : "";
  if (!id || !phone || !text) throw new ApiError(400, "invalid_request", "Envio ao contador inválido.");
  const lines = await whatsappLines(env, profile);
  if (!lines.length) throw new ApiError(409, "line_not_found", "A área não tem linha de WhatsApp ativa. Conecte uma em Conexões, ou envie por e-mail.");
  // A linha do cadastro; sem ela, a primeira oficial (que abre conversa nova), senão a primeira ativa.
  const line: LineInfo = lines.find((item) => item.id === data.line) ?? lines.find((item) => item.kind === "zernio") ?? lines[0];
  let c = await lineConversation(env, profile, phone, line.id);
  if (actor.kind === "user") await assertCanWrite(env, actor, c);
  const decision = await decisionFor(env, profile, line, c, [], "order", now());
  if (decision.mode === "bloqueado")
    throw new ApiError(409, "erp_contador_whatsapp_blocked", `${(decision.reason ?? "O WhatsApp não leva esta mensagem agora.").replace(/o cliente/gi, "o contador").replace(/este cliente/gi, "o contador")} Ou envie por e-mail.`);
  if (!c) {
    c = await conversationByPhone(env, profile, phone, { open: true, connectionId: line.id, module: "erp" });
    if (!c) throw new ApiError(409, "erp_contador_whatsapp_blocked", "Não deu para abrir a conversa com o número do contador nesta linha. Confira o número ou envie por e-mail.");
  }
  const dedupe = `erp-contador:${id}`;
  // Fora da janela de 24 horas: o modelo de aviso da área, com o link no texto.
  if (decision.mode === "modelo") await enqueue(env, c, actor.id, "notification", { text, consent_purpose: "order" }, dedupe);
  else await enqueue(env, c, actor.id, "text", { text }, dedupe);
  await exec(env, "UPDATE erp_contador_sends SET conversation_id=?,updated=? WHERE id=? AND profile_id=?", c.id, now(), id, profile);
  return { conversation_id: c.id };
});

// Envio automático: falha de uma área não para as outras nem o agendador.
registerScheduleExtension("erp", async (env: Env, profile: string, at: number) => {
  try { await runAutoSend(env, profile, typeof at === "number" ? at : Date.now()); } catch { /* tenta de novo na próxima passada */ }
});
