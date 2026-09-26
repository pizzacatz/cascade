// Application preferences (not tied to a document). Persisted by the platform
// layer; see platform/storage.ts.

import type { WeekStart } from "../model/types";

export type ThemePref = "auto" | "light" | "dark";
export type DebugMode = "disabled" | "speed" | "state" | "drag";

export interface StackTimer {
  type: "none" | "duration" | "until" | "pomodoro";
  durationMinutes: number;
  untilTime: string; // "HH:MM" local
  workMinutes: number;
  breakMinutes: number;
}

export interface StackConfig {
  timer: StackTimer;
  /** Walk into folders (true) or only take tasks at the top of the scope. */
  recursive: boolean;
  includeFinished: boolean;
  displayBreadcrumb: boolean;
  syncFinishedStatus: boolean;
  fontSizes: { breadcrumb: number; task: number; heading: number; text: number };
}

export interface Preferences {
  theme: ThemePref;
  debugMode: DebugMode;
  minColumnWidth: number;
  inlineCommandTrigger: string;
  headingShortcutTrigger: string;
  separatorShortcutTrigger: string;
  showWeekNumber: boolean;
  weekStartsOn: WeekStart;
  recentFiles: string[];
  /** When each recent document was last opened (ms), keyed by stored path. */
  recentOpenedAt: Record<string, number>;
  openLastDocumentOnStartup: boolean;
  /** Move unfinished overdue work to today when a document opens and at midnight. */
  rollOverOverdue: boolean;
  /** Rewrite `<document>.ics` next to each document on every save. */
  keepIcsCopy: boolean;
  lastOpenedDocumentPath: string | null;
  showHelp: boolean;
  hideColumnHeaders: boolean;
  /** Hide the ••• menu buttons in column headers. */
  hideColumnHeaderButtons: boolean;
  hideFloatingActionMenu: boolean;
  hideCreateItemButton: boolean;
  columnsProgressBar: "hide" | "showToAllColumns";
  compactWindowPosition: { x: number; y: number } | null;
  stack: StackConfig;
}

export const MIN_COLUMN_WIDTH = 225;
export const MAX_COLUMN_WIDTH = 500;

export function defaultPreferences(): Preferences {
  return {
    theme: "auto",
    debugMode: "disabled",
    minColumnWidth: 450,
    inlineCommandTrigger: "::",
    headingShortcutTrigger: "#",
    separatorShortcutTrigger: "---",
    showWeekNumber: false,
    weekStartsOn: "monday",
    recentFiles: [],
    recentOpenedAt: {},
    openLastDocumentOnStartup: true,
    rollOverOverdue: false,
    keepIcsCopy: false,
    lastOpenedDocumentPath: null,
    showHelp: false,
    hideColumnHeaders: false,
    hideColumnHeaderButtons: false,
    hideFloatingActionMenu: false,
    hideCreateItemButton: false,
    columnsProgressBar: "showToAllColumns",
    compactWindowPosition: null,
    stack: {
      timer: { type: "none", durationMinutes: 25, untilTime: "17:00", workMinutes: 25, breakMinutes: 5 },
      recursive: true,
      includeFinished: false,
      displayBreadcrumb: true,
      syncFinishedStatus: true,
      fontSizes: { breadcrumb: 1, task: 2, heading: 2, text: 1 },
    },
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const str = (v: unknown, d: string) => (typeof v === "string" && v.length > 0 ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function normalizePreferences(raw: unknown): Preferences {
  const d = defaultPreferences();
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const st = (typeof r.stack === "object" && r.stack ? r.stack : {}) as Record<string, unknown>;
  const timer = (typeof st.timer === "object" && st.timer ? st.timer : {}) as Record<string, unknown>;
  const fonts = (typeof st.fontSizes === "object" && st.fontSizes ? st.fontSizes : {}) as Record<string, unknown>;
  const pos = r.compactWindowPosition as { x?: unknown; y?: unknown } | null | undefined;
  return {
    theme: r.theme === "light" || r.theme === "dark" ? r.theme : "auto",
    debugMode: (["disabled", "speed", "state", "drag"] as const).includes(r.debugMode as DebugMode)
      ? (r.debugMode as DebugMode)
      : "disabled",
    // 320 was an earlier default; upgrade it to the current one.
    minColumnWidth: r.minColumnWidth === 320 ? d.minColumnWidth : clamp(num(r.minColumnWidth, d.minColumnWidth), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH),
    inlineCommandTrigger: str(r.inlineCommandTrigger, d.inlineCommandTrigger),
    headingShortcutTrigger: str(r.headingShortcutTrigger, d.headingShortcutTrigger),
    separatorShortcutTrigger: str(r.separatorShortcutTrigger, d.separatorShortcutTrigger),
    showWeekNumber: bool(r.showWeekNumber, d.showWeekNumber),
    weekStartsOn: r.weekStartsOn === "sunday" ? "sunday" : "monday",
    recentFiles: Array.isArray(r.recentFiles)
      ? r.recentFiles.filter((p): p is string => typeof p === "string").slice(0, 12)
      : [],
    recentOpenedAt:
      r.recentOpenedAt && typeof r.recentOpenedAt === "object"
        ? Object.fromEntries(Object.entries(r.recentOpenedAt as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number"))
        : {},
    openLastDocumentOnStartup: bool(r.openLastDocumentOnStartup, d.openLastDocumentOnStartup),
    rollOverOverdue: bool(r.rollOverOverdue, d.rollOverOverdue),
    keepIcsCopy: bool(r.keepIcsCopy, d.keepIcsCopy),
    lastOpenedDocumentPath: typeof r.lastOpenedDocumentPath === "string" ? r.lastOpenedDocumentPath : null,
    showHelp: bool(r.showHelp, d.showHelp),
    hideColumnHeaders: bool(r.hideColumnHeaders, d.hideColumnHeaders),
    hideColumnHeaderButtons: bool(r.hideColumnHeaderButtons, d.hideColumnHeaderButtons),
    hideFloatingActionMenu: bool(r.hideFloatingActionMenu, d.hideFloatingActionMenu),
    hideCreateItemButton: bool(r.hideCreateItemButton, d.hideCreateItemButton),
    columnsProgressBar: r.columnsProgressBar === "hide" ? "hide" : "showToAllColumns",
    compactWindowPosition:
      pos && typeof pos.x === "number" && typeof pos.y === "number" ? { x: pos.x, y: pos.y } : null,
    stack: {
      timer: {
        type: (["none", "duration", "until", "pomodoro"] as const).includes(timer.type as StackTimer["type"])
          ? (timer.type as StackTimer["type"])
          : "none",
        durationMinutes: clamp(num(timer.durationMinutes, 25), 1, 600),
        untilTime: typeof timer.untilTime === "string" && /^\d{2}:\d{2}$/.test(timer.untilTime) ? timer.untilTime : "17:00",
        workMinutes: clamp(num(timer.workMinutes, 25), 1, 180),
        breakMinutes: clamp(num(timer.breakMinutes, 5), 1, 60),
      },
      recursive: bool(st.recursive, true),
      includeFinished: bool(st.includeFinished, false),
      displayBreadcrumb: bool(st.displayBreadcrumb, true),
      syncFinishedStatus: bool(st.syncFinishedStatus, true),
      fontSizes: {
        breadcrumb: clamp(num(fonts.breadcrumb, 1), 1, 3),
        task: clamp(num(fonts.task, 2), 1, 3),
        heading: clamp(num(fonts.heading, 2), 1, 3),
        text: clamp(num(fonts.text, 1), 1, 3),
      },
    },
  };
}
