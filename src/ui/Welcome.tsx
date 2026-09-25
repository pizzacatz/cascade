import { FilePlus, FolderOpen, LayoutTemplate, FileText, X } from "lucide-react";
import { useApp, updatePrefs } from "../state/store";
import { newDocument, openDialog, openPath, clearRecentFiles, fromStoredPath } from "../state/files";
import { openCommand } from "../state/overlays";
import { keyLabel } from "../state/shortcuts";
import { basename, displayName } from "../platform";
import { DOC_TEMPLATES } from "../state/templates";
import { Icon } from "./icons";

export function Welcome() {
  const recent = useApp((s) => s.prefs.recentFiles);
  return (
    <div className="welcome">
      <div className="welcome-card" onKeyDown={onWelcomeKey}>
        <div className="welcome-brand">
          <Logo />
          <div>
            <h1>Cascade</h1>
            <p className="muted">A horizontal, nested to-do list. Your lists are plain .col files you own.</p>
          </div>
        </div>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={() => void newDocument()}>
            <FilePlus size={18} />
            <span>New document</span>
            <span className="kbd">{keyLabel("new-file")}</span>
          </button>
          <button className="welcome-action" onClick={() => openCommand("templates")}>
            <LayoutTemplate size={18} />
            <span>New from template…</span>
            <span className="kbd">{keyLabel("new-from-template")}</span>
          </button>
          <button className="welcome-action" onClick={() => void openDialog()}>
            <FolderOpen size={18} />
            <span>Open…</span>
            <span className="kbd">{keyLabel("open-file")}</span>
          </button>
        </div>
        <div className="welcome-templates">
          {DOC_TEMPLATES.slice(1).map((t) => (
            <button key={t.id} className="template-card" onClick={() => void newDocument(t)}>
              <Icon name={t.icon} size={18} />
              <strong>{t.name}</strong>
              <span className="muted">{t.description}</span>
            </button>
          ))}
        </div>
        {recent.length > 0 && (
          <div className="welcome-recent">
            <div className="row">
              <h2 className="grow">Recent</h2>
              <button className="btn btn-ghost btn-sm" onClick={clearRecentFiles}>
                Clear
              </button>
            </div>
            <ul>
              {recent.map((p) => (
                <li key={p}>
                  <button className="recent-item" onClick={() => void openPath(p)} title={fromStoredPath(p)}>
                    <FileText size={15} />
                    <span className="recent-name">{displayName(p)}</span>
                    <span className="recent-path faint">{fromStoredPath(p).replace(basename(p), "")}</span>
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    aria-label={`Remove ${displayName(p)} from recent`}
                    onClick={() => updatePrefs({ recentFiles: recent.filter((x) => x !== p) })}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="welcome-foot faint">
          Press <span className="kbd">{keyLabel("command")}</span> for every command · <span className="kbd">F1</span> for help · ↑↓ to move between
          actions
        </p>
        <p className="welcome-version faint">Cascade 0.1.0</p>
      </div>
    </div>
  );
}

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="logo">
      <rect x="2" y="2" width="44" height="44" rx="11" fill="var(--accent)" />
      <rect x="10" y="12" width="7" height="24" rx="2.5" fill="var(--accent-contrast)" opacity="0.95" />
      <rect x="20.5" y="12" width="7" height="17" rx="2.5" fill="var(--accent-contrast)" opacity="0.8" />
      <rect x="31" y="12" width="7" height="10" rx="2.5" fill="var(--accent-contrast)" opacity="0.65" />
    </svg>
  );
}

/** ↑/↓ move focus through the actions, templates and recent documents. */
function onWelcomeKey(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".welcome-action, .template-card, .recent-item")];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[i < 0 ? 0 : next].focus();
}
