import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/headless/core";
import { parseDocument } from "../src/model/format";
import { addDays, todayKey } from "../src/model/dates";

const dir = mkdtempSync(join(tmpdir(), "cascade-headless-"));
// Backups go to a throwaway data folder, never the real app data.
process.env.CASCADE_DATA_DIR = join(dir, "cascade-data");
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

describe("headless dates, backups and calendar export", () => {
  it("lists a week-long agenda by default, with overdue work", () => {
    const t = todayKey();
    w(() => core.addItem({ text: "Today thing", date: "today" }));
    w(() => core.addItem({ text: "In three days", date: "+3" }));
    w(() => core.addItem({ text: "Late", date: "-2" }));
    const a = r(() => core.agendaRange());
    expect(a.from).toBe(t);
    expect(a.days).toHaveLength(7);
    expect(a.days[0].items.map((i) => i.text)).toContain("Today thing");
    expect(a.days[3].items.map((i) => i.text)).toContain("In three days");
    expect(a.overdue.map((i) => i.text)).toEqual(["Late"]);
    const range = r(() => core.agendaRange({ from: "+1", to: "+3" }));
    expect(range.days.map((d) => d.date)).toEqual([addDays(t, 1), addDays(t, 2), addDays(t, 3)]);
    expect(range.overdue).toEqual([]);
    expect(() => r(() => core.agendaRange({ from: "+3", to: "+1" }))).toThrow(/before it starts/);
  });

  it("rolls unfinished overdue work over to today, leaving finished tasks", () => {
    w(() => core.addItem({ text: "Old open", date: "-3" }));
    w(() => core.addItem({ text: "Old done", date: "-3", finished: true }));
    expect(r(() => core.overdue()).map((i) => i.text)).toEqual(["Old open"]);
    const res = w(() => core.rollOver());
    expect(res.moved.map((i) => i.text)).toEqual(["Old open"]);
    expect(r(() => core.getItem("Old open")).date).toBe(todayKey());
    expect(r(() => core.getItem("Old done")).date).toBe(addDays(todayKey(), -3));
    expect(r(() => core.overdue())).toEqual([]);
  });

  it("backs up before edits (throttled) and restores a backup reversibly", () => {
    const original = readFileSync(file, "utf8");
    expect(core.listDocBackups(file).backups).toHaveLength(0);
    w(() => core.addItem({ text: "First edit" }));
    w(() => core.addItem({ text: "Second edit" }));
    const list = core.listDocBackups(file).backups;
    expect(list).toHaveLength(1); // one copy per burst of edits
    expect(list[0].ref).toBe(1);
    const res = core.restoreDocBackup(file, 1);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(core.listDocBackups(file).backups).toHaveLength(2);
    // The content before restoring was saved, so restoring can be undone.
    core.restoreDocBackup(file, res.previousBackup);
    expect(r(() => core.search("Second edit"))).toHaveLength(1);
    expect(() => core.restoreDocBackup(file, 99)).toThrow(/No backup/);
  });

  it("exports an .ics file and keeps an existing one up to date", () => {
    w(() => core.addItem({ text: "Dentist", date: "tomorrow" }));
    const out = core.exportIcs(file);
    expect(out.path).toBe(file.replace(/\.col$/, ".ics"));
    expect(out.events).toBeGreaterThanOrEqual(1);
    expect(readFileSync(out.path, "utf8")).toContain("SUMMARY:Dentist");
    w(() => core.addItem({ text: "Haircut", date: "+2" }));
    expect(readFileSync(out.path, "utf8")).toContain("SUMMARY:Haircut");
    expect(existsSync(out.path)).toBe(true);
  });
});
