// Relógio da janela de 24 horas (mobile/DESIGN.md §2).
import type { Row } from "./api";
import { dayDiff, time, whenLabel } from "./format";
import { whatsappServiceWindow } from "../whatsapp-service-window";
import { conversationChannel } from "../channels";
import type { WindowState } from "../../src/channel-contracts";

export const WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type Tone = "ok" | "warn" | "danger" | "muted";

export function channelWindowReason(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason) return null;
  const labels: Record<string, string> = {
    window_closed: "Janela fechada. Aguarde uma nova mensagem do cliente.",
    human_only: "Somente texto escrito por uma pessoa é permitido nesta janela.",
    cannot_initiate: "O cliente precisa iniciar a conversa neste canal.",
    unsupported_content: "Este formato não é aceito pelo canal.",
    inbox_required: "A caixa de entrada desta conta precisa estar habilitada.",
    channel_not_ready: "Este canal ainda não está disponível para envio.",
    provider_unknown: "O resultado no provedor é indeterminado. Confira antes de reenviar.",
  };
  return labels[reason] || reason;
}

export type WindowInfo = {
  source?: "server";
  state?: WindowState["state"];
  channel?: string | null;
  reason?: string | null;
  humanTextClosesAt?: number | null;
  lastCustomer: number;
  expiresAt: number;
  remainingMs: number;
  closed: boolean;
  /** 1 = 24 h inteiras, 0 = fechada. */
  fraction: number;
  tone: Tone;
  /** `23h 14min`, `5h 02min`, `42 min`, `menos de 1 min`, `Janela fechada`. */
  long: string;
  /** `23h`, `5h`, `42m`; vazio quando fechada (a lista mostra o cadeado). */
  compact: string;
  /** "até 14:32" ou "até amanhã 09:10". */
  until: string;
};

/**
 * Janela da conversa, ou null quando não se aplica: grupos e linhas que não
 * são WhatsApp oficial. Sem tipo de linha conhecido, o relógio aparece.
 */
export function windowInfo(
  conversation: Row,
  lineKinds: Record<string, string> | null | undefined,
  now: number,
): WindowInfo | null {
  if (conversation.chat_type === "group") return null;
  const channel = conversationChannel(conversation, lineKinds);
  if ("window" in conversation) {
    const state = conversation.window as WindowState | null;
    if (!state || state.kind === "none") return null;
    const humanOnly = state.state === "human_text_only";
    const expiresAt = Number(humanOnly ? state.humanTextClosesAt : state.closesAt) || 0;
    const current = Math.max(now, Number(state.serverNow) || now);
    const remainingMs = Math.max(0, expiresAt - current);
    const closed = state.state === "closed" || !state.canHumanText || !remainingMs;
    const minutes = Math.floor(remainingMs / 60_000);
    return {
      source: "server", state: closed ? "closed" : state.state, channel,
      reason: channelWindowReason(closed && state.state !== "closed" ? "window_closed" : state.reason), humanTextClosesAt: state.humanTextClosesAt,
      lastCustomer: Number(conversation.last_customer) || 0,
      expiresAt, remainingMs, closed,
      fraction: closed ? 0 : Math.min(1, remainingMs / (humanOnly ? 144 * HOUR_MS : WINDOW_MS)),
      tone: closed ? "muted" : humanOnly ? "warn" : remainingMs < HOUR_MS ? "danger" : remainingMs <= 6 * HOUR_MS ? "warn" : "ok",
      long: closed ? "Janela fechada" : minutes < 1 ? "menos de 1 min" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`,
      compact: closed ? "" : minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${Math.max(1, minutes)}m`,
      until: closed ? "" : dayDiff(current, expiresAt) === 0 ? "até " + time(expiresAt) : dayDiff(current, expiresAt) === 1 ? "até amanhã " + time(expiresAt) : "até " + whenLabel(expiresAt, current),
    };
  }
  if (channel !== "whatsapp") return null;
  const kind = conversation.connection_id
    ? lineKinds?.[conversation.connection_id]
    : undefined;
  if (kind && kind !== "meta" && kind !== "zernio") return null;
  const lastCustomer = Number(conversation.last_customer) || 0;
  // O relógio da tela anda de 30 em 30 s: logo depois de uma mensagem nova o
  // "agora" pode estar atrás dela.
  const base = whatsappServiceWindow(lastCustomer, Math.max(now, lastCustomer));
  const remainingMs = base.remainingMs;
  const closed = !base.open;
  const expiresAt = base.expiresAt || 0;
  const minutes = Math.floor(remainingMs / 60_000);
  return {
    lastCustomer,
    expiresAt,
    remainingMs,
    closed,
    fraction: Math.min(1, Math.max(0, remainingMs / WINDOW_MS)),
    tone: closed
      ? "muted"
      : remainingMs < HOUR_MS
        ? "danger"
        : remainingMs <= 6 * HOUR_MS
          ? "warn"
          : "ok",
    long: closed
      ? "Janela fechada"
      : minutes < 1
        ? "menos de 1 min"
        : minutes < 60
          ? `${minutes} min`
          : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`,
    compact: closed
      ? ""
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.max(1, minutes)}m`,
    until: closed
      ? ""
      : dayDiff(now, expiresAt) === 0
        ? "até " + time(expiresAt)
        : dayDiff(now, expiresAt) === 1
          ? "até amanhã " + time(expiresAt)
          : "até " + whenLabel(expiresAt, now),
  };
}

/** Prazo de protocolo com o mesmo anel: fração sobre o período total conhecido. */
export function deadlineTone(remainingMs: number): Tone {
  if (remainingMs <= 0) return "danger";
  if (remainingMs < HOUR_MS) return "warn";
  return "ok";
}
