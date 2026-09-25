import { X } from "lucide-react";
import { useApp, updatePrefs } from "../state/store";
import { context } from "../state/nav";
import { BINDINGS, bindingsForHelp, keyLabel, type Category } from "../state/shortcuts";

const CONTEXT_LABEL: Record<string, string> = {
  none: "Nothing selected",
  selection: "Item selected",
  edition: "Editing text",
  "create-target": "Ready to create",
  drag: "Dragging",
  nofile: "No document",
};

const modeLabel = (ctx: string) => (ctx.startsWith("overlay-") ? `overlay · ${ctx.slice(8).replace(/([A-Z])/g, " $1").toLowerCase()}` : `mode · ${CONTEXT_LABEL[ctx] ?? ctx}`);

const MOUSE: [string, string][] = [
  ["Click", "Select an item (while editing: edit it, caret at the click)"],
  ["Double-click", "Edit an item"],
  ["Ctrl+click", "Add to / remove from the selection"],
  ["Shift+click", "Extend the selection"],
  ["Drag", "Move (top/bottom edge: before/after, middle: into)"],
  ["Ctrl+drag", "Duplicate instead of moving"],
  ["Drag onto a toolbar chip", "Apply that type, color or tag"],
  ["Right-click", "Item, column or space menu"],
];

/** Keys for dialogs, shown while one is open. */
const OVERLAY_KEYS: Record<string, [string, string][]> = {
  command: [
    ["↑ ↓", "Navigate (←↑↓→ on calendar and icon pages)"],
    ["Enter", "Run / choose"],
    ["Backspace", "Back to the previous page (empty filter)"],
    ["Esc", "Close"],
  ],
  print: [
    ["Enter", "Print"],
    ["Esc", "Close"],
  ],
  prepare: [
    ["← → ↑ ↓", "Choose a day"],
    ["Enter", "Continue / apply"],
    ["Backspace", "Back"],
    ["Esc", "Close"],
  ],
  template: [
    ["↑ ↓", "Choose a template"],
    ["Enter", "Insert"],
    ["Esc", "Close"],
  ],
  context: [
    ["↑ ↓", "Navigate"],
    ["→ / ←", "Open / close a submenu"],
    ["Enter", "Choose"],
    ["Esc", "Close"],
  ],
};

const EDITOR_KEYS: [string, string][] = [
  ["Enter", "Finish and create the next item"],
  ["Ctrl+Enter", "Finish and create a child"],
  ["Esc", "Stop editing"],
  ["↑ / ↓", "Edit the previous / next item"],
  ["Alt+← / →", "Edit the parent / first child"],
  ["#", "At the start: turn into a heading"],
  ["---", "Whole text: turn into a separator"],
  ["::", "Open the inline command menu"],
];

const CATEGORY_LABEL: Record<Category, string> = {
  editing: "Editing",
  creation: "Creating",
  selection: "Selecting",
  navigation: "Navigating",
  status: "Status",
  move: "Moving",
  clipboard: "Clipboard",
  views: "Views",
  file: "Files",
  system: "Application",
};

export function HelpPanel() {
  const ctx = useApp((s) => context(s));
  const prefs = useApp((s) => s.prefs);
  const triggers = [prefs.headingShortcutTrigger, prefs.separatorShortcutTrigger, prefs.inlineCommandTrigger];
  const overlayKind = ctx.startsWith("overlay-") ? ctx.slice(8) : null;
  const overlayKeys = overlayKind ? OVERLAY_KEYS[overlayKind] ?? [["Esc", "Close"]] : null;
  const list = ctx === "edition" || overlayKeys ? null : bindingsForHelp(ctx);
  const editor = EDITOR_KEYS.map(([k, d]) =>
    k === "#" ? ([triggers[0], d] as [string, string]) : k === "---" ? ([triggers[1], d] as [string, string]) : k === "::" ? ([triggers[2], d] as [string, string]) : ([k, d] as [string, string]),
  );
  return (
    <aside className="help-panel" aria-label="Help">
      <header>
        <strong>Shortcuts</strong>
        <span className="mode-pill">{modeLabel(ctx)}</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close help" onClick={() => updatePrefs({ showHelp: false })}>
          <X size={14} />
        </button>
      </header>
      <div className="help-body">
        {overlayKeys ? (
          <dl>
            {overlayKeys.map(([k, d]) => (
              <div key={d} className="help-row">
                <dt><span className="kbd">{k}</span></dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        ) : list === null ? (
          <dl>
            {editor.map(([k, d]) => (
              <div key={d} className="help-row">
                <dt><span className="kbd">{k}</span></dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl>
            {list.map((b) => (
              <div key={b.id} className="help-row">
                <dt><span className="kbd">{keyLabel(b.id)}</span></dt>
                <dd>{b.description}</dd>
              </div>
            ))}
          </dl>
        )}
        <details className="help-all" open={ctx === "nofile"}>
          <summary>Mouse</summary>
          <dl>
            {MOUSE.map(([k, d]) => (
              <div key={k} className="help-row">
                <dt><span className="kbd">{k}</span></dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </details>
        <details className="help-all">
          <summary>All shortcuts</summary>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((cat) => {
            const items = BINDINGS.filter((b) => b.category === cat);
            if (!items.length) return null;
            return (
              <section key={cat}>
                <h4>{CATEGORY_LABEL[cat]}</h4>
                <dl>
                  {items.map((b) => (
                    <div key={b.id} className="help-row">
                      <dt><span className="kbd">{keyLabel(b.id)}</span></dt>
                      <dd>{b.description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </details>
      </div>
    </aside>
  );
}
