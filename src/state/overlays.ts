// Exactly one overlay (modal) is active at a time. Opening a child overlay
// (e.g. a confirmation from inside settings) remembers the parent so closing
// the child returns to it.

import { get, set, type CommandPageId, type Overlay } from "./store";
import { exitEdit } from "./items";
import { enterEdit, selectCalendarItem, selectColumnItem } from "./nav";

export function openOverlay(overlay: Overlay, opts: { stack?: boolean } = {}): void {
  const s = get();
  if (s.edit) exitEdit();
  set((st) => ({
    overlay,
    overlayStack: opts.stack && st.overlay ? [...st.overlayStack, st.overlay] : [],
    drag: null,
  }));
}

/** Return to editing an item after the "::" command palette closes. */
export function resumeInlineEdit(resume: { itemId: string; caret: number } | undefined): void {
  const s = get();
  if (!resume || s.overlay || s.edit) return;
  const it = s.doc?.items[resume.itemId];
  if (!it || it.type === "separator") return;
  (s.view.focusedView === "calendar" && it.scheduleDate ? selectCalendarItem : it.parentId ? selectColumnItem : selectCalendarItem)(it.id);
  enterEdit(it.id, Math.min(resume.caret, it.text.length));
}

export function closeOverlay(): void {
  const closing = get().overlay;
  set((st) => {
    const parent = st.overlayStack[st.overlayStack.length - 1] ?? null;
    return { overlay: parent, overlayStack: st.overlayStack.slice(0, -1) };
  });
  if (closing?.kind === "command") resumeInlineEdit(closing.resume);
}

export function closeAllOverlays(): void {
  set({ overlay: null, overlayStack: [] });
}

export function openCommand(page: CommandPageId = "root", query = ""): void {
  const s = get();
  if (s.overlay?.kind === "command") {
    set({ overlay: { kind: "command", pages: [...s.overlay.pages, { id: page, query }] } });
    return;
  }
  const pages = page === "root" ? [{ id: page, query }] : [{ id: "root" as const, query: "" }, { id: page, query }];
  openOverlay({ kind: "command", pages });
}

export function confirmAction(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  openOverlay(
    {
      kind: "confirm",
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      danger: opts.danger,
      onConfirm: opts.onConfirm,
    },
    { stack: true },
  );
}

export function promptText(opts: { title: string; label: string; value?: string; onSubmit: (v: string) => void }): void {
  openOverlay(
    { kind: "prompt", title: opts.title, label: opts.label, value: opts.value ?? "", onSubmit: opts.onSubmit },
    { stack: true },
  );
}
