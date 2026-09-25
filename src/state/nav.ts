// Selection, navigation and view operations. None of these touch the document
// (they are not undo steps); they only update view/UI state.

import type { Item, ViewName } from "../model/types";
import { isContainerType, isEditableType } from "../model/types";
import { ancestorFolders, childrenOf, itemsOnDay, pathTo, spaceOf, visibleSpaces } from "../model/tree";
import { addDays, diffDays } from "../model/dates";
import { get, set, setView, type AppState, type CreateTarget } from "./store";
import { indexOf, selectionOf, today } from "./derived";

export type Ctx =
  | "nofile"
  | "none"
  | "selection"
  | "edition"
  | "create-target"
  | "drag"
  | `overlay-${string}`;

export function context(s: AppState = get()): Ctx {
  if (s.overlay) return `overlay-${s.overlay.kind}`;
  if (!s.doc) return "nofile";
  if (s.drag?.status === "active") return "drag";
  if (s.edit) return "edition";
  if (selectionOf(s).length) return "selection";
  if (s.createTarget) return "create-target";
  return "none";
}

// ---------------------------------------------------------------------------
// Layout helpers shared with the UI
// ---------------------------------------------------------------------------

/** Number of calendar day columns currently on screen (set by the calendar view). */
let visibleDayCount = 3;
export function setVisibleDayCount(n: number) {
  visibleDayCount = Math.max(1, n);
}
export const getVisibleDayCount = () => visibleDayCount;

/** Column ids (space id first, then folders) for the columns view. */
export function columnIds(s: AppState = get()): string[] {
  const ix = indexOf(s.doc);
  const space = s.view.currentSpaceId;
  const lastPath = [...s.view.columnsPath].reverse().find((id) => ix.items[id] && isContainerType(ix.items[id].type));
  const chain = lastPath && spaceOf(ix, lastPath) === space ? pathTo(ix, lastPath) : [];
  const cols = [space, ...chain];
  const sel = s.view.columnsSelection.filter((id) => ix.items[id]);
  if (sel.length === 1) {
    const it = ix.items[sel[0]];
    if (isContainerType(it.type) && cols[cols.length - 1] !== it.id && it.parentId === cols[cols.length - 1]) {
      cols.push(it.id);
    }
  }
  const ct = s.createTarget;
  if (ct?.view === "columns" && !cols.includes(ct.parentId)) {
    const it = ix.items[ct.parentId];
    if (it && it.parentId === cols[cols.length - 1]) cols.push(ct.parentId);
  }
  return cols;
}

/** Days shown in the calendar strip, starting at the anchor date. */
export function calendarDays(s: AppState = get(), count = visibleDayCount): string[] {
  const anchor = s.view.calendarCurrentDate ?? today();
  return Array.from({ length: count }, (_, i) => addDays(anchor, i));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Leaving edit mode because the selection moved elsewhere must still commit
 * (or auto-remove) the edited item. items.ts registers exitEdit here to avoid a
 * circular import.
 */
let editExitHook: (() => void) | null = null;
export function setEditExitHook(fn: () => void) {
  editExitHook = fn;
}

function exitEditSilently(s: AppState): Partial<AppState> {
  if (!s.edit) return {};
  editExitHook?.();
  return { edit: null };
}

export function selectColumnItem(id: string): void {
  const s = get();
  const ix = indexOf(s.doc);
  const it = ix.items[id];
  if (!it) return;
  if (it.parentId === null) {
    // Calendar-only item: select it in the calendar instead.
    selectCalendarItem(id);
    return;
  }
  const space = spaceOf(ix, id) ?? s.view.currentSpaceId;
  set({
    ...exitEditSilently(s),
    createTarget: null,
    selectionAnchor: id,
    view: {
      ...s.view,
      focusedView: "columns",
      showColumnsView: true,
      columnsSelection: [id],
      columnsPath: ancestorFolders(ix, id),
      currentSpaceId: space,
    },
  });
}

export function selectColumnItems(ids: string[]): void {
  const s = get();
  const ix = indexOf(s.doc);
  const valid = ids.filter((id) => ix.items[id]?.parentId);
  if (!valid.length) return;
  const first = ix.items[valid[0]];
  const same = valid.filter((id) => ix.items[id].parentId === first.parentId);
  set({
    createTarget: null,
    view: {
      ...s.view,
      focusedView: "columns",
      showColumnsView: true,
      columnsSelection: same,
      columnsPath: ancestorFolders(ix, first.id),
      currentSpaceId: spaceOf(ix, first.id) ?? s.view.currentSpaceId,
    },
  });
}

export function toggleColumnSelection(id: string): void {
  const s = get();
  const ix = indexOf(s.doc);
  const it = ix.items[id];
  const sel = s.view.columnsSelection.filter((x) => ix.items[x]);
  if (!it || !sel.length || ix.items[sel[0]].parentId !== it.parentId || s.view.focusedView !== "columns") {
    selectColumnItem(id);
    return;
  }
  const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
  if (!next.length) {
    clearSelection();
    return;
  }
  setView((v) => ({ ...v, columnsSelection: next }));
  set({ selectionAnchor: id });
}

export function extendColumnSelectionTo(id: string): void {
  const s = get();
  const ix = indexOf(s.doc);
  const it = ix.items[id];
  const anchor = s.selectionAnchor && ix.items[s.selectionAnchor] ? ix.items[s.selectionAnchor] : null;
  if (!it || !anchor || anchor.parentId !== it.parentId || it.parentId === null) {
    selectColumnItem(id);
    return;
  }
  const sibs = childrenOf(ix, it.parentId);
  const a = sibs.findIndex((x) => x.id === anchor.id);
  const b = sibs.findIndex((x) => x.id === id);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const ids = sibs.slice(lo, hi + 1).map((x) => x.id);
  setView((v) => ({ ...v, focusedView: "columns", columnsSelection: ids }));
}

export function selectCalendarItem(id: string): void {
  const s = get();
  const it = s.doc?.items[id];
  if (!it?.scheduleDate) return;
  set({
    ...exitEditSilently(s),
    createTarget: null,
    selectionAnchor: id,
    view: {
      ...s.view,
      focusedView: "calendar",
      showCalendarView: true,
      calendarSelection: [id],
      calendarCurrentDate: ensureDayVisible(s, it.scheduleDate),
    },
  });
}

export function toggleCalendarSelection(id: string): void {
  const s = get();
  const it = s.doc?.items[id];
  const sel = s.view.calendarSelection.filter((x) => s.doc?.items[x]);
  if (!it || !sel.length || s.doc!.items[sel[0]].scheduleDate !== it.scheduleDate || s.view.focusedView !== "calendar") {
    selectCalendarItem(id);
    return;
  }
  const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
  setView((v) => ({ ...v, calendarSelection: next }));
  set({ selectionAnchor: id });
}

export function extendCalendarSelectionTo(id: string): void {
  const s = get();
  const ix = indexOf(s.doc);
  const it = ix.items[id];
  const anchor = s.selectionAnchor ? ix.items[s.selectionAnchor] : null;
  if (!it?.scheduleDate || !anchor || anchor.scheduleDate !== it.scheduleDate) {
    selectCalendarItem(id);
    return;
  }
  const day = itemsOnDay(ix, it.scheduleDate);
  const a = day.findIndex((x) => x.id === anchor.id);
  const b = day.findIndex((x) => x.id === id);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  setView((v) => ({ ...v, focusedView: "calendar", calendarSelection: day.slice(lo, hi + 1).map((x) => x.id) }));
}

export function selectInView(view: ViewName, id: string) {
  if (view === "calendar") selectCalendarItem(id);
  else selectColumnItem(id);
}

function ensureDayVisible(s: AppState, date: string): string {
  const anchor = s.view.calendarCurrentDate ?? today();
  const d = diffDays(anchor, date);
  if (d >= 0 && d < visibleDayCount) return anchor;
  return date;
}

export function clearSelection(): void {
  setView((v) =>
    v.focusedView === "calendar" ? { ...v, calendarSelection: [] } : { ...v, columnsSelection: [] },
  );
}

export function setCreateTarget(target: CreateTarget | null): void {
  const s = get();
  const view = target?.view ?? s.view.focusedView;
  set({
    ...exitEditSilently(s),
    createTarget: target,
    view:
      view === "calendar"
        ? { ...s.view, focusedView: "calendar", calendarSelection: [] }
        : {
            ...s.view,
            focusedView: "columns",
            columnsSelection: [],
            columnsPath:
              target?.view === "columns" && s.doc?.items[target.parentId]
                ? pathTo(indexOf(s.doc), target.parentId)
                : target?.view === "columns"
                  ? []
                  : s.view.columnsPath,
          },
  });
}

export function switchSpace(spaceId: string): void {
  const s = get();
  const sp = s.doc?.config.spaces.find((x) => x.id === spaceId);
  if (!sp || sp.archived) return;
  set({
    edit: null,
    createTarget: null,
    columnOffset: 0,
    overlay: null,
    view: {
      ...s.view,
      currentSpaceId: spaceId,
      columnsPath: [],
      columnsSelection: [],
      focusedView: "columns",
      showColumnsView: true,
    },
  });
}

export function cycleSpace(delta: number): void {
  const s = get();
  const spaces = visibleSpaces(s.doc?.config.spaces ?? []);
  const i = spaces.findIndex((x) => x.id === s.view.currentSpaceId);
  const next = spaces[(i + delta + spaces.length) % spaces.length];
  if (next) switchSpace(next.id);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function focusView(view: ViewName): void {
  setView((v) => ({
    ...v,
    focusedView: view,
    showColumnsView: view === "columns" ? true : v.showColumnsView,
    showCalendarView: view === "calendar" ? true : v.showCalendarView,
  }));
  set({ createTarget: null, edit: null });
}

export function toggleFocusedView(): void {
  const v = get().view;
  focusView(v.focusedView === "columns" ? "calendar" : "columns");
}

export function switchView(view: ViewName): void {
  setView((v) => ({
    ...v,
    focusedView: view,
    showColumnsView: view === "columns",
    showCalendarView: view === "calendar",
  }));
  set({ createTarget: null, edit: null });
}

/** columns-only → both → calendar-only → columns-only */
export function cycleViewVisibility(): void {
  const v = get().view;
  if (v.showColumnsView && !v.showCalendarView) {
    setView((x) => ({ ...x, showCalendarView: true }));
  } else if (v.showColumnsView && v.showCalendarView) {
    setView((x) => ({ ...x, showColumnsView: false, focusedView: "calendar" }));
  } else {
    setView((x) => ({ ...x, showColumnsView: true, showCalendarView: false, focusedView: "columns" }));
  }
}

export function toggleDayPicker(): void {
  setView((v) => ({ ...v, showCalendarDayPicker: !v.showCalendarDayPicker, showCalendarView: true }));
}

export function setCalendarAnchor(date: string): void {
  setView((v) => ({ ...v, calendarCurrentDate: date, showCalendarView: true }));
}

export function shiftCalendar(days: number): void {
  const v = get().view;
  setCalendarAnchor(addDays(v.calendarCurrentDate ?? today(), days));
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

function columnSiblings(s: AppState, id: string): Item[] {
  const ix = indexOf(s.doc);
  const it = ix.items[id];
  return it?.parentId ? childrenOf(ix, it.parentId) : [];
}

function daySiblings(s: AppState, id: string): Item[] {
  const it = s.doc?.items[id];
  return it?.scheduleDate ? itemsOnDay(indexOf(s.doc), it.scheduleDate) : [];
}

export function navigateVertical(delta: 1 | -1, extend = false): void {
  const s = get();
  const ix = indexOf(s.doc);
  const cal = s.view.focusedView === "calendar";
  const sel = selectionOf(s);

  if (!sel.length) {
    const ct = s.createTarget;
    const list = ct
      ? ct.view === "columns"
        ? childrenOf(ix, ct.parentId)
        : itemsOnDay(ix, ct.date)
      : cal
        ? itemsOnDay(ix, calendarDays(s)[0])
        : childrenOf(ix, columnIds(s).at(-1)!);
    const pick = delta > 0 ? list[0] : list[list.length - 1];
    if (pick) (ct?.view ?? (cal ? "calendar" : "columns")) === "calendar" ? selectCalendarItem(pick.id) : selectColumnItem(pick.id);
    return;
  }

  const sibs = cal ? daySiblings(s, sel[0]) : columnSiblings(s, sel[0]);
  const idx = sel.map((id) => sibs.findIndex((x) => x.id === id)).filter((i) => i >= 0);
  if (!idx.length) return;

  if (extend) {
    const anchorIdx = sibs.findIndex((x) => x.id === s.selectionAnchor);
    const a = anchorIdx >= 0 ? anchorIdx : idx[0];
    const lo = Math.min(...idx);
    const hi = Math.max(...idx);
    // The moving end is whichever end is not the anchor.
    let end = a === lo ? hi : lo;
    end = Math.min(sibs.length - 1, Math.max(0, end + delta));
    const [from, to] = a < end ? [a, end] : [end, a];
    const ids = sibs.slice(from, to + 1).map((x) => x.id);
    setView((v) => (cal ? { ...v, calendarSelection: ids } : { ...v, columnsSelection: ids }));
    return;
  }

  const target = delta > 0 ? sibs[Math.max(...idx) + 1] : sibs[Math.min(...idx) - 1];
  if (target) (cal ? selectCalendarItem : selectColumnItem)(target.id);
  else if (sel.length > 1) (cal ? selectCalendarItem : selectColumnItem)(delta > 0 ? sibs[Math.max(...idx)].id : sibs[Math.min(...idx)].id);
  else if (s.view.showColumnsView && s.view.showCalendarView) {
    // At the edge of a split view: hop to the other view.
    if (!cal && delta > 0) focusView("calendar");
    if (cal && delta < 0) focusView("columns");
  }
}

export function navigateLeft(): void {
  const s = get();
  const ix = indexOf(s.doc);
  if (s.view.focusedView === "calendar") {
    const sel = selectionOf(s);
    const cur = sel[0] ? ix.items[sel[0]] : null;
    const date = cur?.scheduleDate ?? (s.createTarget?.view === "calendar" ? s.createTarget.date : null);
    if (!date) return;
    moveAcrossDays(date, -1, cur);
    return;
  }
  const sel = selectionOf(s);
  if (!sel.length) {
    const ct = s.createTarget;
    if (ct?.view === "columns" && ix.items[ct.parentId]) selectColumnItem(ct.parentId);
    return;
  }
  const it = ix.items[sel[0]];
  if (it?.parentId && ix.items[it.parentId]) selectColumnItem(it.parentId);
}

export function navigateRight(): void {
  const s = get();
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  if (s.view.focusedView === "calendar") {
    const cur = sel[0] ? ix.items[sel[0]] : null;
    const date = cur?.scheduleDate ?? (s.createTarget?.view === "calendar" ? s.createTarget.date : null);
    if (!date) return;
    moveAcrossDays(date, 1, cur);
    return;
  }
  if (sel.length !== 1) return;
  const it = ix.items[sel[0]];
  if (!it || !isContainerType(it.type)) return;
  const kids = childrenOf(ix, it.id);
  if (kids.length) selectColumnItem(kids[0].id);
  else setCreateTarget({ view: "columns", parentId: it.id });
}

function moveAcrossDays(date: string, delta: number, cur: Item | null): void {
  const s = get();
  const ix = indexOf(s.doc);
  const next = addDays(date, delta);
  const curList = itemsOnDay(ix, date);
  const i = cur ? curList.findIndex((x) => x.id === cur.id) : 0;
  const nextList = itemsOnDay(ix, next);
  const pick = nextList[Math.min(Math.max(i, 0), nextList.length - 1)];
  const anchor = ensureDayVisible(s, next);
  setView((v) => ({ ...v, calendarCurrentDate: anchor }));
  if (pick) selectCalendarItem(pick.id);
  else setCreateTarget({ view: "calendar", date: next });
}

function currentColumnItems(s: AppState): Item[] {
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  if (s.view.focusedView === "calendar") {
    const date =
      (sel[0] && ix.items[sel[0]]?.scheduleDate) || (s.createTarget?.view === "calendar" ? s.createTarget.date : null);
    return date ? itemsOnDay(ix, date) : [];
  }
  const parent =
    (sel[0] && ix.items[sel[0]]?.parentId) ||
    (s.createTarget?.view === "columns" ? s.createTarget.parentId : columnIds(s).at(-1)!);
  return childrenOf(ix, parent);
}

export function selectAll(): void {
  const s = get();
  const list = currentColumnItems(s);
  if (!list.length) return;
  if (s.view.focusedView === "calendar") setView((v) => ({ ...v, calendarSelection: list.map((x) => x.id) }));
  else selectColumnItems(list.map((x) => x.id));
}

export function selectEdge(which: "first" | "last"): void {
  const s = get();
  const list = currentColumnItems(s);
  const it = which === "first" ? list[0] : list[list.length - 1];
  if (!it) return;
  (s.view.focusedView === "calendar" ? selectCalendarItem : selectColumnItem)(it.id);
}

// ---------------------------------------------------------------------------
// Editing state
// ---------------------------------------------------------------------------

export function enterEdit(id: string, caret: "start" | "end" | number = "end"): void {
  if (get().edit && get().edit!.itemId !== id) editExitHook?.();
  const s = get();
  const it = s.doc?.items[id];
  if (!it || !isEditableType(it.type)) return;
  set({ edit: { itemId: id, caret, draft: it.text }, createTarget: null });
}

export function updateDraft(text: string): void {
  const s = get();
  if (s.edit) set({ edit: { ...s.edit, draft: text } });
}
