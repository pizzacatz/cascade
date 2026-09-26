// Headless document operations shared by `cascade-cli` and the MCP server.
//
// Every call is stateless: read the file, apply one change using the same
// operations the app uses (so ordering keys, folder conversion, Trash, tags…
// behave identically), then write it back atomically. The running app notices
// the change on disk and reloads it.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, basename as pathBasename, join, resolve } from "node:path";
import type { Color, Doc, Item, ItemType, ViewState } from "../model/types";
import { COLORS, ITEM_TYPES, ROOT_SPACE_ID, TRASH_SPACE_ID, isContainerType, isTaggableType } from "../model/types";
import { parseDocument, serializeDocument, normalizeViewState } from "../model/format";
import { breadcrumb, childrenOf, descendants, itemsOnDay, spaceOf, topLevelOnly, visibleSpaces, type DocIndex } from "../model/tree";
import { addDays, isDayKey, todayKey } from "../model/dates";
import { nowIso } from "../model/defaults";
import { get, set, transact } from "../state/store";
import { indexOf, statsOf } from "../state/derived";
import {
  addItem as addItemOp,
  addTag,
  canChangeType,
  changeType,
  descheduleItems,
  moveItemsTo,
  removeTag,
  scheduleItems as scheduleOp,
  setColor,
  setFinished as setFinishedOp,
  setIcon,
} from "../state/items";
import { createSpace, createTag, prepareDay as prepareDayOp, type PrepareResult } from "../state/config";
import { DOC_TEMPLATES } from "../state/templates";
import { overdueItems, rollOverOverdue } from "../state/schedule";
import { buildIcs, exportableItems, icsPathFor } from "../model/ics";
import * as backups from "./backups";

export class CascadeError extends Error {}

// ---------------------------------------------------------------------------
// Session: load → mutate → save
// ---------------------------------------------------------------------------

let current: { path: string; text: string; viewState?: ViewState } | null = null;

/**
 * Back up a document before an outside edit unless one was taken recently, so
 * a burst of agent edits leaves one restorable copy of the state before it
 * (and does not push the app's older backups out of the rotation).
 */
export const BACKUP_MIN_GAP_MS = 2 * 60 * 1000;

function backupBeforeWrite(path: string, text: string) {
  try {
    const newest = backups.listBackups(path)[0];
    if (newest && Date.now() - newest.time < BACKUP_MIN_GAP_MS) return;
    backups.writeBackup(path, text);
  } catch (e) {
    // A failed backup must not block the edit itself.
    process.stderr.write(`cascade-cli: could not back up ${path}: ${(e as Error).message}\n`);
  }
}

export function load(file: string): Doc {
  const path = resolve(file);
  if (!existsSync(path)) throw new CascadeError(`No such document: ${path}`);
  const text = readFileSync(path, "utf8");
  const { doc } = parseDocument(text);
  current = { path, text, viewState: doc.config.viewState };
  set({
    doc,
    filePath: path,
    view: doc.config.viewState!,
    past: [],
    future: [],
    edit: null,
    createTarget: null,
    unsavedPatches: [],
  });
  return doc;
}

export function save(): void {
  const s = get();
  if (!s.doc || !current) throw new CascadeError("No document loaded");
  // Keep the file's own view state (the app owns it), dropping ids we deleted.
  const vs = current.viewState
    ? normalizeViewState(current.viewState, new Set(Object.keys(s.doc.items)), s.doc.config.spaces)
    : undefined;
  const text = serializeDocument({ ...s.doc, config: { ...s.doc.config, viewState: vs } });
  backupBeforeWrite(current.path, current.text);
  writeAtomic(current.path, text);
  current.text = text;
  // An existing .ics copy next to the document (the app's "keep an .ics copy"
  // setting) is kept up to date.
  const ics = icsPathFor(current.path);
  if (existsSync(ics)) writeAtomic(ics, buildIcs(s.doc, { name: pathBasename(current.path).replace(/\.col$/i, "") }));
}

function writeAtomic(path: string, text: string) {
  const tmp = join(dirname(path), `.${pathBasename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Run a mutation against a file and save it. */
export function withDoc<T>(file: string, fn: () => T, mutate = true): T {
  load(file);
  const out = fn();
  if (mutate && get().past.length > 0) save();
  return out;
}

const ix = (): DocIndex => indexOf(get().doc);

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface ItemInfo {
  id: string;
  type: ItemType;
  text: string;
  finished?: boolean;
  date?: string;
  color?: Color;
  icon?: string;
  tags?: string[];
  /** Human-readable location, e.g. "Home / Work / Website". */
  path: string;
  parentId: string | null;
  space: string | null;
  /** Folders: number of direct children and task progress. */
  childCount?: number;
  progress?: string;
  children?: ItemInfo[];
}

export function describe(it: Item, depth = 0): ItemInfo {
  const x = ix();
  const tags = get().doc!.config.tags;
  const info: ItemInfo = {
    id: it.id,
    type: it.type,
    text: it.text,
    path: it.parentId ? breadcrumb(x, it.id).join(" / ") : it.scheduleDate ? `Calendar ${it.scheduleDate}` : "",
    parentId: it.parentId,
    space: spaceOf(x, it.id),
  };
  if (it.type === "task") info.finished = it.finished;
  if (it.scheduleDate) info.date = it.scheduleDate;
  if (it.color !== "default") info.color = it.color;
  if (it.icon && isContainerType(it.type)) info.icon = it.icon;
  if (it.tags.length) info.tags = it.tags.map((t) => tags.find((g) => g.id === t)?.name ?? t);
  if (isContainerType(it.type)) {
    const kids = childrenOf(x, it.id);
    info.childCount = kids.length;
    const st = statsOf(get().doc).get(it.id);
    if (st && st.totalTaskCount) info.progress = `${st.completedTaskCount}/${st.totalTaskCount}`;
    if (depth > 0) info.children = kids.map((k) => describe(k, depth - 1));
  }
  return info;
}

// ---------------------------------------------------------------------------
// Reference resolution: ids, names, and "Space/Folder/Sub" paths
// ---------------------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase();

function spaceByRef(ref: string) {
  const spaces = get().doc!.config.spaces;
  return spaces.find((s) => s.id === ref) ?? spaces.find((s) => norm(s.name) === norm(ref));
}

/** Resolve an item by id, or by exact (case-insensitive) text, or by path. */
export function resolveItem(ref: string): Item {
  const d = get().doc!;
  if (d.items[ref]) return d.items[ref];
  if (ref.includes("/")) {
    const target = resolveContainer(ref);
    if (d.items[target]) return d.items[target];
  }
  const named = Object.values(d.items).filter((i) => norm(i.text) === norm(ref));
  const live = named.filter((i) => spaceOf(ix(), i.id) !== TRASH_SPACE_ID);
  // Prefer items outside Trash; fall back to Trash so trashed items can still be referenced.
  const matches = live.length ? live : named;
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CascadeError(
      `"${ref}" matches ${matches.length} items; use an id:\n` + matches.map((m) => `  ${m.id}  ${describe(m).path} / ${m.text}`).join("\n"),
    );
  }
  throw new CascadeError(`No item matches "${ref}"`);
}

/** Resolve a column target (space or folder) by id, name, or "Space/Folder" path. */
export function resolveContainer(ref: string | undefined): string {
  const d = get().doc!;
  if (!ref) return ROOT_SPACE_ID;
  const sp = spaceByRef(ref);
  if (sp) return sp.id;
  if (d.items[ref]) return ref;
  const parts = ref.split("/").map((p) => p.trim()).filter(Boolean);
  let parent = ROOT_SPACE_ID;
  let i = 0;
  const first = parts[0] && spaceByRef(parts[0]);
  if (first) {
    parent = first.id;
    i = 1;
  }
  for (; i < parts.length; i++) {
    const kids = childrenOf(ix(), parent).filter((k) => norm(k.text) === norm(parts[i]));
    if (kids.length !== 1) {
      if (parts.length === 1) {
        // A bare name anywhere in the document.
        const all = Object.values(d.items).filter((x) => norm(x.text) === norm(parts[0]) && x.type !== "separator");
        if (all.length === 1) return all[0].id;
      }
      throw new CascadeError(kids.length ? `"${parts[i]}" is ambiguous in ${ref}` : `No "${parts[i]}" in ${ref}`);
    }
    parent = kids[0].id;
  }
  return parent;
}

function parseType(t: string | undefined, fallback: ItemType = "task"): ItemType {
  if (!t) return fallback;
  if ((ITEM_TYPES as readonly string[]).includes(t)) return t as ItemType;
  if (t === "note") return "text";
  throw new CascadeError(`Unknown type "${t}" (use ${ITEM_TYPES.join(", ")})`);
}

function parseColor(c: string): Color {
  if ((COLORS as readonly string[]).includes(c)) return c as Color;
  throw new CascadeError(`Unknown color "${c}" (use ${COLORS.join(", ")})`);
}

/** Accept YYYY-MM-DD, today, tomorrow, yesterday, or +N / -N days. */
export function parseDate(v: string): string {
  const s = v.trim().toLowerCase();
  const t = todayKey();
  if (s === "today") return t;
  if (s === "tomorrow") return addDays(t, 1);
  if (s === "yesterday") return addDays(t, -1);
  if (/^[+-]\d+$/.test(s)) return addDays(t, Number(s));
  if (isDayKey(s)) return s;
  throw new CascadeError(`Invalid date "${v}" (use YYYY-MM-DD, today, tomorrow, or +N)`);
}

function tagId(name: string, create: boolean): string {
  const d = get().doc!;
  const t = d.config.tags.find((g) => g.id === name || norm(g.name) === norm(name));
  if (t) return t.id;
  if (!create) throw new CascadeError(`No tag named "${name}"`);
  return createTag(name)!;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ListOptions {
  parent?: string;
  /** How many levels of children to include (default 1; "all" for everything). */
  depth?: number | "all";
  includeFinished?: boolean;
}

export function listItems(opts: ListOptions = {}): { location: string; items: ItemInfo[] } {
  const parent = resolveContainer(opts.parent);
  const depth = opts.depth === "all" ? 999 : Math.max(0, (opts.depth ?? 1) - 1);
  const filter = (list: ItemInfo[]): ItemInfo[] =>
    list
      .filter((i) => opts.includeFinished !== false || !i.finished)
      .map((i) => (i.children ? { ...i, children: filter(i.children) } : i));
  const d = get().doc!;
  const location = d.items[parent] ? describe(d.items[parent]).path + " / " + d.items[parent].text : spaceByRef(parent)?.name ?? parent;
  return { location, items: filter(childrenOf(ix(), parent).map((i) => describe(i, depth))) };
}

export function getItem(ref: string, depth = 1): ItemInfo {
  return describe(resolveItem(ref), depth);
}

export interface AddOptions {
  text: string;
  type?: string;
  parent?: string;
  after?: string;
  first?: boolean;
  date?: string;
  color?: string;
  tags?: string[];
  icon?: string;
  finished?: boolean;
}

export function addItem(o: AddOptions): ItemInfo {
  const type = parseType(o.type);
  const fields: Partial<Item> = { text: type === "separator" ? "" : o.text };
  if (o.color) fields.color = parseColor(o.color);
  if (o.icon && isContainerType(type)) fields.icon = o.icon;
  if (o.finished && type === "task") {
    fields.finished = true;
    fields.finishedAt = nowIso();
  }
  const date = o.date ? parseDate(o.date) : undefined;
  let id: string | null;
  if (date && !o.parent && !o.after) {
    if (isContainerType(type)) throw new CascadeError("Folders need a parent; give --parent as well as --date");
    id = addItemOp(type, { view: "calendar", date }, fields, false);
  } else {
    let parentId: string;
    let afterId: string | null | undefined;
    if (o.after) {
      const a = resolveItem(o.after);
      if (!a.parentId) throw new CascadeError(`"${o.after}" is not in a column`);
      parentId = a.parentId;
      afterId = a.id;
    } else {
      parentId = resolveContainer(o.parent);
      afterId = o.first ? null : undefined;
    }
    id = addItemOp(type, { view: "columns", parentId, afterId }, fields, false);
    if (!id) throw new CascadeError("Items cannot be added under a separator");
    if (date) scheduleOp([id], date);
  }
  if (!id) throw new CascadeError("Could not add the item");
  if (o.tags?.length) {
    if (!isTaggableType(type)) throw new CascadeError(`Tags are only allowed on tasks, folders and templates`);
    for (const t of o.tags) addTag(tagId(t, true), [id]);
  }
  return describe(get().doc!.items[id]);
}

export interface UpdateOptions {
  text?: string;
  type?: string;
  color?: string;
  icon?: string | null;
  addTags?: string[];
  removeTags?: string[];
  finished?: boolean;
}

export function updateItem(ref: string, o: UpdateOptions): ItemInfo {
  const it = resolveItem(ref);
  if (o.type) {
    const type = parseType(o.type);
    if (type !== it.type) {
      if (!canChangeType([it.id], type, "columns"))
        throw new CascadeError(`Cannot turn this ${it.type} into a ${type} (a folder with children must stay a container)`);
      changeType(type, [it.id]);
    }
  }
  if (o.text !== undefined) {
    transact("Edit text", (d) => {
      const x = d.items[it.id];
      x.text = o.text!;
      x.updatedAt = nowIso();
    });
  }
  if (o.color) setColor(parseColor(o.color), [it.id]);
  if (o.icon !== undefined) setIcon(o.icon, [it.id]);
  for (const t of o.addTags ?? []) addTag(tagId(t, true), [it.id]);
  for (const t of o.removeTags ?? []) removeTag(tagId(t, false), [it.id]);
  if (o.finished !== undefined) setFinishedOp([it.id], o.finished);
  return describe(get().doc!.items[it.id]);
}

export function setFinished(refs: string[], finished: boolean): ItemInfo[] {
  const items = refs.map(resolveItem);
  const notTasks = items.filter((i) => i.type !== "task");
  if (notTasks.length) throw new CascadeError(`Only tasks can be finished: ${notTasks.map((i) => i.text || i.id).join(", ")}`);
  setFinishedOp(items.map((i) => i.id), finished);
  return items.map((i) => describe(get().doc!.items[i.id]));
}

export function moveItems(refs: string[], to: string, opts: { after?: string; first?: boolean } = {}): ItemInfo[] {
  const ids = refs.map((r) => resolveItem(r).id);
  const target = resolveContainer(to);
  let afterId: string | null | undefined;
  if (opts.after) afterId = resolveItem(opts.after).id;
  else if (opts.first) afterId = null;
  if (!moveItemsTo(ids, target, { afterId })) {
    throw new CascadeError("Could not move there (into a separator, or into one of the items being moved?)");
  }
  return ids.map((id) => describe(get().doc!.items[id]));
}

export function scheduleItems(refs: string[], date: string | null): ItemInfo[] {
  const ids = refs.map((r) => resolveItem(r).id);
  if (date === null) descheduleItems(ids);
  else scheduleOp(ids, parseDate(date));
  return ids.map((id) => describe(get().doc!.items[id]));
}

export function deleteItems(refs: string[], opts: { permanent?: boolean } = {}): { trashed: string[]; deleted: string[] } {
  const x = ix();
  const ids = topLevelOnly(x, refs.map((r) => resolveItem(r).id));
  const permanent = ids.filter((id) => opts.permanent || spaceOf(x, id) === TRASH_SPACE_ID);
  const toTrash = ids.filter((id) => !permanent.includes(id));
  if (toTrash.length) moveItemsTo(toTrash, TRASH_SPACE_ID);
  if (permanent.length) {
    transact("Delete permanently", (d) => {
      for (const id of permanent) {
        for (const c of descendants(x, id)) delete d.items[c.id];
        delete d.items[id];
      }
    });
  }
  return { trashed: toTrash, deleted: permanent };
}

export interface SearchOptions {
  types?: string[];
  tags?: string[];
  includeTrash?: boolean;
  includeFinished?: boolean;
  limit?: number;
}

export function search(query: string, o: SearchOptions = {}): ItemInfo[] {
  const q = norm(query);
  const types = o.types?.map((t) => parseType(t));
  const tagIds = o.tags?.map((t) => tagId(t, false));
  const x = ix();
  return Object.values(get().doc!.items)
    .filter((i) => i.type !== "separator")
    .filter((i) => !q || norm(i.text).includes(q))
    .filter((i) => !types?.length || types.includes(i.type))
    .filter((i) => !tagIds?.length || tagIds.every((t) => i.tags.includes(t)))
    .filter((i) => o.includeTrash || spaceOf(x, i.id) !== TRASH_SPACE_ID)
    .filter((i) => o.includeFinished !== false || !i.finished)
    .slice(0, o.limit ?? 200)
    .map((i) => describe(i));
}

/** Tasks scheduled on a day, plus unfinished overdue tasks when the day is today. */
export function agenda(date = "today"): { date: string; items: ItemInfo[]; overdue: ItemInfo[] } {
  const day = parseDate(date);
  const x = ix();
  const t = todayKey();
  const overdue =
    day === t
      ? Object.values(get().doc!.items).filter((i) => i.type === "task" && !i.finished && i.scheduleDate && i.scheduleDate < t && spaceOf(x, i.id) !== TRASH_SPACE_ID)
      : [];
  return { date: day, items: itemsOnDay(x, day).map((i) => describe(i)), overdue: overdue.map((i) => describe(i)) };
}

export interface AgendaRange {
  from: string;
  to: string;
  days: { date: string; items: ItemInfo[] }[];
  /** Unfinished work scheduled before today (when the range includes today). */
  overdue: ItemInfo[];
}

/** Items per day from `from` to `to` (default: today and the next 6 days). */
export function agendaRange(o: { from?: string; to?: string; days?: number } = {}): AgendaRange {
  const from = parseDate(o.from ?? "today");
  let to = o.to ? parseDate(o.to) : addDays(from, Math.max(1, o.days ?? 7) - 1);
  if (to < from) throw new CascadeError(`The range ends (${to}) before it starts (${from})`);
  if (addDays(from, 366) < to) to = addDays(from, 366);
  const x = ix();
  const days: AgendaRange["days"] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push({ date: d, items: itemsOnDay(x, d).filter((i) => spaceOf(x, i.id) !== TRASH_SPACE_ID).map((i) => describe(i)) });
  }
  const t = todayKey();
  return { from, to, days, overdue: from <= t && t <= to ? overdue() : [] };
}

/** Unfinished tasks, and folders with unfinished tasks, scheduled before today. */
export function overdue(): ItemInfo[] {
  return overdueItems(todayKey()).map((i) => describe(i));
}

/** Move unfinished work scheduled before `date` (default today) onto `date`. */
export function rollOver(date = "today"): { date: string; moved: ItemInfo[] } {
  const day = parseDate(date);
  const ids = overdueItems(day).map((i) => i.id);
  rollOverOverdue(day, { quiet: true });
  return { date: day, moved: ids.map((id) => describe(get().doc!.items[id])) };
}

export function listSpaces() {
  const d = get().doc!;
  return visibleSpaces(d.config.spaces).map((s) => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    color: s.color,
    itemCount: childrenOf(ix(), s.id).length,
  }));
}

export function listTags() {
  return get().doc!.config.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, icon: t.icon }));
}

export function addSpace(name: string): { id: string; name: string } {
  const id = createSpace(name);
  if (!id) throw new CascadeError("Could not create the space");
  return { id, name };
}

export function prepare(date: string): PrepareResult {
  return prepareDayOp(parseDate(date));
}

export function createDocument(file: string, template = "blank"): { path: string; template: string } {
  const path = resolve(file.endsWith(".col") ? file : `${file}.col`);
  if (existsSync(path)) throw new CascadeError(`${path} already exists`);
  const tpl = DOC_TEMPLATES.find((t) => t.id === template);
  if (!tpl) throw new CascadeError(`Unknown template "${template}" (use ${DOC_TEMPLATES.map((t) => t.id).join(", ")})`);
  const doc = tpl.build();
  doc.config.viewState = normalizeViewState(doc.config.viewState, new Set(Object.keys(doc.items)), doc.config.spaces);
  writeFileSync(path, serializeDocument(doc), "utf8");
  return { path, template: tpl.id };
}

export const TEMPLATE_IDS = DOC_TEMPLATES.map((t) => t.id);

// ---------------------------------------------------------------------------
// Backups and calendar export (operate on files directly)
// ---------------------------------------------------------------------------

export interface BackupListing {
  path: string;
  backups: { ref: number; id: string; time: string; size: number; items: number | null; tasks: number | null }[];
}

export function listDocBackups(file: string): BackupListing {
  const path = resolve(file);
  if (!existsSync(path)) throw new CascadeError(`No such document: ${path}`);
  return {
    path,
    backups: backups.listBackups(path).map((b, i) => {
      let items: number | null = null;
      let tasks: number | null = null;
      try {
        const d = parseDocument(backups.readBackup(path, b.id)).doc;
        const all = Object.values(d.items);
        items = all.length;
        tasks = all.filter((x) => x.type === "task").length;
      } catch {
        // Unreadable backup: still listed.
      }
      return { ref: i + 1, id: b.id, time: new Date(b.time).toISOString(), size: b.size, items, tasks };
    }),
  };
}

/**
 * Replace a document with one of its backups (`ref` = 1 for the newest, or a
 * backup id). The current content is backed up first, so this is reversible.
 */
export function restoreDocBackup(file: string, ref: string | number): { path: string; restored: string; restoredTime: string; previousBackup: string } {
  const path = resolve(file);
  if (!existsSync(path)) throw new CascadeError(`No such document: ${path}`);
  const list = backups.listBackups(path);
  const n = typeof ref === "number" ? ref : /^\d{1,4}$/.test(ref) ? Number(ref) : NaN;
  const entry = Number.isFinite(n) ? list[n - 1] : list.find((b) => b.id === ref || b.id.startsWith(`${ref}.`));
  if (!entry) throw new CascadeError(list.length ? `No backup "${ref}" (use 1–${list.length} or an id from list_backups)` : "This document has no backups yet");
  const text = backups.readBackup(path, entry.id);
  parseDocument(text); // refuse to restore something unreadable
  const previousBackup = backups.writeBackup(path, readFileSync(path, "utf8"));
  writeAtomic(path, text);
  return { path, restored: entry.id, restoredTime: new Date(entry.time).toISOString(), previousBackup };
}

export function exportIcs(file: string, out?: string): { path: string; events: number } {
  const path = resolve(file);
  if (!existsSync(path)) throw new CascadeError(`No such document: ${path}`);
  const { doc } = parseDocument(readFileSync(path, "utf8"));
  const target = resolve(out ?? icsPathFor(path));
  writeAtomic(target, buildIcs(doc, { name: pathBasename(path).replace(/\.col$/i, "") }));
  return { path: target, events: exportableItems(doc).length };
}
