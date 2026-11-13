import React, { useEffect, useSyncExternalStore } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  MessageCircle,
  RotateCw,
  X,
} from "lucide-react";

/** Estado vazio: ícone em círculo, título e uma linha. */
export function Empty({
  icon,
  title = "Tudo pronto para começar",
  description = "Os registros aparecerão aqui quando seu atendimento começar.",
  action,
  compact,
}: {
  icon?: React.ReactNode;
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={"empty" + (compact ? " compact" : "")}>
      <span className="empty-icon">{icon || <MessageCircle size={28} />}</span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label, size = 18 }: { label?: string; size?: number }) {
  return (
    <span className="spinner" role="status">
      <Loader2 className="spin" size={size} aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

/** Esqueleto de lista (linhas cinza pulsando) para o primeiro carregamento. */
export function SkeletonRows({
  rows = 6,
  avatar = true,
}: {
  rows?: number;
  avatar?: boolean;
}) {
  return (
    <div className="skeleton-list" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          {avatar && <span className="skeleton circle" />}
          <div>
            <span className="skeleton line" style={{ width: 38 + ((index * 17) % 30) + "%" }} />
            <span className="skeleton line small" style={{ width: 60 + ((index * 11) % 30) + "%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div className="skeleton block" style={{ height }} aria-hidden />;
}

/** Aviso dentro da página: erro legível com "Tentar de novo", ou informação. */
export function Notice({
  tone = "info",
  children,
  onRetry,
  onClose,
  retryLabel = "Tentar de novo",
  busy,
}: {
  tone?: "info" | "error" | "warn" | "ok";
  children: React.ReactNode;
  onRetry?: () => void;
  onClose?: () => void;
  retryLabel?: string;
  busy?: boolean;
}) {
  const Icon =
    tone === "error" || tone === "warn"
      ? AlertCircle
      : tone === "ok"
        ? CheckCircle2
        : Info;
  return (
    <div
      className={"notice" + (tone === "info" ? "" : " " + tone)}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon size={17} aria-hidden />
      <span className="notice-text">{children}</span>
      {onRetry && (
        <button type="button" className="notice-action" onClick={onRetry} disabled={busy}>
          <RotateCw size={14} className={busy ? "spin" : ""} /> {retryLabel}
        </button>
      )}
      {onClose && (
        <button type="button" className="notice-close" aria-label="Fechar aviso" onClick={onClose}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

// --- avisos curtos (toasts) -------------------------------------------------
export type Toast = {
  id: number;
  tone: "ok" | "error" | "info";
  text: string;
  action?: { label: string; run: () => void };
};
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function dismiss(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}
/** Mostra um aviso curto; erros ficam mais tempo e podem trazer uma ação. */
export function toast(
  text: string,
  options: { tone?: Toast["tone"]; action?: Toast["action"]; ms?: number } = {},
) {
  const item: Toast = {
    id: nextId++,
    tone: options.tone || "ok",
    text,
    action: options.action,
  };
  toasts = [...toasts.slice(-3), item];
  emit();
  const ms = options.ms ?? (item.tone === "error" ? 8000 : 3500);
  if (ms > 0) setTimeout(() => dismiss(item.id), ms);
  return item.id;
}
export const toastError = (error: any, retry?: () => void) =>
  toast(error?.message || String(error || "Não foi possível concluir."), {
    tone: "error",
    action: retry ? { label: "Tentar de novo", run: retry } : undefined,
  });

export function ToastHost() {
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => toasts,
  );
  useEffect(() => () => void (toasts = []), []);
  return (
    <div className="toast-host" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={"toast " + item.tone}
          role={item.tone === "error" ? "alert" : "status"}
        >
          {item.tone === "error" ? (
            <AlertCircle size={17} aria-hidden />
          ) : item.tone === "ok" ? (
            <CheckCircle2 size={17} aria-hidden />
          ) : (
            <Info size={17} aria-hidden />
          )}
          <span>{item.text}</span>
          {item.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismiss(item.id);
                item.action!.run();
              }}
            >
              {item.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Fechar aviso"
            onClick={() => dismiss(item.id)}
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
