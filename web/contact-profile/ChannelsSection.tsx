import React from "react";
import type { CustomerChannelView, OtherChannelConversation } from "../../src/channel-contracts";

const labels: Record<string, string> = {
  whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok",
  googlebusiness: "Google Business", telegram: "Telegram", email: "E-mail",
};
export const customerChannelLabel = (channel: string | null) => channel && labels[channel] || "Canal desconhecido";
const states: Record<string, string> = {
  ready: "Verificado neste canal", pending: "Aguardando confirmação", ambiguous: "Vínculo em revisão",
  blocked: "Bloqueado", erased: "Restrito por solicitação de exclusão",
};
export function hasSocialChannels(channels: readonly CustomerChannelView[] | undefined): boolean {
  return !!channels?.some(item => item.channel !== "whatsapp");
}

export function ChannelsSection({ channels, conversations = [] }: {
  channels?: readonly CustomerChannelView[];
  /** A API já aplica a autorização de cada origem; nunca buscar outros históricos por conta própria. */
  conversations?: readonly OtherChannelConversation[];
}) {
  if (!hasSocialChannels(channels)) return null;
  return <section className="customer-profile-card" aria-label="Canais">
    <h3>Canais</h3>
    <ul className="customer-profile-channels">
      {channels!.map(item => <li key={item.id}>
        <strong>{customerChannelLabel(item.channel)}</strong>
        {item.account_label && <span>Conta empresarial: {item.account_label}</span>}
        {(item.display_name || item.username) && <span>{item.display_name}{item.display_name && item.username ? " · " : ""}{item.username}</span>}
        <span>{states[item.state] ?? "Situação desconhecida"}</span>
      </li>)}
    </ul>
    {conversations.length > 0 && <>
      <h4>Conversas disponíveis</h4>
      <ul>{conversations.map(item => <li key={item.id}><a href={"/app/conversas/" + encodeURIComponent(item.id)}>
        {customerChannelLabel(item.channel)}{item.account_label ? " · " + item.account_label : ""} · {item.title || "Conversa"}
      </a></li>)}</ul>
    </>}
  </section>;
}
