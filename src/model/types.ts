// Core document model. The on-disk format is the `.col` JSON document
// (file_version 4); see `format.ts` for the codec. In memory we use a richer,
// normalized shape with full field names.

export const ITEM_TYPES = ["task", "text", "separator", "heading", "folder", "template"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Numeric type codes used by the `t` field on disk. */
export const TYPE_TO_CODE: Record<ItemType, number> = {
  task: 1,
  text: 2,
  separator: 3,
  heading: 4,
  folder: 90,
  template: 91,
};
export const CODE_TO_TYPE: Record<number, ItemType> = Object.fromEntries(
  Object.entries(TYPE_TO_CODE).map(([k, v]) => [v, k as ItemType]),
) as Record<number, ItemType>;

export const COLORS = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export type Color = (typeof COLORS)[number];

export interface Item {
  id: string;
  type: ItemType;
  /** Column placement: a folder/template id or a space id. */
  parentId: string | null;
  position: string | null;
  /** Calendar placement: a YYYY-MM-DD day plus an ordering key. */
  scheduleDate: string | null;
  schedulePosition: string | null;
  text: string;
  finished: boolean;
  finishedAt: string | null;
  color: Color;
  icon: string | null;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Space {
  id: string;
  icon: string;
  color: string;
  name: string;
  position: string;
  archived?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  icon: string;
  color: Color;
  priority: string;
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

export type TagCondition =
  | { kind: "tag"; operator: "has_any" | "has_none" }
  | { kind: "tag"; operator: "has" | "does_not_have"; tagId: string };

export const TEXT_OPERATORS = [
  "is_empty",
  "is_not_empty",
  "equals",
  "not_equals",
  "contains",
  "does_not_contain",
  "starts_with",
  "ends_with",
  "matches_regex",
  "does_not_match_regex",
] as const;
export type TextOperator = (typeof TEXT_OPERATORS)[number];
export interface TextCondition {
  kind: "text";
  operator: TextOperator;
  value?: string;
}

export interface SpaceCondition {
  kind: "space";
  operator: "is_in_space" | "is_not_in_space";
  spaceId: string;
}

export const SCHEDULE_OPERATORS = [
  "has_no_date",
  "has_date",
  "is_overdue",
  "is_not_overdue",
  "today",
  "yesterday",
  "tomorrow",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "next_month",
] as const;
export type ScheduleOperator = (typeof SCHEDULE_OPERATORS)[number];
export interface ScheduleDateCondition {
  kind: "scheduleDate";
  operator: ScheduleOperator;
}

export interface FinishedCondition {
  kind: "finished";
  value: boolean;
}

export const NUMBER_FIELDS = [
  "progression",
  "totalTaskCount",
  "completedTaskCount",
  "incompleteTaskCount",
  "overdueTaskCount",
  "todayTaskCount",
  "futureTaskCount",
  "directOverdueTaskCount",
  "directTodayTaskCount",
  "directFutureTaskCount",
] as const;
export type NumberField = (typeof NUMBER_FIELDS)[number];

export const NUMBER_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "between",
  "not_between",
] as const;
export type NumberOperator = (typeof NUMBER_OPERATORS)[number];
export interface NumberCondition {
  kind: "number";
  field: NumberField;
  operator: NumberOperator;
  value?: number;
  min?: number;
  max?: number;
}

export type TaskCondition =
  | TagCondition
  | TextCondition
  | SpaceCondition
  | ScheduleDateCondition
  | FinishedCondition;
export type FolderCondition = TagCondition | TextCondition | SpaceCondition | NumberCondition;
export type Condition = TaskCondition | FolderCondition;

export interface RuleStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  textColor?: Color | null;
  accentColor?: Color | null;
}

interface RuleBase {
  id: string;
  name: string;
  enabled: boolean;
  priority: string;
  logic: "all" | "any";
  style: RuleStyle;
}
export interface TaskRule extends RuleBase {
  kind: "taskRule";
  conditions: TaskCondition[];
}
export interface FolderRule extends RuleBase {
  kind: "folderRule";
  conditions: FolderCondition[];
}
export type FormatRule = TaskRule | FolderRule;

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type WeekStart = "monday" | "sunday";

interface RecurrenceBase {
  startDate: string;
  endDate?: string | null;
  interval: number;
}
export type Recurrence =
  | (RecurrenceBase & { frequency: "daily" })
  | (RecurrenceBase & { frequency: "weekly"; weekdays: Weekday[]; weekStartsOn: WeekStart })
  | (RecurrenceBase & { frequency: "monthly"; mode: "day"; day: number })
  | (RecurrenceBase & { frequency: "monthly"; mode: "weekday"; weekday: Weekday; ordinal: -1 | 1 | 2 | 3 | 4 | 5 })
  | (RecurrenceBase & { frequency: "monthly"; mode: "last-day" });

export interface RecurrenceRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: string;
  recurrence: Recurrence;
  /** Template item ids whose contents are materialized on matching days. */
  templates: string[];
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type ViewName = "columns" | "calendar";
export type ProgressionMode = "by_level" | "by_task_count";

export interface ViewState {
  focusedView: ViewName;
  showColumnsView: boolean;
  showCalendarView: boolean;
  showCalendarDayPicker: boolean;
  columnsSelection: string[];
  columnsPath: string[];
  calendarSelection: string[];
  calendarCurrentDate?: string;
  currentSpaceId: string;
}

export interface DocConfig {
  recurrenceRules: RecurrenceRule[];
  preparedDays: string[];
  progressionMode: ProgressionMode;
  spaces: Space[];
  tags: Tag[];
  conditionalFormatting: FormatRule[];
  viewState?: ViewState;
  /** Unknown configuration keys, preserved verbatim for forward compatibility. */
  extra?: Record<string, unknown>;
}

export interface Doc {
  /** Items keyed by id. Insertion order is preserved when serializing. */
  items: Record<string, Item>;
  config: DocConfig;
}

export const ROOT_SPACE_ID = "root";
export const TRASH_SPACE_ID = "trash";
export const TREE_SPACE_ID = "tree";
export const SYSTEM_SPACE_IDS = new Set([ROOT_SPACE_ID, TRASH_SPACE_ID, TREE_SPACE_ID]);

export const isContainerType = (t: ItemType) => t === "folder" || t === "template";
/** Tags are only allowed on real content types. */
export const isTaggableType = (t: ItemType) => t === "task" || t === "folder" || t === "template";
export const isEditableType = (t: ItemType) => t !== "separator";
/** What happens when something is dropped into / created under an item. */
export function childPolicy(t: ItemType): "accept" | "convert-to-folder" | "blocked" {
  if (isContainerType(t)) return "accept";
  if (t === "separator") return "blocked";
  return "convert-to-folder";
}
