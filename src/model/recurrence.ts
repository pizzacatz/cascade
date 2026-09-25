// Recurrence rules: which days a rule fires on, and a human summary / RRULE.

import type { Recurrence, RecurrenceRule } from "./types";
import { daysInMonth, diffDays, monthIndex, parseDay, startOfWeek, weekday } from "./dates";
import { sortRules } from "./formatting";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function recurrenceMatches(r: Recurrence, day: string): boolean {
  if (day < r.startDate) return false;
  if (r.endDate && day > r.endDate) return false;
  const interval = Math.max(1, r.interval);
  switch (r.frequency) {
    case "daily":
      return diffDays(r.startDate, day) % interval === 0;
    case "weekly": {
      if (!r.weekdays.includes(weekday(day) as never)) return false;
      const weeks = diffDays(startOfWeek(r.startDate, r.weekStartsOn), startOfWeek(day, r.weekStartsOn)) / 7;
      return weeks % interval === 0;
    }
    case "monthly": {
      if ((monthIndex(day) - monthIndex(r.startDate)) % interval !== 0) return false;
      const d = parseDay(day);
      const dim = daysInMonth(d.getFullYear(), d.getMonth());
      const dom = d.getDate();
      switch (r.mode) {
        case "day":
          return dom === r.day;
        case "last-day":
          return dom === dim;
        case "weekday": {
          if (d.getDay() !== r.weekday) return false;
          if (r.ordinal === -1) return dom + 7 > dim;
          return Math.ceil(dom / 7) === r.ordinal;
        }
      }
    }
  }
  return false;
}

/** Enabled rules matching a day, in priority order. */
export function rulesForDay(rules: RecurrenceRule[], day: string): RecurrenceRule[] {
  return sortRules(rules).filter((r) => r.enabled && recurrenceMatches(r.recurrence, day));
}

const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };

export function describeRecurrence(r: Recurrence): string {
  const every = (unit: string) => (r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`);
  let s: string;
  switch (r.frequency) {
    case "daily":
      s = every("day");
      break;
    case "weekly": {
      const days = r.weekdays.length ? r.weekdays.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ") : "no days";
      s = `${every("week")} on ${days}`;
      break;
    }
    case "monthly":
      if (r.mode === "day") s = `${every("month")} on day ${r.day}`;
      else if (r.mode === "last-day") s = `${every("month")} on the last day`;
      else s = `${every("month")} on the ${ORDINALS[r.ordinal]} ${WEEKDAY_NAMES[r.weekday]}`;
      break;
  }
  s += `, from ${r.startDate}`;
  if (r.endDate) s += ` until ${r.endDate}`;
  return s;
}

/** iCalendar RRULE equivalent (for display / export). */
export function toRRule(r: Recurrence): string {
  const parts: string[] = [];
  switch (r.frequency) {
    case "daily":
      parts.push("FREQ=DAILY");
      break;
    case "weekly":
      parts.push("FREQ=WEEKLY", `WKST=${r.weekStartsOn === "monday" ? "MO" : "SU"}`);
      if (r.weekdays.length) parts.push(`BYDAY=${r.weekdays.map((d) => RRULE_DAYS[d]).join(",")}`);
      break;
    case "monthly":
      parts.push("FREQ=MONTHLY");
      if (r.mode === "day") parts.push(`BYMONTHDAY=${r.day}`);
      else if (r.mode === "last-day") parts.push("BYMONTHDAY=-1");
      else parts.push(`BYDAY=${r.ordinal}${RRULE_DAYS[r.weekday]}`);
      break;
  }
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.endDate) parts.push(`UNTIL=${r.endDate.replace(/-/g, "")}`);
  return parts.join(";");
}
