import React from "react";
import type { ChannelUiData, ConversationSlotProps } from "../channel-extension-contracts";
import { channelUiKey, channelExtensionReason } from "../channel-extensions";

/** Somente projeções públicas. Não percorre nem imprime payloads do provedor. */
export function uiRecord(value: unknown): ChannelUiData {
  if (typeof value === "string") {
    try { return uiRecord(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
}

export function uiText(value: unknown, limit = 4000): string {
  if (typeof value !== "string") return "";
  // Defesa adicional: uma projeção defeituosa nunca exibe a URL com token.
  return value.replace(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^\s<>"']+/gi, "[endereço protegido]").slice(0, limit);
}

export function channelMetadata(conversation: ChannelUiData, detail: ChannelUiData = {}): ChannelUiData {
  return uiRecord(uiRecord(detail.channel_extension ?? conversation.channel_extension).metadata);
}

export function deliveryStateText(state: unknown): string | null {
  switch (state) {
    case "pending": case "reserved": case "sending": return "Envio pendente de confirmação.";
    case "retry": case "rate_limited": return "Aguardando o intervalo permitido para tentar o envio.";
    case "unknown": return "Resultado indeterminado. Confira o envio antes de autorizar outra tentativa.";
    case "failed": return "O envio falhou. Revise a situação antes de tentar novamente.";
    case "removal_pending": return "Remoção pendente. A conexão continua pausada.";
    default: return null;
  }
}

export function ChannelDeliveryNotice({ state, code }: { state: unknown; code?: unknown }) {
  const notices = [...new Set([deliveryStateText(state), channelExtensionReason(code)].filter((text): text is string => !!text))];
  return notices.length ? <p className="c2-notice" role="status">{notices.join(" ")}</p> : null;
}

/** Selo de contexto usado somente pelos slots da segunda leva. */
export function ChannelMarks(props: ConversationSlotProps) {
  const key = channelUiKey(props.conversation);
  if (!key) return null;
  const label = key.endsWith("/comment") ? "Comentário" : ({
    "telegram/direct": "Telegram", "email/direct": "E-mail", "tiktok/direct": "TikTok", "googlebusiness/review": "Avaliação do Google",
  } as Record<string, string>)[key];
  return <span className="c2-mark">{label}</span>;
}
