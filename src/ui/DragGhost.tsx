import { Copy } from "lucide-react";
import { useApp } from "../state/store";

export function DragGhost() {
  const drag = useApp((s) => (s.drag?.status === "active" ? s.drag : null));
  const first = useApp((s) => (s.drag?.ids[0] ? s.doc?.items[s.drag.ids[0]] : undefined));
  // Dragging a folder onto a day: say whether its child items come along.
  const folderToDay = useApp((s) => {
    const d = s.drag;
    if (d?.status !== "active" || d.copy || !d.target) return false;
    const onDay = d.target.kind === "day-end" || ("view" in d.target && d.target.view === "calendar");
    if (!onDay) return false;
    return d.ids.some((id) => s.doc?.items[id]?.type === "folder");
  });
  const tagName = useApp((s) =>
    s.drag?.palette?.kind === "tag" ? s.doc?.config.tags.find((t) => t.id === (s.drag!.palette as { tagId: string }).tagId)?.name : undefined,
  );
  if (!drag) return null;
  let label: string;
  if (drag.palette) {
    const p = drag.palette;
    label = p.kind === "type" ? `New ${p.type}` : p.kind === "color" ? (p.color === "default" ? "Clear color" : `Color ${p.color}`) : `Tag ${tagName ?? ""}`;
  } else {
    label = drag.ids.length > 1 ? `${drag.ids.length} items` : first?.text || "Item";
  }
  const cls = drag.palette?.kind === "color" && drag.palette.color !== "default" ? `c-${drag.palette.color}` : "";
  if (!drag.palette) {
    // A faded copy of the grabbed row, with a count badge for several items.
    return (
      <div className={`drag-ghost is-row ${drag.target ? "" : "is-invalid"}`} style={{ left: drag.x + 12, top: drag.y + 8 }}>
        {drag.copy && <Copy size={12} />}
        <span className="ellipsis">{first?.text || "Item"}</span>
        {drag.ids.length > 1 && <span className="drag-count">{drag.ids.length}</span>}
        {folderToDay && <span className="drag-hint">{drag.alt ? "Folder only" : "With its items · Alt: folder only"}</span>}
      </div>
    );
  }
  return (
    <div className={`drag-ghost ${cls} ${drag.target ? "" : "is-invalid"}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
      <span>{label}</span>
    </div>
  );
}
