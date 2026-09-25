import {
  Pencil,
  CornerDownRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Hash,
  FilePlus,
  FolderOpen,
  LayoutTemplate,
  X as XIcon,
  Settings,
  Keyboard,
  Info,
  CheckSquare,
  Copy,
  Scissors,
  ClipboardPaste,
  Trash2,
  Palette,
  Tag,
  Shapes,
  CalendarPlus,
  FolderInput,
  Printer,
  Layers,
  CopyPlus,
  Plus,
  ArrowUpDown,
  CalendarCheck,
  CalendarX,
  Archive,
  ArrowUp,
  ArrowDown,
  BookmarkCheck,
  ListX,
  Settings2,
} from "lucide-react";
import { COLORS, ITEM_TYPES, TRASH_SPACE_ID, childPolicy, isContainerType, isTaggableType, type Color, type ItemType } from "../../model/types";
import { childrenOf, isUserSpace } from "../../model/tree";
import { get, set, toast, updatePrefs, type ContextTarget, type PrintScopeRef } from "../../state/store";
import { platform } from "../../platform";
import { closeDocument, newDocument, openDialog } from "../../state/files";
import { indexOf, selectionOf, today } from "../../state/derived";
import { enterEdit, selectColumnItem } from "../../state/nav";
import {
  addItem,
  canChangeType,
  changeType,
  deleteSelection,
  duplicateSelection,
  emptyTrash,
  setColor,
  sortColumn,
  toggleFinished,
  toggleTag,
  trashFinished,
  moveSelection,
  type Placement,
  type SortBy,
} from "../../state/items";
import { copyWithToast, cutSelection, paste } from "../../state/clipboard";
import { closeOverlay, confirmAction, openCommand, openOverlay, promptText } from "../../state/overlays";
import { openPrint } from "../../state/printing";
import { openStack } from "../../state/stack";
import {
  deleteSpace,
  duplicateSpace,
  moveSpace,
  prepareDayWithToast,
  setSpaceArchived,
  sortedTags,
  unprepareDay,
  updateSpace,
} from "../../state/config";
import { keyLabel } from "../../state/shortcuts";
import { Menu, type MenuEntry } from "./Menu";
import { Icon } from "../icons";
import { TypeIcon } from "../TypeIcon";

const TYPE_LABEL: Record<ItemType, string> = {
  task: "Task",
  text: "Text",
  heading: "Heading",
  folder: "Folder",
  template: "Template",
  separator: "Separator",
};

export const SORTS: [SortBy, string][] = [
  ["status-unfinished-first", "Unfinished first"],
  ["status-finished-first", "Finished first"],
  ["alphabetical", "A → Z"],
  ["alphabetical-reverse", "Z → A"],
  ["created-at-asc", "Oldest created"],
  ["created-at-desc", "Newest created"],
  ["updated-at-asc", "Least recently modified"],
  ["updated-at-desc", "Most recently modified"],
];

const swatch = (c: Color) => <span className={`swatch ${c === "default" ? "is-default" : `c-${c}`}`} />;

function colorEntries(apply: (c: Color) => void, current?: Color): MenuEntry[] {
  return COLORS.map((c) => ({ label: c === "default" ? "Default" : c[0].toUpperCase() + c.slice(1), icon: swatch(c), checked: c === current, run: () => apply(c) }));
}

const clearPreviews = () => set({ createPreview: null, deletePreview: null });

function childPreview(itemId: string) {
  const kids = childrenOf(indexOf(get().doc), itemId);
  set({ createPreview: kids.length ? { afterId: kids[kids.length - 1].id } : { columnStart: itemId } });
}

function moveEntries(): MenuEntry[] {
  return [
    { label: "Move to Top", icon: <ArrowUpToLine size={14} />, hint: keyLabel("move-first"), run: () => moveSelection("first") },
    { label: "Move Up", icon: <ArrowUp size={14} />, hint: keyLabel("move-up"), run: () => moveSelection("up") },
    { label: "Move Down", icon: <ArrowDown size={14} />, hint: keyLabel("move-down"), run: () => moveSelection("down") },
    { label: "Move to Bottom", icon: <ArrowDownToLine size={14} />, hint: keyLabel("move-last"), run: () => moveSelection("last") },
  ];
}

function itemEntries(itemId: string, view: "columns" | "calendar"): MenuEntry[] {
  const s = get();
  const ix = indexOf(s.doc);
  const it = ix.items[itemId];
  if (!it) return [];
  const sel = selectionOf(s);
  const ids = sel.includes(itemId) ? sel : [itemId];
  const items = ids.map((id) => ix.items[id]).filter(Boolean);
  const tags = sortedTags(s.doc?.config.tags ?? []);
  const taggableItems = items.filter((x) => isTaggableType(x.type));
  const anyContainer = items.some((x) => isContainerType(x.type));
  const inTrash = s.doc ? isInTrashId(itemId) : false;
  const single = ids.length === 1;
  const deleteEntry: MenuEntry = {
    label: view === "calendar" ? "Remove from Day" : inTrash ? "Delete Permanently" : "Delete",
    icon: <Trash2 size={14} />,
    hint: keyLabel("delete"),
    danger: true,
    onHover: () => set({ deletePreview: ids }),
    run: deleteSelection,
  };
  const colorsEntry: MenuEntry = {
    label: "Colors",
    icon: <Palette size={14} />,
    submenu: colorEntries((c) => setColor(c, ids), single ? it.color : undefined),
  };

  // Several items selected: a shorter bulk menu.
  if (!single) {
    return [
      colorsEntry,
      { separator: true },
      { label: "Copy", icon: <Copy size={14} />, hint: keyLabel("copy"), run: () => void copyWithToast() },
      { label: "Cut", icon: <Scissors size={14} />, hint: keyLabel("cut"), run: () => void cutSelection() },
      { label: "Duplicate", icon: <CopyPlus size={14} />, hint: keyLabel("duplicate"), run: duplicateSelection },
      { label: "Move", icon: <FolderInput size={14} />, submenu: moveEntries() },
      { separator: true },
      { label: "Schedule…", icon: <CalendarPlus size={14} />, hint: keyLabel("schedule"), run: () => openCommand("schedule") },
      { label: "Move to…", icon: <FolderInput size={14} />, hint: keyLabel("move-to"), run: () => openCommand("move") },
      { label: "Print", icon: <Printer size={14} />, hint: keyLabel("print"), run: () => openPrint({ kind: "selection", ids }) },
      { label: "Launch Stack", icon: <Layers size={14} />, hint: keyLabel("stack"), run: () => openStack({ kind: "selection", ids }) },
      { separator: true },
      deleteEntry,
    ];
  }

  return [
    { label: "Edit", icon: <Pencil size={14} />, hint: keyLabel("edit"), disabled: it.type === "separator", run: () => { selectColumnOrCal(itemId, view); enterEdit(itemId); } },
    {
      label: "Type",
      icon: <Shapes size={14} />,
      submenu: ITEM_TYPES.filter((t) => t === it.type || canChangeType(ids, t, view)).map((t) => ({
        label: TYPE_LABEL[t],
        icon: <TypeIcon type={t} />,
        checked: t === it.type,
        run: () => changeType(t, ids),
      })),
    },
    {
      label: "Tags",
      icon: <Tag size={14} />,
      disabled: !taggableItems.length,
      submenu: [
        ...(tags.length
          ? tags.map((t) => ({
              label: t.name,
              icon: <span className={`c-${t.color}`} style={{ color: "var(--c)" }}><Icon name={t.icon} size={13} /></span>,
              checked: taggableItems.every((x) => x.tags.includes(t.id)),
              run: () => toggleTag(t.id, ids),
            }))
          : [{ label: "No Tags", disabled: true }]),
        { separator: true },
        { label: "Edit Tags", run: () => openOverlay({ kind: "docSettings", tab: "tags" }) },
      ],
    },
    colorsEntry,
    ...(anyContainer ? [{ label: "Icon…", icon: <Icon name={it.icon ?? "folder"} size={14} />, run: () => openCommand("icon") }] : []),
    { separator: true },
    {
      label: "Create Below",
      icon: <ArrowDownToLine size={14} />,
      hint: keyLabel("create-sibling"),
      onHover: () => set({ createPreview: { afterId: itemId } }),
      submenu: typeEntries(view === "calendar" ? CALENDAR_TYPES : ITEM_TYPES, (t) => addBelow(itemId, view, t)),
    },
    ...(view === "columns" && it.parentId && childPolicy(it.type) !== "blocked"
      ? [
          {
            label: "Create Child",
            icon: <CornerDownRight size={14} />,
            hint: keyLabel("create-child"),
            onHover: () => childPreview(itemId),
            submenu: typeEntries(ITEM_TYPES, (t) => addItem(t, { view: "columns", parentId: itemId })),
          },
        ]
      : []),
    { separator: true },
    { label: "Copy", icon: <Copy size={14} />, hint: keyLabel("copy"), run: () => void copyWithToast() },
    {
      label: "Copy ID",
      icon: <Hash size={14} />,
      run: () => void platform().writeClipboard(itemId).then(() => toast("Item ID copied")),
    },
    { label: "Cut", icon: <Scissors size={14} />, hint: keyLabel("cut"), run: () => void cutSelection() },
    { label: "Paste", icon: <ClipboardPaste size={14} />, hint: keyLabel("paste"), onHover: () => set({ createPreview: { afterId: itemId } }), run: () => void paste() },
    { label: "Duplicate", icon: <CopyPlus size={14} />, hint: keyLabel("duplicate"), run: duplicateSelection },
    { label: "Move", icon: <FolderInput size={14} />, submenu: moveEntries() },
    { separator: true },
    { label: "Toggle Finished", icon: <CheckSquare size={14} />, hint: keyLabel("toggle-finished"), disabled: it.type !== "task", run: () => toggleFinished(ids) },
    { label: "Schedule…", icon: <CalendarPlus size={14} />, hint: keyLabel("schedule"), run: () => openCommand("schedule") },
    { label: "Move to…", icon: <FolderInput size={14} />, hint: keyLabel("move-to"), run: () => openCommand("move") },
    ...(anyContainer ? [{ label: "Insert Template…", icon: <BookmarkCheck size={14} />, run: () => openOverlay({ kind: "template", target: { parentId: itemId } }) }] : []),
    { label: "Print", icon: <Printer size={14} />, hint: keyLabel("print"), run: () => openPrint({ kind: "selection", ids }) },
    { label: "Launch Stack", icon: <Layers size={14} />, hint: keyLabel("stack"), run: () => openStack({ kind: "selection", ids }) },
    { separator: true },
    deleteEntry,
  ];
}

function isInTrashId(id: string): boolean {
  const ix = indexOf(get().doc);
  let cur: string | null = id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    if (cur === TRASH_SPACE_ID) return true;
    cur = ix.items[cur]?.parentId ?? null;
  }
  return false;
}

const CALENDAR_TYPES: ItemType[] = ["task", "text", "heading", "separator"];

function typeEntries(types: readonly ItemType[], create: (t: ItemType) => void): MenuEntry[] {
  return types.map((t) => ({ label: TYPE_LABEL[t], icon: <TypeIcon type={t} />, run: () => create(t) }));
}

/** Create an item of a type right after an item, in the same column (or day). */
function addBelow(itemId: string, view: "columns" | "calendar", type: ItemType) {
  const it = indexOf(get().doc).items[itemId];
  if (!it) return;
  if (view === "calendar" && it.scheduleDate) addItem(type, { view: "calendar", date: it.scheduleDate, afterId: itemId });
  else if (it.parentId) addItem(type, { view: "columns", parentId: it.parentId, afterId: itemId });
}

function selectColumnOrCal(id: string, view: "columns" | "calendar") {
  if (view === "columns") selectColumnItem(id);
}

function surfaceEntries(t: Extract<ContextTarget, { type: "surface" }>): MenuEntry[] {
  type Scope = { parentId: string } | { date: string };
  const scope: Scope | null = t.view === "calendar" && t.date ? { date: t.date } : t.parentId ? { parentId: t.parentId } : null;
  if (!scope) return [];
  const s = get();
  const isDay = "date" in scope;
  const future = "date" in scope && scope.date >= today();
  const prepared = "date" in scope && !!s.doc?.config.preparedDays.includes(scope.date);
  const place: Placement = "date" in scope ? { view: "calendar", date: scope.date } : { view: "columns", parentId: scope.parentId };
  const printScope: PrintScopeRef = "date" in scope ? { kind: "day", date: scope.date } : { kind: "column", parentId: scope.parentId };
  const templateTarget = "date" in scope ? { date: scope.date } : { parentId: scope.parentId };
  const isTrash = "parentId" in scope && scope.parentId === TRASH_SPACE_ID;
  return [
    {
      label: "Create New Item",
      icon: <Plus size={14} />,
      disabled: isTrash,
      onHover: () => {
        if (!("parentId" in scope)) return;
        const kids = childrenOf(indexOf(get().doc), scope.parentId);
        set({ createPreview: kids.length ? { afterId: kids[kids.length - 1].id } : { columnStart: scope.parentId } });
      },
      submenu: typeEntries("date" in scope ? CALENDAR_TYPES : ITEM_TYPES, (t) => addItem(t, place)),
    },
    { label: "Paste", icon: <ClipboardPaste size={14} />, run: () => void paste() },
    { label: "Insert template…", icon: <BookmarkCheck size={14} />, disabled: isTrash, run: () => openOverlay({ kind: "template", target: templateTarget }) },
    { separator: true },
    { label: isDay ? "Print day" : "Print column", icon: <Printer size={14} />, run: () => openPrint(printScope) },
    { label: "Launch stack", icon: <Layers size={14} />, run: () => openStack(printScope) },
    ...(isDay
      ? [
          { separator: true },
          { label: "Prepare recurring tasks", icon: <CalendarCheck size={14} />, disabled: !future || prepared, run: () => "date" in scope && prepareDayWithToast(scope.date) },
          ...(prepared ? [{ label: "Allow preparing again", icon: <CalendarX size={14} />, run: () => "date" in scope && unprepareDay(scope.date) }] : []),
        ]
      : []),
    { separator: true },
    { label: "Trash finished items", icon: <ListX size={14} />, run: () => trashFinished(scope) },
    { label: "Sort & clean", icon: <ArrowUpDown size={14} />, submenu: SORTS.map(([k, label]) => ({ label, run: () => sortColumn(scope, k) })) },
    ...(isTrash
      ? [
          { separator: true },
          {
            label: "Empty Trash",
            icon: <Trash2 size={14} />,
            danger: true,
            run: () =>
              confirmAction({ title: "Empty Trash?", message: "Everything in Trash will be deleted permanently.", confirmLabel: "Empty Trash", danger: true, onConfirm: emptyTrash }),
          },
        ]
      : []),
  ];
}

function spaceEntries(spaceId: string): MenuEntry[] {
  const s = get();
  const sp = s.doc?.config.spaces.find((x) => x.id === spaceId);
  if (!sp) return [];
  const user = isUserSpace(spaceId);
  if (spaceId === TRASH_SPACE_ID) {
    return [
      { label: "Print Trash", icon: <Printer size={14} />, run: () => openPrint({ kind: "space", spaceId }) },
      {
        label: "Empty Trash",
        icon: <Trash2 size={14} />,
        danger: true,
        run: () => confirmAction({ title: "Empty Trash?", message: "Everything in Trash will be deleted permanently.", confirmLabel: "Empty Trash", danger: true, onConfirm: emptyTrash }),
      },
    ];
  }
  return [
    {
      label: "Rename…",
      icon: <Pencil size={14} />,
      run: () => promptText({ title: "Rename space", label: "Name", value: sp.name, onSubmit: (v) => v.trim() && updateSpace(spaceId, { name: v.trim() }) }),
    },
    { label: "Color", icon: <Palette size={14} />, submenu: colorEntries((c) => updateSpace(spaceId, { color: c }), sp.color as Color) },
    { label: "Edit Spaces…", icon: <Settings2 size={14} />, run: () => openOverlay({ kind: "docSettings", tab: "spaces" }) },
    { label: "Copy Space ID", icon: <Hash size={14} />, run: () => void platform().writeClipboard(spaceId).then(() => toast("Space ID copied")) },
    { separator: true },
    { label: "Move up", icon: <ArrowUp size={14} />, run: () => moveSpace(spaceId, -1) },
    { label: "Move down", icon: <ArrowDown size={14} />, run: () => moveSpace(spaceId, 1) },
    { label: "Duplicate", icon: <CopyPlus size={14} />, run: () => duplicateSpace(spaceId) },
    { separator: true },
    { label: "Print space", icon: <Printer size={14} />, run: () => openPrint({ kind: "space", spaceId }) },
    { label: "Launch stack", icon: <Layers size={14} />, run: () => openStack({ kind: "space", spaceId }) },
    ...(user
      ? [
          { separator: true },
          { label: "Archive", icon: <Archive size={14} />, run: () => setSpaceArchived(spaceId, true) },
          {
            label: "Delete space…",
            icon: <Trash2 size={14} />,
            danger: true,
            run: () =>
              confirmAction({
                title: `Delete “${sp.name}”?`,
                message: "Its items will be moved to Trash. Formatting conditions that reference this space are removed.",
                confirmLabel: "Delete space",
                danger: true,
                onConfirm: () => deleteSpace(spaceId),
              }),
          },
        ]
      : []),
  ];
}

function appEntries(): MenuEntry[] {
  const hasDoc = !!get().doc;
  return [
    { label: "New Document", icon: <FilePlus size={14} />, hint: keyLabel("new-file"), run: () => void newDocument() },
    { label: "New from Template…", icon: <LayoutTemplate size={14} />, hint: keyLabel("new-from-template"), run: () => openCommand("templates") },
    { label: "Open Document…", icon: <FolderOpen size={14} />, hint: keyLabel("open-file"), run: () => void openDialog() },
    { label: "Close Document", icon: <XIcon size={14} />, hint: keyLabel("close-file"), disabled: !hasDoc, run: () => void closeDocument() },
    { separator: true },
    { label: "Application Settings", icon: <Settings size={14} />, hint: keyLabel("settings"), run: () => openOverlay({ kind: "appSettings", tab: "general" }) },
    { label: "Print Settings", icon: <Printer size={14} />, run: () => openOverlay({ kind: "printSettings" }) },
    { label: "Document Settings", icon: <Settings2 size={14} />, hint: keyLabel("doc-settings"), disabled: !hasDoc, run: () => openOverlay({ kind: "docSettings", tab: "general" }) },
    { separator: true },
    { label: "Keyboard Shortcuts", icon: <Keyboard size={14} />, hint: "F1", run: () => updatePrefs({ showHelp: true }) },
    { label: "About Cascade", icon: <Info size={14} />, run: () => openOverlay({ kind: "about" }) },
  ];
}

export function ContextMenu({ x, y, target }: { x: number; y: number; target: ContextTarget }) {
  const entries =
    target.type === "item"
      ? itemEntries(target.itemId, target.view)
      : target.type === "surface"
        ? surfaceEntries(target)
        : target.type === "app"
          ? appEntries()
          : spaceEntries(target.spaceId);
  return (
    <div className="menu-layer" onMouseDown={closeOverlay} onContextMenu={(e) => { e.preventDefault(); closeOverlay(); }}>
      <Menu x={x} y={y} entries={entries} onClose={closeOverlay} onClearPreview={clearPreviews} />
    </div>
  );
}
