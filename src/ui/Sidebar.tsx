import { Plus, Settings, Command } from "lucide-react";
import { TRASH_SPACE_ID } from "../model/types";
import { visibleSpaces } from "../model/tree";
import { useApp } from "../state/store";
import { indexOf } from "../state/derived";
import { switchSpace } from "../state/nav";
import { createSpace } from "../state/config";
import { openCommand, openOverlay, promptText } from "../state/overlays";
import { updateSpace } from "../state/config";
import { Icon } from "./icons";

export function Sidebar() {
  const spaces = useApp((s) => s.doc?.config.spaces);
  const current = useApp((s) => s.view.currentSpaceId);
  const trashCount = useApp((s) => indexOf(s.doc).children.get(TRASH_SPACE_ID)?.length ?? 0);
  const dropSpace = useApp((s) => (s.drag?.status === "active" && s.drag.target?.kind === "space" ? s.drag.target.spaceId : null));
  const list = visibleSpaces(spaces ?? []);
  const user = list.filter((s) => s.id !== TRASH_SPACE_ID);
  const trash = list.find((s) => s.id === TRASH_SPACE_ID);

  const chip = (sp: (typeof list)[number]) => (
    <button
      key={sp.id}
      className={`space-chip ${sp.id === current ? "is-active" : ""} ${sp.color !== "default" ? `c-${sp.color} has-color` : ""} ${dropSpace === sp.id ? "is-drop" : ""}`}
      data-space-id={sp.id}
      title={sp.name}
      aria-label={sp.name}
      aria-current={sp.id === current}
      onClick={() => switchSpace(sp.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openOverlay({ kind: "context", x: e.clientX, y: e.clientY, target: { type: "space", spaceId: sp.id } });
      }}
    >
      <Icon name={sp.icon} size={18} />
      {sp.id === TRASH_SPACE_ID && trashCount > 0 && <span className="space-badge">{trashCount > 99 ? "99+" : trashCount}</span>}
    </button>
  );

  return (
    <aside className="sidebar" aria-label="Spaces">
      <div className="sidebar-spaces">
        {user.map(chip)}
        <button
          className="space-chip space-add"
          title="New space"
          aria-label="New space"
          onClick={() => {
            const id = createSpace();
            if (id)
              promptText({
                title: "New space",
                label: "Name",
                value: "New space",
                onSubmit: (name) => updateSpace(id, { name: name.trim() || "New space" }),
              });
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="sidebar-bottom">
        {trash && chip(trash)}
        <button className="space-chip" title="Command menu (Ctrl+K)" aria-label="Command menu" onClick={() => openCommand("root")}>
          <Command size={17} />
        </button>
        <button className="space-chip" title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => openOverlay({ kind: "appSettings", tab: "general" })}>
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
