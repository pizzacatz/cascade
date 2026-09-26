import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc, makeItem } from "../src/model/defaults";
import { get, set } from "../src/state/store";
import { startStack, stackMarkComplete, stackTogglePause } from "../src/state/stack";
import { remoteStackPayload } from "../src/state/remoteStack";

beforeEach(() => {
  const doc = emptyDoc();
  const root = doc.config.spaces[0].id;
  doc.items.F = makeItem("folder", { id: "F", parentId: root, position: "a0", text: "Project" });
  doc.items.a = makeItem("task", { id: "a", parentId: "F", position: "a0", text: "Write intro" });
  doc.items.b = makeItem("task", { id: "b", parentId: "F", position: "a1", text: "Secret" });
  set({ doc, filePath: "t.col", localStack: null, overlay: null, view: doc.config.viewState! });
  set({ prefs: { ...get().prefs, stack: { ...get().prefs.stack, syncFinishedStatus: true, displayBreadcrumb: true, timer: { ...get().prefs.stack.timer, type: "duration", durationMinutes: 25 } } } });
});

describe("remote stack payload", () => {
  it("is empty without a stack", () => {
    expect(remoteStackPayload(get())).toMatchObject({ running: false, total: 0, timer: null });
  });

  it("carries only the current task and progress", () => {
    startStack({ kind: "column", parentId: "F" }, false);
    const p = remoteStackPayload(get(), get().localStack!.startedAt + 60_000);
    expect(p).toMatchObject({ running: true, allDone: false, text: "Write intro", breadcrumb: ["Home", "Project"], done: 0, total: 2, canPrevious: false, canNext: true });
    expect(p.timer).toMatchObject({ type: "duration", remainingMs: 24 * 60_000, elapsedMs: 60_000, paused: false });
    // Other tasks in the document never leave the app.
    expect(JSON.stringify(p)).not.toContain("Secret");
  });

  it("follows completion and pausing", () => {
    startStack({ kind: "column", parentId: "F" }, false);
    stackMarkComplete();
    stackTogglePause();
    const p = remoteStackPayload(get());
    expect(p).toMatchObject({ text: "Secret", done: 1, canPrevious: true, canNext: false });
    expect(p.timer?.paused).toBe(true);
    stackMarkComplete();
    expect(remoteStackPayload(get()).allDone).toBe(true);
  });
});
