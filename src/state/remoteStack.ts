// Remote Stack: mirror the running Stack to a phone on the local network.
// The backend serves a small page over HTTP (see src-tauri/src/remote.rs);
// this module pushes the stack state to it and runs the commands pressed on
// the phone.

import { create } from "zustand";
import { breadcrumb } from "../model/tree";
import { isTauri } from "../platform";
import { get, useApp, type AppState } from "./store";
import { indexOf } from "./derived";
import {
  isStackItemDone,
  stackMarkComplete,
  stackMarkIncomplete,
  stackNext,
  stackPrevious,
  stackTogglePause,
  timerState,
} from "./stack";

export interface RemoteInfo {
  url: string;
  qrSvg: string;
}

/** Whether remote control is on, and the address to open on the phone. */
export const useRemoteStack = create<{ info: RemoteInfo | null; busy: boolean }>(() => ({ info: null, busy: false }));

export const remoteStackAvailable = isTauri;

export interface RemoteStackPayload {
  running: boolean;
  allDone: boolean;
  label: string;
  text: string;
  breadcrumb: string[];
  done: number;
  total: number;
  itemDone: boolean;
  onBreak: boolean;
  canPrevious: boolean;
  canNext: boolean;
  timer: {
    type: string;
    phase: string;
    label: string;
    remainingMs: number | null;
    elapsedMs: number;
    paused: boolean;
  } | null;
}

/** The stack state the phone sees. Only stack fields — never the document. */
export function remoteStackPayload(s: AppState, now = Date.now()): RemoteStackPayload {
  const st = s.localStack;
  if (!st || !s.doc) {
    return { running: false, allDone: false, label: "", text: "", breadcrumb: [], done: 0, total: 0, itemDone: false, onBreak: false, canPrevious: false, canNext: false, timer: null };
  }
  const ix = indexOf(s.doc);
  const id = st.tasks[st.currentIndex];
  const item = ix.items[id];
  const done = st.tasks.filter((t) => isStackItemDone(t)).length;
  const total = st.tasks.length;
  const allDone = !st.isRunning || done === total;
  const cfg = s.prefs.stack;
  const at = st.pausedAt ?? now;
  const tm = timerState(cfg.timer, st.startedAt, at);
  return {
    running: true,
    allDone,
    label: st.label,
    text: item?.text ?? "",
    breadcrumb: item && cfg.displayBreadcrumb ? breadcrumb(ix, item.id) : [],
    done,
    total,
    itemDone: item ? isStackItemDone(item.id) : false,
    onBreak: tm.phase === "break",
    canPrevious: !allDone && st.currentIndex > 0,
    canNext: !allDone && st.currentIndex < total - 1,
    timer:
      cfg.timer.type === "none"
        ? null
        : {
            type: cfg.timer.type,
            phase: tm.phase,
            label: tm.label,
            remainingMs: tm.remainingMs,
            elapsedMs: Math.max(0, at - st.startedAt),
            paused: !!st.pausedAt,
          },
  };
}

let unsubscribe: (() => void) | null = null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

function push() {
  invoke("remote_stack_update", { payload: remoteStackPayload(get()) }).catch(() => {});
}

function run(cmd: string) {
  const st = get().localStack;
  if (!st) return;
  switch (cmd) {
    case "complete":
      if (!isStackItemDone(st.tasks[st.currentIndex])) stackMarkComplete();
      break;
    case "incomplete":
      stackMarkIncomplete();
      break;
    case "next":
      stackNext();
      break;
    case "previous":
      stackPrevious();
      break;
    case "pause":
      if (get().prefs.stack.timer.type !== "none") stackTogglePause();
      break;
  }
  push();
}

export async function startRemoteStack(): Promise<void> {
  if (!remoteStackAvailable || useRemoteStack.getState().info || !get().localStack) return;
  useRemoteStack.setState({ busy: true });
  try {
    const info = await invoke<RemoteInfo>("remote_stack_start");
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>("remote-stack-command", (e) => run(e.payload));
    // Re-push on every store change (the backend ignores identical payloads),
    // and periodically so timer phase changes reach the phone.
    const unsub = useApp.subscribe((s, prev) => {
      if (!s.localStack) {
        void stopRemoteStack();
        return;
      }
      if (s.localStack !== prev.localStack || s.doc !== prev.doc || s.prefs.stack !== prev.prefs.stack) push();
    });
    const timer = setInterval(push, 5000);
    unsubscribe = () => {
      unlisten();
      unsub();
      clearInterval(timer);
    };
    useRemoteStack.setState({ info, busy: false });
    push();
  } catch (e) {
    useRemoteStack.setState({ busy: false });
    throw e;
  }
}

export async function stopRemoteStack(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  const was = useRemoteStack.getState().info;
  useRemoteStack.setState({ info: null, busy: false });
  if (was) await invoke("remote_stack_stop").catch(() => {});
}
