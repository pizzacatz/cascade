// Inline plain-text editor for an item (contenteditable). Handles caret
// placement, inline triggers (# heading, --- separator, :: command menu) and
// the in-editor keyboard gestures.

import { useEffect, useLayoutEffect, useRef } from "react";
import type { Item } from "../model/types";
import { childrenOf } from "../model/tree";
import { get, set, useApp } from "../state/store";
import { indexOf } from "../state/derived";
import { enterEdit, selectColumnItem, updateDraft, selectCalendarItem } from "../state/nav";
import { MAX_TEXT_LENGTH, convertEditedItem, createFromEdit, createSibling, exitEdit, flushEdit } from "../state/items";
import { splitTypedDate } from "../state/schedule";
import { formatShortDay, relativeDayLabel, todayKey } from "../model/dates";
import { CalendarDays } from "lucide-react";

function placeCaret(el: HTMLElement, caret: "start" | "end" | number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const text = el.firstChild;
  if (!text) {
    range.setStart(el, 0);
  } else {
    const len = text.textContent?.length ?? 0;
    const off = caret === "start" ? 0 : caret === "end" ? len : Math.min(len, Math.max(0, caret));
    range.setStart(text, off);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length;
}

/** Is the caret on the first / last visual line of the editor? */
function caretOnEdgeLine(el: HTMLElement, edge: "first" | "last"): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return true;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : null;
  const box = el.getBoundingClientRect();
  if (!rect || rect.height === 0) {
    const off = caretOffset(el);
    return edge === "first" ? off === 0 : off === (el.textContent?.length ?? 0);
  }
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
  return edge === "first" ? rect.top - box.top < lh * 0.9 : box.bottom - rect.bottom < lh * 0.9;
}

function siblingsInView(item: Item, view: "columns" | "calendar"): Item[] {
  const ix = indexOf(get().doc);
  if (view === "calendar" && item.scheduleDate) return (ix.byDay.get(item.scheduleDate) ?? []);
  return item.parentId ? childrenOf(ix, item.parentId) : [];
}

export function ItemEditor({ item, view, className }: { item: Item; view: "columns" | "calendar"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const edit = get().edit;
    el.textContent = edit?.draft ?? item.text;
    el.focus({ preventScroll: true });
    placeCaret(el, edit?.caret ?? "end");
    el.scrollIntoView({ block: "nearest" });
    // Only on mount: afterwards the DOM is the source of truth while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync when a trigger conversion rewrites the draft (e.g. "# " stripped).
  useEffect(() => syncDraftToDom(ref), []);

  // The inline command menu hands focus back here when it closes.
  useEffect(() => {
    const refocus = () => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      placeCaret(el, "end");
    };
    window.addEventListener("cascade:focus-editor", refocus);
    return () => window.removeEventListener("cascade:focus-editor", refocus);
  }, []);

  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
  }, []);

  const onInput = () => {
    const el = ref.current!;
    let text = (el.textContent ?? "").replace(/\n/g, " ");
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH);
      el.textContent = text;
      placeCaret(el, "end");
    }
    // Save after a short pause, so undo steps back in small chunks.
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => {
      if (get().edit?.itemId === item.id) flushEdit();
    }, 500);
    const { prefs } = get();
    const sep = prefs.separatorShortcutTrigger;
    const head = prefs.headingShortcutTrigger;
    const cmd = prefs.inlineCommandTrigger;

    if (sep && text.trim() === sep && item.type !== "separator") {
      // A separator, then straight on to a new item after it.
      convertEditedItem("separator", "");
      selectColumnOrDay(item.id, view);
      createSibling();
      return;
    }
    // Typing the heading trigger as the whole text turns the item into a heading.
    if (head && item.type !== "heading" && text === head && !(sep && sep.startsWith(text) && sep !== text)) {
      convertEditedItem("heading", "");
      el.textContent = "";
      return;
    }
    if (cmd && text.includes(cmd)) {
      // The inline trigger opens the full command menu for this item; editing
      // resumes afterwards with the caret where the trigger was typed.
      const at = text.indexOf(cmd);
      const stripped = text.slice(0, at) + text.slice(at + cmd.length);
      el.textContent = stripped;
      updateDraft(stripped);
      flushEdit();
      set({
        edit: null,
        overlay: { kind: "command", pages: [{ id: "root", query: "" }], resume: { itemId: item.id, caret: at } },
        overlayStack: [],
      });
      return;
    }
    updateDraft(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = ref.current!;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      createFromEdit(e.ctrlKey ? "child" : "sibling");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitEdit();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && plain && !e.shiftKey) {
      const up = e.key === "ArrowUp";
      if (!caretOnEdgeLine(el, up ? "first" : "last")) return;
      const sibs = siblingsInView(item, view);
      const i = sibs.findIndex((x) => x.id === item.id);
      const next = up ? sibs.slice(0, i).reverse().find((x) => x.type !== "separator") : sibs.slice(i + 1).find((x) => x.type !== "separator");
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      // Keep the caret's horizontal position when moving to the neighbour.
      const sel = window.getSelection();
      const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const x = rect && rect.width + rect.left > 0 ? rect.left : el.getBoundingClientRect().left;
      const offset = offsetAtX(next.id, view, x, up) ?? (up ? "end" : Math.min(caretOffset(el), next.text.length));
      moveEditTo(next.id, view, offset);
      return;
    }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && view === "columns") {
      e.preventDefault();
      e.stopPropagation();
      const ix = indexOf(get().doc);
      const target =
        e.key === "ArrowLeft"
          ? item.parentId
            ? ix.items[item.parentId]
            : null
          : childrenOf(ix, item.id).find((x) => x.type !== "separator");
      if (!target) return;
      moveEditTo(target.id, "columns", "end");
    }
  };

  const onBlur = () => {
    // Window lost focus (alt-tab): keep editing.
    if (!document.hasFocus()) return;
    const s = get();
    if (s.edit?.itemId === item.id) exitEdit();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const room = MAX_TEXT_LENGTH - (el.textContent ?? "").length + (window.getSelection()?.toString().length ?? 0);
    const text = e.clipboardData.getData("text/plain").replace(/\s+/g, " ").slice(0, Math.max(0, room));
    document.execCommand("insertText", false, text);
  };

  return (
    <>
      <div
        ref={ref}
        className={`item-editor ${className ?? ""}`}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        role="textbox"
        aria-label="Item text"
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      <TypedDateHint itemId={item.id} />
    </>
  );
}

/** Shows what a trailing "@date" will do when the edit is committed. */
function TypedDateHint({ itemId }: { itemId: string }) {
  const draft = useApp((s) => (s.edit?.itemId === itemId ? s.edit.draft : ""));
  const weekStartsOn = useApp((s) => s.prefs.weekStartsOn);
  const found = draft.includes("@") ? splitTypedDate(draft, todayKey(), weekStartsOn) : null;
  if (!found) return null;
  return (
    <span className="typed-date-hint" title="Scheduled when you finish editing">
      <CalendarDays size={11} />
      {found.date ? (relativeDayLabel(found.date) ?? formatShortDay(found.date)) : "No date"}
    </span>
  );
}

/** Keep the editor's DOM text in sync when the draft is replaced programmatically. */
function syncDraftToDom(ref: React.RefObject<HTMLDivElement | null>) {
  return useApp.subscribe((st, prev) => {
    const draft = st.edit?.draft;
    if (draft === prev.edit?.draft || draft === undefined) return;
    const el = ref.current;
    if (el && (el.textContent ?? "") !== draft) {
      el.textContent = draft;
      placeCaret(el, "end");
    }
  });
}

/** Character offset in another row's text at a horizontal position (its last line when coming from below). */
function offsetAtX(itemId: string, view: string, x: number, fromBelow: boolean): number | null {
  const row = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"][data-view="${view}"] .item-text`);
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  if (!row || !doc.caretRangeFromPoint) return null;
  const r = row.getBoundingClientRect();
  const range = doc.caretRangeFromPoint(Math.min(Math.max(x, r.left + 1), r.right - 1), fromBelow ? r.bottom - 4 : r.top + 4);
  if (!range || !row.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(row);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function selectColumnOrDay(id: string, view: "columns" | "calendar") {
  (view === "calendar" ? selectCalendarItem : selectColumnItem)(id);
}

/** Move editing to another item: selecting commits (or removes) the current one first. */
function moveEditTo(id: string, view: "columns" | "calendar", caret: "start" | "end" | number) {
  (view === "calendar" ? selectCalendarItem : selectColumnItem)(id);
  enterEdit(id, caret);
}
