// Balão pequeno ancorado em um botão (reações, emojis). Fecha com Esc, clique
// fora ou rolagem; fica dentro da janela.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Popover({
  anchor,
  onClose,
  label,
  children,
  className = "",
  placement = "top",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  className?: string;
  placement?: "top" | "bottom";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect(),
      target = anchor?.getBoundingClientRect();
    if (!box || !target) return;
    let left = target.left + target.width / 2 - box.width / 2,
      top =
        placement === "top" ? target.top - box.height - 8 : target.bottom + 8;
    if (top < 8) top = target.bottom + 8;
    if (top + box.height > window.innerHeight - 8)
      top = Math.max(8, target.top - box.height - 8);
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    setPosition({ left, top });
  }, [anchor, placement]);
  // O foco só entra depois de posicionado: enquanto está oculto o navegador
  // recusa o foco.
  const placed = !!position;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, [placed]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const away = (event: MouseEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !anchor?.contains(event.target as Node)
      )
        onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const scroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", scroll, true);
      previous?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      className={"popover " + className}
      role="dialog"
      aria-label={label}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
