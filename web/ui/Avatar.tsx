import React from "react";
import { Bot, Check, Hourglass, User, Users } from "lucide-react";
import { avatarIndex, initials } from "../lib/format";
import type { Row } from "../lib/api";

export type AvatarKind = "person" | "group" | "bot";
/** Selo de estado da conversa no canto do avatar (mobile/DESIGN.md §1). */
export type StateBadge = "waiting" | "bot" | "mine" | "other" | "closed";

const badges: Record<StateBadge, { icon: typeof User; label: string }> = {
  waiting: { icon: Hourglass, label: "Na fila" },
  bot: { icon: Bot, label: "Com o bot" },
  mine: { icon: User, label: "Com você" },
  other: { icon: User, label: "Com outra pessoa" },
  closed: { icon: Check, label: "Concluída" },
};

export function conversationBadge(c: Row, meId?: string): StateBadge {
  if (c.state === "waiting") return "waiting";
  if (c.state === "ai") return "bot";
  if (c.state === "human") return c.owner && c.owner === meId ? "mine" : "other";
  return "closed";
}

/**
 * Avatar circular com iniciais e cor derivada de `seed`. Grupo usa ícone de
 * pessoas; bot usa robô sobre a cor de bot. `badge` desenha o selo de estado
 * da conversa; `online` desenha o ponto de presença (pessoas e bots da equipe).
 * O contorno do selo usa a cor de fundo do contêiner: defina `--avatar-ring`
 * no pai quando o avatar estiver sobre outra superfície.
 */
export function Avatar({
  name,
  seed,
  size = 48,
  kind = "person",
  badge,
  online,
  className = "",
}: {
  name: string;
  seed?: string;
  size?: number;
  kind?: AvatarKind;
  badge?: StateBadge | null;
  online?: boolean | null;
  className?: string;
}) {
  const Icon = kind === "group" ? Users : kind === "bot" ? Bot : null;
  const badgeSize = Math.min(30, Math.max(16, Math.round(size * 0.4)));
  const dotSize = Math.min(22, Math.max(12, Math.round(size * 0.3)));
  const Mark = badge ? badges[badge].icon : null;
  return (
    <span
      className={"avatar " + className}
      style={{ width: size, height: size }}
      aria-hidden={badge || online != null ? undefined : true}
    >
      <span
        className={
          "avatar-face " +
          (kind === "bot" ? "bot" : "c" + avatarIndex(seed || name || "?"))
        }
        style={{ fontSize: Math.round(size * 0.38) }}
      >
        {Icon ? <Icon size={Math.round(size * 0.52)} /> : initials(name)}
      </span>
      {badge && Mark ? (
        <span
          className={"avatar-badge " + badge}
          style={{ width: badgeSize, height: badgeSize }}
          role="img"
          aria-label={badges[badge].label}
          title={badges[badge].label}
        >
          <Mark size={Math.round(badgeSize * 0.5)} strokeWidth={2.6} />
        </span>
      ) : online != null ? (
        <span
          className={"avatar-dot " + (online ? "online" : "offline")}
          style={{ width: dotSize, height: dotSize }}
          role="img"
          aria-label={online ? "Online" : "Offline"}
        />
      ) : null}
    </span>
  );
}

/** Ponto de presença avulso (verde Online, cinza Offline). */
export function PresenceDot({
  online,
  size = 10,
}: {
  online: boolean;
  size?: number;
}) {
  return (
    <span
      className={"presence-dot " + (online ? "online" : "offline")}
      style={{ width: size, height: size }}
      role="img"
      aria-label={online ? "Online" : "Offline"}
    />
  );
}
