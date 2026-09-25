import { useState } from "react";
import type { Color } from "../model/types";
import { COLORS } from "../model/types";
import { ICON_NAMES, Icon, iconKeywords } from "./icons";
import { fuzzyFilter } from "./fuzzy";

const LABEL = (c: Color) => (c === "default" ? "Default" : c[0].toUpperCase() + c.slice(1));

export function ColorPicker({ value, onChange, allowDefault = true }: { value: string | null | undefined; onChange: (c: Color) => void; allowDefault?: boolean }) {
  return (
    <div className="color-picker" role="radiogroup">
      {COLORS.filter((c) => allowDefault || c !== "default").map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={(value ?? "default") === c}
          title={LABEL(c)}
          aria-label={LABEL(c)}
          className={`swatch swatch-btn ${c === "default" ? "is-default" : `c-${c}`} ${(value ?? "default") === c ? "is-selected" : ""}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

export function IconPicker({ value, onChange }: { value: string | null | undefined; onChange: (name: string) => void }) {
  const [q, setQ] = useState("");
  const list = fuzzyFilter(ICON_NAMES, q, iconKeywords);
  return (
    <div className="icon-picker">
      <input className="input" placeholder="Search icons…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="icon-grid">
        {list.map((n) => (
          <button key={n} className={`icon-cell ${value === n ? "is-selected" : ""}`} title={n} aria-label={n} onClick={() => onChange(n)}>
            <Icon name={n} size={17} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A compact button that reveals the icon picker in a popover. */
export function IconButton({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="icon-button-wrap">
      <button className="btn btn-sm btn-icon" aria-label="Change icon" onClick={() => setOpen((o) => !o)}>
        <Icon name={value} size={15} />
      </button>
      {open && (
        <div className="popover" onMouseLeave={() => setOpen(false)}>
          <IconPicker
            value={value}
            onChange={(n) => {
              onChange(n);
              setOpen(false);
            }}
          />
        </div>
      )}
    </span>
  );
}
