import { memo } from "react";
import { Check, ChevronRight, CalendarDays, Plus } from "lucide-react";
import type { Item, ViewName } from "../model/types";
import { isContainerType } from "../model/types";
import { formatShortDay, relativeDayLabel } from "../model/dates";
import { useApp, get } from "../state/store";
import { statsOf, styleFor, today, indexOf } from "../state/derived";
import {
  enterEdit,
  extendCalendarSelectionTo,
  extendColumnSelectionTo,
  selectCalendarItem,
  selectColumnItem,
  toggleCalendarSelection,
  toggleColumnSelection,
} from "../state/nav";
import { addItem, toggleFinished } from "../state/items";
import { keyLabel } from "../state/shortcuts";
import { openOverlay } from "../state/overlays";
import { Icon } from "./icons";
import { ItemEditor } from "./ItemEditor";
import { justDropped, startItemDrag } from "./dnd";
import { ProgressPie, usesProgressPie } from "./ProgressRing";

interface Props {
  item: Item;
  view: ViewName;
  /** The folder whose children are shown in the next column. */
  open?: boolean;
}

function colorClass(c: string | null | undefined) {
  return c && c !== "default" ? `c-${c}` : "";
}

export const ItemRow = memo(function ItemRow({ item, view, open }: Props) {
  const selected = useApp((s) =>
    view === "calendar" ? s.view.calendarSelection.includes(item.id) : s.view.columnsSelection.includes(item.id),
  );
  const focusedHere = useApp((s) => s.view.focusedView === view);
  const editing = useApp((s) => s.edit?.itemId === item.id);
  const style = useApp((s) => styleFor(s, item));
  const tags = useApp((s) => s.doc?.config.tags);
  const stats = useApp((s) => (isContainerType(item.type) ? statsOf(s.doc).get(item.id) : undefined));
  const childCount = useApp((s) => (isContainerType(item.type) ? indexOf(s.doc).children.get(item.id)?.length ?? 0 : 0));
  const dropHint = useApp((s) => {
    const t = s.drag?.status === "active" ? s.drag.target : null;
    if (!t || !("itemId" in t) || t.itemId !== item.id) return null;
    if (t.kind === "into") return "into";
    return "view" in t && t.view === view ? t.kind : null;
  });
  const dragging = useApp((s) => s.drag?.status === "active" && !s.drag.copy && s.drag.ids.includes(item.id));
  const hideChildButton = useApp((s) => s.prefs.hideCreateItemButton);
  // Colonnes-style "open a column and add a child here" button, shown on hover.
  const showChildButton = view === "columns" && !hideChildButton && !editing && item.parentId !== null;

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || editing) return;
    if (e.ctrlKey || e.metaKey) {
      (view === "calendar" ? toggleCalendarSelection : toggleColumnSelection)(item.id);
      return;
    }
    if (e.shiftKey) {
      (view === "calendar" ? extendCalendarSelectionTo : extendColumnSelectionTo)(item.id);
      return;
    }
    if (!selected || !focusedHere) (view === "calendar" ? selectCalendarItem : selectColumnItem)(item.id);
    startItemDrag(e, item.id, view);
  };

  const onClick = (e: React.MouseEvent) => {
    if (justDropped() || e.ctrlKey || e.metaKey || e.shiftKey || editing) return;
    const s = get();
    const sel = view === "calendar" ? s.view.calendarSelection : s.view.columnsSelection;
    if (sel.length > 1) (view === "calendar" ? selectCalendarItem : selectColumnItem)(item.id);
  };

  const onDoubleClick = () => {
    if (item.type === "separator") return;
    (view === "calendar" ? selectCalendarItem : selectColumnItem)(item.id);
    enterEdit(item.id, "end");
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!selected) (view === "calendar" ? selectCalendarItem : selectColumnItem)(item.id);
    openOverlay({ kind: "context", x: e.clientX, y: e.clientY, target: { type: "item", itemId: item.id, view } });
  };

  const textCls = [
    "item-text",
    style.bold && "is-bold",
    style.italic && "is-italic",
    style.strikethrough && "is-strike",
    style.textColor && "has-color",
    colorClass(style.textColor),
  ]
    .filter(Boolean)
    .join(" ");

  const rowCls = [
    "item-row",
    `type-${item.type}`,
    selected && "is-selected",
    selected && !focusedHere && "is-selected-unfocused",
    open && "is-open",
    editing && "is-editing",
    dragging && "is-dragging",
    dropHint && `drop-${dropHint}`,
    colorClass(style.accentColor),
  ]
    .filter(Boolean)
    .join(" ");

  if (item.type === "separator") {
    return (
      <div
        className={rowCls}
        data-item-id={item.id}
        data-view={view}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
        role="separator"
      >
        <div className={`separator-line ${style.accentColor ? "has-color" : ""}`} />
      </div>
    );
  }

  const itemTags = item.tags.length && tags ? tags.filter((t) => item.tags.includes(t.id)) : [];
  const day = view === "columns" ? item.scheduleDate : null;
  const progress = stats?.progression ?? -1;

  return (
    <div
      className={rowCls}
      data-item-id={item.id}
      data-view={view}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="treeitem"
      aria-selected={selected}
    >
      {item.type === "task" && (
        <button
          className={`checkbox ${item.finished ? "is-checked" : ""} ${style.accentColor ? "has-color" : ""}`}
          aria-label={item.finished ? "Mark unfinished" : "Mark finished"}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            toggleFinished([item.id]);
          }}
        >
          {item.finished && <Check size={12} strokeWidth={3} />}
        </button>
      )}
      {isContainerType(item.type) && (
        <span className={`item-icon ${style.accentColor ? "has-color" : ""}`}>
          {usesProgressPie(item.type, item.icon) ? (
            <ProgressPie value={progress} size={16} />
          ) : (
            <Icon name={item.icon} fallback={undefined} size={16} />
          )}
        </span>
      )}
      {editing ? (
        <ItemEditor item={item} view={view} className={textCls} />
      ) : (
        <div className={textCls}>{item.text || <span className="placeholder">{placeholderFor(item)}</span>}</div>
      )}
      <div className="item-meta">
        {itemTags.map((t) => (
          <span key={t.id} className={`tag-chip ${colorClass(t.color)}`} title={t.name}>
            <Icon name={t.icon} size={11} />
            <span>{t.name}</span>
          </span>
        ))}
        {day && (
          <span className={`date-chip ${day < today() && !item.finished ? "is-overdue" : ""}`}>
            <CalendarDays size={11} />
            {relativeDayLabel(day, today()) ?? formatShortDay(day)}
          </span>
        )}
        {isContainerType(item.type) && childCount > 0 && <span className="child-count">{childCount}</span>}
        {showChildButton && (
          <button
            className="child-add-btn"
            title={`${isContainerType(item.type) ? "Add an item inside" : "Turn into a folder and add an item inside"} (${keyLabel("create-child")})`}
            aria-label="Add child item"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              addItem("task", { view: "columns", parentId: item.id });
            }}
          >
            <Plus size={13} />
          </button>
        )}
        {isContainerType(item.type) && <ChevronRight size={14} className="chevron" />}
      </div>
    </div>
  );
});

function placeholderFor(item: Item) {
  switch (item.type) {
    case "heading":
      return "Heading";
    case "folder":
      return "Untitled folder";
    case "template":
      return "Untitled template";
    case "text":
      return "Note";
    default:
      return "Untitled";
  }
}
