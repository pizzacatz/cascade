import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, BookmarkCheck, Info, Bug, CalendarCheck } from "lucide-react";
import { addDays, formatLongDay } from "../../model/dates";
import { MonthGrid, dayStatus } from "../MonthGrid";
import { breadcrumb, buildIndex } from "../../model/tree";
import { computeStats } from "../../model/progression";
import { useApp, updatePrefs, historyLabels, type PrintScopeRef } from "../../state/store";
import { indexOf, today } from "../../state/derived";
import { closeOverlay, openOverlay } from "../../state/overlays";
import { scopeLabel, stackItems, startStack } from "../../state/stack";
import { instantiateTemplate } from "../../state/items";
import { preparePreview, prepareDayWithToast, templateItems } from "../../state/config";
import type { StackTimer } from "../../state/prefs";
import { platform } from "../../platform";
import { Modal } from "./Modal";
import { Logo } from "../Welcome";

// ---------------------------------------------------------------------------
// Stack setup
// ---------------------------------------------------------------------------

const TIMERS: { type: StackTimer["type"]; label: string; hint: string }[] = [
  { type: "none", label: "No timer", hint: "Work through tasks without a time constraint." },
  { type: "duration", label: "Duration", hint: "A total time budget for the session." },
  { type: "until", label: "Until", hint: "Work until a wall-clock time." },
  { type: "pomodoro", label: "Pomodoro", hint: "Alternate focused work and short breaks." },
];

export function StackOverlay({ scope }: { scope: PrintScopeRef }) {
  const cfg = useApp((s) => s.prefs.stack);
  const doc = useApp((s) => s.doc);
  const view = useApp((s) => s.view);
  const ix = indexOf(doc);
  // "What to Execute": the column (or day/space) versus the selection.
  const selIds = view.focusedView === "calendar" ? view.calendarSelection : view.columnsSelection;
  const selectionScope: PrintScopeRef | null =
    scope.kind === "selection" ? scope : selIds.length ? { kind: "selection", ids: selIds } : null;
  const columnScope: PrintScopeRef = (() => {
    if (scope.kind !== "selection") return scope;
    const first = ix.items[scope.ids[0]];
    if (view.focusedView === "calendar" && first?.scheduleDate) return { kind: "day", date: first.scheduleDate };
    return { kind: "column", parentId: first?.parentId ?? view.currentSpaceId };
  })();
  const [which, setWhich] = useState<"column" | "selection">(scope.kind === "selection" ? "selection" : "column");
  const active = which === "selection" && selectionScope ? selectionScope : columnScope;
  const tasks = useMemo(
    () => stackItems(ix, active, { recursive: cfg.recursive, includeFinished: cfg.includeFinished }),
    [ix, active, cfg.recursive, cfg.includeFinished],
  );
  const done = tasks.filter((t) => t.finished).length;
  const setCfg = (patch: Partial<typeof cfg>) => updatePrefs({ stack: { ...cfg, ...patch } });
  const setTimer = (patch: Partial<StackTimer>) => setCfg({ timer: { ...cfg.timer, ...patch } });
  const sizeSel = (key: keyof typeof cfg.fontSizes, label: string) => (
    <label className="field-inline">
      <span>{label}</span>
      <div className="segmented">
        {[1, 2, 3].map((n) => (
          <button key={n} aria-pressed={cfg.fontSizes[key] === n} onClick={() => setCfg({ fontSizes: { ...cfg.fontSizes, [key]: n } })}>
            {["S", "M", "L"][n - 1]}
          </button>
        ))}
      </div>
    </label>
  );

  return (
    <Modal
      title="Stack"
      icon={<Layers size={16} />}
      width={580}
      height="min(88vh, 760px)"
      footer={
        <>
          <button className="btn" disabled={!tasks.length} onClick={() => startStack(active, false)}>
            Run in window
          </button>
          <button className="btn btn-primary" disabled={!tasks.length} autoFocus onClick={() => startStack(active, true)}>
            Start
          </button>
        </>
      }
    >
      <div className="stack-v">
        <div className="field">
          <span className="field-label">What to Execute</span>
          <div className="segmented">
            <button aria-pressed={which === "column"} onClick={() => setWhich("column")}>
              {columnScope.kind === "day" ? "Day" : columnScope.kind === "space" ? "Space" : "Column"} · {scopeLabel(columnScope)}
            </button>
            <button aria-pressed={which === "selection"} disabled={!selectionScope} onClick={() => setWhich("selection")}>
              Selection{selectionScope?.kind === "selection" ? ` (${selectionScope.ids.length})` : ""}
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Stack Options</span>
          <div className="segmented">
            <button aria-pressed={!cfg.recursive} onClick={() => setCfg({ recursive: false })}>
              Individual tasks
            </button>
            <button aria-pressed={cfg.recursive} onClick={() => setCfg({ recursive: true })}>
              Individual tasks (recursive)
            </button>
          </div>
          <span className="field-hint">{cfg.recursive ? "Tasks inside folders are included." : "Folders are ignored; only tasks at this level."}</span>
        </div>
        <label className="field-inline">
          <span>Add Finished Tasks</span>
          <input type="checkbox" className="switch" checked={cfg.includeFinished} onChange={(e) => setCfg({ includeFinished: e.target.checked })} />
        </label>
        <label className="field-inline">
          <span>
            Don't Sync Status
            <span className="field-hint block">When on, completing a task in the stack doesn't mark it finished in the document.</span>
          </span>
          <input type="checkbox" className="switch" checked={!cfg.syncFinishedStatus} onChange={(e) => setCfg({ syncFinishedStatus: !e.target.checked })} />
        </label>
        <div className="field">
          <div className="row">
            <span className="field-label grow">Tasks</span>
            <span className="muted small">
              Progress {done} / {tasks.length}
            </span>
          </div>
          <div className="stack-progress">
            <div className="stack-progress-bar" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
          </div>
          <div className="stack-preview">
            {tasks.length === 0 && <p className="muted">No tasks in this scope.</p>}
            {tasks.slice(0, 200).map((t) => (
              <div key={t.id} className={`stack-preview-row ${t.finished ? "is-strike" : ""}`}>
                <span className="checkbox">{t.finished ? "✓" : ""}</span>
                <span className="ellipsis grow">{t.text || "Untitled"}</span>
                <span className="faint small ellipsis">{breadcrumb(ix, t.id).join(" › ")}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">Timer</span>
          <div className="segmented">
            {TIMERS.map((t) => (
              <button key={t.type} aria-pressed={cfg.timer.type === t.type} onClick={() => setTimer({ type: t.type })}>
                {t.label}
              </button>
            ))}
          </div>
          <span className="field-hint">{TIMERS.find((t) => t.type === cfg.timer.type)?.hint}</span>
        </div>
        {cfg.timer.type === "duration" && (
          <div className="row">
            {[5, 10, 15, 25, 30, 45, 60, 90].map((m) => (
              <button key={m} className={`btn btn-sm ${cfg.timer.durationMinutes === m ? "btn-primary" : ""}`} onClick={() => setTimer({ durationMinutes: m })}>
                {m} min
              </button>
            ))}
          </div>
        )}
        {cfg.timer.type === "until" && (
          <label className="field">
            <span className="field-label">End time</span>
            <input className="input" type="time" value={cfg.timer.untilTime} onChange={(e) => setTimer({ untilTime: e.target.value || "17:00" })} style={{ width: 140 }} />
          </label>
        )}
        {cfg.timer.type === "pomodoro" && (
          <div className="row">
            <label className="field">
              <span className="field-label">Work (min)</span>
              <input className="input" type="number" min={1} max={180} value={cfg.timer.workMinutes} onChange={(e) => setTimer({ workMinutes: Math.max(1, Number(e.target.value) || 25) })} style={{ width: 100 }} />
            </label>
            <label className="field">
              <span className="field-label">Break (min)</span>
              <input className="input" type="number" min={1} max={60} value={cfg.timer.breakMinutes} onChange={(e) => setTimer({ breakMinutes: Math.max(1, Number(e.target.value) || 5) })} style={{ width: 100 }} />
            </label>
          </div>
        )}
        <details>
          <summary className="muted">Display</summary>
          <div className="stack-v" style={{ marginTop: 8 }}>
            <label className="field-inline">
              <span>Display breadcrumb</span>
              <input type="checkbox" className="switch" checked={cfg.displayBreadcrumb} onChange={(e) => setCfg({ displayBreadcrumb: e.target.checked })} />
            </label>
            {sizeSel("breadcrumb", "Breadcrumb size")}
            {sizeSel("task", "Task size")}
            {sizeSel("heading", "Heading size")}
            {sizeSel("text", "Text size")}
          </div>
        </details>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Template picker (in-document template items)
// ---------------------------------------------------------------------------

export function TemplateOverlay({ target }: { target: { parentId: string } | { date: string } }) {
  const doc = useApp((s) => s.doc);
  const ix = indexOf(doc);
  const list = templateItems(doc);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const choose = (i: number) => {
    const t = list[i];
    if (!t) return;
    closeOverlay();
    instantiateTemplate(t.id, target);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") setActive((a) => Math.min(list.length - 1, a + 1));
      else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
      else if (e.key === "Enter") choose(active);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <Modal title="Insert template" icon={<BookmarkCheck size={16} />} width={480}>
      {list.length === 0 ? (
        <p className="muted">
          No templates yet. Turn any folder into a template (right-click → Turn into → Template) and its contents can be inserted anywhere or prepared
          onto the calendar by recurrence rules.
        </p>
      ) : (
        <div className="template-list" ref={ref} role="listbox">
          {list.map((t, i) => (
            <button key={t.id} className={`template-row ${i === active ? "is-active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <strong>{t.text || "Untitled template"}</strong>
              <span className="faint">{breadcrumb(ix, t.id).join(" › ")}</span>
              <span className="muted">{ix.children.get(t.id)?.length ?? 0} items</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

export function AboutOverlay() {
  return (
    <Modal title="About Cascade" icon={<Info size={16} />} width={440}>
      <div className="about">
        <Logo size={56} />
        <h3>Cascade 0.1.0</h3>
        <p className="muted">
          An open-source, horizontal, column-based nested to-do list. Documents are plain <code>.col</code> JSON files you own; nothing leaves your
          machine.
        </p>
        <p className="muted">Released under the MIT License.</p>
        <button className="btn" onClick={() => void platform().openUrl("https://github.com/pizzacatz/cascade")}>
          Project page
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Debug tools (support diagnostics; enable in Settings › General)
// ---------------------------------------------------------------------------

export function DebugOverlay({ tab }: { tab: "speed" | "drag" | "state" }) {
  const state = useApp((s) => s);
  const [result, setResult] = useState<string>("");
  const setTab = (t: "speed" | "drag" | "state") => openOverlay({ kind: "debug", tab: t });
  const bench = () => {
    if (!state.doc) return;
    const n = 20;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) buildIndex(state.doc);
    const t1 = performance.now();
    const ix = buildIndex(state.doc);
    for (let i = 0; i < n; i++) computeStats(ix, state.doc.config.progressionMode, today());
    const t2 = performance.now();
    setResult(
      `${Object.keys(state.doc.items).length} items\nbuildIndex: ${((t1 - t0) / n).toFixed(2)} ms\ncomputeStats: ${((t2 - t1) / n).toFixed(2)} ms`,
    );
  };
  return (
    <Modal title="State debug tools" icon={<Bug size={16} />} width={900} height="min(80vh, 720px)">
      <div className="tabs">
        {(["speed", "drag", "state"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
            {t === "speed" ? "Speed" : t === "drag" ? "Drag & drop" : "State"}
          </button>
        ))}
      </div>
      <div className="debug-body">
        {tab === "speed" && (
          <div className="stack-v">
            <button className="btn" onClick={bench}>
              Run rendering benchmark
            </button>
            <pre className="debug-pre">{result}</pre>
          </div>
        )}
        {tab === "drag" && <pre className="debug-pre">{JSON.stringify(state.drag, null, 2) ?? "No drag in progress (start dragging to inspect)."}</pre>}
        {tab === "state" && (
          <pre className="debug-pre">
            {JSON.stringify(
              {
                filePath: state.filePath,
                revision: state.revision,
                savedRevision: state.savedRevision,
                view: state.view,
                createTarget: state.createTarget,
                edit: state.edit,
                history: historyLabels(),
              },
              null,
              2,
            )}
          </pre>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Prepare recurring tasks: pick a day, then confirm with a preview.
// ---------------------------------------------------------------------------

export function PrepareOverlay({ date }: { date?: string }) {
  const doc = useApp((s) => s.doc);
  const weekStartsOn = useApp((s) => s.prefs.weekStartsOn);
  const t = today();
  const [day, setDay] = useState(date && date >= t ? date : t);
  const [month, setMonth] = useState(day);
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const ix = indexOf(doc);
  const prepared = !!doc?.config.preparedDays.includes(day);
  const preview = preparePreview(doc, day);

  const move = (delta: number) => {
    const next = addDays(day, delta);
    if (next < t) return;
    setDay(next);
    setMonth(next);
  };
  const apply = () => {
    closeOverlay();
    prepareDayWithToast(day);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (step === "pick") {
        if (e.key === "ArrowLeft") move(-1);
        else if (e.key === "ArrowRight") move(1);
        else if (e.key === "ArrowUp") move(-7);
        else if (e.key === "ArrowDown") move(7);
        else if (e.key === "Enter") setStep("confirm");
        else return;
      } else {
        if (e.key === "Backspace") setStep("pick");
        else if (e.key === "Enter" && preview.items.length && !prepared) apply();
        else return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <Modal
      title="Prepare recurring tasks"
      icon={<CalendarCheck size={16} />}
      width={440}
      footer={
        step === "pick" ? (
          <>
            <span className="muted grow small">←↑↓→ choose a day · Enter continue</span>
            <button className="btn btn-primary" onClick={() => setStep("confirm")}>
              Continue
            </button>
          </>
        ) : (
          <>
            <span className="muted grow small">Backspace back</span>
            <button className="btn" onClick={() => setStep("pick")}>
              Back
            </button>
            <button className="btn btn-primary" disabled={!preview.items.length || prepared} onClick={apply}>
              Apply
            </button>
          </>
        )
      }
    >
      {step === "pick" ? (
        <MonthGrid
          month={month}
          today={t}
          weekStartsOn={weekStartsOn}
          selected={day}
          status={(d) => dayStatus(ix, d)}
          disabled={(d) => d < t}
          onSelect={(d) => {
            setDay(d);
            setStep("confirm");
          }}
          onMonthChange={setMonth}
        />
      ) : (
        <div className="stack-v">
          <div>
            <strong>{formatLongDay(day)}</strong>
          </div>
          {prepared ? (
            <p className="muted">This day is already prepared.</p>
          ) : preview.rules.length === 0 ? (
            <p className="muted">No matching rule for this day.</p>
          ) : (
            <>
              <div className="muted small">{preview.rules.map((r) => r.name).join(", ")}</div>
              <div className="prepare-preview">
                {preview.items.map((it, i) => (
                  <div key={`${it.id}-${i}`} className={`recurring-preview type-${it.type}`}>
                    {it.type === "task" && <span className="checkbox" />}
                    <span className="ellipsis">{it.text || "Untitled"}</span>
                  </div>
                ))}
                {!preview.items.length && <p className="muted">The matching rules have no templates to copy.</p>}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
