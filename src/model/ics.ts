// iCalendar (RFC 5545) export of a document's dated items, so calendar apps
// can show or subscribe to them. Each dated task or folder becomes one all-day
// event; finished tasks are prefixed with a check mark.

import type { Doc, Item } from "./types";
import { buildIndex, breadcrumb, isInTrash } from "./tree";
import { addDays } from "./dates";

export interface IcsOptions {
  /** Calendar name shown by calendar apps. */
  name?: string;
  /** Timestamp for DTSTAMP (defaults to now). */
  now?: Date;
}

/** Escape a TEXT value: backslash, semicolon, comma and newlines. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a content line so no physical line exceeds 75 octets (UTF-8), never
 * splitting a multi-byte character. Continuation lines start with one space.
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // the leading space of a continuation line counts
    }
    cur += ch;
    curBytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const dateValue = (day: string) => day.replace(/-/g, "");

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The items that go into the calendar export, in date order. */
export function exportableItems(doc: Doc): Item[] {
  const ix = buildIndex(doc);
  return Object.values(doc.items)
    .filter((it) => it.scheduleDate && (it.type === "task" || it.type === "folder") && !isInTrash(ix, it.id))
    .sort(
      (a, b) =>
        a.scheduleDate!.localeCompare(b.scheduleDate!) || (a.schedulePosition ?? "").localeCompare(b.schedulePosition ?? "") || a.id.localeCompare(b.id),
    );
}

export function buildIcs(doc: Doc, opts: IcsOptions = {}): string {
  const ix = buildIndex(doc);
  const dtstamp = stamp(opts.now ?? new Date());
  const tagName = (id: string) => doc.config.tags.find((t) => t.id === id)?.name;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cascade//Cascade//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (opts.name) lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`);
  for (const it of exportableItems(doc)) {
    const day = it.scheduleDate!;
    const text = it.text.trim() || "Untitled";
    const summary = it.type === "task" && it.finished ? `✓ ${text}` : text;
    const path = it.parentId ? breadcrumb(ix, it.id).join(" / ") : "";
    const tags = it.tags.map(tagName).filter((t): t is string => !!t);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${it.id}@cascade`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${dateValue(day)}`,
      `DTEND;VALUE=DATE:${dateValue(addDays(day, 1))}`,
      `SUMMARY:${escapeText(summary)}`,
    );
    if (path) lines.push(`DESCRIPTION:${escapeText(path)}`);
    if (tags.length) lines.push(`CATEGORIES:${tags.map(escapeText).join(",")}`);
    if (it.updatedAt) {
      const t = new Date(it.updatedAt);
      if (!isNaN(t.getTime())) lines.push(`LAST-MODIFIED:${stamp(t)}`);
    }
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** `/a/b/List.col` → `/a/b/List.ics`. */
export function icsPathFor(colPath: string): string {
  return colPath.replace(/\.col$/i, "") + ".ics";
}
