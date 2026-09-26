import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import "./styles/layout.css";
import "./styles/overlays.css";
import { App } from "./App";
import { initPlatform, revealWindow } from "./platform";
import { loadSettings, openPath, startPersistence, startWatchingDisk } from "./state/files";
import { cliOpenedSomething, startCli } from "./state/cli";
import { get, set, toast } from "./state/store";

function showFatal(e: unknown) {
  console.error(e);
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:24px;white-space:pre-wrap;font:13px monospace;color:#c00";
  pre.textContent = `Cascade failed to start:\n${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`;
  document.body.replaceChildren(pre);
}

async function boot() {
  const platform = await initPlatform();
  // Never leave the (initially hidden) window invisible, even if startup stalls.
  setTimeout(revealWindow, 2500);
  window.addEventListener("error", (e) => toast(`Error: ${e.message}`, "error", 8000));
  window.addEventListener("unhandledrejection", (e) => toast(`Error: ${String(e.reason)}`, "error", 8000));

  await loadSettings().catch((e) => console.warn("Settings could not be loaded", e));
  startPersistence();
  startWatchingDisk();
  platform.pruneBackups().catch(() => {});

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await startCli().catch((e) => console.warn("CLI setup failed", e));
  const { prefs, doc } = get();
  if (!doc && !cliOpenedSomething() && prefs.openLastDocumentOnStartup && prefs.lastOpenedDocumentPath) {
    await openPath(prefs.lastOpenedDocumentPath);
  }
  // App reveals the window once it has rendered with ready = true.
  set({ ready: true });
}

boot().catch((e) => {
  showFatal(e);
  initPlatform().then(revealWindow).catch(() => {});
});
