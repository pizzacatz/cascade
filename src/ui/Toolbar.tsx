// Bottom floating toolbar: draggable palette chips (item types, colours, tags)
// plus quick actions.

import { CheckSquare, Type, Heading, Folder, Minus, Printer, Layers, Columns3, CalendarDays, Undo2, Redo2, BookmarkCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { COLORS } from "../model/types";
import { useApp, undo, redo, toast } from "../state/store";
import { startPaletteDrag } from "./dnd";
import { cycleViewVisibility } from "../state/nav";
import { openPrint } from "../state/printing";
import { openStack } from "../state/stack";
import { sortedTags } from "../state/config";
import { flushEdit } from "../state/items";
import { keyLabel } from "../state/shortcuts";
import { Icon } from "./icons";

const TYPES: { type: "task" | "text" | "heading" | "folder" | "separator" | "template"; label: string; icon: LucideIcon }[] = [
  { type: "task", label: "Task", icon: CheckSquare },
  { type: "text", label: "Text", icon: Type },
  { type: "heading", label: "Heading", icon: Heading },
  { type: "folder", label: "Folder", icon: Folder },
  { type: "template", label: "Template", icon: BookmarkCheck },
  { type: "separator", label: "Separator", icon: Minus },
];

const NO_TAGS: never[] = [];

export function Toolbar() {
  const tags = useApp((s) => s.doc?.config.tags ?? NO_TAGS);
  const view = useApp((s) => s.view);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const hidePrint = useApp((s) => s.printSettings.hidePrintButtons);

  return (
    <div className="toolbar" role="toolbar" aria-label="Toolbar">
      <div className="toolbar-group" aria-label="Drag to create">
        {TYPES.map((t) => (
          <button
            key={t.type}
            className="palette-chip"
            title={`Drag to create a ${t.label.toLowerCase()}`}
            aria-label={`Drag to create a ${t.label.toLowerCase()}`}
            onMouseDown={(e) => startPaletteDrag(e, { kind: "type", type: t.type })}
          >
            <t.icon size={15} />
          </button>
        ))}
      </div>
      <div className="toolbar-sep" />
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
        <button
          className="btn btn-ghost btn-sm"
          title={`Cycle views (${keyLabel("cycle-views")})`}
          onClick={cycleViewVisibility}
        >
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
