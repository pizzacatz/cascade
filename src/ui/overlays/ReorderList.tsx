import { useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

/**
 * A selectable list for settings panes whose rows can be reordered by
 * dragging (mouse events, so it behaves the same in WebKitGTK) or with
 * Alt+↑/↓. ↑/↓ move the selection.
 */
export function ReorderList<T extends { id: string }>({
  items,
  selectedId,
  onSelect,
  onPlace,
  onMove,
  canReorder = () => true,
  render,
  label,
}: {
  items: T[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Move `id` so it lands before the item currently at `index` (items.length = end). */
  onPlace: (id: string, index: number) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  canReorder?: (item: T) => boolean;
  render: (item: T) => ReactNode;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);

  const indexAt = (y: number): number => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-reorder-row]") ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  const startDrag = (e: React.MouseEvent, item: T) => {
    if (e.button !== 0 || !canReorder(item)) return;
    const startY = e.clientY;
    let active = false;
    let index = -1;
    const onMoveEv = (ev: MouseEvent) => {
      if (!active && Math.abs(ev.clientY - startY) < 4) return;
      active = true;
      index = indexAt(ev.clientY);
      setDrag({ id: item.id, index });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMoveEv);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey, true);
      setDrag(null);
      if (active && index >= 0) onPlace(item.id, index);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      ev.preventDefault();
      active = false;
      onUp();
    };
    window.addEventListener("mousemove", onMoveEv);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey, true);
  };

  const onKeyDown = (e: React.KeyboardEvent, item: T, i: number) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey) {
      if (canReorder(item)) onMove(item.id, delta);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-reorder-row="${item.id}"]`)?.focus());
      return;
    }
    const next = items[i + delta];
    if (!next) return;
    onSelect(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-reorder-row="${next.id}"]`)?.focus();
  };

  return (
    <div className={`reorder-list ${drag ? "is-dragging" : ""}`} ref={listRef} role="listbox" aria-label={label}>
      {items.map((item, i) => (
        <div
          key={item.id}
          data-reorder-row={item.id}
          role="option"
          tabIndex={0}
          aria-selected={item.id === selectedId}
          className={`rule-row reorder-row ${item.id === selectedId ? "is-active" : ""} ${drag?.id === item.id ? "is-drag-source" : ""} ${
            drag && drag.index === i ? "drop-before" : ""
          } ${drag && drag.index === items.length && i === items.length - 1 ? "drop-after" : ""}`}
          onMouseDown={(e) => {
            onSelect(item.id);
            startDrag(e, item);
          }}
          onFocus={() => item.id !== selectedId && onSelect(item.id)}
          onKeyDown={(e) => onKeyDown(e, item, i)}
          title={canReorder(item) ? "Drag to reorder (or Alt+↑/↓)" : undefined}
        >
          <span className={`reorder-grip ${canReorder(item) ? "" : "is-hidden"}`} aria-hidden>
            <GripVertical size={13} />
          </span>
          {render(item)}
        </div>
      ))}
    </div>
  );
}
