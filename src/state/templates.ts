// Built-in document templates for "New from template".

import type { Color, Doc, FormatRule, ItemType, RecurrenceRule, Space, Tag } from "../model/types";
import { ROOT_SPACE_ID, TRASH_SPACE_ID } from "../model/types";
import { emptyDoc, finishedTasksRule, makeItem, newId } from "../model/defaults";
import { keysBetween } from "../model/order";
import { todayKey } from "../model/dates";

interface Node {
  t: ItemType;
  text?: string;
  color?: Color;
  tags?: string[];
  icon?: string;
  done?: boolean;
  id?: string;
  children?: Node[];
}

export interface DocTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  build(): Doc;
}

function addNodes(doc: Doc, parentId: string, nodes: Node[]) {
  const keys = keysBetween(null, null, nodes.length);
  nodes.forEach((n, i) => {
    const it = makeItem(n.t, {
      id: n.id ?? newId(),
      parentId,
      position: keys[i],
      text: n.text ?? "",
      color: n.color ?? "default",
      tags: n.tags ?? [],
      finished: !!n.done,
      finishedAt: n.done ? new Date().toISOString() : null,
      // Folders keep the default progress-circle icon; only templates get custom icons.
      ...(n.icon && n.t !== "folder" ? { icon: n.icon } : {}),
    });
    doc.items[it.id] = it;
    if (n.children) addNodes(doc, it.id, n.children);
  });
}

function withSpaces(doc: Doc, extra: Omit<Space, "position">[]) {
  const all = [doc.config.spaces.find((s) => s.id === ROOT_SPACE_ID)!, ...extra, doc.config.spaces.find((s) => s.id === TRASH_SPACE_ID)!];
  const keys = keysBetween(null, null, all.length);
  doc.config.spaces = all.map((s, i) => ({ ...s, position: keys[i], archived: false }));
}

function tags(list: [string, string, Color, string][]): Tag[] {
  const keys = keysBetween(null, null, list.length);
  return list.map(([id, name, color, icon], i) => ({ id, name, color, icon, priority: keys[i] }));
}

function rules(list: Omit<FormatRule, "priority">[]): FormatRule[] {
  const keys = keysBetween(null, null, list.length);
  return list.map((r, i) => ({ ...r, priority: keys[i] }) as FormatRule);
}

const overdueRule = (): Omit<FormatRule, "priority"> => ({
  id: newId(),
  name: "Overdue tasks",
  enabled: true,
  kind: "taskRule",
  logic: "all",
  conditions: [
    { kind: "scheduleDate", operator: "is_overdue" },
    { kind: "finished", value: false },
  ],
  style: { bold: true, textColor: "red" },
});

const tagRule = (name: string, tagId: string, style: FormatRule["style"]): Omit<FormatRule, "priority"> => ({
  id: newId(),
  name,
  enabled: true,
  kind: "taskRule",
  logic: "all",
  conditions: [{ kind: "tag", operator: "has", tagId }],
  style,
});

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "An empty document with a Home space.",
    icon: "file",
    build: () => emptyDoc(),
  },
  {
    id: "getting-started",
    name: "Getting started",
    description: "A short tour of columns, item types and shortcuts.",
    icon: "graduation-cap",
    build() {
      const doc = emptyDoc();
      addNodes(doc, ROOT_SPACE_ID, [
        {
          t: "folder",
          text: "Welcome to Cascade",
          icon: "star",
          children: [
            { t: "heading", text: "Columns" },
            { t: "text", text: "Folders open into a new column to the right. The row of columns is your path." },
            { t: "task", text: "Select this task and press Space to finish it" },
            { t: "task", text: "Press Enter to edit, Shift+Enter for a new item", done: true },
            { t: "task", text: "Ctrl+Enter creates a child (turning the item into a folder)" },
            { t: "separator" },
            { t: "heading", text: "Typing shortcuts" },
            { t: "text", text: "Type # at the start of an item for a heading, --- for a separator, :: for the command menu." },
            {
              t: "folder",
              text: "A nested folder",
              children: [
                { t: "task", text: "Ctrl+→ indents, Ctrl+← unindents" },
                { t: "task", text: "Ctrl+↑/↓ reorders" },
              ],
            },
            { t: "heading", text: "Everything else" },
            { t: "task", text: "Press Ctrl+K for the command palette" },
            { t: "task", text: "Press Tab to show the calendar" },
            { t: "task", text: "Press F1 for context help" },
          ],
        },
      ]);
      return doc;
    },
  },
  {
    id: "personal",
    name: "Personal",
    description: "Home and errands, with Waiting / Quick / Focus tags and overdue highlighting.",
    icon: "house",
    build() {
      const doc = emptyDoc();
      withSpaces(doc, [{ id: "errands", name: "Errands", icon: "cart-shopping", color: "green" }]);
      doc.config.tags = tags([
        ["waiting", "Waiting", "orange", "hourglass"],
        ["quick", "Quick", "green", "bolt"],
        ["focus", "Focus", "purple", "bullseye"],
      ]);
      doc.config.conditionalFormatting = rules([
        { ...finishedTasksRule() },
        overdueRule(),
        tagRule("Waiting", "waiting", { italic: true, textColor: "orange" }),
        tagRule("Focus", "focus", { bold: true, accentColor: "purple" }),
      ]);
      addNodes(doc, ROOT_SPACE_ID, [
        {
          t: "folder",
          text: "House",
          icon: "house",
          children: [
            { t: "task", text: "Fix the leaking tap", tags: ["focus"] },
            { t: "task", text: "Call the plumber back", tags: ["waiting"] },
            { t: "task", text: "Replace hallway bulb", tags: ["quick"] },
          ],
        },
        {
          t: "folder",
          text: "Health",
          icon: "heart",
          children: [
            { t: "task", text: "Book a dentist appointment", tags: ["quick"] },
            { t: "task", text: "Plan three runs this week" },
          ],
        },
        { t: "folder", text: "Someday", icon: "cloud", children: [{ t: "task", text: "Learn to bake bread" }] },
      ]);
      addNodes(doc, "errands", [
        {
          t: "folder",
          text: "Groceries",
          icon: "basket-shopping",
          children: [
            { t: "task", text: "Oat milk" },
            { t: "task", text: "Coffee beans" },
            { t: "task", text: "Apples" },
          ],
        },
        { t: "task", text: "Return the library books" },
      ]);
      return doc;
    },
  },
  {
    id: "projects",
    name: "Projects",
    description: "Work projects with Urgent / Blocked / Delegated tags and a folder progress rule.",
    icon: "briefcase",
    build() {
      const doc = emptyDoc();
      withSpaces(doc, [{ id: "work", name: "Work", icon: "briefcase", color: "blue" }]);
      doc.config.progressionMode = "by_task_count";
      doc.config.tags = tags([
        ["urgent", "Urgent", "red", "fire"],
        ["blocked", "Blocked", "gray", "ban"],
        ["delegated", "Delegated", "yellow", "user"],
      ]);
      doc.config.conditionalFormatting = rules([
        { ...finishedTasksRule() },
        overdueRule(),
        tagRule("Urgent", "urgent", { bold: true, textColor: "red" }),
        tagRule("Blocked", "blocked", { italic: true, textColor: "gray" }),
        tagRule("Delegated", "delegated", { italic: true, accentColor: "yellow" }),
        {
          id: newId(),
          name: "Folders with overdue work",
          enabled: true,
          kind: "folderRule",
          logic: "all",
          conditions: [{ kind: "number", field: "overdueTaskCount", operator: "greater_than", value: 0 }],
          style: { accentColor: "red" },
        },
        {
          id: newId(),
          name: "Completed folders",
          enabled: true,
          kind: "folderRule",
          logic: "all",
          conditions: [{ kind: "number", field: "progression", operator: "equals", value: 100 }],
          style: { textColor: "green" },
        },
      ]);
      addNodes(doc, "work", [
        {
          t: "folder",
          text: "Website relaunch",
          icon: "globe",
          children: [
            { t: "heading", text: "Design" },
            { t: "task", text: "Moodboard", done: true },
            { t: "task", text: "Homepage mock-up", tags: ["urgent"] },
            { t: "heading", text: "Build" },
            { t: "task", text: "Set up hosting", tags: ["delegated"] },
            { t: "task", text: "Migrate blog posts", tags: ["blocked"] },
          ],
        },
        {
          t: "folder",
          text: "Quarterly report",
          icon: "chart-line",
          children: [
            { t: "task", text: "Collect numbers" },
            { t: "task", text: "Draft summary" },
            { t: "task", text: "Review with team" },
          ],
        },
        {
          t: "template",
          text: "New project checklist",
          children: [
            { t: "task", text: "Define goal" },
            { t: "task", text: "List stakeholders" },
            { t: "task", text: "Set first milestone" },
          ],
        },
      ]);
      return doc;
    },
  },
  {
    id: "routine",
    name: "Daily routine",
    description: "Recurring morning and weekly-review templates that prepare onto the calendar.",
    icon: "calendar-check",
    build() {
      const doc = emptyDoc();
      const morning = newId();
      const review = newId();
      addNodes(doc, ROOT_SPACE_ID, [
        {
          t: "folder",
          text: "Routines",
          icon: "repeat",
          children: [
            {
              t: "template",
              id: morning,
              text: "Morning",
              children: [
                { t: "heading", text: "Morning", color: "blue" },
                { t: "task", text: "Review today's calendar" },
                { t: "task", text: "Pick the one thing that matters" },
                { t: "task", text: "Inbox to zero" },
              ],
            },
            {
              t: "template",
              id: review,
              text: "Weekly review",
              children: [
                { t: "heading", text: "Weekly review", color: "purple" },
                { t: "task", text: "Clear finished items" },
                { t: "task", text: "Plan next week" },
              ],
            },
          ],
        },
      ]);
      const start = todayKey();
      const rr: RecurrenceRule[] = [
        {
          id: newId(),
          name: "Weekday mornings",
          enabled: true,
          priority: "a0",
          recurrence: { frequency: "weekly", startDate: start, endDate: null, interval: 1, weekdays: [1, 2, 3, 4, 5], weekStartsOn: "monday" },
          templates: [morning],
        },
        {
          id: newId(),
          name: "Friday review",
          enabled: true,
          priority: "a1",
          recurrence: { frequency: "weekly", startDate: start, endDate: null, interval: 1, weekdays: [5], weekStartsOn: "monday" },
          templates: [review],
        },
      ];
      doc.config.recurrenceRules = rr;
      doc.config.viewState = { ...doc.config.viewState!, showCalendarView: true, showCalendarDayPicker: true };
      return doc;
    },
  },
];
