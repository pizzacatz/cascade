// Document lifecycle (new / open / close), atomic autosave with local backups,
// recent files, and persistence of preferences and print settings.

import type { Doc } from "../model/types";
import { parseDocument, serializeDocument, normalizeViewState } from "../model/format";
import { defaultViewState } from "../model/defaults";
import { basename, displayName, platform } from "../platform";
import { get, set, toast, updatePrefs, useApp } from "./store";
import { normalizePreferences } from "./prefs";
import { normalizePrintSettings } from "../print/settings";
import { DOC_TEMPLATES, type DocTemplate } from "./templates";

const PREFS_STORE = "preferences.json";
const PRINT_STORE = "printing.json";
const RECENT_LIMIT = 12;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;

const lastBackupAt = new Map<string, number>();

function withViewState(doc: Doc): Doc {
  const s = get();
  return { ...doc, config: { ...doc.config, viewState: s.view } };
}

function addRecent(path: string) {
  const prefs = get().prefs;
  const recentFiles = [path, ...prefs.recentFiles.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
  updatePrefs({ recentFiles, lastOpenedDocumentPath: path });
}

export function clearRecentFiles() {
  updatePrefs({ recentFiles: [] });
}

function updateTitle() {
  const s = get();
  const name = s.filePath ? displayName(s.filePath) : null;
  platform()
    .setTitle(name ? `${name} — Cascade` : "Cascade")
    .catch(() => {});
}

function loadDoc(doc: Doc, path: string) {
  const view = doc.config.viewState ?? defaultViewState();
  set({
    doc,
    filePath: path,
    view,
    columnOffset: 0,
    edit: null,
    createTarget: null,
    overlay: null,
    overlayStack: [],
    past: [],
    future: [],
    revision: 0,
    savedRevision: 0,
    saveError: null,
    localStack: null,
  });
  addRecent(path);
  updateTitle();
}

/** Write the current document to disk (atomic), plus a periodic backup. */
export async function saveNow(): Promise<boolean> {
  const s = get();
  if (!s.doc || !s.filePath) return false;
  const rev = s.revision;
  let text: string;
  try {
    text = serializeDocument(withViewState(s.doc));
  } catch (e) {
    set({ saveError: (e as Error).message });
    toast(`Not saved: ${(e as Error).message}`, "error", 6000);
    return false;
  }
  try {
    await platform().writeTextAtomic(s.filePath, text);
    set((st) => ({ savedRevision: Math.max(st.savedRevision, rev), saveError: null }));
    const last = lastBackupAt.get(s.filePath) ?? 0;
    if (Date.now() - last > BACKUP_INTERVAL_MS) {
      lastBackupAt.set(s.filePath, Date.now());
      platform()
        .writeBackup(s.filePath, text)
        .catch((e) => console.warn("Backup failed", e));
    }
    return true;
  } catch (e) {
    const msg = `Could not save ${basename(s.filePath)}: ${String(e)}`;
    set({ saveError: msg });
    toast(msg, "error", 6000);
    return false;
  }
}

export async function openPath(path: string): Promise<boolean> {
  if (get().doc) await saveNow();
  let text: string;
  try {
    text = await platform().readText(path);
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${String(e)}`, "error", 6000);
    const prefs = get().prefs;
    updatePrefs({
      recentFiles: prefs.recentFiles.filter((p) => p !== path),
      lastOpenedDocumentPath: prefs.lastOpenedDocumentPath === path ? null : prefs.lastOpenedDocumentPath,
    });
    return false;
  }
  try {
    const result = parseDocument(text);
    loadDoc(result.doc, path);
    // Keep a copy of what we opened before any migration rewrites it.
    lastBackupAt.set(path, Date.now());
    platform()
      .writeBackup(path, text)
      .catch(() => {});
    if (result.shouldRewrite) {
      await saveNow();
      if (result.sourceVersion !== 4) toast(`Upgraded ${basename(path)} to the current file format`);
    }
    if (result.warnings.length) {
      toast(`Repaired ${result.warnings.length} problem${result.warnings.length === 1 ? "" : "s"} in the file`, "info", 5000);
      console.warn("Document warnings:", result.warnings);
    }
    return true;
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${(e as Error).message}`, "error", 6000);
    return false;
  }
}

export async function openDialog(): Promise<void> {
  const path = await platform().pickOpenPath();
  if (path) await openPath(path);
}

export async function newDocument(template: DocTemplate = DOC_TEMPLATES[0]): Promise<void> {
  const path = await platform().pickSavePath(template.id === "blank" ? "Untitled.col" : `${template.name}.col`);
  if (!path) return;
  if (get().doc) await saveNow();
  const doc = template.build();
  doc.config.viewState = normalizeViewState(doc.config.viewState, new Set(Object.keys(doc.items)), doc.config.spaces);
  loadDoc(doc, path);
  await saveNow();
}

export async function closeDocument(): Promise<void> {
  await saveNow();
  set({
    doc: null,
    filePath: null,
    edit: null,
    createTarget: null,
    overlay: null,
    past: [],
    future: [],
    localStack: null,
    view: defaultViewState(),
  });
  updatePrefs({ lastOpenedDocumentPath: null });
  updateTitle();
}

// ---------------------------------------------------------------------------
// Persistence wiring
// ---------------------------------------------------------------------------

function debounce(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    t = null;
    fn();
  };
  const call = () => {
    if (t) clearTimeout(t);
    t = setTimeout(run, ms);
  };
  call.flush = () => {
    if (t) {
      clearTimeout(t);
      run();
    }
  };
  return call;
}

let pendingSave: ReturnType<typeof debounce> | null = null;

export async function loadSettings(): Promise<void> {
  const p = platform();
  const [prefs, print] = await Promise.all([
    p.loadStore(PREFS_STORE).catch(() => ({})),
    p.loadStore(PRINT_STORE).catch(() => ({})),
  ]);
  set({ prefs: normalizePreferences(prefs), printSettings: normalizePrintSettings(print) });
}

export function startPersistence(): () => void {
  const p = platform();
  const saveDoc = debounce(() => void saveNow(), 400);
  pendingSave = saveDoc;
  const saveView = debounce(() => void saveNow(), 2000);
  const savePrefs = debounce(() => void p.saveStore(PREFS_STORE, get().prefs).catch(() => {}), 300);
  const savePrint = debounce(() => void p.saveStore(PRINT_STORE, get().printSettings).catch(() => {}), 300);

  const unsub = useApp.subscribe((s, prev) => {
    if (s.doc && s.revision !== prev.revision && s.filePath === prev.filePath) saveDoc();
    else if (s.doc && s.view !== prev.view && s.filePath === prev.filePath) saveView();
    if (s.prefs !== prev.prefs) savePrefs();
    if (s.printSettings !== prev.printSettings) savePrint();
  });
  const onHide = () => {
    saveDoc.flush();
    saveView.flush();
    savePrefs.flush();
  };
  window.addEventListener("beforeunload", onHide);
  document.addEventListener("visibilitychange", onHide);
  return () => {
    unsub();
    window.removeEventListener("beforeunload", onHide);
    document.removeEventListener("visibilitychange", onHide);
  };
}

export function flushPendingSave() {
  pendingSave?.flush();
}

export { basename, displayName };
