import React from "react";
import type { ChannelAction } from "../../src/channel-c2-contracts";
import type { ChannelDraft, ChannelUiData, ComposerSlotProps, ConversationSlotProps } from "../channel-extension-contracts";
import { channelMetadata, uiRecord } from "./ChannelMarks";

export function tiktokQuotaState(conversation: ChannelUiData, now: number, requested = 1, detail: ChannelUiData = {}) {
  const metadata = channelMetadata(conversation, detail), quota = uiRecord(metadata.tiktok), window = uiRecord(conversation.window ?? detail.window);
  const rawRemaining = quota.remainingMessages ?? metadata.remainingMessages ?? window.remainingMessages;
  const remaining = typeof rawRemaining === "number" && Number.isInteger(rawRemaining) && rawRemaining >= 0 && rawRemaining <= 10 ? rawRemaining : null;
  const rawDeadline = quota.closesAt ?? metadata.closesAt ?? window.closesAt;
  const closesAt = typeof rawDeadline === "number" && Number.isFinite(rawDeadline) && Math.abs(rawDeadline) <= 8_640_000_000_000_000 ? rawDeadline : null;
  const time = Math.max(now, typeof window.serverNow === "number" ? window.serverNow : now);
  const open = closesAt !== null && closesAt > time && window.canHumanText !== false && window.state !== "closed";
  const enough = remaining !== null && requested > 0 && remaining >= requested;
  return { remaining, closesAt, requested, open, canSend: open && enough,
    reason: !open ? "A janela de 48 horas está fechada ou aguarda atualização. Aguarde uma nova mensagem do cliente."
      : remaining === null ? "A contagem de mensagens aguarda atualização do servidor."
      : !enough ? `Este envio precisa de ${requested} vagas; há ${remaining} disponíveis. Nenhuma parte será enviada.` : null };
}

export function TikTokQuota(props: ConversationSlotProps) {
  if (props.conversation.channel !== "tiktok") return null;
  const quota = tiktokQuotaState(props.conversation, props.now, 1, props.detail);
  return <section className="c2-panel c2-quota" aria-label="Limites do TikTok">
    <strong>TikTok · janela de 48 horas</strong>
    <p>{quota.remaining === null ? "Contagem aguardando atualização" : `Restam ${quota.remaining} de 10 mensagens`}</p>
    {quota.closesAt !== null && <p>Prazo do servidor: <time dateTime={new Date(quota.closesAt).toISOString()}>{new Date(quota.closesAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time></p>}
    <p className="c2-help">Regra conservadora: até dez envios ou tentativas nos últimos 48 horários corridos. Uma nova entrada renova o prazo, mas não zera a contagem. Envios externos e indeterminados também contam. A conferir com a conta real.</p>
    {quota.reason && <p className="c2-notice" role="status">{quota.reason}</p>}
  </section>;
}

export function TikTokComposerFields(props: ComposerSlotProps) {
  if (props.conversation.channel !== "tiktok") return null;
  const files = props.draft.pendingAttachments ?? props.draft.attachmentDetails;
  const requested = (props.draft.text.trim() ? 1 : 0) + files.length;
  const quota = tiktokQuotaState(props.conversation, props.now, requested || 1, props.detail);
  return <div className="c2-composer-fields">
    {requested > 1 && <p>Texto antes da imagem: duas entregas, duas vagas. O envio só começa com as duas vagas disponíveis.</p>}
    {quota.reason && <p className="c2-notice" role="status">{quota.reason}</p>}
    <small className="c2-help">Até 6.000 caracteres e uma imagem JPG ou PNG de até 3.000.000 bytes. O servidor reconfere prazo e quota.</small>
  </div>;
}

export function prepareTikTokAction(draft: ChannelDraft): ChannelAction {
  if (draft.conversation.channel !== "tiktok") throw new Error("Canal incompatível.");
  if (draft.text.length > 6000) throw new Error("O texto do TikTok pode ter até 6.000 caracteres, incluindo a assinatura.");
  if (draft.attachmentDetails.length > 1 || draft.attachmentDetails.some(file => file.kind !== "image" || !["image/jpeg", "image/png"].includes(file.mimeType) || !Number.isFinite(file.bytes) || file.bytes < 1 || file.bytes > 3_000_000))
    throw new Error("Use uma imagem JPG ou PNG de até 3.000.000 bytes.");
  if (draft.attachments.length !== draft.attachmentDetails.length || ["location", "contacts", "sticker"].includes(String(draft.content.type)))
    throw new Error("Este conteúdo não está disponível no TikTok.");
  const requested = (draft.text.trim() ? 1 : 0) + draft.attachmentDetails.length;
  if (!requested) throw new Error("Escreva uma mensagem ou selecione uma imagem.");
  const window = uiRecord(draft.conversation.window);
  // A preparação usa o relógio da projeção; o servidor reconfere ao reservar.
  const quota = tiktokQuotaState(draft.conversation, typeof window.serverNow === "number" ? window.serverNow : Date.now(), requested);
  if (!quota.canSend) throw new Error(quota.reason ?? "Atualize a quota antes de enviar.");
  return { type: "message.send", text: draft.text, attachments: draft.attachmentDetails.map(file => ({ ...file })) };
}
