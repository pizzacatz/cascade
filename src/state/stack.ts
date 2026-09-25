// Stack: a one-task-at-a-time focus session over a scope of tasks, with an
// optional timer (duration / until / pomodoro) and a compact always-on-top
// runner window.

import type { Item } from "../model/types";
import { isContainerType } from "../model/types";
import { childrenOf, itemsOnDay, topLevelOnly, type DocIndex } from "../model/tree";
import { isTauri } from "../platform";
import { get, set, toast, updatePrefs, type PrintScopeRef } from "./store";
import { indexOf } from "./derived";
import { setFinished } from "./items";
import { closeAllOverlays, openOverlay } from "./overlays";
import { currentPrintScope } from "./printing";
import type { StackTimer } from "./prefs";

/** Flatten a scope into the ordered list of items the stack walks through. */
export function stackItems(ix: DocIndex, scope: PrintScopeRef): Item[] {
  const out: Item[] = [];
  const walk = (list: Item[]) => {
    for (const it of list) {
      if (it.type === "separator") continue;
      if (isContainerType(it.type)) walk(childrenOf(ix, it.id));
      else if (it.type === "task" || it.type === "heading" || it.type === "text") out.push(it);
    }
  };
  switch (scope.kind) {
    case "selection":
      walk(topLevelOnly(ix, scope.ids).map((id) => ix.items[id]).filter(Boolean));
      break;
    case "column":
      walk(childrenOf(ix, scope.parentId));
      break;
    case "space":
      walk(childrenOf(ix, scope.spaceId));
      break;
    case "day":
      walk(itemsOnDay(ix, scope.date));
      break;
  }
  return out;
}

export function scopeLabel(scope: PrintScopeRef): string {
  const s = get();
  const ix = indexOf(s.doc);
  switch (scope.kind) {
    case "selection":
      return scope.ids.length === 1 ? ix.items[scope.ids[0]]?.text || "Selection" : `${scope.ids.length} items`;
    case "column":
      return ix.items[scope.parentId]?.text || ix.spaces.find((x) => x.id === scope.parentId)?.name || "Column";
    case "space":
      return ix.spaces.find((x) => x.id === scope.spaceId)?.name ?? "Space";
    case "day":
      return scope.date;
  }
}

export function openStack(scope: PrintScopeRef | null = currentPrintScope()): void {
  if (!scope) return;
  openOverlay({ kind: "stack", scope });
}

export function startStack(scope: PrintScopeRef, compact: boolean): void {
  const s = get();
  const ix = indexOf(s.doc);
  const items = stackItems(ix, scope);
  if (!items.some((x) => x.type === "task")) {
    toast("There are no tasks to stack in this scope", "error");
    return;
  }
  const firstOpen = items.findIndex((x) => x.type === "task" && !x.finished);
  const now = Date.now();
  set({
    localStack: {
      tasks: items.map((x) => x.id),
      currentIndex: Math.max(0, firstOpen),
      isRunning: true,
      startedAt: now,
      taskStartedAt: now,
      pausedAt: null,
      compact: false,
      onBreak: false,
      label: scopeLabel(scope),
    },
  });
  closeAllOverlays();
  if (compact) void setCompact(true);
}

export function stopStack(): void {
  const st = get().localStack;
  if (st?.compact) void setCompact(false);
  set({ localStack: null });
}

function go(delta: number) {
  const st = get().localStack;
  if (!st) return;
  const next = Math.min(st.tasks.length - 1, Math.max(0, st.currentIndex + delta));
  set({ localStack: { ...st, currentIndex: next, taskStartedAt: Date.now() } });
}

export const stackNext = () => go(1);
export const stackPrevious = () => go(-1);

export function stackMarkComplete(): void {
  const s = get();
  const st = s.localStack;
  if (!st) return;
  const id = st.tasks[st.currentIndex];
  if (s.prefs.stack.syncFinishedStatus && s.doc?.items[id]?.type === "task") setFinished([id], true);
  finishedLocally.add(id);
  if (st.currentIndex < st.tasks.length - 1) go(1);
  else {
    toast("Stack complete — nice work!", "success");
    set({ localStack: { ...st, isRunning: false } });
  }
}

export function stackMarkIncomplete(): void {
  const s = get();
  const st = s.localStack;
  if (!st) return;
  const id = st.tasks[st.currentIndex];
  if (s.prefs.stack.syncFinishedStatus) setFinished([id], false);
  finishedLocally.delete(id);
}

export function stackTogglePause(): void {
  const st = get().localStack;
  if (!st) return;
  if (st.pausedAt) {
    const paused = Date.now() - st.pausedAt;
    set({
      localStack: { ...st, pausedAt: null, startedAt: st.startedAt + paused, taskStartedAt: st.taskStartedAt + paused },
    });
  } else set({ localStack: { ...st, pausedAt: Date.now() } });
}

/** Items finished during this session when sync is off. */
const finishedLocally = new Set<string>();

export function isStackItemDone(id: string): boolean {
  const s = get();
  return s.prefs.stack.syncFinishedStatus ? !!s.doc?.items[id]?.finished : finishedLocally.has(id);
}

export interface TimerState {
  label: string;
  remainingMs: number | null;
  phase: "work" | "break" | "none" | "overtime";
  fraction: number | null;
}

/** Timer math for the session timer. */
export function timerState(timer: StackTimer, startedAt: number, now: number): TimerState {
  const elapsed = Math.max(0, now - startedAt);
  switch (timer.type) {
    case "none":
      return { label: formatDuration(elapsed), remainingMs: null, phase: "none", fraction: null };
    case "duration": {
      const total = timer.durationMinutes * 60_000;
      const remaining = total - elapsed;
      return {
        label: remaining >= 0 ? formatDuration(remaining) : `+${formatDuration(-remaining)}`,
        remainingMs: remaining,
        phase: remaining >= 0 ? "work" : "overtime",
        fraction: Math.min(1, elapsed / total),
      };
    }
    case "until": {
      const [h, m] = timer.untilTime.split(":").map(Number);
      const end = new Date(startedAt);
      end.setHours(h, m, 0, 0);
      if (end.getTime() <= startedAt) end.setDate(end.getDate() + 1);
      const total = end.getTime() - startedAt;
      const remaining = end.getTime() - now;
      return {
        label: remaining >= 0 ? formatDuration(remaining) : `+${formatDuration(-remaining)}`,
        remainingMs: remaining,
        phase: remaining >= 0 ? "work" : "overtime",
        fraction: Math.min(1, elapsed / total),
      };
    }
    case "pomodoro": {
      const work = timer.workMinutes * 60_000;
      const brk = timer.breakMinutes * 60_000;
      const inCycle = elapsed % (work + brk);
      const onBreak = inCycle >= work;
      const remaining = onBreak ? work + brk - inCycle : work - inCycle;
      return {
        label: formatDuration(remaining),
        remainingMs: remaining,
        phase: onBreak ? "break" : "work",
        fraction: onBreak ? (inCycle - work) / brk : inCycle / work,
      };
    }
  }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Compact runner window
// ---------------------------------------------------------------------------

let savedGeometry: { width: number; height: number; x: number; y: number } | null = null;

export async function setCompact(on: boolean): Promise<void> {
  const st = get().localStack;
  if (st) set({ localStack: { ...st, compact: on } });
  if (!isTauri) return;
  const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  try {
    if (on) {
      const scale = await w.scaleFactor();
      const size = (await w.innerSize()).toLogical(scale);
      const pos = (await w.outerPosition()).toLogical(scale);
      savedGeometry = { width: size.width, height: size.height, x: pos.x, y: pos.y };
      await w.unmaximize().catch(() => {});
      await w.setDecorations(false);
      await w.setMinSize(new LogicalSize(320, 50)).catch(() => {});
      await w.setSize(new LogicalSize(420, 56));
      await w.setAlwaysOnTop(true);
      const p = get().prefs.compactWindowPosition;
      if (p) await w.setPosition(new LogicalPosition(p.x, p.y)).catch(() => {});
    } else {
      const scale = await w.scaleFactor();
      const pos = (await w.outerPosition()).toLogical(scale);
      updatePrefs({ compactWindowPosition: { x: pos.x, y: pos.y } });
      await w.setAlwaysOnTop(false);
      await w.setDecorations(true);
      await w.setMinSize(new LogicalSize(640, 480)).catch(() => {});
      if (savedGeometry) {
        await w.setSize(new LogicalSize(savedGeometry.width, savedGeometry.height));
        await w.setPosition(new LogicalPosition(savedGeometry.x, savedGeometry.y)).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("Compact mode failed", e);
  }
}

export async function startCompactDrag(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging().catch(() => {});
}
