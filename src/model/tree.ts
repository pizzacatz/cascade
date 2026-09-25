// Derived indexes over the flat item map: children per parent and items per
// calendar day, both sorted by their ordering key.

import type { Doc, Item, Space } from "./types";
import { TRASH_SPACE_ID, TREE_SPACE_ID, SYSTEM_SPACE_IDS, isContainerType } from "./types";
import { compareKeys } from "./order";

export interface DocIndex {
  items: Record<string, Item>;
  spaces: Space[];
  spaceIds: Set<string>;
  children: Map<string, Item[]>;
  byDay: Map<string, Item[]>;
}

const byPosition = (a: Item, b: Item) =>
  compareKeys(a.position ?? "", b.position ?? "") || compareKeys(a.id, b.id);
const bySchedule = (a: Item, b: Item) =>
  compareKeys(a.schedulePosition ?? "", b.schedulePosition ?? "") || compareKeys(a.id, b.id);

export function buildIndex(doc: Doc): DocIndex {
  const children = new Map<string, Item[]>();
  const byDay = new Map<string, Item[]>();
  for (const it of Object.values(doc.items)) {
    if (it.parentId !== null) {
      let list = children.get(it.parentId);
      if (!list) children.set(it.parentId, (list = []));
      list.push(it);
    }
    if (it.scheduleDate !== null) {
      let list = byDay.get(it.scheduleDate);
      if (!list) byDay.set(it.scheduleDate, (list = []));
      list.push(it);
    }
  }
  for (const list of children.values()) list.sort(byPosition);
  for (const list of byDay.values()) list.sort(bySchedule);
  return {
    items: doc.items,
    spaces: sortSpaces(doc.config.spaces),
    spaceIds: new Set(doc.config.spaces.map((s) => s.id)),
    children,
    byDay,
  };
}

export function sortSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort((a, b) => compareKeys(a.position, b.position) || a.name.localeCompare(b.name));
}

/** Spaces shown in the switcher: not archived and not the hidden legacy tree. */
export function visibleSpaces(spaces: Space[]): Space[] {
  return sortSpaces(spaces).filter((s) => !s.archived && s.id !== TREE_SPACE_ID);
}

export const isUserSpace = (id: string) => !SYSTEM_SPACE_IDS.has(id);

export function childrenOf(ix: DocIndex, parentId: string): Item[] {
  return ix.children.get(parentId) ?? [];
}

export function itemsOnDay(ix: DocIndex, day: string): Item[] {
  return ix.byDay.get(day) ?? [];
}

/** Folder ids from the owning space down to (and including) the item if it is a folder. */
export function pathTo(ix: DocIndex, itemId: string): string[] {
  const out: string[] = [];
  let cur: string | null = itemId;
  const guard = new Set<string>();
  while (cur && ix.items[cur] && !guard.has(cur)) {
    guard.add(cur);
    const it: Item = ix.items[cur];
    if (isContainerType(it.type)) out.push(it.id);
    cur = it.parentId;
  }
  return out.reverse();
}

/** The column path for selecting an item: its ancestor folders (not the item itself). */
export function ancestorFolders(ix: DocIndex, itemId: string): string[] {
  const it = ix.items[itemId];
  if (!it || !it.parentId) return [];
  if (ix.spaceIds.has(it.parentId)) return [];
  return pathTo(ix, it.parentId);
}

/** The space an item belongs to, walking up the parent chain. */
export function spaceOf(ix: DocIndex, itemId: string): string | null {
  let cur: string | null = itemId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    if (ix.spaceIds.has(cur)) return cur;
    const it: Item | undefined = ix.items[cur];
    if (!it) return null;
    cur = it.parentId;
  }
  return null;
}

export const isInTrash = (ix: DocIndex, itemId: string) => spaceOf(ix, itemId) === TRASH_SPACE_ID;

/** All descendants (depth-first, in order), excluding the item itself. */
export function descendants(ix: DocIndex, itemId: string): Item[] {
  const out: Item[] = [];
  const walk = (id: string) => {
    for (const c of childrenOf(ix, id)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(itemId);
  return out;
}

export function isAncestor(ix: DocIndex, ancestorId: string, itemId: string): boolean {
  let cur = ix.items[itemId]?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    if (cur === ancestorId) return true;
    guard.add(cur);
    cur = ix.items[cur]?.parentId ?? null;
  }
  return false;
}

/** Human-readable breadcrumb labels for an item (space name, folders). */
export function breadcrumb(ix: DocIndex, itemId: string): string[] {
  const labels: string[] = [];
  let cur = ix.items[itemId]?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    if (ix.spaceIds.has(cur)) {
      const s = ix.spaces.find((sp) => sp.id === cur);
      if (s) labels.push(s.name);
      break;
    }
    const it = ix.items[cur];
    if (!it) break;
    labels.push(it.text || "Untitled");
    cur = it.parentId;
  }
  return labels.reverse();
}

/** Remove ids whose ancestor is also in the list, preserving order. */
export function topLevelOnly(ix: DocIndex, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = ix.items[id]?.parentId ?? null;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      if (set.has(cur)) return false;
      guard.add(cur);
      cur = ix.items[cur]?.parentId ?? null;
    }
    return true;
  });
}
