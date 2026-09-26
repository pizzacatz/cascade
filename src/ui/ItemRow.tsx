import { memo } from "react";
import { Check, ChevronRight, CalendarDays, Columns3, Tags as TagsIcon } from "lucide-react";
import type { Item, ViewName } from "../model/types";
import { isContainerType } from "../model/types";
import { formatShortDay, relativeDayLabel } from "../model/dates";
import { useApp, get } from "../state/store";
import { folderSpan, statsOf, styleFor, today, indexOf } from "../state/derived";
import {
  enterEdit,
  focusView,
  extendCalendarSelectionTo,
  extendColumnSelectionTo,
  selectCalendarItem,
  selectColumnItem,
  setCalendarAnchor,
  toggleCalendarSelection,
  toggleColumnSelection,
} from "../state/nav";
import { toggleFinished } from "../state/items";
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
  // An item can show in both views (e.g. a dated folder's child); only the
  // focused view gets the editor, or the two would fight over focus.
  const editing = useApp((s) => s.edit?.itemId === item.id && s.view.focusedView === view);
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
  const previewAfter = useApp((s) => s.createPreview?.afterId === item.id);
  const deletePreview = useApp((s) => !!s.deletePreview?.includes(item.id));
  // Calendar: indent under a dated folder on the same day.
  const dayDepth = useApp((s) => (view === "calendar" ? indexOf(s.doc).dayDepth.get(item.id) ?? 0 : 0));
  // Columns: a folder shows the span of dates inside it.
  const spanKey = useApp((s) => {
    if (view !== "columns" || item.type !== "folder") return null;
    const sp = folderSpan(s.doc, item.id);
    return sp ? `${sp.from}|${sp.to}` : null;
  });
  const highlightKind = useApp((s) => (s.highlightPreview?.ids.includes(item.id) ? s.highlightPreview.kind : null));

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || editing) return;
    // While another item is being edited, a plain click moves editing here,
    // with the caret where you clicked.
    const editingOther = get().edit;
    if (editingOther && item.type !== "separator" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      const caret = caretOffsetAt(e.clientX, e.clientY, e.currentTarget as HTMLElement) ?? "end";
      (view === "calendar" ? selectCalendarItem : selectColumnItem)(item.id);
      enterEdit(item.id, caret);
      return;
    }
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
    if (editing) return; // the editor gets the normal text menu
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
    previewAfter && "preview-after",
    deletePreview && "is-delete-preview",
    highlightKind && `is-highlight-preview highlight-${highlightKind}`,
    dropHint === "into" && !isContainerType(item.type) && "will-convert",
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
  const [spanFrom, spanTo] = spanKey ? spanKey.split("|") : [null, null];
  const day = view === "columns" ? (spanFrom ?? item.scheduleDate) : null;
  const dayTo = spanTo && spanTo !== spanFrom ? spanTo : null;
  const dayLabel = (d: string) => relativeDayLabel(d, today()) ?? formatShortDay(d);
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
      style={dayDepth ? ({ "--day-depth": dayDepth } as React.CSSProperties) : undefined}
      data-day-depth={dayDepth || undefined}
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
        <span className={`item-icon ${style.accentColor ? "has-color" : ""}`} title={progress >= 0 ? `${Math.round(progress * 100)} %` : undefined}>
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
        <div className={textCls}>
          {item.text || (isContainerType(item.type) || item.type === "heading" ? <span className="placeholder">{placeholderFor(item)}</span> : "\u00a0")}
        </div>
      )}
      <div className="item-meta">
        {day && (
          <button
            className={`date-chip ${(dayTo ?? day) < today() && !item.finished ? "is-overdue" : ""}`}
            title={dayTo ? "Dates inside this folder — open in calendar" : "Open in calendar"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              focusView("calendar");
              if (item.scheduleDate) selectCalendarItem(item.id);
              else setCalendarAnchor(day);
            }}
          >
            <CalendarDays size={11} />
            {dayLabel(day)}
            {dayTo && <> – {dayLabel(dayTo)}</>}
          </button>
        )}
        {view === "calendar" && item.parentId && (
          <button
            className="open-in-btn"
            title="Open in columns"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              selectColumnItem(item.id);
            }}
          >
            <Columns3 size={12} />
          </button>
        )}
        {itemTags.length === 1 && (
          <span className={`tag-icon ${colorClass(itemTags[0].color)}`} title={itemTags[0].name}>
            <Icon name={itemTags[0].icon} size={13} />
          </span>
        )}
        {itemTags.length > 1 && (
          <span className="tags-stack" title={`Show all ${itemTags.length} tags`}>
            <TagsIcon size={13} />
            <span className="tags-pop" role="tooltip">
              {itemTags.map((t) => (
                <span key={t.id} className={`tags-pop-row ${colorClass(t.color)}`}>
                  <Icon name={t.icon} size={12} />
                  {t.name}
                </span>
              ))}
            </span>
          </span>
        )}
        {isContainerType(item.type) && childCount > 0 && <span className="child-count">{childCount}</span>}
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

/** Character offset in a row's text under a screen point (for placing the caret). */
function caretOffsetAt(x: number, y: number, row: HTMLElement): number | null {
  const text = row.querySelector(".item-text");
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (!text || !range || !text.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(text);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}
