import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, MoreHorizontal, CalendarCheck, AlertTriangle, Repeat, Pin, PinOff, ArrowRightToLine } from "lucide-react";
import type { Item } from "../model/types";
import { childrenOf, itemsOnDay } from "../model/tree";
import {
  addDays,
  addMonths,
  formatMonth,
  formatShortDay,
  relativeDayLabel,
  startOfMonth,
} from "../model/dates";
import { rulesForDay } from "../model/recurrence";
import { get, useApp } from "../state/store";
import { indexOf, today } from "../state/derived";
import { calendarDays, setCalendarAnchor, setVisibleDayCount, shiftCalendar, toggleDayPicker } from "../state/nav";
import { exitEdit } from "../state/items";
import { prepareDayWithToast } from "../state/config";
import { overdueItems, rollOverDay, rollOverOverdue, unfinishedOnDay } from "../state/schedule";
import { ProgressRing } from "./ProgressRing";
import { MonthGrid, dayStatus } from "./MonthGrid";
import { CreateRow, EditFooter } from "./CreateRow";
import { openOverlay } from "../state/overlays";
import { ItemRow } from "./ItemRow";

export function CalendarView() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const minWidth = useApp((s) => s.prefs.minColumnWidth);
  const showPicker = useApp((s) => s.view.showCalendarDayPicker);
  const focused = useApp((s) => s.view.focusedView === "calendar");
  const anchor = useApp((s) => s.view.calendarCurrentDate ?? today());

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(1, Math.floor((width || minWidth) / minWidth));
  const dayCount = Math.max(1, fit - (showPicker ? 1 : 0));
  setVisibleDayCount(dayCount);
  const colWidth = width ? width / fit : minWidth;
  const days = useApp((s) => calendarDays(s, dayCount).join("|")).split("|");

  return (
    <section className={`calendar-view ${focused ? "is-focused" : ""}`} aria-label="Calendar">
      <div className="calendar-toolbar">
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous day" onClick={() => shiftCalendar(-1)}>
          <ChevronLeft size={15} />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setCalendarAnchor(today())}>
          Today
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next day" onClick={() => shiftCalendar(1)}>
          <ChevronRight size={15} />
        </button>
        <MonthButton anchor={anchor} dayCount={dayCount} pinned={showPicker} />
        <span className="grow" />
        <OverdueButton />
      </div>
      <div className="calendar-strip" ref={ref}>
        {showPicker && <DayPicker width={colWidth} anchor={anchor} dayCount={dayCount} />}
        {days.map((d) => (
          <DayColumn key={d} date={d} width={colWidth} />
        ))}
      </div>
    </section>
  );
}

function DayColumn({ date, width }: { date: string; width: number }) {
  const doc = useApp((s) => s.doc);
  const editingHere = useApp((s) => !!s.edit && s.doc?.items[s.edit.itemId]?.scheduleDate === date && s.view.focusedView === "calendar");
  const busy = useApp((s) => !!s.edit || s.drag?.status === "active");
  const isTarget = useApp((s) => s.createTarget?.view === "calendar" && s.createTarget.date === date);
  const prepared = useApp((s) => s.doc?.config.preparedDays.includes(date) ?? false);
  const dropEnd = useApp((s) => {
    const t = s.drag?.status === "active" ? s.drag.target : null;
    return t?.kind === "day-end" && t.date === date;
  });
  const ix = indexOf(doc);
  const items = itemsOnDay(ix, date);
  const t = today();
  const rel = relativeDayLabel(date, t);
  const past = date < t;
  const rules = doc ? rulesForDay(doc.config.recurrenceRules, date) : [];
  const broken = rules.filter((r) => r.templates.some((id) => ix.items[id]?.type !== "template"));
  // What preparing this day would create (template contents), shown greyed.
  const preview =
    !past && !prepared
      ? rules.flatMap((r) =>
          r.templates
            .map((id) => ix.items[id])
            .filter((x): x is Item => !!x && x.type === "template")
            .flatMap((tpl) => {
              const kids = childrenOf(ix, tpl.id);
              return kids.length ? kids : [tpl];
            }),
        )
      : [];
  const tasks = items.filter((i) => i.type === "task");
  const progress = tasks.length ? tasks.filter((i) => i.finished).length / tasks.length : -1;
  const pending = past && doc ? unfinishedOnDay(date) : 0;

  const openMenu = (x: number, y: number) =>
    openOverlay({ kind: "context", x, y, target: { type: "surface", view: "calendar", date } });

  return (
    <div className={`column day-column ${date === t ? "is-today" : ""} ${past ? "is-past" : ""} ${isTarget ? "is-create-target" : ""}`} style={{ width }}>
      <header
        className="column-header"
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
      >
        <span className="column-title">
          {rel && <strong>{rel} · </strong>}
          {formatShortDay(date)}
        </span>
        {broken.length > 0 && (
          <button
            className="btn btn-ghost btn-sm btn-icon day-warning"
            title={`Recurring rule "${broken[0].name}" refers to a missing template — open its settings`}
            onClick={() => openOverlay({ kind: "docSettings", tab: "recurrence" })}
          >
            <AlertTriangle size={14} />
          </button>
        )}
        {past && pending > 0 && (
          <button
            className="btn btn-ghost btn-sm day-rollover"
            title={`Move ${pending} unfinished item${pending === 1 ? "" : "s"} to today`}
            onClick={() => rollOverDay(date)}
          >
            <ArrowRightToLine size={13} /> Today
          </button>
        )}
        {progress >= 0 && (
          <span className="column-progress" title={`${Math.round(progress * 100)} %`}>
            <ProgressRing value={progress} size={14} />
          </span>
        )}
        <button
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Day menu"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.bottom + 4);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </header>
      <div
        className={`column-body ${dropEnd ? "drop-end" : ""}`}
        data-day={date}
        onMouseDown={(e) => {
          if (e.button === 0 && e.target === e.currentTarget && get().edit) exitEdit();
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
      >
        {items.map((it) => (
          <ItemRow key={it.id} item={it} view="calendar" />
        ))}
        {!busy && <CreateRow target={{ view: "calendar", date }} focused={isTarget} hint={null} />}
        {editingHere && <EditFooter allowChild={false} />}
        {rules.length > 0 && !past && (
          <div className="recurring-block">
            <div className="recurring-divider">
              <Repeat size={12} />
              <span className="ellipsis grow">{rules.map((r) => r.name).join(", ")}</span>
              <button className="link-btn" onClick={() => openOverlay({ kind: "docSettings", tab: "recurrence", ruleId: rules[0].id })}>
                Edit rule
              </button>
            </div>
            {prepared ? (
              <div className="recurring-prepared">
                <CalendarCheck size={13} /> Prepared
              </div>
            ) : (
              <>
                {preview.map((it, i) => (
                  <div key={`${it.id}-${i}`} className={`recurring-preview type-${it.type}`}>
                    {it.type === "task" && <span className="checkbox" />}
                    <span className="ellipsis">{it.text || "Untitled"}</span>
                  </div>
                ))}
                <button className="btn btn-sm recurring-prepare" onClick={() => prepareDayWithToast(date)}>
                  <CalendarCheck size={13} /> Prepare recurring tasks
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DayPickerGrid({ anchor, dayCount, onPicked, extraFooter }: { anchor: string; dayCount: number; onPicked?: () => void; extraFooter?: React.ReactNode }) {
  const weekStartsOn = useApp((s) => s.prefs.weekStartsOn);
  const showWeek = useApp((s) => s.prefs.showWeekNumber);
  const doc = useApp((s) => s.doc);
  const dropDate = useApp((s) => (s.drag?.status === "active" && s.drag.target?.kind === "day-end" ? s.drag.target.date : null));
  const ix = indexOf(doc);
  const t = today();
  const visibleEnd = addDays(anchor, dayCount - 1);
  const away = t < anchor || t > visibleEnd;
  return (
    <MonthGrid
      month={anchor}
      today={t}
      weekStartsOn={weekStartsOn}
      showWeekNumbers={showWeek}
      inRange={(d) => d >= anchor && d <= visibleEnd}
      status={(d) => dayStatus(ix, d)}
      onSelect={(d) => {
        setCalendarAnchor(d);
        onPicked?.();
      }}
      // The picker follows the strip: changing month moves the whole calendar.
      onMonthChange={(m) => setCalendarAnchor(m < startOfMonth(anchor) ? addMonths(anchor, -1) : addMonths(anchor, 1))}
      dayProps={(d) => ({ "data-day-picker": d, ...(d === dropDate ? { "data-drop": "1" } : {}) })}
      footer={
        <div className="picker-foot">
          {away && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setCalendarAnchor(t);
                onPicked?.();
              }}
            >
              Today
            </button>
          )}
          <span className="grow" />
          {extraFooter}
        </div>
      }
    />
  );
}

/** The docked picker: a column at the left of the day strip. */
function DayPicker({ width, anchor, dayCount }: { width: number; anchor: string; dayCount: number }) {
  return (
    <div className="column day-picker" style={{ width }}>
      <DayPickerGrid
        anchor={anchor}
        dayCount={dayCount}
        extraFooter={
          <button className="btn btn-ghost btn-sm" title="Close the docked day picker (the month name opens it again)" onClick={toggleDayPicker}>
            <PinOff size={13} /> Unpin
          </button>
        }
      />
    </div>
  );
}

/**
 * The month name. Clicking it drops the day picker down under it; holding a
 * dragged item over it springs the picker open so any day can be a drop target.
 */
function MonthButton({ anchor, dayCount, pinned }: { anchor: string; dayCount: number; pinned: boolean }) {
  const [open, setOpen] = useState(false);
  const [byDrag, setByDrag] = useState(false);
  const dragging = useApp((s) => s.drag?.status === "active");
  const wrap = useRef<HTMLDivElement>(null);
  const hover = useRef<number | undefined>(undefined);

  // A picker opened by a drag closes when the drag ends.
  useEffect(() => {
    if (byDrag && !dragging) {
      setOpen(false);
      setByDrag(false);
    }
  }, [dragging, byDrag]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(hover.current), []);

  return (
    <div className="month-button-wrap" ref={wrap}>
      <button
        className={`btn btn-ghost btn-sm calendar-month ${open || pinned ? "is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={pinned ? "Hide the day picker" : "Pick a day"}
        onClick={() => {
          if (pinned) toggleDayPicker();
          else setOpen((o) => !o);
        }}
        onMouseEnter={() => {
          if (!get().drag || get().drag?.status !== "active" || open || pinned) return;
          hover.current = window.setTimeout(() => {
            setOpen(true);
            setByDrag(true);
          }, 350);
        }}
        onMouseLeave={() => window.clearTimeout(hover.current)}
      >
        {formatMonth(anchor)}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="popover day-picker-popover" role="dialog" aria-label="Day picker">
          <DayPickerGrid
            anchor={anchor}
            dayCount={dayCount}
            onPicked={() => !byDrag && setOpen(false)}
            extraFooter={
              <button
                className="btn btn-ghost btn-sm"
                title="Keep the day picker open as a column"
                onClick={() => {
                  setOpen(false);
                  toggleDayPicker();
                }}
              >
                <Pin size={13} /> Pin
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}

/** "N overdue → Today" when unfinished work sits on past days. */
function OverdueButton() {
  const count = useApp((s) => (s.doc ? overdueCount(s.doc.items, today()) : 0));
  if (!count) return null;
  return (
    <button className="btn btn-ghost btn-sm overdue-btn" title="Move unfinished tasks from past days to today" onClick={() => rollOverOverdue()}>
      <ArrowRightToLine size={13} /> {count} overdue → Today
    </button>
  );
}

const overdueCache = new WeakMap<object, { day: string; n: number }>();
function overdueCount(items: object, day: string): number {
  const c = overdueCache.get(items);
  if (c && c.day === day) return c.n;
  const n = overdueItems(day).length;
  overdueCache.set(items, { day, n });
  return n;
}
