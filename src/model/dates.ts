// Calendar-day helpers. Days are local-time "YYYY-MM-DD" keys.

import type { WeekStart } from "./types";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const d = parseDay(s);
  return toDayKey(d) === s;
}

export function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a day key as local midnight. */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey(now: Date = new Date()): string {
  return toDayKey(now);
}

export function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return toDayKey(d);
}

export function addMonths(key: string, n: number): string {
  const d = parseDay(key);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return toDayKey(d);
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Whole days from a to b (b - a). DST-safe because it rounds. */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

export function weekday(key: string): number {
  return parseDay(key).getDay();
}

export function startOfWeek(key: string, weekStartsOn: WeekStart): string {
  const wd = weekday(key);
  const offset = weekStartsOn === "monday" ? (wd + 6) % 7 : wd;
  return addDays(key, -offset);
}

export function startOfMonth(key: string): string {
  return key.slice(0, 8) + "01";
}

export function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** ISO-8601 week number. */
export function isoWeek(key: string): number {
  const d = parseDay(key);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNr = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = (target.getTime() - firstThursday.getTime()) / 86_400_000;
  return 1 + Math.round((diff - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
}

const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export const formatLongDay = (key: string) => LONG_DAY.format(parseDay(key));
export const formatShortDay = (key: string) => SHORT_DAY.format(parseDay(key));
export const formatMonth = (key: string) => MONTH.format(parseDay(key));

export function relativeDayLabel(key: string, today = todayKey()): string | null {
  const d = diffDays(today, key);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  return null;
}
