import { useEffect } from "react";
import { toast, useApp } from "./state/store";
import { handleKeydown } from "./state/shortcuts";
import { ColumnsView } from "./ui/Columns";
import { CalendarView } from "./ui/Calendar";
import { Sidebar } from "./ui/Sidebar";
import { Toolbar } from "./ui/Toolbar";
import { Welcome } from "./ui/Welcome";
import { HelpPanel } from "./ui/HelpPanel";
import { Toasts } from "./ui/Toasts";
import { DragGhost } from "./ui/DragGhost";
import { OverlayHost } from "./ui/overlays/OverlayHost";
import { StackRunner } from "./ui/StackRunner";
import { installDragListeners } from "./ui/dnd";
import { revealWindow } from "./platform";
import { todayKey } from "./model/dates";
import { rollOverOverdue } from "./state/schedule";

function useTheme() {
  const pref = useApp((s) => s.prefs.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = pref === "dark" || (pref === "auto" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
}

export function App() {
  useTheme();
  const hasDoc = useApp((s) => !!s.doc);
  const showColumns = useApp((s) => s.view.showColumnsView);
  const showCalendar = useApp((s) => s.view.showCalendarView);
  const hideToolbar = useApp((s) => s.prefs.hideFloatingActionMenu);
  const showHelp = useApp((s) => s.prefs.showHelp);
  const stack = useApp((s) => s.localStack);
  const dragging = useApp((s) => s.drag?.status === "active");
  const ready = useApp((s) => s.ready);

  // Optional: move unfinished overdue work to today on open and at midnight.
  const rollOver = useApp((s) => s.prefs.rollOverOverdue);
  const filePath = useApp((s) => s.filePath);
  useEffect(() => {
    if (!rollOver || !filePath) return;
    const run = () => {
      const n = rollOverOverdue(todayKey(), { quiet: true });
      if (n) toast(`Moved ${n} unfinished item${n === 1 ? "" : "s"} to today`, "success");
    };
    run();
    let day = todayKey();
    const t = setInterval(() => {
      if (todayKey() === day) return;
      day = todayKey();
      run();
    }, 60_000);
    return () => clearInterval(t);
  }, [rollOver, filePath]);

  // Runs after the commit that shows the opened document.
  useEffect(() => {
    if (ready) revealWindow();
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKeydown(e);
    window.addEventListener("keydown", onKey);
    const uninstall = installDragListeners();
    // Suppress the webview's own context menu except inside editable text.
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!(t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
      uninstall();
    };
  }, []);

  if (stack?.compact) return <StackRunner compact />;

  return (
    <div className={`app ${dragging ? "is-dragging" : ""}`}>
      {hasDoc ? (
        <>
          <Sidebar />
          <main className="workspace">
            {stack && <StackRunner />}
            <div className={`views ${showColumns && showCalendar ? "is-split" : ""}`}>
              {showColumns && <ColumnsView />}
              {showCalendar && <CalendarView />}
              {!showColumns && !showCalendar && (
                <div className="no-view">
                  <div>
                    <strong>No view selected</strong>
                    Enable Columns or Calendar in the toolbar to display a view.
                  </div>
                </div>
              )}
            </div>
            {!hideToolbar && <Toolbar />}
          </main>
          {showHelp && <HelpPanel />}
        </>
      ) : (
        <>
          <Welcome />
          {showHelp && <HelpPanel />}
        </>
      )}
      <OverlayHost />
      <DragGhost />
      <Toasts />
    </div>
  );
}
