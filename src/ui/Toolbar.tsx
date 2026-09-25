// Bottom floating toolbar: actions for the selection (edit, create below,
// create child, delete) with a placement preview on hover; item-type chips
// (click to change the selection's type, drag to create); colour and tag chips.

import { useLayoutEffect, useRef, useState } from "react";
import { Pencil, PencilOff, ArrowDownToLine, CornerDownRight, Trash2, Printer, Layers, Columns3, CalendarDays, Undo2, Redo2, Menu as MenuIcon, Keyboard } from "lucide-react";
import { COLORS, ITEM_TYPES, childPolicy, isTaggableType, type Color, type ItemType } from "../model/types";
import { childrenOf } from "../model/tree";
import { get, set, setView, useApp, undo, redo, toast, updatePrefs } from "../state/store";
import { indexOf, selectionOf } from "../state/derived";
import { startPaletteDrag } from "./dnd";
import { context, enterEdit } from "../state/nav";
import { openOverlay } from "../state/overlays";
import { openPrint } from "../state/printing";
import { openStack } from "../state/stack";
import { sortedTags } from "../state/config";
import { canChangeType, changeType, createChild, createSibling, deleteSelection, exitEdit, flushEdit, setColor, toggleTag } from "../state/items";
import { keyLabel } from "../state/shortcuts";
import { Icon } from "./icons";
import { TypeIcon } from "./TypeIcon";

const TYPE_LABEL: Record<ItemType, string> = { task: "Task", text: "Text", separator: "Separator", heading: "Heading", folder: "Folder", template: "Template" };
const NO_TAGS: never[] = [];

/** The item the toolbar actions apply to: the edited item, else the first selected. */
function anchorItem() {
  const s = get();
  const id = s.edit?.itemId ?? selectionOf(s)[0];
  return id ? s.doc?.items[id] ?? null : null;
}

function previewBelow() {
  const it = anchorItem();
  set({ createPreview: it ? { afterId: it.id } : null });
}

function previewChild() {
  const it = anchorItem();
  if (!it) return;
  const kids = childrenOf(indexOf(get().doc), it.id);
  set({ createPreview: kids.length ? { afterId: kids[kids.length - 1].id } : { columnStart: it.id } });
}

const clearPreview = () => set({ createPreview: null });

/** Items a toolbar click applies to: the edited item, else the selection. */
function targets(): string[] {
  const s = get();
  return s.edit ? [s.edit.itemId] : selectionOf(s);
}

function applyColor(c: Color) {
  const ids = targets();
  if (ids.length) setColor(c, ids);
  else toast("Select items to color, or drag the color onto an item");
}

function applyTag(tagId: string) {
  const ids = targets();
  if (ids.length) toggleTag(tagId, ids);
  else toast("Select items to tag, or drag the tag onto an item");
}

const MODE_LABEL: Record<string, string> = {
  none: "none",
  selection: "selection",
  "create-target": "create",
  edition: "edit",
  drag: "drag",
};

export function Toolbar() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1400);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tags = useApp((s) => s.doc?.config.tags ?? NO_TAGS);
  const view = useApp((s) => s.view);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const hidePrint = useApp((s) => s.printSettings.hidePrintButtons);
  const showHelp = useApp((s) => s.prefs.showHelp);
  const mode = useApp((s) => context(s));
  const editing = useApp((s) => !!s.edit);
  const itemDrag = useApp((s) => s.drag?.status === "active" && !s.drag.palette);
  const chipTarget = useApp((s) => (s.drag?.status === "active" && s.drag.target?.kind === "chip" ? chipKey(s.drag.target.chip) : null));
  const selIds = useApp((s) => (s.edit ? s.edit.itemId : selectionOf(s).join(",")));
  const anchor = useApp((s) => {
    const id = s.edit?.itemId ?? selectionOf(s)[0];
    return id ? s.doc?.items[id] ?? null : null;
  });
  const ids = selIds ? selIds.split(",") : [];
  const docItems = get().doc?.items ?? {};
  const active = editing || ids.length > 0;
  const showPalette = active || itemDrag;
  const calendar = view.focusedView === "calendar";
  const childDisabled = !anchor || calendar || childPolicy(anchor.type) === "blocked" || !anchor.parentId;
  const taggable = ids.some((id) => docItems[id] && isTaggableType(docItems[id].type));

  // Groups collapse as the window narrows.
  const showColors = width >= 1000;
  const showTags = width >= 740;
  const showTypes = width >= 560;
  const showActions = width >= 340;

  const toggleView = (which: "columns" | "calendar") =>
    setView((v) => {
      const next = which === "columns" ? { ...v, showColumnsView: !v.showColumnsView } : { ...v, showCalendarView: !v.showCalendarView };
      if (next.focusedView === "columns" && !next.showColumnsView && next.showCalendarView) next.focusedView = "calendar";
      if (next.focusedView === "calendar" && !next.showCalendarView && next.showColumnsView) next.focusedView = "columns";
      return next;
    });

  return (
    <div className="toolbar" role="toolbar" aria-label="Toolbar" ref={ref}>
      <div className="toolbar-group">
        <button
          className="btn btn-ghost btn-sm btn-icon"
          title="Menu"
          aria-label="Menu"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openOverlay({ kind: "context", x: r.left, y: r.top - 8, target: { type: "app" } });
          }}
        >
          <MenuIcon size={15} />
        </button>
        <button className={`btn btn-ghost btn-sm view-toggle ${view.showColumnsView ? "is-on" : ""}`} aria-pressed={view.showColumnsView} title="Show or hide the Columns view" onClick={() => toggleView("columns")}>
          <Columns3 size={14} /> Columns
        </button>
        <button className={`btn btn-ghost btn-sm view-toggle ${view.showCalendarView ? "is-on" : ""}`} aria-pressed={view.showCalendarView} title="Show or hide the Calendar view" onClick={() => toggleView("calendar")}>
          <CalendarDays size={14} /> Calendar
        </button>
      </div>
      {active && showActions && (
        <>
          <div className="toolbar-sep" />
          <Group label="Actions" onMouseDown={(e) => e.preventDefault()}>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              title={editing ? "Stop editing the current item" : "Edit the current selected item"}
              disabled={!editing && (ids.length !== 1 || anchor?.type === "separator")}
              onClick={() => (editing ? exitEdit() : anchor && enterEdit(anchor.id, "end"))}
            >
              {editing ? <PencilOff size={15} /> : <Pencil size={15} />}
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              title={`Create a new item below the current selection (${keyLabel("create-sibling")})`}
              onMouseEnter={previewBelow}
              onMouseLeave={clearPreview}
              onClick={() => {
                clearPreview();
                flushEdit();
                createSibling();
              }}
            >
              <ArrowDownToLine size={15} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              title={`Create a child item under the current selection (${keyLabel("create-child")})`}
              disabled={childDisabled}
              onMouseEnter={previewChild}
              onMouseLeave={clearPreview}
              onClick={() => {
                clearPreview();
                flushEdit();
                createChild();
              }}
            >
              <CornerDownRight size={15} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              title="Delete the current selection"
              onMouseEnter={() => set({ deletePreview: targets() })}
              onMouseLeave={() => set({ deletePreview: null })}
              onClick={() => {
                set({ deletePreview: null });
                if (get().edit) exitEdit();
                deleteSelection();
              }}
            >
              <Trash2 size={15} />
            </button>
          </Group>
        </>
      )}
      {showPalette && showTypes && (
        <>
          <div className="toolbar-sep" />
          <Group label="Types">
            {ITEM_TYPES.map((t) => {
              const current = anchor?.type === t;
              const legal = ids.length > 0 && (current || canChangeType(ids, t, view.focusedView));
              return (
                <button
                  key={t}
                  className={`palette-chip ${current ? "is-current" : ""} ${chipTarget === `type:${t}` ? "is-drop" : ""} ${!legal ? "is-unavailable" : ""}`}
                  data-chip={`type:${t}`}
                  title={`${TYPE_LABEL[t]}\nClick to change the selection's type\nDrop items here to change their type\nDrag onto the list to create a ${TYPE_LABEL[t].toLowerCase()}`}
                  aria-label={TYPE_LABEL[t]}
                  aria-pressed={current}
                  aria-disabled={!legal}
                  onMouseDown={(e) => startPaletteDrag(e, { kind: "type", type: t })}
                  onClick={() => legal && !current && changeType(t, ids)}
                >
                  <TypeIcon type={t} size={15} />
                </button>
              );
            })}
          </Group>
        </>
      )}
      {showPalette && showColors && (
        <>
          <div className="toolbar-sep" />
          <Group label="Colors">
            {["default" as Color, ...COLORS.filter((c) => c !== "default")].map((c) => (
              <button
                key={c}
                className={`color-dot ${c === "default" ? "is-default" : `c-${c}`} ${chipTarget === `color:${c}` ? "is-drop" : ""} ${ids.length ? "" : "is-unavailable"} ${anchor?.color === c && ids.length === 1 ? "is-current" : ""}`}
                data-chip={`color:${c}`}
                title={`${c === "default" ? "No color" : c[0].toUpperCase() + c.slice(1)}\nClick to color the selection\nDrop items here to color them\nDrag onto an item to color it`}
                aria-label={c === "default" ? "No color" : `Color ${c}`}
                onMouseDown={(e) => startPaletteDrag(e, { kind: "color", color: c })}
                onClick={() => applyColor(c)}
              />
            ))}
          </Group>
        </>
      )}
      {showPalette && showTags && tags.length > 0 && (
        <>
          <div className="toolbar-sep" />
          <Group label="Tags">
            {sortedTags(tags).map((t) => {
              const on = ids.length > 0 && ids.every((id) => docItems[id]?.tags.includes(t.id));
              return (
                <button
                  key={t.id}
                  className={`palette-chip tag-chip-btn ${t.color !== "default" ? `c-${t.color}` : ""} ${on ? "is-current" : ""} ${chipTarget === `tag:${t.id}` ? "is-drop" : ""} ${taggable ? "" : "is-unavailable"}`}
                  data-chip={`tag:${t.id}`}
                  title={`#${t.name}\nClick to add or remove it on the selection\nDrop items here to tag them\nDrag onto an item to tag it`}
                  aria-label={`Tag ${t.name}`}
                  onMouseDown={(e) => startPaletteDrag(e, { kind: "tag", tagId: t.id })}
                  onClick={() => applyTag(t.id)}
                >
                  <Icon name={t.icon} size={14} />
                </button>
              );
            })}
          </Group>
        </>
      )}
      <div className="grow" />
      {showHelp && (
        <div className="toolbar-group">
          <span className={`mode-badge mode-${MODE_LABEL[mode] ?? "overlay"}`} title="Current interaction mode">
            {MODE_LABEL[mode] ?? "menu"}
          </span>
        </div>
      )}
      <div className="toolbar-group">
        <button className="btn btn-ghost btn-sm btn-icon" title={`Undo (${keyLabel("undo")})`} disabled={!canUndo} onClick={() => { flushEdit(); const l = undo(); if (l) toast(`Undid: ${l}`); }}>
          <Undo2 size={15} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" title={`Redo (${keyLabel("redo")})`} disabled={!canRedo} onClick={() => { const l = redo(); if (l) toast(`Redid: ${l}`); }}>
          <Redo2 size={15} />
        </button>
        {!hidePrint && (
          <button className="btn btn-ghost btn-sm btn-icon" title={`Print (${keyLabel("print")})`} onClick={() => openPrint()}>
            <Printer size={15} />
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-icon" title={`Stack (${keyLabel("stack")})`} onClick={() => openStack()}>
          <Layers size={15} />
        </button>
        <button className={`btn btn-ghost btn-sm btn-icon ${showHelp ? "is-active" : ""}`} title="Toggle keyboard shortcuts (F1)" onClick={() => updatePrefs({ showHelp: !showHelp })}>
          <Keyboard size={15} />
        </button>
      </div>
    </div>
  );
}

function Group({ label, children, onMouseDown }: { label: string; children: React.ReactNode; onMouseDown?: (e: React.MouseEvent) => void }) {
  return (
    <div className="toolbar-group toolbar-labeled" aria-label={label} onMouseDown={onMouseDown}>
      <span className="toolbar-label">{label}</span>
      <div className="toolbar-group">{children}</div>
    </div>
  );
}

function chipKey(c: { kind: string; type?: string; color?: string; tagId?: string }): string {
  return c.kind === "type" ? `type:${c.type}` : c.kind === "color" ? `color:${c.color}` : `tag:${c.tagId}`;
}
