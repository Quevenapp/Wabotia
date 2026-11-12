// Chat interno (pessoas e bots da equipe) com as mesmas bolhas da conversa,
// sem janela de 24 h nem ticks do WhatsApp (web/DESIGN.md §7).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Lock, RotateCw, Send, Terminal } from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { useCompact } from "../app/hooks";
import { isFinalError, type Row } from "../lib/api";
import { dayDiff, dayLabel } from "../lib/format";
import { navigate } from "../lib/routes";
import {
  Avatar,
  Button,
  Empty,
  IconButton,
  Notice,
  Spinner,
} from "../ui";
import { Bubble, ChatScroll, DayChip, EventChip, MessageInput } from "../ui/chat";
import { internalRunStatus, rememberPreview } from "./shared";

export function InternalChat({
  chatId,
  onActivity,
}: {
  chatId: string;
  /** Mensagem enviada ou recebida: a lista de conversas recarrega. */
  onActivity: () => void;
}) {
  const app = useApp();
  const compact = useCompact();
  const [detail, setDetail] = useState<Row | null>(null),
    [loadError, setLoadError] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [, setRetry] = useState(0);
  const current = useRef(chatId);
  current.current = chatId;
  // Pedido ainda sem confirmação: repetir reutiliza a mesma chave e o mesmo corpo.
  const pending = useRef<{ path: string; body: Row; key: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const wanted = chatId;
    try {
      const next = await app.api(
        `${app.root}/internal-chats/${encodeURIComponent(chatId)}`,
      );
      if (current.current !== wanted) return;
      setDetail(next);
      setLoadError("");
      rememberPreview(app.profile, chatId, (next.messages || []).at(-1));
    } catch (e: any) {
      if (current.current === wanted) setLoadError(e.message);
    }
  }, [app.api, app.root, app.profile, chatId]);

  useEffect(() => {
    app.setOpenInternalChat(chatId);
    // Mensagens que chegaram com a aba em segundo plano contam como não
    // lidas até a pessoa voltar para esta conversa.
    const visible = () => !document.hidden && app.markInternalRead(chatId);
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      app.setOpenInternalChat(null);
    };
  }, [chatId, app.setOpenInternalChat, app.markInternalRead]);
  const waiting = (detail?.messages || []).some((message: Row) =>
    ["queued", "running", "starting"].includes(message.status),
  );
  useEffect(() => {
    void load();
    // Os eventos trazem as novidades; a consulta periódica é só garantia.
    const timer = setInterval(
      () => !document.hidden && void load(),
      waiting ? 2500 : 8000,
    );
    return () => clearInterval(timer);
  }, [load, waiting]);
  useAppEvents((events) => {
    if (
      events.some(
        (event) =>
          event.kind === "resync" ||
          event.kind.startsWith("bot.run.") ||
          (event.kind === "internal.message" &&
            event.payload?.chat_id === chatId),
      )
    ) {
      void load();
      app.markInternalRead(chatId);
    }
  });

  async function send() {
    if (!detail || busy || (!text.trim() && !pending.current)) return;
    if (app.demoBlocked()) return;
    setBusy(true);
    setError("");
    pending.current ||= {
      path: `${app.root}/internal-chats/${detail.id}/messages`,
      body: { text: text.trim() },
      key: crypto.randomUUID(),
    };
    try {
      const request = pending.current;
      await app.api(request.path, "POST", request.body, undefined, request.key);
      pending.current = null;
      setText("");
      await load();
      onActivity();
      input.current?.focus();
    } catch (e: any) {
      if (isFinalError(e)) pending.current = null;
      setError(e.message);
    } finally {
      setBusy(false);
      setRetry((n) => n + 1);
    }
  }

  const peer: Row | null = detail?.peer
    ? app.team.find((item) => item.id === detail.peer.id) || detail.peer
    : null;
  const isBot = peer?.kind === "bot";
  const unavailable =
    !!peer &&
    (!app.team.some((item) => item.id === peer.id) ||
      (isBot && peer.enabled === false));
  const messages: Row[] = detail?.messages || [];

  return (
    <>
      <header className="pane-header team-chat-header">
        {compact && (
          <IconButton
            label="Voltar"
            onClick={() => navigate({ area: "team", sub: "conversas" })}
          >
            <ArrowLeft size={20} />
          </IconButton>
        )}
        {peer ? (
          <>
            <Avatar
              name={peer.name}
              seed={peer.id}
              size={40}
              kind={isBot ? "bot" : "person"}
              online={!!peer.online}
            />
            <div className="team-chat-title">
              <h2 className="truncate">{peer.name}</h2>
              <small className="truncate">
                {isBot ? "Conversa com bot" : "Conversa entre pessoas"} ·{" "}
                {isBot
                  ? peer.online
                    ? "Disponível"
                    : "Indisponível"
                  : peer.online
                    ? "Online"
                    : "Offline"}
              </small>
            </div>
            {isBot && peer.bot_id && (
              <IconButton
                label="Abrir console do bot"
                onClick={() =>
                  navigate({ area: "team", sub: "bots", id: peer.bot_id })
                }
              >
                <Terminal size={19} />
              </IconButton>
            )}
          </>
        ) : (
          <h2>Conversa interna</h2>
        )}
      </header>
      {loadError && !detail ? (
        <div className="pane-scroll">
          <Empty
            title="Não foi possível abrir a conversa"
            description={loadError}
            action={<Button onClick={() => void load()}>Tentar de novo</Button>}
          />
        </div>
      ) : (
        <ChatScroll
          resetKey={chatId}
          count={messages.length}
          label="Mensagens internas"
        >
          <EventChip icon={<Lock size={12} />}>
            Esta conversa fica dentro do Wabotia. Nada aqui é enviado ao cliente
            no WhatsApp.
          </EventChip>
          {!detail && (
            <div className="team-chat-loading">
              <Spinner label="Abrindo conversa…" />
            </div>
          )}
          {detail && !messages.length && peer && (
            <EventChip>Inicie a conversa com {peer.name}.</EventChip>
          )}
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const mine = message.author === app.me.id;
            const newDay =
              !previous || dayDiff(previous.created, message.created) !== 0;
            const tail = newDay || previous?.author !== message.author;
            const status = internalRunStatus[message.status];
            const stopped = ["failed", "unknown", "cancelled"].includes(
              message.status,
            );
            return (
              <React.Fragment key={message.id}>
                {newDay && <DayChip>{dayLabel(message.created, app.now)}</DayChip>}
                <Bubble
                  side={mine ? "out" : "in"}
                  tail={tail}
                  at={message.created}
                  label={
                    !mine && isBot && tail ? (
                      <>
                        <Bot size={12} /> {peer?.name}
                      </>
                    ) : undefined
                  }
                  labelTone="bot"
                  meta={
                    status && !stopped ? (
                      <span className="team-run-status">{status}</span>
                    ) : undefined
                  }
                >
                  <p>{message.text}</p>
                </Bubble>
                {status && stopped && (
                  <EventChip tone={message.status === "failed" ? "danger" : "warn"}>
                    {status}
                  </EventChip>
                )}
              </React.Fragment>
            );
          })}
        </ChatScroll>
      )}
      <footer className="chat-footer">
        {error && (
          <div className="team-chat-notice">
            <Notice tone="error" onClose={() => setError("")}>
              {error}
            </Notice>
          </div>
        )}
        {unavailable ? (
          <div className="footer-card">
            <div>
              <strong>Contato indisponível</strong>
              <small>
                O histórico continua aqui, mas não é possível enviar novas
                mensagens para este contato.
              </small>
            </div>
          </div>
        ) : (
          <>
            {pending.current && !busy && (
              <p className="team-chat-pending" role="status">
                O envio ainda não foi confirmado. Tentar novamente reutiliza o
                mesmo pedido para evitar duplicação.
              </p>
            )}
            <div className="composer">
              <div className="composer-field">
                <MessageInput
                  ref={input}
                  value={pending.current ? pending.current.body.text : text}
                  onChange={setText}
                  onSend={() => void send()}
                  placeholder="Mensagem interna"
                  label="Mensagem interna"
                  maxLength={12000}
                  disabled={busy || !!pending.current || !detail}
                />
              </div>
              <button
                type="button"
                className="composer-send"
                aria-label={pending.current ? "Tentar novamente" : "Enviar"}
                title={pending.current ? "Tentar novamente" : "Enviar"}
                disabled={busy || !detail || (!text.trim() && !pending.current)}
                onClick={() => void send()}
              >
                {busy ? (
                  <RotateCw size={19} className="spin" />
                ) : pending.current ? (
                  <RotateCw size={19} />
                ) : (
                  <Send size={19} />
                )}
              </button>
            </div>
          </>
        )}
      </footer>
    </>
  );
}
