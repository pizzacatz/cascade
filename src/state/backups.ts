// Restoring a document from its automatic backups (see files.ts saveUnlocked
// and platform writeBackup). Restoring is one undoable step in the open
// document, never a silent overwrite of the file.

import type { Doc, Item } from "../model/types";
import { normalizeViewState, parseDocument } from "../model/format";
import { buildIndex, isInTrash } from "../model/tree";
import { basename, platform, type BackupEntry } from "../platform";
import { get, set, toast, transact } from "./store";
import { openPath } from "./files";

export interface DocCounts {
  items: number;
  tasks: number;
  finished: number;
}

export function countItems(doc: Doc): DocCounts {
  const ix = buildIndex(doc);
  const live = Object.values(doc.items).filter((it) => !isInTrash(ix, it.id));
  const tasks = live.filter((it) => it.type === "task");
  return { items: live.length, tasks: tasks.length, finished: tasks.filter((t) => t.finished).length };
}

export interface DocDiff {
  /** Items that exist now but not in the backup (restoring removes them). */
  added: Item[];
  /** Items in the backup that are gone now (restoring brings them back). */
  removed: Item[];
  /** Items present in both whose content or place differs. */
  changed: Item[];
}

const FIELDS: (keyof Item)[] = ["type", "text", "finished", "parentId", "position", "scheduleDate", "schedulePosition", "color", "icon"];

function differs(a: Item, b: Item): boolean {
  return FIELDS.some((f) => (a[f] ?? null) !== (b[f] ?? null)) || a.tags.join(",") !== b.tags.join(",");
}

/** What changed from `backup` to `current`. */
export function diffDocs(current: Doc, backup: Doc): DocDiff {
  const added: Item[] = [];
  const changed: Item[] = [];
  for (const it of Object.values(current.items)) {
    const old = backup.items[it.id];
    if (!old) added.push(it);
    else if (differs(it, old)) changed.push(it);
  }
  const removed = Object.values(backup.items).filter((it) => !current.items[it.id]);
  return { added, removed, changed };
}

export interface LoadedBackup {
  entry: BackupEntry;
  text: string;
  doc: Doc;
}

export async function listDocumentBackups(): Promise<BackupEntry[]> {
  const path = get().filePath;
  if (!path) return [];
  return platform().listBackups(path);
}

export async function loadBackup(entry: BackupEntry): Promise<LoadedBackup> {
  const path = get().filePath;
  if (!path) throw new Error("No document is open");
  const text = await platform().readBackup(path, entry.id);
  return { entry, text, doc: parseDocument(text).doc };
}

/** Replace the open document's content with a backup, as one undoable step. */
export function restoreBackup(b: LoadedBackup): boolean {
  const s = get();
  if (!s.doc) return false;
  const ids = new Set(Object.keys(b.doc.items));
  const ok = transact(
    "Restore backup",
    (d) => {
      d.items = b.doc.items;
      d.config = { ...b.doc.config, viewState: d.config.viewState };
    },
    { view: (v) => normalizeViewState(v, ids, b.doc.config.spaces) },
  );
  if (ok) {
    set({ edit: null, createTarget: null });
    toast(`Restored the backup from ${formatBackupTime(b.entry.time)} — Undo (Ctrl+Z) to go back`, "success", 6000);
  } else toast("The backup is identical to the current document");
  return ok;
}

/** "List (backup 2026-09-25 1430).col" next to the original. */
export function backupCopyName(originalPath: string, time: number): string {
  const d = new Date(time);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
  return originalPath.replace(/\.col$/i, "") + ` (backup ${stamp}).col`;
}

/** Save the backup next to the original under a new name and open it. */
export async function openBackupAsCopy(b: LoadedBackup): Promise<string | null> {
  const orig = get().filePath;
  if (!orig) return null;
  const p = platform();
  const base = backupCopyName(orig, b.entry.time);
  let path = base;
  for (let n = 2; await p.exists(path); n++) path = base.replace(/\)\.col$/i, ` ${n}).col`);
  try {
    await p.writeTextAtomic(path, b.text);
  } catch (e) {
    toast(`Could not save the copy: ${String(e)}`, "error", 6000);
    return null;
  }
  if (await openPath(path)) toast(`Opened the backup as ${basename(path)}`, "success");
  return path;
}

export function formatBackupTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function relativeAge(time: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
