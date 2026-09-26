// Calendar export: a one-off .ics file, and an optional .ics copy kept next to
// each document and rewritten on every save (calendar apps can subscribe to it).

import type { Doc } from "../model/types";
import { buildIcs, icsPathFor } from "../model/ics";
import { fnv1a64 } from "../model/hash";
import { basename, displayName, platform } from "../platform";
import { get, toast } from "./store";

const calendarName = (path: string | null) => (path ? displayName(path) : "Cascade");

export async function exportCalendar(): Promise<void> {
  const s = get();
  if (!s.doc) return;
  const text = buildIcs(s.doc, { name: calendarName(s.filePath) });
  try {
    const path = await platform().saveExport(`${calendarName(s.filePath)}.ics`, text, { name: "iCalendar", extensions: ["ics"] });
    if (path) toast(`Exported the calendar to ${basename(path)}`, "success");
  } catch (e) {
    toast(`Could not export the calendar: ${String(e)}`, "error", 6000);
  }
}

/** Last sidecar content written per path, so unchanged calendars are not rewritten. */
const written = new Map<string, string>();

/** After a successful save: keep `<doc>.ics` up to date when the preference is on. */
export async function writeIcsSidecar(path: string, doc: Doc): Promise<void> {
  if (!get().prefs.keepIcsCopy || platform().kind !== "tauri") return;
  // DTSTAMP changes every call, so compare the content without it.
  const text = buildIcs(doc, { name: calendarName(path) });
  const key = fnv1a64(text.replace(/^DTSTAMP:.*$/gm, ""));
  const target = icsPathFor(path);
  if (written.get(target) === key) return;
  await platform().writeTextAtomic(target, text);
  written.set(target, key);
}
