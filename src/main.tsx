import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import "./styles/layout.css";
import "./styles/overlays.css";
import { App } from "./App";
import { initPlatform } from "./platform";
import { loadSettings, openPath, startPersistence } from "./state/files";
import { cliOpenedSomething, startCli } from "./state/cli";
import { get, set } from "./state/store";

async function boot() {
  const platform = await initPlatform();
  await loadSettings();
  startPersistence();
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
  set({ ready: true });
  // Reveal the (initially hidden) window once the first frame is painted.
  requestAnimationFrame(() => requestAnimationFrame(() => void platform.showWindow().catch(() => {})));
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = `Cascade failed to start: ${String(e)}`;
  initPlatform()
    .then((p) => p.showWindow())
    .catch(() => {});
});
