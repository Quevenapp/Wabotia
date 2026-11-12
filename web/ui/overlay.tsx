import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

/** Prende o foco dentro de `ref`, fecha com Esc e devolve o foco ao sair. */
function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
  initialFocus = true,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (item) => item.getClientRects().length,
      );
    if (initialFocus) {
      const preferred =
        element.querySelector<HTMLElement>("[data-autofocus]") ||
        focusable().find((item) => !item.hasAttribute("data-dialog-close")) ||
        element;
      preferred.focus();
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener("keydown", keyboard);
    return () => {
      element.removeEventListener("keydown", keyboard);
      previous?.focus?.();
    };
  }, []);
}

/**
 * Diálogo: título, corpo rolável e ações no rodapé (web/DESIGN.md §8).
 * `footer` fica fixo embaixo; formulários antigos podem usar `.modal-actions`.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "md",
  className = "",
  bare = false,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  /** Sem preenchimento no corpo (listas que vão de borda a borda). */
  bare?: boolean;
}) {
  const dialog = useRef<HTMLElement>(null);
  useFocusTrap(dialog, onClose);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className={`modal ${size} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Fechar"
            data-dialog-close
          >
            <X size={20} />
          </button>
        </header>
        <div className={"modal-body" + (bare ? " bare" : "")}>{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

/** Assinatura do painel antigo (`title`, `close`). */
export function Modal({
  title,
  children,
  close,
  size,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <Dialog title={title} onClose={close} size={size}>
      {children}
    </Dialog>
  );
}

/** Pergunta curta com duas ações. */
export function Confirm({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancelar",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={"button" + (danger ? " danger" : "")}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export type MenuAction = {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  /** Linha divisória antes deste item. */
  separator?: boolean;
  hint?: string;
};

/** Lista de menu posicionada em coordenadas da janela (menu ⋮ e clique direito). */
export function MenuList({
  items,
  at,
  onClose,
  label,
  align = "start",
}: {
  items: MenuAction[];
  at: { x: number; y: number };
  onClose: () => void;
  label: string;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const visible = items.filter((item) => !item.hidden);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    let left = align === "end" ? at.x - box.width : at.x,
      top = at.y;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    if (top + box.height > window.innerHeight - 8)
      top = Math.max(8, at.y - box.height - 8);
    setPosition({ left, top });
  }, [at.x, at.y, visible.length]);
  useFocusTrap(ref, onClose);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const scroll = () => onClose();
    document.addEventListener("mousedown", away, true);
    window.addEventListener("resize", scroll);
    window.addEventListener("blur", scroll);
    return () => {
      document.removeEventListener("mousedown", away, true);
      window.removeEventListener("resize", scroll);
      window.removeEventListener("blur", scroll);
    };
  }, []);
  if (!visible.length) return null;
  return createPortal(
    <div
      ref={ref}
      className="menu-list"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{
        left: position?.left ?? at.x,
        top: position?.top ?? at.y,
        opacity: position ? undefined : 0,
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ||
            [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }}
    >
      {visible.map((item, index) => (
        <React.Fragment key={item.label}>
          {item.separator && index > 0 && <hr />}
          <button
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}

/** Botão que abre um menu ancorado nele. */
export function MenuButton({
  items,
  label,
  children,
  className = "icon-button",
  align = "end",
  disabled,
}: {
  items: MenuAction[];
  label: string;
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!items.some((item) => !item.hidden)) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className + (at ? " active" : "")}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          const box = button.current!.getBoundingClientRect();
          setAt(
            at
              ? null
              : { x: align === "end" ? box.right : box.left, y: box.bottom + 4 },
          );
        }}
      >
        {children}
      </button>
      {at && (
        <MenuList
          items={items}
          at={at}
          align={align}
          label={label}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/**
 * Painel lateral. Em telas largas ocupa uma coluna; abaixo de 1100 px o CSS o
 * transforma em sobreposição com fundo escurecido (web/DESIGN.md §2).
 */
export function SidePanel({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.contains(document.activeElement)) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [onClose]);
  return (
    <>
      <button
        type="button"
        className="side-panel-backdrop"
        aria-label={"Fechar " + title}
        onClick={onClose}
      />
      <aside className={"side-panel " + className} aria-label={title} ref={ref}>
        <header className="pane-header">
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={20} />
          </button>
          <h2>{title}</h2>
        </header>
        <div className="side-panel-body">{children}</div>
      </aside>
    </>
  );
}
