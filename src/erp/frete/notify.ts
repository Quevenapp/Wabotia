// Frete: o aviso ao cliente pelo WhatsApp quando o rastreio muda (ajuste da
// área, desligado por padrão). As mesmas peças do envio de documentos do ERP
// (src/erp/conversa): a linha de WhatsApp da área, a regra da janela de 24
// horas e o modelo de aviso fora dela. Sem linha, sem telefone ou com a
// mensagem bloqueada pela regra, o aviso não sai e o rastreio segue.
import { conversationByPhone, enqueue } from "../../service";
import type { Env } from "../../types";
import { decisionFor, lineConversation, whatsappLines } from "../conversa/service.ts";

export interface TrackingNotice { phone: string; text: string; dedupe: string; actor: string }

/** Põe o aviso na fila do WhatsApp; devolve se saiu (ou o motivo de não sair). */
export async function sendTrackingNotice(env: Env, profile: string, notice: TrackingNotice, at: number): Promise<{ sent: boolean; reason: string | null }> {
  const lines = await whatsappLines(env, profile);
  if (!lines.length) return { sent: false, reason: "Sem linha de WhatsApp ativa na área." };
  const line = lines.find((item) => item.kind === "zernio") ?? lines[0];
  let c = await lineConversation(env, profile, notice.phone, line.id);
  const decision = await decisionFor(env, profile, line, c, [], "order", at);
  if (decision.mode === "bloqueado") return { sent: false, reason: decision.reason ?? "A regra do WhatsApp não deixa enviar agora." };
  if (!c) {
    c = await conversationByPhone(env, profile, notice.phone, { open: true, connectionId: line.id, module: "erp" });
    if (!c) return { sent: false, reason: "Não deu para abrir a conversa com o cliente nesta linha." };
  }
  if (decision.mode === "modelo") await enqueue(env, c, notice.actor, "notification", { text: notice.text, consent_purpose: "order" }, notice.dedupe);
  else await enqueue(env, c, notice.actor, "text", { text: notice.text }, notice.dedupe);
  return { sent: true, reason: null };
}
