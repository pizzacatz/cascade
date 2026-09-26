// Document-configuration operations: spaces, tags, conditional formatting,
// recurrence rules, progression mode, and calendar day preparation.

import type {
  Color,
  Doc,
  FormatRule,
  Item,
  ProgressionMode,
  RecurrenceRule,
  Space,
  Tag,
} from "../model/types";
import { ROOT_SPACE_ID, TRASH_SPACE_ID, TREE_SPACE_ID, isContainerType } from "../model/types";
import { newId } from "../model/defaults";
import { keyAfter, keyBetween } from "../model/order";
import { childrenOf, isUserSpace, itemsOnDay, sortSpaces } from "../model/tree";
import { rulesForDay } from "../model/recurrence";
import { sortRules } from "../model/formatting";
import { get, set, toast, transact } from "./store";
import { indexOf, today } from "./derived";
import { copyTrees } from "./items";
import { switchSpace } from "./nav";

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export function createSpace(name = "New space", icon = "folder", color: Color = "default", opts: { open?: boolean } = {}): string | null {
  const s = get();
  if (!s.doc) return null;
  const spaces = sortSpaces(s.doc.config.spaces);
  // New spaces go before Trash.
  const trashIdx = spaces.findIndex((x) => x.id === TRASH_SPACE_ID);
  const before = trashIdx >= 0 ? spaces[trashIdx] : null;
  const prev = trashIdx > 0 ? spaces[trashIdx - 1] : trashIdx < 0 ? spaces.at(-1) : null;
  const id = newId();
  const space: Space = {
    id,
    name,
    icon,
    color,
    position: keyBetween(prev?.position ?? null, before?.position ?? null),
    archived: false,
  };
  transact("New space", (d) => {
    d.config.spaces.push(space);
  });
  if (opts.open !== false) switchSpace(id);
  return id;
}

export function updateSpace(id: string, patch: Partial<Pick<Space, "name" | "icon" | "color">>): void {
  transact("Edit space", (d) => {
    const sp = d.config.spaces.find((x) => x.id === id);
    if (sp) Object.assign(sp, patch);
  });
}

export function setSpaceArchived(id: string, archived: boolean): void {
  if (!isUserSpace(id)) return;
  transact(archived ? "Archive space" : "Unarchive space", (d) => {
    const sp = d.config.spaces.find((x) => x.id === id);
    if (sp) sp.archived = archived;
  });
  if (archived && get().view.currentSpaceId === id) switchSpace(ROOT_SPACE_ID);
}

export function moveSpace(id: string, delta: -1 | 1): void {
  const s = get();
  if (!s.doc) return;
  const spaces = sortSpaces(s.doc.config.spaces).filter((x) => !x.archived);
  const i = spaces.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= spaces.length) return;
  const others = spaces.filter((x) => x.id !== id);
  const pos = keyBetween(others[j - 1]?.position ?? null, others[j]?.position ?? null);
  transact("Reorder spaces", (d) => {
    const sp = d.config.spaces.find((x) => x.id === id);
    if (sp) sp.position = pos;
  });
}

/**
 * Place an active space at an index of the visible (non-archived, non-tree)
 * space list, as drag-to-reorder does. Trash keeps its own position.
 */
export function placeSpace(id: string, index: number): void {
  const s = get();
  if (!s.doc) return;
  const list = sortSpaces(s.doc.config.spaces).filter((x) => !x.archived && x.id !== TREE_SPACE_ID);
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const others = list.filter((x) => x.id !== id);
  const to = Math.max(0, Math.min(index > from ? index - 1 : index, others.length));
  if (to === from) return;
  const pos = keyBetween(others[to - 1]?.position ?? null, others[to]?.position ?? null);
  transact("Reorder spaces", (d) => {
    const sp = d.config.spaces.find((x) => x.id === id);
    if (sp) sp.position = pos;
  });
}

export function duplicateSpace(id: string, opts: { open?: boolean } = {}): string | null {
  const s = get();
  if (!s.doc) return null;
  const ix = indexOf(s.doc);
  const src = s.doc.config.spaces.find((x) => x.id === id);
  if (!src || id === TRASH_SPACE_ID) return null;
  const spaces = sortSpaces(s.doc.config.spaces);
  const i = spaces.findIndex((x) => x.id === id);
  const newSpace: Space = {
    ...src,
    id: newId(),
    name: `${src.name} copy`,
    position: keyBetween(src.position, spaces[i + 1]?.position ?? null),
    archived: false,
  };
  transact("Duplicate space", (d) => {
    d.config.spaces.push(newSpace);
    copyTrees(d, ix, childrenOf(ix, id), (c) => {
      c.parentId = newSpace.id;
      c.scheduleDate = null;
      c.schedulePosition = null;
    });
  });
  if (opts.open !== false) switchSpace(newSpace.id);
  return newSpace.id;
}

/** Delete a user space: its items move to Trash; rules referencing it lose those conditions. */
export function deleteSpace(id: string): void {
  const s = get();
  if (!s.doc || !isUserSpace(id)) return;
  const ix = indexOf(s.doc);
  const items = childrenOf(ix, id);
  transact("Delete space", (d) => {
    let pos = childrenOf(ix, TRASH_SPACE_ID).at(-1)?.position ?? null;
    for (const it of items) {
      const x = d.items[it.id];
      pos = keyAfter(pos);
      x.parentId = TRASH_SPACE_ID;
      x.position = pos;
      x.scheduleDate = null;
      x.schedulePosition = null;
    }
    d.config.spaces = d.config.spaces.filter((x) => x.id !== id);
    for (const r of d.config.conditionalFormatting) {
      r.conditions = r.conditions.filter((c) => !(c.kind === "space" && c.spaceId === id)) as never;
    }
  });
  if (get().view.currentSpaceId === id) switchSpace(ROOT_SPACE_ID);
  if (items.length) toast(`Moved ${items.length} item${items.length === 1 ? "" : "s"} to Trash`);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function sortedTags(tags: Tag[]): Tag[] {
  return sortRules(tags.map((t) => ({ ...t })));
}

export function createTag(name: string, color: Color = "blue", icon = "tag"): string | null {
  const s = get();
  if (!s.doc) return null;
  const last = sortedTags(s.doc.config.tags).at(-1);
  const id = newId();
  transact("New tag", (d) => {
    d.config.tags.push({ id, name, color, icon, priority: keyAfter(last?.priority ?? null) });
  });
  return id;
}

export function updateTag(id: string, patch: Partial<Pick<Tag, "name" | "icon" | "color">>): void {
  transact("Edit tag", (d) => {
    const t = d.config.tags.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  });
}

export function deleteTag(id: string): void {
  transact("Delete tag", (d) => {
    d.config.tags = d.config.tags.filter((t) => t.id !== id);
    for (const it of Object.values(d.items)) {
      if (it.tags.includes(id)) it.tags = it.tags.filter((t) => t !== id);
    }
    for (const r of d.config.conditionalFormatting) {
      r.conditions = r.conditions.filter(
        (c) => !(c.kind === "tag" && "tagId" in c && c.tagId === id),
      ) as never;
    }
  });
}

/** Generic reorder for priority-ordered lists (tags, rules, recurrence rules). */
function reorderByPriority<T extends { id: string; priority: string; name: string }>(
  list: T[],
  id: string,
  delta: -1 | 1,
): string | null {
  const sorted = sortRules(list);
  const i = sorted.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sorted.length) return null;
  const others = sorted.filter((x) => x.id !== id);
  return keyBetween(others[j - 1]?.priority ?? null, others[j]?.priority ?? null);
}

export function moveTag(id: string, delta: -1 | 1): void {
  const s = get();
  const p = s.doc && reorderByPriority(s.doc.config.tags, id, delta);
  if (!p) return;
  transact("Reorder tags", (d) => {
    const t = d.config.tags.find((x) => x.id === id);
    if (t) t.priority = p;
  });
}

/** Place a tag at an index of the ordered tag list (drag-to-reorder). */
export function placeTag(id: string, index: number): void {
  const s = get();
  if (!s.doc) return;
  const list = sortRules(s.doc.config.tags);
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const others = list.filter((x) => x.id !== id);
  const to = Math.max(0, Math.min(index > from ? index - 1 : index, others.length));
  if (to === from) return;
  const p = keyBetween(others[to - 1]?.priority ?? null, others[to]?.priority ?? null);
  transact("Reorder tags", (d) => {
    const t = d.config.tags.find((x) => x.id === id);
    if (t) t.priority = p;
  });
}

/** Duplicate a tag right after the original. */
export function duplicateTag(id: string): string | null {
  const s = get();
  if (!s.doc) return null;
  const list = sortRules(s.doc.config.tags);
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const src = list[i];
  const nid = newId();
  const priority = keyBetween(src.priority, list[i + 1]?.priority ?? null);
  transact("Duplicate tag", (d) => {
    d.config.tags.push({ id: nid, name: `${src.name} copy`, color: src.color, icon: src.icon, priority });
  });
  return nid;
}

// ---------------------------------------------------------------------------
// Conditional formatting rules
// ---------------------------------------------------------------------------

export function createRule(kind: FormatRule["kind"] = "taskRule"): string | null {
  const s = get();
  if (!s.doc) return null;
  const last = sortRules(s.doc.config.conditionalFormatting).at(-1);
  const id = newId();
  const rule = {
    id,
    name: kind === "taskRule" ? "New task rule" : "New folder rule",
    enabled: true,
    priority: keyAfter(last?.priority ?? null),
    kind,
    logic: "all",
    conditions: [],
    style: { bold: true },
  } as FormatRule;
  transact("New formatting rule", (d) => {
    d.config.conditionalFormatting.push(rule);
  });
  return id;
}

export function updateRule(id: string, update: (r: FormatRule) => void): void {
  transact(
    "Edit formatting rule",
    (d) => {
      const r = d.config.conditionalFormatting.find((x) => x.id === id);
      if (r) update(r as FormatRule);
    },
    { coalesceKey: `rule:${id}` },
  );
}

export function deleteRule(id: string): void {
  transact("Delete formatting rule", (d) => {
    d.config.conditionalFormatting = d.config.conditionalFormatting.filter((r) => r.id !== id);
  });
}

export function duplicateRule(id: string): string | null {
  const s = get();
  const src = s.doc?.config.conditionalFormatting.find((r) => r.id === id);
  if (!s.doc || !src) return null;
  const sorted = sortRules(s.doc.config.conditionalFormatting);
  const i = sorted.findIndex((r) => r.id === id);
  const copy = structuredClone(src);
  copy.id = newId();
  copy.name = `${src.name} copy`;
  copy.priority = keyBetween(src.priority, sorted[i + 1]?.priority ?? null);
  transact("Duplicate formatting rule", (d) => {
    d.config.conditionalFormatting.push(copy);
  });
  return copy.id;
}

export function moveRule(id: string, delta: -1 | 1): void {
  const s = get();
  const p = s.doc && reorderByPriority(s.doc.config.conditionalFormatting, id, delta);
  if (!p) return;
  transact("Reorder formatting rules", (d) => {
    const r = d.config.conditionalFormatting.find((x) => x.id === id);
    if (r) r.priority = p;
  });
}

// ---------------------------------------------------------------------------
// Recurrence rules
// ---------------------------------------------------------------------------

export function createRecurrenceRule(): string | null {
  const s = get();
  if (!s.doc) return null;
  const last = sortRules(s.doc.config.recurrenceRules).at(-1);
  const id = newId();
  const rule: RecurrenceRule = {
    id,
    name: "New recurring rule",
    enabled: true,
    priority: keyAfter(last?.priority ?? null),
    recurrence: {
      frequency: "weekly",
      startDate: today(),
      endDate: null,
      interval: 1,
      weekdays: [1, 2, 3, 4, 5],
      weekStartsOn: s.prefs.weekStartsOn,
    },
    templates: [],
  };
  transact("New recurrence rule", (d) => {
    d.config.recurrenceRules.push(rule);
  });
  return id;
}

export function updateRecurrenceRule(id: string, update: (r: RecurrenceRule) => void): void {
  transact(
    "Edit recurrence rule",
    (d) => {
      const r = d.config.recurrenceRules.find((x) => x.id === id);
      if (r) update(r);
    },
    { coalesceKey: `rec:${id}` },
  );
}

export function deleteRecurrenceRule(id: string): void {
  transact("Delete recurrence rule", (d) => {
    d.config.recurrenceRules = d.config.recurrenceRules.filter((r) => r.id !== id);
  });
}

export function duplicateRecurrenceRule(id: string): string | null {
  const s = get();
  const src = s.doc?.config.recurrenceRules.find((r) => r.id === id);
  if (!s.doc || !src) return null;
  const sorted = sortRules(s.doc.config.recurrenceRules);
  const i = sorted.findIndex((r) => r.id === id);
  const copy = structuredClone(src);
  copy.id = newId();
  copy.name = `${src.name} copy`;
  copy.priority = keyBetween(src.priority, sorted[i + 1]?.priority ?? null);
  transact("Duplicate recurrence rule", (d) => {
    d.config.recurrenceRules.push(copy);
  });
  return copy.id;
}

export function moveRecurrenceRule(id: string, delta: -1 | 1): void {
  const s = get();
  const p = s.doc && reorderByPriority(s.doc.config.recurrenceRules, id, delta);
  if (!p) return;
  transact("Reorder recurrence rules", (d) => {
    const r = d.config.recurrenceRules.find((x) => x.id === id);
    if (r) r.priority = p;
  });
}

export function setProgressionMode(mode: ProgressionMode): void {
  transact("Change progression mode", (d) => {
    d.config.progressionMode = mode;
  });
}

// ---------------------------------------------------------------------------
// Calendar day preparation (recurring tasks)
// ---------------------------------------------------------------------------

export type PrepareStatus = "prepared" | "already_prepared" | "no_matching_rule" | "error";

export interface PrepareResult {
  date: string;
  status: PrepareStatus;
  createdCount: number;
  message?: string;
}

/** All template items in the document (for pickers). */
export function templateItems(doc: Doc | null): Item[] {
  return doc ? Object.values(doc.items).filter((x) => x.type === "template") : [];
}

/** What preparing a day would create: matching rules and the template contents. */
export function preparePreview(doc: Doc | null, date: string): { rules: RecurrenceRule[]; items: Item[] } {
  if (!doc) return { rules: [], items: [] };
  const ix = indexOf(doc);
  const rules = rulesForDay(doc.config.recurrenceRules, date);
  const items = rules.flatMap((r) =>
    r.templates
      .map((id) => ix.items[id])
      .filter((x): x is Item => !!x && x.type === "template")
      .flatMap((tpl) => {
        const kids = childrenOf(ix, tpl.id);
        return kids.length ? kids : [tpl];
      }),
  );
  return { rules, items };
}

/** Materialize recurring templates for a day (today or later only). */
export function prepareDay(date: string): PrepareResult {
  const s = get();
  if (!s.doc) return { date, status: "error", createdCount: 0, message: "No document is open." };
  if (date < today()) {
    return { date, status: "error", createdCount: 0, message: "Only today and future dates can be prepared." };
  }
  if (s.doc.config.preparedDays.includes(date)) return { date, status: "already_prepared", createdCount: 0 };
  const ix = indexOf(s.doc);
  const rules = rulesForDay(s.doc.config.recurrenceRules, date);
  const templates = rules
    .flatMap((r) => r.templates)
    .map((id) => ix.items[id])
    .filter((x): x is Item => !!x && x.type === "template");
  if (!templates.length) return { date, status: "no_matching_rule", createdCount: 0 };

  set((st) => ({ preparingDays: [...st.preparingDays, date] }));
  let created = 0;
  try {
    const existing = itemsOnDay(ix, date);
    let pos = existing.at(-1)?.schedulePosition ?? null;
    transact("Prepare day", (d) => {
      for (const tpl of templates) {
        const kids = childrenOf(ix, tpl.id);
        const sources = kids.length ? kids : [{ ...tpl, type: "task" as const, icon: null }];
        const ids = copyTrees(d, ix, sources, (c) => {
          pos = keyAfter(pos);
          c.parentId = null;
          c.position = null;
          c.scheduleDate = date;
          c.schedulePosition = pos;
          c.finished = false;
          c.finishedAt = null;
          if (isContainerType(c.type) && c.parentId === null) {
            // Folders need a column placement; calendar-only copies become tasks.
            c.type = "task";
            c.icon = null;
          }
        });
        created += ids.length;
      }
      d.config.preparedDays = [...new Set([...d.config.preparedDays, date])].filter((x) => x >= today()).sort();
    });
  } finally {
    set((st) => ({ preparingDays: st.preparingDays.filter((x) => x !== date) }));
  }
  return { date, status: "prepared", createdCount: created };
}

export function prepareDayWithToast(date: string): PrepareResult {
  const r = prepareDay(date);
  const msg: Record<PrepareStatus, string> = {
    prepared: `Prepared ${r.createdCount} recurring item${r.createdCount === 1 ? "" : "s"} for ${date}`,
    already_prepared: `${date} is already prepared`,
    no_matching_rule: `No recurring rule matches ${date}`,
    error: r.message ?? "Could not prepare the day",
  };
  toast(msg[r.status], r.status === "error" ? "error" : r.status === "prepared" ? "success" : "info");
  return r;
}

export function unprepareDay(date: string): void {
  transact("Allow preparing again", (d) => {
    d.config.preparedDays = d.config.preparedDays.filter((x) => x !== date);
  });
}
