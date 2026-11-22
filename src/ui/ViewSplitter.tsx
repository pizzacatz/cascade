import { get, updatePrefs, useApp } from "../state/store";
import { MAX_CALENDAR_SPLIT, MIN_CALENDAR_SPLIT, defaultPreferences } from "../state/prefs";

const clamp = (n: number) => Math.min(MAX_CALENDAR_SPLIT, Math.max(MIN_CALENDAR_SPLIT, n));
const STEP = 0.05;

/**
 * The bar between the columns and the calendar. Dragging it changes how much
 * height the calendar gets; double-click resets to an even split. While
 * dragging, only a CSS variable changes; the preference is saved on release.
 */
export function ViewSplitter() {
  const split = useApp((s) => s.prefs.calendarSplit);
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const views = e.currentTarget.parentElement!;
    const rect = views.getBoundingClientRect();
    let next = split;
    document.body.classList.add("is-resizing-views");
    const onMove = (m: MouseEvent) => {
      next = clamp((rect.bottom - m.clientY) / rect.height);
      views.style.setProperty("--calendar-split", String(next));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing-views");
      updatePrefs({ calendarSplit: next });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="view-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize calendar"
      aria-valuemin={Math.round(MIN_CALENDAR_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_CALENDAR_SPLIT * 100)}
      aria-valuenow={Math.round(split * 100)}
      tabIndex={-1}
      title="Drag to resize the calendar · double-click to reset"
      onMouseDown={onMouseDown}
      onDoubleClick={() => updatePrefs({ calendarSplit: defaultPreferences().calendarSplit })}
      onKeyDown={(e) => {
        const d = e.key === "ArrowUp" ? STEP : e.key === "ArrowDown" ? -STEP : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        updatePrefs({ calendarSplit: clamp(get().prefs.calendarSplit + d) });
      }}
    />
  );
}
