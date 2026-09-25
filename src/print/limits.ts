// Output-size guards for the print dialog: a long-output warning and a hard
// cap on the number of printed items.

import type { Ticket } from "./tickets";

/** Most items (ticket blocks) printed in one job. */
export const MAX_PRINT_ITEMS = 1000;
/** Output longer than this many lines gets a warning. */
export const LONG_OUTPUT_LINES = 100;

/** Number of items (blocks) across all tickets. */
export function countItems(tickets: Ticket[]): number {
  return tickets.reduce((n, t) => n + t.blocks.length, 0);
}

/** Rough printed line count: breadcrumb, title and one line per block, plus a gap per ticket. */
export function estimateLines(tickets: Ticket[]): number {
  return tickets.reduce((n, t) => n + (t.breadcrumb?.length ? 1 : 0) + (t.title ? 1 : 0) + t.blocks.length + 1, 0);
}

/**
 * Trim tickets so no more than `max` items print. The ticket that crosses the
 * limit is shortened (keeping only its task ids that still print); later
 * tickets are dropped.
 */
export function capTickets(tickets: Ticket[], max = MAX_PRINT_ITEMS): { tickets: Ticket[]; capped: boolean } {
  if (countItems(tickets) <= max) return { tickets, capped: false };
  const out: Ticket[] = [];
  let left = max;
  for (const t of tickets) {
    if (left <= 0) break;
    if (t.blocks.length <= left) {
      out.push(t);
      left -= t.blocks.length;
      continue;
    }
    const blocks = t.blocks.slice(0, left);
    // Blocks don't carry ids; keep the leading task ids matching the kept task blocks.
    const keptTasks = blocks.filter((b) => b.kind === "task").length;
    out.push({ ...t, blocks, taskIds: t.taskIds.slice(0, keptTasks) });
    left = 0;
  }
  return { tickets: out, capped: true };
}
