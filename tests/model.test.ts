import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, serializeDocument, DocumentFormatError } from "../src/model/format";
import { compareKeys, keyBetween, keysBetween } from "../src/model/order";
import { buildIndex, childrenOf, pathTo, spaceOf, breadcrumb } from "../src/model/tree";
import { computeStats } from "../src/model/progression";
import { resolveStyle, sortRules, type FormatContext } from "../src/model/formatting";
import { recurrenceMatches, toRRule } from "../src/model/recurrence";
import { parseOutline, outlineToText, nodesFromItems } from "../src/model/outline";
import { emptyDoc, makeItem } from "../src/model/defaults";
import type { Doc, FormatRule, Recurrence } from "../src/model/types";

const TODAY = "2026-09-25";
const sample = readFileSync(join(__dirname, "fixtures/sample.col"), "utf8");

describe(".col codec", () => {
  it("parses the sample document", () => {
    const { doc, sourceVersion, shouldRewrite, warnings } = parseDocument(sample, TODAY);
    expect(sourceVersion).toBe(4);
    expect(shouldRewrite).toBe(false);
    expect(warnings).toEqual([]);
    expect(Object.keys(doc.items)).toHaveLength(8);
    const done = doc.items["taskrender000000000000001"];
    expect(done.type).toBe("task");
    expect(done.finished).toBe(true);
    expect(done.finishedAt).toBe("2026-09-25T00:00:05.000Z");
    expect(doc.items["folderlinuxport0000000001"].type).toBe("folder");
    expect(doc.config.viewState?.columnsPath).toEqual(["folderlinuxport0000000001"]);
    expect(doc.config.conditionalFormatting[0].name).toBe("Finished tasks");
  });

  it("round-trips the sample byte-for-byte in structure", () => {
    const { doc } = parseDocument(sample, TODAY);
    const out = serializeDocument(doc);
    const a = JSON.parse(sample);
    const b = JSON.parse(out);
    // calendarCurrentDate is regenerated on load (it is not meaningful to persist).
    delete b.configuration.viewState.calendarCurrentDate;
    expect(b).toEqual(a);
    expect(out).toContain('\n  "file_version": 4');
  });

  it("uses compact keys and omits defaults", () => {
    const doc = emptyDoc();
    const it = makeItem("task", { parentId: "root", position: "a0", text: "", color: "blue", tags: ["t1"] });
    const sep = makeItem("separator", { parentId: "root", position: "a1", tags: ["x"] });
    doc.items[it.id] = it;
    doc.items[sep.id] = sep;
    const items = JSON.parse(serializeDocument(doc)).items;
    expect(items[0]).not.toHaveProperty("text");
    expect(items[0]).not.toHaveProperty("finished");
    expect(items[0].c).toBe(6);
    expect(items[0].tg).toEqual(["t1"]);
    expect(items[1].t).toBe(3);
    expect(items[1]).not.toHaveProperty("tg");
  });

  it("accepts legacy v1 arrays and rewrites them", () => {
    const legacy = JSON.stringify([
      { id: "f", parent_id: "root", position: "a0", text: "Folder" },
      { id: "t", parent_id: "f", position: "a0", text: "Child", type: "task", color: "red" },
    ]);
    const { doc, sourceVersion, shouldRewrite } = parseDocument(legacy, TODAY);
    expect(sourceVersion).toBe(1);
    expect(shouldRewrite).toBe(true);
    expect(doc.items.f.type).toBe("folder"); // inferred from having children
    expect(doc.items.t.color).toBe("red");
    expect(doc.config.spaces.map((s) => s.id)).toEqual(["root", "trash"]);
  });

  it("rejects unsupported versions", () => {
    expect(() => parseDocument('{"file_version": 9, "items": []}', TODAY)).toThrow(DocumentFormatError);
    expect(() => parseDocument("not json", TODAY)).toThrow(DocumentFormatError);
  });

  it("repairs broken placement", () => {
    const text = JSON.stringify({
      file_version: 4,
      configuration: {},
      items: [
        { id: "a", t: 1, text: "no placement" },
        { id: "b", t: 1, parent_id: "missing", position: "a0" },
        { id: "c", t: 1, scheduleDate: "2026-10-01" },
      ],
    });
    const { doc, shouldRewrite } = parseDocument(text, TODAY);
    expect(shouldRewrite).toBe(true);
    expect(doc.items.a.parentId).toBe("root");
    expect(doc.items.b.parentId).toBe("root");
    expect(doc.items.c.schedulePosition).toBeTruthy();
    expect(() => serializeDocument(doc)).not.toThrow();
  });

  it("normalizes prepared days and weekly week start", () => {
    const text = JSON.stringify({
      file_version: 3,
      configuration: {
        preparedDays: ["2026-10-02", "2020-01-01", "2026-10-01", "2026-10-01"],
        recurrenceRules: [
          {
            id: "r",
            name: "Weekly",
            enabled: true,
            priority: "a0",
            recurrence: { frequency: "weekly", startDate: "2026-01-01", interval: 1, weekdays: [1] },
            templates: [],
          },
        ],
      },
      items: [],
    });
    const { doc } = parseDocument(text, TODAY);
    expect(doc.config.preparedDays).toEqual(["2026-10-01", "2026-10-02"]);
    const rec = doc.config.recurrenceRules[0].recurrence;
    expect(rec.frequency === "weekly" && rec.weekStartsOn).toBe("monday");
  });

  it("preserves unknown configuration keys", () => {
    const text = JSON.stringify({ file_version: 4, configuration: { futureThing: { a: 1 } }, items: [] });
    const out = JSON.parse(serializeDocument(parseDocument(text, TODAY).doc));
    expect(out.configuration.futureThing).toEqual({ a: 1 });
  });
});

describe("ordering keys", () => {
  it("mints keys between neighbours", () => {
    const k = keyBetween("a0", "a1");
    expect(compareKeys("a0", k)).toBeLessThan(0);
    expect(compareKeys(k, "a1")).toBeLessThan(0);
  });
  it("handles bare keys like 'a' and 'b'", () => {
    const k = keyBetween("a", "b");
    expect(k > "a" && k < "b").toBe(true);
    const after = keyBetween("b", null);
    expect(after > "b").toBe(true);
  });
  it("mints n ordered keys", () => {
    const ks = keysBetween(null, null, 5);
    expect([...ks].sort()).toEqual(ks);
    expect(new Set(ks).size).toBe(5);
  });
});

function docWith(build: (d: Doc) => void): Doc {
  const d = emptyDoc();
  build(d);
  return d;
}

describe("tree and progression", () => {
  const doc = docWith((d) => {
    const add = (id: string, type: "task" | "folder", parentId: string, position: string, finished = false) =>
      (d.items[id] = makeItem(type, { id, parentId, position, text: id, finished }));
    add("A", "folder", "root", "a0");
    add("A1", "task", "A", "a0", true);
    add("B", "folder", "A", "a1");
    add("B1", "task", "B", "a0", true);
    add("B2", "task", "B", "a1");
    add("B3", "task", "B", "a2");
    add("B4", "task", "B", "a3");
  });
  const ix = buildIndex(doc);

  it("indexes children in order and builds paths", () => {
    expect(childrenOf(ix, "B").map((i) => i.id)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(pathTo(ix, "B")).toEqual(["A", "B"]);
    expect(spaceOf(ix, "B3")).toBe("root");
    expect(breadcrumb(ix, "B3")).toEqual(["Home", "A", "B"]);
  });

  it("computes by_level progress", () => {
    const s = computeStats(ix, "by_level", TODAY);
    expect(s.get("B")!.progression).toBeCloseTo(0.25);
    expect(s.get("A")!.progression).toBeCloseTo((1 + 0.25) / 2);
  });

  it("computes by_task_count progress", () => {
    const s = computeStats(ix, "by_task_count", TODAY);
    expect(s.get("A")!.progression).toBeCloseTo(2 / 5);
    expect(s.get("A")!.totalTaskCount).toBe(5);
    expect(s.get("A")!.completedTaskCount).toBe(2);
  });
});

describe("conditional formatting", () => {
  const doc = docWith((d) => {
    d.items.t1 = makeItem("task", { id: "t1", parentId: "root", position: "a0", text: "Call Bob", finished: true });
    d.items.t2 = makeItem("task", {
      id: "t2",
      parentId: "root",
      position: "a1",
      text: "Overdue thing",
      scheduleDate: "2026-09-20",
      schedulePosition: "a0",
      tags: ["urgent"],
    });
    d.items.t3 = makeItem("task", { id: "t3", parentId: "root", position: "a2", text: "Mine", color: "green", tags: ["urgent"] });
  });
  const ix = buildIndex(doc);
  const ctx: FormatContext = {
    ix,
    stats: computeStats(ix, "by_level", TODAY),
    today: TODAY,
    weekStartsOn: "monday",
    tagIds: new Set(["urgent"]),
  };
  const rules: FormatRule[] = sortRules([
    ...doc.config.conditionalFormatting,
    {
      id: "overdue",
      name: "Overdue",
      enabled: true,
      priority: "a1",
      kind: "taskRule",
      logic: "all",
      conditions: [{ kind: "scheduleDate", operator: "is_overdue" }],
      style: { bold: true, textColor: "red" },
    },
    {
      id: "urgent",
      name: "Urgent",
      enabled: true,
      priority: "a2",
      kind: "taskRule",
      logic: "any",
      conditions: [{ kind: "tag", operator: "has", tagId: "urgent" }],
      style: { italic: true, textColor: "blue" },
    },
  ]);

  it("applies the default finished rule", () => {
    const s = resolveStyle(rules, doc.items.t1, ctx);
    expect(s.strikethrough).toBe(true);
    expect(s.textColor).toBe("gray");
  });
  it("accumulates booleans and lets the top rule win colours", () => {
    const s = resolveStyle(rules, doc.items.t2, ctx);
    expect(s.bold).toBe(true);
    expect(s.italic).toBe(true);
    expect(s.textColor).toBe("red");
  });
  it("lets an item's own colour beat rule colours", () => {
    const s = resolveStyle(rules, doc.items.t3, ctx);
    expect(s.italic).toBe(true);
    expect(s.textColor).toBe("green");
  });
});

describe("recurrence", () => {
  const base = { startDate: "2026-09-01", endDate: null, interval: 1 };
  it("matches daily with interval", () => {
    const r: Recurrence = { ...base, frequency: "daily", interval: 3 };
    expect(recurrenceMatches(r, "2026-09-01")).toBe(true);
    expect(recurrenceMatches(r, "2026-09-02")).toBe(false);
    expect(recurrenceMatches(r, "2026-09-04")).toBe(true);
    expect(recurrenceMatches(r, "2026-08-31")).toBe(false);
  });
  it("matches weekly weekdays", () => {
    const r: Recurrence = { ...base, frequency: "weekly", weekdays: [1, 3], weekStartsOn: "monday" };
    expect(recurrenceMatches(r, "2026-09-28")).toBe(true); // Monday
    expect(recurrenceMatches(r, "2026-09-29")).toBe(false); // Tuesday
    expect(toRRule(r)).toBe("FREQ=WEEKLY;WKST=MO;BYDAY=MO,WE");
  });
  it("matches monthly variants", () => {
    const lastDay: Recurrence = { ...base, frequency: "monthly", mode: "last-day" };
    expect(recurrenceMatches(lastDay, "2026-09-30")).toBe(true);
    expect(recurrenceMatches(lastDay, "2026-09-29")).toBe(false);
    const secondTue: Recurrence = { ...base, frequency: "monthly", mode: "weekday", weekday: 2, ordinal: 2 };
    expect(recurrenceMatches(secondTue, "2026-09-08")).toBe(true);
    const lastFri: Recurrence = { ...base, frequency: "monthly", mode: "weekday", weekday: 5, ordinal: -1 };
    expect(recurrenceMatches(lastFri, "2026-09-25")).toBe(true);
    const day31: Recurrence = { ...base, frequency: "monthly", mode: "day", day: 31 };
    expect(recurrenceMatches(day31, "2026-09-30")).toBe(false);
  });
  it("respects end dates", () => {
    const r: Recurrence = { ...base, frequency: "daily", endDate: "2026-09-10" };
    expect(recurrenceMatches(r, "2026-09-11")).toBe(false);
  });
});

describe("outline", () => {
  it("parses generic outlines", () => {
    const nodes = parseOutline("# Plan\n- [ ] one\n- [x] two\n+ Folder\n  - child\n---\n> note\nplain");
    expect(nodes.map((n) => n.type)).toEqual(["heading", "task", "task", "folder", "separator", "text", "task"]);
    expect(nodes[2].finished).toBe(true);
    expect(nodes[3].children[0].text).toBe("child");
  });
  it("turns items with indented children into folders", () => {
    const nodes = parseOutline("Groceries\n  milk\n  eggs");
    expect(nodes[0].type).toBe("folder");
    expect(nodes[0].children).toHaveLength(2);
  });
  it("round-trips items", () => {
    const doc = parseDocument(sample, TODAY).doc;
    const ix = buildIndex(doc);
    const text = outlineToText(nodesFromItems(ix, childrenOf(ix, "root"), true));
    expect(text.split("\n")[0]).toBe("+ Linux Port Smoke Test");
    const back = parseOutline(text);
    expect(back[0].children.map((c) => c.text)).toEqual([
      "Open a .col file from the command line",
      "Render columns in WebKitGTK",
      "Nested folder",
    ]);
  });
});
