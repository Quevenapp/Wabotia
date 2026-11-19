import type { ChannelId } from "../src/channel-contracts";
import type { Row } from "./lib/api";
import { channelUiFor } from "./channel-extensions";

const labels: Record<ChannelId, string> = {
  whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook",
  tiktok: "TikTok", googlebusiness: "Google Business", telegram: "Telegram", email: "E-mail",
};

export function channelLabel(channel: unknown): string {
  return typeof channel === "string" && Object.hasOwn(labels, channel)
    ? labels[channel as ChannelId] : "Canal desconhecido";
}

/** ID explícito, mesmo desconhecido, prevalece. Só um transporte reconhecido
 * permite interpretar uma conversa antiga como WhatsApp. */
export function conversationChannel(row: Row, lineKinds?: Record<string, string> | null): string | null {
  const kind = (row.connection_id ? lineKinds?.[row.connection_id] : undefined) || row.connection_kind;
  if (row.kind === "ai" || kind === "ai" || row.type === "internal" || row.kind === "internal" || row.kind === "app") return null;
  if (typeof row.channel === "string" && row.channel) return row.channel;
  if (row.external_namespace && !String(row.external_namespace).startsWith("channel:")) return null;
  return ["qr", "meta", "zernio", "whatsapp"].includes(kind || "") ? "whatsapp" : null;
}

/** Só os canais de conversa projetados pelo servidor entram nos filtros. */
export function conversationChannels(status: Row): ChannelId[] {
  const values: unknown[] = Array.isArray(status.conversation_channels) ? status.conversation_channels : [];
  return ["whatsapp", "instagram", "facebook", "telegram", "email", "tiktok"].filter((id) =>
    values.includes(id) && (["whatsapp", "instagram", "facebook"].includes(id) || !!channelUiFor({ channel: id }))) as ChannelId[];
}

export function isMultichannel(status: Row): boolean {
  return status.multichannel === true || conversationChannels(status).length > 1;
}

export function channelPresentation(row: Row, status: Row, lineKinds?: Record<string, string> | null) {
  const channel = conversationChannel(row, lineKinds);
  const multichannel = isMultichannel(status) || row.multichannel === true;
  const label = channelLabel(channel);
  return { channel, multichannel, label,
    subtitle: multichannel ? label + (row.account_label ? " · " + row.account_label : "") : "" };
}

/** O título mínimo não expõe nome/canal, e um título já prefixado não duplica. */
export function channelNotificationTitle(name: string, channel: unknown, multichannel: boolean, minimal = false): string {
  if (minimal) return "Wabotia";
  if (!multichannel) return name;
  const prefix = channelLabel(channel) + " · ";
  return name.startsWith(prefix) ? name : prefix + name;
}
