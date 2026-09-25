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

export interface FileEntry {
  path: string;
  name: string;
}

export interface Platform {
  kind: "tauri" | "browser";
  // Documents
  pickOpenPath(): Promise<string | null>;
  pickSavePath(defaultName: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  /** Atomic write: temp file + rename. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeBackup(path: string, text: string): Promise<void>;
  pruneBackups(): Promise<void>;
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
}

export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const displayName = (path: string) => basename(path).replace(/\.col$/i, "");

// ---------------------------------------------------------------------------
// FNV-1a 64-bit, used to name backup folders/files deterministically.
// ---------------------------------------------------------------------------
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export const BACKUP_MAX_PER_DOC = 10;
export const BACKUP_MAX_AGE_MS = 5 * 24 * 3600 * 1000;

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
    async pickOpenPath() {
      const r = await dialog.open({
        multiple: false,
        directory: false,
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
  };
}

// ---------------------------------------------------------------------------
// Browser implementation (localStorage)
// ---------------------------------------------------------------------------

const LS_DOC_PREFIX = "cascade:doc:";
const LS_STORE_PREFIX = "cascade:store:";

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
    writeBackup: async () => {},
    pruneBackups: async () => {},
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
