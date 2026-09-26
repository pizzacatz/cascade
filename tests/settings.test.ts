import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc } from "../src/model/defaults";
import { sortSpaces } from "../src/model/tree";
import { sortRules } from "../src/model/formatting";
import { TREE_SPACE_ID } from "../src/model/types";
import { get, set, undo } from "../src/state/store";
import { createSpace, createTag, duplicateSpace, duplicateTag, placeSpace, placeTag } from "../src/state/config";
import { relativeTime } from "../src/ui/DocumentsDialog";

beforeEach(() => {
  const doc = emptyDoc();
  set({ doc, filePath: "test.col", past: [], future: [], edit: null, createTarget: null, overlay: null, view: doc.config.viewState! });
});

const spaceNames = () =>
  sortSpaces(get().doc!.config.spaces)
    .filter((s) => !s.archived && s.id !== TREE_SPACE_ID)
    .map((s) => s.name);
const tagNames = () => sortRules(get().doc!.config.tags).map((t) => t.name);

describe("settings list reordering", () => {
  it("places a space at a list index (drag-to-reorder) and undoes it", () => {
    createSpace("A");
    createSpace("B");
    createSpace("C");
    const before = spaceNames();
    expect(before.slice(-4)).toEqual(["A", "B", "C", "Trash"]);
    const c = get().doc!.config.spaces.find((s) => s.name === "C")!;
    // Drop C before A (index of A in the visible list).
    placeSpace(c.id, before.indexOf("A"));
    expect(spaceNames().slice(-4)).toEqual(["C", "A", "B", "Trash"]);
    undo();
    expect(spaceNames()).toEqual(before);
    // Dropping at the end of the list puts it last.
    const a = get().doc!.config.spaces.find((s) => s.name === "A")!;
    placeSpace(a.id, before.length);
    expect(spaceNames().at(-1)).toBe("A");
  });

  it("dropping an item onto its own slot changes nothing", () => {
    createSpace("A");
    createSpace("B");
    const list = spaceNames();
    const a = get().doc!.config.spaces.find((s) => s.name === "A")!;
    const pastBefore = get().past.length;
    placeSpace(a.id, list.indexOf("A"));
    placeSpace(a.id, list.indexOf("A") + 1);
    expect(get().past.length).toBe(pastBefore);
  });

  it("places and duplicates tags", () => {
    createTag("one");
    createTag("two");
    const three = createTag("three")!;
    placeTag(three, 0);
    expect(tagNames()).toEqual(["three", "one", "two"]);
    const dup = duplicateTag(three)!;
    expect(tagNames()).toEqual(["three", "three copy", "one", "two"]);
    const t = get().doc!.config.tags.find((x) => x.id === dup)!;
    expect(t.color).toBe(get().doc!.config.tags.find((x) => x.id === three)!.color);
  });

  it("creates and duplicates spaces without leaving the settings when asked", () => {
    const current = get().view.currentSpaceId;
    const id = createSpace("Kept", "folder", "default", { open: false })!;
    expect(get().view.currentSpaceId).toBe(current);
    const copy = duplicateSpace(id, { open: false })!;
    expect(get().view.currentSpaceId).toBe(current);
    expect(get().doc!.config.spaces.find((s) => s.id === copy)?.name).toBe("Kept copy");
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 8, 25, 12, 0).getTime();
  it("formats recent times", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 days ago");
    expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/2026/);
  });
});
