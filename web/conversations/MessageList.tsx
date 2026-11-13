// Mensagens da conversa: bolhas agrupadas por autor, chips de data e de
// evento, citação, reações, mídia e as ações de cada mensagem.
import React, { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCheck,
  ChevronDown,
  Clock,
  Copy,
  Lock,
  Pencil,
  Reply,
  Smile,
  Trash2,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { avatarIndex, dayDiff, dayLabel, parse } from "../lib/format";
import { Confirm, MenuList, toast, type MenuAction } from "../ui";
import { Bubble, DayChip, EventChip, deliveryLabel } from "../ui/chat";
import {
  ContactCard,
  LocationCard,
  MessageMedia,
  isImage,
} from "./Media";
import { Popover } from "./Popover";
import { outboundAuthor } from "./model";

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const EDIT_WINDOW_MS = 15 * 60_000;

export type SessionEvent = { id: string; at: number; text: string };
export type Optimistic = { text: string; attachments: number; at: number };

/** Endereços http(s) no texto viram links que abrem em nova aba. */
function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let last = 0,
    match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    // Pontuação no fim da frase não faz parte do endereço.
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noreferrer noopener">
        {url}
      </a>,
    );
    last = match.index + url.length;
    pattern.lastIndex = last;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

type Tools = {
  own: boolean;
  capabilities: Row;
  busy: boolean;
  onReply: (message: Row) => void;
  onEdit: (message: Row) => void;
  onAct: (action: string, body: Row) => void;
  onOpenImage: (id: string) => void;
  onSaveContact: (contact: Row) => void;
};

function quoteOf(message: Row, content: Row, messages: Row[], app: ReturnType<typeof useApp>, customer: string) {
  if (!content.reply_to && !content.reply_external_id) return null;
  const original = messages.find(
    (item) =>
      (content.reply_to && item.id === content.reply_to) ||
      (content.reply_external_id && item.external_id === content.reply_external_id),
  );
  const originalContent = original ? parse(original.content) : {};
  const author = !original
    ? ""
    : original.direction === "customer"
      ? originalContent.participant_name || customer
      : original.author === app.me.id
        ? "Você"
        : outboundAuthor(original.author, app).label || "Equipe";
  return {
    id: original?.id as string | undefined,
    author,
    text:
      content.reply_text ||
      original?.text ||
      (original && parse(original.attachments, []).length ? "Anexo" : "") ||
      "Mensagem citada",
  };
}

function MessageBubble({
  message,
  messages,
  media,
  tail,
  group,
  customer,
  root,
  tools,
  highlighted,
  onJump,
}: {
  message: Row;
  messages: Row[];
  media: Row[];
  tail: boolean;
  group: boolean;
  customer: string;
  root: string;
  tools: Tools;
  highlighted: boolean;
  onJump: (id: string) => void;
}) {
  const app = useApp();
  const content = parse(message.content);
  const attachments: string[] = content.deleted ? [] : parse(message.attachments, []);
  const side =
    message.direction === "customer" ? "in" : message.direction === "note" ? "note" : "out";
  const author = side === "out" ? outboundAuthor(message.author, app) : null;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reactButton = useRef<HTMLButtonElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);

  const files = attachments.map(
    (id) =>
      media.find((file) => file.id === id) || {
        id,
        type: "application/octet-stream",
        name: "Baixar anexo",
        size: 0,
      },
  );
  const onlyMedia =
    files.length > 0 &&
    files.every((file) => isImage(file.type) || String(file.type).startsWith("video/"));
  const quote = quoteOf(message, content, messages, app, customer);
  const reactions = Object.entries(content.reactions || {}).filter(
    ([, reaction]: any) => reaction?.emoji,
  ) as [string, Row][];
  const mineReaction = (content.reactions || {})[app.me.id]?.emoji || "";
  const receipts = content.receipts ? Object.values(content.receipts as Row) : null;

  // Regras iguais às do painel anterior: só em conversa minha, mensagem do
  // canal (com id externo), não apagada, e conforme as capacidades da linha.
  const channel =
    !!message.external_id && message.direction !== "note" && !content.deleted && tools.own;
  const cap = tools.capabilities;
  const canReply = channel && !!cap.reply,
    canReact = channel && !!cap.reaction,
    canEdit =
      channel &&
      !!cap.edit &&
      message.direction === "outbound" &&
      app.now - message.created < EDIT_WINDOW_MS &&
      Date.now() - message.created < EDIT_WINDOW_MS &&
      attachments.length === 0,
    canDelete = channel && !!cap.delete && message.direction === "outbound",
    canRead = channel && !!cap.read && message.direction === "customer";
  const text = content.deleted ? "" : String(message.text || "");
  const items: MenuAction[] = [
    {
      label: "Responder",
      icon: <Reply size={17} />,
      hidden: !canReply,
      onSelect: () => tools.onReply(message),
    },
    {
      label: "Copiar",
      icon: <Copy size={17} />,
      hidden: !text,
      onSelect: () =>
        navigator.clipboard
          .writeText(text)
          .then(() => toast("Texto copiado."))
          .catch(() => toast("Não foi possível copiar.", { tone: "error" })),
    },
    {
      label: "Editar",
      icon: <Pencil size={17} />,
      hidden: !canEdit,
      onSelect: () => tools.onEdit(message),
    },
    {
      label: "Marcar como lida",
      icon: <CheckCheck size={17} />,
      hidden: !canRead,
      disabled: tools.busy,
      onSelect: () => tools.onAct("read", { message_id: message.id }),
    },
    {
      label: "Apagar",
      icon: <Trash2 size={17} />,
      hidden: !canDelete,
      danger: true,
      separator: true,
      disabled: tools.busy,
      onSelect: () => setConfirmDelete(true),
    },
  ];
  const hasMenu = items.some((item) => !item.hidden);

  const label =
    side === "note" ? (
      <>
        <Lock size={11} /> Nota interna
        {message.author !== app.me.id && app.names[message.author]
          ? " · " + app.names[message.author]
          : ""}
      </>
    ) : side === "in" && group ? (
      tail ? (
        content.participant_name || content.participant || "Participante"
      ) : undefined
    ) : author && !author.mine && tail ? (
      author.tone === "bot" ? (
        <>
          <Bot size={12} /> {author.label}
        </>
      ) : (
        author.label
      )
    ) : undefined;

  return (
    <>
      <Bubble
        id={"message-" + message.id}
        side={side}
        tail={tail}
        label={label}
        labelTone={
          side === "note"
            ? "note"
            : side === "in"
              ? (("author c" +
                  avatarIndex(
                    String(content.participant || content.participant_name || "?"),
                  )) as any)
              : author?.tone
        }
        at={message.created}
        status={side === "out" ? message.delivery_status || undefined : undefined}
        edited={!!content.edited}
        media={onlyMedia && !quote}
        highlighted={highlighted}
        onContextMenu={
          hasMenu
            ? (event) => {
                // Mantém o menu do navegador sobre links e seleção de texto.
                if ((event.target as HTMLElement).closest("a") || window.getSelection()?.toString())
                  return;
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        reactions={
          reactions.length ? (
            <span
              title={reactions
                .map(([who, reaction]) =>
                  `${reaction.emoji} ${who === app.me.id ? "Você" : app.names[who] || (who === "customer" || who.startsWith("customer") ? customer : who)}`,
                )
                .join("\n")}
            >
              {Array.from(new Set(reactions.map(([, reaction]) => reaction.emoji))).join(" ")}
              {reactions.length > 1 && <small> {reactions.length}</small>}
            </span>
          ) : undefined
        }
        tools={
          canReact || hasMenu ? (
            <>
              {canReact && (
                <button
                  type="button"
                  ref={reactButton}
                  aria-label="Reagir à mensagem"
                  title="Reagir"
                  aria-expanded={picker}
                  onClick={() => setPicker(!picker)}
                >
                  <Smile size={16} />
                </button>
              )}
              {hasMenu && (
                <button
                  type="button"
                  ref={menuButton}
                  aria-label="Ações da mensagem"
                  title="Ações"
                  aria-haspopup="menu"
                  aria-expanded={!!menu}
                  onClick={() => {
                    const box = menuButton.current!.getBoundingClientRect();
                    setMenu(menu ? null : { x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <ChevronDown size={17} />
                </button>
              )}
            </>
          ) : undefined
        }
        meta={
          receipts ? (
            <span className="bubble-receipts">
              {receipts.filter((receipt: any) => ["read", "played"].includes(receipt.status)).length}{" "}
              leram · {receipts.length} receberam
            </span>
          ) : undefined
        }
      >
        {quote && (
          <button
            type="button"
            className="bubble-quote"
            disabled={!quote.id}
            onClick={() => quote.id && onJump(quote.id)}
            aria-label={"Ir para a mensagem citada: " + quote.text.slice(0, 80)}
          >
            {quote.author && <strong>{quote.author}</strong>}
            <span>{quote.text}</span>
          </button>
        )}
        {files.map((file) => (
          <MessageMedia
            key={file.id}
            file={file}
            root={root}
            onOpenImage={tools.onOpenImage}
            sticker={content.type === "sticker"}
          />
        ))}
        {content.location && !content.deleted && <LocationCard location={content.location} />}
        {!content.deleted &&
          (content.contacts || []).map((contact: Row, index: number) => (
            <ContactCard key={index} contact={contact} onSave={tools.onSaveContact} />
          ))}
        {content.deleted ? (
          <p className="bubble-deleted">
            <Ban size={14} /> Mensagem apagada
          </p>
        ) : (
          text && <p>{linkify(text)}</p>
        )}
        {side === "out" && message.delivery_status === "failed" && (
          <span className="bubble-failed" role="status">
            <AlertCircle size={13} /> Não foi entregue
            {content.error ? " · " + String(content.error) : ""}
          </span>
        )}
      </Bubble>
      {picker && (
        <Popover
          anchor={reactButton.current}
          label="Reações"
          className="reaction-picker"
          onClose={() => setPicker(false)}
        >
          {REACTIONS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              disabled={tools.busy}
              aria-label={"Reagir com " + emoji}
              aria-pressed={mineReaction === emoji}
              onClick={() => {
                setPicker(false);
                tools.onAct("reaction", { message_id: message.id, emoji });
              }}
            >
              {emoji}
            </button>
          ))}
          {mineReaction && (
            <button
              type="button"
              className="reaction-remove"
              disabled={tools.busy}
              onClick={() => {
                setPicker(false);
                tools.onAct("reaction", { message_id: message.id, emoji: "" });
              }}
            >
              Remover
            </button>
          )}
        </Popover>
      )}
      {menu && (
        <MenuList
          items={items}
          at={menu}
          label="Ações da mensagem"
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDelete && (
        <Confirm
          title="Apagar mensagem"
          confirmLabel="Apagar"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            tools.onAct("delete", { message_id: message.id });
          }}
        >
          <p>Apagar esta mensagem também no WhatsApp?</p>
        </Confirm>
      )}
    </>
  );
}

type Item =
  | { kind: "day"; key: string; at: number }
  | { kind: "event"; key: string; event: SessionEvent }
  | { kind: "message"; key: string; message: Row; tail: boolean };

export function MessageList({
  detail,
  root,
  events,
  optimistic,
  tools,
  highlighted,
  onJump,
}: {
  detail: Row;
  root: string;
  events: SessionEvent[];
  optimistic: Record<string, Optimistic>;
  tools: Tools;
  highlighted: string | null;
  onJump: (id: string) => void;
}) {
  const app = useApp();
  const messages: Row[] = detail.messages || [];
  const conversation = detail.conversation;
  const group = conversation.chat_type === "group";
  const customer =
    detail.contact?.name || conversation.contact_name || conversation.title || "Cliente";

  const items = useMemo(() => {
    const merged: ({ at: number; message?: Row; event?: SessionEvent })[] = [
      ...messages.map((message) => ({ at: message.created as number, message })),
      ...events.map((event) => ({ at: event.at, event })),
    ].sort((a, b) => a.at - b.at);
    const list: Item[] = [];
    let previous: { at: number; key: string } | null = null;
    for (const entry of merged) {
      if (!previous || dayDiff(previous.at, entry.at) !== 0) {
        list.push({ kind: "day", key: "day-" + entry.at, at: entry.at });
        previous = { at: entry.at, key: "" };
      }
      if (entry.event) {
        list.push({ kind: "event", key: "event-" + entry.event.id, event: entry.event });
        previous = { at: entry.at, key: "" };
        continue;
      }
      const message = entry.message!;
      const content = parse(message.content);
      // Agrupa por autor: mesma direção, mesmo autor (ou participante).
      const key =
        message.direction +
        ":" +
        (message.direction === "customer"
          ? content.participant || content.participant_name || ""
          : message.author);
      list.push({
        kind: "message",
        key: message.id,
        message,
        tail: previous.key !== key || entry.at - previous.at > 10 * 60_000,
      });
      previous = { at: entry.at, key };
    }
    return list;
  }, [messages, events]);

  const pending: Row[] = (detail.deliveries || []).filter(
    (delivery: Row) => !["sent", "cancelled"].includes(delivery.status),
  );

  return (
    <>
      {!messages.length && !pending.length && (
        <EventChip>Ainda não há mensagens nesta conversa.</EventChip>
      )}
      {items.map((item) =>
        item.kind === "day" ? (
          <DayChip key={item.key}>{dayLabel(item.at, app.now)}</DayChip>
        ) : item.kind === "event" ? (
          <EventChip key={item.key}>{item.event.text}</EventChip>
        ) : (
          <MessageBubble
            key={item.key}
            message={item.message}
            messages={messages}
            media={detail.media || []}
            tail={item.tail}
            group={group}
            customer={customer}
            root={root}
            tools={tools}
            highlighted={highlighted === item.message.id}
            onJump={onJump}
          />
        ),
      )}
      {pending.map((delivery) => {
        const local = optimistic[delivery.id];
        const failed = delivery.status === "failed";
        return local ? (
          <Bubble
            key={"delivery-" + delivery.id}
            side="out"
            tail
            at={delivery.created}
            status={delivery.status}
          >
            <p>
              {local.text
                ? linkify(local.text)
                : local.attachments === 1
                  ? "Anexo"
                  : `${local.attachments} anexos`}
            </p>
            {delivery.error && (
              <span className="bubble-failed" role="status">
                <AlertCircle size={13} /> {delivery.error}
              </span>
            )}
          </Bubble>
        ) : (
          <div
            key={"delivery-" + delivery.id}
            className={"delivery-row" + (failed ? " failed" : "")}
            role="status"
          >
            <span>
              {failed ? <AlertCircle size={13} /> : <Clock size={13} />}
              {deliveryLabel(delivery.status)}
              {delivery.error ? " · " + delivery.error : failed ? "" : " · aguardando o canal"}
            </span>
          </div>
        );
      })}
    </>
  );
}
