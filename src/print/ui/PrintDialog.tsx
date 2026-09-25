import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Copy, Printer, Scissors, Settings, X } from "lucide-react";
import type { Ticket } from "../tickets";
import {
  PRINT_MODE_LABELS,
  PRINT_OPTION_DESCRIPTIONS,
  PRINT_OPTION_LABELS,
  activeImageOptions,
  effectivePrintOption,
  isImageMode,
  printOptionsFor,
  printSettingsProblem,
  type PrintOption,
  type PrintSettings,
} from "../settings";
import { LONG_OUTPUT_LINES, MAX_PRINT_ITEMS, capTickets, countItems, estimateLines } from "../limits";
import { ensurePrintFontsLoaded, renderPreviewDataUrl } from "../render-image";
import { renderTicketsHtml } from "../classic";
import "../print.css";
import "./print-ui.css";

export type WhatToPrint = "column" | "selection";

export interface PrintDialogProps {
  /** Tickets for the current scope, before the item cap is applied. */
  tickets: Ticket[];
  settings: PrintSettings;
  onChangeSettings(next: PrintSettings): void;
  /** Print these (already capped) tickets. Throw to show the failure panel. */
  onPrint(tickets: Ticket[]): Promise<void>;
  onClose(): void;
  /** Current "What to Print" scope; the switch shows only when both scopes are offered. */
  whatToPrint?: WhatToPrint;
  availableScopes?: readonly WhatToPrint[];
  onChangeWhatToPrint?(next: WhatToPrint): void;
  /** Opens the print settings (shown when the active mode is not set up). */
  onOpenSettings?(): void;
  /** Copies error details; defaults to the browser clipboard. */
  copyText?(text: string): Promise<void>;
}

const PREVIEW_LIMIT = 20;

interface PrintFailure {
  message: string;
  details: string;
}

function toFailure(e: unknown): PrintFailure {
  if (e instanceof Error) return { message: e.message || e.name, details: e.stack || `${e.name}: ${e.message}` };
  const message = typeof e === "string" ? e : JSON.stringify(e) ?? String(e);
  return { message, details: message };
}

function ImagePreview({ tickets, settings }: { tickets: Ticket[]; settings: PrintSettings }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const image = activeImageOptions(settings);
    if (!image) return;
    setUrls(null);
    setError(null);
    void ensurePrintFontsLoaded().then(() => {
      if (cancelled) return;
      try {
        const enforce = settings.printing.mode !== "mqtt";
        setUrls(tickets.slice(0, PREVIEW_LIMIT).map((t) => renderPreviewDataUrl(t, { image, enforceMultipleOf8: enforce })));
      } catch (e) {
        setError((e as Error).message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tickets, settings]);

  if (error) return <p className="pr-error">Preview failed: {error}</p>;
  if (!urls) return <p className="pr-muted">Rendering preview…</p>;
  return (
    <div className="pr-image-previews">
      {urls.map((u, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div className="pr-cut" aria-hidden>
              <Scissors size={12} />
            </div>
          )}
          <img src={u} alt={`Ticket ${i + 1}`} className="pr-image-preview" />
        </Fragment>
      ))}
    </div>
  );
}

function HtmlPreview({ tickets, settings }: { tickets: Ticket[]; settings: PrintSettings }) {
  const ref = useRef<HTMLDivElement>(null);
  const cfg = settings.printing.mode === "classic" ? settings.printing.classic : false;
  useEffect(() => {
    ref.current?.replaceChildren(renderTicketsHtml(tickets.slice(0, PREVIEW_LIMIT), cfg));
  }, [tickets, cfg]);
  return <div ref={ref} className="pr-html-preview" />;
}

function FailurePanel({
  failure,
  onDismiss,
  onRetry,
  copyText,
}: {
  failure: PrintFailure;
  onDismiss(): void;
  onRetry(): void;
  copyText(text: string): Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pr-failure" role="alert">
      <div className="pr-failure-head">
        <AlertTriangle size={16} />
        <strong>Print Failed</strong>
      </div>
      <p className="pr-error">{failure.message}</p>
      <details className="pr-failure-details">
        <summary>
          <ChevronRight size={12} className="pr-chevron" /> Error Details
        </summary>
        <pre className="pr-failure-pre">{failure.details}</pre>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void copyText(failure.details).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          <Copy size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </details>
      <div className="row pr-failure-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>
          Try Again
        </button>
      </div>
    </div>
  );
}

function InlineToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="pr-toggle pr-check">
      <span>{label}</span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const defaultCopy = (text: string) => navigator.clipboard.writeText(text);

export function PrintDialog({
  tickets: allTickets,
  settings,
  onChangeSettings,
  onPrint,
  onClose,
  whatToPrint,
  availableScopes = [],
  onChangeWhatToPrint,
  onOpenSettings,
  copyText = defaultCopy,
}: PrintDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PrintFailure | null>(null);

  const { tickets, capped } = useMemo(() => capTickets(allTickets, MAX_PRINT_ITEMS), [allTickets]);
  const items = countItems(tickets);
  const lines = useMemo(() => estimateLines(tickets), [tickets]);
  const problem = printSettingsProblem(settings);
  const mode = settings.printing.mode;
  const option = effectivePrintOption(settings);
  const taskOption = option === "task_tickets" || option === "task_tickets_recursive";

  const print = async () => {
    if (busy || tickets.length === 0 || problem) return;
    setBusy(true);
    setFailure(null);
    try {
      await onPrint(tickets);
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  // Keep the latest handlers reachable from the key listener.
  const printRef = useRef(print);
  printRef.current = print;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SUMMARY") return;
        e.preventDefault();
        e.stopPropagation();
        void printRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const set = (patch: Partial<PrintSettings>) => onChangeSettings({ ...settings, ...patch });
  const imageMode = isImageMode(settings);
  const showScopeSwitch = availableScopes.length > 1 && whatToPrint && onChangeWhatToPrint;

  return (
    <div className="pr-dialog" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title">
      <header className="pr-dialog-header">
        <div>
          <h2 id="pr-dialog-title" className="pr-dialog-title">
            Print
          </h2>
          <p className="pr-muted">
            {tickets.length === 0 ? "Nothing to print" : `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`} ·{" "}
            {PRINT_MODE_LABELS[mode]}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {problem && (
        <div className="pr-banner" role="status">
          <AlertTriangle size={14} />
          <span className="pr-grow">{problem}</span>
          {onOpenSettings && (
            <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
              <Settings size={12} /> Open Print Settings
            </button>
          )}
        </div>
      )}

      <div className="pr-dialog-body">
        <div className="pr-dialog-side stack-v">
          {showScopeSwitch && (
            <div className="field">
              <span className="field-label">What to Print</span>
              <div className="tabs pr-segmented" role="radiogroup" aria-label="What to Print">
                {(["column", "selection"] as const)
                  .filter((w) => availableScopes.includes(w))
                  .map((w) => (
                    <button
                      key={w}
                      type="button"
                      role="radio"
                      aria-checked={whatToPrint === w}
                      className={`tab ${whatToPrint === w ? "tab-active" : ""}`}
                      onClick={() => onChangeWhatToPrint(w)}
                    >
                      {w === "column" ? "Column" : "Selection"}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="field" role="radiogroup" aria-label="Tickets">
            <span className="field-label">Tickets</span>
            {printOptionsFor(mode).map((o: PrintOption) => (
              <label key={o} className={`pr-option ${option === o ? "is-active" : ""}`}>
                <input type="radio" name="pr-option" checked={option === o} onChange={() => set({ printOption: o })} />
                <span className="pr-option-text">
                  <span>{PRINT_OPTION_LABELS[o]}</span>
                  <span className="pr-option-desc">{PRINT_OPTION_DESCRIPTIONS[o]}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="stack-v pr-checks">
            {taskOption && (
              <InlineToggle label="Print Breadcrumb" checked={settings.printBreadcrumb} onChange={(v) => set({ printBreadcrumb: v })} />
            )}
            <InlineToggle label="Print Finished Tasks" checked={settings.printFinishedTasks} onChange={(v) => set({ printFinishedTasks: v })} />
            <InlineToggle label="Mark as finished" checked={settings.printMarkAsFinished} onChange={(v) => set({ printMarkAsFinished: v })} />
          </div>
        </div>

        <div className="pr-preview">
          {tickets.length === 0 ? (
            <p className="pr-muted pr-empty">No tickets. Try including finished tasks or choosing a different ticket option.</p>
          ) : imageMode ? (
            <ImagePreview tickets={tickets} settings={settings} />
          ) : (
            <HtmlPreview tickets={tickets} settings={settings} />
          )}
          {tickets.length > PREVIEW_LIMIT && (
            <p className="pr-muted pr-more">
              Showing {PREVIEW_LIMIT} of {tickets.length} tickets.
            </p>
          )}
        </div>
      </div>

      {(capped || lines > LONG_OUTPUT_LINES) && (
        <div className="pr-notices">
          {capped && <p className="pr-warning">Limited to {MAX_PRINT_ITEMS} items for performance</p>}
          {lines > LONG_OUTPUT_LINES && (
            <p className="pr-warning">This prints about {lines} lines — check the preview before printing.</p>
          )}
        </div>
      )}

      {failure && (
        <FailurePanel failure={failure} onDismiss={() => setFailure(null)} onRetry={() => void print()} copyText={copyText} />
      )}

      <footer className="pr-dialog-footer row">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={print} disabled={busy || tickets.length === 0 || !!problem}>
          <Printer size={14} /> {busy ? "Printing…" : `Print (${items} item${items === 1 ? "" : "s"})`}
        </button>
      </footer>
    </div>
  );
}
