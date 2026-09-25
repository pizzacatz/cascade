// Turn a print scope (selection, column, space or calendar day) into printable
// tickets. A ticket is a self-contained slip: an optional breadcrumb, an
// optional title, and a list of blocks.

import type { Item, ItemType } from "../model/types";
import { isContainerType } from "../model/types";
import type { DocIndex } from "../model/tree";
import { breadcrumb, childrenOf, itemsOnDay, topLevelOnly } from "../model/tree";
import { formatLongDay } from "../model/dates";
import type { PrintOption } from "./settings";

export type PrintScope =
  | { kind: "selection"; ids: string[] }
  | { kind: "column"; parentId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "day"; date: string };

export type BlockKind = "task" | "text" | "heading" | "separator" | "folder";

export interface TicketBlock {
  kind: BlockKind;
  text: string;
  finished: boolean;
  depth: number;
}

export interface Ticket {
  breadcrumb: string[] | null;
  title: string | null;
  blocks: TicketBlock[];
  /** Tasks on this ticket, marked finished after printing when enabled. */
  taskIds: string[];
}

export interface TicketOptions {
  printOption: PrintOption;
  printBreadcrumb: boolean;
  printFinishedTasks: boolean;
}

const blockKind = (t: ItemType): BlockKind => (t === "template" ? "folder" : t);

function itemBreadcrumb(ix: DocIndex, it: Item): string[] {
  const crumbs = breadcrumb(ix, it.id);
  if (crumbs.length === 0 && it.scheduleDate) return [formatLongDay(it.scheduleDate)];
  return crumbs;
}

interface ScopeRoot {
  /** The item the root represents, when it is an item (selection scope). */
  item: Item | null;
  title: string | null;
  breadcrumb: string[];
  /** The items directly inside this root. */
  entries: Item[];
}

function scopeRoots(ix: DocIndex, scope: PrintScope): ScopeRoot[] {
  switch (scope.kind) {
    case "selection": {
      const ids = topLevelOnly(ix, scope.ids.filter((id) => ix.items[id]));
      return ids.map((id) => {
        const it = ix.items[id];
        const container = isContainerType(it.type) || childrenOf(ix, id).length > 0;
        return {
          item: it,
          title: container ? it.text || "Untitled" : null,
          breadcrumb: itemBreadcrumb(ix, it),
          entries: container ? childrenOf(ix, id) : [it],
        };
      });
    }
    case "column": {
      const folder = ix.items[scope.parentId];
      const space = ix.spaces.find((s) => s.id === scope.parentId);
      return [
        {
          item: folder ?? null,
          title: folder ? folder.text || "Untitled" : (space?.name ?? null),
          breadcrumb: folder ? itemBreadcrumb(ix, folder) : [],
          entries: childrenOf(ix, scope.parentId),
        },
      ];
    }
    case "space": {
      const space = ix.spaces.find((s) => s.id === scope.spaceId);
      return [{ item: null, title: space?.name ?? null, breadcrumb: [], entries: childrenOf(ix, scope.spaceId) }];
    }
    case "day":
      return [{ item: null, title: formatLongDay(scope.date), breadcrumb: [], entries: itemsOnDay(ix, scope.date) }];
  }
}

export function buildTickets(ix: DocIndex, scope: PrintScope, opts: TicketOptions): Ticket[] {
  const includeTask = (it: Item) => it.type === "task" && (opts.printFinishedTasks || !it.finished);
  const crumbs = (c: string[]) => (opts.printBreadcrumb ? c : null);
  const roots = scopeRoots(ix, scope);
  const tickets: Ticket[] = [];

  if (opts.printOption === "task_tickets" || opts.printOption === "task_tickets_recursive") {
    const recursive = opts.printOption === "task_tickets_recursive";
    const seen = new Set<string>();
    const visit = (it: Item) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      if (includeTask(it)) {
        tickets.push({
          breadcrumb: crumbs(itemBreadcrumb(ix, it)),
          title: null,
          blocks: [{ kind: "task", text: it.text, finished: it.finished, depth: 0 }],
          taskIds: [it.id],
        });
      }
      if (recursive) for (const c of childrenOf(ix, it.id)) visit(c);
    };
    for (const root of roots) for (const e of root.entries) visit(e);
    return tickets;
  }

  const recursive = opts.printOption === "selection_tickets_recursive";
  for (const root of roots) {
    const blocks: TicketBlock[] = [];
    const taskIds: string[] = [];
    const guard = new Set<string>();
    const add = (it: Item, depth: number) => {
      if (guard.has(it.id)) return;
      guard.add(it.id);
      if (it.type === "task" && !includeTask(it)) return;
      blocks.push({ kind: blockKind(it.type), text: it.text, finished: it.finished, depth });
      if (it.type === "task") taskIds.push(it.id);
      if (recursive && (root.item === null || it.id !== root.item.id)) {
        for (const c of childrenOf(ix, it.id)) add(c, depth + 1);
      }
    };
    for (const e of root.entries) add(e, 0);
    if (blocks.length === 0) continue;
    tickets.push({ breadcrumb: crumbs(root.breadcrumb), title: root.title, blocks, taskIds });
  }
  return tickets;
}

/** Plain-text rendering of a ticket (used for previews and direct encoding). */
export function blockPrefix(b: TicketBlock): string {
  switch (b.kind) {
    case "task":
      return b.finished ? "[x] " : "[ ] ";
    case "folder":
      return "> ";
    default:
      return "";
  }
}
