// Copy / cut / paste through the OS clipboard as a plain-text outline. An
// in-app copy also keeps the full item data, so pasting inside Cascade keeps
// colours, tags, icons and types exactly.

import { nodesFromItems, outlineToText, parseOutline, type OutlineNode } from "../model/outline";
import { topLevelOnly } from "../model/tree";
import { platform } from "../platform";
import { get, toast } from "./store";
import { indexOf, selectionOf } from "./derived";
import { deleteSelection, insertOutline, type Placement } from "./items";
import { calendarDays, columnIds } from "./nav";

let lastCopy: { text: string; nodes: OutlineNode[] } | null = null;

export async function copySelection(): Promise<number> {
  const s = get();
  if (!s.doc) return 0;
  const ix = indexOf(s.doc);
  const ids = topLevelOnly(ix, selectionOf(s));
  if (!ids.length) return 0;
  const nodes = nodesFromItems(ix, ids.map((id) => ix.items[id]), true);
  const text = outlineToText(nodes);
  lastCopy = { text, nodes };
  await platform().writeClipboard(text);
  return ids.length;
}

export async function copyWithToast(): Promise<void> {
  const n = await copySelection();
  if (n) toast(`Copied ${n} item${n === 1 ? "" : "s"}`);
}

export async function cutSelection(): Promise<void> {
  const n = await copySelection();
  if (!n) return;
  deleteSelection();
  toast(`Cut ${n} item${n === 1 ? "" : "s"} (originals moved to Trash)`);
}

function pastePlacement(): Placement {
  const s = get();
  const ix = indexOf(s.doc);
  const sel = selectionOf(s);
  const last = sel.length ? ix.items[sel[sel.length - 1]] : null;
  if (s.view.focusedView === "calendar") {
    if (last?.scheduleDate) return { view: "calendar", date: last.scheduleDate, afterId: last.id };
    if (s.createTarget?.view === "calendar") return { view: "calendar", date: s.createTarget.date };
    return { view: "calendar", date: calendarDays(s)[0] };
  }
  if (last?.parentId) return { view: "columns", parentId: last.parentId, afterId: last.id };
  if (s.createTarget?.view === "columns") return { view: "columns", parentId: s.createTarget.parentId };
  return { view: "columns", parentId: columnIds(s).at(-1)! };
}

export async function pasteFromText(text: string): Promise<void> {
  if (!text.trim()) return;
  const nodes = lastCopy && lastCopy.text === text ? lastCopy.nodes : parseOutline(text);
  const created = insertOutline(nodes, pastePlacement());
  if (created.length) toast(`Pasted ${created.length} item${created.length === 1 ? "" : "s"}`);
}

export async function paste(): Promise<void> {
  const text = await platform().readClipboard();
  await pasteFromText(text);
}
