// A keyboard-navigable popup menu with flyout submenus.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface MenuEntry {
  label?: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuEntry[];
  run?: () => void;
}

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  /** Submenus close with ArrowLeft instead of closing everything. */
  isSub?: boolean;
  onRun?: () => void;
}

export function Menu({ x, y, entries, onClose, isSub, onRun }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(() => entries.findIndex((e) => !e.separator && !e.disabled));
  const [openSub, setOpenSub] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const nx = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
    const ny = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
    setPos({ x: nx, y: ny });
    el.focus({ preventScroll: true });
  }, [x, y]);

  const selectable = (i: number) => !!entries[i] && !entries[i].separator && !entries[i].disabled;
  const step = (d: number) => {
    let i = active;
    for (let n = 0; n < entries.length; n++) {
      i = (i + d + entries.length) % entries.length;
      if (selectable(i)) break;
    }
    setActive(i);
  };

  const activate = (i: number) => {
    const e = entries[i];
    if (!e || e.disabled || e.separator) return;
    if (e.submenu) {
      setOpenSub(i);
      return;
    }
    (onRun ?? onClose)();
    e.run?.();
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (openSub !== null) return;
      if (ev.key === "ArrowDown") step(1);
      else if (ev.key === "ArrowUp") step(-1);
      else if (ev.key === "Enter" || ev.key === " ") activate(active);
      else if (ev.key === "ArrowRight" && entries[active]?.submenu) setOpenSub(active);
      else if (ev.key === "ArrowLeft" && isSub) onClose();
      else if (ev.key === "Escape") onClose();
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const subAnchor = (i: number) => {
    const el = ref.current?.querySelectorAll<HTMLElement>(".menu-item")[i];
    const r = el?.getBoundingClientRect();
    return r ? { x: r.right - 2, y: r.top - 5 } : { x: pos.x, y: pos.y };
  };

  return (
    <>
      <div ref={ref} className="menu" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
        {entries.map((e, i) => {
          if (e.separator) return <div key={`sep${i}`} className="menu-sep" role="separator" />;
          return (
            <button
              key={`${e.label}${i}`}
              className={`menu-item ${i === active ? "is-active" : ""} ${e.danger ? "is-danger" : ""}`}
              role="menuitem"
              disabled={e.disabled}
              aria-haspopup={e.submenu ? "menu" : undefined}
              onMouseEnter={() => {
                setActive(i);
                setOpenSub(e.submenu ? i : null);
              }}
              onClick={() => activate(i)}
            >
              <span className="menu-icon">{e.icon}</span>
              <span className="menu-label">{e.label}</span>
              {e.checked && <span className="menu-check">✓</span>}
              {e.hint && <span className="menu-hint">{e.hint}</span>}
              {e.submenu && <ChevronRight size={13} className="menu-chevron" />}
            </button>
          );
        })}
      </div>
      {openSub !== null && entries[openSub]?.submenu && (
        <Menu
          {...subAnchor(openSub)}
          entries={entries[openSub].submenu!}
          isSub
          onClose={() => {
            setOpenSub(null);
            ref.current?.focus();
          }}
          onRun={onRun ?? onClose}
        />
      )}
    </>
  );
}
