// Peças de conversa compartilhadas pelo WhatsApp e pelo chat interno:
// fundo, bolhas com rabinho, ticks, chips de data e de evento, campo que cresce.
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Lock,
} from "lucide-react";
import { time } from "../lib/format";

const tickLabels: Record<string, string> = {
  pending: "Na fila",
  sending: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  played: "Ouvida",
  failed: "Falhou",
  unknown: "Sem confirmação",
  cancelled: "Cancelada",
};
export const deliveryLabel = (status: string) => tickLabels[status] || status;

/** Ticks de entrega: relógio, ✓, ✓✓, ✓✓ azul, ! vermelho. */
export function Ticks({ status, size = 16 }: { status?: string | null; size?: number }) {
  if (!status) return null;
  const label = deliveryLabel(status);
  const Icon =
    status === "failed"
      ? AlertCircle
      : status === "cancelled"
        ? Ban
        : status === "sent"
          ? Check
          : ["delivered", "read", "played"].includes(status)
            ? CheckCheck
            : Clock;
  return (
    <span className={"ticks " + status} role="img" aria-label={label} title={label}>
      <Icon size={status === "failed" || Icon === Clock ? size - 3 : size} strokeWidth={2.2} />
    </span>
  );
}

export function DayChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="chat-chip day" role="separator">
      <span>{children}</span>
    </div>
  );
}
/** Evento do atendimento (assumida, transferida, protocolo aberto…). */
export function EventChip({
  icon,
  children,
  tone,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: "danger" | "warn";
}) {
  return (
    <div className={"chat-chip event" + (tone ? " " + tone : "")} role="status">
      <span>
        {icon}
        {children}
      </span>
    </div>
  );
}

/**
 * Bolha de mensagem. `side`: "in" (recebida, esquerda), "out" (enviada,
 * direita) ou "note" (nota interna amarela, direita). `tail` desenha o
 * rabinho na primeira bolha de cada grupo.
 */
export const Bubble = React.forwardRef<
  HTMLDivElement,
  {
    side: "in" | "out" | "note";
    tail?: boolean;
    /** Rótulo pequeno no topo (bot, atendente, participante do grupo). */
    label?: React.ReactNode;
    labelTone?: "bot" | "brand" | "note" | "author";
    at?: number;
    status?: string | null;
    edited?: boolean;
    /** Conteúdo sem preenchimento (imagem de borda a borda). */
    media?: boolean;
    reactions?: React.ReactNode;
    /** Botões que aparecem ao passar o mouse (reagir, ações). */
    tools?: React.ReactNode;
    highlighted?: boolean;
    children: React.ReactNode;
    onContextMenu?: (event: React.MouseEvent) => void;
    id?: string;
    meta?: React.ReactNode;
  }
>(function Bubble(
  {
    side,
    tail,
    label,
    labelTone,
    at,
    status,
    edited,
    media,
    reactions,
    tools,
    highlighted,
    children,
    onContextMenu,
    id,
    meta,
  },
  ref,
) {
  return (
    <div
      ref={ref}
      id={id}
      className={
        "bubble-row " +
        side +
        (tail ? " tail" : "") +
        (reactions ? " has-reactions" : "") +
        (highlighted ? " highlighted" : "")
      }
    >
      <div
        className={"bubble" + (media ? " media" : "")}
        onContextMenu={onContextMenu}
      >
        {side === "note" && !label && (
          <span className="bubble-label note">
            <Lock size={11} /> Nota interna
          </span>
        )}
        {label && (
          <span className={"bubble-label " + (labelTone || "author")}>{label}</span>
        )}
        {children}
        <span className="bubble-meta">
          {meta}
          {edited && <span>Editada</span>}
          {at ? <time dateTime={new Date(at).toISOString()}>{time(at)}</time> : null}
          {side === "out" && <Ticks status={status} />}
        </span>
        {reactions && <span className="bubble-reactions">{reactions}</span>}
      </div>
      {tools && <div className="bubble-tools">{tools}</div>}
    </div>
  );
});

export type ChatScrollHandle = {
  toBottom: (smooth?: boolean) => void;
  element: () => HTMLDivElement | null;
};

/**
 * Área rolável das mensagens. Fica no fim enquanto a pessoa está no fim;
 * se ela rolou para cima, mensagens novas não roubam a rolagem e aparece o
 * botão "ir para o fim" com contador. `resetKey` muda ao trocar de conversa.
 */
export const ChatScroll = React.forwardRef<
  ChatScrollHandle,
  {
    resetKey: string;
    count: number;
    children: React.ReactNode;
    label?: string;
    className?: string;
  }
>(function ChatScroll(
  { resetKey, count, children, label = "Mensagens", className = "" },
  ref,
) {
  const box = useRef<HTMLDivElement>(null),
    inner = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true),
    lastCount = useRef(count),
    lastKey = useRef(resetKey);
  const [away, setAway] = useState(false),
    [fresh, setFresh] = useState(0);
  const toBottom = useCallback((smooth = false) => {
    const element = box.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    atBottom.current = true;
    setAway(false);
    setFresh(0);
  }, []);
  useImperativeHandle(ref, () => ({ toBottom, element: () => box.current }), [
    toBottom,
  ]);
  useLayoutEffect(() => {
    if (lastKey.current !== resetKey) {
      lastKey.current = resetKey;
      lastCount.current = count;
      atBottom.current = true;
      toBottom();
      return;
    }
    if (count > lastCount.current) {
      if (atBottom.current) toBottom();
      else setFresh((value) => value + (count - lastCount.current));
    }
    lastCount.current = count;
  }, [resetKey, count, toBottom]);
  useLayoutEffect(() => {
    toBottom();
  }, []);
  // Imagens e áudios mudam a altura depois de carregar: continua no fim.
  useEffect(() => {
    if (!inner.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && box.current)
        box.current.scrollTop = box.current.scrollHeight;
    });
    observer.observe(inner.current);
    // O rodapé muda de altura (composer, anexos): a caixa encolhe também.
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={"chat-scroll-wrap " + className}>
      <div
        className="chat-scroll"
        ref={box}
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={() => {
          const element = box.current!;
          const bottom =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          atBottom.current = bottom;
          setAway(!bottom);
          if (bottom) setFresh(0);
        }}
      >
        <div className="chat-scroll-inner" ref={inner}>
          {children}
        </div>
      </div>
      {away && (
        <button
          type="button"
          className="chat-to-bottom"
          aria-label={
            fresh
              ? `Ir para o fim, ${fresh} ${fresh === 1 ? "mensagem nova" : "mensagens novas"}`
              : "Ir para o fim"
          }
          onClick={() => toBottom(true)}
        >
          {fresh > 0 && <b className="count-badge">{fresh > 99 ? "99+" : fresh}</b>}
          <ChevronDown size={22} />
        </button>
      )}
    </div>
  );
});

/**
 * Campo de mensagem que cresce com o texto. Enter envia; Shift+Enter quebra
 * linha (web/DESIGN.md §4).
 */
export const MessageInput = React.forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    placeholder?: string;
    disabled?: boolean;
    maxLength?: number;
    label?: string;
    onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  }
>(function MessageInput(
  {
    value,
    onChange,
    onSend,
    placeholder = "Mensagem",
    disabled,
    maxLength,
    label,
    onPaste,
    onKeyDown,
  },
  ref,
) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = Math.min(element.scrollHeight, 148) + "px";
  }, [value]);
  return (
    <textarea
      ref={(element) => {
        area.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      className="message-input"
      rows={1}
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      aria-label={label || placeholder}
      placeholder={placeholder}
      onPaste={onPaste}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          onSend();
        }
      }}
    />
  );
});
