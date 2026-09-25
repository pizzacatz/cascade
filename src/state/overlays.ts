// Exactly one overlay (modal) is active at a time. Opening a child overlay
// (e.g. a confirmation from inside settings) remembers the parent so closing
// the child returns to it.

import { get, set, type CommandPageId, type Overlay } from "./store";
import { exitEdit } from "./items";

export function openOverlay(overlay: Overlay, opts: { stack?: boolean } = {}): void {
  const s = get();
  if (s.edit) exitEdit();
  set((st) => ({
    overlay,
    overlayStack: opts.stack && st.overlay ? [...st.overlayStack, st.overlay] : [],
    drag: null,
  }));
}

export function closeOverlay(): void {
  set((st) => {
    const parent = st.overlayStack[st.overlayStack.length - 1] ?? null;
    return { overlay: parent, overlayStack: st.overlayStack.slice(0, -1) };
  });
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
