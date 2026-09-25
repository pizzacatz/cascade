// Document lifecycle (new / open / close), atomic autosave with local backups,
// recent files, and persistence of preferences and print settings.

import type { Doc } from "../model/types";
import { parseDocument, serializeDocument, normalizeViewState } from "../model/format";
import { defaultViewState } from "../model/defaults";
import { applyPatches } from "immer";
import { basename, displayName, fnv1a64, platform, type PortableStatus } from "../platform";
import { get, set, toast, updatePrefs, useApp } from "./store";
import { normalizePreferences } from "./prefs";
import { normalizePrintSettings } from "../print/settings";
import { DOC_TEMPLATES, type DocTemplate } from "./templates";

const PREFS_STORE = "preferences.json";
const PRINT_STORE = "printing.json";
const RECENT_LIMIT = 12;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;

const lastBackupAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Portable mode: documents stored next to the app (e.g. on the same USB stick)
// are remembered relative to it, so they still open when the stick mounts at
// a different path on another computer.
// ---------------------------------------------------------------------------

const PORTABLE_PREFIX = "portable:";
let portable: PortableStatus | null = null;

export const portableStatus = () => portable;

function portableRoot(): string | null {
  return portable?.enabled && portable.root ? portable.root.replace(/\/+$/, "") : null;
}

/** Path as remembered in preferences. */
export function toStoredPath(path: string): string {
  const root = portableRoot();
  return root && path.startsWith(`${root}/`) ? PORTABLE_PREFIX + path.slice(root.length + 1) : path;
}

/** Path as usable on this machine. */
export function fromStoredPath(stored: string): string {
  const root = portableRoot();
  if (!stored.startsWith(PORTABLE_PREFIX)) return stored;
  return root ? `${root}/${stored.slice(PORTABLE_PREFIX.length)}` : stored.slice(PORTABLE_PREFIX.length);
}

export async function enablePortableMode(): Promise<void> {
  try {
    const dir = await platform().enablePortable();
    await saveNow();
    toast(`Portable data folder created at ${dir}. Restarting…`, "success");
    setTimeout(() => void platform().relaunch(), 900);
  } catch (e) {
    toast(String(e), "error", 8000);
  }
}

function withViewState(doc: Doc): Doc {
  const s = get();
  return { ...doc, config: { ...doc.config, viewState: s.view } };
}

function addRecent(path: string) {
  const prefs = get().prefs;
  const stored = toStoredPath(path);
  const recentFiles = [stored, ...prefs.recentFiles.filter((p) => p !== stored && fromStoredPath(p) !== path)].slice(0, RECENT_LIMIT);
  updatePrefs({ recentFiles, lastOpenedDocumentPath: stored });
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
    unsavedPatches: [],
  });
  addRecent(path);
  updateTitle();
}

// ---------------------------------------------------------------------------
// Disk state: what we last read or wrote, so outside edits (another program,
// cascade-cli, an agent, a text editor) are detected and never overwritten.
// ---------------------------------------------------------------------------

let disk: { path: string; hash: string; mtime: number } | null = null;
/** Saves and external-change checks run one at a time. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function rememberDisk(path: string, text: string) {
  const st = await platform().stat(path);
  disk = { path, hash: fnv1a64(text), mtime: st?.mtime ?? 0 };
}

/**
 * If the open file changed on disk, reload it, re-applying edits made here
 * since the last save. Returns true when a change was merged in.
 */
async function checkDisk(): Promise<boolean> {
  const s = get();
  if (!s.doc || !s.filePath || !disk || disk.path !== s.filePath) return false;
  const st = await platform().stat(s.filePath);
  if (!st || st.mtime === disk.mtime) return false;
  let text: string;
  try {
    text = await platform().readText(s.filePath);
  } catch {
    return false;
  }
  const hash = fnv1a64(text);
  if (hash === disk.hash) {
    disk.mtime = st.mtime;
    return false;
  }
  let parsed;
  try {
    parsed = parseDocument(text);
  } catch (e) {
    // Half-written or invalid: try again on the next check.
    console.warn("External change could not be read yet", e);
    return false;
  }
  disk = { path: s.filePath, hash, mtime: st.mtime };
  const cur = get();
  let doc = parsed.doc;
  let reapplied = 0;
  let skipped = 0;
  for (const patch of cur.unsavedPatches) {
    try {
      doc = applyPatches(doc, [patch]);
      reapplied++;
    } catch {
      skipped++;
    }
  }
  const view = normalizeViewState(cur.view, new Set(Object.keys(doc.items)), doc.config.spaces);
  const editOk = cur.edit && doc.items[cur.edit.itemId];
  set({
    doc,
    view: { ...view, calendarCurrentDate: cur.view.calendarCurrentDate },
    edit: editOk ? cur.edit : null,
    past: [],
    future: [],
    unsavedPatches: reapplied ? cur.unsavedPatches : [],
    // Only a merge produces something new to save.
    revision: reapplied ? cur.revision + 1 : cur.revision,
  });
  toast(
    skipped
      ? `${basename(s.filePath)} changed on disk; reloaded (${skipped} of your recent edits conflicted and were dropped)`
      : `${basename(s.filePath)} changed on disk; reloaded`,
    skipped ? "error" : "info",
  );
  return reapplied > 0;
}

/** Write the current document to disk (atomic), plus a periodic backup. */
export function saveNow(): Promise<boolean> {
  return serialized(saveUnlocked);
}

async function saveUnlocked(): Promise<boolean> {
  // Never overwrite a change made outside the app: merge it in first.
  await checkDisk();
  const s = get();
  if (!s.doc || !s.filePath) return false;
  const rev = s.revision;
  const patchCount = s.unsavedPatches.length;
  let text: string;
  try {
    text = serializeDocument(withViewState(s.doc));
  } catch (e) {
    set({ saveError: (e as Error).message });
    toast(`Not saved: ${(e as Error).message}`, "error", 6000);
    return false;
  }
  try {
    if (disk && disk.path === s.filePath && disk.hash === fnv1a64(text)) {
      set((st) => ({ savedRevision: Math.max(st.savedRevision, rev), unsavedPatches: st.unsavedPatches.slice(patchCount) }));
      return true;
    }
    await platform().writeTextAtomic(s.filePath, text);
    await rememberDisk(s.filePath, text);
    set((st) => ({
      savedRevision: Math.max(st.savedRevision, rev),
      saveError: null,
      unsavedPatches: st.unsavedPatches.slice(patchCount),
    }));
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

/** Poll the open file for outside changes (about once a second). */
export function startWatchingDisk(): () => void {
  const timer = setInterval(() => {
    void serialized(async () => {
      if (await checkDisk()) await saveUnlocked();
    });
  }, 1000);
  return () => clearInterval(timer);
}

export async function openPath(pathOrStored: string): Promise<boolean> {
  const stored = pathOrStored;
  const path = fromStoredPath(pathOrStored);
  if (get().doc) await saveNow();
  let text: string;
  try {
    text = await platform().readText(path);
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${String(e)}`, "error", 6000);
    const prefs = get().prefs;
    updatePrefs({
      recentFiles: prefs.recentFiles.filter((p) => p !== stored && p !== path),
      lastOpenedDocumentPath: prefs.lastOpenedDocumentPath === stored ? null : prefs.lastOpenedDocumentPath,
    });
    return false;
  }
  try {
    const result = parseDocument(text);
    loadDoc(result.doc, path);
    await rememberDisk(path, text);
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
  const path = await platform().pickOpenPath(portableRoot() ?? undefined);
  if (path) await openPath(path);
}

export async function newDocument(template: DocTemplate = DOC_TEMPLATES[0]): Promise<void> {
  const name = template.id === "blank" ? "Untitled.col" : `${template.name}.col`;
  const root = portableRoot();
  const path = await platform().pickSavePath(root ? `${root}/${name}` : name);
  if (!path) return;
  if (get().doc) await saveNow();
  disk = null;
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
  portable = await p.portableStatus().catch(() => null);
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
