// The inline command menu opened by typing the inline trigger ("::" by
// default) while editing an item.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Shapes } from "lucide-react";
import type { Color, ItemType } from "../../model/types";
import { COLORS, ITEM_TYPES, isContainerType, isTaggableType } from "../../model/types";
import { addDays } from "../../model/dates";
import { get, set, useApp } from "../../state/store";
import { today } from "../../state/derived";
import { canChangeType, changeType, exitEdit, flushEdit, scheduleItems, setColor, toggleTag } from "../../state/items";
import { Icon } from "../icons";
import { fuzzyFilter } from "../fuzzy";

interface Entry {
  id: string;
  label: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

const TYPE_LABEL: Record<ItemType, string> = { task: "Task", text: "Text", heading: "Heading", folder: "Folder", template: "Template", separator: "Separator" };

export function InlineMenu({ itemId, x, y }: { itemId: string; x: number; y: number }) {
  const item = useApp((s) => s.doc?.items[itemId]);
  const tags = useApp((s) => s.doc?.config.tags);
  const view = useApp((s) => s.view.focusedView);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const entries = useMemo<Entry[]>(() => {
    if (!item) return [];
    const ids = [itemId];
    const list: Entry[] = [];
    for (const t of ITEM_TYPES) {
      if (canChangeType(ids, t, view)) list.push({ id: `t-${t}`, label: `Turn into ${TYPE_LABEL[t].toLowerCase()}`, icon: <Shapes size={14} />, keywords: "type", run: () => changeType(t, ids) });
    }
    for (const c of COLORS) {
      list.push({
        id: `c-${c}`,
        label: c === "default" ? "Clear color" : `Color ${c}`,
        icon: <span className={`swatch ${c === "default" ? "is-default" : `c-${c}`}`} />,
        keywords: "colour",
        run: () => setColor(c as Color, ids),
      });
    }
    if (isTaggableType(item.type)) {
      for (const t of tags ?? []) {
        list.push({
          id: `g-${t.id}`,
          label: `${item.tags.includes(t.id) ? "Remove" : "Add"} tag ${t.name}`,
          icon: <span className={`c-${t.color}`} style={{ color: "var(--c)" }}><Icon name={t.icon} size={14} /></span>,
          keywords: "tag",
          run: () => toggleTag(t.id, ids),
        });
      }
    }
    if (!isContainerType(item.type) || item.parentId) {
      list.push({ id: "s-today", label: "Schedule today", icon: <CalendarPlus size={14} />, keywords: "date", run: () => scheduleItems(ids, today()) });
      list.push({ id: "s-tomorrow", label: "Schedule tomorrow", icon: <CalendarPlus size={14} />, keywords: "date", run: () => scheduleItems(ids, addDays(today(), 1)) });
    }
    return list;
  }, [item, itemId, tags, view]);

  const shown = fuzzyFilter(entries, query, (e) => `${e.label} ${e.keywords ?? ""}`).slice(0, 12);

  const close = (refocus: boolean) => {
    set({ overlay: null });
    if (refocus) window.dispatchEvent(new CustomEvent("cascade:focus-editor"));
  };

  const run = (e: Entry | undefined) => {
    if (!e) return;
    flushEdit();
    close(false);
    e.run();
    if (get().edit) exitEdit();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(shown.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") run(shown[active]);
    else if (e.key === "Escape" || (e.key === "Backspace" && !query)) close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menu-layer" onMouseDown={() => close(true)}>
      <div className="menu inline-menu" style={{ left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 340) }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="inline-menu-input"
          placeholder="Command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => get().overlay?.kind === "inline" && inputRef.current?.focus(), 0)}
        />
        {shown.map((e, i) => (
          <button key={e.id} className={`menu-item ${i === active ? "is-active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => run(e)}>
            <span className="menu-icon">{e.icon}</span>
            <span className="menu-label">{e.label}</span>
          </button>
        ))}
        {shown.length === 0 && <div className="palette-empty">No commands</div>}
      </div>
    </div>
  );
}
