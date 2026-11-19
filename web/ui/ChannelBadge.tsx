import React from "react";
import { Facebook, Instagram, Mail, MessageCircle, CircleHelp, Send, Music2, Star } from "lucide-react";
import { channelLabel } from "../channels";

/** Selo acessível; nenhuma imagem remota ou identificador pessoal. */
export function ChannelBadge({ channel, size = 20 }: { channel?: string | null; size?: number }) {
  const Icon = channel === "instagram" ? Instagram : channel === "facebook" ? Facebook
    : channel === "whatsapp" ? MessageCircle : channel === "email" ? Mail
      : channel === "telegram" ? Send : channel === "tiktok" ? Music2 : channel === "googlebusiness" ? Star : CircleHelp;
  const known = ["whatsapp", "instagram", "facebook", "email", "telegram", "tiktok", "googlebusiness"].includes(channel || "");
  return <span className={"channel-badge channel-" + (known ? channel : "unknown")}
    style={{ width: size, height: size }} role="img" aria-label={channelLabel(channel)} title={channelLabel(channel)}>
    <Icon size={Math.round(size * 0.6)} strokeWidth={2.2} />
  </span>;
}
