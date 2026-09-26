// Folder dates. A day's items are shown grouped under their dated folders,
// and child items keep their dates in step with their folder:
//
// - When a folder's date changes, its "followers" change with it: child tasks
//   and sub-folders (at any depth, unfinished tasks only) that had no date or
//   the folder's old date. A child given its own date keeps it, and its own
//   children are left alone.
// - An item created in, or moved into, a dated folder takes the folder's date
//   if it has none.
// - Day positions are then re-balanced so that ordering by schedulePosition
//   matches the grouped order (so plain readers such as Colonnes show the same
//   order, just without indentation).
//
// Everything here is pure; store.transact applies the result as part of the
// same undo step.

import type { Doc, Item } from "./types";
import { compareKeys, keyAfter, keysBetween } from "./order";

type Lookup = (id: string) => Item | undefined;

const bySchedule = (a: Item, b: Item) =>
  compareKeys(a.schedulePosition ?? "", b.schedulePosition ?? "") || compareKeys(a.id, b.id);

export interface DayEntry {
  item: Item;
  /** Number of dated ancestors on the same day (0 = top level). */
  depth: number;
}

/** The nearest ancestor that is also on the day, or null. */
function hostOf(it: Item, onDay: Set<string>, get: Lookup): string | null {
  let cur = it.parentId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    if (onDay.has(cur)) return cur;
    guard.add(cur);
    cur = get(cur)?.parentId ?? null;
  }
  return null;
}

/** A day's items in display order: each item after its dated ancestor, indented. */
export function groupDay(list: Item[], get: Lookup): DayEntry[] {
  const onDay = new Set(list.map((x) => x.id));
  const kids = new Map<string | null, Item[]>();
  for (const it of list) {
    const h = hostOf(it, onDay, get);
    let l = kids.get(h);
    if (!l) kids.set(h, (l = []));
    l.push(it);
  }
  for (const l of kids.values()) l.sort(bySchedule);
  const out: DayEntry[] = [];
  const walk = (host: string | null, depth: number) => {
    for (const it of kids.get(host) ?? []) {
      out.push({ item: it, depth });
      walk(it.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Types whose dates follow their folder. */
export const DATE_FOLLOWER_TYPES = new Set<Item["type"]>(["task", "folder"]);

/** Does `x` (as it was before the change) follow a folder whose date was `oldDate`? */
export function followsFolder(x: Item, oldDate: string | null): boolean {
  if (!DATE_FOLLOWER_TYPES.has(x.type)) return false;
  if (x.type === "task" && x.finished) return false;
  return x.scheduleDate === null || x.scheduleDate === oldDate;
}

export interface DateChange {
  scheduleDate: string | null;
  schedulePosition: string | null;
  /** True when the date itself changed (vs. only a position re-balance). */
  dateChanged: boolean;
}

interface Indexed {
  children: Map<string, Item[]>;
  byDay: Map<string, Item[]>;
}

/**
 * Work out the date and position changes implied by a transaction that turned
 * `before` into `after`, touching `changed` item ids.
 */
export function dateRuleChanges(
  before: Doc,
  after: Doc,
  changed: Set<string>,
  ixAfter: Indexed,
  opts: { cascade: boolean },
): Map<string, DateChange> {
  const out = new Map<string, DateChange>();
  const relevant = [...changed].some((id) => {
    const b = before.items[id];
    const a = after.items[id];
    if (!b || !a) return !!(b ?? a);
    return (
      b.scheduleDate !== a.scheduleDate ||
      b.schedulePosition !== a.schedulePosition ||
      b.parentId !== a.parentId ||
      b.type !== a.type
    );
  });
  if (!relevant) return out;

  const newDates = new Map<string, string | null>();
  const dateOf = (id: string) => (newDates.has(id) ? newDates.get(id)! : (after.items[id]?.scheduleDate ?? null));
  const kidsOf = (id: string) => ixAfter.children.get(id) ?? [];

  // Give `root`'s followers `date`. `wasDate` is what they had to match.
  const spread = (rootId: string, wasDate: string | null, date: string | null, useBefore: boolean) => {
    for (const c of kidsOf(rootId)) {
      // A date set explicitly in this transaction wins.
      const was = before.items[c.id];
      if (changed.has(c.id) && was && was.scheduleDate !== c.scheduleDate) continue;
      const ref = useBefore ? (was ?? c) : c;
      if (newDates.has(c.id) || !followsFolder(ref, wasDate)) continue;
      if (c.scheduleDate !== date) newDates.set(c.id, date);
      if (c.type === "folder") spread(c.id, wasDate, date, useBefore);
    }
  };

  // 1. A folder's date changed: its followers change with it.
  if (opts.cascade) {
    for (const id of changed) {
      const b = before.items[id];
      const a = after.items[id];
      if (!b || !a || a.type !== "folder" || b.scheduleDate === a.scheduleDate) continue;
      spread(id, b.scheduleDate, a.scheduleDate, true);
    }
  }

  // 2. Created in, or moved into, a dated folder: take its date if undated.
  if (opts.cascade) {
    const depth = (id: string) => {
      let n = 0;
      let cur = after.items[id]?.parentId ?? null;
      const guard = new Set<string>();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        n++;
        cur = after.items[cur]?.parentId ?? null;
      }
      return n;
    };
    const candidates = [...changed]
      .filter((id) => {
        const a = after.items[id];
        const b = before.items[id];
        return a && a.parentId && (!b || b.parentId !== a.parentId);
      })
      .sort((x, y) => depth(x) - depth(y));
    for (const id of candidates) {
      const a = after.items[id];
      if (dateOf(id) !== null || !followsFolder(a, null)) continue;
      const parent = a.parentId ? after.items[a.parentId] : undefined;
      const date = parent && parent.type === "folder" ? dateOf(parent.id) : null;
      if (!date) continue;
      newDates.set(id, date);
      if (a.type === "folder") spread(id, null, date, false);
    }
  }

  // 3. Positions for newly dated items: after everything already on the day
  //    (in walk order, so a folder's followers keep their outline order).
  const tail = new Map<string, string | null>();
  const lastKey = (day: string) => {
    if (!tail.has(day)) {
      const list = ixAfter.byDay.get(day) ?? [];
      let max: string | null = null;
      for (const x of list) if (x.schedulePosition && (max === null || x.schedulePosition > max)) max = x.schedulePosition;
      tail.set(day, max);
    }
    return tail.get(day)!;
  };
  for (const [id, date] of newDates) {
    if (date === null) {
      out.set(id, { scheduleDate: null, schedulePosition: null, dateChanged: true });
      continue;
    }
    const key = keyAfter(lastKey(date));
    tail.set(date, key);
    out.set(id, { scheduleDate: date, schedulePosition: key, dateChanged: true });
  }

  // 4. Re-balance every affected day so position order equals grouped order.
  const days = new Set<string>();
  const addDay = (d: string | null | undefined) => d && days.add(d);
  for (const id of changed) {
    addDay(before.items[id]?.scheduleDate);
    addDay(after.items[id]?.scheduleDate);
  }
  for (const [id, c] of out) {
    addDay(after.items[id]?.scheduleDate);
    addDay(c.scheduleDate);
  }
  const view = (id: string): Item | undefined => {
    const it = after.items[id];
    const c = out.get(id);
    return it && c ? { ...it, scheduleDate: c.scheduleDate, schedulePosition: c.schedulePosition } : it;
  };
  for (const day of days) {
    const ids = new Set((ixAfter.byDay.get(day) ?? []).map((x) => x.id));
    for (const [id, c] of out) if (c.scheduleDate === day) ids.add(id);
    const members = [...ids].map(view).filter((x): x is Item => !!x && x.scheduleDate === day);
    const grouped = groupDay(members, (id) => after.items[id]);
    let ordered = true;
    for (let i = 1; i < grouped.length && ordered; i++) {
      const p = grouped[i - 1].item.schedulePosition ?? "";
      const q = grouped[i].item.schedulePosition ?? "";
      if (!(compareKeys(p, q) < 0)) ordered = false;
    }
    if (ordered) continue;
    const keys = keysBetween(null, null, grouped.length);
    grouped.forEach(({ item }, i) => {
      const prev = out.get(item.id);
      out.set(item.id, {
        scheduleDate: day,
        schedulePosition: keys[i],
        dateChanged: prev?.dateChanged ?? false,
      });
    });
  }
  return out;
}

/** Earliest and latest date among a folder and its unfinished dated descendants. */
export function dateSpan(
  rootId: string,
  items: Record<string, Item>,
  children: Map<string, Item[]>,
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  const see = (d: string | null) => {
    if (!d) return;
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
  };
  see(items[rootId]?.scheduleDate ?? null);
  const walk = (id: string) => {
    for (const c of children.get(id) ?? []) {
      if (!(c.type === "task" && c.finished)) see(c.scheduleDate);
      walk(c.id);
    }
  };
  walk(rootId);
  return from && to ? { from, to } : null;
}
