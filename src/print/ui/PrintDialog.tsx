import { useEffect, useRef, useState } from "react";
import { Printer, X } from "lucide-react";
import type { Ticket } from "../tickets";
import {
  PRINT_MODE_LABELS,
  PRINT_OPTIONS,
  PRINT_OPTION_LABELS,
  activeImageOptions,
  isImageMode,
  type PrintSettings,
} from "../settings";
import { ensurePrintFontsLoaded, renderPreviewDataUrl } from "../render-image";
import { renderTicketsHtml } from "../classic";
import "../print.css";
import "./print-ui.css";

export interface PrintDialogProps {
  tickets: Ticket[];
  settings: PrintSettings;
  onChangeSettings(next: PrintSettings): void;
  onPrint(): Promise<void>;
  onClose(): void;
}

const PREVIEW_LIMIT = 20;

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
        const mode = settings.printing.mode;
        const enforce = mode !== "mqtt";
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
        <img key={i} src={u} alt={`Ticket ${i + 1}`} className="pr-image-preview" />
      ))}
    </div>
  );
}

function HtmlPreview({ tickets, color }: { tickets: Ticket[]; color: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.replaceChildren(renderTicketsHtml(tickets.slice(0, PREVIEW_LIMIT), color));
  }, [tickets, color]);
  return <div ref={ref} className="pr-html-preview" />;
}

export function PrintDialog({ tickets, settings, onChangeSettings, onPrint, onClose }: PrintDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const print = async () => {
    if (busy || tickets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onPrint();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        if (tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
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
  const count = tickets.length;

  return (
    <div className="pr-dialog" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title">
      <header className="pr-dialog-header">
        <div>
          <h2 id="pr-dialog-title" className="pr-dialog-title">
            Print
          </h2>
          <p className="pr-muted">
            {count === 0 ? "Nothing to print" : `${count} ticket${count === 1 ? "" : "s"}`} ·{" "}
            {PRINT_MODE_LABELS[settings.printing.mode]}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      <div className="pr-dialog-options row">
        <label className="field pr-grow">
          <span className="field-label">Tickets</span>
          <select
            className="select"
            value={settings.printOption}
            onChange={(e) => set({ printOption: e.target.value as PrintSettings["printOption"] })}
          >
            {PRINT_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {PRINT_OPTION_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
        <label className="pr-toggle pr-inline-toggle">
          <span className="field-label">Mark as finished</span>
          <input
            type="checkbox"
            className="switch"
            checked={settings.printMarkAsFinished}
            onChange={(e) => set({ printMarkAsFinished: e.target.checked })}
          />
        </label>
      </div>

      <div className="pr-preview">
        {count === 0 ? (
          <p className="pr-muted pr-empty">
            No tickets. Try including finished tasks or choosing a different ticket option.
          </p>
        ) : imageMode ? (
          <ImagePreview tickets={tickets} settings={settings} />
        ) : (
          <HtmlPreview
            tickets={tickets}
            color={settings.printing.mode === "classic" ? settings.printing.classic.color : false}
          />
        )}
        {count > PREVIEW_LIMIT && (
          <p className="pr-muted pr-more">
            Showing {PREVIEW_LIMIT} of {count} tickets.
          </p>
        )}
      </div>

      {error && <p className="pr-error">{error}</p>}

      <footer className="pr-dialog-footer row">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={print} disabled={busy || count === 0}>
          <Printer size={14} /> {busy ? "Printing…" : "Print"}
        </button>
      </footer>
    </div>
  );
}
