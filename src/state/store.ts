// The application store (zustand). Document mutations go through `transact`,
// which records immer patches so every user gesture is atomically undoable.
// View state (selection, path, focused view) lives beside the document and is
// written into `configuration.viewState` when the document is saved.

import { create } from "zustand";
import { applyPatches, enablePatches, produceWithPatches, type Patch } from "immer";
import type { Doc, ViewName, ViewState } from "../model/types";
import { defaultViewState } from "../model/defaults";
import { defaultPreferences, type Preferences } from "./prefs";
import { defaultPrintSettings, type PrintSettings } from "../print/settings";

enablePatches();

export type CommandPageId =
  | "root"
  | "move"
  | "schedule"
  | "search"
  | "icon"
  | "templates"
  | "prepare"
  | "tags"
  | "colors"
  | "types"
  | "recent";

export interface CommandPage {
  id: CommandPageId;
  query: string;
}

export type ContextTarget =
  | { type: "item"; itemId: string; view: ViewName }
  | { type: "surface"; view: ViewName; parentId?: string; date?: string }
  | { type: "space"; spaceId: string };

export type PrintScopeRef =
  | { kind: "selection"; ids: string[] }
  | { kind: "column"; parentId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "day"; date: string };

export type Overlay =
  | { kind: "command"; pages: CommandPage[] }
  | { kind: "context"; x: number; y: number; target: ContextTarget }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | { kind: "prompt"; title: string; label: string; value: string; onSubmit: (value: string) => void }
  | { kind: "appSettings"; tab: "general" | "interface" | "triggers" | "calendar" }
  | { kind: "docSettings"; tab: "general" | "spaces" | "tags" | "formatting" | "recurrence"; ruleId?: string }
  | { kind: "printSettings" }
  | { kind: "print"; scope: PrintScopeRef }
  | { kind: "stack"; scope: PrintScopeRef }
  | { kind: "template"; target: { parentId: string } | { date: string } }
  | { kind: "inline"; itemId: string; x: number; y: number; query: string }
  | { kind: "debug"; tab: "speed" | "drag" | "state" }
  | { kind: "about" };

export type CreateTarget = { view: "columns"; parentId: string } | { view: "calendar"; date: string };

export interface EditState {
  itemId: string;
  /** Where to place the caret when the editor mounts. */
  caret: "start" | "end" | number;
  /** Live text while editing (committed to the document on flush). */
  draft: string;
}

export type DropTarget =
  | { kind: "before" | "after"; itemId: string; view: ViewName }
  | { kind: "into"; itemId: string }
  | { kind: "column-end"; parentId: string }
  | { kind: "day-end"; date: string }
  | { kind: "space"; spaceId: string };

export type PaletteDrag =
  | { kind: "type"; type: "task" | "text" | "heading" | "folder" | "separator" | "template" }
  | { kind: "color"; color: string }
  | { kind: "tag"; tagId: string };

export interface DragState {
  status: "pending" | "active";
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Items being dragged (empty for toolbar palette drags). */
  ids: string[];
  sourceView: ViewName;
  palette: PaletteDrag | null;
  copy: boolean;
  target: DropTarget | null;
}

export interface LocalStack {
  tasks: string[];
  currentIndex: number;
  isRunning: boolean;
  startedAt: number;
  taskStartedAt: number;
  pausedAt: number | null;
  compact: boolean;
  onBreak: boolean;
  label: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
}

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  viewBefore: ViewState;
  viewAfter: ViewState;
  coalesceKey?: string;
  at: number;
}

export interface AppState {
  ready: boolean;
  doc: Doc | null;
  filePath: string | null;
  /** Increments on every document change; drives autosave. */
  revision: number;
  savedRevision: number;
  saveError: string | null;
  view: ViewState;
  columnOffset: number;
  edit: EditState | null;
  createTarget: CreateTarget | null;
  overlay: Overlay | null;
  /** Overlay to return to when a child overlay (e.g. confirm) closes. */
  overlayStack: Overlay[];
  drag: DragState | null;
  hoveredView: ViewName | null;
  selectionAnchor: string | null;
  localStack: LocalStack | null;
  preparingDays: string[];
  toasts: Toast[];
  prefs: Preferences;
  printSettings: PrintSettings;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Where a toolbar create button would put a new item (shown while hovering it). */
  createPreview: { afterId?: string; columnStart?: string } | null;
  /** Patches applied since the last successful save (re-applied if the file changes on disk). */
  unsavedPatches: Patch[];
}

const HISTORY_LIMIT = 300;

export const useApp = create<AppState>(() => ({
  ready: false,
  doc: null,
  filePath: null,
  revision: 0,
  savedRevision: 0,
  saveError: null,
  view: defaultViewState(),
  columnOffset: 0,
  edit: null,
  createTarget: null,
  overlay: null,
  overlayStack: [],
  drag: null,
  hoveredView: null,
  selectionAnchor: null,
  localStack: null,
  preparingDays: [],
  toasts: [],
  prefs: defaultPreferences(),
  printSettings: defaultPrintSettings(),
  past: [],
  future: [],
  unsavedPatches: [],
  createPreview: null,
}));

export const get = () => useApp.getState();
export const set = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) =>
  useApp.setState(partial);

export interface TransactOptions {
  /** Consecutive transactions with the same key merge into one undo step. */
  coalesceKey?: string;
  /** New view state to apply together with the change. */
  view?: (v: ViewState) => ViewState;
  /** Skip recording in history (e.g. automatic normalisation). */
  skipHistory?: boolean;
}

/**
 * Apply a document mutation as one undoable step. Returns false when there is
 * no document or the recipe changed nothing.
 */
export function transact(label: string, recipe: (draft: Doc) => void, opts: TransactOptions = {}): boolean {
  const s = get();
  if (!s.doc) return false;
  const [next, patches, inverse] = produceWithPatches(s.doc, recipe);
  const viewBefore = s.view;
  const viewAfter = opts.view ? opts.view(s.view) : s.view;
  if (patches.length === 0) {
    if (viewAfter !== viewBefore) set({ view: viewAfter });
    return false;
  }
  let past = s.past;
  if (!opts.skipHistory) {
    const top = past[past.length - 1];
    if (
      opts.coalesceKey &&
      top &&
      top.coalesceKey === opts.coalesceKey &&
      s.future.length === 0 &&
      Date.now() - top.at < 5000
    ) {
      past = [
        ...past.slice(0, -1),
        { ...top, patches: [...top.patches, ...patches], inverse: [...inverse, ...top.inverse], viewAfter, at: Date.now() },
      ];
    } else {
      past = [
        ...past,
        { label, patches, inverse, viewBefore, viewAfter, coalesceKey: opts.coalesceKey, at: Date.now() },
      ].slice(-HISTORY_LIMIT);
    }
  }
  set({
    doc: next,
    view: viewAfter,
    revision: s.revision + 1,
    past,
    future: opts.skipHistory ? s.future : [],
    unsavedPatches: [...s.unsavedPatches, ...patches],
  });
  return true;
}

export const canUndo = () => get().past.length > 0;
export const canRedo = () => get().future.length > 0;

export function undo(): string | null {
  const s = get();
  const entry = s.past[s.past.length - 1];
  if (!entry || !s.doc) return null;
  set({
    doc: applyPatches(s.doc, entry.inverse),
    view: entry.viewBefore,
    past: s.past.slice(0, -1),
    future: [...s.future, entry],
    revision: s.revision + 1,
    unsavedPatches: [...s.unsavedPatches, ...entry.inverse],
    edit: null,
    createTarget: null,
  });
  return entry.label;
}

export function redo(): string | null {
  const s = get();
  const entry = s.future[s.future.length - 1];
  if (!entry || !s.doc) return null;
  set({
    doc: applyPatches(s.doc, entry.patches),
    view: entry.viewAfter,
    future: s.future.slice(0, -1),
    past: [...s.past, entry],
    revision: s.revision + 1,
    unsavedPatches: [...s.unsavedPatches, ...entry.patches],
    edit: null,
    createTarget: null,
  });
  return entry.label;
}

export function historyLabels(): { past: string[]; future: string[] } {
  const s = get();
  return { past: s.past.map((e) => e.label), future: s.future.map((e) => e.label) };
}

let toastSeq = 0;
export function toast(message: string, kind: Toast["kind"] = "info", ms = 3200): void {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, message, kind }].slice(-4) }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function setView(update: (v: ViewState) => ViewState): void {
  set((s) => ({ view: update(s.view) }));
}

export function updatePrefs(patch: Partial<Preferences>): void {
  set((s) => ({ prefs: { ...s.prefs, ...patch } }));
}
