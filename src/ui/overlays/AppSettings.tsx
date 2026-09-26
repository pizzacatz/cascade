import { Settings, Monitor, Sun, Moon } from "lucide-react";
import { get, useApp, updatePrefs, toast } from "../../state/store";
import { exportCalendar, writeIcsSidecar } from "../../state/exports";
import { confirmAction, openOverlay } from "../../state/overlays";
import { enablePortableMode, portableStatus } from "../../state/files";
import { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, defaultPreferences, type DebugMode } from "../../state/prefs";
import { Modal, SettingsSwitcher } from "./Modal";

type Tab = "general" | "interface" | "triggers" | "calendar";

const TABS: [Tab, string][] = [
  ["general", "General"],
  ["interface", "Interface"],
  ["triggers", "Editor triggers"],
  ["calendar", "Calendar"],
];

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field-inline">
      <span>
        {label}
        {hint && <span className="field-hint block">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function AppSettings({ tab }: { tab: Tab }) {
  const p = useApp((s) => s.prefs);
  const setTab = (t: Tab) => openOverlay({ kind: "appSettings", tab: t });
  return (
    <Modal title="Settings" icon={<Settings size={16} />} width={620} height="min(80vh, 600px)" footer={<SettingsSwitcher current="app" />}>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "tab-active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="settings-body stack-v">
        {tab === "general" && (
          <>
            <div className="field-inline">
              <span>Theme</span>
              <div className="segmented">
                {([
                  ["auto", "System", Monitor],
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                ] as const).map(([v, label, I]) => (
                  <button key={v} aria-pressed={p.theme === v} onClick={() => updatePrefs({ theme: v })}>
                    <I size={12} /> {label}
                  </button>
                ))}
              </div>
            </div>
            <Toggle
              label="Reopen the last document on startup"
              checked={p.openLastDocumentOnStartup}
              onChange={(v) => updatePrefs({ openLastDocumentOnStartup: v })}
            />
            <Toggle label="Show the help panel" hint="Context-aware shortcut hints (F1)." checked={p.showHelp} onChange={(v) => updatePrefs({ showHelp: v })} />
            <label className="field-inline">
              <span>
                Debug tools
                <span className="field-hint block">Support diagnostics: rendering speed, drag state, and history.</span>
              </span>
              <select className="select" value={p.debugMode} onChange={(e) => updatePrefs({ debugMode: e.target.value as DebugMode })}>
                <option value="disabled">Disabled</option>
                <option value="speed">Speed</option>
                <option value="drag">Drag &amp; drop</option>
                <option value="state">State</option>
              </select>
            </label>
            <PortableRow />
            <p className="field-hint">
              Cascade stores documents as local <code>.col</code> files and never contacts a server. Automatic backups of each document are kept
              for 5 days in the app data folder.
            </p>
          </>
        )}
        {tab === "interface" && (
          <>
            <label className="field">
              <span className="field-label">
                Minimum column width · {p.minColumnWidth}px
              </span>
              <input
                type="range"
                min={MIN_COLUMN_WIDTH}
                max={MAX_COLUMN_WIDTH}
                step={5}
                value={p.minColumnWidth}
                onChange={(e) => updatePrefs({ minColumnWidth: Number(e.target.value) })}
              />
              <span className="field-hint">Columns and calendar days fill the window at no less than this width.</span>
            </label>
            <Toggle label="Hide column headers" checked={p.hideColumnHeaders} onChange={(v) => updatePrefs({ hideColumnHeaders: v })} />
            <Toggle label="Hide column buttons in header" checked={p.hideColumnHeaderButtons} onChange={(v) => updatePrefs({ hideColumnHeaderButtons: v })} />
            <Toggle label="Hide the bottom toolbar" checked={p.hideFloatingActionMenu} onChange={(v) => updatePrefs({ hideFloatingActionMenu: v })} />
            <Toggle label="Hide edit-mode footer hints" checked={p.hideCreateItemButton} onChange={(v) => updatePrefs({ hideCreateItemButton: v })} />
            <Toggle
              label="Show progress in columns"
              hint="Progress rings on column headers and folders."
              checked={p.columnsProgressBar !== "hide"}
              onChange={(v) => updatePrefs({ columnsProgressBar: v ? "showToAllColumns" : "hide" })}
            />
          </>
        )}
        {tab === "triggers" && (
          <>
            <p className="field-hint">Type these while editing an item.</p>
            {([
              ["inlineCommandTrigger", "Inline command menu", "Opens a small command menu at the caret."],
              ["headingShortcutTrigger", "Heading", "At the start of an item, turns it into a heading."],
              ["separatorShortcutTrigger", "Separator", "As the whole text of an item, turns it into a separator."],
            ] as const).map(([key, label, hint]) => (
              <label key={key} className="field">
                <span className="field-label">{label}</span>
                <input
                  className="input mono"
                  maxLength={8}
                  defaultValue={p[key]}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || defaultPreferences()[key];
                    const others = (["inlineCommandTrigger", "headingShortcutTrigger", "separatorShortcutTrigger"] as const).filter((k) => k !== key).map((k) => p[k]);
                    if (others.includes(v)) {
                      toast("Each trigger must be different", "error");
                      e.target.value = p[key];
                      return;
                    }
                    e.target.value = v;
                    updatePrefs({ [key]: v });
                  }}
                  style={{ width: 120 }}
                />
                <span className="field-hint">{hint}</span>
              </label>
            ))}
          </>
        )}
        {tab === "calendar" && (
          <>
            <div className="field-inline">
              <span>Week starts on</span>
              <div className="segmented">
                <button aria-pressed={p.weekStartsOn === "monday"} onClick={() => updatePrefs({ weekStartsOn: "monday" })}>
                  Monday
                </button>
                <button aria-pressed={p.weekStartsOn === "sunday"} onClick={() => updatePrefs({ weekStartsOn: "sunday" })}>
                  Sunday
                </button>
              </div>
            </div>
            <Toggle label="Show ISO week numbers in the day picker" checked={p.showWeekNumber} onChange={(v) => updatePrefs({ showWeekNumber: v })} />
            <Toggle
              label="Move unfinished tasks to today automatically"
              hint="When a document opens and at midnight, unfinished tasks (and folders with unfinished tasks) on past days move to today. Finished tasks stay where they were."
              checked={p.rollOverOverdue}
              onChange={(v) => updatePrefs({ rollOverOverdue: v })}
            />
            <Toggle
              label="Keep an .ics calendar copy next to each document"
              hint="Rewritten on every save as “<document>.ics”, so calendar apps can subscribe to the file. Dated tasks and folders become all-day events."
              checked={p.keepIcsCopy}
              onChange={(v) => {
                updatePrefs({ keepIcsCopy: v });
                const s = get();
                if (v && s.doc && s.filePath) writeIcsSidecar(s.filePath, s.doc).catch((e) => toast(`Could not write the calendar copy: ${String(e)}`, "error", 6000));
              }}
            />
            <div className="field-inline">
              <span>
                Export the calendar once
                <span className="field-hint block">Save the current document’s dated items as an .ics file.</span>
              </span>
              <button className="btn btn-sm" onClick={() => void exportCalendar()}>
                Export .ics…
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PortableRow() {
  const st = portableStatus();
  if (!st) return null;
  if (st.enabled) {
    return (
      <div className="field-inline">
        <span>
          Portable mode is on
          <span className="field-hint block">
            Settings and backups are stored in <code>{st.dataDir}</code>. Documents next to the app are remembered relative to it. Rename or
            delete that folder to turn portable mode off.
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="field-inline">
      <span>
        Portable mode
        <span className="field-hint block">
          Keep settings and backups in a <code>cascade-data</code> folder next to the app, e.g. on a USB stick, instead of this computer.
        </span>
      </span>
      <button
        className="btn btn-sm"
        disabled={!st.canEnable}
        title={st.canEnable ? undefined : "The app's folder is not writable"}
        onClick={() =>
          confirmAction({
            title: "Make Cascade portable?",
            message: `A cascade-data folder will be created in ${st.root}, your current settings and backups copied into it, and Cascade restarted. From then on, Cascade run from that folder keeps everything there.`,
            confirmLabel: "Make portable",
            onConfirm: () => void enablePortableMode(),
          })
        }
      >
        Make portable…
      </button>
    </div>
  );
}
