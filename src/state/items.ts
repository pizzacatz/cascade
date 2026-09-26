// Document-mutating item operations. Each public function is one undo step.

import type { Doc, Item, ItemType, Color, ViewName } from "../model/types";
import {
  TRASH_SPACE_ID,
  childPolicy,
  isContainerType,
  isEditableType,
  isTaggableType,
} from "../model/types";
import { makeItem, newId, nowIso } from "../model/defaults";
import { keyAfter, keyBefore, keyBetween, keysBetween } from "../model/order";
import {
  childrenOf,
  descendants,
  isAncestor,
  isInTrash,
  itemsOnDay,
  spaceOf,
  topLevelOnly,
  type DocIndex,
} from "../model/tree";
import type { OutlineNode } from "../model/outline";
import { get, set, transact, setView, toast, type CreateTarget } from "./store";
import { indexOf, selectionOf } from "./derived";
import { addDays, formatShortDay, relativeDayLabel, todayKey } from "../model/dates";
import { splitTypedDate } from "./schedule";
import {
  enterEdit,
  selectCalendarItem,
  selectColumnItem,
  selectColumnItems,
  setCreateTarget,
  setEditExitHook,
  setEditFlushHook,
  calendarDays,
} from "./nav";

// ---------------------------------------------------------------------------
// Draft helpers (operate on an immer draft of the document)
// ---------------------------------------------------------------------------

const touch = (it: Item) => {
  it.updatedAt = nowIso();
};

function lastChildPosition(ix: DocIndex, parentId: string): string | null {
  const kids = childrenOf(ix, parentId);
  return kids.length ? kids[kids.length - 1].position : null;
}

function lastDayPosition(ix: DocIndex, date: string): string | null {
  const list = itemsOnDay(ix, date);
  return list.length ? list[list.length - 1].schedulePosition : null;
}

/** Position for inserting into a column: after `afterId`, or at the end. */
export function columnInsertPosition(ix: DocIndex, parentId: string, afterId?: string | null): string {
  const kids = childrenOf(ix, parentId);
  if (afterId === undefined) return keyAfter(kids.at(-1)?.position ?? null);
  if (afterId === null) return keyBefore(kids[0]?.position ?? null);
  const i = kids.findIndex((k) => k.id === afterId);
  if (i < 0) return keyAfter(kids.at(-1)?.position ?? null);
  return keyBetween(kids[i].position, kids[i + 1]?.position ?? null);
}

function dayInsertPosition(ix: DocIndex, date: string, afterId?: string | null): string {
  const list = itemsOnDay(ix, date);
  if (afterId === undefined) return keyAfter(list.at(-1)?.schedulePosition ?? null);
  if (afterId === null) return keyBefore(list[0]?.schedulePosition ?? null);
  const i = list.findIndex((k) => k.id === afterId);
  if (i < 0) return keyAfter(list.at(-1)?.schedulePosition ?? null);
  return keyBetween(list[i].schedulePosition, list[i + 1]?.schedulePosition ?? null);
}

/** Change an item's type in place, dropping data the new type cannot hold. */
function applyType(it: Item, type: ItemType) {
  if (it.type === type) return;
  it.type = type;
  if (type !== "task") {
    it.finished = false;
    it.finishedAt = null;
  }
  if (type === "separator") it.text = "";
  if (!isTaggableType(type)) it.tags = [];
  if (isContainerType(type)) {
    if (type === "template" && !it.icon) it.icon = "folder-bookmark";
  } else {
    it.icon = null;
  }
  touch(it);
}

function hardDelete(draft: Doc, ix: DocIndex, ids: string[]) {
  for (const id of ids) {
    for (const d of descendants(ix, id)) delete draft.items[d.id];
    delete draft.items[id];
  }
}

function trashInto(draft: Doc, ix: DocIndex, ids: string[]) {
  let pos = lastChildPosition(ix, TRASH_SPACE_ID);
  for (const id of ids) {
    const it = draft.items[id];
    if (!it) continue;
    pos = keyAfter(pos);
    it.parentId = TRASH_SPACE_ID;
    it.position = pos;
    it.scheduleDate = null;
    it.schedulePosition = null;
    touch(it);
  }
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

function focused(): ViewName {
  return get().view.focusedView;
}

function selectionAfterRemoval(ix: DocIndex, removed: string[], view: ViewName): string | null {
  const first = ix.items[removed[0]];
  if (!first) return null;
  const sibs =
    view === "calendar" && first.scheduleDate
      ? itemsOnDay(ix, first.scheduleDate)
      : first.parentId
        ? childrenOf(ix, first.parentId)
        : [];
  const gone = new Set(removed);
  const idx = sibs.map((x, i) => (gone.has(x.id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return null;
  const after = sibs.slice(Math.max(...idx) + 1).find((x) => !gone.has(x.id));
  if (after) return after.id;
  const before = sibs.slice(0, Math.min(...idx)).reverse().find((x) => !gone.has(x.id));
  return before?.id ?? null;
}

function reselect(view: ViewName, id: string | null, fallback: () => void) {
  if (id) (view === "calendar" ? selectCalendarItem : selectColumnItem)(id);
  else fallback();
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type Placement =
  | { view: "columns"; parentId: string; afterId?: string | null }
  | { view: "calendar"; date: string; afterId?: string | null };

/** Create an item and (for editable types) start editing it. Returns its id. */
export function addItem(type: ItemType, place: Placement, fields: Partial<Item> = {}, edit = true): string | null {
  const s = get();
  if (!s.doc) return null;
  const ix = indexOf(s.doc);
  const item = makeItem(type, fields);
  if (place.view === "columns") {
    // Creating under a non-container converts it into a folder (or is blocked).
    const parent = ix.items[place.parentId];
    if (parent && childPolicy(parent.type) === "blocked") return null;
    item.parentId = place.parentId;
    item.position = columnInsertPosition(ix, place.parentId, place.afterId);
  } else {
    item.scheduleDate = place.date;
    item.schedulePosition = dayInsertPosition(ix, place.date, place.afterId);
  }
  const ok = transact(`Create ${type}`, (d) => {
    if (place.view === "columns") {
      const parent = d.items[place.parentId];
      if (parent && childPolicy(parent.type) === "convert-to-folder") applyType(parent, "folder");
    }
    d.items[item.id] = item;
  });
  if (!ok) return null;
  if (place.view === "calendar") selectCalendarItem(item.id);
  else selectColumnItem(item.id);
  if (edit && isEditableType(type)) enterEdit(item.id, "end");
  return item.id;
}

/** Shift+Enter: new sibling after the selection. */
export function createSibling(type: ItemType = "task"): void {
  const s = get();
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  let anchorId = s.edit?.itemId ?? sel[0];
  if (!s.edit && sel.length > 1) {
    // Insert right after the first selected item in column order.
    const first = ix.items[sel[0]];
    const list =
      focused() === "calendar" && first?.scheduleDate
        ? itemsOnDay(ix, first.scheduleDate)
        : first?.parentId
          ? childrenOf(ix, first.parentId)
          : [];
    anchorId = list.find((x) => sel.includes(x.id))?.id ?? anchorId;
  }
  const anchor = anchorId ? ix.items[anchorId] : null;
  if (!anchor) {
    createInCurrentColumn(type);
    return;
  }
  if (focused() === "calendar" && anchor.scheduleDate) {
    addItem(type, { view: "calendar", date: anchor.scheduleDate, afterId: anchor.id });
  } else if (anchor.parentId) {
    addItem(type, { view: "columns", parentId: anchor.parentId, afterId: anchor.id });
  }
}

/** Ctrl+Enter: new child inside the selected item (converting it to a folder). */
export function createChild(type: ItemType = "task"): void {
  const s = get();
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  const anchorId = s.edit?.itemId ?? (sel.length === 1 ? sel[0] : null);
  const anchor = anchorId ? ix.items[anchorId] : null;
  if (!anchor || childPolicy(anchor.type) === "blocked") return;
  addItem(type, { view: "columns", parentId: anchor.id });
}

/** Enter with nothing selected: create at the end of the deepest column / first day. */
export function createInCurrentColumn(type: ItemType = "task"): void {
  const s = get();
  const ct = s.createTarget;
  if (ct) {
    createAtTarget(ct, type);
    return;
  }
  if (s.view.focusedView === "calendar") {
    addItem(type, { view: "calendar", date: calendarDays(s)[0] });
    return;
  }
  // Nothing selected: bottom of the current space's root column.
  addItem(type, { view: "columns", parentId: s.view.currentSpaceId });
}

/** Where each item made from a create row came from (for selection after auto-removal). */
const createOrigins = new Map<string, CreateTarget>();

/** Activate a "Create a new item" row or the "Turn into folder…" button. */
export function createAtTarget(target: CreateTarget, type: ItemType = "task"): string | null {
  const id =
    target.view === "calendar"
      ? addItem(type, { view: "calendar", date: target.date })
      : addItem(type, { view: "columns", parentId: target.parentId });
  if (id) createOrigins.set(id, target);
  return id;
}

/** Enter / Ctrl+Enter while editing: commit, then create — the edited item is kept even if empty. */
export function createFromEdit(kind: "sibling" | "child"): void {
  const s = get();
  if (!s.edit) return;
  const id = s.edit.itemId;
  takeTypedDate();
  flushEdit();
  set({ edit: null });
  const view = focused();
  if (view === "calendar") {
    if (kind === "child") return;
    selectCalendarItem(id);
  } else selectColumnItem(id);
  if (kind === "child") createChild();
  else createSibling();
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export const MAX_TEXT_LENGTH = 1000;

/** Item text is one line: whitespace runs become one space; capped in length. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, MAX_TEXT_LENGTH);
}

/** Commit the live edit draft to the document. */
export function flushEdit(): void {
  const s = get();
  if (!s.edit || !s.doc) return;
  const { itemId } = s.edit;
  const draft = cleanText(s.edit.draft);
  const it = s.doc.items[itemId];
  if (!it || it.text === draft) return;
  // Each flush (after a short pause in typing) is its own undo step.
  transact("Edit text", (d) => {
    const x = d.items[itemId];
    if (x) {
      x.text = draft;
      touch(x);
    }
  });
}

/**
 * "Call dentist @fri": when an edit is committed, a trailing @date schedules
 * the item and is removed from its text (see splitTypedDate).
 */
function takeTypedDate(): void {
  const s = get();
  if (!s.edit || !s.doc) return;
  const found = splitTypedDate(s.edit.draft, todayKey(), s.prefs.weekStartsOn);
  const it = s.doc.items[s.edit.itemId];
  if (!found || !it || it.type === "separator") return;
  const id = it.id;
  set({ edit: { ...s.edit, draft: found.text } });
  flushEdit();
  if (found.date) {
    if (it.scheduleDate !== found.date) {
      scheduleItems([id], found.date, "Schedule");
      toast(`Scheduled on ${relativeDayLabel(found.date) ?? formatShortDay(found.date)}`, "success");
    }
  } else if (it.scheduleDate && it.parentId) {
    descheduleItems([id]);
  }
}

/** Leave edit mode. Empty, childless items are removed rather than kept. */
export function exitEdit(): void {
  takeTypedDate();
  const s = get();
  if (!s.edit || !s.doc) return;
  const { itemId, draft } = s.edit;
  const ix = indexOf(s.doc);
  const it = ix.items[itemId];
  if (!it) {
    set({ edit: null });
    return;
  }
  // An empty, childless item is removed when you leave it — except when it is
  // the only item in its folder: then it stays as a blank task, so the folder
  // (e.g. one just made with "Turn into folder…") still has something to finish.
  const onlyChildOfFolder =
    it.parentId !== null && !!ix.items[it.parentId] && childrenOf(ix, it.parentId).length === 1;
  if (draft.trim() === "" && childrenOf(ix, itemId).length === 0 && it.type !== "separator" && !onlyChildOfFolder) {
    const view = focused();
    const list = view === "calendar" && it.scheduleDate ? itemsOnDay(ix, it.scheduleDate) : it.parentId ? childrenOf(ix, it.parentId) : [];
    const i = list.findIndex((x) => x.id === itemId);
    const prev = i > 0 ? list[i - 1].id : null;
    const origin = createOrigins.get(itemId);
    createOrigins.delete(itemId);
    const parentId = it.parentId;
    set({ edit: null });
    transact("Remove empty item", (d) => {
      const x = d.items[itemId];
      if (!x) return;
      if (view === "calendar" && x.parentId && x.text.trim() !== "") {
        x.scheduleDate = null;
        x.schedulePosition = null;
      } else {
        delete d.items[itemId];
      }
    });
    reselect(view, prev, () => {
      if (origin) setCreateTarget(origin);
      else if (parentId && indexOf(get().doc).items[parentId]) selectColumnItem(parentId);
      else set((st) => ({ view: view === "calendar" ? { ...st.view, calendarSelection: [] } : { ...st.view, columnsSelection: [] } }));
    });
    return;
  }
  flushEdit();
  set({ edit: null });
}

setEditExitHook(() => exitEdit());
setEditFlushHook(() => flushEdit());

/** Apply an inline trigger (heading / separator) to the item being edited. */
export function convertEditedItem(type: ItemType, newText: string): void {
  const s = get();
  if (!s.edit) return;
  const id = s.edit.itemId;
  transact(`Turn into ${type}`, (d) => {
    const x = d.items[id];
    if (!x) return;
    applyType(x, type);
    if (type !== "separator") x.text = newText;
  });
  if (type === "separator") set({ edit: null });
  else set({ edit: { itemId: id, caret: "end", draft: newText } });
}

// ---------------------------------------------------------------------------
// Delete / trash
// ---------------------------------------------------------------------------

export function deleteSelection(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const view = focused();
  const ids = topLevelOnly(ix, selectionOf(s));
  if (!ids.length) return;
  const next = selectionAfterRemoval(ix, ids, view);
  const first = ix.items[ids[0]];
  const parentId = first.parentId;
  const date = first.scheduleDate;

  if (view === "calendar") {
    transact("Remove from calendar", (d) => {
      const toTrash: string[] = [];
      for (const id of ids) {
        const x = d.items[id];
        if (!x) continue;
        if (x.parentId) {
          x.scheduleDate = null;
          x.schedulePosition = null;
          touch(x);
        } else toTrash.push(id);
      }
      trashInto(d, ix, toTrash);
    });
  } else {
    const inTrash = ids.filter((id) => isInTrash(ix, id));
    const others = ids.filter((id) => !isInTrash(ix, id));
    transact(inTrash.length && !others.length ? "Delete permanently" : "Move to trash", (d) => {
      hardDelete(d, ix, inTrash);
      trashInto(d, ix, others);
    });
  }
  reselect(view, next, () => {
    if (view === "calendar" && date) setCreateTarget({ view: "calendar", date });
    else if (parentId) setCreateTarget({ view: "columns", parentId });
  });
}

export function emptyTrash(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const ids = childrenOf(ix, TRASH_SPACE_ID).map((x) => x.id);
  if (!ids.length) return;
  transact("Empty trash", (d) => hardDelete(d, ix, ids));
  setView((v) => ({ ...v, columnsSelection: [], columnsPath: [] }));
  toast(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"} permanently`);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function editTargets(): string[] {
  const s = get();
  return s.edit ? [s.edit.itemId] : selectionOf(s);
}

export function toggleFinished(ids = editTargets()): void {
  const s = get();
  if (!s.doc) return;
  const tasks = ids.map((id) => s.doc!.items[id]).filter((x) => x?.type === "task");
  if (!tasks.length) return;
  const allDone = tasks.every((t) => t.finished);
  setFinished(tasks.map((t) => t.id), !allDone);
}

export function setFinished(ids: string[], finished: boolean): void {
  transact(finished ? "Finish" : "Unfinish", (d) => {
    const at = nowIso();
    for (const id of ids) {
      const x = d.items[id];
      if (!x || x.type !== "task" || x.finished === finished) continue;
      x.finished = finished;
      x.finishedAt = finished ? at : null;
      touch(x);
    }
  });
}

export function canChangeType(ids: string[], type: ItemType, view: ViewName): boolean {
  const s = get();
  const ix = indexOf(s.doc);
  if (!ids.length) return false;
  if (view === "calendar" && isContainerType(type)) return false;
  return ids.every((id) => {
    const it = ix.items[id];
    if (!it || it.type === type) return false;
    if (!isContainerType(type) && childrenOf(ix, id).length > 0) return false;
    if (isContainerType(type) && it.parentId === null) return false;
    return true;
  });
}

export function changeType(type: ItemType, ids = editTargets()): void {
  const valid = ids.filter((id) => canChangeType([id], type, focused()));
  if (!valid.length) return;
  transact(`Turn into ${type}`, (d) => {
    for (const id of valid) {
      const x = d.items[id];
      if (x) applyType(x, type);
    }
  });
  const s = get();
  if (s.edit && type === "separator") set({ edit: null });
}

export function setColor(color: Color, ids = editTargets()): void {
  transact(color === "default" ? "Clear color" : `Color ${color}`, (d) => {
    for (const id of ids) {
      const x = d.items[id];
      if (x && x.color !== color) {
        x.color = color;
        touch(x);
      }
    }
  });
}

export function setIcon(icon: string | null, ids = editTargets()): void {
  transact("Change icon", (d) => {
    for (const id of ids) {
      const x = d.items[id];
      if (x && isContainerType(x.type)) {
        x.icon = icon;
        touch(x);
      }
    }
  });
}

export function addTag(tagId: string, ids = editTargets()): void {
  transact("Add tag", (d) => {
    for (const id of ids) {
      const x = d.items[id];
      if (x && isTaggableType(x.type) && !x.tags.includes(tagId)) {
        x.tags.push(tagId);
        touch(x);
      }
    }
  });
}

export function removeTag(tagId: string, ids = editTargets()): void {
  transact("Remove tag", (d) => {
    for (const id of ids) {
      const x = d.items[id];
      if (x && x.tags.includes(tagId)) {
        x.tags = x.tags.filter((t) => t !== tagId);
        touch(x);
      }
    }
  });
}

export function toggleTag(tagId: string, ids = editTargets()): void {
  const s = get();
  const items = ids.map((id) => s.doc?.items[id]).filter((x): x is Item => !!x && isTaggableType(x.type));
  if (!items.length) return;
  if (items.every((x) => x.tags.includes(tagId))) removeTag(tagId, ids);
  else addTag(tagId, ids);
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

/** Reorder the selection within its column / day. */
export function moveSelection(where: "up" | "down" | "first" | "last"): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const cal = focused() === "calendar";
  const sel = selectionOf(s);
  if (!sel.length) return;
  const first = ix.items[sel[0]];
  const sibs = cal
    ? first.scheduleDate
      ? itemsOnDay(ix, first.scheduleDate)
      : []
    : first.parentId
      ? childrenOf(ix, first.parentId)
      : [];
  const chosen = new Set(sel);
  const moving = sibs.filter((x) => chosen.has(x.id));
  const rest = sibs.filter((x) => !chosen.has(x.id));
  if (!moving.length) return;
  const firstIdx = sibs.findIndex((x) => chosen.has(x.id));
  const lastIdx = sibs.length - 1 - [...sibs].reverse().findIndex((x) => chosen.has(x.id));
  const key = (x: Item) => (cal ? x.schedulePosition : x.position);

  // Index in `rest` after which the moved block is inserted (-1 = at start).
  let insertAfter: number;
  if (where === "first") insertAfter = -1;
  else if (where === "last") insertAfter = rest.length - 1;
  else if (where === "up") {
    if (firstIdx === 0) return;
    const prev = sibs.slice(0, firstIdx).reverse().find((x) => !chosen.has(x.id));
    insertAfter = prev ? rest.indexOf(prev) - 1 : -1;
  } else {
    if (lastIdx === sibs.length - 1) return;
    const next = sibs.slice(lastIdx + 1).find((x) => !chosen.has(x.id));
    insertAfter = next ? rest.indexOf(next) : rest.length - 1;
  }
  const lo = insertAfter >= 0 ? key(rest[insertAfter]) : null;
  const hi = insertAfter + 1 < rest.length ? key(rest[insertAfter + 1]) : null;
  const keys = keysBetween(lo, hi, moving.length);
  transact("Move", (d) => {
    moving.forEach((m, i) => {
      const x = d.items[m.id];
      if (!x) return;
      if (cal) x.schedulePosition = keys[i];
      else x.position = keys[i];
      touch(x);
    });
  });
}

/** Ctrl+Right: make the selection children of the previous sibling (or next day in calendar). */
export function indentSelection(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const sel = topLevelOnly(ix, selectionOf(s));
  if (!sel.length) return;
  if (focused() === "calendar") {
    shiftDays(sel, 1);
    return;
  }
  const first = ix.items[sel[0]];
  if (!first.parentId) return;
  const sibs = childrenOf(ix, first.parentId);
  const chosen = new Set(sel);
  const firstIdx = sibs.findIndex((x) => chosen.has(x.id));
  const newParent = sibs.slice(0, firstIdx).reverse().find((x) => !chosen.has(x.id));
  if (!newParent || childPolicy(newParent.type) === "blocked") return;
  const moving = sibs.filter((x) => chosen.has(x.id));
  const keys = keysBetween(lastChildPosition(ix, newParent.id), null, moving.length);
  transact("Indent", (d) => {
    const p = d.items[newParent.id];
    if (p && childPolicy(p.type) === "convert-to-folder") applyType(p, "folder");
    moving.forEach((m, i) => {
      const x = d.items[m.id];
      x.parentId = newParent.id;
      x.position = keys[i];
      touch(x);
    });
  });
  selectColumnItems(moving.map((m) => m.id));
}

/** Ctrl+Left: move the selection up to its grandparent (or previous day in calendar). */
export function unindentSelection(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const sel = topLevelOnly(ix, selectionOf(s));
  if (!sel.length) return;
  if (focused() === "calendar") {
    shiftDays(sel, -1);
    return;
  }
  const first = ix.items[sel[0]];
  const parent = first.parentId ? ix.items[first.parentId] : null;
  if (!parent || !parent.parentId) return; // already at a space root
  const grand = parent.parentId;
  const moving = childrenOf(ix, parent.id).filter((x) => sel.includes(x.id));
  const sibs = childrenOf(ix, grand);
  const pi = sibs.findIndex((x) => x.id === parent.id);
  const keys = keysBetween(parent.position, sibs[pi + 1]?.position ?? null, moving.length);
  transact("Unindent", (d) => {
    moving.forEach((m, i) => {
      const x = d.items[m.id];
      x.parentId = grand;
      x.position = keys[i];
      touch(x);
    });
  });
  selectColumnItems(moving.map((m) => m.id));
}

function shiftDays(ids: string[], delta: number) {
  const first = indexOf(get().doc).items[ids[0]];
  if (!first?.scheduleDate) return;
  scheduleItems(ids, addDays(first.scheduleDate, delta), "Move to another day");
}

/** Reparent items under `targetId` (a folder, a convertible item, or a space). */
export function moveItemsTo(ids: string[], targetId: string, opts: { afterId?: string | null } = {}): boolean {
  const s = get();
  if (!s.doc) return false;
  const ix = indexOf(s.doc);
  const top = topLevelOnly(ix, ids).filter((id) => id !== targetId && !isAncestor(ix, id, targetId));
  if (!top.length) return false;
  const target = ix.items[targetId];
  if (target && childPolicy(target.type) === "blocked") return false;
  if (!target && !ix.spaceIds.has(targetId)) return false;
  const kids = childrenOf(ix, targetId).filter((k) => !top.includes(k.id));
  let lo: string | null;
  let hi: string | null;
  if (opts.afterId === undefined) {
    lo = kids.at(-1)?.position ?? null;
    hi = null;
  } else if (opts.afterId === null) {
    lo = null;
    hi = kids[0]?.position ?? null;
  } else {
    const i = kids.findIndex((k) => k.id === opts.afterId);
    lo = kids[i]?.position ?? null;
    hi = kids[i + 1]?.position ?? null;
  }
  const keys = keysBetween(lo, hi, top.length);
  const intoTrash = targetId === TRASH_SPACE_ID;
  return transact(intoTrash ? "Move to trash" : "Move", (d) => {
    const t = d.items[targetId];
    if (t && childPolicy(t.type) === "convert-to-folder") applyType(t, "folder");
    top.forEach((id, i) => {
      const x = d.items[id];
      x.parentId = targetId;
      x.position = keys[i];
      if (intoTrash) {
        x.scheduleDate = null;
        x.schedulePosition = null;
      }
      touch(x);
    });
  });
}

/** "Move To…" from the palette: move and follow the items. */
export function moveSelectionTo(targetId: string): void {
  const s = get();
  const ix = indexOf(s.doc);
  const ids = topLevelOnly(ix, selectionOf(s));
  if (!moveItemsTo(ids, targetId)) return;
  const nix = indexOf(get().doc);
  const space = spaceOf(nix, ids[0]);
  if (space && space !== get().view.currentSpaceId) setView((v) => ({ ...v, currentSpaceId: space }));
  selectColumnItems(ids);
}

// ---------------------------------------------------------------------------
// Calendar placement
// ---------------------------------------------------------------------------

export function scheduleItems(ids: string[], date: string, label = "Schedule", afterId?: string | null): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const moving = ids.filter((id) => ix.items[id]);
  if (!moving.length) return;
  const list = itemsOnDay(ix, date).filter((x) => !moving.includes(x.id));
  let lo: string | null;
  let hi: string | null;
  if (afterId === undefined) {
    lo = list.at(-1)?.schedulePosition ?? null;
    hi = null;
  } else if (afterId === null) {
    lo = null;
    hi = list[0]?.schedulePosition ?? null;
  } else {
    const i = list.findIndex((x) => x.id === afterId);
    lo = list[i]?.schedulePosition ?? null;
    hi = list[i + 1]?.schedulePosition ?? null;
  }
  const keys = keysBetween(lo, hi, moving.length);
  transact(label, (d) => {
    moving.forEach((id, i) => {
      const x = d.items[id];
      x.scheduleDate = date;
      x.schedulePosition = keys[i];
      touch(x);
    });
  });
  if (get().view.focusedView === "calendar") {
    setView((v) => ({ ...v, calendarSelection: moving }));
  }
}

export function scheduleSelection(date: string): void {
  const s = get();
  const ids = selectionOf(s).filter((id) => s.doc?.items[id]?.type !== "separator");
  scheduleItems(ids, date);
  toast(`Scheduled ${ids.length} item${ids.length === 1 ? "" : "s"} on ${date}`, "success");
}

export function descheduleItems(ids: string[]): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const space = s.view.currentSpaceId;
  transact("Remove from calendar", (d) => {
    let pos = lastChildPosition(ix, space);
    for (const id of ids) {
      const x = d.items[id];
      if (!x) continue;
      x.scheduleDate = null;
      x.schedulePosition = null;
      if (!x.parentId) {
        pos = keyAfter(pos);
        x.parentId = space;
        x.position = pos;
      }
      touch(x);
    }
  });
}

// ---------------------------------------------------------------------------
// Duplicate / insert trees
// ---------------------------------------------------------------------------

/** Deep-copy items (with subtrees) into a draft. Returns the new top-level ids. */
export function copyTrees(
  draft: Doc,
  ix: DocIndex,
  sources: Item[],
  place: (copy: Item, index: number) => void,
  withChildren = true,
): string[] {
  const out: string[] = [];
  const now = nowIso();
  const cloneUnder = (src: Item, parentId: string) => {
    for (const c of childrenOf(ix, src.id)) {
      const copy: Item = { ...c, tags: [...c.tags], id: newId(), parentId, createdAt: now, updatedAt: now };
      copy.scheduleDate = null;
      copy.schedulePosition = null;
      draft.items[copy.id] = copy;
      cloneUnder(c, copy.id);
    }
  };
  sources.forEach((src, i) => {
    const copy: Item = { ...src, tags: [...src.tags], id: newId(), createdAt: now, updatedAt: now };
    place(copy, i);
    draft.items[copy.id] = copy;
    if (withChildren) cloneUnder(src, copy.id);
    out.push(copy.id);
  });
  return out;
}

export function duplicateSelection(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const cal = focused() === "calendar";
  const ids = topLevelOnly(ix, selectionOf(s));
  if (!ids.length) return;
  const items = ids.map((id) => ix.items[id]);
  const last = items[items.length - 1];
  let created: string[] = [];
  if (cal && last.scheduleDate) {
    const date = last.scheduleDate;
    const list = itemsOnDay(ix, date);
    const i = list.findIndex((x) => x.id === last.id);
    const keys = keysBetween(last.schedulePosition, list[i + 1]?.schedulePosition ?? null, items.length);
    transact("Duplicate", (d) => {
      created = copyTrees(d, ix, items, (c, n) => {
        c.parentId = null;
        c.position = null;
        c.scheduleDate = date;
        c.schedulePosition = keys[n];
      });
    });
    setView((v) => ({ ...v, calendarSelection: created }));
    return;
  }
  if (!last.parentId) return;
  const parentId = last.parentId;
  const sibs = childrenOf(ix, parentId);
  const i = sibs.findIndex((x) => x.id === last.id);
  const keys = keysBetween(last.position, sibs[i + 1]?.position ?? null, items.length);
  transact("Duplicate", (d) => {
    created = copyTrees(d, ix, items, (c, n) => {
      c.parentId = parentId;
      c.position = keys[n];
      c.scheduleDate = null;
      c.schedulePosition = null;
    });
  });
  selectColumnItems(created);
}

/** Insert parsed outline nodes at a placement. Returns created top-level ids. */
export function insertOutline(nodes: OutlineNode[], place: Placement, label = "Paste"): string[] {
  const s = get();
  if (!s.doc || !nodes.length) return [];
  const ix = indexOf(s.doc);
  let created: string[] = [];
  const keys =
    place.view === "columns"
      ? (() => {
          const kids = childrenOf(ix, place.parentId);
          const i = place.afterId ? kids.findIndex((k) => k.id === place.afterId) : kids.length - 1;
          return keysBetween(kids[i]?.position ?? null, kids[i + 1]?.position ?? null, nodes.length);
        })()
      : (() => {
          const list = itemsOnDay(ix, place.date);
          const i = place.afterId ? list.findIndex((k) => k.id === place.afterId) : list.length - 1;
          return keysBetween(list[i]?.schedulePosition ?? null, list[i + 1]?.schedulePosition ?? null, nodes.length);
        })();
  const now = nowIso();
  transact(label, (d) => {
    if (place.view === "columns") {
      const parent = d.items[place.parentId];
      if (parent && childPolicy(parent.type) === "convert-to-folder") applyType(parent, "folder");
    }
    const build = (n: OutlineNode, parentId: string | null, pos: string | null, sched: string | null): string => {
      const base = n.source
        ? { ...n.source, tags: [...n.source.tags] }
        : makeItem(n.type, { text: n.text, finished: n.finished, finishedAt: n.finished ? now : null });
      const it: Item = {
        ...base,
        id: newId(),
        parentId,
        position: pos,
        scheduleDate: sched ? (place as { date: string }).date : null,
        schedulePosition: sched,
        createdAt: now,
        updatedAt: now,
      };
      if (!isTaggableType(it.type)) it.tags = [];
      if (it.parentId === null && it.scheduleDate === null) it.parentId = s.view.currentSpaceId;
      d.items[it.id] = it;
      const ck = keysBetween(null, null, n.children.length);
      n.children.forEach((c, i) => build(c, it.id, ck[i], null));
      return it.id;
    };
    created = nodes.map((n, i) =>
      place.view === "columns" ? build(n, place.parentId, keys[i], null) : build(n, null, null, keys[i]),
    );
  });
  if (place.view === "columns") selectColumnItems(created);
  else setView((v) => ({ ...v, focusedView: "calendar", calendarSelection: created }));
  return created;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

export function removeEmptyItems(): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const empty = Object.values(s.doc.items).filter(
    (x) => x.type !== "separator" && x.text.trim() === "" && childrenOf(ix, x.id).length === 0,
  );
  if (!empty.length) {
    toast("No empty items");
    return;
  }
  transact("Remove empty items", (d) => {
    for (const x of empty) delete d.items[x.id];
  });
  toast(`Removed ${empty.length} empty item${empty.length === 1 ? "" : "s"}`);
}

/** Trash finished tasks in a column/day, or everywhere when no scope is given. */
export function trashFinished(scope?: { parentId: string } | { date: string }): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  let list: Item[];
  if (!scope) list = Object.values(s.doc.items).filter((x) => !isInTrash(ix, x.id));
  else if ("parentId" in scope) list = childrenOf(ix, scope.parentId);
  else list = itemsOnDay(ix, scope.date);
  const done = topLevelOnly(
    ix,
    list.filter((x) => x.type === "task" && x.finished).map((x) => x.id),
  );
  if (!done.length) {
    toast("No finished tasks");
    return;
  }
  transact("Trash finished items", (d) => trashInto(d, ix, done));
  toast(`Moved ${done.length} finished task${done.length === 1 ? "" : "s"} to trash`);
}

export type SortBy =
  | "status-unfinished-first"
  | "status-finished-first"
  | "alphabetical"
  | "alphabetical-reverse"
  | "created-at-asc"
  | "created-at-desc"
  | "updated-at-asc"
  | "updated-at-desc";

export function sortColumn(scope: { parentId: string } | { date: string }, sortBy: SortBy): void {
  const s = get();
  if (!s.doc) return;
  const ix = indexOf(s.doc);
  const cal = "date" in scope;
  const list = cal ? itemsOnDay(ix, scope.date) : childrenOf(ix, scope.parentId);
  if (list.length < 2) return;
  const byStatus = (a: Item, b: Item) => Number(a.finished) - Number(b.finished);
  const cmp: Record<SortBy, (a: Item, b: Item) => number> = {
    "status-unfinished-first": byStatus,
    "status-finished-first": (a, b) => -byStatus(a, b),
    alphabetical: (a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "base", numeric: true }),
    "alphabetical-reverse": (a, b) => b.text.localeCompare(a.text, undefined, { sensitivity: "base", numeric: true }),
    "created-at-asc": (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    "created-at-desc": (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    "updated-at-asc": (a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
    "updated-at-desc": (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  };
  // Stable sort keeps the existing order among equal items.
  const sorted = list.map((x, i) => ({ x, i })).sort((p, q) => cmp[sortBy](p.x, q.x) || p.i - q.i).map((p) => p.x);
  const keys = keysBetween(null, null, sorted.length);
  transact("Sort", (d) => {
    sorted.forEach((x, i) => {
      const it = d.items[x.id];
      if (cal) it.schedulePosition = keys[i];
      else it.position = keys[i];
    });
  });
}

// ---------------------------------------------------------------------------
// Templates (in-document template items)
// ---------------------------------------------------------------------------

/** Copy a template's contents into a column or onto a day. */
export function instantiateTemplate(templateId: string, target: { parentId: string } | { date: string }): string[] {
  const s = get();
  if (!s.doc) return [];
  const ix = indexOf(s.doc);
  const tpl = ix.items[templateId];
  if (!tpl || tpl.type !== "template") return [];
  const kids = childrenOf(ix, templateId);
  const sources = kids.length ? kids : [{ ...tpl, type: "task" as const }];
  let created: string[] = [];
  if ("parentId" in target) {
    const keys = keysBetween(lastChildPosition(ix, target.parentId), null, sources.length);
    transact("Insert template", (d) => {
      created = copyTrees(d, ix, sources, (c, i) => {
        c.parentId = target.parentId;
        c.position = keys[i];
        c.scheduleDate = null;
        c.schedulePosition = null;
      });
    });
    selectColumnItems(created);
  } else {
    const keys = keysBetween(lastDayPosition(ix, target.date), null, sources.length);
    transact("Insert template", (d) => {
      created = copyTrees(d, ix, sources, (c, i) => {
        c.parentId = null;
        c.position = null;
        c.scheduleDate = target.date;
        c.schedulePosition = keys[i];
      });
    });
    setView((v) => ({ ...v, focusedView: "calendar", calendarSelection: created }));
  }
  return created;
}

