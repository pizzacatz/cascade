import type { Doc, DocConfig, FormatRule, Item, ItemType, Space, ViewState } from "./types";
import { ROOT_SPACE_ID, TRASH_SPACE_ID } from "./types";
import { todayKey } from "./dates";
import { compareKeys, keyBetween } from "./order";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random 24-character id, similar in shape to ids in existing documents. */
export function newId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export const nowIso = () => new Date().toISOString();

export function defaultSpaces(): Space[] {
  return [
    { id: ROOT_SPACE_ID, icon: "home", color: "default", name: "Home", position: "a", archived: false },
    { id: TRASH_SPACE_ID, icon: "trash", color: "default", name: "Trash", position: "b", archived: false },
  ];
}

export function finishedTasksRule(): FormatRule {
  return {
    id: newId(),
    name: "Finished tasks",
    enabled: true,
    priority: "a0",
    kind: "taskRule",
    logic: "all",
    conditions: [{ kind: "finished", value: true }],
    style: { strikethrough: true, textColor: "gray" },
  };
}

export function overdueTasksRule(priority = "a1"): FormatRule {
  return {
    id: newId(),
    name: "Overdue tasks",
    enabled: true,
    priority,
    kind: "taskRule",
    logic: "all",
    conditions: [{ kind: "scheduleDate", operator: "is_overdue" }],
    style: { textColor: "red" },
  };
}

/** Sits above "Finished tasks" so its colour wins (canceled tasks are also finished). */
export function canceledTasksRule(priority = keyBetween(null, "a0")): FormatRule {
  return {
    id: newId(),
    name: "Canceled tasks",
    enabled: true,
    priority,
    kind: "taskRule",
    logic: "all",
    conditions: [{ kind: "canceled", value: true }],
    style: { strikethrough: true, textColor: "red" },
  };
}

/** Config key recording which built-in rules a document has already been given. */
export const BUILTIN_RULES_KEY = "cascadeBuiltinRules";
const BUILTIN_RULES = ["overdue", "canceled"] as const;

/**
 * Give a document the built-in "Overdue tasks" and "Canceled tasks" rules once.
 * A rule the user later deletes is not re-added (the document remembers it was
 * offered), and a document that already has an equivalent rule is left alone.
 * Returns true when the config changed.
 */
export function ensureBuiltinRules(config: DocConfig): boolean {
  const extra = config.extra ?? {};
  const raw = extra[BUILTIN_RULES_KEY];
  const offered = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  const missing = BUILTIN_RULES.filter((k) => !offered.has(k));
  if (!missing.length) return false;
  const rules = config.conditionalFormatting;
  const has = (pred: (c: { kind: string; operator?: string }) => boolean) =>
    rules.some((r) => (r.conditions as { kind: string; operator?: string }[]).some(pred));
  const sorted = rules.map((r) => r.priority).sort(compareKeys);
  for (const k of missing) {
    if (k === "overdue" && !has((c) => c.kind === "scheduleDate" && c.operator === "is_overdue")) {
      rules.push(overdueTasksRule(keyBetween(sorted.at(-1) ?? null, null)));
    }
    if (k === "canceled" && !has((c) => c.kind === "canceled")) {
      rules.push(canceledTasksRule(keyBetween(null, sorted[0] ?? null)));
    }
    offered.add(k);
  }
  config.extra = { ...extra, [BUILTIN_RULES_KEY]: [...offered].sort() };
  return true;
}

export function defaultViewState(): ViewState {
  return {
    focusedView: "columns",
    showColumnsView: true,
    showCalendarView: false,
    showCalendarDayPicker: false,
    columnsSelection: [],
    columnsPath: [],
    calendarSelection: [],
    calendarCurrentDate: todayKey(),
    currentSpaceId: ROOT_SPACE_ID,
  };
}

export function defaultConfig(): DocConfig {
  const config: DocConfig = {
    recurrenceRules: [],
    preparedDays: [],
    progressionMode: "by_level",
    spaces: defaultSpaces(),
    tags: [],
    conditionalFormatting: [finishedTasksRule()],
    viewState: defaultViewState(),
  };
  ensureBuiltinRules(config);
  return config;
}

export function emptyDoc(): Doc {
  return { items: {}, config: defaultConfig() };
}

export function makeItem(type: ItemType, fields: Partial<Item> = {}): Item {
  const now = nowIso();
  return {
    id: newId(),
    type,
    parentId: null,
    position: null,
    scheduleDate: null,
    schedulePosition: null,
    text: "",
    finished: false,
    finishedAt: null,
    color: "default",
    icon: type === "template" ? "folder-bookmark" : null,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}
