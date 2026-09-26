// Platform abstraction. Under Tauri everything goes through the plugins; in a
// plain browser (development, tests) we fall back to localStorage-backed
// documents so the UI is fully usable without the desktop shell.

import { invoke } from "@tauri-apps/api/core";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface CliPayload {
  argv: string[];
  cwd?: string;
  source?: string;
  requestId?: string;
}

export interface PortableStatus {
  enabled: boolean;
  dataDir: string | null;
  root: string | null;
  canEnable: boolean;
}

/** One automatic backup of a document; `id` is its file name. */
export interface BackupEntry {
  id: string;
  time: number;
  size: number | null;
}

export interface FileEntry {
  path: string;
  name: string;
}

export interface Platform {
  kind: "tauri" | "browser";
  // Documents
  pickOpenPath(defaultDir?: string): Promise<string | null>;
  pickSavePath(defaultName: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  /** Atomic write: temp file + rename. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Modification time (ms) and size, or null when unavailable. */
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  writeBackup(path: string, text: string): Promise<void>;
  pruneBackups(): Promise<void>;
  /** Backups of the document at `path`, newest first. */
  listBackups(path: string): Promise<BackupEntry[]>;
  readBackup(path: string, id: string): Promise<string>;
  /** Ask where to save an exported file and write it; returns the path, or null if cancelled. */
  saveExport(defaultName: string, text: string, filter: { name: string; extensions: string[] }): Promise<string | null>;
  // Preferences / settings stores
  loadStore(name: string): Promise<unknown>;
  saveStore(name: string, value: unknown): Promise<void>;
  // Clipboard
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  // Window
  showWindow(): Promise<void>;
  setTitle(title: string): Promise<void>;
  toggleFullscreen(): Promise<void>;
  openUrl(url: string): Promise<void>;
  confirm(message: string, title?: string): Promise<boolean>;
  // CLI
  getStartupPayload(): Promise<CliPayload | null>;
  markCliReady(): Promise<CliPayload[]>;
  onCliCommand(cb: (p: CliPayload) => void): Promise<() => void>;
  normalizePath(path: string, cwd?: string): Promise<string>;
  validateCliRequest(requestId: string): Promise<void>;
  completeCliRequest(requestId: string, result: unknown): Promise<void>;
  // Portable mode (desktop only)
  portableStatus(): Promise<PortableStatus | null>;
  enablePortable(): Promise<string>;
  relaunch(): Promise<void>;
}

export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const displayName = (path: string) => basename(path).replace(/\.col$/i, "");

export { fnv1a64, BACKUP_MAX_PER_DOC, BACKUP_MAX_AGE_MS } from "../model/hash";
import { fnv1a64, BACKUP_MAX_PER_DOC, BACKUP_MAX_AGE_MS, parseBackupName } from "../model/hash";

// ---------------------------------------------------------------------------
// Tauri implementation
// ---------------------------------------------------------------------------

async function tauriPlatform(): Promise<Platform> {
  const fs = await import("@tauri-apps/plugin-fs");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const storeMod = await import("@tauri-apps/plugin-store");
  const clip = await import("@tauri-apps/plugin-clipboard-manager");
  const opener = await import("@tauri-apps/plugin-opener");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { listen } = await import("@tauri-apps/api/event");
  const pathApi = await import("@tauri-apps/api/path");

  const stores = new Map<string, Awaited<ReturnType<typeof storeMod.load>>>();
  const getStore = async (name: string) => {
    let s = stores.get(name);
    if (!s) {
      s = await storeMod.load(name, { autoSave: false, defaults: {} });
      stores.set(name, s);
    }
    return s;
  };
  const backupRoot = async () => pathApi.join(await pathApi.appLocalDataDir(), "document-backups");

  return {
    kind: "tauri",
    async pickOpenPath(defaultDir) {
      const r = await dialog.open({
        multiple: false,
        directory: false,
        defaultPath: defaultDir,
        filters: [{ name: "Cascade document", extensions: ["col"] }],
      });
      return typeof r === "string" ? r : null;
    },
    async pickSavePath(defaultName) {
      const r = await dialog.save({
        defaultPath: defaultName,
        filters: [{ name: "Cascade document", extensions: ["col"] }],
      });
      if (!r) return null;
      return /\.col$/i.test(r) ? r : `${r}.col`;
    },
    readText: (path) => fs.readTextFile(path),
    async writeTextAtomic(path, text) {
      const tmp = `${path}.${Date.now().toString(36)}.tmp`;
      await fs.writeTextFile(tmp, text);
      try {
        await fs.rename(tmp, path);
      } catch (e) {
        await fs.remove(tmp).catch(() => {});
        throw e;
      }
    },
    exists: (path) => fs.exists(path),
    async stat(path) {
      try {
        const st = await fs.stat(path);
        return { mtime: st.mtime ? new Date(st.mtime).getTime() : 0, size: st.size };
      } catch {
        return null;
      }
    },
    async writeBackup(path, text) {
      const dir = await pathApi.join(await backupRoot(), fnv1a64(path));
      await fs.mkdir(dir, { recursive: true });
      const file = await pathApi.join(dir, `${Date.now()}.${fnv1a64(text)}.col`);
      await fs.writeTextFile(file, text);
      const entries = (await fs.readDir(dir)).filter((e) => e.isFile && e.name.endsWith(".col"));
      entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      for (const e of entries.slice(BACKUP_MAX_PER_DOC)) {
        await fs.remove(await pathApi.join(dir, e.name)).catch(() => {});
      }
    },
    async listBackups(path) {
      const dir = await pathApi.join(await backupRoot(), fnv1a64(path));
      if (!(await fs.exists(dir))) return [];
      const out: BackupEntry[] = [];
      for (const e of await fs.readDir(dir)) {
        const meta = e.isFile ? parseBackupName(e.name) : null;
        if (!meta) continue;
        const size = await fs
          .stat(await pathApi.join(dir, e.name))
          .then((st) => st.size)
          .catch(() => null);
        out.push({ id: e.name, time: meta.time, size });
      }
      return out.sort((a, b) => b.time - a.time);
    },
    async readBackup(path, id) {
      if (!parseBackupName(id)) throw new Error(`Not a backup: ${id}`);
      return fs.readTextFile(await pathApi.join(await backupRoot(), fnv1a64(path), id));
    },
    async saveExport(defaultName, text, filter) {
      const r = await dialog.save({ defaultPath: defaultName, filters: [filter] });
      if (!r) return null;
      const ext = filter.extensions[0];
      const path = ext && !r.toLowerCase().endsWith(`.${ext}`) ? `${r}.${ext}` : r;
      await fs.writeTextFile(path, text);
      return path;
    },
    async pruneBackups() {
      const root = await backupRoot();
      if (!(await fs.exists(root))) return;
      const cutoff = Date.now() - BACKUP_MAX_AGE_MS;
      for (const d of await fs.readDir(root)) {
        if (!d.isDirectory) continue;
        const dir = await pathApi.join(root, d.name);
        for (const f of await fs.readDir(dir)) {
          const ts = Number(f.name.split(".")[0]);
          if (Number.isFinite(ts) && ts < cutoff) await fs.remove(await pathApi.join(dir, f.name)).catch(() => {});
        }
      }
    },
    async loadStore(name) {
      const s = await getStore(name);
      return Object.fromEntries(await s.entries());
    },
    async saveStore(name, value) {
      const s = await getStore(name);
      await s.clear();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) await s.set(k, v);
      await s.save();
    },
    readClipboard: () => clip.readText().catch(() => ""),
    writeClipboard: (text) => clip.writeText(text),
    showWindow: () => invoke("show_window"),
    setTitle: (title) => getCurrentWindow().setTitle(title),
    async toggleFullscreen() {
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
    },
    openUrl: (url) => opener.openUrl(url),
    confirm: (message, title) => dialog.confirm(message, { title: title ?? "Cascade", kind: "warning" }),
    getStartupPayload: () => invoke<CliPayload | null>("get_startup_payload"),
    markCliReady: () => invoke<CliPayload[]>("mark_cli_ready"),
    async onCliCommand(cb) {
      return listen<CliPayload>("cli-command", (e) => cb(e.payload));
    },
    normalizePath: (path, cwd) => invoke<string>("normalize_path", { path, cwd: cwd ?? null }),
    validateCliRequest: (requestId) => invoke("validate_cli_request", { requestId }),
    completeCliRequest: (requestId, result) => invoke("complete_cli_request", { requestId, result }),
    portableStatus: () => invoke<PortableStatus>("portable_status").catch(() => null),
    enablePortable: () => invoke<string>("enable_portable_mode"),
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

// ---------------------------------------------------------------------------
// Browser implementation (localStorage)
// ---------------------------------------------------------------------------

const LS_DOC_PREFIX = "cascade:doc:";
const LS_STORE_PREFIX = "cascade:store:";
const LS_BACKUP_PREFIX = "cascade:backup:";

function browserPlatform(): Platform {
  const ls = window.localStorage;
  const docKey = (path: string) => LS_DOC_PREFIX + path;
  let memoryClipboard = "";
  return {
    kind: "browser",
    async pickOpenPath() {
      // Offer the documents kept in this browser, plus importing a real file.
      const paths = Object.keys(ls)
        .filter((k) => k.startsWith(LS_DOC_PREFIX))
        .map((k) => k.slice(LS_DOC_PREFIX.length));
      const file = await pickFileFromDisk();
      if (file) {
        const path = `browser://${file.name}`;
        ls.setItem(docKey(path), file.text);
        return path;
      }
      return paths[0] ?? null;
    },
    async pickSavePath(defaultName) {
      const name = window.prompt("Document name", defaultName.replace(/\.col$/i, ""));
      return name ? `browser://${name.replace(/\.col$/i, "")}.col` : null;
    },
    async readText(path) {
      const v = ls.getItem(docKey(path));
      if (v === null) throw new Error(`No such document: ${path}`);
      return v;
    },
    async writeTextAtomic(path, text) {
      ls.setItem(docKey(path), text);
    },
    exists: async (path) => ls.getItem(docKey(path)) !== null,
    stat: async () => null,
    // Backups live in localStorage too, so restoring can be tried in a browser.
    async writeBackup(path, text) {
      const prefix = `${LS_BACKUP_PREFIX}${fnv1a64(path)}:`;
      ls.setItem(`${prefix}${Date.now()}.${fnv1a64(text)}.col`, text);
      const keys = Object.keys(ls)
        .filter((k) => k.startsWith(prefix))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const k of keys.slice(BACKUP_MAX_PER_DOC)) ls.removeItem(k);
    },
    pruneBackups: async () => {},
    async listBackups(path) {
      const prefix = `${LS_BACKUP_PREFIX}${fnv1a64(path)}:`;
      return Object.keys(ls)
        .filter((k) => k.startsWith(prefix))
        .flatMap((k) => {
          const id = k.slice(prefix.length);
          const meta = parseBackupName(id);
          return meta ? [{ id, time: meta.time, size: ls.getItem(k)?.length ?? null }] : [];
        })
        .sort((a, b) => b.time - a.time);
    },
    async readBackup(path, id) {
      const v = ls.getItem(`${LS_BACKUP_PREFIX}${fnv1a64(path)}:${id}`);
      if (v === null) throw new Error(`No such backup: ${id}`);
      return v;
    },
    async saveExport(defaultName, text, filter) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: filter.extensions[0] === "ics" ? "text/calendar" : "text/plain" }));
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return defaultName;
    },
    async loadStore(name) {
      try {
        return JSON.parse(ls.getItem(LS_STORE_PREFIX + name) ?? "{}");
      } catch {
        return {};
      }
    },
    async saveStore(name, value) {
      ls.setItem(LS_STORE_PREFIX + name, JSON.stringify(value));
    },
    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return memoryClipboard;
      }
    },
    async writeClipboard(text) {
      memoryClipboard = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard permission denied; the in-memory copy still works in-app.
      }
    },
    showWindow: async () => {},
    async setTitle(title) {
      document.title = title;
    },
    async toggleFullscreen() {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    },
    async openUrl(url) {
      window.open(url, "_blank", "noopener");
    },
    confirm: async (message) => window.confirm(message),
    getStartupPayload: async () => null,
    markCliReady: async () => [],
    onCliCommand: async () => () => {},
    normalizePath: async (path) => path,
    validateCliRequest: async () => {},
    completeCliRequest: async () => {},
    portableStatus: async () => null,
    enablePortable: async () => {
      throw new Error("Portable mode needs the desktop app.");
    },
    relaunch: async () => window.location.reload(),
  };
}

function pickFileFromDisk(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".col,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

let instance: Platform | null = null;

export async function initPlatform(): Promise<Platform> {
  if (!instance) instance = isTauri ? await tauriPlatform() : browserPlatform();
  return instance;
}

/** The platform, once initPlatform() has resolved (it runs before the app mounts). */
export function platform(): Platform {
  if (!instance) throw new Error("Platform not initialised");
  return instance;
}

let windowShown = false;
/**
 * Show the (initially hidden) main window, once. Called after React has
 * committed the first frame with the document. It must not wait for
 * requestAnimationFrame: WebKitGTK does not run frames for a hidden window.
 */
export function revealWindow(): void {
  if (windowShown || !instance) return;
  windowShown = true;
  instance.showWindow().catch(() => {});
}
