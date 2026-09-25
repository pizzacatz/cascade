// Pointer-driven drag and drop (not HTML5 DnD, which is unreliable in
// WebKitGTK). Drop targets are found with elementFromPoint and data attributes:
//   [data-item-id][data-view]   an item row
//   [data-column-id]            empty area of a column
//   [data-day]                  empty area of a calendar day
//   [data-space-id]             a space in the sidebar

import type { Color, ItemType, ViewName } from "../model/types";
import { childPolicy, isContainerType, isEditableType } from "../model/types";
import { childrenOf, isAncestor, itemsOnDay, spaceOf } from "../model/tree";
import { nodesFromItems } from "../model/outline";
import { get, set, type DragState, type DropTarget, type PaletteDrag } from "../state/store";
import { indexOf, selectionOf } from "../state/derived";
import {
  addItem,
  addTag,
  canChangeType,
  changeType,
  insertOutline,
  moveItemsTo,
  scheduleItems,
  setColor,
} from "../state/items";
import { enterEdit, selectCalendarItem, selectColumnItem, selectColumnItems, switchSpace } from "../state/nav";

const THRESHOLD = 4;

export function startItemDrag(e: React.MouseEvent, itemId: string, view: ViewName): void {
  const s = get();
  const sel = selectionOf(s);
  const ids = sel.includes(itemId) && s.view.focusedView === view ? sel : [itemId];
  set({
    drag: {
      status: "pending",
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      ids,
      sourceView: view,
      palette: null,
      copy: e.ctrlKey,
      target: null,
    },
  });
}

export function startPaletteDrag(e: React.MouseEvent, palette: PaletteDrag): void {
  e.preventDefault();
  set({
    drag: {
      status: "pending",
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      ids: [],
      sourceView: get().view.focusedView,
      palette,
      copy: false,
      target: null,
    },
  });
}

function computeTarget(d: DragState, x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const s = get();
  const ix = indexOf(s.doc);
  const moving = new Set(d.ids);

  // Dragging items onto a toolbar chip applies it to them.
  const chip = el.closest<HTMLElement>("[data-chip]");
  if (chip) {
    if (d.palette || !d.ids.length) return null;
    const [kind, value] = chip.dataset.chip!.split(":");
    const c: PaletteDrag =
      kind === "type" ? { kind: "type", type: value as ItemType & "task" } : kind === "color" ? { kind: "color", color: value } : { kind: "tag", tagId: value };
    if (c.kind === "type" && !canChangeType(d.ids, c.type as ItemType, d.sourceView)) return null;
    return { kind: "chip", chip: c };
  }
  // A date in the calendar's day picker schedules onto that day.
  const pickerDay = el.closest<HTMLElement>("[data-day-picker]");
  if (pickerDay) {
    if (d.palette && d.palette.kind !== "type") return null;
    if (d.palette?.kind === "type" && isContainerType(d.palette.type as ItemType)) return null;
    return { kind: "day-end", date: pickerDay.dataset.dayPicker! };
  }
  const row = el.closest<HTMLElement>("[data-item-id]");
  if (row) {
    const itemId = row.dataset.itemId!;
    const view = (row.dataset.view as ViewName) ?? "columns";
    const it = ix.items[itemId];
    if (!it) return null;
    // Can't drop onto (or into) something being dragged.
    if (moving.has(itemId) || d.ids.some((id) => isAncestor(ix, id, itemId))) return null;
    if (d.palette && d.palette.kind !== "type") return { kind: "into", itemId };
    // Folders and templates can't live on the calendar.
    if (view === "calendar" && d.palette?.kind === "type" && isContainerType(d.palette.type as ItemType)) return null;
    const r = row.getBoundingClientRect();
    const rel = (y - r.top) / r.height;
    const canInto = view === "columns" && childPolicy(it.type) !== "blocked";
    // Top quarter: before; middle half: into; bottom quarter: after.
    if (canInto && rel >= 0.25 && rel <= 0.75) return { kind: "into", itemId };
    return { kind: rel < 0.5 ? "before" : "after", itemId, view };
  }
  const space = el.closest<HTMLElement>("[data-space-id]");
  if (space) {
    if (d.palette) return null;
    return { kind: "space", spaceId: space.dataset.spaceId! };
  }
  const col = el.closest<HTMLElement>("[data-column-id]");
  if (col) {
    const parentId = col.dataset.columnId!;
    if (d.ids.includes(parentId) || d.ids.some((id) => isAncestor(ix, id, parentId))) return null;
    if (d.palette && d.palette.kind !== "type") return null;
    return { kind: "column-end", parentId };
  }
  const day = el.closest<HTMLElement>("[data-day]");
  if (day) {
    if (d.palette && d.palette.kind !== "type") return null;
    if (d.palette?.kind === "type" && isContainerType(d.palette.type as ItemType)) return null;
    return { kind: "day-end", date: day.dataset.day! };
  }
  return null;
}

function onMove(e: MouseEvent) {
  const d = get().drag;
  if (!d) return;
  if (d.status === "pending") {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < THRESHOLD) return;
    if (get().edit) return; // text selection inside the editor, not a drag
  }
  set({
    drag: { ...d, status: "active", x: e.clientX, y: e.clientY, copy: e.ctrlKey, target: computeTarget(d, e.clientX, e.clientY) },
  });
}

let lastDropAt = 0;
/** True right after a drag ended, so the click that follows can be ignored. */
export const justDropped = () => Date.now() - lastDropAt < 80;

function onUp(e: MouseEvent) {
  const d = get().drag;
  if (!d) return;
  set({ drag: null });
  if (d.status !== "active") return;
  lastDropAt = Date.now();
  e.preventDefault();
  const target = computeTarget(d, e.clientX, e.clientY);
  if (target) performDrop({ ...d, copy: e.ctrlKey }, target);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && get().drag) {
    e.preventDefault();
    e.stopPropagation();
    set({ drag: null });
  } else if (e.key === "Control") {
    const d = get().drag;
    if (d?.status === "active") set({ drag: { ...d, copy: e.type === "keydown" } });
  }
}

export function installDragListeners(): () => void {
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  return () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
  };
}

// ---------------------------------------------------------------------------
// Drop semantics
// ---------------------------------------------------------------------------

type Place =
  | { view: "columns"; parentId: string; afterId?: string | null }
  | { view: "calendar"; date: string; afterId?: string | null };

function placeFor(target: DropTarget, excluding: string[]): Place | null {
  const s = get();
  const ix = indexOf(s.doc);
  const skip = new Set(excluding);
  switch (target.kind) {
    case "into":
      return { view: "columns", parentId: target.itemId };
    case "column-end":
      return { view: "columns", parentId: target.parentId };
    case "day-end":
      return { view: "calendar", date: target.date };
    case "space":
      return { view: "columns", parentId: target.spaceId };
    case "chip":
      return null;
    case "before":
    case "after": {
      const it = ix.items[target.itemId];
      if (!it) return null;
      if (target.view === "calendar" && it.scheduleDate) {
        const list = itemsOnDay(ix, it.scheduleDate).filter((x) => !skip.has(x.id));
        const i = list.findIndex((x) => x.id === it.id);
        const afterId = target.kind === "after" ? it.id : i > 0 ? list[i - 1].id : null;
        return { view: "calendar", date: it.scheduleDate, afterId };
      }
      if (!it.parentId) return null;
      const list = childrenOf(ix, it.parentId).filter((x) => !skip.has(x.id));
      const i = list.findIndex((x) => x.id === it.id);
      const afterId = target.kind === "after" ? it.id : i > 0 ? list[i - 1].id : null;
      return { view: "columns", parentId: it.parentId, afterId };
    }
  }
}

function performDrop(d: DragState, target: DropTarget) {
  const s = get();
  const ix = indexOf(s.doc);

  if (d.palette) {
    const p = d.palette;
    if (p.kind === "color" && target.kind === "into") return setColor(p.color as Color, targetIds(target.itemId));
    if (p.kind === "tag" && target.kind === "into") return addTag(p.tagId, targetIds(target.itemId));
    if (p.kind === "type") {
      const place = placeFor(target, []);
      if (!place) return;
      const id = addItem(p.type as ItemType, place, {}, false);
      if (id && isEditableType(p.type as ItemType)) enterEdit(id, "end");
    }
    return;
  }

  if (target.kind === "chip") {
    const ids = d.ids.filter((id) => ix.items[id]);
    const c = target.chip;
    if (c.kind === "type") changeType(c.type as ItemType, ids);
    else if (c.kind === "color") setColor(c.color as Color, ids);
    else addTag(c.tagId, ids);
    return;
  }

  const place = placeFor(target, d.copy ? [] : d.ids);
  if (!place) return;
  const ids = d.ids.filter((id) => ix.items[id]);
  if (!ids.length) return;

  if (d.copy) {
    const nodes = nodesFromItems(ix, ids.map((id) => ix.items[id]), true);
    insertOutline(nodes, place, "Duplicate");
    return;
  }

  if (place.view === "calendar") {
    const schedulable = ids.filter((id) => ix.items[id].type !== "separator");
    scheduleItems(schedulable, place.date, "Move", place.afterId);
    selectCalendarItem(schedulable[0]);
    return;
  }

  const moved = moveItemsTo(ids, place.parentId, { afterId: place.afterId });
  if (!moved) return;
  const nix = indexOf(get().doc);
  if (target.kind === "space") {
    if (target.spaceId !== "trash") switchSpace(target.spaceId);
    return;
  }
  const space = spaceOf(nix, ids[0]);
  if (space && space !== get().view.currentSpaceId) switchSpace(space);
  const parent = nix.items[place.parentId];
  if (target.kind === "into" && parent && isContainerType(parent.type)) selectColumnItem(parent.id);
  else selectColumnItems(ids);
}

/** Palette colour/tag drops apply to the whole selection when dropped on a selected item. */
function targetIds(itemId: string): string[] {
  const sel = selectionOf(get());
  return sel.includes(itemId) ? sel : [itemId];
}
