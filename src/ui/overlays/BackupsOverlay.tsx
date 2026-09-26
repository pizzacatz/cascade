import { useEffect, useMemo, useState } from "react";
import { History, CheckSquare, Square, Folder, FileText } from "lucide-react";
import { Modal } from "./Modal";
import { useApp } from "../../state/store";
import { closeOverlay } from "../../state/overlays";
import {
  countItems,
  diffDocs,
  formatBackupTime,
  listDocumentBackups,
  loadBackup,
  openBackupAsCopy,
  relativeAge,
  restoreBackup,
  type LoadedBackup,
} from "../../state/backups";
import type { BackupEntry } from "../../platform";
import type { Doc, Item } from "../../model/types";
import { ROOT_SPACE_ID } from "../../model/types";
import { buildIndex, childrenOf, visibleSpaces } from "../../model/tree";

const PREVIEW_LINES = 80;

function formatSize(n: number | null): string {
  if (n === null) return "";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read-only outline of the backup's spaces, two levels deep. */
function OutlinePreview({ doc, current }: { doc: Doc; current: Doc }) {
  const ix = useMemo(() => buildIndex(doc), [doc]);
  const rows: { item: Item; depth: number; mark: "back" | "changed" | null }[] = [];
  const spaces = visibleSpaces(doc.config.spaces);
  const walk = (parentId: string, depth: number) => {
    for (const it of childrenOf(ix, parentId)) {
      if (rows.length >= PREVIEW_LINES) return;
      const now = current.items[it.id];
      const mark = !now ? "back" : now.text !== it.text || now.finished !== it.finished || now.parentId !== it.parentId ? "changed" : null;
      rows.push({ item: it, depth, mark });
      if (depth < 2) walk(it.id, depth + 1);
    }
  };
  const out: JSX.Element[] = [];
  for (const sp of spaces.length ? spaces : [{ id: ROOT_SPACE_ID, name: "Home" }]) {
    if (rows.length >= PREVIEW_LINES) break;
    const start = rows.length;
    walk(sp.id, 0);
    out.push(
      <div key={sp.id} className="backup-outline-space">
        <div className="settings-subhead">{sp.name}</div>
        {rows.slice(start).map(({ item, depth, mark }) => (
          <div key={item.id} className={`backup-outline-row ${item.type === "task" && item.finished ? "is-finished" : ""}`} style={{ paddingLeft: depth * 16 }}>
            {item.type === "task" ? item.finished ? <CheckSquare size={13} /> : <Square size={13} /> : item.type === "folder" ? <Folder size={13} /> : <FileText size={13} />}
            <span className="grow ellipsis">{item.type === "separator" ? "———" : item.text || "Untitled"}</span>
            {mark === "back" && <span className="badge">restored</span>}
            {mark === "changed" && <span className="badge">changed</span>}
          </div>
        ))}
        {rows.length === start && <div className="muted small">(empty)</div>}
      </div>,
    );
  }
  return <div className="backup-outline">{out}</div>;
}

export function BackupsOverlay() {
  const doc = useApp((s) => s.doc);
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDocumentBackups()
      .then(setEntries)
      .catch((e) => {
        setEntries([]);
        setError(String(e));
      });
  }, []);

  const entry = entries?.[index] ?? null;
  useEffect(() => {
    setLoaded(null);
    if (!entry) return;
    let live = true;
    loadBackup(entry)
      .then((b) => live && (setLoaded(b), setError(null)))
      .catch((e) => live && setError(`This backup could not be read: ${(e as Error).message ?? e}`));
    return () => {
      live = false;
    };
  }, [entry]);

  const diff = useMemo(() => (doc && loaded ? diffDocs(doc, loaded.doc) : null), [doc, loaded]);
  const counts = useMemo(() => (loaded ? countItems(loaded.doc) : null), [loaded]);
  const nowCounts = useMemo(() => (doc ? countItems(doc) : null), [doc]);
  const identical = !!diff && !diff.added.length && !diff.removed.length && !diff.changed.length;

  const restore = () => {
    if (!loaded || identical) return;
    if (restoreBackup(loaded)) closeOverlay();
  };
  const openCopy = async () => {
    if (!loaded) return;
    closeOverlay();
    await openBackupAsCopy(loaded);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!entries?.length) return;
      if (e.key === "ArrowDown") setIndex((i) => Math.min(entries.length - 1, i + 1));
      else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
      else if (e.key === "Enter") restore();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <Modal
      title="Restore from backup"
      icon={<History size={16} />}
      width={860}
      height="min(640px, 90vh)"
      footer={
        <>
          <span className="muted grow small">↑↓ choose · Enter restore · Restoring can be undone with Ctrl+Z</span>
          <button className="btn" disabled={!loaded} onClick={() => void openCopy()}>
            Open as copy
          </button>
          <button className="btn btn-primary" disabled={!loaded || identical} onClick={restore}>
            Restore
          </button>
        </>
      }
    >
      {entries === null ? (
        <p className="muted">Looking for backups…</p>
      ) : !entries.length ? (
        <div className="stack-v">
          <p>No backups of this document yet.</p>
          <p className="field-hint">
            Cascade keeps a copy of each document when it is opened and then at most every 10 minutes while you edit (the last 10 copies,
            for up to 5 days). Edits made with cascade-cli or the MCP server are backed up too.
          </p>
          {error && <p className="field-hint">{error}</p>}
        </div>
      ) : (
        <div className="split-pane backups-pane">
          <div className="split-list" role="listbox" aria-label="Backups">
            {entries.map((b, i) => (
              <div
                key={b.id}
                role="option"
                aria-selected={i === index}
                className={`rule-row backup-row ${i === index ? "is-active" : ""}`}
                onClick={() => setIndex(i)}
                onDoubleClick={restore}
              >
                <span className="grow ellipsis">{formatBackupTime(b.time)}</span>
                <span className="muted small">{relativeAge(b.time)}</span>
              </div>
            ))}
          </div>
          <div className="split-detail stack-v">
            {error && <p className="field-hint">{error}</p>}
            {entry && (
              <div className="row wrap">
                <strong>{formatBackupTime(entry.time)}</strong>
                <span className="muted">{relativeAge(entry.time)}</span>
                {entry.size !== null && <span className="badge">{formatSize(entry.size)}</span>}
              </div>
            )}
            {loaded && counts && nowCounts && diff && (
              <>
                <div className="stats-grid">
                  <div>
                    <strong>{counts.items}</strong>
                    <span className="muted small">items (now {nowCounts.items})</span>
                  </div>
                  <div>
                    <strong>
                      {counts.finished}/{counts.tasks}
                    </strong>
                    <span className="muted small">tasks done (now {nowCounts.finished}/{nowCounts.tasks})</span>
                  </div>
                  <div>
                    <strong>{diff.removed.length}</strong>
                    <span className="muted small">deleted since, would come back</span>
                  </div>
                  <div>
                    <strong>
                      {diff.added.length} · {diff.changed.length}
                    </strong>
                    <span className="muted small">added · changed since</span>
                  </div>
                </div>
                {identical ? (
                  <p className="field-hint">This backup matches the current document.</p>
                ) : (
                  <p className="field-hint">
                    Restoring replaces the document with this backup: {diff.added.length} item{diff.added.length === 1 ? "" : "s"} added since
                    would be removed and {diff.changed.length} changed item{diff.changed.length === 1 ? "" : "s"} reverted. Or open it as a
                    separate copy.
                  </p>
                )}
                <OutlinePreview doc={loaded.doc} current={doc!} />
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
