// Folder progress and task statistics.
//
// by_level:      a folder's progress is the mean of its direct children's
//                progress (each child counts equally); a task is 1 or 0.
// by_task_count: a folder's progress is finished/total over every task in its
//                subtree.
// -1 means "not applicable" (no tasks beneath / not a task).

import type { Item, ProgressionMode } from "./types";
import { isContainerType } from "./types";
import type { DocIndex } from "./tree";
import { childrenOf } from "./tree";

export interface FolderStats {
  progression: number;
  totalTaskCount: number;
  completedTaskCount: number;
  incompleteTaskCount: number;
  overdueTaskCount: number;
  todayTaskCount: number;
  futureTaskCount: number;
  directOverdueTaskCount: number;
  directTodayTaskCount: number;
  directFutureTaskCount: number;
}

export type StatsMap = Map<string, FolderStats>;

function emptyStats(): FolderStats {
  return {
    progression: -1,
    totalTaskCount: 0,
    completedTaskCount: 0,
    incompleteTaskCount: 0,
    overdueTaskCount: 0,
    todayTaskCount: 0,
    futureTaskCount: 0,
    directOverdueTaskCount: 0,
    directTodayTaskCount: 0,
    directFutureTaskCount: 0,
  };
}

const isOverdue = (it: Item, today: string) =>
  it.type === "task" && !it.finished && it.scheduleDate !== null && it.scheduleDate < today;

/**
 * Compute stats for every item that has children or is a task. Tasks get a
 * progression of 0/1; containers get aggregated stats.
 */
export function computeStats(ix: DocIndex, mode: ProgressionMode, today: string): StatsMap {
  const out: StatsMap = new Map();
  const visiting = new Set<string>();

  const visit = (it: Item): FolderStats => {
    const cached = out.get(it.id);
    if (cached) return cached;
    const s = emptyStats();
    if (visiting.has(it.id)) return s; // cycle guard
    visiting.add(it.id);

    if (it.type === "task") {
      s.totalTaskCount = 1;
      s.completedTaskCount = it.finished ? 1 : 0;
      s.incompleteTaskCount = it.finished ? 0 : 1;
      s.overdueTaskCount = isOverdue(it, today) ? 1 : 0;
      s.todayTaskCount = it.scheduleDate === today ? 1 : 0;
      s.futureTaskCount = it.scheduleDate !== null && it.scheduleDate > today ? 1 : 0;
    }

    const kids = childrenOf(ix, it.id);
    const levelValues: number[] = [];
    for (const c of kids) {
      const cs = visit(c);
      s.totalTaskCount += cs.totalTaskCount;
      s.completedTaskCount += cs.completedTaskCount;
      s.incompleteTaskCount += cs.incompleteTaskCount;
      s.overdueTaskCount += cs.overdueTaskCount;
      s.todayTaskCount += cs.todayTaskCount;
      s.futureTaskCount += cs.futureTaskCount;
      if (c.type === "task") {
        if (isOverdue(c, today)) s.directOverdueTaskCount++;
        if (c.scheduleDate === today) s.directTodayTaskCount++;
        if (c.scheduleDate !== null && c.scheduleDate > today) s.directFutureTaskCount++;
      }
      if (cs.progression >= 0) levelValues.push(cs.progression);
    }

    if (it.type === "task" && kids.length === 0) {
      s.progression = it.finished ? 1 : 0;
    } else if (mode === "by_task_count") {
      s.progression = s.totalTaskCount === 0 ? -1 : s.completedTaskCount / s.totalTaskCount;
    } else if (it.type === "task" && levelValues.length === 0) {
      s.progression = it.finished ? 1 : 0;
    } else {
      s.progression = levelValues.length ? levelValues.reduce((a, b) => a + b, 0) / levelValues.length : -1;
    }

    visiting.delete(it.id);
    out.set(it.id, s);
    return s;
  };

  for (const it of Object.values(ix.items)) {
    if (it.type === "task" || isContainerType(it.type) || ix.children.has(it.id)) visit(it);
  }
  return out;
}

/** Aggregate progress for a whole column (space or folder children). */
export function columnProgress(ix: DocIndex, stats: StatsMap, parentId: string, mode: ProgressionMode): number {
  const kids = childrenOf(ix, parentId);
  if (mode === "by_task_count") {
    let total = 0;
    let done = 0;
    for (const k of kids) {
      const s = stats.get(k.id);
      if (!s) continue;
      total += s.totalTaskCount;
      done += s.completedTaskCount;
    }
    return total === 0 ? -1 : done / total;
  }
  const vals = kids.map((k) => stats.get(k.id)?.progression ?? -1).filter((v) => v >= 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -1;
}
