import React from "react";
import { Clock, Lock } from "lucide-react";
import type { Tone, WindowInfo } from "../lib/window";

/**
 * Anel de progresso: cheio em fraction = 1 e esvazia no sentido horário.
 * O centro mostra um ícone (padrão) ou os filhos (tempo no anel grande).
 */
export function ProgressRing({
  fraction,
  tone,
  size = 22,
  stroke = 2.5,
  icon,
  children,
  label,
}: {
  fraction: number;
  tone: Tone | "bot" | "ticket" | "brand";
  size?: number;
  stroke?: number;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  label?: string;
}) {
  const value = Math.min(1, Math.max(0, fraction));
  const radius = (size - stroke) / 2,
    length = 2 * Math.PI * radius;
  return (
    <span
      className={"ring tone-" + tone}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
        />
        {value > 0 && (
          <circle
            className="ring-value"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${length * value} ${length}`}
            // A parte vazia cresce a partir do topo, no sentido horário.
            transform={`rotate(${-90 + 360 * (1 - value)} ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-center">{children ?? icon}</span>
    </span>
  );
}

/** Anel da janela de 24 h: relógio no centro; fechada vira cadeado. */
export function WindowRing({
  info,
  size = 22,
  stroke,
  children,
}: {
  info: WindowInfo;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const Icon = info.closed ? Lock : Clock;
  return (
    <ProgressRing
      fraction={info.fraction}
      tone={info.tone}
      size={size}
      stroke={stroke ?? (size >= 60 ? 6 : 2.5)}
      label={
        info.closed
          ? "Janela de 24 horas fechada"
          : `Janela de 24 horas: ${info.long} restantes`
      }
      icon={<Icon size={Math.round(size * 0.5)} strokeWidth={2.4} />}
    >
      {children}
    </ProgressRing>
  );
}
