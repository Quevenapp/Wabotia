// Peças comuns de Equipe: estados de execução de bots, saída do bot e a
// prévia local das conversas internas (a lista do servidor não traz prévia).
import type { Row } from "../lib/api";
import { readStore, writeStore } from "../lib/storage";
import type { PillTone } from "../ui";

/** Texto do andamento de um pedido ao bot dentro do chat interno. */
export const internalRunStatus: Record<string, string> = {
  queued: "Aguardando o bot",
  running: "Bot respondendo…",
  starting: "Iniciando resposta…",
  failed: "O bot não conseguiu responder",
  unknown: "Resposta sem confirmação",
  cancelled: "Resposta cancelada",
};

export const runStatusName: Record<string, string> = {
  queued: "Na fila",
  starting: "Iniciando",
  running: "Em execução",
  cancelling: "Cancelando",
  cancelled: "Cancelada",
  completed: "Concluída",
  failed: "Falhou",
  unknown: "Sem confirmação",
};
export const runStatusTone = (status: string): PillTone =>
  status === "completed"
    ? "ok"
    : status === "failed"
      ? "danger"
      : status === "unknown"
        ? "warn"
        : ["queued", "starting", "running"].includes(status)
          ? "bot"
          : "muted";
export const runActive = (status: string) =>
  ["queued", "starting", "running", "cancelling"].includes(status);

/** Texto e anexos do `result` de uma execução (texto puro ou JSON do Hermes). */
export function botOutput(run: Row): { text: string; attachments: string[] } {
  const raw = String(run.result || "").trim();
  let text = raw,
    files: string[] = Array.isArray(run.attachments) ? run.attachments : [];
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const candidate = [
          "text",
          "output",
          "message",
          "content",
          "result",
          "answer",
          "response",
        ]
          .map((key) => parsed[key])
          .find((value) => typeof value === "string" && value.trim());
        if (!files.length && Array.isArray(parsed.attachments))
          files = parsed.attachments.filter(
            (item: unknown) => typeof item === "string",
          );
        if (candidate) text = candidate;
        else {
          const { attachments, files: ignored, ...rest } = parsed;
          void attachments;
          void ignored;
          text = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "";
        }
      }
    } catch {
      /* não era JSON: mostra como veio */
    }
  }
  return { text, attachments: [...new Set(files)] };
}

export type Preview = { text: string; author: string; created: number };
const previewKey = (profile: string) => "wabotia:internal-previews:" + profile;
export const readPreviews = (profile: string) =>
  readStore<Record<string, Preview>>(previewKey(profile), {});
export function rememberPreview(profile: string, chatId: string, message?: Row) {
  if (!message) return;
  const all = readPreviews(profile);
  if (all[chatId]?.created === message.created) return;
  all[chatId] = {
    text: String(message.text || "").slice(0, 160),
    author: message.author,
    created: message.created,
  };
  writeStore(previewKey(profile), all);
}

/** "Todas as linhas", "2 linhas", "Só conversa interna". */
export function botLinesText(lineIds: unknown) {
  let list: unknown = lineIds;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = null;
    }
  }
  if (list === null || list === undefined) return "Todas as linhas";
  if (!Array.isArray(list) || !list.length) return "Só conversa interna";
  return list.length === 1 ? "1 linha" : `${list.length} linhas`;
}

export const BOT_CONTEXT_KEY = "wabotia:bot-context";
/** Contexto deixado por "Consultar bot" na conversa; lido uma única vez. */
export function takeBotContext(): Row | null {
  try {
    const raw = sessionStorage.getItem(BOT_CONTEXT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(BOT_CONTEXT_KEY);
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
export function peekBotContext() {
  try {
    return !!sessionStorage.getItem(BOT_CONTEXT_KEY);
  } catch {
    return false;
  }
}
