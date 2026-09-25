import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Search,
  ChevronRight,
  FilePlus,
  FolderOpen,
  X as XIcon,
  Settings,
  Printer,
  Layers,
  HelpCircle,
  PanelTop,
  Maximize2,
  CalendarDays,
  Columns3,
  Sun,
  Moon,
  Monitor,
  Trash2,
  CopyPlus,
  Copy,
  Scissors,
  CheckSquare,
  Shapes,
  Palette,
  Tag,
  CalendarPlus,
  FolderInput,
  FileText,
  LayoutTemplate,
  CalendarCheck,
  Eraser,
  ListX,
  Plus,
  Info,
  Bug,
  ArrowUpDown,
  BookmarkCheck,
  Settings2,
  CalendarX,
  Undo2,
  Redo2,
  Keyboard,
} from "lucide-react";
import type { Color, Item, ItemType } from "../../model/types";
import { COLORS, ITEM_TYPES, TRASH_SPACE_ID, isContainerType, isTaggableType } from "../../model/types";
import { breadcrumb, descendants, spaceOf, topLevelOnly, visibleSpaces } from "../../model/tree";
import { addDays, formatLongDay } from "../../model/dates";
import { set, useApp, undo, redo, toast, updatePrefs, type AppState, type CommandPageId } from "../../state/store";
import { indexOf, selectionOf, today } from "../../state/derived";
import { columnIds, context, selectColumnItem, selectCalendarItem, switchSpace, calendarDays, focusView } from "../../state/nav";
import {
  addItem,
  canChangeType,
  changeType,
  deleteSelection,
  descheduleItems,
  duplicateSelection,
  moveSelectionTo,
  removeEmptyItems,
  scheduleSelection,
  setColor,
  setIcon,
  sortColumn,
  toggleFinished,
  toggleTag,
  addTag,
  trashFinished,
  flushEdit,
  createSibling,
} from "../../state/items";
import { copyWithToast, cutSelection } from "../../state/clipboard";
import { closeDocument, newDocument, openDialog, openPath, clearRecentFiles, fromStoredPath } from "../../state/files";
import { closeOverlay, openOverlay, resumeInlineEdit } from "../../state/overlays";
import { openPrint } from "../../state/printing";
import { openStack } from "../../state/stack";
import { createSpace, createTag, prepareDayWithToast, updateSpace } from "../../state/config";
import { keyLabel } from "../../state/shortcuts";
import { DOC_TEMPLATES } from "../../state/templates";
import { platform, displayName } from "../../platform";
import { ICON_NAMES, Icon, iconKeywords } from "../icons";
import { ProgressPie } from "../ProgressRing";
import { fuzzyFilter, parseDatePhrase } from "../fuzzy";
import { SORTS } from "./ContextMenu";
import { promptText } from "../../state/overlays";

interface PItem {
  id: string;
  label: string;
  group?: string;
  icon?: ReactNode;
  hint?: string;
  detail?: string;
  keywords?: string;
  page?: CommandPageId;
  run?: () => void;
}

const PAGE_TITLE: Record<CommandPageId, string> = {
  root: "Commands",
  move: "Move to…",
  schedule: "Schedule…",
  search: "Search items",
  icon: "Change icon",
  templates: "New from template",
  prepare: "Prepare recurring tasks",
  tags: "Tags",
  colors: "Color",
  types: "Turn into",
  recent: "Recent documents",
};

const TYPE_LABEL: Record<ItemType, string> = {
  task: "Task",
  text: "Text",
  heading: "Heading",
  folder: "Folder",
  template: "Template",
  separator: "Separator",
};

const swatch = (c: Color) => <span className={`swatch ${c === "default" ? "is-default" : `c-${c}`}`} />;

function rootItems(s: AppState): PItem[] {
  const out: PItem[] = [];
  const hasDoc = !!s.doc;
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  const items = sel.map((id) => ix.items[id]).filter(Boolean);
  const push = (group: string, list: PItem[]) => list.forEach((x) => out.push({ ...x, group }));

  if (hasDoc && items.length) {
    const n = items.length;
    const what = n === 1 ? `“${(items[0].text || "item").slice(0, 40)}”` : `${n} items`;
    push(`Selection · ${what}`, [
      ...(n === 1 && items[0].parentId && items[0].type !== "separator"
        ? [{ id: "add-child", label: "Create Child Item", icon: <Plus size={15} />, hint: keyLabel("create-child"), keywords: "subtask nest new add folder", run: () => addItem("task", { view: "columns", parentId: items[0].id }) }]
        : []),
      { id: "add-below", label: "Create New Item", icon: <Plus size={15} />, hint: keyLabel("create-sibling"), keywords: "new add below sibling", run: () => createSibling() },
      { id: "toggle-status", label: "Toggle finished", icon: <CheckSquare size={15} />, hint: keyLabel("toggle-finished"), run: () => toggleFinished(sel) },
      { id: "types", label: "Turn into…", icon: <Shapes size={15} />, page: "types", keywords: "type convert task heading folder text separator template" },
      { id: "colors", label: "Color…", icon: <Palette size={15} />, page: "colors", keywords: "colour" },
      ...(items.some((x) => isTaggableType(x.type)) ? [{ id: "tags", label: "Tags…", icon: <Tag size={15} />, page: "tags" as const, keywords: "label" }] : []),
      ...(items.some((x) => isContainerType(x.type)) ? [{ id: "icon", label: "Change icon…", icon: <Icon name="folder" size={15} />, page: "icon" as const }] : []),
      { id: "schedule", label: "Schedule…", icon: <CalendarPlus size={15} />, hint: keyLabel("schedule"), page: "schedule", keywords: "date calendar day" },
      { id: "move", label: "Move to…", icon: <FolderInput size={15} />, hint: keyLabel("move-to"), page: "move", keywords: "reparent folder space" },
      { id: "duplicate", label: "Duplicate", icon: <CopyPlus size={15} />, hint: keyLabel("duplicate"), run: duplicateSelection },
      { id: "copy", label: "Copy", icon: <Copy size={15} />, hint: keyLabel("copy"), run: () => void copyWithToast() },
      { id: "cut", label: "Cut", icon: <Scissors size={15} />, hint: keyLabel("cut"), run: () => void cutSelection() },
      { id: "print-sel", label: "Print selection", icon: <Printer size={15} />, hint: keyLabel("print"), run: () => openPrint({ kind: "selection", ids: sel }) },
      { id: "stack-sel", label: "Launch stack on selection", icon: <Layers size={15} />, hint: keyLabel("stack"), run: () => openStack({ kind: "selection", ids: sel }) },
      { id: "delete", label: "Move to Trash", icon: <Trash2 size={15} />, hint: keyLabel("delete"), keywords: "delete remove", run: deleteSelection },
    ]);
  }

  if (hasDoc) {
    const cal = s.view.focusedView === "calendar";
    const date = cal ? ((sel[0] && ix.items[sel[0]]?.scheduleDate) || calendarDays(s)[0]) : null;
    const parentId = !cal ? ((sel[0] && ix.items[sel[0]]?.parentId) || columnIds(s).at(-1)!) : null;
    const scope = date ? { date } : { parentId: parentId! };
    const colName = date ? formatLongDay(date) : ix.items[parentId!]?.text || ix.spaces.find((x) => x.id === parentId)?.name || "column";
    push(`Current ${cal ? "day" : "column"} · ${colName}`, [
      { id: "new-here", label: "Create New Item here", icon: <Plus size={15} />, run: () => addItem("task", date ? { view: "calendar", date } : { view: "columns", parentId: parentId! }) },
      { id: "template-here", label: "Insert template…", icon: <BookmarkCheck size={15} />, hint: keyLabel("template"), run: () => openOverlay({ kind: "template", target: date ? { date } : { parentId: parentId! } }) },
      { id: "print-col", label: `Print current ${cal ? "day" : "column"}`, icon: <Printer size={15} />, run: () => openPrint(date ? { kind: "day", date } : { kind: "column", parentId: parentId! }) },
      { id: "stack-col", label: `Launch stack on current ${cal ? "day" : "column"}`, icon: <Layers size={15} />, run: () => openStack(date ? { kind: "day", date } : { kind: "column", parentId: parentId! }) },
      ...(date && date >= today() ? [{ id: "prepare-day", label: "Prepare recurring tasks for this day", icon: <CalendarCheck size={15} />, run: () => prepareDayWithToast(date) }] : []),
      { id: "trash-finished-col", label: "Trash finished items in this column", icon: <ListX size={15} />, run: () => trashFinished(scope) },
      ...SORTS.map(([k, label]) => ({ id: `sort-${k}`, label: `Sort: ${label}`, icon: <ArrowUpDown size={15} />, keywords: "sort order clean", run: () => sortColumn(scope, k) })),
    ]);

    const space = ix.spaces.find((x) => x.id === s.view.currentSpaceId);
    push(`Current space · ${space?.name ?? ""}`, [
      { id: "print-space", label: "Print current space", icon: <Printer size={15} />, run: () => openPrint({ kind: "space", spaceId: s.view.currentSpaceId }) },
      { id: "stack-space", label: "Launch stack on current space", icon: <Layers size={15} />, run: () => openStack({ kind: "space", spaceId: s.view.currentSpaceId }) },
      ...(space && space.id !== TRASH_SPACE_ID
        ? [{ id: "rename-space", label: "Rename space…", icon: <Settings2 size={15} />, run: () => promptText({ title: "Rename space", label: "Name", value: space.name, onSubmit: (v) => v.trim() && updateSpace(space.id, { name: v.trim() }) }) }]
        : []),
      {
        id: "new-space",
        label: "New space…",
        icon: <Plus size={15} />,
        run: () => {
          const id = createSpace();
          if (id) promptText({ title: "New space", label: "Name", value: "New space", onSubmit: (v) => updateSpace(id, { name: v.trim() || "New space" }) });
        },
      },
    ]);

    push(
      "Spaces",
      visibleSpaces(s.doc!.config.spaces).map((sp) => ({
        id: `space-${sp.id}`,
        label: `Go to ${sp.name}`,
        icon: <Icon name={sp.icon} size={15} />,
        keywords: "switch space",
        run: () => switchSpace(sp.id),
      })),
    );

    push("Views", [
      { id: "focus-columns", label: "Show columns", icon: <Columns3 size={15} />, run: () => focusView("columns") },
      { id: "focus-calendar", label: "Show calendar", icon: <CalendarDays size={15} />, hint: keyLabel("focus-view"), run: () => focusView("calendar") },
      { id: "day-picker", label: "Toggle calendar day picker", icon: <CalendarDays size={15} />, run: () => set((st) => ({ view: { ...st.view, showCalendarView: true, showCalendarDayPicker: !st.view.showCalendarDayPicker } })) },
      { id: "undo", label: "Undo", icon: <Undo2 size={15} />, hint: keyLabel("undo"), run: () => { flushEdit(); const l = undo(); if (l) toast(`Undid: ${l}`); } },
      { id: "redo", label: "Redo", icon: <Redo2 size={15} />, hint: keyLabel("redo"), run: () => { const l = redo(); if (l) toast(`Redid: ${l}`); } },
    ]);
  }

  push("File", [
    { id: "new-file", label: "New document…", icon: <FilePlus size={15} />, hint: keyLabel("new-file"), run: () => void newDocument() },
    { id: "new-from-template", label: "New document from template…", icon: <LayoutTemplate size={15} />, hint: keyLabel("new-from-template"), page: "templates" },
    { id: "open-file", label: "Open document…", icon: <FolderOpen size={15} />, hint: keyLabel("open-file"), run: () => void openDialog() },
    ...(s.prefs.recentFiles.length ? [{ id: "recent", label: "Open recent…", icon: <FileText size={15} />, page: "recent" as const }] : []),
    ...(hasDoc
      ? [
          { id: "search", label: "Search items…", icon: <Search size={15} />, hint: keyLabel("search"), page: "search" as const, keywords: "find" },
          { id: "doc-settings", label: "Document settings", icon: <Settings2 size={15} />, hint: keyLabel("doc-settings"), keywords: "spaces tags formatting recurrence rules progression", run: () => openOverlay({ kind: "docSettings", tab: "general" }) },
          { id: "prepare", label: "Prepare recurring tasks…", icon: <CalendarCheck size={15} />, page: "prepare" as const },
          { id: "remove-empty", label: "Remove empty items", icon: <Eraser size={15} />, run: removeEmptyItems },
          { id: "trash-finished", label: "Trash all finished items", icon: <ListX size={15} />, run: () => trashFinished() },
          { id: "close-file", label: "Close document", icon: <XIcon size={15} />, hint: keyLabel("close-file"), run: () => void closeDocument() },
        ]
      : []),
    ...(s.prefs.recentFiles.length ? [{ id: "clear-recent", label: "Clear recent documents", icon: <CalendarX size={15} />, run: clearRecentFiles }] : []),
  ]);

  push("Application", [
    { id: "settings", label: "Application settings", icon: <Settings size={15} />, hint: keyLabel("settings"), keywords: "preferences theme triggers", run: () => openOverlay({ kind: "appSettings", tab: "general" }) },
    { id: "print-settings", label: "Print settings", icon: <Printer size={15} />, keywords: "printer receipt thermal bluetooth mqtt", run: () => openOverlay({ kind: "printSettings" }) },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={15} />, keywords: "hotkeys keys help reference", run: () => updatePrefs({ showHelp: true }) },
    { id: "toggle-help", label: "Toggle help panel", icon: <HelpCircle size={15} />, hint: "F1", run: () => updatePrefs({ showHelp: !s.prefs.showHelp }) },
    { id: "toggle-headers", label: "Toggle column headers", icon: <PanelTop size={15} />, run: () => updatePrefs({ hideColumnHeaders: !s.prefs.hideColumnHeaders }) },
    { id: "toggle-toolbar", label: "Toggle toolbar", icon: <PanelTop size={15} />, run: () => updatePrefs({ hideFloatingActionMenu: !s.prefs.hideFloatingActionMenu }) },
    { id: "fullscreen", label: "Toggle fullscreen", icon: <Maximize2 size={15} />, hint: "F11", run: () => void platform().toggleFullscreen() },
    { id: "theme-auto", label: "Theme: follow system", icon: <Monitor size={15} />, run: () => updatePrefs({ theme: "auto" }) },
    { id: "theme-light", label: "Theme: light", icon: <Sun size={15} />, run: () => updatePrefs({ theme: "light" }) },
    { id: "theme-dark", label: "Theme: dark", icon: <Moon size={15} />, run: () => updatePrefs({ theme: "dark" }) },
    ...(s.prefs.debugMode !== "disabled"
      ? [{ id: "debug", label: "State debug tools", icon: <Bug size={15} />, run: () => openOverlay({ kind: "debug", tab: s.prefs.debugMode === "disabled" ? "state" : s.prefs.debugMode }) }]
      : []),
    { id: "about", label: "About Cascade", icon: <Info size={15} />, run: () => openOverlay({ kind: "about" }) },
  ]);

  return out;
}

function typeItems(s: AppState): PItem[] {
  const sel = selectionOf(s);
  return ITEM_TYPES.filter((t) => canChangeType(sel, t, s.view.focusedView)).map((t) => ({
    id: `type-${t}`,
    label: TYPE_LABEL[t],
    icon: <Icon name={t === "task" ? "list-check" : t === "folder" ? "folder" : t === "template" ? "folder-bookmark" : t === "heading" ? "file-lines" : t === "text" ? "file" : "shapes"} size={15} />,
    run: () => changeType(t, sel),
  }));
}

function colorItems(s: AppState): PItem[] {
  const sel = selectionOf(s);
  return COLORS.map((c) => ({ id: `color-${c}`, label: c === "default" ? "Default (no color)" : c[0].toUpperCase() + c.slice(1), icon: swatch(c), run: () => setColor(c, sel) }));
}

function tagItems(s: AppState, query: string): PItem[] {
  const sel = selectionOf(s);
  const ix = indexOf(s.doc);
  const items = sel.map((id) => ix.items[id]).filter((x): x is Item => !!x && isTaggableType(x.type));
  const tags = s.doc?.config.tags ?? [];
  const list: PItem[] = tags.map((t) => {
    const all = items.length > 0 && items.every((x) => x.tags.includes(t.id));
    return {
      id: `tag-${t.id}`,
      label: `${all ? "Remove" : "Add"} tag “${t.name}”`,
      icon: <span className={`c-${t.color}`} style={{ color: "var(--c)" }}><Icon name={t.icon} size={15} /></span>,
      keywords: t.name,
      run: () => toggleTag(t.id, sel),
    };
  });
  const q = query.trim();
  if (q && !tags.some((t) => t.name.toLowerCase() === q.toLowerCase())) {
    list.push({
      id: "tag-create",
      label: `Create tag “${q}” and add it`,
      icon: <Plus size={15} />,
      keywords: q,
      run: () => {
        const id = createTag(q);
        if (id) addTag(id, sel);
      },
    });
  }
  return list;
}

function iconItems(s: AppState): PItem[] {
  const sel = selectionOf(s);
  return [
    { id: "icon-default", label: "Progress circle (default)", icon: <ProgressPie value={0.6} size={15} />, keywords: "progression progress default circle reset", run: () => setIcon(null, sel) },
    ...ICON_NAMES.map((n) => ({ id: `icon-${n}`, label: n.replace(/-/g, " "), icon: <Icon name={n} size={15} />, keywords: iconKeywords(n), run: () => setIcon(n, sel) })),
  ];
}

function scheduleItems(s: AppState, query: string): PItem[] {
  const sel = selectionOf(s);
  const t = today();
  const base: [string, string][] = [
    [t, "Today"],
    [addDays(t, 1), "Tomorrow"],
    [addDays(t, 2), formatLongDay(addDays(t, 2))],
    [addDays(t, 7), "In one week"],
  ];
  const parsed = parseDatePhrase(query, t, s.prefs.weekStartsOn);
  const list: PItem[] = [];
  if (parsed) list.push({ id: `sched-q-${parsed}`, label: formatLongDay(parsed), detail: parsed, icon: <CalendarPlus size={15} />, keywords: query, run: () => scheduleSelection(parsed) });
  for (const [d, label] of base) {
    list.push({ id: `sched-${d}-${label}`, label, detail: d, icon: <CalendarPlus size={15} />, keywords: `${label} ${d}`, run: () => scheduleSelection(d) });
  }
  const ix = indexOf(s.doc);
  if (sel.some((id) => ix.items[id]?.scheduleDate)) {
    list.push({ id: "sched-none", label: "Remove from calendar", icon: <CalendarX size={15} />, keywords: "unschedule clear", run: () => descheduleItems(sel) });
  }
  return list;
}

function moveItems(s: AppState): PItem[] {
  const ix = indexOf(s.doc);
  const sel = topLevelOnly(ix, selectionOf(s));
  const blocked = new Set<string>(sel);
  for (const id of sel) for (const d of descendants(ix, id)) blocked.add(d.id);
  const list: PItem[] = visibleSpaces(ix.spaces).map((sp) => ({
    id: `move-${sp.id}`,
    label: sp.name,
    detail: "Space",
    icon: <Icon name={sp.icon} size={15} />,
    run: () => moveSelectionTo(sp.id),
  }));
  for (const it of Object.values(ix.items)) {
    if (!isContainerType(it.type) || blocked.has(it.id) || it.parentId === null) continue;
    const crumbs = breadcrumb(ix, it.id);
    list.push({
      id: `move-${it.id}`,
      label: it.text || "Untitled",
      detail: crumbs.join(" › "),
      icon: <Icon name={it.icon} size={15} />,
      keywords: crumbs.join(" "),
      run: () => moveSelectionTo(it.id),
    });
  }
  return list;
}

function searchItems(s: AppState, filters: SearchFilters): PItem[] {
  const ix = indexOf(s.doc);
  const list: PItem[] = [];
  for (const it of Object.values(ix.items)) {
    if (it.type === "separator") continue;
    if (filters.types.length && !filters.types.includes(it.type)) continue;
    if (filters.tagIds.length && !filters.tagIds.every((t) => it.tags.includes(t))) continue;
    const sp = spaceOf(ix, it.id);
    if (!filters.includeTrash && sp === TRASH_SPACE_ID) continue;
    const crumbs = it.parentId ? breadcrumb(ix, it.id) : it.scheduleDate ? [formatLongDay(it.scheduleDate)] : [];
    list.push({
      id: `item-${it.id}`,
      label: it.text || "Untitled",
      detail: crumbs.join(" › "),
      icon: it.type === "task" ? <CheckSquare size={15} /> : isContainerType(it.type) ? <Icon name={it.icon} size={15} /> : <FileText size={15} />,
      run: () => (it.parentId ? selectColumnItem(it.id) : selectCalendarItem(it.id)),
    });
  }
  return list;
}

function templateDocItems(): PItem[] {
  return DOC_TEMPLATES.map((t) => ({ id: `tpl-${t.id}`, label: t.name, detail: t.description, icon: <Icon name={t.icon} size={15} />, run: () => void newDocument(t) }));
}

function prepareItems(s: AppState): PItem[] {
  const t = today();
  const prepared = new Set(s.doc?.config.preparedDays ?? []);
  return Array.from({ length: 21 }, (_, i) => addDays(t, i)).map((d) => ({
    id: `prep-${d}`,
    label: formatLongDay(d),
    detail: prepared.has(d) ? "Already prepared" : d,
    icon: <CalendarCheck size={15} />,
    run: () => prepareDayWithToast(d),
  }));
}

function recentItems(s: AppState): PItem[] {
  return s.prefs.recentFiles.map((p) => ({ id: `recent-${p}`, label: displayName(p), detail: fromStoredPath(p), icon: <FileText size={15} />, run: () => void openPath(p) }));
}

interface SearchFilters {
  types: ItemType[];
  tagIds: string[];
  includeTrash: boolean;
}

export function CommandPalette({ pages, resume }: { pages: { id: CommandPageId; query: string }[]; resume?: { itemId: string; caret: number } }) {
  const s = useApp((st) => st);
  const page = pages[pages.length - 1];
  const [query, setQuery] = useState(page.query);
  const [active, setActive] = useState(0);
  const [filters, setFilters] = useState<SearchFilters>({ types: [], tagIds: [], includeTrash: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(page.query);
    setActive(0);
    inputRef.current?.focus();
  }, [page.id, pages.length, page.query]);

  const all = useMemo<PItem[]>(() => {
    switch (page.id) {
      case "root":
        return rootItems(s);
      case "types":
        return typeItems(s);
      case "colors":
        return colorItems(s);
      case "tags":
        return tagItems(s, query);
      case "icon":
        return iconItems(s);
      case "schedule":
        return scheduleItems(s, query);
      case "move":
        return moveItems(s);
      case "search":
        return searchItems(s, filters);
      case "templates":
        return templateDocItems();
      case "prepare":
        return prepareItems(s);
      case "recent":
        return recentItems(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, s.doc, s.view, s.prefs, filters, page.id === "tags" || page.id === "schedule" ? query : ""]);

  const shown = useMemo(() => {
    const list = fuzzyFilter(all, query, (x) => `${x.label} ${x.keywords ?? ""} ${x.group ?? ""} ${x.detail ?? ""}`);
    return page.id === "search" ? list.slice(0, 200) : list;
  }, [all, query, page.id]);

  useEffect(() => {
    if (active >= shown.length) setActive(Math.max(0, shown.length - 1));
  }, [shown.length, active]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PItem | undefined) => {
    if (!item) return;
    if (item.page) {
      set({ overlay: { kind: "command", pages: [...pages.slice(0, -1), { ...page, query }, { id: item.page, query: "" }], resume } });
      return;
    }
    // Run with the palette gone; then, if it was opened with "::" while
    // editing, go back to editing (unless the command opened something else).
    set({ overlay: null, overlayStack: [] });
    item.run?.();
    resumeInlineEdit(resume);
  };

  const back = () => {
    if (pages.length > 1) set({ overlay: { kind: "command", pages: pages.slice(0, -1), resume } });
    else closeOverlay();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === "Backspace" && query === "" && pages.length > 1) {
      e.preventDefault();
      back();
    }
  };

  const grouped = !query.trim() && page.id === "root";
  let lastGroup: string | undefined;
  const tags = s.doc?.config.tags ?? [];

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
            placeholder={page.id === "root" ? (context(s) === "nofile" ? "Open, create, or configure…" : "Type a command…") : page.id === "schedule" ? "today, tomorrow, fri, +3, 2026-10-01…" : "Filter…"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `pi-${active}` : undefined}
          />
          <span className="kbd">Esc</span>
        </div>
        {page.id === "search" && (
          <div className="palette-filters">
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
            <button className={`filter-chip ${filters.includeTrash ? "is-on" : ""}`} onClick={() => setFilters((f) => ({ ...f, includeTrash: !f.includeTrash }))}>
              Include Trash
            </button>
          </div>
        )}
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <div className="palette-empty">No matches</div>}
          {shown.map((item, i) => {
            const header = grouped && item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pi-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${i === active ? "is-active" : ""}`}
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(item);
                  }}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                  {!grouped && item.group && page.id === "root" && <span className="palette-detail">{item.group.split(" · ")[0]}</span>}
                  {item.hint && <span className="kbd">{item.hint}</span>}
                  {item.page && <ChevronRight size={14} className="faint" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

