// Regras de exibição de uma conversa: responsável, estado, prévia e autores.
import React from "react";
import {
  Camera,
  FileText,
  List,
  Lock,
  MapPin,
  Mic,
  Sticker,
  User,
  Video,
} from "lucide-react";
import type { Row } from "../lib/api";
import { parse, span } from "../lib/format";
import type { AppState } from "../app/AppContext";

export const isMine = (c: Row, meId: string) =>
  c.state === "human" && !!c.owner && c.owner === meId;

export const tagsOf = (c: Row): string[] => {
  const tags = parse(c.tags, []);
  return Array.isArray(tags) ? tags.map(String) : [];
};

const firstName = (name: string) => String(name || "").split(/\s+/)[0] || name;

export function botName(c: Row, app: AppState) {
  const id = c.assigned_bot_id || app.settings.attendant_bot;
  return (id && (app.names["bot:" + id] || app.bots.find((b) => b.id === id)?.name)) || "";
}
export function departmentName(c: Row, app: AppState) {
  if (!c.department_id) return "";
  return (
    (app.settings.departments || []).find((d: Row) => d.id === c.department_id)
      ?.name || "Setor indisponível"
  );
}

/** Texto curto do responsável: "Com você", "Com Ana", "Bot Vendas", "Setor Financeiro". */
export function ownerText(c: Row, app: AppState) {
  if (c.state === "human")
    return isMine(c, app.me.id)
      ? "Com você"
      : "Com " + firstName(app.names[c.owner] || "atendente");
  if (c.state === "ai") {
    const name = botName(c, app);
    return name ? "Bot " + name : "Com o bot";
  }
  if (c.state === "waiting") {
    const department = departmentName(c, app);
    return department ? "Setor " + department : "Na fila";
  }
  return "Concluída";
}

/** Estado por extenso (prévia sem mensagem e subtítulo do cabeçalho). */
export function stateText(c: Row, app: AppState) {
  if (c.state === "waiting") return "Aguardando atendente";
  if (c.state === "ai") {
    const name = botName(c, app);
    return name ? `Em atendimento com o bot ${name}` : "Em atendimento com o bot";
  }
  if (c.state === "human")
    return isMine(c, app.me.id)
      ? "Em atendimento com você"
      : `Em atendimento com ${app.names[c.owner] || "outra pessoa"}`;
  return "Conversa concluída";
}

/** Subtítulo do cabeçalho: "Com você", "Na fila há 4 min", "Com Ana · Online". */
export function headerSubtitle(c: Row, app: AppState) {
  if (c.state === "waiting") {
    const department = departmentName(c, app);
    const wait = span(app.now - (c.updated || app.now));
    return (
      (wait === "agora" ? "Na fila" : "Na fila há " + wait) +
      (department ? " · " + department : "")
    );
  }
  if (c.state === "ai") {
    const name = botName(c, app);
    return name ? "Com o bot " + name : "Com o bot";
  }
  if (c.state === "human") {
    if (isMine(c, app.me.id)) return "Com você";
    const person = app.team.find((item) => item.id === c.owner);
    return (
      "Com " +
      (app.names[c.owner] || "outra pessoa") +
      (person ? (person.online ? " · Online" : " · Offline") : "")
    );
  }
  return "Concluída";
}

const kinds: Record<string, [typeof Camera, string]> = {
  image: [Camera, "Foto"],
  video: [Video, "Vídeo"],
  audio: [Mic, "Áudio"],
  document: [FileText, "Documento"],
  location: [MapPin, "Localização"],
  contacts: [User, "Contato"],
  sticker: [Sticker, "Figurinha"],
  interactive: [List, "Menu"],
};

/** Prévia da última mensagem: ícone + tipo para mídia, cadeado para nota. */
export function previewParts(c: Row, app: AppState) {
  const last = c.last_message as Row | null | undefined;
  if (!last)
    return { text: stateText(c, app), icon: null, note: false, ours: false, status: "", fallback: true };
  const kind = kinds[last.kind];
  const Icon = last.direction === "note" ? Lock : kind?.[0];
  const text =
    String(last.text || "").trim() ||
    kind?.[1] ||
    (last.attachments ? "Anexo" : "Mensagem");
  return {
    text,
    icon: Icon ? <Icon size={14} aria-hidden /> : null,
    note: last.direction === "note",
    ours: last.direction === "outbound",
    status: last.delivery_status || "",
    fallback: false,
  };
}

export type AuthorInfo = { label: string; tone: "bot" | "brand"; mine: boolean };
/** Autor de uma mensagem enviada: eu, colega, bot ou automático. */
export function outboundAuthor(author: string, app: AppState): AuthorInfo {
  if (author === app.me.id) return { label: "", tone: "brand", mine: true };
  if (String(author).startsWith("bot:"))
    return {
      label: app.names[author] || "Bot",
      tone: "bot",
      mine: false,
    };
  if (author === "system" || author === "ai")
    return { label: "Atendimento automático", tone: "bot", mine: false };
  const bot = app.bots.find((item) => item.id === author);
  if (bot) return { label: bot.name, tone: "bot", mine: false };
  return { label: app.names[author] || author || "Equipe", tone: "brand", mine: false };
}

/** Texto para "Consultar bot": o que o cliente perguntou por último. */
export function botContext(c: Row, messages: Row[]) {
  const asked = messages
    .filter((m) => m.direction === "customer" && String(m.text || "").trim())
    .slice(-3)
    .map((m) => String(m.text).trim())
    .join("\n");
  const who = c.phone || c.external_id || "Cliente";
  return asked ? `Cliente ${who} perguntou: ${asked}` : `Cliente ${who}.`;
}

export const WAIT_WARN_MS = 5 * 60_000;
