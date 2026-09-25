// The command menu (Ctrl+K). The root lists every command — including
// selection commands such as "Color Red" and recent documents — under section
// headers that stay visible while filtering. Sub-pages: Move (tree), Schedule
// (month calendar), Search (tree with filters), Icon (grid), Templates, Tags.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Search, ChevronRight, FilePlus, FolderOpen, X as XIcon, Settings, Printer, Layers, HelpCircle, PanelTop, Maximize2,
  CalendarDays, Columns3, Sun, Moon, Monitor, Trash2, CopyPlus, Copy, Scissors, CheckSquare, Tag, CalendarPlus,
  FolderInput, FileText, LayoutTemplate, CalendarCheck, Eraser, ListX, Plus, Info, Bug, ArrowUpDown, BookmarkCheck,
  Settings2, CalendarX, Undo2, Redo2, Keyboard, Pencil, ArrowUp, ArrowDown, ArrowUpToLine, ArrowDownToLine, MousePointer2,
  Shapes, Palette,
} from "lucide-react";
import type { Color, Item, ItemType } from "../../model/types";
import { COLORS, ITEM_TYPES, TRASH_SPACE_ID, isContainerType, isTaggableType } from "../../model/types";
import { childrenOf, descendants, itemsOnDay, topLevelOnly, visibleSpaces } from "../../model/tree";
import { addDays, formatLongDay } from "../../model/dates";
import { set, useApp, updatePrefs, type AppState, type CommandPageId } from "../../state/store";
import { indexOf, selectionOf, today } from "../../state/derived";
import { columnIds, selectColumnItem, selectCalendarItem, switchSpace, calendarDays, focusView, enterEdit, selectAll, selectEdge, setCalendarAnchor } from "../../state/nav";
import {
  addItem, canChangeType, changeType, deleteSelection, descheduleItems, duplicateSelection, moveSelection, moveSelectionTo,
  removeEmptyItems, scheduleSelection, setColor, setIcon, sortColumn, toggleFinished, toggleTag, addTag, trashFinished,
  createSibling, emptyTrash,
} from "../../state/items";
import { copyWithToast, cutSelection } from "../../state/clipboard";
import { closeDocument, newDocument, openDialog, openPath, clearRecentFiles, fromStoredPath } from "../../state/files";
import { closeOverlay, openOverlay, promptText, resumeInlineEdit } from "../../state/overlays";
import { openPrint } from "../../state/printing";
import { openStack } from "../../state/stack";
import { createSpace, createTag, sortedTags, updateSpace } from "../../state/config";
import { historyStep, keyLabel } from "../../state/shortcuts";
import { DOC_TEMPLATES } from "../../state/templates";
import { platform, displayName } from "../../platform";
import { ICON_NAMES, Icon, iconKeywords } from "../icons";
import { fuzzyFilter, fuzzyScore, matchPositions, parseDatePhrase } from "../fuzzy";
import { ProgressPie } from "../ProgressRing";
import { TypeIcon } from "../TypeIcon";
import { MonthGrid, dayStatus } from "../MonthGrid";
import { SORTS } from "./ContextMenu";

interface Row {
  id: string;
  label: string;
  group?: string;
  icon?: ReactNode;
  hint?: string;
  detail?: string;
  keywords?: string;
  page?: CommandPageId;
  run?: () => void;
  /** Indentation level (tree pages). */
  depth?: number;
  /** A greyed, non-selectable row (e.g. the ancestors of a search match). */
  context?: boolean;
}

const PAGE_TITLE: Record<CommandPageId, string> = {
  root: "Commands",
  move: "Move to",
  schedule: "Schedule",
  search: "Search items",
  icon: "Change icon",
  templates: "New from template",
  prepare: "Prepare recurring tasks",
  tags: "Tags",
  colors: "Color",
  types: "Turn into",
  recent: "Recent documents",
};

const PAGE_ACTION: Partial<Record<CommandPageId, string>> = { move: "Move", schedule: "Schedule", search: "Open", icon: "Select", templates: "Create", recent: "Open" };

const TYPE_LABEL: Record<ItemType, string> = { task: "Task", text: "Text", heading: "Heading", folder: "Folder", template: "Template", separator: "Separator" };
const cap = (c: string) => c[0].toUpperCase() + c.slice(1);
const swatch = (c: Color) => <span className={`swatch ${c === "default" ? "is-default" : `c-${c}`}`} />;

/** Shorten a folder path for display: "~/Documents/…/Lists". */
function shortDir(path: string): string {
  const dir = path.replace(/[\\/][^\\/]*$/, "").replace(/^\/home\/[^/]+/, "~");
  const parts = dir.split("/");
  return parts.length > 4 ? [parts[0], parts[1], "…", ...parts.slice(-2)].join("/") : dir;
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

function rootRows(s: AppState): Row[] {
  const out: Row[] = [];
  const hasDoc = !!s.doc;
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  const items = sel.map((id) => ix.items[id]).filter(Boolean);
  const push = (group: string, list: Row[]) => list.forEach((x) => out.push({ ...x, group }));
  const view = s.view.focusedView;

  if (hasDoc && items.length) {
    const n = items.length;
    const single = n === 1 ? items[0] : null;
    push("Selection", [
      ...(single && single.type !== "separator" ? [{ id: "edit", label: "Edit Item", icon: <Pencil size={15} />, hint: keyLabel("edit"), run: () => enterEdit(single.id, "end") }] : []),
      { id: "add-below", label: "Create New Item", icon: <Plus size={15} />, hint: keyLabel("create-sibling"), keywords: "new add below sibling", run: () => createSibling() },
      ...(single && single.parentId && single.type !== "separator" && view === "columns"
        ? [{ id: "add-child", label: "Create Child Item", icon: <Plus size={15} />, hint: keyLabel("create-child"), keywords: "subtask nest folder", run: () => addItem("task", { view: "columns", parentId: single.id }) }]
        : []),
      ...(items.some((x) => x.type === "task") ? [{ id: "toggle-status", label: "Toggle Finished", icon: <CheckSquare size={15} />, hint: keyLabel("toggle-finished"), run: () => toggleFinished(sel) }] : []),
      { id: "schedule", label: "Schedule…", icon: <CalendarPlus size={15} />, hint: keyLabel("schedule"), page: "schedule", keywords: "date calendar day" },
      { id: "move", label: "Move to…", icon: <FolderInput size={15} />, hint: keyLabel("move-to"), page: "move", keywords: "reparent folder space" },
      ...(items.some((x) => isContainerType(x.type)) ? [{ id: "icon", label: "Change Icon…", icon: <Icon name="folder" size={15} />, page: "icon" as const }] : []),
      { id: "duplicate", label: "Duplicate", icon: <CopyPlus size={15} />, hint: keyLabel("duplicate"), run: duplicateSelection },
      { id: "copy", label: "Copy", icon: <Copy size={15} />, hint: keyLabel("copy"), run: () => void copyWithToast() },
      { id: "cut", label: "Cut", icon: <Scissors size={15} />, hint: keyLabel("cut"), run: () => void cutSelection() },
      { id: "print-sel", label: "Print Selection", icon: <Printer size={15} />, hint: keyLabel("print"), run: () => openPrint({ kind: "selection", ids: sel }) },
      { id: "stack-sel", label: "Launch Stack on Selection", icon: <Layers size={15} />, hint: keyLabel("stack"), run: () => openStack({ kind: "selection", ids: sel }) },
      { id: "delete", label: "Delete", icon: <Trash2 size={15} />, hint: keyLabel("delete"), keywords: "trash remove", run: deleteSelection },
    ]);
    push("Move selection", [
      { id: "move-up", label: "Move Up", icon: <ArrowUp size={15} />, hint: keyLabel("move-up"), run: () => moveSelection("up") },
      { id: "move-down", label: "Move Down", icon: <ArrowDown size={15} />, hint: keyLabel("move-down"), run: () => moveSelection("down") },
      { id: "move-first", label: "Move to First Position", icon: <ArrowUpToLine size={15} />, hint: keyLabel("move-first"), run: () => moveSelection("first") },
      { id: "move-last", label: "Move to Last Position", icon: <ArrowDownToLine size={15} />, hint: keyLabel("move-last"), run: () => moveSelection("last") },
    ]);
    push(
      "Change selection type",
      ITEM_TYPES.filter((t) => canChangeType(sel, t, view)).map((t) => ({ id: `type-${t}`, label: `Turn into ${TYPE_LABEL[t]}`, icon: <TypeIcon type={t} size={15} />, keywords: "type convert", run: () => changeType(t, sel) })),
    );
    push(
      "Change selection color",
      COLORS.map((c) => ({ id: `color-${c}`, label: c === "default" ? "No Color" : `Color ${cap(c)}`, icon: swatch(c), keywords: "colour", run: () => setColor(c, sel) })),
    );
    const taggable = items.filter((x) => isTaggableType(x.type));
    if (taggable.length) {
      const plural = n > 1;
      push("Update selected item tags", [
        ...sortedTags(s.doc!.config.tags).map((t) => {
          const all = taggable.every((x) => x.tags.includes(t.id));
          return {
            id: `tag-${t.id}`,
            label: all ? `Remove Tag ${t.name}${plural ? " from Selection" : ""}` : `Add Tag ${t.name}${plural ? " to Selection" : ""}`,
            icon: <span className={`c-${t.color}`} style={{ color: "var(--c)" }}><Icon name={t.icon} size={15} /></span>,
            keywords: "tag label",
            run: () => toggleTag(t.id, sel),
          };
        }),
        { id: "tags-page", label: "New Tag…", icon: <Tag size={15} />, keywords: "create tag", page: "tags" },
      ]);
    }
  }

  if (hasDoc) {
    const cal = view === "calendar";
    const date = cal ? (sel[0] && ix.items[sel[0]]?.scheduleDate) || calendarDays(s)[0] : null;
    const parentId = !cal ? (sel[0] && ix.items[sel[0]]?.parentId) || columnIds(s).filter((id) => !ix.items[id] || isContainerType(ix.items[id].type)).at(-1)! : null;
    const scope = date ? { date } : { parentId: parentId! };
    push(`Current ${cal ? "day" : "column"}`, [
      { id: "new-here", label: "Create New Item Here", icon: <Plus size={15} />, run: () => addItem("task", date ? { view: "calendar", date } : { view: "columns", parentId: parentId! }) },
      { id: "select-first", label: "Select First Item", icon: <MousePointer2 size={15} />, hint: keyLabel("select-first"), run: () => selectEdge("first") },
      { id: "select-last", label: "Select Last Item", icon: <MousePointer2 size={15} />, hint: keyLabel("select-last"), run: () => selectEdge("last") },
      { id: "select-all", label: "Select All", icon: <MousePointer2 size={15} />, hint: keyLabel("select-all"), run: selectAll },
      { id: "template-here", label: "Insert Template…", icon: <BookmarkCheck size={15} />, hint: keyLabel("template"), run: () => openOverlay({ kind: "template", target: date ? { date } : { parentId: parentId! } }) },
      { id: "print-col", label: `Print Current ${cal ? "Day" : "Column"}`, icon: <Printer size={15} />, run: () => openPrint(date ? { kind: "day", date } : { kind: "column", parentId: parentId! }) },
      { id: "stack-col", label: `Launch Stack on Current ${cal ? "Day" : "Column"}`, icon: <Layers size={15} />, run: () => openStack(date ? { kind: "day", date } : { kind: "column", parentId: parentId! }) },
      ...(date && date >= today() ? [{ id: "prepare-day", label: "Prepare Recurring Tasks for This Day", icon: <CalendarCheck size={15} />, run: () => openOverlay({ kind: "prepare", date }) }] : []),
      { id: "trash-finished-col", label: "Delete Finished Items in This Column", icon: <ListX size={15} />, run: () => trashFinished(scope) },
      ...SORTS.map(([k, label]) => ({ id: `sort-${k}`, label: `Sort: ${label}`, icon: <ArrowUpDown size={15} />, keywords: "sort order clean", run: () => sortColumn(scope, k) })),
    ]);

    const space = ix.spaces.find((x) => x.id === s.view.currentSpaceId);
    push("Current space", [
      { id: "print-space", label: "Print Current Space", icon: <Printer size={15} />, run: () => openPrint({ kind: "space", spaceId: s.view.currentSpaceId }) },
      { id: "stack-space", label: "Launch Stack on Current Space", icon: <Layers size={15} />, run: () => openStack({ kind: "space", spaceId: s.view.currentSpaceId }) },
      ...(space && space.id !== TRASH_SPACE_ID
        ? [{ id: "rename-space", label: "Rename Space…", icon: <Settings2 size={15} />, run: () => promptText({ title: "Rename space", label: "Name", value: space.name, onSubmit: (v) => v.trim() && updateSpace(space.id, { name: v.trim() }) }) }]
        : []),
      {
        id: "new-space",
        label: "New Space…",
        icon: <Plus size={15} />,
        run: () => {
          const id = createSpace();
          if (id) promptText({ title: "New space", label: "Name", value: "New space", onSubmit: (v) => updateSpace(id, { name: v.trim() || "New space" }) });
        },
      },
      { id: "empty-trash", label: "Empty Trash", icon: <Trash2 size={15} />, keywords: "delete permanently", run: emptyTrash },
    ]);
    push(
      "Spaces",
      visibleSpaces(s.doc!.config.spaces).map((sp) => ({ id: `space-${sp.id}`, label: `Go to ${sp.name}`, icon: <Icon name={sp.icon} size={15} />, keywords: "switch space", run: () => switchSpace(sp.id) })),
    );
    push("Views", [
      { id: "focus-columns", label: "Show Columns", icon: <Columns3 size={15} />, run: () => focusView("columns") },
      { id: "focus-calendar", label: "Show Calendar", icon: <CalendarDays size={15} />, hint: keyLabel("focus-view"), run: () => focusView("calendar") },
      { id: "day-picker", label: "Toggle Calendar Day Picker", icon: <CalendarDays size={15} />, run: () => set((st) => ({ view: { ...st.view, showCalendarView: true, showCalendarDayPicker: !st.view.showCalendarDayPicker } })) },
      { id: "search", label: "Search Items…", icon: <Search size={15} />, hint: keyLabel("search"), page: "search", keywords: "find" },
      { id: "undo", label: "Undo", icon: <Undo2 size={15} />, hint: keyLabel("undo"), run: () => historyStep("undo") },
      { id: "redo", label: "Redo", icon: <Redo2 size={15} />, hint: keyLabel("redo"), run: () => historyStep("redo") },
    ]);
  }

  push("Current file", [
    { id: "new-file", label: "New Document…", icon: <FilePlus size={15} />, hint: keyLabel("new-file"), run: () => void newDocument() },
    { id: "new-from-template", label: "New Document from Template…", icon: <LayoutTemplate size={15} />, hint: keyLabel("new-from-template"), page: "templates" },
    { id: "open-file", label: "Open Document…", icon: <FolderOpen size={15} />, hint: keyLabel("open-file"), run: () => void openDialog() },
    ...(hasDoc
      ? [
          { id: "doc-settings", label: "Document Settings", icon: <Settings2 size={15} />, hint: keyLabel("doc-settings"), keywords: "spaces tags formatting recurrence rules progression", run: () => openOverlay({ kind: "docSettings", tab: "general" }) },
          { id: "prepare", label: "Prepare Recurring Tasks…", icon: <CalendarCheck size={15} />, run: () => openOverlay({ kind: "prepare" }) },
          { id: "remove-empty", label: "Remove Empty Items", icon: <Eraser size={15} />, run: removeEmptyItems },
          { id: "trash-finished", label: "Delete Finished Items (All Data)", icon: <ListX size={15} />, run: () => trashFinished() },
          { id: "close-file", label: "Close Document", icon: <XIcon size={15} />, hint: keyLabel("close-file"), run: () => void closeDocument() },
        ]
      : []),
    ...(s.prefs.recentFiles.length ? [{ id: "clear-recent", label: "Clear Recent Documents", icon: <CalendarX size={15} />, run: clearRecentFiles }] : []),
  ]);
  push(
    "Recent documents",
    s.prefs.recentFiles.map((p) => {
      const real = fromStoredPath(p);
      return { id: `recent-${p}`, label: displayName(p), detail: shortDir(real), keywords: real, icon: <FileText size={15} />, run: () => void openPath(p) };
    }),
  );
  push("Application", [
    { id: "settings", label: "Application Settings", icon: <Settings size={15} />, hint: keyLabel("settings"), keywords: "preferences theme triggers", run: () => openOverlay({ kind: "appSettings", tab: "general" }) },
    { id: "print-settings", label: "Print Settings", icon: <Printer size={15} />, keywords: "printer receipt thermal bluetooth mqtt", run: () => openOverlay({ kind: "printSettings" }) },
    { id: "shortcuts", label: "Keyboard Shortcuts", icon: <Keyboard size={15} />, keywords: "hotkeys keys help reference", run: () => updatePrefs({ showHelp: true }) },
    { id: "toggle-help", label: "Toggle Help", icon: <HelpCircle size={15} />, hint: "F1", run: () => updatePrefs({ showHelp: !s.prefs.showHelp }) },
    { id: "toggle-headers", label: "Toggle Column Headers", icon: <PanelTop size={15} />, run: () => updatePrefs({ hideColumnHeaders: !s.prefs.hideColumnHeaders }) },
    { id: "toggle-toolbar", label: "Toggle App Toolbar", icon: <PanelTop size={15} />, run: () => updatePrefs({ hideFloatingActionMenu: !s.prefs.hideFloatingActionMenu }) },
    { id: "fullscreen", label: "Toggle Fullscreen", icon: <Maximize2 size={15} />, hint: "F11", run: () => void platform().toggleFullscreen() },
    { id: "theme-auto", label: "Theme: Follow System", icon: <Monitor size={15} />, run: () => updatePrefs({ theme: "auto" }) },
    { id: "theme-light", label: "Theme: Light", icon: <Sun size={15} />, run: () => updatePrefs({ theme: "light" }) },
    { id: "theme-dark", label: "Theme: Dark", icon: <Moon size={15} />, run: () => updatePrefs({ theme: "dark" }) },
    ...(s.prefs.debugMode !== "disabled" ? [{ id: "debug", label: "State Debug Tools", icon: <Bug size={15} />, run: () => openOverlay({ kind: "debug", tab: s.prefs.debugMode === "disabled" ? "state" : s.prefs.debugMode }) }] : []),
    { id: "about", label: "About Cascade", icon: <Info size={15} />, run: () => openOverlay({ kind: "about" }) },
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// Other list pages
// ---------------------------------------------------------------------------

function typeRows(s: AppState): Row[] {
  const sel = selectionOf(s);
  return ITEM_TYPES.filter((t) => canChangeType(sel, t, s.view.focusedView)).map((t) => ({ id: `type-${t}`, label: TYPE_LABEL[t], icon: <TypeIcon type={t} size={15} />, run: () => changeType(t, sel) }));
}

function colorRows(s: AppState): Row[] {
  const sel = selectionOf(s);
  return COLORS.map((c) => ({ id: `color-${c}`, label: c === "default" ? "No Color" : cap(c), icon: swatch(c), run: () => setColor(c, sel) }));
}

function tagRows(s: AppState, query: string): Row[] {
  const sel = selectionOf(s);
  const ix = indexOf(s.doc);
  const items = sel.map((id) => ix.items[id]).filter((x): x is Item => !!x && isTaggableType(x.type));
  const tags = s.doc?.config.tags ?? [];
  const rows: Row[] = tags.map((t) => ({
    id: `tag-${t.id}`,
    label: `${items.length && items.every((x) => x.tags.includes(t.id)) ? "Remove" : "Add"} tag ${t.name}`,
    icon: <span className={`c-${t.color}`} style={{ color: "var(--c)" }}><Icon name={t.icon} size={15} /></span>,
    keywords: t.name,
    run: () => toggleTag(t.id, sel),
  }));
  const q = query.trim();
  if (q && !tags.some((t) => t.name.toLowerCase() === q.toLowerCase())) {
    rows.unshift({
      id: "tag-create",
      label: `Create tag “${q}”${items.length ? " and add it" : ""}`,
      icon: <Plus size={15} />,
      keywords: q,
      run: () => {
        const id = createTag(q);
        if (id && items.length) addTag(id, sel);
      },
    });
  }
  return rows;
}

/** Spaces and their folder trees; typing keeps matches plus their ancestors. */
function moveRows(s: AppState, query: string): Row[] {
  const ix = indexOf(s.doc);
  const sel = topLevelOnly(ix, selectionOf(s));
  const blocked = new Set<string>(sel);
  for (const id of sel) for (const d of descendants(ix, id)) blocked.add(d.id);
  const rows: Row[] = [];
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const walk = (parentId: string, depth: number): Row[] => {
    const out: Row[] = [];
    for (const it of childrenOf(ix, parentId)) {
      if (!isContainerType(it.type) || blocked.has(it.id)) continue;
      const kids = walk(it.id, depth + 1);
      if (matches(it.text) || kids.length) {
        out.push({ id: `move-${it.id}`, label: it.text || "Untitled", icon: <Icon name={it.icon} fallback={undefined} size={15} />, depth, run: () => moveSelectionTo(it.id) });
        out.push(...kids);
      }
    }
    return out;
  };
  for (const sp of visibleSpaces(ix.spaces)) {
    const kids = walk(sp.id, 1);
    if (matches(sp.name) || kids.length) {
      rows.push({ id: `move-${sp.id}`, label: sp.name, icon: <Icon name={sp.icon} size={15} />, depth: 0, run: () => moveSelectionTo(sp.id) });
      rows.push(...kids);
    }
  }
  return rows;
}

interface SearchFilters {
  source: "columns" | "calendar";
  spaceIds: string[];
  types: ItemType[];
  tagIds: string[];
}

/** Matches grouped under their space (or date), with greyed ancestor rows for context. */
function searchRows(s: AppState, query: string, f: SearchFilters): Row[] {
  const ix = indexOf(s.doc);
  const q = query.trim().toLowerCase();
  const ok = (it: Item) =>
    it.type !== "separator" &&
    (!q || it.text.toLowerCase().includes(q)) &&
    (!f.types.length || f.types.includes(it.type)) &&
    (!f.tagIds.length || f.tagIds.every((t) => it.tags.includes(t)));
  const rows: Row[] = [];
  const open = (it: Item) => (f.source === "calendar" ? selectCalendarItem(it.id) : selectColumnItem(it.id));
  const itemRow = (it: Item, depth: number, context = false): Row => ({
    id: `${context ? "ctx" : "item"}-${it.id}`,
    label: it.text || "Untitled",
    icon: it.type === "task" ? <CheckSquare size={14} /> : isContainerType(it.type) ? <Icon name={it.icon} size={14} /> : <FileText size={14} />,
    depth,
    context,
    run: context ? undefined : () => open(it),
  });
  if (f.source === "calendar") {
    const days = [...ix.byDay.keys()].sort();
    for (const day of days) {
      const hits = itemsOnDay(ix, day).filter(ok);
      if (!hits.length) continue;
      rows.push({ id: `day-${day}`, label: formatLongDay(day), icon: <CalendarDays size={14} />, depth: 0, run: () => { focusView("calendar"); setCalendarAnchor(day); } });
      rows.push(...hits.map((it) => itemRow(it, 1)));
    }
    return rows.slice(0, 400);
  }
  const spaces = visibleSpaces(ix.spaces).filter((sp) => sp.id !== TRASH_SPACE_ID && (!f.spaceIds.length || f.spaceIds.includes(sp.id)));
  for (const sp of spaces) {
    const shown = new Set<string>();
    const block: Row[] = [];
    const visit = (parentId: string, depth: number) => {
      for (const it of childrenOf(ix, parentId)) {
        if (ok(it)) {
          // Ancestors not shown yet appear first, as greyed context rows.
          const chain = breadcrumbIds(ix, it.id);
          chain.forEach((aid, i) => {
            if (shown.has(aid)) return;
            shown.add(aid);
            block.push(itemRow(ix.items[aid], i + 1, true));
          });
          block.push(itemRow(it, chain.length + 1));
          shown.add(it.id);
        }
        visit(it.id, depth + 1);
      }
    };
    visit(sp.id, 1);
    if (block.length) {
      rows.push({ id: `space-${sp.id}`, label: sp.name, icon: <Icon name={sp.icon} size={14} />, depth: 0, run: () => switchSpace(sp.id) });
      rows.push(...block);
    }
  }
  return rows.slice(0, 400);
}

/** Ids of the folders between an item and its space (outermost first). */
function breadcrumbIds(ix: ReturnType<typeof indexOf>, id: string): string[] {
  const out: string[] = [];
  let cur = ix.items[id]?.parentId ?? null;
  while (cur && ix.items[cur]) {
    out.unshift(cur);
    cur = ix.items[cur].parentId;
  }
  return out;
}

function templateRows(): Row[] {
  return DOC_TEMPLATES.map((t) => ({ id: `tpl-${t.id}`, label: t.name, detail: t.description, icon: <Icon name={t.icon} size={15} />, run: () => void newDocument(t) }));
}

function recentRows(s: AppState): Row[] {
  return s.prefs.recentFiles.map((p) => ({ id: `recent-${p}`, label: displayName(p), detail: shortDir(fromStoredPath(p)), icon: <FileText size={15} />, run: () => void openPath(p) }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Highlight({ text, query }: { text: string; query: string }) {
  const pos = query ? matchPositions(query, text) : null;
  if (!pos || !pos.length) return <>{text}</>;
  const set = new Set(pos);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  );
}

const ICON_COLS = 10;

export function CommandPalette({ pages, resume }: { pages: { id: CommandPageId; query: string }[]; resume?: { itemId: string; caret: number } }) {
  const s = useApp((st) => st);
  const page = pages[pages.length - 1];
  const [query, setQuery] = useState(page.query);
  const [active, setActive] = useState(0);
  const [filters, setFilters] = useState<SearchFilters>({ source: "columns", spaceIds: [], types: [], tagIds: [] });
  const [schedDay, setSchedDay] = useState(today());
  const [schedMonth, setSchedMonth] = useState(today());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(page.query);
    setActive(0);
    inputRef.current?.focus();
  }, [page.id, pages.length, page.query]);

  const sel = selectionOf(s);

  // Build the rows for list/tree pages.
  const rows = useMemo<Row[]>(() => {
    switch (page.id) {
      case "root": {
        const all = rootRows(s);
        if (!query.trim()) return all;
        // Filter but keep sections: rank sections by their best match.
        // Scores are bucketed so near-equal matches keep the natural order
        // (selection commands first, then column, space, file, app).
        const bucket = (sc: number) => Math.floor(sc / 50);
        const scored = all
          .map((r, i) => ({ r, i, sc: fuzzyScore(query, `${r.label} ${r.keywords ?? ""} ${r.detail ?? ""}`) }))
          .filter((x) => x.sc !== null)
          .map((x) => ({ ...x, b: bucket(x.sc!) }));
        const best = new Map<string, number>();
        const firstIdx = new Map<string, number>();
        for (const x of scored) {
          const g = x.r.group ?? "";
          best.set(g, Math.max(best.get(g) ?? -Infinity, x.b));
          if (!firstIdx.has(g)) firstIdx.set(g, x.i);
        }
        return scored
          .sort((a, b) => {
            const ga = a.r.group ?? "";
            const gb = b.r.group ?? "";
            return best.get(gb)! - best.get(ga)! || firstIdx.get(ga)! - firstIdx.get(gb)! || b.b - a.b || a.i - b.i;
          })
          .map((x) => x.r);
      }
      case "types":
        return fuzzyFilter(typeRows(s), query, (r) => r.label);
      case "colors":
        return fuzzyFilter(colorRows(s), query, (r) => r.label);
      case "tags":
        return fuzzyFilter(tagRows(s, query), query, (r) => `${r.label} ${r.keywords ?? ""}`);
      case "move":
        return moveRows(s, query);
      case "search":
        return searchRows(s, query, filters);
      case "templates":
        return fuzzyFilter(templateRows(), query, (r) => `${r.label} ${r.detail}`);
      case "recent":
      case "prepare":
        return fuzzyFilter(recentRows(s), query, (r) => `${r.label} ${r.detail}`);
      default:
        return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, s.doc, s.view, s.prefs, filters, query]);

  const icons = useMemo(() => (page.id === "icon" ? fuzzyFilter(ICON_NAMES, query, iconKeywords).slice(0, 160) : []), [page.id, query]);
  const selectable = rows.map((r, i) => (r.context ? -1 : i)).filter((i) => i >= 0);

  // Schedule page: typed phrases move the calendar.
  useEffect(() => {
    if (page.id !== "schedule") return;
    const d = parseDatePhrase(query, today(), s.prefs.weekStartsOn);
    if (d) {
      setSchedDay(d);
      setSchedMonth(d);
    }
  }, [query, page.id, s.prefs.weekStartsOn]);

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, schedDay]);

  const finish = (run?: () => void) => {
    // Run with the palette gone; then, if it was opened with "::" while
    // editing, go back to editing (unless the command opened something else).
    set({ overlay: null, overlayStack: [] });
    run?.();
    resumeInlineEdit(resume);
  };

  const choose = (row: Row | undefined) => {
    if (!row || row.context) return;
    if (row.page) {
      set({ overlay: { kind: "command", pages: [...pages.slice(0, -1), { ...page, query }, { id: row.page, query: "" }], resume } });
      return;
    }
    finish(row.run);
  };

  const back = () => {
    if (pages.length > 1) set({ overlay: { kind: "command", pages: pages.slice(0, -1), resume } });
    else closeOverlay();
  };

  const schedulable = sel.filter((id) => s.doc?.items[id] && s.doc.items[id].type !== "separator");
  const schedule = (d: string) => schedulable.length && finish(() => scheduleSelection(d));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay(); // Esc closes the whole menu
      return;
    }
    if (k === "Backspace" && query === "" && pages.length > 1) {
      e.preventDefault();
      back();
      return;
    }
    if (page.id === "schedule") {
      const step = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : k === "ArrowUp" ? -7 : k === "ArrowDown" ? 7 : 0;
      if (step && (k === "ArrowUp" || k === "ArrowDown" || query === "")) {
        e.preventDefault();
        const d = addDays(schedDay, step);
        setSchedDay(d);
        setSchedMonth(d);
      } else if (k === "Enter") {
        e.preventDefault();
        schedule(schedDay);
      }
      return;
    }
    if (page.id === "icon") {
      const step = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : k === "ArrowUp" ? -ICON_COLS : k === "ArrowDown" ? ICON_COLS : 0;
      if (step) {
        e.preventDefault();
        setActive((a) => Math.min(icons.length, Math.max(0, a + step)));
      } else if (k === "Enter") {
        e.preventDefault();
        finish(() => setIcon(active === 0 ? null : icons[active - 1], sel));
      }
      return;
    }
    const pos = selectable.indexOf(active);
    if (k === "ArrowDown" || (k === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive(selectable[Math.min(selectable.length - 1, pos + 1)] ?? active);
    } else if (k === "ArrowUp" || (k === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive(selectable[Math.max(0, pos - 1)] ?? active);
    } else if (k === "PageDown") {
      e.preventDefault();
      setActive(selectable[Math.min(selectable.length - 1, pos + 8)] ?? active);
    } else if (k === "PageUp") {
      e.preventDefault();
      setActive(selectable[Math.max(0, pos - 8)] ?? active);
    } else if (k === "Enter") {
      e.preventDefault();
      choose(rows[active]);
    }
  };

  // Keep the active row on a selectable one; on Search/Move start at the
  // first actual match rather than a space header.
  useEffect(() => {
    if ((page.id === "search" || page.id === "move") && query.trim()) {
      const q = query.trim().toLowerCase();
      const first = rows.findIndex((r) => !r.context && (page.id === "search" ? r.id.startsWith("item-") : r.label.toLowerCase().includes(q)));
      if (first >= 0) {
        setActive(first);
        return;
      }
    }
    if (!selectable.includes(active)) setActive(selectable[0] ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const tags = s.doc?.config.tags ?? [];
  const placeholder =
    page.id === "root"
      ? "Type a command or recent document…"
      : page.id === "schedule"
        ? "today, tomorrow, fri, next week, dec 5, +3…"
        : page.id === "search"
          ? "Search items…"
          : "Filter…";
  let lastGroup: string | undefined;
  const grid = page.id === "icon" || page.id === "schedule";

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div className="palette" role="dialog" aria-label={PAGE_TITLE[page.id]}>
        <div className="palette-input-row">
          {pages.length > 1 && (
            <span className="palette-crumb">
              {PAGE_TITLE[page.id]}
              <ChevronRight size={13} />
            </span>
          )}
          <Search size={16} className="faint" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (page.id !== "schedule") setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {page.id === "search" && (
          <div className="palette-filters">
            <div className="segmented">
              <button aria-pressed={filters.source === "columns"} onClick={() => setFilters((f) => ({ ...f, source: "columns" }))}>
                Columns
              </button>
              <button aria-pressed={filters.source === "calendar"} onClick={() => setFilters((f) => ({ ...f, source: "calendar" }))}>
                Calendar
              </button>
            </div>
            {filters.source === "columns" &&
              visibleSpaces(s.doc?.config.spaces ?? [])
                .filter((sp) => sp.id !== TRASH_SPACE_ID)
                .map((sp) => (
                  <button
                    key={sp.id}
                    className={`filter-chip ${filters.spaceIds.includes(sp.id) ? "is-on" : ""}`}
                    onClick={() => setFilters((f) => ({ ...f, spaceIds: f.spaceIds.includes(sp.id) ? f.spaceIds.filter((x) => x !== sp.id) : [...f.spaceIds, sp.id] }))}
                  >
                    <Icon name={sp.icon} size={11} /> {sp.name}
                  </button>
                ))}
            {(["task", "folder", "heading", "text", "template"] as ItemType[]).map((t) => (
              <button
                key={t}
                className={`filter-chip ${filters.types.includes(t) ? "is-on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t] }))}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
            {tags.map((t) => (
              <button
                key={t.id}
                className={`filter-chip c-${t.color} ${filters.tagIds.includes(t.id) ? "is-on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, tagIds: f.tagIds.includes(t.id) ? f.tagIds.filter((x) => x !== t.id) : [...f.tagIds, t.id] }))}
              >
                #{t.name}
              </button>
            ))}
          </div>
        )}

        <div className="palette-list" ref={listRef} role="listbox">
          {page.id === "schedule" ? (
            schedulable.length === 0 ? (
              <div className="palette-empty">No schedulable items selected</div>
            ) : (
              <div className="palette-schedule">
                <MonthGrid
                  month={schedMonth}
                  today={today()}
                  weekStartsOn={s.prefs.weekStartsOn}
                  selected={schedDay}
                  status={(d) => dayStatus(indexOf(s.doc), d)}
                  onHover={setSchedDay}
                  onSelect={(d) => schedule(d)}
                  onMonthChange={setSchedMonth}
                />
                <div className="row palette-schedule-quick">
                  <button className="btn btn-sm" onClick={() => schedule(today())}>
                    Today
                  </button>
                  <button className="btn btn-sm" onClick={() => schedule(addDays(today(), 1))}>
                    Tomorrow
                  </button>
                  <button className="btn btn-sm" onClick={() => schedule(addDays(today(), 7))}>
                    In a week
                  </button>
                  {schedulable.some((id) => s.doc?.items[id]?.scheduleDate) && (
                    <button className="btn btn-sm" onClick={() => finish(() => descheduleItems(schedulable))}>
                      <CalendarX size={13} /> Remove from calendar
                    </button>
                  )}
                  <span className="grow" />
                  <span className="muted small">{formatLongDay(schedDay)}</span>
                </div>
              </div>
            )
          ) : page.id === "icon" ? (
            <div className="palette-icon-grid" style={{ gridTemplateColumns: `repeat(${ICON_COLS}, 1fr)` }}>
              <button className={`icon-cell ${active === 0 ? "is-active" : ""}`} title="Progress circle (default)" onMouseEnter={() => setActive(0)} onClick={() => finish(() => setIcon(null, sel))}>
                <ProgressPie value={0.6} size={18} />
              </button>
              {icons.map((n, i) => (
                <button key={n} className={`icon-cell ${active === i + 1 ? "is-active" : ""}`} title={n} onMouseEnter={() => setActive(i + 1)} onClick={() => finish(() => setIcon(n, sel))}>
                  <Icon name={n} size={18} />
                </button>
              ))}
            </div>
          ) : (
            <>
              {rows.length === 0 && <div className="palette-empty">No matches</div>}
              {rows.map((row, i) => {
                const header = page.id === "root" && row.group !== lastGroup ? row.group : undefined;
                lastGroup = row.group;
                return (
                  <div key={row.id}>
                    {header && <div className="palette-group">{header}</div>}
                    <div
                      role="option"
                      aria-selected={i === active}
                      aria-disabled={row.context}
                      className={`palette-item ${i === active ? "is-active" : ""} ${row.context ? "is-context" : ""}`}
                      style={row.depth ? { paddingLeft: 10 + row.depth * 18 } : undefined}
                      onMouseMove={() => !row.context && setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(row);
                      }}
                    >
                      <span className="palette-icon">{row.icon}</span>
                      <span className="palette-label">
                        <Highlight text={row.label} query={query} />
                      </span>
                      {row.detail && <span className="palette-detail">{row.detail}</span>}
                      {row.hint && <span className="kbd">{row.hint}</span>}
                      {row.page && <ChevronRight size={14} className="faint" />}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="palette-footer">
          <span className="palette-footer-title">
            {page.id === "root" ? <Shapes size={12} /> : page.id === "schedule" ? <CalendarPlus size={12} /> : page.id === "icon" ? <Palette size={12} /> : <Search size={12} />}
            {PAGE_TITLE[page.id]}
          </span>
          <span className="grow" />
          {pages.length > 1 && (
            <span>
              <span className="kbd">⌫</span> Back
            </span>
          )}
          <span>
            <span className="kbd">{grid ? "←↑↓→" : "↑↓"}</span> Navigate
          </span>
          <span>
            <span className="kbd">↵</span> {PAGE_ACTION[page.id] ?? "Run"}
          </span>
          <span>
            <span className="kbd">Esc</span> Close
          </span>
        </div>
      </div>
    </div>
  );
}
