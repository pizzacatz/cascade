// Creation affordances shared by columns and calendar days:
//  - the "+ Create a new item" row at the bottom of a column (also the
//    keyboard-focusable "create target"),
//  - the footer of hints shown in the column being edited,
//  - the virtual "Turn into folder and create a new item" column.

import { ArrowLeftRight, Folder, Plus } from "lucide-react";
import { useApp, type CreateTarget } from "../state/store";
import { createAtTarget } from "../state/items";
import { keyLabel } from "../state/shortcuts";

export type CreateHint = "enter" | "ctrl-enter" | "pulse" | null;

export function CreateRow({ target, focused, hint }: { target: CreateTarget; focused: boolean; hint: CreateHint }) {
  return (
    <button
      className={`create-row ${focused ? "is-focused" : ""} ${hint === "pulse" ? "is-pulsing" : ""}`}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={() => createAtTarget(target)}
      aria-label="Create a new item"
    >
      <Plus size={14} />
      <span>Create a new item</span>
      {hint && <span className="kbd">{hint === "ctrl-enter" ? keyLabel("create-child") : "Enter"}</span>}
    </button>
  );
}

export function EditFooter({ allowChild }: { allowChild: boolean }) {
  const hidden = useApp((s) => s.prefs.hideCreateItemButton);
  if (hidden) return null;
  return (
    <div className="edit-footer" aria-hidden>
      <div>
        <span className="kbd">Enter</span> to create a new item
      </div>
      {allowChild && (
        <div>
          <span className="kbd">{keyLabel("create-child")}</span> to create a child item
        </div>
      )}
      <div>
        <span className="kbd">Esc</span> to exit edit mode
      </div>
    </div>
  );
}

export function ConvertColumn({ itemId, width }: { itemId: string; width: number }) {
  const focused = useApp((s) => s.createTarget?.view === "columns" && s.createTarget.parentId === itemId);
  const dropHere = useApp(
    (s) => (s.drag?.status === "active" && s.drag.target?.kind === "column-end" && s.drag.target.parentId === itemId) || s.createPreview?.columnStart === itemId,
  );
  const hideHeader = useApp((s) => s.prefs.hideColumnHeaders);
  const title = useApp((s) => s.doc?.items[itemId]?.text ?? "");
  return (
    <div className="column convert-column" style={{ width }} data-column-id={itemId}>
      {/* Same header height as real columns, so the button lines up with the first row. */}
      {!hideHeader && (
        <header className="column-header convert-header">
          <span className="column-title">{title}</span>
        </header>
      )}
      <div className={`convert-body ${dropHere ? "drop-end" : ""}`} data-column-id={itemId}>
        <button
          className={`convert-btn ${focused ? "is-focused" : ""}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={() => createAtTarget({ view: "columns", parentId: itemId })}
          title={`Turn into folder and create a new item (${keyLabel("create-child")})`}
        >
          <span className="convert-icons">
            <ArrowLeftRight size={14} />
            <Folder size={15} />
          </span>
          <span className="convert-label">Turn into folder and create a new item</span>
          {focused && <span className="kbd">Enter</span>}
        </button>
      </div>
    </div>
  );
}
