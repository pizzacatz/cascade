// Conditional formatting engine.
//
// Rules are sorted by priority (top of the list first). For every enabled rule
// whose kind matches the item and whose conditions pass (all/any), its style is
// folded in. Boolean styles accumulate; colours are taken from the top-most
// matching rule. An item's own explicit colour beats any rule colour.

import type {
  Color,
  Condition,
  FormatRule,
  Item,
  NumberCondition,
  RuleStyle,
  ScheduleOperator,
  TextCondition,
  WeekStart,
} from "./types";
import { compareKeys } from "./order";
import type { DocIndex } from "./tree";
import { spaceOf } from "./tree";
import type { FolderStats, StatsMap } from "./progression";
import { addDays, addMonths, startOfMonth, startOfWeek } from "./dates";

export interface ResolvedStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  textColor: Color | null;
  accentColor: Color | null;
}

export const EMPTY_STYLE: ResolvedStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  textColor: null,
  accentColor: null,
};

export interface FormatContext {
  ix: DocIndex;
  stats: StatsMap;
  today: string;
  weekStartsOn: WeekStart;
  /** Tag ids that still exist; tag conditions ignore dangling ids. */
  tagIds: Set<string>;
}

export function sortRules<T extends { priority: string; name: string }>(rules: T[]): T[] {
  return [...rules].sort((a, b) => compareKeys(a.priority, b.priority) || a.name.localeCompare(b.name));
}

function textMatches(c: TextCondition, text: string): boolean {
  const hay = text.toLowerCase();
  const needle = (c.value ?? "").toLowerCase();
  switch (c.operator) {
    case "is_empty":
      return hay.trim() === "";
    case "is_not_empty":
      return hay.trim() !== "";
    case "equals":
      return hay === needle;
    case "not_equals":
      return hay !== needle;
    case "contains":
      return needle !== "" && hay.includes(needle);
    case "does_not_contain":
      return needle === "" || !hay.includes(needle);
    case "starts_with":
      return needle !== "" && hay.startsWith(needle);
    case "ends_with":
      return needle !== "" && hay.endsWith(needle);
    case "matches_regex":
    case "does_not_match_regex": {
      let re: RegExp;
      try {
        re = new RegExp(c.value ?? "", "i");
      } catch {
        return false;
      }
      const m = re.test(text);
      return c.operator === "matches_regex" ? m : !m;
    }
    default:
      return false;
  }
}

export function scheduleMatches(
  op: ScheduleOperator,
  item: Item,
  today: string,
  weekStartsOn: WeekStart,
): boolean {
  const d = item.scheduleDate;
  switch (op) {
    case "has_no_date":
      return d === null;
    case "has_date":
      return d !== null;
    case "is_overdue":
      return d !== null && d < today && !item.finished;
    case "is_not_overdue":
      return !(d !== null && d < today && !item.finished);
  }
  if (d === null) return false;
  switch (op) {
    case "today":
      return d === today;
    case "yesterday":
      return d === addDays(today, -1);
    case "tomorrow":
      return d === addDays(today, 1);
    case "this_week":
    case "last_week": {
      const start = startOfWeek(today, weekStartsOn);
      const from = op === "this_week" ? start : addDays(start, -7);
      return d >= from && d <= addDays(from, 6);
    }
    case "this_month":
      return d.slice(0, 7) === today.slice(0, 7);
    case "last_month":
      return d.slice(0, 7) === addMonths(startOfMonth(today), -1).slice(0, 7);
    case "next_month":
      return d.slice(0, 7) === addMonths(startOfMonth(today), 1).slice(0, 7);
    default:
      return false;
  }
}

function numberMatches(c: NumberCondition, stats: FolderStats | undefined): boolean {
  if (!stats) return false;
  const raw = stats[c.field];
  if (typeof raw !== "number") return false;
  // Progression is exposed to users as a percentage (0–100).
  const v = c.field === "progression" ? (raw < 0 ? 0 : Math.round(raw * 100)) : raw;
  const x = c.value ?? 0;
  switch (c.operator) {
    case "equals":
      return v === x;
    case "not_equals":
      return v !== x;
    case "greater_than":
      return v > x;
    case "greater_than_or_equal":
      return v >= x;
    case "less_than":
      return v < x;
    case "less_than_or_equal":
      return v <= x;
    case "between":
    case "not_between": {
      const lo = Math.min(c.min ?? 0, c.max ?? 0);
      const hi = Math.max(c.min ?? 0, c.max ?? 0);
      const inside = v >= lo && v <= hi;
      return c.operator === "between" ? inside : !inside;
    }
    default:
      return false;
  }
}

export function conditionMatches(c: Condition, item: Item, ctx: FormatContext): boolean {
  switch (c.kind) {
    case "tag": {
      const tags = item.tags.filter((t) => ctx.tagIds.has(t));
      switch (c.operator) {
        case "has_any":
          return tags.length > 0;
        case "has_none":
          return tags.length === 0;
        case "has":
          return tags.includes(c.tagId);
        case "does_not_have":
          return !tags.includes(c.tagId);
        default:
          return false;
      }
    }
    case "text":
      return textMatches(c, item.text);
    case "space": {
      const sp = spaceOf(ctx.ix, item.id);
      return c.operator === "is_in_space" ? sp === c.spaceId : sp !== c.spaceId;
    }
    case "scheduleDate":
      return scheduleMatches(c.operator, item, ctx.today, ctx.weekStartsOn);
    case "finished":
      return item.finished === c.value;
    case "number":
      return numberMatches(c, ctx.stats.get(item.id));
    default:
      return false;
  }
}

export function ruleMatches(rule: FormatRule, item: Item, ctx: FormatContext): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  if (rule.kind === "taskRule" && item.type !== "task") return false;
  if (rule.kind === "folderRule" && item.type !== "folder") return false;
  const test = (c: Condition) => conditionMatches(c, item, ctx);
  return rule.logic === "all"
    ? (rule.conditions as Condition[]).every(test)
    : (rule.conditions as Condition[]).some(test);
}

function fold(acc: ResolvedStyle, s: RuleStyle): ResolvedStyle {
  const next = { ...acc };
  if (s.bold) next.bold = true;
  if (s.italic) next.italic = true;
  if (s.strikethrough) next.strikethrough = true;
  if (s.textColor && s.textColor !== "default") next.textColor = s.textColor;
  if (s.accentColor && s.accentColor !== "default") next.accentColor = s.accentColor;
  return next;
}

/** `rules` must already be sorted with sortRules(). */
export function resolveStyle(sortedRules: FormatRule[], item: Item, ctx: FormatContext): ResolvedStyle {
  let style = EMPTY_STYLE;
  // Iterate bottom-up so the top-most rule is applied last and wins colours.
  for (let i = sortedRules.length - 1; i >= 0; i--) {
    const r = sortedRules[i];
    if (ruleMatches(r, item, ctx)) style = fold(style, r.style);
  }
  if (item.color !== "default") {
    style = { ...style, textColor: item.color, accentColor: item.color };
  }
  return style;
}
