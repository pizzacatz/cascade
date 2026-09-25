// Bottom floating toolbar: actions for the selection (edit, create below,
// create child, delete) with a placement preview on hover; item-type chips
// (click to change the selection's type, drag to create); colour and tag chips.

import { Pencil, PencilOff, ArrowDownToLine, CornerDownRight, Trash2, Printer, Layers, Columns3, CalendarDays, Undo2, Redo2 } from "lucide-react";
import { COLORS, ITEM_TYPES, childPolicy, type ItemType } from "../model/types";
import { childrenOf } from "../model/tree";
import { get, set, useApp, undo, redo, toast } from "../state/store";
import { indexOf, selectionOf } from "../state/derived";
import { startPaletteDrag } from "./dnd";
import { cycleViewVisibility, enterEdit } from "../state/nav";
import { openPrint } from "../state/printing";
import { openStack } from "../state/stack";
import { sortedTags } from "../state/config";
import { canChangeType, changeType, createChild, createSibling, deleteSelection, exitEdit, flushEdit } from "../state/items";
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

export function Toolbar() {
  const tags = useApp((s) => s.doc?.config.tags ?? NO_TAGS);
  const view = useApp((s) => s.view);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const hidePrint = useApp((s) => s.printSettings.hidePrintButtons);
  const editing = useApp((s) => !!s.edit);
  const selCount = useApp((s) => selectionOf(s).length);
  const anchor = useApp((s) => {
    const id = s.edit?.itemId ?? selectionOf(s)[0];
    return id ? s.doc?.items[id] ?? null : null;
  });
  const active = editing || selCount > 0;
  const calendar = view.focusedView === "calendar";
  const childDisabled = !anchor || calendar || childPolicy(anchor.type) === "blocked" || !anchor.parentId;

  return (
    <div className="toolbar" role="toolbar" aria-label="Toolbar">
      {active && (
        <>
          <div className="toolbar-group" aria-label="Actions" onMouseDown={(e) => e.preventDefault()}>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              title={editing ? "Stop editing the current item" : "Edit the current selected item"}
              disabled={!editing && (selCount !== 1 || anchor?.type === "separator")}
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
            <button className="btn btn-ghost btn-sm btn-icon" title="Delete the current selection" onClick={() => { if (get().edit) exitEdit(); deleteSelection(); }}>
              <Trash2 size={15} />
            </button>
          </div>
          <div className="toolbar-sep" />
          <div className="toolbar-group" aria-label="Item types">
            {ITEM_TYPES.map((t) => {
              const ids = get().edit ? [get().edit!.itemId] : selectionOf(get());
              const current = anchor?.type === t;
              return (
                <button
                  key={t}
                  className={`palette-chip ${current ? "is-current" : ""}`}
                  title={`${TYPE_LABEL[t]} — click to change the selection's type, drag onto the list to create one`}
                  aria-label={TYPE_LABEL[t]}
                  aria-pressed={current}
                  onMouseDown={(e) => startPaletteDrag(e, { kind: "type", type: t })}
                  onClick={() => canChangeType(ids, t, view.focusedView) && changeType(t, ids)}
                >
                  <TypeIcon type={t} size={15} />
                </button>
              );
            })}
          </div>
          <div className="toolbar-sep" />
        </>
      )}
      <div className="toolbar-group" aria-label="Drag to color">
        {COLORS.filter((c) => c !== "default").map((c) => (
          <button
            key={c}
            className={`color-dot c-${c}`}
            title={`Drag onto items to color them ${c}`}
            aria-label={`Color ${c}`}
            onMouseDown={(e) => startPaletteDrag(e, { kind: "color", color: c })}
          />
        ))}
        <button
          className="color-dot is-default"
          title="Drag onto items to clear their color"
          aria-label="Clear color"
          onMouseDown={(e) => startPaletteDrag(e, { kind: "color", color: "default" })}
        />
      </div>
      {tags.length > 0 && (
        <>
          <div className="toolbar-sep" />
          <div className="toolbar-group toolbar-tags" aria-label="Drag to tag">
            {sortedTags(tags).map((t) => (
              <button
                key={t.id}
                className={`tag-chip is-draggable ${t.color !== "default" ? `c-${t.color}` : ""}`}
                title={`Drag onto items to tag them "${t.name}"`}
                onMouseDown={(e) => startPaletteDrag(e, { kind: "tag", tagId: t.id })}
              >
                <Icon name={t.icon} size={11} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="grow" />
      <div className="toolbar-group">
        <button className="btn btn-ghost btn-sm btn-icon" title={`Undo (${keyLabel("undo")})`} disabled={!canUndo} onClick={() => { flushEdit(); const l = undo(); if (l) toast(`Undid: ${l}`); }}>
          <Undo2 size={15} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" title={`Redo (${keyLabel("redo")})`} disabled={!canRedo} onClick={() => { const l = redo(); if (l) toast(`Redid: ${l}`); }}>
          <Redo2 size={15} />
        </button>
        <button className="btn btn-ghost btn-sm" title={`Cycle views (${keyLabel("cycle-views")})`} onClick={cycleViewVisibility}>
          {view.showColumnsView && <Columns3 size={15} />}
          {view.showCalendarView && <CalendarDays size={15} />}
        </button>
        {!hidePrint && (
          <button className="btn btn-ghost btn-sm btn-icon" title={`Print (${keyLabel("print")})`} onClick={() => openPrint()}>
            <Printer size={15} />
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-icon" title={`Stack (${keyLabel("stack")})`} onClick={() => openStack()}>
          <Layers size={15} />
        </button>
      </div>
    </div>
  );
}
