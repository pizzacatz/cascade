import { Copy } from "lucide-react";
import { useApp } from "../state/store";

export function DragGhost() {
  const drag = useApp((s) => (s.drag?.status === "active" ? s.drag : null));
  const first = useApp((s) => (s.drag?.ids[0] ? s.doc?.items[s.drag.ids[0]] : undefined));
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
  return (
    <div className={`drag-ghost ${cls} ${drag.target ? "" : "is-invalid"}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
      {drag.copy && <Copy size={12} />}
      <span>{label}</span>
    </div>
  );
}
