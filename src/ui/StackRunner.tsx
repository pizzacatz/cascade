import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, Square, Undo2, GripVertical, Coffee } from "lucide-react";
import { breadcrumb } from "../model/tree";
import { useApp } from "../state/store";
import { indexOf } from "../state/derived";
import {
  isStackItemDone,
  setCompact,
  stackMarkComplete,
  stackMarkIncomplete,
  stackNext,
  stackPrevious,
  stackTogglePause,
  startCompactDrag,
  stopStack,
  timerState,
} from "../state/stack";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const FONT_SCALE = [0, 0.85, 1, 1.35];

export function StackRunner({ compact = false }: { compact?: boolean }) {
  const st = useApp((s) => s.localStack)!;
  const doc = useApp((s) => s.doc);
  const cfg = useApp((s) => s.prefs.stack);
  const now = useNow(!!st?.isRunning && !st.pausedAt);
  if (!st || !doc) return null;
  const ix = indexOf(doc);
  const id = st.tasks[st.currentIndex];
  const item = ix.items[id];
  const tasks = st.tasks.filter((t) => ix.items[t]?.type === "task");
  const done = tasks.filter((t) => isStackItemDone(t)).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const timer = timerState(cfg.timer, st.startedAt, st.pausedAt ?? now);
  const itemDone = item ? isStackItemDone(item.id) : false;
  const crumbs = item && cfg.displayBreadcrumb ? breadcrumb(ix, item.id) : [];
  const sizeFor = (t: string | undefined) =>
    t === "heading" ? cfg.fontSizes.heading : t === "text" ? cfg.fontSizes.text : cfg.fontSizes.task;

  const timerEl =
    cfg.timer.type !== "none" || !compact ? (
      <span className={`stack-timer phase-${timer.phase}`} title={timer.phase === "break" ? "Break" : "Timer"}>
        {timer.phase === "break" && <Coffee size={13} />}
        {timer.label}
      </span>
    ) : null;

  if (compact) {
    return (
      <div className="stack-compact" data-tauri-drag-region>
        <span className="stack-grip" onMouseDown={() => void startCompactDrag()} aria-hidden>
          <GripVertical size={14} />
        </span>
        {item?.type === "task" && (
          <button className={`checkbox ${itemDone ? "is-checked" : ""}`} aria-label="Complete" onClick={itemDone ? stackMarkIncomplete : stackMarkComplete}>
            {itemDone && <Check size={12} strokeWidth={3} />}
          </button>
        )}
        <span className={`stack-compact-text ${itemDone ? "is-strike" : ""}`} data-tauri-drag-region onMouseDown={() => void startCompactDrag()}>
          {item?.text || "—"}
        </span>
        <span className="faint stack-compact-count">
          {st.currentIndex + 1}/{st.tasks.length}
        </span>
        {timerEl}
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next" onClick={stackNext}>
          <ChevronRight size={14} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Expand" onClick={() => void setCompact(false)}>
          <Maximize2 size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="stack-runner" role="region" aria-label="Stack">
      <div className="stack-main">
        <div className="stack-meta">
          <span className="stack-label">Stack · {st.label}</span>
          <span className="faint">
            {st.currentIndex + 1} of {st.tasks.length} · {done}/{tasks.length} done ({pct}%)
          </span>
        </div>
        {crumbs.length > 0 && (
          <div className="stack-crumbs" style={{ fontSize: `${FONT_SCALE[cfg.fontSizes.breadcrumb]}em` }}>
            {crumbs.join(" › ")}
          </div>
        )}
        <div className={`stack-current type-${item?.type ?? "task"} ${itemDone ? "is-strike" : ""}`} style={{ fontSize: `${FONT_SCALE[sizeFor(item?.type)] * 1.3}em` }}>
          {item?.text || "—"}
        </div>
        <div className="stack-progress">
          <div className="stack-progress-bar" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="stack-controls">
        {timerEl}
        <button className="btn btn-ghost btn-icon" aria-label="Previous" onClick={stackPrevious} disabled={st.currentIndex === 0}>
          <ChevronLeft size={16} />
        </button>
        {item?.type === "task" &&
          (itemDone ? (
            <button className="btn" onClick={stackMarkIncomplete}>
              <Undo2 size={15} /> Incomplete
            </button>
          ) : (
            <button className="btn btn-primary" onClick={stackMarkComplete}>
              <Check size={15} /> Complete
            </button>
          ))}
        <button className="btn btn-ghost btn-icon" aria-label="Next" onClick={stackNext} disabled={st.currentIndex >= st.tasks.length - 1}>
          <ChevronRight size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label={st.pausedAt ? "Resume" : "Pause"} onClick={stackTogglePause}>
          {st.pausedAt ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Compact runner" title="Compact always-on-top runner" onClick={() => void setCompact(true)}>
          <Minimize2 size={15} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Stop stack" onClick={stopStack}>
          <Square size={14} />
        </button>
      </div>
    </div>
  );
}
