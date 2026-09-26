import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine, icsPathFor } from "../src/model/ics";
import { emptyDoc, makeItem } from "../src/model/defaults";

describe("iCalendar export", () => {
  it("escapes TEXT values", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("folds long lines at 75 octets without splitting characters", () => {
    const line = "SUMMARY:" + "é".repeat(60);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    const enc = new TextEncoder();
    for (const p of parts) expect(enc.encode(p).length).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
    expect(foldLine("SHORT:x")).toBe("SHORT:x");
  });

  it("writes all-day events for dated tasks and folders only, with CRLF", () => {
    const doc = emptyDoc();
    const task = makeItem("task", { text: "Call, dentist", scheduleDate: "2026-10-05", schedulePosition: "a0", parentId: "root", position: "a5" });
    const done = makeItem("task", { text: "Done thing", finished: true, scheduleDate: "2026-10-06", schedulePosition: "a0", parentId: "root", position: "a6" });
    const text = makeItem("text", { text: "A note", scheduleDate: "2026-10-06", schedulePosition: "a1", parentId: "root", position: "a7" });
    const trashed = makeItem("task", { text: "Gone", scheduleDate: "2026-10-06", schedulePosition: "a2", parentId: "trash", position: "a0" });
    for (const it of [task, done, text, trashed]) doc.items[it.id] = it;
    const ics = buildIcs(doc, { name: "My list", now: new Date(Date.UTC(2026, 8, 25, 12, 0, 0)) });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
    expect(ics).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    expect(ics).toContain("X-WR-CALNAME:My list");
    expect(ics).toContain(`UID:${task.id}@cascade`);
    expect(ics).toContain("DTSTAMP:20260925T120000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006");
    expect(ics).toContain("SUMMARY:Call\\, dentist");
    expect(ics).toContain("SUMMARY:✓ Done thing");
    expect(ics).not.toContain("A note");
    expect(ics).not.toContain("Gone");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it("names the sidecar file after the document", () => {
    expect(icsPathFor("/a/b/List.col")).toBe("/a/b/List.ics");
  });
});
