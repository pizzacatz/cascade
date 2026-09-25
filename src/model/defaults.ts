import type { Doc, DocConfig, FormatRule, Item, ItemType, Space, ViewState } from "./types";
import { ROOT_SPACE_ID, TRASH_SPACE_ID } from "./types";
import { todayKey } from "./dates";

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
  return {
    recurrenceRules: [],
    preparedDays: [],
    progressionMode: "by_level",
    spaces: defaultSpaces(),
    tags: [],
    conditionalFormatting: [finishedTasksRule()],
    viewState: defaultViewState(),
  };
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
