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
  const list = ctx === "edition" ? null : bindingsForHelp(ctx);
  const editor = EDITOR_KEYS.map(([k, d]) =>
    k === "#" ? ([triggers[0], d] as [string, string]) : k === "---" ? ([triggers[1], d] as [string, string]) : k === "::" ? ([triggers[2], d] as [string, string]) : ([k, d] as [string, string]),
  );
  return (
    <aside className="help-panel" aria-label="Help">
      <header>
        <strong>Shortcuts</strong>
        <span className="muted">{CONTEXT_LABEL[ctx] ?? ""}</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close help" onClick={() => updatePrefs({ showHelp: false })}>
          <X size={14} />
        </button>
      </header>
      <div className="help-body">
        {list === null ? (
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
