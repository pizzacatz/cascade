import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc, makeItem } from "../src/model/defaults";
import { buildIndex, itemsOnDay } from "../src/model/tree";
import { addDays, todayKey } from "../src/model/dates";
import { get, set, undo, withoutDateCascade } from "../src/state/store";
import { addItem, descheduleItems, duplicateSelection, moveItemsTo, scheduleItems, moveSelection } from "../src/state/items";
import { selectColumnItem, selectCalendarItem } from "../src/state/nav";
import { overdueItems, rollOverOverdue } from "../src/state/schedule";
import { dateSpan } from "../src/model/schedule";
import type { Doc } from "../src/model/types";

const D1 = "2030-01-10";
const D2 = "2030-01-12";

function load(doc: Doc) {
  set({ doc, filePath: "test.col", past: [], future: [], edit: null, createTarget: null, overlay: null, view: doc.config.viewState! });
}
const item = (id: string) => get().doc!.items[id];
const date = (id: string) => item(id).scheduleDate;
const day = (d: string) => itemsOnDay(buildIndex(get().doc!), d).map((x) => x.id);
const depth = (id: string) => buildIndex(get().doc!).dayDepth.get(id) ?? 0;

beforeEach(() => {
  // F ─ a, b(finished), S ─ s1, s2 ; X (other root task)
  const doc = emptyDoc();
  const add = (id: string, type: "task" | "folder" | "text", parentId: string, position: string, extra = {}) =>
    (doc.items[id] = makeItem(type, { id, parentId, position, text: id, ...extra }));
  add("F", "folder", "root", "a0");
  add("a", "task", "F", "a0");
  add("b", "task", "F", "a1", { finished: true });
  add("S", "folder", "F", "a2");
  add("s1", "task", "S", "a0");
  add("s2", "task", "S", "a1");
  add("note", "text", "F", "a3");
  add("X", "task", "root", "a1");
  load(doc);
});

describe("folder dates", () => {
  it("dating a folder dates its unfinished tasks and sub-folders, grouped under it", () => {
    scheduleItems(["F"], D1);
    expect(date("a")).toBe(D1);
    expect(date("S")).toBe(D1);
    expect(date("s1")).toBe(D1);
    expect(date("b")).toBeNull(); // finished
    expect(date("note")).toBeNull(); // text
    expect(day(D1)).toEqual(["F", "a", "S", "s1", "s2"]);
    expect([depth("F"), depth("a"), depth("S"), depth("s1")]).toEqual([0, 1, 1, 2]);
    // Position order matches the grouped order (what Colonnes would show).
    const keys = day(D1).map((id) => item(id).schedulePosition!);
    expect([...keys].sort()).toEqual(keys);
    // One undo step.
    undo();
    expect(date("F")).toBeNull();
    expect(date("s1")).toBeNull();
  });

  it("moving the folder moves followers but keeps a child's own date", () => {
    scheduleItems(["F"], D1);
    scheduleItems(["s2"], "2030-02-01");
    scheduleItems(["F"], D2);
    expect(date("a")).toBe(D2);
    expect(date("s1")).toBe(D2);
    expect(date("s2")).toBe("2030-02-01");
    expect(day(D1)).toEqual([]);
  });

  it("a child with its own date shields its own children", () => {
    scheduleItems(["F"], D1);
    scheduleItems(["S"], "2030-03-01"); // S moves with s1, s2 (they followed S's old date)
    expect(date("s1")).toBe("2030-03-01");
    scheduleItems(["F"], D2);
    expect(date("S")).toBe("2030-03-01");
    expect(date("s1")).toBe("2030-03-01");
  });

  it("descheduling the folder clears followers", () => {
    scheduleItems(["F"], D1);
    descheduleItems(["F"]);
    expect(date("a")).toBeNull();
    expect(date("s1")).toBeNull();
  });

  it("withoutDateCascade dates only the folder", () => {
    withoutDateCascade(() => scheduleItems(["F"], D1));
    expect(date("F")).toBe(D1);
    expect(date("a")).toBeNull();
  });

  it("new child items take the folder's date", () => {
    scheduleItems(["F"], D1);
    const id = addItem("task", { view: "columns", parentId: "F" }, { text: "new" }, false)!;
    expect(date(id)).toBe(D1);
    // A dated task that becomes a folder passes its date to its first child.
    scheduleItems(["X"], D2);
    const kid = addItem("task", { view: "columns", parentId: "X" }, { text: "kid" }, false)!;
    expect(item("X").type).toBe("folder");
    expect(date(kid)).toBe(D2);
    expect(day(D2)).toEqual(["X", kid]);
  });

  it("moving an undated item into a dated folder dates it; a dated one keeps its date", () => {
    scheduleItems(["S"], D1);
    moveItemsTo(["X"], "S");
    expect(date("X")).toBe(D1);
    scheduleItems(["a"], D2);
    moveItemsTo(["a"], "S");
    expect(date("a")).toBe(D2);
  });

  it("duplicates inside a dated folder take its date", () => {
    scheduleItems(["S"], D1);
    selectColumnItem("s1");
    duplicateSelection();
    const copies = Object.values(get().doc!.items).filter((x) => x.text === "s1" && x.id !== "s1");
    expect(copies).toHaveLength(1);
    expect(copies[0].scheduleDate).toBe(D1);
  });

  it("reordering a folder in the calendar carries its group", () => {
    scheduleItems(["X"], D1);
    scheduleItems(["S"], D1);
    expect(day(D1)).toEqual(["X", "S", "s1", "s2"]);
    set({ view: { ...get().view, focusedView: "calendar" } });
    selectCalendarItem("S");
    moveSelection("up");
    expect(day(D1)).toEqual(["S", "s1", "s2", "X"]);
  });

  it("dateSpan covers the folder and its unfinished dated descendants", () => {
    scheduleItems(["F"], D1);
    scheduleItems(["s2"], D2);
    const ix = buildIndex(get().doc!);
    expect(dateSpan("F", ix.items, ix.children)).toEqual({ from: D1, to: D2 });
  });
});

describe("roll over", () => {
  it("moves unfinished overdue work to today, leaving finished tasks", () => {
    const today = todayKey();
    const past = addDays(today, -3);
    scheduleItems(["F"], past);
    scheduleItems(["b"], past); // finished task on the past day
    scheduleItems(["X"], addDays(today, -1));
    expect(overdueItems(today).map((x) => x.id)).toEqual(["F", "X"]);
    expect(rollOverOverdue(today, { quiet: true })).toBe(2);
    expect(date("F")).toBe(today);
    expect(date("s1")).toBe(today);
    expect(date("X")).toBe(today);
    expect(date("b")).toBe(past);
  });
});

describe("typed dates", () => {
  const T = "2030-01-10"; // a Thursday
  it("parses a trailing @date and strips it", async () => {
    const { splitTypedDate } = await import("../src/state/schedule");
    expect(splitTypedDate("Call dentist @tomorrow", T, "monday")).toEqual({ text: "Call dentist", date: "2030-01-11" });
    expect(splitTypedDate("Pay rent @dec 5", T, "monday")).toEqual({ text: "Pay rent", date: "2030-12-05" });
    expect(splitTypedDate("Plan @fri", T, "monday")).toEqual({ text: "Plan", date: "2030-01-11" });
    expect(splitTypedDate("Report @+3d", T, "monday")).toEqual({ text: "Report", date: "2030-01-13" });
    expect(splitTypedDate("Unplan @none", T, "monday")).toEqual({ text: "Unplan", date: null });
  });
  it("ignores e-mail addresses, unknown phrases and bare dates", async () => {
    const { splitTypedDate } = await import("../src/state/schedule");
    expect(splitTypedDate("mail bob@example.com", T, "monday")).toBeNull();
    expect(splitTypedDate("meet @the park", T, "monday")).toBeNull();
    expect(splitTypedDate("@tomorrow", T, "monday")).toBeNull();
  });
  it("committing an edit schedules the item", async () => {
    const { enterEdit, updateDraft } = await import("../src/state/nav");
    const { exitEdit } = await import("../src/state/items");
    selectColumnItem("X");
    enterEdit("X", "end");
    updateDraft("Call dentist @2030-02-02");
    exitEdit();
    expect(item("X").text).toBe("Call dentist");
    expect(date("X")).toBe("2030-02-02");
  });
});
