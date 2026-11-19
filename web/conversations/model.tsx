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
import { channelLabel, channelPresentation, conversationChannel } from "../channels";
import type { WindowState } from "../../src/channel-contracts";
import { channelWindowReason } from "../lib/window";
import { channelExtensionReason, channelUiFor, channelUiKey } from "../channel-extensions";

/** Detalhe novo pode projetar ChannelView no topo e/ou nas capacidades. */
export function channelConversation(detail: Row): Row {
  const conversation = { ...detail.conversation };
  for (const key of ["channel", "channel_context", "account_label", "multichannel", "window", "templates", "menu", "subject", "public_reply", "modules", "can_initiate", "channel_extension"])
    if (key in detail) conversation[key] = detail[key];
    else if (key in (detail.capabilities || {})) conversation[key] = detail.capabilities[key];
  if (detail.connection_kind) conversation.connection_kind = detail.connection_kind;
  conversation.capabilities = detail.capabilities || {};
  return conversation;
}

/** A tela só restringe permissões anunciadas; nunca concede a extensão humana. */
export function channelSendPolicy(
  conversation: Row,
  capabilities: Row = {},
  now = Date.now(),
  lineKinds?: Record<string, string>,
) {
  const source = { ...conversation, ...capabilities };
  const channel = conversationChannel(source, lineKinds);
  const legacy = channel === "whatsapp" && !("window" in source);
  const window = source.window as WindowState | null | undefined;
  const extensionKey = channelUiKey(source);
  const publicContext = extensionKey?.endsWith("/comment") || extensionKey?.endsWith("/review");
  const known = extensionKey ? !!channelUiFor(source)?.prepareAction && capabilities.text === true
    : channel === "whatsapp" || channel === "instagram" || channel === "facebook";
  const humanTextOnly = window?.state === "human_text_only";
  const deadline = humanTextOnly ? window?.humanTextClosesAt : window?.closesAt;
  const expired = window?.kind === "customer" &&
    (window.state === "closed" || !Number.isFinite(deadline) || Number(deadline) <= Math.max(now, window.serverNow));
  const hasWindow = legacy || window?.kind === "none" || (!!window && !expired);
  const text = known && hasWindow && (legacy ? capabilities.text !== false : capabilities.text === true) &&
    (legacy || window?.canHumanText === true);
  const automation = known && !publicContext && hasWindow && !humanTextOnly &&
    (legacy || window?.canAutomation === true);
  const media = text && !humanTextOnly &&
    ["image", "video", "audio", "voice", "document", "sticker"].some((key) => capabilities[key] === true);
  const effective: Row = { ...capabilities };
  if (!text || humanTextOnly) {
    for (const key of ["image", "video", "audio", "voice", "document", "sticker", "location", "contacts", "reply", "reaction", "edit", "delete", "mentions", "calls", "video_calls"])
      effective[key] = false;
  }
  // Citação, chamadas e formatos exclusivos de WhatsApp não são DMs sociais.
  if (channel !== "whatsapp" && !extensionKey)
    for (const key of ["reply", "location", "contacts", "sticker", "mentions", "calls", "video_calls"])
      effective[key] = false;
  if (channel !== "whatsapp")
    for (const key of ["mentions", "calls", "video_calls", "groups", "group_manage"])
      effective[key] = false;
  effective.text = text;
  const reason = !known
    ? "Canal indisponível para envio."
    : !hasWindow || !text
      ? (extensionKey && channelExtensionReason(window?.reason)) || channelWindowReason(expired && window?.state !== "closed" ? "window_closed" : window?.reason) || "Janela fechada. Aguarde uma nova mensagem do cliente."
      : humanTextOnly
        ? "Até 7 dias, somente texto escrito por uma pessoa. Anexos e respostas automáticas estão bloqueados."
        : null;
  return { channel, legacy, text, media, automation,
    modules: channel === "whatsapp" && capabilities.modules !== false,
    humanTextOnly, reason, capabilities: effective };
}

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
  const state = headerStateSubtitle(c, app);
  const presentation = channelPresentation(c, app.status, app.lineKinds);
  return presentation.multichannel && presentation.subtitle
    ? `${state} · ${presentation.subtitle}` : state;
}

function headerStateSubtitle(c: Row, app: AppState) {
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
  const channel = conversationChannel(c);
  const who = channel === "whatsapp" ? c.phone || c.external_id || "Cliente"
    : channel ? "do " + channelLabel(channel) : "Cliente";
  return asked ? `Cliente ${who} perguntou: ${asked}` : `Cliente ${who}.`;
}

export const WAIT_WARN_MS = 5 * 60_000;
