// The `.col` document codec.
//
// On disk a document is UTF-8 JSON: `{ file_version: 4, configuration, items }`,
// written with two-space indentation. Items are a flat array; the tree is
// rebuilt from `parent_id` + `position`. Optional fields are omitted at their
// defaults and three decorations are abbreviated (`t` type code, `ic` icon,
// `c` colour code, `tg` tags).
//
// The reader is lenient: it accepts legacy shapes (a bare item array = v1,
// file_version 2 and 3), full-length field spellings, and repairs broken
// placement instead of refusing to open the file. `shouldRewrite` tells the
// caller the file was migrated or repaired and should be saved back.

import {
  CODE_TO_TYPE,
  COLORS,
  ITEM_TYPES,
  ROOT_SPACE_ID,
  TRASH_SPACE_ID,
  TYPE_TO_CODE,
  isTaggableType,
  type Color,
  type Doc,
  type DocConfig,
  type FormatRule,
  type Item,
  type ItemType,
  type ProgressionMode,
  type Recurrence,
  type RecurrenceRule,
  type Space,
  type Tag,
  type ViewState,
} from "./types";
import { defaultSpaces, defaultViewState, finishedTasksRule } from "./defaults";
import { isDayKey, todayKey } from "./dates";
import { compareKeys, keyAfter, keyBetween } from "./order";

export const CURRENT_FILE_VERSION = 4;

export class DocumentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentFormatError";
  }
}

export interface ParseResult {
  doc: Doc;
  sourceVersion: number;
  shouldRewrite: boolean;
  warnings: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function resolveType(raw: Json): ItemType | null {
  for (const v of [raw.t, raw.type]) {
    if (typeof v === "number" && CODE_TO_TYPE[v]) return CODE_TO_TYPE[v];
    if (typeof v === "string" && (ITEM_TYPES as readonly string[]).includes(v)) return v as ItemType;
  }
  return null;
}

export function colorFromCode(code: unknown): Color {
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code < COLORS.length) {
    return COLORS[code];
  }
  if (typeof code === "string" && (COLORS as readonly string[]).includes(code)) return code as Color;
  return "default";
}

export const colorToCode = (c: Color) => COLORS.indexOf(c);

function readItem(raw: unknown, hasChildren: Set<string>, warnings: string[]): Item | null {
  if (!isObj(raw) || !nonEmpty(raw.id)) {
    warnings.push("Skipped an item without an id.");
    return null;
  }
  const id = raw.id;
  const type = resolveType(raw) ?? (hasChildren.has(id) ? "folder" : "task");
  const parentId = nonEmpty(raw.parent_id) ? raw.parent_id : nonEmpty(raw.parentId) ? raw.parentId : null;
  const tagsRaw = Array.isArray(raw.tg) ? raw.tg : Array.isArray(raw.tags) ? raw.tags : [];
  const finished = type === "task" && raw.finished === true;
  const icon = isStr(raw.ic) ? raw.ic : isStr(raw.icon) ? raw.icon : null;
  return {
    id,
    type,
    parentId,
    position: nonEmpty(raw.position) ? raw.position : null,
    scheduleDate: isDayKey(raw.scheduleDate) ? raw.scheduleDate : null,
    schedulePosition: nonEmpty(raw.schedulePosition) ? raw.schedulePosition : null,
    text: type === "separator" ? "" : isStr(raw.text) ? raw.text : "",
    finished,
    finishedAt: finished && isStr(raw.finishedAt) ? raw.finishedAt : null,
    color: colorFromCode(raw.c ?? raw.color),
    icon: icon || (type === "template" ? "folder-bookmark" : null),
    tags: isTaggableType(type) ? tagsRaw.filter(nonEmpty) : [],
    createdAt: isStr(raw.createdAt) ? raw.createdAt : undefined,
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : undefined,
  };
}

function writeItem(item: Item): Json {
  const out: Json = { id: item.id, t: TYPE_TO_CODE[item.type] };
  if (item.parentId !== null && item.position !== null) {
    out.parent_id = item.parentId;
    out.position = item.position;
  }
  if (item.text && item.type !== "separator") out.text = item.text;
  if (item.type === "task" && item.finished) {
    out.finished = true;
    if (item.finishedAt) out.finishedAt = item.finishedAt;
  }
  if (item.createdAt) out.createdAt = item.createdAt;
  if (item.updatedAt) out.updatedAt = item.updatedAt;
  if (item.scheduleDate !== null && item.schedulePosition !== null) {
    out.schedulePosition = item.schedulePosition;
    out.scheduleDate = item.scheduleDate;
  }
  if (item.icon) out.ic = item.icon;
  if (item.color !== "default") out.c = colorToCode(item.color);
  if (item.tags.length && isTaggableType(item.type)) out.tg = [...item.tags];
  return out;
}

/**
 * Enforce placement invariants: parent/position and scheduleDate/position come
 * in pairs, every item has at least one placement, parents exist, and there are
 * no parent cycles. Returns true when anything had to be repaired.
 */
function repairPlacement(items: Record<string, Item>, spaceIds: Set<string>, warnings: string[]): boolean {
  let repaired = false;
  const lastPos = new Map<string, string>();
  const lastSched = new Map<string, string>();
  for (const it of Object.values(items)) {
    if (it.parentId && it.position) {
      const prev = lastPos.get(it.parentId);
      if (!prev || compareKeys(it.position, prev) > 0) lastPos.set(it.parentId, it.position);
    }
    if (it.scheduleDate && it.schedulePosition) {
      const prev = lastSched.get(it.scheduleDate);
      if (!prev || compareKeys(it.schedulePosition, prev) > 0) lastSched.set(it.scheduleDate, it.schedulePosition);
    }
  }
  const appendTo = (parent: string) => {
    const k = keyAfter(lastPos.get(parent) ?? null);
    lastPos.set(parent, k);
    return k;
  };

  for (const it of Object.values(items)) {
    // Parent must exist (as an item or a space) and must not be the item itself.
    if (it.parentId !== null && ((!items[it.parentId] && !spaceIds.has(it.parentId)) || it.parentId === it.id)) {
      warnings.push(`Item ${it.id} referenced a missing parent; moved to Home.`);
      it.parentId = ROOT_SPACE_ID;
      it.position = null;
      repaired = true;
    }
    if (it.parentId !== null && it.position === null) {
      it.position = appendTo(it.parentId);
      repaired = true;
    }
    if (it.parentId === null && it.position !== null) {
      it.position = null;
      repaired = true;
    }
    if (it.scheduleDate !== null && it.schedulePosition === null) {
      const k = keyAfter(lastSched.get(it.scheduleDate) ?? null);
      lastSched.set(it.scheduleDate, k);
      it.schedulePosition = k;
      repaired = true;
    }
    if (it.scheduleDate === null && it.schedulePosition !== null) {
      it.schedulePosition = null;
      repaired = true;
    }
    if (it.parentId === null && it.scheduleDate === null) {
      warnings.push(`Item ${it.id} had no placement; moved to Home.`);
      it.parentId = ROOT_SPACE_ID;
      it.position = appendTo(ROOT_SPACE_ID);
      repaired = true;
    }
  }

  // Break parent cycles.
  for (const it of Object.values(items)) {
    const seen = new Set<string>([it.id]);
    let cur = it.parentId;
    while (cur && items[cur]) {
      if (seen.has(cur)) {
        warnings.push(`Item ${it.id} was part of a parent cycle; moved to Home.`);
        it.parentId = ROOT_SPACE_ID;
        it.position = appendTo(ROOT_SPACE_ID);
        repaired = true;
        break;
      }
      seen.add(cur);
      cur = items[cur].parentId;
    }
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_KEYS = new Set([
  "recurrenceRules",
  "preparedDays",
  "progressionMode",
  "spaces",
  "tags",
  "conditionalFormatting",
  "viewState",
]);

function readSpaces(raw: unknown, warnings: string[]): Space[] {
  const out: Space[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (!isObj(s) || !nonEmpty(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      const system = s.id === ROOT_SPACE_ID || s.id === TRASH_SPACE_ID;
      out.push({
        id: s.id,
        icon: nonEmpty(s.icon) ? s.icon : "folder",
        color: nonEmpty(s.color) ? s.color : "default",
        name: isStr(s.name) ? s.name : s.id,
        position: nonEmpty(s.position) ? s.position : "a",
        archived: !system && s.archived === true,
      });
    }
  }
  for (const d of defaultSpaces()) {
    if (!seen.has(d.id)) {
      if (raw !== undefined) warnings.push(`Added missing "${d.name}" space.`);
      out.push({ ...d, position: keyAfter(out.map((s) => s.position).sort(compareKeys).at(-1) ?? null) });
    }
  }
  return out;
}

function readTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Tag[] = [];
  for (const t of raw) {
    if (!isObj(t) || !nonEmpty(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({
      id: t.id,
      name: isStr(t.name) ? t.name : t.id,
      icon: nonEmpty(t.icon) ? t.icon : "tag",
      color: colorFromCode(t.color),
      priority: nonEmpty(t.priority) ? t.priority : "a0",
    });
  }
  return out;
}

function readRules(raw: unknown, warnings: string[]): FormatRule[] {
  if (raw === undefined) return [finishedTasksRule()];
  if (!Array.isArray(raw)) return [];
  const out: FormatRule[] = [];
  for (const r of raw) {
    if (
      !isObj(r) ||
      !nonEmpty(r.id) ||
      (r.kind !== "taskRule" && r.kind !== "folderRule") ||
      !Array.isArray(r.conditions)
    ) {
      warnings.push("Skipped an invalid conditional-formatting rule.");
      continue;
    }
    const style = isObj(r.style) ? r.style : {};
    out.push({
      id: r.id,
      name: isStr(r.name) ? r.name : "Rule",
      enabled: r.enabled !== false,
      priority: nonEmpty(r.priority) ? r.priority : "a0",
      kind: r.kind,
      logic: r.logic === "any" ? "any" : "all",
      // Conditions are kept verbatim (unknown operators simply never match).
      conditions: r.conditions.filter(isObj) as never[],
      style: {
        ...(style.bold === true ? { bold: true } : {}),
        ...(style.italic === true ? { italic: true } : {}),
        ...(style.strikethrough === true ? { strikethrough: true } : {}),
        ...(isStr(style.textColor) ? { textColor: colorFromCode(style.textColor) } : {}),
        ...(isStr(style.accentColor) ? { accentColor: colorFromCode(style.accentColor) } : {}),
      },
    } as FormatRule);
  }
  return out;
}

function readRecurrence(raw: unknown): { value: Recurrence; normalized: boolean } | null {
  if (!isObj(raw)) return null;
  const frequency = raw.frequency ?? raw.type ?? raw.freq;
  const startDate = raw.startDate;
  if (!isDayKey(startDate)) return null;
  const endDate = isDayKey(raw.endDate) ? raw.endDate : null;
  if (endDate && endDate < startDate) return null;
  const interval = typeof raw.interval === "number" && raw.interval >= 1 ? Math.floor(raw.interval) : 1;
  const base = { startDate, endDate, interval };
  let normalized = false;
  switch (frequency) {
    case "daily":
      return { value: { ...base, frequency: "daily" }, normalized };
    case "weekly": {
      const weekdays = (Array.isArray(raw.weekdays) ? raw.weekdays : [])
        .filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
        .sort() as never[];
      let weekStartsOn = raw.weekStartsOn;
      if (weekStartsOn !== "monday" && weekStartsOn !== "sunday") {
        weekStartsOn = "monday";
        normalized = true;
      }
      return {
        value: { ...base, frequency: "weekly", weekdays, weekStartsOn: weekStartsOn as "monday" | "sunday" },
        normalized,
      };
    }
    case "monthly": {
      if (raw.mode === "day") {
        const day = typeof raw.day === "number" ? Math.min(31, Math.max(1, Math.floor(raw.day))) : 1;
        return { value: { ...base, frequency: "monthly", mode: "day", day }, normalized };
      }
      if (raw.mode === "weekday") {
        const weekday = Number.isInteger(raw.weekday) ? ((raw.weekday as number) % 7) : 1;
        const ord = raw.ordinal;
        const ordinal = ord === -1 || (Number.isInteger(ord) && (ord as number) >= 1 && (ord as number) <= 5) ? ord : 1;
        return {
          value: { ...base, frequency: "monthly", mode: "weekday", weekday, ordinal } as Recurrence,
          normalized,
        };
      }
      if (raw.mode === "last-day") return { value: { ...base, frequency: "monthly", mode: "last-day" }, normalized };
      return null;
    }
    default:
      return null;
  }
}

function readRecurrenceRules(raw: unknown, warnings: string[]): { rules: RecurrenceRule[]; normalized: boolean } {
  if (!Array.isArray(raw)) return { rules: [], normalized: false };
  let normalized = false;
  const ids = new Set<string>();
  const priorities = new Set<string>();
  const rules: RecurrenceRule[] = [];
  for (const r of raw) {
    if (!isObj(r) || !nonEmpty(r.id) || ids.has(r.id)) {
      warnings.push("Skipped an invalid or duplicate recurrence rule.");
      normalized = true;
      continue;
    }
    const rec = readRecurrence(r.recurrence);
    if (!rec) {
      warnings.push(`Skipped recurrence rule ${r.id} with an invalid schedule.`);
      normalized = true;
      continue;
    }
    normalized ||= rec.normalized;
    ids.add(r.id);
    let priority = nonEmpty(r.priority) ? r.priority : "a0";
    while (priorities.has(priority)) {
      priority = keyAfter([...priorities].sort(compareKeys).at(-1));
      normalized = true;
    }
    priorities.add(priority);
    rules.push({
      id: r.id,
      name: isStr(r.name) ? r.name : "Recurring",
      enabled: r.enabled !== false,
      priority,
      recurrence: rec.value,
      templates: Array.isArray(r.templates) ? r.templates.filter(nonEmpty) : [],
    });
  }
  return { rules, normalized };
}

function readPreparedDays(raw: unknown, today: string): { days: string[]; normalized: boolean } {
  if (!Array.isArray(raw)) return { days: [], normalized: false };
  const days = [...new Set(raw.filter(isDayKey).filter((d) => d >= today))].sort();
  const normalized = days.length !== raw.length || days.some((d, i) => d !== raw[i]);
  return { days, normalized };
}

export function normalizeViewState(
  raw: unknown,
  itemIds: Set<string>,
  spaces: Space[],
): ViewState {
  const d = defaultViewState();
  const v = isObj(raw) ? raw : {};
  const ids = (x: unknown) =>
    Array.isArray(x) ? [...new Set(x.filter((id): id is string => isStr(id) && itemIds.has(id)))] : [];
  const spaceOk = (id: unknown) => isStr(id) && spaces.some((s) => s.id === id && !s.archived);
  const vs: ViewState = {
    focusedView: v.focusedView === "calendar" ? "calendar" : "columns",
    showColumnsView: typeof v.showColumnsView === "boolean" ? v.showColumnsView : d.showColumnsView,
    showCalendarView: typeof v.showCalendarView === "boolean" ? v.showCalendarView : d.showCalendarView,
    showCalendarDayPicker:
      typeof v.showCalendarDayPicker === "boolean" ? v.showCalendarDayPicker : d.showCalendarDayPicker,
    columnsSelection: ids(v.columnsSelection),
    columnsPath: ids(v.columnsPath),
    calendarSelection: ids(v.calendarSelection),
    calendarCurrentDate: d.calendarCurrentDate,
    currentSpaceId: spaceOk(v.currentSpaceId) ? (v.currentSpaceId as string) : ROOT_SPACE_ID,
  };
  if (!vs.showColumnsView && !vs.showCalendarView) vs.showColumnsView = true;
  if (vs.focusedView === "columns" && !vs.showColumnsView) vs.focusedView = "calendar";
  if (vs.focusedView === "calendar" && !vs.showCalendarView) vs.focusedView = "columns";
  return vs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseDocument(text: string, today = todayKey()): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new DocumentFormatError(`The file is not valid JSON: ${(e as Error).message}`);
  }
  const warnings: string[] = [];
  let sourceVersion: number;
  let rawItems: unknown;
  let rawConfig: Json = {};
  if (Array.isArray(data)) {
    sourceVersion = 1;
    rawItems = data;
  } else if (isObj(data)) {
    const v = data.file_version;
    if (v !== 2 && v !== 3 && v !== 4) {
      throw new DocumentFormatError(`Unsupported file version: ${String(v)}`);
    }
    sourceVersion = v;
    rawItems = data.items;
    rawConfig = isObj(data.configuration) ? data.configuration : {};
    if (!Array.isArray(rawItems)) throw new DocumentFormatError("The document has no items array.");
  } else {
    throw new DocumentFormatError("The file is not a document.");
  }

  const itemList = rawItems as unknown[];
  const parents = new Set<string>();
  for (const r of itemList) {
    if (isObj(r)) {
      const p = r.parent_id ?? r.parentId;
      if (nonEmpty(p)) parents.add(p);
    }
  }
  const items: Record<string, Item> = {};
  for (const r of itemList) {
    const it = readItem(r, parents, warnings);
    if (!it) continue;
    if (items[it.id]) {
      warnings.push(`Skipped duplicate item id ${it.id}.`);
      continue;
    }
    items[it.id] = it;
  }

  const spaces = readSpaces(rawConfig.spaces, warnings);
  const spaceIds = new Set(spaces.map((s) => s.id));
  const repaired = repairPlacement(items, spaceIds, warnings);
  const rec = readRecurrenceRules(rawConfig.recurrenceRules, warnings);
  const prepared = readPreparedDays(rawConfig.preparedDays, today);
  const progressionMode: ProgressionMode =
    rawConfig.progressionMode === "by_task_count" ? "by_task_count" : "by_level";

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawConfig)) if (!CONFIG_KEYS.has(k)) extra[k] = v;

  const config: DocConfig = {
    recurrenceRules: rec.rules,
    preparedDays: prepared.days,
    progressionMode,
    spaces,
    tags: readTags(rawConfig.tags),
    conditionalFormatting: readRules(rawConfig.conditionalFormatting, warnings),
    viewState: normalizeViewState(rawConfig.viewState, new Set(Object.keys(items)), spaces),
    ...(Object.keys(extra).length ? { extra } : {}),
  };

  return {
    doc: { items, config },
    sourceVersion,
    shouldRewrite: sourceVersion !== CURRENT_FILE_VERSION || rec.normalized || prepared.normalized || repaired,
    warnings,
  };
}

function writeConfig(c: DocConfig): Json {
  const out: Json = {
    recurrenceRules: c.recurrenceRules.map((r) => ({
      ...r,
      recurrence: Object.fromEntries(
        Object.entries(r.recurrence).filter(([k, v]) => !(k === "endDate" && (v === null || v === undefined))),
      ),
    })),
    preparedDays: [...c.preparedDays],
    progressionMode: c.progressionMode,
    spaces: c.spaces.map((s) => ({ ...s, archived: s.archived === true })),
    tags: c.tags.map((t) => ({ ...t })),
    conditionalFormatting: c.conditionalFormatting.map((r) => ({ ...r })),
  };
  if (c.viewState) {
    const v = c.viewState;
    out.viewState = {
      focusedView: v.focusedView,
      showColumnsView: v.showColumnsView,
      showCalendarView: v.showCalendarView,
      showCalendarDayPicker: v.showCalendarDayPicker,
      columnsSelection: [...v.columnsSelection],
      columnsPath: [...v.columnsPath],
      calendarSelection: [...v.calendarSelection],
      ...(v.calendarCurrentDate ? { calendarCurrentDate: v.calendarCurrentDate } : {}),
      currentSpaceId: v.currentSpaceId,
    };
  }
  if (c.extra) for (const [k, v] of Object.entries(c.extra)) if (!(k in out)) out[k] = v;
  return out;
}

/** Validate invariants of an in-memory document before it is written. */
export function validateDoc(doc: Doc): void {
  const spaceIds = new Set(doc.config.spaces.map((s) => s.id));
  for (const it of Object.values(doc.items)) {
    const where = `items[${it.id}]`;
    if (!(it.type in TYPE_TO_CODE)) throw new DocumentFormatError(`${where}: unknown type ${it.type}`);
    if ((it.parentId === null) !== (it.position === null))
      throw new DocumentFormatError(`${where}: parent_id and position must be provided together`);
    if ((it.scheduleDate === null) !== (it.schedulePosition === null))
      throw new DocumentFormatError(`${where}: scheduleDate and schedulePosition must be provided together`);
    if (it.parentId === null && it.scheduleDate === null)
      throw new DocumentFormatError(`${where}: an item needs a column or calendar placement`);
    if (it.parentId !== null && !doc.items[it.parentId] && !spaceIds.has(it.parentId))
      throw new DocumentFormatError(`${where}: parent ${it.parentId} does not exist`);
    if (it.scheduleDate !== null && !isDayKey(it.scheduleDate))
      throw new DocumentFormatError(`${where}: invalid scheduleDate ${it.scheduleDate}`);
  }
  if (!spaceIds.has(ROOT_SPACE_ID) || !spaceIds.has(TRASH_SPACE_ID))
    throw new DocumentFormatError("configuration.spaces: Home and Trash spaces are required");
}

export function serializeDocument(doc: Doc): string {
  validateDoc(doc);
  const out = {
    file_version: CURRENT_FILE_VERSION,
    configuration: writeConfig(doc.config),
    items: Object.values(doc.items).map(writeItem),
  };
  return JSON.stringify(out, null, 2);
}

/** Re-mint positions for siblings whose keys collide (used after bulk edits). */
export function dedupePositions(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const prev = out.at(-1);
    out.push(prev !== undefined && compareKeys(k, prev) <= 0 ? keyBetween(prev, null) : k);
  }
  return out;
}
