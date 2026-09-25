import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, X, Undo2, GripVertical, Coffee } from "lucide-react";
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
  const item = ix.items[st.tasks[st.currentIndex]];
  const done = st.tasks.filter((t) => isStackItemDone(t)).length;
  const total = st.tasks.length;
  const allDone = !st.isRunning || done === total;
  const timer = timerState(cfg.timer, st.startedAt, st.pausedAt ?? now);
  const onBreak = timer.phase === "break";
  const itemDone = item ? isStackItemDone(item.id) : false;
  const crumbs = item && cfg.displayBreadcrumb ? breadcrumb(ix, item.id) : [];
  // The bar shows the timer when there is one, otherwise task progress.
  const barFraction = timer.fraction ?? (total ? done / total : 0);

  const controls = (
    <>
      <button className="btn btn-ghost btn-sm btn-icon" title="Previous task" aria-label="Previous task" onClick={stackPrevious} disabled={st.currentIndex === 0 || allDone}>
        <ChevronLeft size={15} />
      </button>
      {!allDone &&
        (itemDone ? (
          <button className="btn btn-sm" title="Mark incomplete" onClick={stackMarkIncomplete}>
            <Undo2 size={14} /> {!compact && "Mark incomplete"}
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" title="Mark complete" onClick={stackMarkComplete}>
            <Check size={14} /> {!compact && "Mark complete"}
          </button>
        ))}
      <button className="btn btn-ghost btn-sm btn-icon" title="Next task" aria-label="Next task" onClick={stackNext} disabled={st.currentIndex >= total - 1 || allDone}>
        <ChevronRight size={15} />
      </button>
      {cfg.timer.type !== "none" && !allDone && (
        <button className="btn btn-ghost btn-sm btn-icon" aria-label={st.pausedAt ? "Resume" : "Pause"} title={st.pausedAt ? "Resume" : "Pause"} onClick={stackTogglePause}>
          {st.pausedAt ? <Play size={14} /> : <Pause size={14} />}
        </button>
      )}
      <button className="btn btn-ghost btn-sm btn-icon" aria-label={compact ? "Expand" : "Compact runner"} title={compact ? "Back to the full window" : "Compact always-on-top runner"} onClick={() => void setCompact(!compact)}>
        {compact ? <Maximize2 size={13} /> : <Minimize2 size={14} />}
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close" title="Close" onClick={stopStack}>
        <X size={14} />
      </button>
    </>
  );

  const body = allDone ? (
    <span className="stack-message">🎉 All Done!</span>
  ) : onBreak ? (
    <span className="stack-message is-break">
      <Coffee size={14} /> Break · {timer.label}
    </span>
  ) : (
    <span
      className={`stack-current-text type-${item?.type ?? "task"} ${itemDone ? "is-strike" : ""}`}
      style={compact ? undefined : { fontSize: `${FONT_SCALE[cfg.fontSizes.task] * 1.3}em` }}
    >
      {item?.text || "—"}
    </span>
  );

  if (compact) {
    return (
      <div className="stack-compact" data-tauri-drag-region>
        <span className="stack-grip" onMouseDown={() => void startCompactDrag()} aria-hidden>
          <GripVertical size={14} />
        </span>
        <div className="stack-compact-main" data-tauri-drag-region onMouseDown={() => void startCompactDrag()}>
          {body}
          <span className="faint stack-compact-count">
            {done}/{total}
          </span>
        </div>
        {controls}
        <div className={`stack-timebar ${onBreak ? "is-break" : ""} ${timer.phase === "overtime" ? "is-over" : ""}`} style={{ width: `${barFraction * 100}%` }} />
      </div>
    );
  }

  return (
    <div className="stack-runner" role="region" aria-label="Stack">
      <div className="stack-main">
        <div className="stack-meta">
          <span className="stack-label">Stack · {st.label}</span>
          <span className="faint">
            Progress {done} / {total}
            {cfg.timer.type !== "none" && ` · ${timer.label}`}
          </span>
        </div>
        {crumbs.length > 0 && !allDone && !onBreak && (
          <div className="stack-crumbs" style={{ fontSize: `${FONT_SCALE[cfg.fontSizes.breadcrumb]}em` }}>
            {crumbs.join(" › ")}
          </div>
        )}
        <div className="stack-current">{body}</div>
        <div className="stack-progress">
          <div className={`stack-progress-bar ${onBreak ? "is-break" : ""}`} style={{ width: `${barFraction * 100}%` }} />
        </div>
      </div>
      <div className="stack-controls">{controls}</div>
    </div>
  );
}
