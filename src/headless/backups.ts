// Document backups for cascade-cli and the MCP server, written to the same
// folder the desktop app uses, so "Restore from Backup…" in the app also
// offers copies taken before agent edits.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BACKUP_MAX_PER_DOC, fnv1a64, parseBackupName } from "../model/hash";

/** The app's bundle identifier (tauri.conf.json), which names its data folder. */
const APP_ID = "io.github.pizzacatz.cascade";
const PORTABLE_DIR = "cascade-data";

/** Tauri's appLocalDataDir as the app would resolve it on this machine. */
export function appLocalDataDir(): string {
  const env = process.env;
  // Portable mode: an explicit data folder, or `cascade-data` next to the CLI
  // (like the app, which looks next to its AppImage/executable).
  if (env.CASCADE_DATA_DIR) return join(env.CASCADE_DATA_DIR, "data", APP_ID);
  const script = process.argv[1];
  if (script) {
    try {
      const portable = join(dirname(realpathSync(script)), PORTABLE_DIR);
      if (existsSync(portable) && statSync(portable).isDirectory()) return join(portable, "data", APP_ID);
    } catch {
      // Not a real file (e.g. a test runner); fall through.
    }
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_ID);
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_ID);
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), APP_ID);
}

export function backupDirFor(docPath: string): string {
  return join(appLocalDataDir(), "document-backups", fnv1a64(docPath));
}

export interface BackupInfo {
  /** File name, usable as a reference. */
  id: string;
  time: number;
  size: number;
}

export function listBackups(docPath: string): BackupInfo[] {
  const dir = backupDirFor(docPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const meta = parseBackupName(name);
      if (!meta) return [];
      try {
        return [{ id: name, time: meta.time, size: statSync(join(dir, name)).size }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.time - a.time);
}

export function readBackup(docPath: string, id: string): string {
  if (!parseBackupName(id)) throw new Error(`Not a backup: ${id}`);
  return readFileSync(join(backupDirFor(docPath), id), "utf8");
}

/**
 * Store a copy of `text` as a backup of `docPath`, unless the newest backup
 * already has this content. Keeps the newest BACKUP_MAX_PER_DOC copies.
 * Returns the backup id (existing or new).
 */
export function writeBackup(docPath: string, text: string, now = Date.now()): string {
  const dir = backupDirFor(docPath);
  const hash = fnv1a64(text);
  const existing = listBackups(docPath);
  if (existing[0] && parseBackupName(existing[0].id)?.hash === hash) return existing[0].id;
  mkdirSync(dir, { recursive: true });
  const id = `${Math.max(now, (existing[0]?.time ?? 0) + 1)}.${hash}.col`;
  const tmp = join(dir, `.${id}.${process.pid}.tmp`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, join(dir, id));
  for (const old of listBackups(docPath).slice(BACKUP_MAX_PER_DOC)) {
    try {
      unlinkSync(join(dir, old.id));
    } catch {
      // Already gone.
    }
  }
  return id;
}
