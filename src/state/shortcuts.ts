// The declarative shortcut table. One source of truth drives key handling, the
// key hints shown in the command palette and menus, and the help panel.

import { get, set, undo, redo, toast } from "./store";
import { selectionOf } from "./derived";
import {
  context,
  cycleViewVisibility,
  enterEdit,
  navigateLeft,
  navigateRight,
  navigateVertical,
  selectAll,
  selectEdge,
  clearSelection,
  toggleFocusedView,
  cycleSpace,
  type Ctx,
} from "./nav";
import {
  createChild,
  createInCurrentColumn,
  createSibling,
  deleteSelection,
  duplicateSelection,
  flushEdit,
  indentSelection,
  moveSelection,
  toggleFinished,
  unindentSelection,
} from "./items";
import { copyWithToast, cutSelection, paste } from "./clipboard";
import { closeDocument, newDocument, openDialog } from "./files";
import { openCommand, openOverlay } from "./overlays";
import { openPrint } from "./printing";
import { openStack } from "./stack";
import { platform } from "../platform";
import { updatePrefs } from "./store";
import { columnIds } from "./nav";

export type Category =
  | "editing"
  | "creation"
  | "selection"
  | "navigation"
  | "status"
  | "move"
  | "clipboard"
  | "views"
  | "file"
  | "system";

export interface Binding {
  id: string;
  /** Key combo, e.g. "ctrl+shift+arrowleft". Multiple alternatives with "|". */
  keys: string;
  contexts: Ctx[];
  description: string;
  category: Category;
  /** Also fires while typing in an item editor. */
  inEditor?: boolean;
  /** Shown in the contextual help panel. */
  help?: boolean;
  run: () => void;
}

const SEL: Ctx[] = ["selection"];
const NAV: Ctx[] = ["selection", "create-target", "none"];
const DOC: Ctx[] = ["selection", "create-target", "none", "edition"];
const ANY: Ctx[] = [...DOC, "nofile"];

function withSingleEditable(fn: (id: string) => void) {
  return () => {
    const sel = selectionOf(get());
    if (sel.length === 1) fn(sel[0]);
  };
}

export const BINDINGS: Binding[] = [
  // Editing
  { id: "edit", keys: "enter|f2", contexts: SEL, description: "Edit the selected item", category: "editing", help: true, run: withSingleEditable((id) => enterEdit(id, "end")) },
  { id: "toggle-finished", keys: "space", contexts: SEL, description: "Toggle finished", category: "status", help: true, run: () => toggleFinished() },
  { id: "delete", keys: "delete|backspace", contexts: SEL, description: "Move to Trash (delete permanently inside Trash)", category: "editing", help: true, run: deleteSelection },
  { id: "duplicate", keys: "ctrl+d", contexts: SEL, description: "Duplicate", category: "editing", help: true, run: duplicateSelection },
  // Creation
  { id: "create-root", keys: "enter", contexts: ["none", "create-target"], description: "Create an item here", category: "creation", help: true, run: () => createInCurrentColumn() },
  { id: "create-sibling", keys: "shift+enter", contexts: NAV, description: "New item below", category: "creation", help: true, run: () => createSibling() },
  { id: "create-child", keys: "ctrl+enter", contexts: SEL, description: "New child item (turns the item into a folder)", category: "creation", help: true, run: () => createChild() },
  // Selection & navigation
  { id: "nav-up", keys: "arrowup", contexts: NAV, description: "Select previous", category: "navigation", run: () => navigateVertical(-1) },
  { id: "nav-down", keys: "arrowdown", contexts: NAV, description: "Select next", category: "navigation", run: () => navigateVertical(1) },
  { id: "nav-left", keys: "arrowleft", contexts: NAV, description: "Go to parent / previous day", category: "navigation", help: true, run: navigateLeft },
  { id: "nav-right", keys: "arrowright", contexts: NAV, description: "Open folder / next day", category: "navigation", help: true, run: navigateRight },
  { id: "extend-up", keys: "shift+arrowup", contexts: SEL, description: "Extend selection up", category: "selection", run: () => navigateVertical(-1, true) },
  { id: "extend-down", keys: "shift+arrowdown", contexts: SEL, description: "Extend selection down", category: "selection", run: () => navigateVertical(1, true) },
  { id: "select-all", keys: "ctrl+a", contexts: NAV, description: "Select all in column", category: "selection", run: selectAll },
  { id: "select-first", keys: "home", contexts: NAV, description: "Select first in column", category: "selection", run: () => selectEdge("first") },
  { id: "select-last", keys: "end", contexts: NAV, description: "Select last in column", category: "selection", run: () => selectEdge("last") },
  { id: "clear-selection", keys: "escape", contexts: ["selection", "create-target"], description: "Clear selection", category: "selection", run: () => { clearSelection(); set({ createTarget: null }); } },
  // Move
  { id: "move-up", keys: "ctrl+arrowup", contexts: SEL, description: "Move up", category: "move", help: true, run: () => moveSelection("up") },
  { id: "move-down", keys: "ctrl+arrowdown", contexts: SEL, description: "Move down", category: "move", help: true, run: () => moveSelection("down") },
  { id: "move-first", keys: "ctrl+home", contexts: SEL, description: "Move to top", category: "move", run: () => moveSelection("first") },
  { id: "move-last", keys: "ctrl+end", contexts: SEL, description: "Move to bottom", category: "move", run: () => moveSelection("last") },
  { id: "indent", keys: "ctrl+arrowright", contexts: SEL, description: "Indent (or move to the next day)", category: "move", help: true, run: indentSelection },
  { id: "unindent", keys: "ctrl+arrowleft", contexts: SEL, description: "Unindent (or move to the previous day)", category: "move", help: true, run: unindentSelection },
  { id: "move-to", keys: "ctrl+shift+arrowleft", contexts: SEL, description: "Move to a new parent…", category: "move", run: () => { set((s) => ({ view: { ...s.view, showColumnsView: true } })); openCommand("move"); } },
  { id: "schedule", keys: "ctrl+shift+arrowright", contexts: SEL, description: "Schedule on the calendar…", category: "move", run: () => { set((s) => ({ view: { ...s.view, showCalendarView: true } })); openCommand("schedule"); } },
  // Clipboard
  { id: "copy", keys: "ctrl+c", contexts: SEL, description: "Copy", category: "clipboard", run: () => void copyWithToast() },
  { id: "cut", keys: "ctrl+x", contexts: SEL, description: "Cut", category: "clipboard", run: () => void cutSelection() },
  { id: "paste", keys: "ctrl+v", contexts: NAV, description: "Paste", category: "clipboard", run: () => void paste() },
  // History
  { id: "undo", keys: "ctrl+z", contexts: DOC, description: "Undo", category: "editing", inEditor: true, run: () => { flushEdit(); const l = undo(); if (l) toast(`Undid: ${l}`); } },
  { id: "redo", keys: "ctrl+y|ctrl+shift+z", contexts: DOC, description: "Redo", category: "editing", inEditor: true, run: () => { const l = redo(); if (l) toast(`Redid: ${l}`); } },
  // Views
  { id: "focus-view", keys: "tab", contexts: DOC, description: "Move focus between Columns and Calendar", category: "views", inEditor: true, help: true, run: toggleFocusedView },
  { id: "cycle-views", keys: "shift+tab", contexts: DOC, description: "Cycle Columns / both / Calendar", category: "views", inEditor: true, help: true, run: cycleViewVisibility },
  { id: "prev-space", keys: "ctrl+pageup", contexts: NAV, description: "Previous space", category: "views", run: () => cycleSpace(-1) },
  { id: "next-space", keys: "ctrl+pagedown", contexts: NAV, description: "Next space", category: "views", run: () => cycleSpace(1) },
  // Overlays & system
  { id: "command", keys: "ctrl+k", contexts: ANY, description: "Command menu", category: "system", inEditor: true, help: true, run: () => openCommand("root") },
  { id: "search", keys: "ctrl+f", contexts: DOC, description: "Search items", category: "system", inEditor: true, help: true, run: () => openCommand("search") },
  { id: "help", keys: "f1", contexts: ANY, description: "Toggle help", category: "system", inEditor: true, run: () => updatePrefs({ showHelp: !get().prefs.showHelp }) },
  { id: "settings", keys: "ctrl+comma", contexts: ANY, description: "Application settings", category: "system", inEditor: true, run: () => openOverlay({ kind: "appSettings", tab: "general" }) },
  { id: "doc-settings", keys: "ctrl+shift+comma", contexts: DOC, description: "Document settings", category: "system", run: () => openOverlay({ kind: "docSettings", tab: "general" }) },
  { id: "print", keys: "ctrl+p", contexts: NAV, description: "Print", category: "system", help: true, run: () => openPrint() },
  { id: "stack", keys: "ctrl+l|ctrl+shift+l", contexts: NAV, description: "Launch a Stack focus session", category: "system", help: true, run: () => openStack() },
  { id: "template", keys: "ctrl+shift+t", contexts: NAV, description: "Insert a template…", category: "creation", run: () => openOverlay({ kind: "template", target: { parentId: columnIds().at(-1)! } }) },
  { id: "fullscreen", keys: "f11", contexts: ANY, description: "Toggle fullscreen", category: "system", inEditor: true, run: () => void platform().toggleFullscreen() },
  // File
  { id: "new-file", keys: "ctrl+n", contexts: ANY, description: "New document", category: "file", run: () => void newDocument() },
  { id: "new-from-template", keys: "ctrl+shift+n", contexts: ANY, description: "New document from template…", category: "file", run: () => openCommand("templates") },
  { id: "open-file", keys: "ctrl+o", contexts: ANY, description: "Open document…", category: "file", run: () => void openDialog() },
  { id: "close-file", keys: "ctrl+shift+w", contexts: DOC, description: "Close document", category: "file", run: () => void closeDocument() },
];

export const bindingById = (id: string) => BINDINGS.find((b) => b.id === id);

const KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  meta: "Super",
  enter: "Enter",
  escape: "Esc",
  space: "Space",
  delete: "Del",
  backspace: "Backspace",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  comma: ",",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  tab: "Tab",
};

/** Human label of the first key combo of a binding, e.g. "Ctrl+Shift+N". */
export function keyLabel(idOrKeys: string): string {
  const keys = bindingById(idOrKeys)?.keys ?? idOrKeys;
  return keys
    .split("|")[0]
    .split("+")
    .map((k) => KEY_LABELS[k] ?? k.toUpperCase())
    .join("+");
}

/** Punctuation is matched by physical key so Shift doesn't change it (Shift+, is "<"). */
const CODE_KEYS: Record<string, string> = {
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  Minus: "minus",
  Equal: "equal",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
};

export function comboFromEvent(e: KeyboardEvent): string {
  let key = CODE_KEYS[e.code] ?? e.key.toLowerCase();
  if (key === " ") key = "space";
  else if (key === ",") key = "comma";
  else if (key === "esc") key = "escape";
  else if (key === "del") key = "delete";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && key !== "shift") mods.push("shift");
  if (e.metaKey) mods.push("meta");
  if (["control", "shift", "alt", "meta"].includes(key)) return mods.join("+");
  return [...mods, key].join("+");
}

function matches(b: Binding, combo: string) {
  return b.keys.split("|").includes(combo);
}

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Global keydown handler. Returns true when a binding handled the event. */
export function handleKeydown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const combo = comboFromEvent(e);
  const ctx = context();
  const inText = isTextInput(e.target);
  // Inside an overlay's own inputs only the global "any" bindings apply.
  for (const b of BINDINGS) {
    if (!matches(b, combo) || !b.contexts.includes(ctx)) continue;
    if (inText && !b.inEditor) continue;
    e.preventDefault();
    b.run();
    return true;
  }
  return false;
}

export function bindingsForHelp(ctx: Ctx): Binding[] {
  return BINDINGS.filter((b) => b.help && b.contexts.includes(ctx));
}
