import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, CalendarCheck, CalendarDays } from "lucide-react";
import { itemsOnDay } from "../model/tree";
import {
  addDays,
  addMonths,
  formatMonth,
  formatShortDay,
  isoWeek,
  parseDay,
  relativeDayLabel,
  startOfMonth,
  startOfWeek,
  toDayKey,
} from "../model/dates";
import { rulesForDay } from "../model/recurrence";
import { get, useApp } from "../state/store";
import { indexOf, today } from "../state/derived";
import { calendarDays, setCalendarAnchor, setVisibleDayCount, shiftCalendar, toggleDayPicker } from "../state/nav";
import { exitEdit } from "../state/items";
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
        <span className="calendar-month">{formatMonth(anchor)}</span>
        <span className="grow" />
        <button
          className={`btn btn-ghost btn-sm ${showPicker ? "is-active" : ""}`}
          aria-pressed={showPicker}
          onClick={toggleDayPicker}
        >
          <CalendarDays size={14} /> Day picker
        </button>
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
  const hasRules = !!doc && rulesForDay(doc.config.recurrenceRules, date).length > 0;
  const past = date < t;

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
        {hasRules && !past && (
          <span className={`prepared-badge ${prepared ? "is-prepared" : ""}`} title={prepared ? "Recurring tasks prepared" : "Recurring tasks can be prepared"}>
            <CalendarCheck size={13} />
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
      </div>
    </div>
  );
}

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

function DayPicker({ width, anchor, dayCount }: { width: number; anchor: string; dayCount: number }) {
  const [month, setMonth] = useState(startOfMonth(anchor));
  const weekStartsOn = useApp((s) => s.prefs.weekStartsOn);
  const showWeek = useApp((s) => s.prefs.showWeekNumber);
  const byDay = useApp((s) => indexOf(s.doc).byDay);
  const t = today();
  const first = startOfWeek(month, weekStartsOn);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i)));
  const order = weekStartsOn === "monday" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const visibleEnd = addDays(anchor, dayCount - 1);

  return (
    <div className="column day-picker" style={{ width }}>
      <header className="column-header">
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft size={15} />
        </button>
        <span className="column-title centered">{formatMonth(month)}</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight size={15} />
        </button>
      </header>
      <div className="picker-grid" style={{ gridTemplateColumns: `${showWeek ? "28px " : ""}repeat(7, 1fr)` }}>
        {showWeek && <span className="picker-head faint">Wk</span>}
        {order.map((d, i) => (
          <span key={i} className="picker-head faint">
            {WEEKDAY_LETTERS[d]}
          </span>
        ))}
        {weeks.map((week) => (
          <Week key={week[0]} week={week} month={month} showWeek={showWeek} t={t} anchor={anchor} visibleEnd={visibleEnd} byDay={byDay} />
        ))}
      </div>
      <div className="picker-foot">
        <button className="btn btn-sm" onClick={() => { setMonth(startOfMonth(t)); setCalendarAnchor(t); }}>
          Today
        </button>
      </div>
    </div>
  );
}

function Week(props: {
  week: string[];
  month: string;
  showWeek: boolean;
  t: string;
  anchor: string;
  visibleEnd: string;
  byDay: Map<string, unknown[]>;
}) {
  const { week, month, showWeek, t, anchor, visibleEnd, byDay } = props;
  return (
    <>
      {showWeek && <span className="picker-week faint">{isoWeek(week[0])}</span>}
      {week.map((d) => {
        const inMonth = d.slice(0, 7) === month.slice(0, 7);
        const inView = d >= anchor && d <= visibleEnd;
        const count = byDay.get(d)?.length ?? 0;
        return (
          <button
            key={d}
            className={`picker-day ${inMonth ? "" : "is-other"} ${d === t ? "is-today" : ""} ${inView ? "is-in-view" : ""}`}
            onClick={() => setCalendarAnchor(d)}
            data-day-picker={d}
            title={toDayKey(parseDay(d))}
          >
            {Number(d.slice(8))}
            {count > 0 && <span className="picker-dot" />}
          </button>
        );
      })}
    </>
  );
}
