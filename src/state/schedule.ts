// Calendar-wide scheduling operations: rolling unfinished work forward.
// Folder date cascading and inheritance happen in store.transact (see
// model/schedule.ts), so every path that moves dates gets them for free.

import type { Item } from "../model/types";
import { addDays, todayKey } from "../model/dates";
import { descendants, isInTrash, itemsOnDay } from "../model/tree";
import { get, toast } from "./store";
import { indexOf } from "./derived";
import { scheduleItems } from "./items";
import { parseDatePhrase } from "../ui/fuzzy";

/**
 * Items scheduled before `before` that still have unfinished work: unfinished
 * tasks, and folders with at least one unfinished task inside. Returned in
 * calendar order (by day, then position on the day). Folder descendants that
 * move with their folder are left out.
 */
export function overdueItems(before: string = todayKey()): Item[] {
  const s = get();
  if (!s.doc) return [];
  const ix = indexOf(s.doc);
  const days = [...ix.byDay.keys()].filter((d) => d < before).sort();
  const out: Item[] = [];
  const taken = new Set<string>();
  for (const day of days) {
    for (const it of itemsOnDay(ix, day)) {
      if (taken.has(it.id) || isInTrash(ix, it.id)) continue;
      const pending =
        it.type === "task"
          ? !it.finished
          : it.type === "folder"
            ? descendants(ix, it.id).some((x) => x.type === "task" && !x.finished)
            : false;
      if (!pending) continue;
      out.push(it);
      taken.add(it.id);
      // Followers on the same day travel with the folder.
      if (it.type === "folder") for (const x of descendants(ix, it.id)) if (x.scheduleDate === day) taken.add(x.id);
    }
  }
  return out;
}

/**
 * Move unfinished overdue work onto `to` (default today), appended after the
 * items already there. Returns how many items were moved. One undo step.
 */
export function rollOverOverdue(to: string = todayKey(), opts: { quiet?: boolean } = {}): number {
  const items = overdueItems(to);
  if (!items.length) {
    if (!opts.quiet) toast("Nothing overdue");
    return 0;
  }
  scheduleItems(
    items.map((x) => x.id),
    to,
    "Move unfinished to today",
  );
  if (!opts.quiet) toast(`Moved ${items.length} unfinished item${items.length === 1 ? "" : "s"} to ${to === todayKey() ? "today" : to}`, "success");
  return items.length;
}

/** How many items on one day still have unfinished work (for the day header button). */
export function unfinishedOnDay(date: string): number {
  return overdueItems(addDays(date, 1)).filter((x) => x.scheduleDate === date).length;
}

/** Move one past day's unfinished items to `to`. */
export function rollOverDay(date: string, to: string = todayKey()): number {
  const ids = overdueItems(addDays(date, 1))
    .filter((x) => x.scheduleDate === date)
    .map((x) => x.id);
  if (!ids.length) return 0;
  scheduleItems(ids, to, "Move unfinished to today");
  toast(`Moved ${ids.length} unfinished item${ids.length === 1 ? "" : "s"}`, "success");
  return ids.length;
}

/**
 * A trailing "@date" typed at the end of an item's text: "Call dentist @fri",
 * "Pay rent @dec 5", "@tomorrow", "@+3d", "@2026-10-01", or "@none" to remove
 * the date. The "@" must start a word (so e-mail addresses are ignored) and
 * some text must remain before it.
 */
export function splitTypedDate(
  text: string,
  today: string,
  weekStartsOn: "monday" | "sunday",
): { text: string; date: string | null } | null {
  const m = /(^|\s)@([^@\s][^@]*)$/.exec(text);
  if (!m) return null;
  const rest = text.slice(0, m.index + m[1].length).trimEnd();
  if (!rest.trim()) return null;
  const phrase = m[2].trim();
  if (/^(none|clear|no date)$/i.test(phrase)) return { text: rest, date: null };
  const date = parseDatePhrase(phrase, today, weekStartsOn);
  return date ? { text: rest, date } : null;
}
