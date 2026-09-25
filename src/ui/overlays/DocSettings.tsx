import { useState } from "react";
import {
  Settings2,
  ArrowUp,
  ArrowDown,
  Trash2,
  Archive,
  ArchiveRestore,
  Plus,
  CopyPlus,
  SlidersHorizontal,
  ListChecks,
  Palette,
  Printer,
  AlertTriangle,
  CalendarDays,
} from "lucide-react";
import type {
  Condition,
  FormatRule,
  NumberField,
  NumberOperator,
  RecurrenceRule,
  ScheduleOperator,
  TextOperator,
  Weekday,
} from "../../model/types";
import { NUMBER_FIELDS, NUMBER_OPERATORS, SCHEDULE_OPERATORS, TEXT_OPERATORS, TRASH_SPACE_ID, TREE_SPACE_ID } from "../../model/types";
import { isUserSpace, sortSpaces, breadcrumb, spaceOf } from "../../model/tree";
import { sortRules } from "../../model/formatting";
import { describeRecurrence, recurrenceMatches, toRRule } from "../../model/recurrence";
import { addDays, formatLongDay } from "../../model/dates";
import { get, useApp } from "../../state/store";
import { indexOf, today } from "../../state/derived";
import { confirmAction, openOverlay } from "../../state/overlays";
import {
  createRecurrenceRule,
  createRule,
  createSpace,
  createTag,
  deleteRecurrenceRule,
  duplicateRecurrenceRule,
  deleteRule,
  deleteSpace,
  deleteTag,
  duplicateRule,
  moveRecurrenceRule,
  moveRule,
  moveSpace,
  moveTag,
  setProgressionMode,
  setSpaceArchived,
  sortedTags,
  templateItems,
  updateRecurrenceRule,
  updateRule,
  updateSpace,
  updateTag,
} from "../../state/config";
import { displayName } from "../../platform";
import { ColorPicker, IconButton } from "../Pickers";
import { Icon } from "../icons";
import { Modal, SettingsSwitcher } from "./Modal";
import { MonthGrid } from "../MonthGrid";

type Tab = "general" | "spaces" | "tags" | "formatting" | "recurrence";
const TABS: [Tab, string][] = [
  ["general", "General"],
  ["spaces", "Spaces"],
  ["tags", "Tags"],
  ["formatting", "Formatting"],
  ["recurrence", "Recurrence"],
];

export function DocSettings({ tab, ruleId }: { tab: Tab; ruleId?: string }) {
  const setTab = (t: Tab) => openOverlay({ kind: "docSettings", tab: t });
  return (
    <Modal title="Document settings" icon={<Settings2 size={16} />} width={880} height="min(86vh, 760px)" footer={<SettingsSwitcher current="doc" />}>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "tab-active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === "general" && <GeneralTab />}
        {tab === "spaces" && <SpacesTab />}
        {tab === "tags" && <TagsTab />}
        {tab === "formatting" && <FormattingTab initial={ruleId} />}
        {tab === "recurrence" && <RecurrenceTab initial={ruleId} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function GeneralTab() {
  const doc = useApp((s) => s.doc)!;
  const path = useApp((s) => s.filePath);
  const items = Object.values(doc.items);
  const tasks = items.filter((x) => x.type === "task");
  return (
    <div className="stack-v">
      <div className="field">
        <span className="field-label">File</span>
        <span className="mono small">{path ? `${displayName(path)} — ${path}` : "Unsaved"}</span>
      </div>
      <div className="field">
        <span className="field-label">Folder progress</span>
        <div className="segmented">
          <button aria-pressed={doc.config.progressionMode === "by_level"} onClick={() => setProgressionMode("by_level")}>
            By level
          </button>
          <button aria-pressed={doc.config.progressionMode === "by_task_count"} onClick={() => setProgressionMode("by_task_count")}>
            By task count
          </button>
        </div>
        <span className="field-hint">
          {doc.config.progressionMode === "by_level"
            ? "A folder's progress is the average of its direct children — each child counts equally."
            : "A folder's progress is finished tasks ÷ all tasks anywhere inside it."}
        </span>
      </div>
      <div className="stats-grid">
        <div>
          <strong>{items.length}</strong>
          <span className="muted">items</span>
        </div>
        <div>
          <strong>{tasks.length}</strong>
          <span className="muted">tasks</span>
        </div>
        <div>
          <strong>{tasks.filter((t) => t.finished).length}</strong>
          <span className="muted">finished</span>
        </div>
        <div>
          <strong>{doc.config.spaces.filter((s) => s.id !== TREE_SPACE_ID).length}</strong>
          <span className="muted">spaces</span>
        </div>
      </div>
      <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => openOverlay({ kind: "printSettings" }, { stack: true })}>
        <Printer size={14} /> Print settings…
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SpacesTab() {
  const spaces = useApp((s) => s.doc?.config.spaces ?? []);
  const sorted = sortSpaces(spaces).filter((s) => s.id !== TREE_SPACE_ID);
  const active = sorted.filter((s) => !s.archived);
  const archived = sorted.filter((s) => s.archived);
  const row = (sp: (typeof sorted)[number]) => (
    <div key={sp.id} className="settings-row">
      <IconButton value={sp.icon} onChange={(icon) => updateSpace(sp.id, { icon })} />
      <input
        className="input grow"
        defaultValue={sp.name}
        disabled={sp.id === TRASH_SPACE_ID}
        onBlur={(e) => e.target.value.trim() && e.target.value !== sp.name && updateSpace(sp.id, { name: e.target.value.trim() })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label="Space name"
      />
      <ColorPicker value={sp.color} onChange={(color) => updateSpace(sp.id, { color })} />
      {!sp.archived && (
        <>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" onClick={() => moveSpace(sp.id, -1)}>
            <ArrowUp size={14} />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" onClick={() => moveSpace(sp.id, 1)}>
            <ArrowDown size={14} />
          </button>
        </>
      )}
      {isUserSpace(sp.id) ? (
        <>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={sp.archived ? "Unarchive" : "Archive"}
            title={sp.archived ? "Unarchive" : "Archive"}
            onClick={() => setSpaceArchived(sp.id, !sp.archived)}
          >
            {sp.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Delete space"
            onClick={() =>
              confirmAction({
                title: `Delete “${sp.name}”?`,
                message: `${spaceItemCount(sp.id)} item${spaceItemCount(sp.id) === 1 ? "" : "s"} will move to Trash. Formatting conditions referencing this space are removed.`,
                confirmLabel: "Delete",
                danger: true,
                onConfirm: () => deleteSpace(sp.id),
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </>
      ) : (
        <span className="settings-row-spacer" />
      )}
    </div>
  );
  return (
    <div className="stack-v">
      <p className="field-hint">Spaces are separate top-level areas of the document. Home and Trash are built in.</p>
      <div className="settings-list">{active.map(row)}</div>
      <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => createSpace()}>
        <Plus size={14} /> New space
      </button>
      {archived.length > 0 && (
        <>
          <h4 className="settings-subhead">Archived</h4>
          <div className="settings-list">{archived.map(row)}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TagsTab() {
  const tags = useApp((s) => s.doc?.config.tags ?? []);
  const [name, setName] = useState("");
  const add = () => {
    if (!name.trim()) return;
    createTag(name.trim());
    setName("");
  };
  return (
    <div className="stack-v">
      <p className="field-hint">Tags can be attached to tasks, folders and templates, filtered in search, and used by formatting rules.</p>
      <div className="settings-list">
        {sortedTags(tags).map((t) => (
          <div key={t.id} className="settings-row">
            <IconButton value={t.icon} onChange={(icon) => updateTag(t.id, { icon })} />
            <input
              className="input grow"
              defaultValue={t.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && updateTag(t.id, { name: e.target.value.trim() })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Tag name"
            />
            <ColorPicker value={t.color} onChange={(color) => updateTag(t.id, { color })} />
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" onClick={() => moveTag(t.id, -1)}>
              <ArrowUp size={14} />
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" onClick={() => moveTag(t.id, 1)}>
              <ArrowDown size={14} />
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Duplicate tag" title="Duplicate" onClick={() => createTag(`${t.name} copy`, t.color, t.icon)}>
              <CopyPlus size={14} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              aria-label="Delete tag"
              onClick={() =>
                confirmAction({
                  title: `Delete tag “${t.name}”?`,
                  message: `This tag will be removed from ${tagUseCount(t.id)} item${tagUseCount(t.id) === 1 ? "" : "s"} and from formatting rules that reference it.`,
                  confirmLabel: "Delete",
                  danger: true,
                  onConfirm: () => deleteTag(t.id),
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {tags.length === 0 && <p className="muted">No tags yet.</p>}
      </div>
      <div className="row">
        <input className="input" placeholder="New tag name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn" onClick={add} disabled={!name.trim()}>
          <Plus size={14} /> Add tag
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

const TEXT_OP_LABEL: Record<TextOperator, string> = {
  is_empty: "is empty",
  is_not_empty: "is not empty",
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  does_not_contain: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  matches_regex: "matches regex",
  does_not_match_regex: "does not match regex",
};
const SCHEDULE_LABEL: Record<ScheduleOperator, string> = {
  has_no_date: "has no date",
  has_date: "has a date",
  is_overdue: "is overdue",
  is_not_overdue: "is not overdue",
  today: "is today",
  yesterday: "was yesterday",
  tomorrow: "is tomorrow",
  this_week: "is this week",
  last_week: "was last week",
  this_month: "is this month",
  last_month: "was last month",
  next_month: "is next month",
};
const FIELD_LABEL: Record<NumberField, string> = {
  progression: "Progress (%)",
  totalTaskCount: "Total tasks",
  completedTaskCount: "Finished tasks",
  incompleteTaskCount: "Unfinished tasks",
  overdueTaskCount: "Overdue tasks",
  todayTaskCount: "Today tasks",
  futureTaskCount: "Future tasks",
  directOverdueTaskCount: "Direct overdue tasks",
  directTodayTaskCount: "Direct today tasks",
  directFutureTaskCount: "Direct future tasks",
};
const NUM_OP_LABEL: Record<NumberOperator, string> = {
  equals: "=",
  not_equals: "≠",
  greater_than: ">",
  greater_than_or_equal: "≥",
  less_than: "<",
  less_than_or_equal: "≤",
  between: "between",
  not_between: "not between",
};

function FormattingTab({ initial }: { initial?: string }) {
  const rules = useApp((s) => s.doc?.config.conditionalFormatting ?? []);
  const sorted = sortRules(rules);
  const [selected, setSelected] = useState<string | undefined>(initial ?? sorted[0]?.id);
  const rule = rules.find((r) => r.id === selected) ?? sorted[0];
  const enabled = sorted.filter((r) => r.enabled);
  const disabled = sorted.filter((r) => !r.enabled);
  const item = (r: FormatRule) => (
    <div key={r.id} className={`rule-row ${rule?.id === r.id ? "is-active" : ""}`} onClick={() => setSelected(r.id)}>
      <input
        type="checkbox"
        className="switch"
        checked={r.enabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => updateRule(r.id, (d) => void (d.enabled = e.target.checked))}
        aria-label="Enabled"
      />
      <span className="grow ellipsis">{r.name}</span>
      <span className="badge">{r.kind === "taskRule" ? "Task" : "Folder"}</span>
    </div>
  );
  return (
    <div className="split-pane">
      <div className="split-list">
        <div className="settings-subhead">Enabled · top rule wins colors</div>
        {enabled.map(item)}
        {disabled.length > 0 && <div className="settings-subhead">Disabled</div>}
        {disabled.map(item)}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => setSelected(createRule("taskRule") ?? undefined)}>
            <Plus size={13} /> Task rule
          </button>
          <button className="btn btn-sm" onClick={() => setSelected(createRule("folderRule") ?? undefined)}>
            <Plus size={13} /> Folder rule
          </button>
        </div>
      </div>
      <div className="split-detail">{rule ? <RuleEditor key={rule.id} rule={rule} onSelect={setSelected} /> : <p className="muted">No rules. Create one to restyle items automatically.</p>}</div>
    </div>
  );
}

function RuleEditor({ rule, onSelect }: { rule: FormatRule; onSelect: (id: string | undefined) => void }) {
  const [tab, setTab] = useState<"properties" | "conditions" | "style">("properties");
  const up = (fn: (r: FormatRule) => void) => updateRule(rule.id, fn);
  return (
    <div className="stack-v">
      <div className="row">
        <strong className="grow ellipsis">{rule.name}</strong>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" onClick={() => moveRule(rule.id, -1)}>
          <ArrowUp size={14} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" onClick={() => moveRule(rule.id, 1)}>
          <ArrowDown size={14} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Duplicate rule" onClick={() => onSelect(duplicateRule(rule.id) ?? undefined)}>
          <CopyPlus size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Delete rule"
          onClick={() =>
            confirmAction({ title: `Delete rule “${rule.name}”?`, message: `This rule, its ${rule.conditions.length} condition${rule.conditions.length === 1 ? "" : "s"} and its style will be deleted (Undo restores it).`, confirmLabel: "Delete", danger: true, onConfirm: () => { deleteRule(rule.id); onSelect(undefined); } })
          }
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === "properties" ? "tab-active" : ""}`} onClick={() => setTab("properties")}>
          <SlidersHorizontal size={13} /> Properties
        </button>
        <button className={`tab ${tab === "conditions" ? "tab-active" : ""}`} onClick={() => setTab("conditions")}>
          <ListChecks size={13} /> Conditions ({rule.conditions.length})
        </button>
        <button className={`tab ${tab === "style" ? "tab-active" : ""}`} onClick={() => setTab("style")}>
          <Palette size={13} /> Style
        </button>
      </div>
      {tab === "properties" && (
        <div className="stack-v">
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={rule.name} onChange={(e) => up((r) => void (r.name = e.target.value))} />
          </label>
          <div className="field">
            <span className="field-label">Applies to</span>
            <span>{rule.kind === "taskRule" ? "Tasks" : "Folders"}</span>
          </div>
          <div className="field">
            <span className="field-label">Logic</span>
            <div className="segmented">
              <button aria-pressed={rule.logic === "all"} onClick={() => up((r) => void (r.logic = "all"))}>
                All conditions
              </button>
              <button aria-pressed={rule.logic === "any"} onClick={() => up((r) => void (r.logic = "any"))}>
                Any condition
              </button>
            </div>
            <span className="field-hint">How conditions are combined.</span>
          </div>
          <label className="field-inline">
            <span>Enabled</span>
            <input type="checkbox" className="switch" checked={rule.enabled} onChange={(e) => up((r) => void (r.enabled = e.target.checked))} />
          </label>
        </div>
      )}
      {tab === "conditions" && <ConditionsEditor rule={rule} />}
      {tab === "style" && <StyleEditor rule={rule} />}
    </div>
  );
}

function newCondition(kind: Condition["kind"], ctx: { firstTag?: string; firstSpace: string }): Condition {
  switch (kind) {
    case "tag":
      return ctx.firstTag ? { kind: "tag", operator: "has", tagId: ctx.firstTag } : { kind: "tag", operator: "has_any" };
    case "text":
      return { kind: "text", operator: "contains", value: "" };
    case "space":
      return { kind: "space", operator: "is_in_space", spaceId: ctx.firstSpace };
    case "scheduleDate":
      return { kind: "scheduleDate", operator: "is_overdue" };
    case "finished":
      return { kind: "finished", value: true };
    case "number":
      return { kind: "number", field: "totalTaskCount", operator: "greater_than", value: 0 };
  }
}

function ConditionsEditor({ rule }: { rule: FormatRule }) {
  const tags = useApp((s) => s.doc?.config.tags ?? []);
  const spaces = useApp((s) => s.doc?.config.spaces ?? []);
  const userSpaces = sortSpaces(spaces).filter((s) => !s.archived && s.id !== TREE_SPACE_ID);
  const kinds: [Condition["kind"], string][] =
    rule.kind === "taskRule"
      ? [
          ["finished", "Finished"],
          ["tag", "Tag"],
          ["text", "Text"],
          ["space", "Space"],
          ["scheduleDate", "Date"],
        ]
      : [
          ["number", "Count / progress"],
          ["tag", "Tag"],
          ["text", "Text"],
          ["space", "Space"],
        ];
  const setCond = (i: number, c: Condition) => updateRule(rule.id, (r) => void ((r.conditions as Condition[])[i] = c));
  const remove = (i: number) =>
    confirmAction({
      title: "Delete condition?",
      message: "Only this condition will be removed; the rest of the rule stays.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => updateRule(rule.id, (r) => void (r.conditions as Condition[]).splice(i, 1)),
    });
  const add = (kind: Condition["kind"]) =>
    updateRule(rule.id, (r) => void (r.conditions as Condition[]).push(newCondition(kind, { firstTag: tags[0]?.id, firstSpace: userSpaces[0]?.id ?? "root" })));

  return (
    <div className="stack-v">
      {rule.conditions.length === 0 && <p className="muted">No conditions yet — a rule without conditions never applies.</p>}
      {(rule.conditions as Condition[]).map((c, i) => (
        <div key={i} className="condition-row">
          <span className="badge">{kinds.find(([k]) => k === c.kind)?.[1] ?? c.kind}</span>
          {c.kind === "finished" && (
            <select className="select" value={String(c.value)} onChange={(e) => setCond(i, { kind: "finished", value: e.target.value === "true" })}>
              <option value="true">is finished</option>
              <option value="false">is not finished</option>
            </select>
          )}
          {c.kind === "tag" && (
            <>
              <select
                className="select"
                value={c.operator}
                onChange={(e) => {
                  const op = e.target.value as "has" | "does_not_have" | "has_any" | "has_none";
                  setCond(i, op === "has" || op === "does_not_have" ? { kind: "tag", operator: op, tagId: ("tagId" in c && c.tagId) || tags[0]?.id || "" } : { kind: "tag", operator: op });
                }}
              >
                <option value="has">has tag</option>
                <option value="does_not_have">does not have tag</option>
                <option value="has_any">has any tag</option>
                <option value="has_none">has no tag</option>
              </select>
              {(c.operator === "has" || c.operator === "does_not_have") && (
                <select className="select" value={c.tagId} onChange={(e) => setCond(i, { ...c, tagId: e.target.value })}>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {c.kind === "text" && (
            <>
              <select className="select" value={c.operator} onChange={(e) => setCond(i, { ...c, operator: e.target.value as TextOperator })}>
                {TEXT_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {TEXT_OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {c.operator !== "is_empty" && c.operator !== "is_not_empty" && (
                <input className="input grow" value={c.value ?? ""} placeholder="value" onChange={(e) => setCond(i, { ...c, value: e.target.value })} />
              )}
            </>
          )}
          {c.kind === "space" && (
            <>
              <select className="select" value={c.operator} onChange={(e) => setCond(i, { ...c, operator: e.target.value as "is_in_space" | "is_not_in_space" })}>
                <option value="is_in_space">is in space</option>
                <option value="is_not_in_space">is not in space</option>
              </select>
              <select className="select" value={c.spaceId} onChange={(e) => setCond(i, { ...c, spaceId: e.target.value })}>
                {userSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {c.kind === "scheduleDate" && (
            <select className="select" value={c.operator} onChange={(e) => setCond(i, { ...c, operator: e.target.value as ScheduleOperator })}>
              {SCHEDULE_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {SCHEDULE_LABEL[op]}
                </option>
              ))}
            </select>
          )}
          {c.kind === "number" && (
            <>
              <select className="select" value={c.field} onChange={(e) => setCond(i, { ...c, field: e.target.value as NumberField })}>
                {NUMBER_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABEL[f]}
                  </option>
                ))}
              </select>
              <select className="select" value={c.operator} onChange={(e) => setCond(i, { ...c, operator: e.target.value as NumberOperator })}>
                {NUMBER_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {NUM_OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {c.operator === "between" || c.operator === "not_between" ? (
                <>
                  <input className="input" type="number" style={{ width: 70 }} value={c.min ?? 0} onChange={(e) => setCond(i, { ...c, min: Number(e.target.value) })} />
                  <span className="muted">and</span>
                  <input className="input" type="number" style={{ width: 70 }} value={c.max ?? 0} onChange={(e) => setCond(i, { ...c, max: Number(e.target.value) })} />
                </>
              ) : (
                <input className="input" type="number" style={{ width: 80 }} value={c.value ?? 0} onChange={(e) => setCond(i, { ...c, value: Number(e.target.value) })} />
              )}
            </>
          )}
          <span className="grow" />
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Duplicate condition" onClick={() => updateRule(rule.id, (r) => void (r.conditions as Condition[]).splice(i + 1, 0, structuredClone(c)))}>
            <CopyPlus size={13} />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Delete condition" onClick={() => remove(i)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="row">
        <span className="muted">Add condition:</span>
        {kinds.map(([k, label]) => (
          <button key={k} className="btn btn-sm" onClick={() => add(k)}>
            <Plus size={12} /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StyleEditor({ rule }: { rule: FormatRule }) {
  const up = (fn: (r: FormatRule) => void) => updateRule(rule.id, fn);
  const st = rule.style;
  const cls = [st.bold && "is-bold", st.italic && "is-italic", st.strikethrough && "is-strike", st.textColor && st.textColor !== "default" && `has-color c-${st.textColor}`].filter(Boolean).join(" ");
  return (
    <div className="stack-v">
      {(["bold", "italic", "strikethrough"] as const).map((k) => (
        <label key={k} className="field-inline">
          <span>{k === "bold" ? "Bold" : k === "italic" ? "Italic" : "Strikethrough"}</span>
          <input type="checkbox" className="switch" checked={!!st[k]} onChange={(e) => up((r) => void (r.style[k] = e.target.checked || undefined))} />
        </label>
      ))}
      <div className="field">
        <span className="field-label">Text color</span>
        <ColorPicker value={st.textColor ?? "default"} onChange={(c) => up((r) => void (r.style.textColor = c === "default" ? undefined : c))} />
        <span className="field-hint">Default keeps the item text color. An item's own color always wins.</span>
      </div>
      <div className="field">
        <span className="field-label">Accent color</span>
        <ColorPicker value={st.accentColor ?? "default"} onChange={(c) => up((r) => void (r.style.accentColor = c === "default" ? undefined : c))} />
        <span className="field-hint">Colors checkboxes, folder icons, progress and separators.</span>
      </div>
      <div className={`style-preview ${st.accentColor && st.accentColor !== "default" ? `c-${st.accentColor}` : ""}`}>
        <span className={`checkbox ${st.accentColor ? "has-color" : ""}`} />
        <span className={`item-text ${cls}`}>Preview of a {rule.kind === "taskRule" ? "task" : "folder"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const WEEKDAYS: [Weekday, string][] = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function RecurrenceTab({ initial }: { initial?: string }) {
  const rules = useApp((s) => s.doc?.config.recurrenceRules ?? []);
  const sorted = sortRules(rules);
  const [selected, setSelected] = useState<string | undefined>(initial ?? sorted[0]?.id);
  const rule = rules.find((r) => r.id === selected) ?? sorted[0];
  const row = (r: RecurrenceRule) => (
    <div key={r.id} className={`rule-row ${rule?.id === r.id ? "is-active" : ""}`} onClick={() => setSelected(r.id)}>
      <input
        type="checkbox"
        className="switch"
        checked={r.enabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => updateRecurrenceRule(r.id, (d) => void (d.enabled = e.target.checked))}
        aria-label="Active"
        title={r.enabled ? "Active — click to archive" : "Archived — click to activate"}
      />
      <span className="grow ellipsis">{r.name}</span>
    </div>
  );
  const active = sorted.filter((r) => r.enabled);
  const archived = sorted.filter((r) => !r.enabled);
  return (
    <div className="split-pane">
      <div className="split-list">
        <div className="settings-subhead">Active</div>
        {active.map(row)}
        {active.length === 0 && <p className="muted small">No active rules.</p>}
        {archived.length > 0 && <div className="settings-subhead">Archived</div>}
        {archived.map(row)}
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setSelected(createRecurrenceRule() ?? undefined)}>
          <Plus size={13} /> New rule
        </button>
      </div>
      <div className="split-detail">
        {rule ? (
          <RecurrenceEditor key={rule.id} rule={rule} onDeleted={() => setSelected(undefined)} onSelect={setSelected} />
        ) : (
          <div className="stack-v">
            <p className="muted">
              Recurrence rules copy the contents of template items onto matching calendar days when a day is prepared (from the day menu, the
              command palette, or <code>cascade prepare-calendar</code>).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RecurrenceEditor({ rule, onDeleted, onSelect }: { rule: RecurrenceRule; onDeleted: () => void; onSelect: (id: string) => void }) {
  const [picking, setPicking] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [previewMonth, setPreviewMonth] = useState(today());
  const weekStartsOnPref = useApp((s) => s.prefs.weekStartsOn);
  const doc = useApp((s) => s.doc);
  const ix = indexOf(doc);
  const templates = templateItems(doc);
  const up = (fn: (r: RecurrenceRule) => void) => updateRecurrenceRule(rule.id, fn);
  const r = rule.recurrence;
  const t = today();
  const next: string[] = [];
  for (let i = 0, d = t; i < 400 && next.length < 5; i++, d = addDays(t, i)) if (recurrenceMatches(r, d)) next.push(d);

  const setFrequency = (f: "daily" | "weekly" | "monthly") =>
    up((x) => {
      const base = { startDate: x.recurrence.startDate, endDate: x.recurrence.endDate ?? null, interval: x.recurrence.interval };
      x.recurrence =
        f === "daily"
          ? { ...base, frequency: "daily" }
          : f === "weekly"
            ? { ...base, frequency: "weekly", weekdays: [1], weekStartsOn: "monday" }
            : { ...base, frequency: "monthly", mode: "day", day: Number(base.startDate.slice(8)) };
    });

  return (
    <div className="stack-v">
      <div className="row">
        <input className="input grow" value={rule.name} onChange={(e) => up((x) => void (x.name = e.target.value))} aria-label="Rule name" />
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" onClick={() => moveRecurrenceRule(rule.id, -1)}>
          <ArrowUp size={14} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" onClick={() => moveRecurrenceRule(rule.id, 1)}>
          <ArrowDown size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Delete rule"
          onClick={() => confirmAction({ title: `Delete “${rule.name}”?`, message: "Templates are kept; only the rule is removed.", confirmLabel: "Delete", danger: true, onConfirm: () => { deleteRecurrenceRule(rule.id); onDeleted(); } })}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="field">
        <span className="field-label">Repeats</span>
        <div className="row">
          <div className="segmented">
            {(["daily", "weekly", "monthly"] as const).map((f) => (
              <button key={f} aria-pressed={r.frequency === f} onClick={() => setFrequency(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <span className="muted">every</span>
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            style={{ width: 70 }}
            value={r.interval}
            onChange={(e) => up((x) => void (x.recurrence.interval = Math.max(1, Number(e.target.value) || 1)))}
          />
          <span className="muted">{r.frequency === "daily" ? "day(s)" : r.frequency === "weekly" ? "week(s)" : "month(s)"}</span>
        </div>
      </div>
      {r.frequency === "weekly" && (
        <div className="field">
          <span className="field-label">On</span>
          <div className="row">
            {WEEKDAYS.map(([d, label]) => (
              <button
                key={d}
                className={`filter-chip ${r.weekdays.includes(d) ? "is-on" : ""}`}
                onClick={() =>
                  up((x) => {
                    if (x.recurrence.frequency !== "weekly") return;
                    const set = new Set(x.recurrence.weekdays);
                    if (set.has(d)) set.delete(d);
                    else set.add(d);
                    x.recurrence.weekdays = [...set].sort() as Weekday[];
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {r.frequency === "weekly" && (
        <div className="field">
          <span className="field-label">Week starts on</span>
          <div className="segmented">
            {(["monday", "sunday"] as const).map((w) => (
              <button key={w} aria-pressed={r.weekStartsOn === w} onClick={() => up((x) => void (x.recurrence.frequency === "weekly" && (x.recurrence.weekStartsOn = w)))}>
                {w === "monday" ? "Monday" : "Sunday"}
              </button>
            ))}
          </div>
          <span className="field-hint">Matters for rules that repeat every 2+ weeks.</span>
        </div>
      )}
      {r.frequency === "monthly" && (
        <div className="field">
          <span className="field-label">On</span>
          <div className="row">
            <select
              className="select"
              value={r.mode}
              onChange={(e) =>
                up((x) => {
                  const base = { startDate: x.recurrence.startDate, endDate: x.recurrence.endDate ?? null, interval: x.recurrence.interval };
                  const mode = e.target.value;
                  x.recurrence =
                    mode === "day"
                      ? { ...base, frequency: "monthly", mode: "day", day: 1 }
                      : mode === "weekday"
                        ? { ...base, frequency: "monthly", mode: "weekday", weekday: 1, ordinal: 1 }
                        : { ...base, frequency: "monthly", mode: "last-day" };
                })
              }
            >
              <option value="day">a day of the month</option>
              <option value="weekday">a weekday of the month</option>
              <option value="last-day">the last day</option>
            </select>
            {r.mode === "day" && (
              <input
                className="input"
                type="number"
                min={1}
                max={31}
                style={{ width: 70 }}
                value={r.day}
                onChange={(e) => up((x) => void (x.recurrence.frequency === "monthly" && x.recurrence.mode === "day" && (x.recurrence.day = Math.min(31, Math.max(1, Number(e.target.value) || 1)))))}
              />
            )}
            {r.mode === "weekday" && (
              <>
                <select
                  className="select"
                  value={r.ordinal}
                  onChange={(e) => up((x) => void (x.recurrence.frequency === "monthly" && x.recurrence.mode === "weekday" && (x.recurrence.ordinal = Number(e.target.value) as -1 | 1 | 2 | 3 | 4 | 5)))}
                >
                  <option value={1}>first</option>
                  <option value={2}>second</option>
                  <option value={3}>third</option>
                  <option value={4}>fourth</option>
                  <option value={5}>fifth</option>
                  <option value={-1}>last</option>
                </select>
                <select
                  className="select"
                  value={r.weekday}
                  onChange={(e) => up((x) => void (x.recurrence.frequency === "monthly" && x.recurrence.mode === "weekday" && (x.recurrence.weekday = Number(e.target.value) as Weekday)))}
                >
                  {WEEKDAY_NAMES.map((n, i) => (
                    <option key={n} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}
      <div className="row">
        <label className="field">
          <span className="field-label">Starts</span>
          <input className="input" type="date" value={r.startDate} onChange={(e) => e.target.value && up((x) => void (x.recurrence.startDate = e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">Ends (optional)</span>
          <input
            className="input"
            type="date"
            value={r.endDate ?? ""}
            min={r.startDate}
            onChange={(e) => up((x) => void (x.recurrence.endDate = e.target.value || null))}
          />
        </label>
      </div>
      <div className="field">
        <span className="field-label">Templates to prepare, in order</span>
        {rule.templates.length === 0 && <span className="field-hint">No templates yet. Their contents are copied onto matching days, in this order.</span>}
        <div className="settings-list">
          {rule.templates.map((id, i) => {
            const tp = ix.items[id];
            return (
              <div key={`${id}-${i}`} className="settings-row template-occurrence">
                <span className="faint small">{i + 1}.</span>
                {tp && tp.type === "template" ? (
                  <span className="grow ellipsis">
                    <Icon name={tp.icon} size={13} /> {tp.text || "Untitled template"} <span className="faint">{breadcrumb(ix, tp.id).join(" › ")}</span>
                  </span>
                ) : (
                  <span className="grow ellipsis warning-text">
                    <AlertTriangle size={13} /> Missing template
                  </span>
                )}
                <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => up((x) => void x.templates.splice(i - 1, 0, x.templates.splice(i, 1)[0]))}>
                  <ArrowUp size={13} />
                </button>
                <button className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" disabled={i === rule.templates.length - 1} onClick={() => up((x) => void x.templates.splice(i + 1, 0, x.templates.splice(i, 1)[0]))}>
                  <ArrowDown size={13} />
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label="Remove template"
                  onClick={() =>
                    confirmAction({
                      title: `Remove template occurrence ${i + 1}?`,
                      message: "The template itself is kept; it just won't be prepared by this rule at this position.",
                      confirmLabel: "Remove",
                      danger: true,
                      onConfirm: () => up((x) => void x.templates.splice(i, 1)),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
        {picking ? (
          <TemplatePicker
            onPick={(id) => {
              up((x) => void x.templates.push(id));
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setPicking(true)} disabled={templates.length === 0} title={templates.length ? undefined : "Turn a folder into a template first (Type ▸ Template)"}>
            <Plus size={13} /> Add template
          </button>
        )}
      </div>
      <div className="row">
        <button className="btn btn-sm" onClick={() => setShowSchedule((v) => !v)}>
          <CalendarDays size={13} /> {showSchedule ? "Hide schedule" : "Preview schedule"}
        </button>
        <button className="btn btn-sm" onClick={() => { const id = duplicateRecurrenceRule(rule.id); if (id) onSelect(id); }}>
          <CopyPlus size={13} /> Duplicate rule
        </button>
      </div>
      {showSchedule && (
        <div className="schedule-preview">
          <MonthGrid
            month={previewMonth}
            today={t}
            weekStartsOn={weekStartsOnPref}
            inRange={(d) => recurrenceMatches(r, d)}
            onSelect={() => {}}
            onMonthChange={setPreviewMonth}
          />
        </div>
      )}
      <div className="recurrence-summary">
        <div>{describeRecurrence(r)}</div>
        <div className="mono faint small">RRULE:{toRRule(r)}</div>
        <div className="muted small">Next: {next.length ? next.map((d) => formatLongDay(d)).join(" · ") : "none in the next year"}</div>
      </div>
    </div>
  );
}

/** Searchable picker of template items in active spaces (excludes archived spaces and Trash). */
function TemplatePicker({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const doc = useApp((s) => s.doc);
  const ix = indexOf(doc);
  const [q, setQ] = useState("");
  const archived = new Set((doc?.config.spaces ?? []).filter((sp) => sp.archived).map((sp) => sp.id));
  const list = templateItems(doc)
    .filter((tp) => {
      const sp = spaceOf(ix, tp.id);
      return sp !== TRASH_SPACE_ID && !(sp && archived.has(sp));
    })
    .filter((tp) => !q.trim() || tp.text.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="template-picker">
      <div className="row">
        <input className="input grow" autoFocus placeholder="Select template…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())} />
        <button className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <span className="field-hint">Templates in active spaces · Excludes archived spaces and Trash</span>
      <div className="settings-list">
        {list.map((tp) => (
          <button key={tp.id} className="template-row" onClick={() => onPick(tp.id)}>
            <strong>
              <Icon name={tp.icon} size={13} /> {tp.text || "Untitled template"}
            </strong>
            <span className="faint">{breadcrumb(ix, tp.id).join(" › ")}</span>
            <span className="muted">{ix.children.get(tp.id)?.length ?? 0} items</span>
          </button>
        ))}
        {list.length === 0 && <p className="muted small">No matching templates.</p>}
      </div>
    </div>
  );
}

function tagUseCount(tagId: string): number {
  return Object.values(get().doc?.items ?? {}).filter((i) => i.tags.includes(tagId)).length;
}

function spaceItemCount(spaceId: string): number {
  const ix = indexOf(get().doc);
  return Object.values(ix.items).filter((i) => spaceOf(ix, i.id) === spaceId).length;
}
