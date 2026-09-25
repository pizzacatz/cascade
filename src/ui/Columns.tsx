import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import type { Item } from "../model/types";
import { TRASH_SPACE_ID, isContainerType } from "../model/types";
import { childrenOf } from "../model/tree";
import { columnProgress } from "../model/progression";
import { get, set, useApp } from "../state/store";
import { indexOf, statsOf, styleFor } from "../state/derived";
import { columnIds, selectColumnItem } from "../state/nav";
import { emptyTrash, exitEdit } from "../state/items";
import { ConvertColumn, CreateRow, EditFooter, type CreateHint } from "./CreateRow";
import { confirmAction, openOverlay } from "../state/overlays";
import { Icon } from "./icons";
import { ItemRow } from "./ItemRow";
import { ProgressPie, ProgressRing, usesProgressPie } from "./ProgressRing";

export function ColumnsView() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const minWidth = useApp((s) => s.prefs.minColumnWidth);
  const cols = useApp((s) => columnIds(s).join("|")).split("|");
  const offset = useApp((s) => s.columnOffset);
  const focused = useApp((s) => s.view.focusedView === "columns");

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(1, Math.floor((width || minWidth) / minWidth));
  const colWidth = width ? width / fit : minWidth;
  const maxOffset = Math.max(0, cols.length - fit);

  // Keep the deepest column in view whenever the path changes. When only one
  // column fits, show the column holding the selection rather than its (empty)
  // child column.
  const key = cols.join("|");
  const selParent = useApp((s) => {
    const id = s.view.columnsSelection[0];
    return id ? s.doc?.items[id]?.parentId ?? null : null;
  });
  useEffect(() => {
    let off = Math.max(0, cols.length - fit);
    if (fit === 1 && selParent) {
      const i = cols.indexOf(selParent);
      if (i >= 0) off = i;
    }
    set({ columnOffset: off });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fit, selParent]);



  const eff = Math.min(offset, maxOffset);

  const onWheel = (e: React.WheelEvent) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (Math.abs(dx) < 20) return;
    set({ columnOffset: Math.min(maxOffset, Math.max(0, eff + (dx > 0 ? 1 : -1))) });
  };

  return (
    <section className={`columns-view ${focused ? "is-focused" : ""}`} aria-label="Columns" onWheel={onWheel}>
      <div className="columns-viewport" ref={ref}>
        <div className="columns-strip" style={{ transform: `translateX(${-eff * colWidth}px)` }}>
          {cols.map((id, i) => (
            <ColumnOrConvert key={id} columnId={id} openChildId={cols[i + 1]} width={colWidth} />
          ))}
        </div>
      </div>
      {eff > 0 && (
        <button className="columns-scroll left" aria-label="Scroll left" onClick={() => set({ columnOffset: eff - 1 })}>
          <ChevronLeft size={16} />
        </button>
      )}
      {eff < maxOffset && (
        <button className="columns-scroll right" aria-label="Scroll right" onClick={() => set({ columnOffset: eff + 1 })}>
          <ChevronRight size={16} />
        </button>
      )}
    </section>
  );
}

function ColumnOrConvert(props: { columnId: string; openChildId?: string; width: number }) {
  const leaf = useApp((s) => {
    const it = s.doc?.items[props.columnId];
    return !!it && !isContainerType(it.type);
  });
  return leaf ? <ConvertColumn itemId={props.columnId} width={props.width} /> : <Column {...props} />;
}

function Column({ columnId, openChildId, width }: { columnId: string; openChildId?: string; width: number }) {
  const doc = useApp((s) => s.doc);
  const hideHeader = useApp((s) => s.prefs.hideColumnHeaders);
  const editingHere = useApp((s) => !!s.edit && s.doc?.items[s.edit.itemId]?.parentId === columnId && s.view.focusedView === "columns");
  const busy = useApp((s) => !!s.edit || s.drag?.status === "active");
  const previewTop = useApp((s) => s.createPreview?.columnStart === columnId);
  const hideButtons = useApp((s) => s.prefs.hideColumnHeaderButtons);
  // Arrow from the open folder row into the next column, following scrolling.
  const colRef = useRef<HTMLDivElement>(null);
  const [connector, setConnector] = useState<{ y: number; cls: string } | null>(null);
  const measureConnector = useCallback(() => {
    const col = colRef.current;
    const row = col?.querySelector<HTMLElement>(".item-row.is-open");
    const body = col?.querySelector<HTMLElement>(".column-body");
    if (!col || !row || !body) return setConnector(null);
    const c = col.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (mid < b.top || mid > b.bottom) return setConnector(null);
    setConnector({ y: mid - c.top, cls: [...row.classList].find((k) => k.startsWith("c-")) ?? "" });
  }, []);
  // The column holding the selection / edited item / create spot is "active".
  const active = useApp((s) => {
    if (s.view.focusedView !== "columns") return null;
    if (s.createTarget?.view === "columns" && s.createTarget.parentId === columnId) return "select";
    const id = s.edit?.itemId ?? s.view.columnsSelection[0];
    return id && s.doc?.items[id]?.parentId === columnId ? (s.edit ? "edit" : "select") : null;
  });
  const headerStyle = useApp((s) => {
    const f = s.doc?.items[columnId];
    return f ? styleFor(s, f).textColor : null;
  });
  const hasSelection = useApp((s) => s.view.columnsSelection.length > 0);
  const showProgress = useApp((s) => s.prefs.columnsProgressBar !== "hide");
  const isTarget = useApp((s) => s.createTarget?.view === "columns" && s.createTarget.parentId === columnId);
  const dropEnd = useApp((s) => {
    const t = s.drag?.status === "active" ? s.drag.target : null;
    return (t?.kind === "column-end" && t.parentId === columnId) || (t?.kind === "into" && t.itemId === columnId);
  });
  const ix = indexOf(doc);
  const folder: Item | undefined = ix.items[columnId];
  const space = folder ? null : ix.spaces.find((x) => x.id === columnId);
  const kids = childrenOf(ix, columnId);
  const progress = showProgress && doc ? columnProgress(ix, statsOf(doc), columnId, doc.config.progressionMode) : -1;
  const isTrash = columnId === TRASH_SPACE_ID;
  useLayoutEffect(measureConnector, [measureConnector, openChildId, kids.length, width, doc]);

  const title = folder ? folder.text || "Untitled" : space?.name ?? "";
  const icon = folder ? folder.icon : space?.icon;

  const onHeaderMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openOverlay({
      kind: "context",
      x: r.left,
      y: r.bottom + 4,
      target: { type: "surface", view: "columns", parentId: columnId },
    });
  };

  // Clicking empty column space only ends editing; it never creates anything.
  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    if (get().edit) exitEdit();
  };
  const isSpaceRoot = ix.spaceIds.has(columnId);
  const showCreateRow = !busy && !isTrash && (kids.length > 0 || isSpaceRoot || hasSelection || isTarget);
  const hint: CreateHint = kids.length ? null : isTarget ? "enter" : isSpaceRoot && !hasSelection ? "pulse" : "ctrl-enter";

  const onBodyContext = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    openOverlay({ kind: "context", x: e.clientX, y: e.clientY, target: { type: "surface", view: "columns", parentId: columnId } });
  };

  return (
    <div ref={colRef} className={`column ${isTarget ? "is-create-target" : ""} ${active ? `is-active is-active-${active}` : ""}`} style={{ width }} role="group" aria-label={title}>
      {connector && <span className={`column-connector ${connector.cls}`} style={{ top: connector.y }} aria-hidden />}
      {!hideHeader && (
        <header
          className="column-header"
          onMouseDown={() => folder && selectColumnItem(folder.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onHeaderMenu(e);
          }}
        >
          <span className="column-icon" title={progress >= 0 ? `${Math.round(progress * 100)} %` : undefined}>
            {folder && usesProgressPie(folder.type, folder.icon) ? (
              <ProgressPie value={Math.max(0, progress)} size={15} />
            ) : (
              <Icon name={icon} size={15} />
            )}
          </span>
          <span className={`column-title ${headerStyle ? `has-color c-${headerStyle}` : ""}`}>{title}</span>
          {progress >= 0 && !(folder && usesProgressPie(folder.type, folder.icon)) && (
            <span className="column-progress" title={`${Math.round(progress * 100)} %`}>
              <ProgressRing value={progress} size={14} />
            </span>
          )}
          {!hideButtons && (
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Column menu" onMouseDown={(e) => e.stopPropagation()} onClick={onHeaderMenu}>
              <MoreHorizontal size={15} />
            </button>
          )}
        </header>
      )}
      {showProgress && progress >= 0 && hideHeader && <div className="column-bar" style={{ width: `${progress * 100}%` }} />}
      <div
        className={`column-body ${dropEnd ? "drop-end" : ""} ${previewTop ? "preview-top" : ""}`}
        data-column-id={columnId}
        onMouseDown={onBodyMouseDown}
        onContextMenu={onBodyContext}
        onScroll={measureConnector}
        role="tree"
      >
        {kids.map((it) => (
          <ItemRow key={it.id} item={it} view="columns" open={it.id === openChildId && isContainerType(it.type)} />
        ))}
        {showCreateRow && <CreateRow target={{ view: "columns", parentId: columnId }} focused={isTarget} hint={hint} />}
        {editingHere && <EditFooter allowChild />}
        {kids.length === 0 && isTrash && <div className="column-empty">Trash is empty</div>}
      </div>
      {isTrash && (
        <footer className="trash-footer">
          <p>Deleted items from other spaces appear here. Deleting from Trash removes them permanently.</p>
          <button
            className="btn btn-sm"
            disabled={!kids.length}
            onClick={() =>
              confirmAction({
                title: "Empty Trash?",
                message: `This permanently deletes ${kids.length} item${kids.length === 1 ? "" : "s"} and everything inside them.`,
                confirmLabel: "Empty Trash",
                danger: true,
                onConfirm: emptyTrash,
              })
            }
          >
            <Trash2 size={14} /> Empty Trash
          </button>
        </footer>
      )}
    </div>
  );
}

