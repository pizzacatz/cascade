// A month calendar grid shared by the calendar's day picker, the "prepare
// recurring tasks" dialog and the schedule page. Each day can show a small
// completion bar: green when all its tasks are done, red when tasks remain
// (today and past), grey for future days.

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WeekStart } from "../model/types";
import { addDays, addMonths, daysInMonth, formatMonth, isoWeek, parseDay, startOfMonth, startOfWeek } from "../model/dates";
import type { DocIndex } from "../model/tree";
import { itemsOnDay } from "../model/tree";

export interface DayStatus {
  total: number;
  done: number;
}

export function dayStatus(ix: DocIndex, date: string): DayStatus {
  const tasks = itemsOnDay(ix, date).filter((i) => i.type === "task");
  return { total: tasks.length, done: tasks.filter((t) => t.finished).length };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** US-style week number (weeks start on Sunday; week 1 contains Jan 1). */
function usWeek(key: string): number {
  const d = parseDay(key);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.round((d.getTime() - jan1.getTime()) / 86_400_000);
  return Math.floor((days + jan1.getDay()) / 7) + 1;
}

interface Props {
  month: string; // any day in the month to show
  today: string;
  weekStartsOn: WeekStart;
  showWeekNumbers?: boolean;
  selected?: string | null;
  /** Days currently shown elsewhere (e.g. the calendar strip), lightly highlighted. */
  inRange?: (date: string) => boolean;
  status?: (date: string) => DayStatus | null;
  disabled?: (date: string) => boolean;
  onSelect: (date: string) => void;
  onHover?: (date: string) => void;
  onMonthChange: (month: string) => void;
  /** Extra attributes per day, e.g. drop-target markers. */
  dayProps?: (date: string) => Record<string, string>;
  footer?: ReactNode;
}

export function MonthGrid(p: Props) {
  const first = startOfMonth(p.month);
  const gridStart = startOfWeek(first, p.weekStartsOn);
  const d = parseDay(first);
  const last = addDays(first, daysInMonth(d.getFullYear(), d.getMonth()) - 1);
  // Only as many week rows as the month needs.
  const weeks: string[][] = [];
  for (let w = gridStart; w <= last; w = addDays(w, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  const order = p.weekStartsOn === "monday" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const weekNo = (key: string) => (p.weekStartsOn === "sunday" ? usWeek(key) : isoWeek(addDays(key, 3)));

  return (
    <div className="month-grid">
      <div className="month-grid-head">
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous month" onClick={() => p.onMonthChange(addMonths(first, -1))}>
          <ChevronLeft size={15} />
        </button>
        <span className="month-grid-title">{formatMonth(first)}</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next month" onClick={() => p.onMonthChange(addMonths(first, 1))}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="month-grid-days" style={{ gridTemplateColumns: `${p.showWeekNumbers ? "30px " : ""}repeat(7, 1fr)` }}>
        {p.showWeekNumbers && <span className="month-grid-dow faint">Wk</span>}
        {order.map((i) => (
          <span key={i} className="month-grid-dow faint">
            {WEEKDAYS[i]}
          </span>
        ))}
        {weeks.map((week) => [
          p.showWeekNumbers ? (
            <span key={`w${week[0]}`} className="month-grid-week faint">
              {weekNo(week[0])}
            </span>
          ) : null,
          ...week.map((day) => {
            const st = p.status?.(day) ?? null;
            const bar = st && st.total ? (day > p.today ? "future" : st.done === st.total ? "done" : "open") : null;
            const disabled = p.disabled?.(day) ?? false;
            return (
              <button
                key={day}
                className={[
                  "month-grid-day",
                  day.slice(0, 7) !== first.slice(0, 7) && "is-other",
                  day === p.today && "is-today",
                  day === p.selected && "is-selected",
                  p.inRange?.(day) && "is-in-range",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={disabled}
                onClick={() => p.onSelect(day)}
                onMouseEnter={() => p.onHover?.(day)}
                title={st && st.total ? `${st.done} of ${st.total} done` : undefined}
                {...(p.dayProps?.(day) ?? {})}
              >
                <span>{Number(day.slice(8))}</span>
                {bar && (
                  <span className={`month-grid-bar is-${bar}`}>
                    <span style={{ width: `${Math.max(12, (st!.done / st!.total) * 100)}%` }} />
                  </span>
                )}
              </button>
            );
          }),
        ])}
      </div>
      {p.footer}
    </div>
  );
}
