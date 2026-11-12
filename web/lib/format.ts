// Datas, nomes e pequenos formatos usados em todo o painel (pt-BR).
import type { Row } from "./api";

export const parse = (value: any, fallback: any = {}) => {
  if (typeof value !== "string") return value || fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;

/** Data e hora curtas ("12/11/2026 14:32"); "—" quando não há valor. */
export const date = (n: number) =>
  n
    ? new Date(n).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

export const time = (n: number) =>
  new Date(n).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

const startOfDay = (n: number) => {
  const d = new Date(n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Diferença em dias de calendário entre dois instantes (0 = mesmo dia). */
export const dayDiff = (from: number, to: number) =>
  Math.round((startOfDay(to) - startOfDay(from)) / DAY);

/** Horário da lista: "14:32", "Ontem", "segunda", "08/11". */
export function listTime(n: number, now = Date.now()) {
  if (!n) return "";
  const days = dayDiff(n, now);
  if (days <= 0) return time(n);
  if (days === 1) return "Ontem";
  if (days < 7)
    return new Date(n).toLocaleDateString("pt-BR", { weekday: "long" });
  return new Date(n).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    ...(new Date(n).getFullYear() !== new Date(now).getFullYear()
      ? { year: "2-digit" }
      : {}),
  });
}

/** Chip de data da conversa: "Hoje", "Ontem", "12 de novembro". */
export function dayLabel(n: number, now = Date.now()) {
  const days = dayDiff(n, now);
  if (days <= 0) return "Hoje";
  if (days === 1) return "Ontem";
  return new Date(n).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
    ...(new Date(n).getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

/** "Hoje 14:32", "Ontem 09:10", "08/11 14:00". */
export function whenLabel(n: number, now = Date.now()) {
  if (!n) return "—";
  const days = dayDiff(n, now);
  if (days === 0) return "Hoje " + time(n);
  if (days === 1) return "Ontem " + time(n);
  if (days === -1) return "Amanhã " + time(n);
  return (
    new Date(n).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    }) +
    " " +
    time(n)
  );
}

/** Duração aproximada: "agora", "4 min", "2 h", "3 dias". */
export function span(ms: number) {
  const value = Math.max(0, ms);
  if (value < MINUTE) return "agora";
  if (value < HOUR) return Math.floor(value / MINUTE) + " min";
  if (value < DAY) return Math.floor(value / HOUR) + " h";
  const days = Math.floor(value / DAY);
  return days + (days === 1 ? " dia" : " dias");
}
/** "há 4 min" (ou "agora"). */
export const ago = (n: number, now = Date.now()) => {
  const text = span(now - n);
  return text === "agora" ? text : "há " + text;
};

/** Cronômetro "0:12", "12:05", "1:02:03". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function fileSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " kB";
  return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
}

/** Até duas iniciais; telefones usam os dois últimos dígitos. */
export function initials(name: string) {
  const text = String(name || "").trim();
  if (!text) return "?";
  if (/^[+\d\s().-]+$/.test(text)) return text.replace(/\D/g, "").slice(-2);
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words.length) return text.slice(0, 1).toUpperCase();
  const first = words[0].match(/[\p{L}\p{N}]/u)?.[0] || "",
    last =
      words.length > 1
        ? words[words.length - 1].match(/[\p{L}\p{N}]/u)?.[0] || ""
        : "";
  return (first + last).toUpperCase();
}

/** Mesmo hash de String.hashCode() do Android: mesma cor de avatar nas duas pontas. */
export function avatarIndex(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 8;
}

/** +55 (11) 99999-0000 quando reconhece um número brasileiro; senão devolve como veio. */
export function phone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits || digits.length !== String(value || "").replace(/[+\s().-]/g, "").length)
    return String(value || "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4),
      rest = digits.slice(4);
    return `+55 ${ddd} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return "+" + digits;
}

/** Nome exibido de uma conversa: contato → título → telefone → identificador. */
export const conversationName = (c: Row) =>
  c.contact_name ||
  c.title ||
  (c.phone ? phone(c.phone) : "") ||
  c.external_id ||
  "Conversa";

export const digits = (value: string) => String(value || "").replace(/\D/g, "");

export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
