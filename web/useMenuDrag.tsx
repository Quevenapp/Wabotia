import React, { useEffect, useRef, useState } from "react";
import {
  menuListSnapshot,
  menuPath,
  moveMenu,
  type MenuItem,
} from "./menu-tree";

export type MenuMove = {
  sourceId: string;
  targetId: string | null;
  placement: "before" | "after" | "inside";
  snapshot: string;
};
type Destination = {
  targetId: string | null;
  placement: MenuMove["placement"];
  label: string;
  error?: string;
};
type Drag = {
  sourceId: string;
  label: string;
  snapshot: string;
  items: MenuItem[];
  pointerId: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  active: boolean;
  destination: Destination | null;
};

export function useMenuDrag(
  items: MenuItem[],
  scope: string,
  disabled: boolean,
  onMove: (move: MenuMove) => Promise<void>,
) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  function update(value: Drag | null) {
    current.current = value;
    setDrag(value);
  }
  function destinationAt(value: Drag): Destination | null {
    const hit = document.elementFromPoint(value.x, value.y);
    const row = hit?.closest<HTMLElement>("[data-menu-drag-row]");
    const root = hit?.closest<HTMLElement>("[data-menu-root-drop]");
    if (
      !container.current ||
      (!container.current.contains(row || null) &&
        !container.current.contains(root || null))
    )
      return null;
    let targetId: string | null = null,
      placement: MenuMove["placement"] = "inside",
      label = "No final do Menu principal";
    if (row) {
      targetId = row.dataset.menuDragRow!;
      const target = value.items.find((item) => item.id === targetId);
      if (!target) return null;
      const box = row.getBoundingClientRect(),
        ratio = (value.y - box.top) / box.height;
      placement =
        target.type === "submenu"
          ? ratio < 0.25
            ? "before"
            : ratio > 0.75
              ? "after"
              : "inside"
          : ratio < 0.5
            ? "before"
            : "after";
      label =
        placement === "inside"
          ? "Dentro de " + menuPath(value.items, targetId)
          : (placement === "before" ? "Antes de " : "Depois de ") +
            target.label +
            " · " +
            menuPath(value.items, target.parent_id);
    }
    try {
      moveMenu(value.items, value.sourceId, targetId, placement);
      return { targetId, placement, label };
    } catch (error: any) {
      return { targetId, placement, label, error: error.message };
    }
  }
  function updatePointer(x: number, y: number) {
    const previous = current.current;
    if (!previous) return;
    const next = {
      ...previous,
      x,
      y,
      active:
        previous.active ||
        Math.hypot(x - previous.startX, y - previous.startY) >= 5,
    };
    next.destination = next.active ? destinationAt(next) : null;
    update(next);
  }
  useEffect(() => {
    update(null);
  }, [scope, disabled]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current.current) {
        event.preventDefault();
        update(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("keydown", cancel);
      current.current = null;
    };
  }, []);
  useEffect(() => {
    if (!drag?.active) return;
    let frame: number;
    const scroll = () => {
      const value = current.current;
      if (!value?.active) return;
      if (
        value.x < 0 ||
        value.x > window.innerWidth ||
        value.y < 0 ||
        value.y > window.innerHeight
      ) {
        frame = requestAnimationFrame(scroll);
        return;
      }
      let parent: Element | null = container.current?.parentElement || null;
      while (
        parent &&
        !(
          parent.scrollHeight > parent.clientHeight &&
          /auto|scroll/.test(getComputedStyle(parent).overflowY)
        )
      )
        parent = parent.parentElement;
      const scroller = parent || document.scrollingElement;
      const box = parent
        ? parent.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const top = Math.max(0, box.top),
        bottom = Math.min(window.innerHeight, box.bottom);
      const amount =
        value.y < top + 52
          ? -Math.ceil((top + 52 - value.y) / 4)
          : value.y > bottom - 52
            ? Math.ceil((value.y - bottom + 52) / 4)
            : 0;
      if (amount && scroller) {
        scroller.scrollTop += Math.max(-18, Math.min(18, amount));
        updatePointer(value.x, value.y);
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [drag?.active]);
  function handle(
    item: MenuItem,
  ): React.ButtonHTMLAttributes<HTMLButtonElement> {
    return {
      type: "button",
      disabled,
      className: "menu-drag-handle",
      "aria-label": "Arrastar " + item.label,
      "aria-describedby": "menu-move-help",
      title:
        "Arraste para mover. Você também pode usar Subir, Descer ou Editar.",
      onPointerDown(event) {
        if (disabled || (event.pointerType === "mouse" && event.button !== 0))
          return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        update({
          sourceId: item.id,
          label: item.label,
          snapshot: menuListSnapshot(items),
          items,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          destination: null,
        });
      },
      onPointerMove(event) {
        if (current.current?.pointerId === event.pointerId)
          updatePointer(event.clientX, event.clientY);
      },
      onPointerUp(event) {
        const value = current.current;
        if (!value || value.pointerId !== event.pointerId) return;
        const destination = value.active
          ? destinationAt({ ...value, x: event.clientX, y: event.clientY })
          : null;
        update(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (destination && !destination.error)
          void onMove({
            sourceId: value.sourceId,
            targetId: destination.targetId,
            placement: destination.placement,
            snapshot: value.snapshot,
          });
      },
      onPointerCancel() {
        update(null);
      },
      onLostPointerCapture() {
        if (current.current) update(null);
      },
      onContextMenu(event) {
        event.preventDefault();
      },
    };
  }
  function marker(item: MenuItem) {
    if (!drag?.active) return null;
    const selected =
      drag.destination?.targetId === item.id ? drag.destination : null;
    return (
      <div
        className={
          "menu-drop-zones" + (item.type === "submenu" ? " has-inside" : "")
        }
        aria-hidden="true"
      >
        {(
          [
            "before",
            ...(item.type === "submenu" ? ["inside"] : []),
            "after",
          ] as MenuMove["placement"][]
        ).map((placement) => (
          <span
            key={placement}
            className={
              "menu-drop-zone " +
              placement +
              (selected?.placement === placement
                ? selected.error
                  ? " invalid"
                  : " chosen"
                : "")
            }
          >
            {placement === "before"
              ? "Antes de "
              : placement === "after"
                ? "Depois de "
                : "Dentro de "}
            {item.label}
          </span>
        ))}
      </div>
    );
  }
  const status = drag?.active ? (
    <div
      className={
        "menu-drag-status" + (drag.destination?.error ? " invalid" : "")
      }
      role="status"
    >
      <strong>Movendo {drag.label}</strong>
      <span>
        {drag.destination?.error ||
          drag.destination?.label ||
          "Arraste sobre um item ou sobre Menu principal."}
      </span>
      <small>Solte para salvar. Esc cancela.</small>
    </div>
  ) : null;
  return { container, drag, handle, marker, status };
}
