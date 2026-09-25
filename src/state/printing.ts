// Glue between the app state and the print subsystem.

import { buildTickets, type Ticket } from "../print/tickets";
import { printTickets } from "../print/dispatch";
import { defaultPrintBackend } from "../print/backend";
import { get, set, toast, type PrintScopeRef } from "./store";
import { indexOf, selectionOf } from "./derived";
import { setFinished } from "./items";
import { calendarDays, columnIds } from "./nav";
import { openOverlay } from "./overlays";

export function ticketsFor(scope: PrintScopeRef): Ticket[] {
  const s = get();
  const ps = s.printSettings;
  return buildTickets(indexOf(s.doc), scope, {
    printOption: ps.printOption,
    printBreadcrumb: ps.printBreadcrumb,
    printFinishedTasks: ps.printFinishedTasks,
  });
}

/** The natural print scope for the current state. */
export function currentPrintScope(kind: "selection" | "column" | "space" = "selection"): PrintScopeRef | null {
  const s = get();
  if (!s.doc) return null;
  const sel = selectionOf(s);
  if (kind === "space") return { kind: "space", spaceId: s.view.currentSpaceId };
  if (kind === "selection" && sel.length) return { kind: "selection", ids: sel };
  if (s.view.focusedView === "calendar") {
    const ix = indexOf(s.doc);
    const date = (sel[0] && ix.items[sel[0]]?.scheduleDate) || calendarDays(s)[0];
    return { kind: "day", date };
  }
  const ix = indexOf(s.doc);
  const parent = (sel[0] && ix.items[sel[0]]?.parentId) || columnIds(s).at(-1)!;
  return { kind: "column", parentId: parent };
}

export function openPrint(scope: PrintScopeRef | null = currentPrintScope()): void {
  if (!scope) return;
  openOverlay({ kind: "print", scope });
}

export async function runPrint(scope: PrintScopeRef): Promise<{ printed: number; tickets: Ticket[] }> {
  const s = get();
  const tickets = ticketsFor(scope);
  if (!tickets.length) throw new Error("Nothing to print — no matching tasks in this scope.");
  const res = await printTickets(tickets, s.printSettings, defaultPrintBackend());
  if (s.printSettings.printMarkAsFinished) {
    const ids = [...new Set(tickets.flatMap((t) => t.taskIds))];
    if (ids.length) setFinished(ids, true);
  }
  return { printed: res.printed, tickets };
}

export async function printNow(scope: PrintScopeRef | null = currentPrintScope()): Promise<void> {
  if (!scope) return;
  try {
    const r = await runPrint(scope);
    if (get().printSettings.printing.mode !== "classic") {
      toast(`Printed ${r.printed} ticket${r.printed === 1 ? "" : "s"}`, "success");
    }
  } catch (e) {
    toast((e as Error).message, "error", 6000);
  }
}

export function updatePrintSettings(next: ReturnType<typeof get>["printSettings"]) {
  set({ printSettings: next });
}
