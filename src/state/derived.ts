// Memoised derived data. Each selector caches on the identity of its inputs,
// so components re-render cheaply and computations run once per change.

import type { Doc, FormatRule, Item } from "../model/types";
import { buildIndex, type DocIndex } from "../model/tree";
import { computeStats, type StatsMap } from "../model/progression";
import { resolveStyle, sortRules, EMPTY_STYLE, type FormatContext, type ResolvedStyle } from "../model/formatting";
import { todayKey } from "../model/dates";
import { get, useApp, type AppState } from "./store";

const EMPTY_DOC: Doc = {
  items: {},
  config: {
    recurrenceRules: [],
    preparedDays: [],
    progressionMode: "by_level",
    spaces: [],
    tags: [],
    conditionalFormatting: [],
  },
};

let ixCache: { items: Doc["items"] | null; spaces: unknown; ix: DocIndex } | null = null;
export function indexOf(doc: Doc | null): DocIndex {
  const d = doc ?? EMPTY_DOC;
  if (!ixCache || ixCache.items !== d.items || ixCache.spaces !== d.config.spaces) {
    ixCache = { items: d.items, spaces: d.config.spaces, ix: buildIndex(d) };
  }
  return ixCache.ix;
}

/** Today's key, refreshed at most once a minute (so day rollover is picked up). */
let todayCache = { key: todayKey(), at: Date.now() };
export function today(): string {
  if (Date.now() - todayCache.at > 60_000) todayCache = { key: todayKey(), at: Date.now() };
  return todayCache.key;
}

let statsCache: { ix: DocIndex; mode: string; today: string; stats: StatsMap } | null = null;
export function statsOf(doc: Doc | null): StatsMap {
  const ix = indexOf(doc);
  const mode = doc?.config.progressionMode ?? "by_level";
  const t = today();
  if (!statsCache || statsCache.ix !== ix || statsCache.mode !== mode || statsCache.today !== t) {
    statsCache = { ix, mode, today: t, stats: computeStats(ix, mode, t) };
  }
  return statsCache.stats;
}

let rulesCache: { rules: FormatRule[]; sorted: FormatRule[] } | null = null;
function sortedRulesOf(doc: Doc | null): FormatRule[] {
  const rules = doc?.config.conditionalFormatting ?? [];
  if (!rulesCache || rulesCache.rules !== rules) rulesCache = { rules, sorted: sortRules(rules) };
  return rulesCache.sorted;
}

// Keyed by item object identity: items are immutable (immer), so a changed item
// is a new object and can never hit a stale entry.
let styleCache: { key: unknown[]; map: WeakMap<Item, ResolvedStyle> } | null = null;
/** Resolved conditional-formatting style for an item. */
export function styleFor(s: AppState, item: Item): ResolvedStyle {
  if (!s.doc) return EMPTY_STYLE;
  const ix = indexOf(s.doc);
  const key = [ix, sortedRulesOf(s.doc), statsOf(s.doc), s.doc.config.tags, s.prefs.weekStartsOn, today()];
  if (!styleCache || styleCache.key.some((k, i) => k !== key[i])) styleCache = { key, map: new WeakMap() };
  let st = styleCache.map.get(item);
  if (!st) {
    const ctx: FormatContext = {
      ix,
      stats: statsOf(s.doc),
      today: today(),
      weekStartsOn: s.prefs.weekStartsOn,
      tagIds: new Set(s.doc.config.tags.map((t) => t.id)),
    };
    st = resolveStyle(sortedRulesOf(s.doc), item, ctx);
    styleCache.map.set(item, st);
  }
  return st;
}

export const useIndex = () => useApp((s) => indexOf(s.doc));
export const ix = () => indexOf(get().doc);

/** The focused view's selection, filtered to items that still exist. */
export function selectionOf(s: AppState): string[] {
  const items = s.doc?.items ?? {};
  const sel = s.view.focusedView === "calendar" ? s.view.calendarSelection : s.view.columnsSelection;
  return sel.filter((id) => items[id]);
}

export function selectedItems(s: AppState): Item[] {
  const items = s.doc?.items ?? {};
  return selectionOf(s).map((id) => items[id]);
}
