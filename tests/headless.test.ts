import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/headless/core";
import { parseDocument } from "../src/model/format";
import { addDays, todayKey } from "../src/model/dates";

const dir = mkdtempSync(join(tmpdir(), "cascade-headless-"));
let file: string;
let n = 0;

beforeEach(() => {
  file = join(dir, `doc${++n}.col`);
  core.createDocument(file, "projects");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const w = <T>(fn: () => T) => core.withDoc(file, fn);
const r = <T>(fn: () => T) => core.withDoc(file, fn, false);

describe("headless core", () => {
  it("creates a valid document from a template", () => {
    const { doc } = parseDocument(readFileSync(file, "utf8"));
    expect(doc.config.spaces.map((s) => s.name)).toContain("Work");
  });

  it("resolves paths, names and ids", () => {
    const folder = r(() => core.getItem("Work/Website relaunch"));
    expect(folder.type).toBe("folder");
    expect(r(() => core.getItem(folder.id)).text).toBe("Website relaunch");
    expect(r(() => core.getItem("website RELAUNCH")).id).toBe(folder.id);
    expect(() => r(() => core.getItem("nope"))).toThrow(core.CascadeError);
  });

  it("adds items with tags and dates, persisting to disk", () => {
    const tomorrow = addDays(todayKey(), 1);
    const it = w(() => core.addItem({ text: "Ship it", parent: "Work/Website relaunch", tags: ["Urgent", "new-tag"], date: "tomorrow" }));
    expect(it.path).toBe("Work / Website relaunch");
    expect(it.tags).toEqual(["Urgent", "new-tag"]);
    expect(it.date).toBe(tomorrow);
    const agenda = r(() => core.agenda("tomorrow"));
    expect(agenda.items.map((i) => i.text)).toContain("Ship it");
  });

  it("turns a task into a folder when adding a child", () => {
    const parent = w(() => core.addItem({ text: "Groceries" }));
    w(() => core.addItem({ text: "Milk", parent: parent.id }));
    expect(r(() => core.getItem(parent.id)).type).toBe("folder");
  });

  it("finishes, edits, moves and deletes", () => {
    w(() => core.setFinished(["Homepage mock-up"], true));
    expect(r(() => core.getItem("Homepage mock-up")).finished).toBe(true);
    w(() => core.updateItem("Collect numbers", { text: "Collect Q3 numbers", color: "blue" }));
    const moved = w(() => core.moveItems(["Collect Q3 numbers"], "Home"));
    expect(moved[0].space).toBe("root");
    const del = w(() => core.deleteItems(["Collect Q3 numbers"]));
    expect(del.trashed).toHaveLength(1);
    const perm = w(() => core.deleteItems(["Collect Q3 numbers"]));
    expect(perm.deleted).toHaveLength(1);
    expect(r(() => core.search("Collect", { includeTrash: true }))).toHaveLength(0);
  });

  it("refuses finishing non-tasks and ambiguous names", () => {
    expect(() => w(() => core.setFinished(["Work/Website relaunch"], true))).toThrow(/Only tasks/);
    w(() => core.addItem({ text: "Dup" }));
    w(() => core.addItem({ text: "Dup" }));
    expect(() => r(() => core.getItem("Dup"))).toThrow(/matches 2 items/);
  });

  it("does not write the file for read-only calls", () => {
    const before = readFileSync(file, "utf8");
    r(() => core.listItems({ parent: "Work", depth: "all" }));
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
