import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, FileWarning, FolderOpen, Library, X } from "lucide-react";
import { get, updatePrefs, useApp } from "../state/store";
import { clearRecentFiles, fromStoredPath, openDialog, openPath, toStoredPath } from "../state/files";
import { basename, displayName, platform } from "../platform";
import { fuzzyFilter } from "./fuzzy";
import { Modal } from "./overlays/Modal";

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function removeRecent(stored: string) {
  const prefs = get().prefs;
  const { [stored]: _drop, ...rest } = prefs.recentOpenedAt;
  updatePrefs({ recentFiles: prefs.recentFiles.filter((p) => p !== stored), recentOpenedAt: rest });
}

/**
 * Every remembered document: filter by typing, ↑/↓ to move, Enter to open,
 * Delete to forget. Documents that no longer exist are greyed out and can be
 * located again or removed.
 */
export function DocumentsDialog({ onClose }: { onClose: () => void }) {
  const recent = useApp((s) => s.prefs.recentFiles);
  const openedAt = useApp((s) => s.prefs.recentOpenedAt);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all(recent.map(async (p) => [p, await platform().exists(fromStoredPath(p)).catch(() => false)] as const)).then((r) => {
      if (alive) setMissing(new Set(r.filter(([, ok]) => !ok).map(([p]) => p)));
    });
    return () => {
      alive = false;
    };
  }, [recent]);

  const list = useMemo(() => fuzzyFilter(recent, q, (p) => `${displayName(p)} ${fromStoredPath(p)}`), [recent, q]);
  const idx = Math.min(active, Math.max(0, list.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-doc-index="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const open = async (p: string) => {
    if (missing.has(p)) return;
    onClose();
    await openPath(p);
  };

  const locate = async (p: string) => {
    const picked = await platform().pickOpenPath(fromStoredPath(p).replace(basename(p), "") || undefined);
    if (!picked) return;
    const stored = toStoredPath(picked);
    const prefs = get().prefs;
    updatePrefs({ recentFiles: prefs.recentFiles.map((x) => (x === p ? stored : x)).filter((x, i, a) => a.indexOf(x) === i) });
    onClose();
    await openPath(stored);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      setActive((idx + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = list[idx];
      if (p) void (missing.has(p) ? locate(p) : open(p));
    } else if (e.key === "Delete" && list[idx] && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      removeRecent(list[idx]);
    } else if (e.key === "Delete" && list[idx] && e.altKey) {
      e.preventDefault();
      removeRecent(list[idx]);
    }
  };

  return (
    <Modal
      title="Documents"
      icon={<Library size={16} />}
      width={640}
      height="min(80vh, 560px)"
      onClose={onClose}
      className="documents-dialog"
      footer={
        <div className="row grow">
          <button className="btn btn-sm" onClick={() => void (onClose(), openDialog())}>
            <FolderOpen size={13} /> Open other…
          </button>
          <span className="grow" />
          <button className="btn btn-ghost btn-sm" disabled={!recent.length} onClick={clearRecentFiles}>
            Clear list
          </button>
        </div>
      }
    >
      <div className="documents-body" onKeyDown={onKey}>
        <input
          className="input"
          type="text"
          autoFocus
          placeholder={`Filter ${recent.length} document${recent.length === 1 ? "" : "s"}…`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          aria-label="Filter documents"
        />
        <div className="documents-list" ref={listRef} role="listbox" aria-label="Recent documents">
          {list.map((p, i) => {
            const gone = missing.has(p);
            const at = openedAt[p];
            return (
              <div
                key={p}
                data-doc-index={i}
                role="option"
                aria-selected={i === idx}
                className={`documents-row ${i === idx ? "is-active" : ""} ${gone ? "is-missing" : ""}`}
                onMouseMove={() => i !== idx && setActive(i)}
                onClick={() => void (gone ? undefined : open(p))}
                title={fromStoredPath(p)}
              >
                {gone ? <FileWarning size={16} /> : <FileText size={16} />}
                <div className="documents-text">
                  <span className="recent-name">{displayName(p)}</span>
                  <span className="faint small ellipsis">{fromStoredPath(p)}</span>
                  {gone && <span className="documents-note">File not found — it was moved, renamed or deleted.</span>}
                </div>
                <span className="faint small documents-time">{at ? relativeTime(at) : ""}</span>
                {gone && (
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void locate(p);
                    }}
                  >
                    Locate…
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label={`Remove ${displayName(p)} from the list`}
                  title="Remove from list (Delete)"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(p);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          {!list.length && <p className="muted documents-empty">{recent.length ? "No documents match." : "No recent documents yet."}</p>}
        </div>
        <p className="faint small">↑↓ to move · Enter to open · Alt+Delete to remove from the list · the files themselves are never deleted</p>
      </div>
    </Modal>
  );
}
