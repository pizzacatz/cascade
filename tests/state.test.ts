import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc, makeItem } from "../src/model/defaults";
import { buildIndex, childrenOf } from "../src/model/tree";
import { todayKey } from "../src/model/dates";
import { get, set, undo, redo } from "../src/state/store";
import { enterEdit, navigateRight, navigateVertical, selectColumnItem, selectColumnItems } from "../src/state/nav";
import {
  addItem,
  createFromEdit,
  createInCurrentColumn,
  createSibling,
  exitEdit,
  createAtTarget,
  deleteSelection,
  duplicateSelection,
  emptyTrash,
  indentSelection,
  moveSelection,
  toggleFinished,
  unindentSelection,
  changeType,
  canChangeType,
  sortColumn,
} from "../src/state/items";
import { createSpace, deleteSpace, createTag, deleteTag, prepareDay } from "../src/state/config";
import type { Doc } from "../src/model/types";

function load(doc: Doc) {
  set({ doc, filePath: "test.col", past: [], future: [], edit: null, createTarget: null, overlay: null, view: doc.config.viewState! });
}

function names(parentId: string): string[] {
  return childrenOf(buildIndex(get().doc!), parentId).map((i) => i.text);
}

beforeEach(() => {
  const doc = emptyDoc();
  const add = (id: string, type: "task" | "folder", parentId: string, position: string, text = id) =>
    (doc.items[id] = makeItem(type, { id, parentId, position, text }));
  add("F", "folder", "root", "a0");
  add("a", "task", "F", "a0");
  add("b", "task", "F", "a1");
  add("c", "task", "F", "a2");
  load(doc);
});

describe("item operations", () => {
  it("creates siblings and children in order", () => {
    selectColumnItem("a");
    const id = addItem("task", { view: "columns", parentId: "F", afterId: "a" }, { text: "new" }, false);
    expect(id).toBeTruthy();
    expect(names("F")).toEqual(["a", "new", "b", "c"]);
    // Creating under a task turns it into a folder.
    addItem("task", { view: "columns", parentId: "b" }, { text: "child" }, false);
    expect(get().doc!.items.b.type).toBe("folder");
    expect(names("b")).toEqual(["child"]);
  });

  it("reorders with move up/down/first/last", () => {
    selectColumnItem("c");
    moveSelection("up");
    expect(names("F")).toEqual(["a", "c", "b"]);
    moveSelection("first");
    expect(names("F")).toEqual(["c", "a", "b"]);
    selectColumnItems(["c", "a"]);
    moveSelection("last");
    expect(names("F")).toEqual(["b", "c", "a"]);
  });

  it("indents into the previous sibling and unindents back", () => {
    selectColumnItem("b");
    indentSelection();
    const d = get().doc!;
    expect(d.items.b.parentId).toBe("a");
    expect(d.items.a.type).toBe("folder");
    unindentSelection();
    expect(get().doc!.items.b.parentId).toBe("F");
    expect(names("F")).toEqual(["a", "b", "c"]);
  });

  it("deletes to Trash, then permanently, with undo/redo", () => {
    selectColumnItem("b");
    deleteSelection();
    expect(get().doc!.items.b.parentId).toBe("trash");
    expect(get().view.columnsSelection).toEqual(["c"]);
    undo();
    expect(get().doc!.items.b.parentId).toBe("F");
    redo();
    expect(get().doc!.items.b.parentId).toBe("trash");
    emptyTrash();
    expect(get().doc!.items.b).toBeUndefined();
  });

  it("toggles finished for tasks only", () => {
    selectColumnItems(["a", "b"]);
    toggleFinished();
    expect(get().doc!.items.a.finished).toBe(true);
    expect(get().doc!.items.a.finishedAt).toBeTruthy();
    toggleFinished();
    expect(get().doc!.items.b.finished).toBe(false);
  });

  it("duplicates with subtrees", () => {
    selectColumnItem("F");
    duplicateSelection();
    const root = childrenOf(buildIndex(get().doc!), "root");
    expect(root).toHaveLength(2);
    expect(names(root[1].id)).toEqual(["a", "b", "c"]);
  });

  it("refuses to turn a folder with children into a leaf", () => {
    expect(canChangeType(["F"], "task", "columns")).toBe(false);
    selectColumnItem("a");
    changeType("heading");
    expect(get().doc!.items.a.type).toBe("heading");
  });

  it("sorts a column", () => {
    const d = get().doc!;
    set({ doc: { ...d, items: { ...d.items, a: { ...d.items.a, text: "zeta" }, c: { ...d.items.c, text: "alpha" } } } });
    sortColumn({ parentId: "F" }, "alphabetical");
    expect(names("F")).toEqual(["alpha", "b", "zeta"]);
  });
});

describe("Colonnes-style creation", () => {
  it("Shift+Enter inserts after the first selected item", () => {
    selectColumnItems(["a", "c"]);
    createSibling();
    expect(names("F")).toEqual(["a", "", "b", "c"]);
  });

  it("Enter with nothing selected adds to the bottom of the space root", () => {
    set({ view: { ...get().view, columnsSelection: [], columnsPath: ["F"] } });
    createInCurrentColumn();
    expect(names("root")).toEqual(["F", ""]);
  });

  it("Enter while editing keeps an empty item and creates the next one", () => {
    selectColumnItem("a");
    addItem("task", { view: "columns", parentId: "F", afterId: "a" });
    createFromEdit("sibling");
    expect(names("F")).toEqual(["a", "", "", "b", "c"]);
  });

  it("down from the last item focuses the column's create row; right on a task focuses the convert button", () => {
    selectColumnItem("c");
    navigateVertical(1);
    expect(get().createTarget).toEqual({ view: "columns", parentId: "F" });
    selectColumnItem("b");
    navigateRight();
    expect(get().createTarget).toEqual({ view: "columns", parentId: "b" });
    createAtTarget(get().createTarget!);
    expect(get().doc!.items.b.type).toBe("folder");
    expect(get().edit).not.toBeNull();
  });

  it("keeps a blank task when it is the only item of a folder just made from a task", () => {
    selectColumnItem("b");
    createAtTarget({ view: "columns", parentId: "b" });
    exitEdit();
    const d = get().doc!;
    expect(d.items.b.type).toBe("folder");
    const kids = childrenOf(buildIndex(d), "b");
    expect(kids).toHaveLength(1);
    expect(kids[0].type).toBe("task");
    expect(kids[0].text).toBe("");
  });

  it("removing an empty new item selects the previous sibling, else its create row", () => {
    selectColumnItem("b");
    createSibling();
    exitEdit();
    expect(get().view.columnsSelection).toEqual(["b"]);
    // In a folder that already has items, an empty new item is removed and
    // selection falls back to the item above it.
    const id = createAtTarget({ view: "columns", parentId: "F" })!;
    enterEdit(id);
    exitEdit();
    expect(get().doc!.items[id]).toBeUndefined();
    expect(get().view.columnsSelection).toEqual(["c"]);
  });
});

describe("configuration operations", () => {
  it("deletes a space into Trash and strips its rule conditions", () => {
    const id = createSpace("Work")!;
    addItem("task", { view: "columns", parentId: id }, { text: "w" }, false);
    const d = get().doc!;
    set({
      doc: {
        ...d,
        config: {
          ...d.config,
          conditionalFormatting: [
            { ...d.config.conditionalFormatting[0], conditions: [{ kind: "space", operator: "is_in_space", spaceId: id }] },
          ],
        },
      },
    });
    deleteSpace(id);
    const after = get().doc!;
    expect(after.config.spaces.some((s) => s.id === id)).toBe(false);
    expect(names("trash")).toEqual(["w"]);
    expect(after.config.conditionalFormatting[0].conditions).toEqual([]);
  });

  it("deleting a tag removes it from items", () => {
    const tag = createTag("Urgent")!;
    const d = get().doc!;
    set({ doc: { ...d, items: { ...d.items, a: { ...d.items.a, tags: [tag] } } } });
    deleteTag(tag);
    expect(get().doc!.items.a.tags).toEqual([]);
  });

  it("prepares recurring templates onto a day once", () => {
    const today = todayKey();
    const d = get().doc!;
    const tpl = makeItem("template", { id: "T", parentId: "root", position: "a1", text: "Morning" });
    const step = makeItem("task", { id: "T1", parentId: "T", position: "a0", text: "Stretch" });
    set({
      doc: {
        ...d,
        items: { ...d.items, T: tpl, T1: step },
        config: {
          ...d.config,
          recurrenceRules: [
            {
              id: "r",
              name: "Daily",
              enabled: true,
              priority: "a0",
              recurrence: { frequency: "daily", startDate: today, endDate: null, interval: 1 },
              templates: ["T"],
            },
          ],
        },
      },
    });
    const r = prepareDay(today);
    expect(r.status).toBe("prepared");
    expect(r.createdCount).toBe(1);
    const onDay = Object.values(get().doc!.items).filter((i) => i.scheduleDate === today);
    expect(onDay.map((i) => i.text)).toEqual(["Stretch"]);
    expect(prepareDay(today).status).toBe("already_prepared");
    expect(prepareDay("2000-01-01").status).toBe("error");
  });
});
