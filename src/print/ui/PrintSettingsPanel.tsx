import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bluetooth, RefreshCw, RotateCcw } from "lucide-react";
import type { BluetoothConnectionStatus, BluetoothPrinterInfo, PrintBackend, PrinterInfo } from "../backend";
import {
  DEFAULT_MQTT_TEMPLATE,
  PRINTER_COLUMNS,
  PRINTER_LANGUAGES,
  PRINT_MODES,
  PRINT_MODE_LABELS,
  PRINT_OPTIONS,
  PRINT_OPTION_LABELS,
  normalizePrintSettings,
  type AdvancedOptions,
  type ImageOptions,
  type PrintSettings,
  type PrintMode,
  type PrinterLanguage,
} from "../settings";
import { codepageMappingsFor, printerModels, resolveCodepageMapping, type PrinterModelChoice } from "../encode";
import { ensurePrintFontsLoaded, renderPreviewDataUrl } from "../render-image";
import type { Ticket } from "../tickets";
import "./print-ui.css";

export interface PrintSettingsPanelProps {
  settings: PrintSettings;
  onChange(next: PrintSettings): void;
  backend: PrintBackend;
}

// ---------------------------------------------------------------------------
// Small form primitives
// ---------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <label className="pr-toggle">
      <span className="pr-toggle-text">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange(v: number): void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      className="input"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="tabs pr-segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`tab${value === o.value ? " tab-active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pr-section stack-v">
      <h3 className="pr-section-title">{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Composite editors
// ---------------------------------------------------------------------------

function PrinterPicker({
  backend,
  value,
  onChange,
}: {
  backend: PrintBackend;
  value: string;
  onChange(v: string): void;
}) {
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setPrinters(null);
    setError(null);
    try {
      setPrinters(await backend.getPrinters());
    } catch (e) {
      setError(`Failed to load printers: ${(e as Error).message}`);
      setPrinters([]);
    }
  }, [backend]);
  useEffect(() => {
    void load();
  }, [load]);

  const known = printers?.some((p) => p.name === value);
  return (
    <Field label="Printer" hint={!backend.native ? "Receipt printing requires the desktop app." : error ?? undefined}>
      <div className="row">
        <select className="select pr-grow" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{printers === null ? "Loading…" : printers.length ? "Choose a printer" : "No printers found"}</option>
          {value && printers && !known && <option value={value}>{value} (not found)</option>}
          {printers?.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.is_default ? " (default)" : ""}
              {p.state && p.state !== "READY" && p.state !== "UNKNOWN" ? ` — ${p.state.toLowerCase()}` : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost" onClick={load} title="Refresh printers" aria-label="Refresh printers">
          <RefreshCw size={14} />
        </button>
      </div>
    </Field>
  );
}

function ImageOptionsEditor({ image, onChange }: { image: ImageOptions; onChange(v: ImageOptions): void }) {
  const set = (patch: Partial<ImageOptions>) => onChange({ ...image, ...patch });
  const pad = (k: keyof ImageOptions["padding"], v: number) => set({ padding: { ...image.padding, [k]: v } });
  const fs = (k: keyof ImageOptions["fontSizes"], v: number) => set({ fontSizes: { ...image.fontSizes, [k]: v } });
  return (
    <Section title="Image">
      <div className="pr-grid">
        <Field label="Paper width (mm)">
          <NumberInput value={image.widthMm} min={20} max={200} onChange={(v) => set({ widthMm: v })} />
        </Field>
        <Field label="Resolution (DPI)">
          <NumberInput value={image.dpi} min={72} max={600} onChange={(v) => set({ dpi: v })} />
        </Field>
      </div>
      <div className="pr-grid pr-grid-4">
        {(["top", "bottom", "left", "right"] as const).map((k) => (
          <Field key={k} label={`Padding ${k} (mm)`}>
            <NumberInput value={image.padding[k]} min={0} max={50} step={0.5} onChange={(v) => pad(k, v)} />
          </Field>
        ))}
      </div>
      <div className="pr-grid pr-grid-5">
        {(["breadcrumb", "title", "heading", "task", "text"] as const).map((k) => (
          <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} (px)`}>
            <NumberInput value={image.fontSizes[k]} min={8} max={96} onChange={(v) => fs(k, v)} />
          </Field>
        ))}
      </div>
      <Toggle
        label="Prevent trimming"
        hint="Adds a thin line at the bottom so drivers keep the bottom padding."
        checked={image.preventTrim}
        onChange={(v) => set({ preventTrim: v })}
      />
    </Section>
  );
}

function AdvancedEditor({
  advanced,
  onChange,
  showImageMode,
}: {
  advanced: AdvancedOptions;
  onChange(v: AdvancedOptions): void;
  showImageMode: boolean;
}) {
  const set = (patch: Partial<AdvancedOptions>) => onChange({ ...advanced, ...patch });
  return (
    <Section title="Advanced">
      <Toggle
        label="Override printer settings"
        hint="Use these values instead of the printer model's defaults."
        checked={advanced.enabled}
        onChange={(v) => set({ enabled: v })}
      />
      {advanced.enabled && (
        <div className="pr-grid">
          <Field label="Command language">
            <select
              className="select"
              value={advanced.language}
              onChange={(e) => set({ language: e.target.value as PrinterLanguage })}
            >
              {PRINTER_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Characters per line">
            <select
              className="select"
              value={advanced.columns}
              onChange={(e) => set({ columns: Number(e.target.value) as AdvancedOptions["columns"] })}
            >
              {PRINTER_COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lines to feed before cutting">
            <NumberInput value={advanced.feedBeforeCut} min={0} max={20} onChange={(v) => set({ feedBeforeCut: v })} />
          </Field>
          <Field label="Newline">
            <select
              className="select"
              value={advanced.newline === "\n" ? "lf" : "crlf"}
              onChange={(e) => set({ newline: e.target.value === "lf" ? "\n" : "\r\n" })}
            >
              <option value="lf">LF (\n)</option>
              <option value="crlf">CR LF (\r\n)</option>
            </select>
          </Field>
          {showImageMode && (
            <Field label="Image encoding">
              <select
                className="select"
                value={advanced.imageMode}
                onChange={(e) => set({ imageMode: e.target.value as AdvancedOptions["imageMode"] })}
              >
                <option value="column">Column</option>
                <option value="raster">Raster</option>
              </select>
            </Field>
          )}
        </div>
      )}
    </Section>
  );
}

const LANGUAGE_LABELS: Record<PrinterLanguage, string> = {
  "esc-pos": "ESC/POS",
  "star-prnt": "StarPRNT",
  "star-line": "Star Line",
};

function CodepageSelect({
  language,
  value,
  onChange,
}: {
  language: PrinterLanguage;
  value: string;
  onChange(v: string): void;
}) {
  const resolved = resolveCodepageMapping(language, value);
  return (
    <Field label="Codepage mapping" hint="Which character sets the printer understands.">
      <select className="select" value={resolved} onChange={(e) => onChange(e.target.value)}>
        {codepageMappingsFor(language).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </Field>
  );
}

function BluetoothPane({
  settings,
  backend,
  update,
}: {
  settings: PrintSettings;
  backend: PrintBackend;
  update(fn: (s: PrintSettings) => void): void;
}) {
  const bt = settings.printing.bluetooth;
  const [status, setStatus] = useState<BluetoothConnectionStatus | null>(null);
  const [found, setFound] = useState<BluetoothPrinterInfo[] | null>(null);
  const [busy, setBusy] = useState<"scan" | "connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await backend.bluetoothStatus());
    } catch {
      setStatus(null);
    }
  }, [backend]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scan = async () => {
    setBusy("scan");
    setError(null);
    try {
      setFound(await backend.scanBluetooth());
    } catch (e) {
      setError(`Scan failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const connect = async (p: BluetoothPrinterInfo) => {
    setBusy("connect");
    setError(null);
    try {
      const info = await backend.connectBluetooth(p.id);
      update((s) => {
        const b = s.printing.bluetooth;
        b.deviceId = info.id;
        b.deviceName = info.name;
        if ((PRINTER_LANGUAGES as readonly string[]).includes(info.language)) b.language = info.language as PrinterLanguage;
        b.codepageMapping = info.codepage_mapping || b.codepageMapping;
      });
    } catch (e) {
      setError(`Connection failed (${p.name}): ${(e as Error).message}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await backend.disconnectBluetooth();
      update((s) => {
        s.printing.bluetooth.deviceId = "";
        s.printing.bluetooth.deviceName = "";
      });
    } catch (e) {
      setError(`Disconnection failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const connected = status?.is_connected ? status.connected_device : null;
  return (
    <Section title="Bluetooth printer">
      {!backend.native && <p className="field-hint">Receipt printing requires the desktop app.</p>}
      <div className="pr-status">
        <Bluetooth size={14} />
        {connected ? (
          <span>Connected to {connected.name}</span>
        ) : bt.deviceName ? (
          <span className="pr-muted">Last connected: {bt.deviceName} (disconnected)</span>
        ) : (
          <span className="pr-muted">No printer connected</span>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={scan} disabled={busy !== null || !backend.native}>
          {busy === "scan" ? "Scanning…" : "Scan for printers"}
        </button>
        {connected && (
          <button type="button" className="btn btn-ghost" onClick={disconnect} disabled={busy !== null}>
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
      </div>
      {found && found.length === 0 && (
        <p className="field-hint">No Bluetooth printers found. Make sure the printer is on and nearby.</p>
      )}
      {found && found.length > 0 && (
        <ul className="pr-list">
          {found.map((p) => (
            <li key={p.id} className="pr-list-item">
              <span className="pr-grow">
                <span>{p.name}</span>
                <span className="pr-muted">
                  {" "}
                  · {LANGUAGE_LABELS[p.language as PrinterLanguage] ?? p.language} ·{" "}
                  {p.rssi === null ? "Unknown signal" : `${p.rssi} dBm`}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => connect(p)}
              >
                {busy === "connect" ? "Connecting…" : "Connect"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="pr-error">{error}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Live sample preview
// ---------------------------------------------------------------------------

const SAMPLE_TICKET: Ticket = {
  breadcrumb: ["Home", "Errands"],
  title: "Saturday",
  blocks: [
    { kind: "heading", text: "Groceries", finished: false, depth: 0 },
    { kind: "task", text: "Buy oat milk", finished: false, depth: 0 },
    { kind: "task", text: "Pick up bread", finished: true, depth: 0 },
    { kind: "separator", text: "", finished: false, depth: 0 },
    { kind: "task", text: "Return library books", finished: false, depth: 1 },
  ],
  taskIds: [],
};

function SamplePreview({ image, enforceMultipleOf8 }: { image: ImageOptions; enforceMultipleOf8: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Debounce so dragging a number input doesn't re-render on every step.
    const t = setTimeout(() => {
      void ensurePrintFontsLoaded().then(() => {
        if (cancelled) return;
        try {
          setUrl(renderPreviewDataUrl(SAMPLE_TICKET, { image, enforceMultipleOf8 }));
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        }
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [image, enforceMultipleOf8]);
  return (
    <div className="pr-sample">
      <span className="field-label">Preview</span>
      {error ? <p className="pr-error">{error}</p> : url ? <img src={url} alt="Sample ticket" /> : <p className="pr-muted">Rendering…</p>}
    </div>
  );
}

function ImageWithPreview({
  image,
  enforceMultipleOf8,
  onChange,
}: {
  image: ImageOptions;
  enforceMultipleOf8: boolean;
  onChange(v: ImageOptions): void;
}) {
  return (
    <div className="pr-image-with-preview">
      <div className="stack-v">
        <ImageOptionsEditor image={image} onChange={onChange} />
      </div>
      <SamplePreview image={image} enforceMultipleOf8={enforceMultipleOf8} />
    </div>
  );
}

/** Printer models grouped by brand (the first word of the model name). */
function groupModelsByBrand(models: PrinterModelChoice[]): [string, PrinterModelChoice[]][] {
  const groups = new Map<string, PrinterModelChoice[]>();
  for (const m of models) {
    const brand = m.name.split(/\s+/)[0] || "Other";
    const list = groups.get(brand) ?? [];
    list.push(m);
    groups.set(brand, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type SettingsTab = "mode" | PrintMode;

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "mode", label: "Mode" },
  { id: "classic", label: "System Print" },
  { id: "receipt_printer", label: "USB" },
  { id: "bluetooth_printer", label: "Bluetooth" },
  { id: "lp_printer", label: "Mac Alternative (lp)" },
  { id: "mqtt", label: "MQTT" },
];

const MODE_HINTS: Record<PrintMode, string> = {
  classic: "Print through the system print dialog on any printer.",
  receipt_printer: "Send ESC/POS or StarPRNT commands to a USB receipt printer.",
  lp_printer: "Send each ticket to CUPS as an image with lp.",
  bluetooth_printer: "Print to a paired Bluetooth receipt printer.",
  mqtt: "Publish each ticket as an image to an MQTT topic.",
};

function UseModeRow({ mode, active, onUse }: { mode: PrintMode; active: boolean; onUse(): void }) {
  return (
    <div className="pr-status">
      {active ? (
        <span className="pr-muted">This is the active printing mode.</span>
      ) : (
        <>
          <span className="pr-muted pr-grow">Not the active mode.</span>
          <button type="button" className="btn btn-sm" onClick={onUse}>
            Use {PRINT_MODE_LABELS[mode]}
          </button>
        </>
      )}
    </div>
  );
}

export function PrintSettingsPanel({ settings, onChange, backend }: PrintSettingsPanelProps) {
  const update = useCallback(
    (fn: (s: PrintSettings) => void) => {
      const next = structuredClone(settings);
      fn(next);
      onChange(normalizePrintSettings(next));
    },
    [settings, onChange],
  );
  const [tab, setTab] = useState<SettingsTab>("mode");
  const p = settings.printing;
  const modelGroups = useMemo(() => groupModelsByBrand(printerModels()), []);
  const useMode = (m: PrintMode) => update((s) => (s.printing.mode = m));
  const pane = (mode: PrintMode, body: ReactNode) => (
    <Section title={TABS.find((t) => t.id === mode)!.label}>
      <UseModeRow mode={mode} active={p.mode === mode} onUse={() => useMode(mode)} />
      {body}
    </Section>
  );

  return (
    <div className="pr-settings-tabs">
      <nav className="pr-vtabs" role="tablist" aria-orientation="vertical" aria-label="Print settings">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`pr-vtab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
            {t.id === p.mode && <span className="pr-vtab-dot" title="Active mode" />}
          </button>
        ))}
      </nav>

      <div className="pr-settings-pane pr-settings stack-v" role="tabpanel">
        {tab === "mode" && (
          <>
            <Section title="Printing mode">
              <div className="stack-v" role="radiogroup" aria-label="Printing mode">
                {PRINT_MODES.map((m) => (
                  <label key={m} className={`pr-option ${p.mode === m ? "is-active" : ""}`}>
                    <input type="radio" name="pr-mode" checked={p.mode === m} onChange={() => useMode(m)} />
                    <span className="pr-option-text">
                      <span>{PRINT_MODE_LABELS[m]}</span>
                      <span className="pr-option-desc">{MODE_HINTS[m]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Section>
            <Section title="Content">
              <Field label="Tickets" hint={p.mode === "classic" ? "System Print always prints one ticket per selected item." : undefined}>
                <select
                  className="select"
                  value={settings.printOption}
                  onChange={(e) => update((s) => (s.printOption = e.target.value as PrintSettings["printOption"]))}
                >
                  {PRINT_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {PRINT_OPTION_LABELS[o]}
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle
                label="Print breadcrumb"
                hint="Show where each item lives in the hierarchy."
                checked={settings.printBreadcrumb}
                onChange={(v) => update((s) => (s.printBreadcrumb = v))}
              />
              <Toggle
                label="Print finished tasks"
                checked={settings.printFinishedTasks}
                onChange={(v) => update((s) => (s.printFinishedTasks = v))}
              />
              <Toggle
                label="Mark printed tasks as finished"
                checked={settings.printMarkAsFinished}
                onChange={(v) => update((s) => (s.printMarkAsFinished = v))}
              />
              <Toggle
                label="Hide print buttons"
                hint="Remove the print buttons from column and day headers."
                checked={settings.hidePrintButtons}
                onChange={(v) => update((s) => (s.hidePrintButtons = v))}
              />
            </Section>
          </>
        )}

        {tab === "classic" &&
          pane(
            "classic",
            <>
              <Field label="Layout">
                <Segmented
                  value={String(p.classic.layout) as "1" | "2"}
                  options={[
                    { value: "1", label: "1 column" },
                    { value: "2", label: "2 columns" },
                  ]}
                  onChange={(v) => update((s) => (s.printing.classic.layout = v === "2" ? 2 : 1))}
                />
              </Field>
              <div className="pr-grid">
                <Field label="Font size (pt)">
                  <NumberInput value={p.classic.fontSize} min={7} max={24} onChange={(v) => update((s) => (s.printing.classic.fontSize = v))} />
                </Field>
                <Field label="Horizontal margin (%)">
                  <NumberInput value={p.classic.marginX} min={0} max={25} onChange={(v) => update((s) => (s.printing.classic.marginX = v))} />
                </Field>
                <Field label="Vertical margin (%)">
                  <NumberInput value={p.classic.marginY} min={0} max={25} onChange={(v) => update((s) => (s.printing.classic.marginY = v))} />
                </Field>
              </div>
              <Toggle
                label="Print in colour"
                hint="Off prints in pure black and white."
                checked={p.classic.color}
                onChange={(v) => update((s) => (s.printing.classic.color = v))}
              />
            </>,
          )}

        {tab === "receipt_printer" &&
          pane(
            "receipt_printer",
            <>
              <PrinterPicker
                backend={backend}
                value={p.receipt.printerId}
                onChange={(v) => update((s) => (s.printing.receipt.printerId = v))}
              />
              <Field label="Printer model" hint="Pick your model for correct defaults, or Generic.">
                <select
                  className="select"
                  value={p.receipt.printerModel ?? ""}
                  onChange={(e) => update((s) => (s.printing.receipt.printerModel = e.target.value || null))}
                >
                  <option value="">Generic</option>
                  {modelGroups.map(([brand, list]) => (
                    <optgroup key={brand} label={brand}>
                      {list.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <CodepageSelect
                language={p.receipt.advanced.language}
                value={p.receipt.codepageMapping}
                onChange={(v) => update((s) => (s.printing.receipt.codepageMapping = v))}
              />
              <Field label="Print as">
                <Segmented
                  value={p.receipt.printType}
                  options={[
                    { value: "direct", label: "Text" },
                    { value: "image", label: "Image" },
                  ]}
                  onChange={(v) => update((s) => (s.printing.receipt.printType = v))}
                />
              </Field>
              {p.receipt.printType === "image" && (
                <ImageWithPreview
                  image={p.receipt.image}
                  enforceMultipleOf8
                  onChange={(v) => update((s) => (s.printing.receipt.image = v))}
                />
              )}
              <AdvancedEditor
                advanced={p.receipt.advanced}
                showImageMode={p.receipt.printType === "image"}
                onChange={(v) => update((s) => (s.printing.receipt.advanced = v))}
              />
            </>,
          )}

        {tab === "lp_printer" &&
          pane(
            "lp_printer",
            <>
              <PrinterPicker
                backend={backend}
                value={p.lp.printerId}
                onChange={(v) => update((s) => (s.printing.lp.printerId = v))}
              />
              <p className="field-hint">Each ticket is sent to CUPS as an image sized to the paper.</p>
              <ImageWithPreview image={p.lp.image} enforceMultipleOf8 onChange={(v) => update((s) => (s.printing.lp.image = v))} />
            </>,
          )}

        {tab === "bluetooth_printer" &&
          pane(
            "bluetooth_printer",
            <>
              <BluetoothPane settings={settings} backend={backend} update={update} />
              <CodepageSelect
                language={p.bluetooth.advanced.enabled ? p.bluetooth.advanced.language : p.bluetooth.language}
                value={p.bluetooth.codepageMapping}
                onChange={(v) => update((s) => (s.printing.bluetooth.codepageMapping = v))}
              />
              <Field label="Print as">
                <Segmented
                  value={p.bluetooth.printType}
                  options={[
                    { value: "direct", label: "Text" },
                    { value: "image", label: "Image" },
                  ]}
                  onChange={(v) => update((s) => (s.printing.bluetooth.printType = v))}
                />
              </Field>
              {p.bluetooth.printType === "image" && (
                <ImageWithPreview
                  image={p.bluetooth.image}
                  enforceMultipleOf8
                  onChange={(v) => update((s) => (s.printing.bluetooth.image = v))}
                />
              )}
              <AdvancedEditor
                advanced={p.bluetooth.advanced}
                showImageMode={p.bluetooth.printType === "image"}
                onChange={(v) => update((s) => (s.printing.bluetooth.advanced = v))}
              />
            </>,
          )}

        {tab === "mqtt" &&
          pane(
            "mqtt",
            <>
              {!backend.native && <p className="field-hint">Receipt printing requires the desktop app.</p>}
              <div className="pr-grid">
                <Field label="Broker URL" hint="mqtt://host:1883 or mqtts://host:8883">
                  <input
                    className="input"
                    value={p.mqtt.brokerUrl}
                    placeholder="mqtt://localhost:1883"
                    onChange={(e) => update((s) => (s.printing.mqtt.brokerUrl = e.target.value))}
                  />
                </Field>
                <Field label="Topic">
                  <input
                    className="input"
                    value={p.mqtt.topic}
                    onChange={(e) => update((s) => (s.printing.mqtt.topic = e.target.value))}
                  />
                </Field>
                <Field label="Quality of service">
                  <select
                    className="select"
                    value={p.mqtt.qos}
                    onChange={(e) => update((s) => (s.printing.mqtt.qos = Number(e.target.value) as 0 | 1 | 2))}
                  >
                    <option value={0}>0 — at most once</option>
                    <option value={1}>1 — at least once</option>
                    <option value={2}>2 — exactly once</option>
                  </select>
                </Field>
                <Field label="Username">
                  <input
                    className="input"
                    value={p.mqtt.username}
                    autoComplete="off"
                    onChange={(e) => update((s) => (s.printing.mqtt.username = e.target.value))}
                  />
                </Field>
                <Field label="Password">
                  <input
                    className="input"
                    type="password"
                    value={p.mqtt.password}
                    autoComplete="off"
                    onChange={(e) => update((s) => (s.printing.mqtt.password = e.target.value))}
                  />
                </Field>
              </div>
              <Toggle
                label="Retain messages"
                checked={p.mqtt.retain}
                onChange={(v) => update((s) => (s.printing.mqtt.retain = v))}
              />
              <Field
                label="Message template"
                hint="Placeholders: ${image_base64}, ${paper_width_mm}, ${paper_height_mm}"
              >
                <textarea
                  className="input pr-template"
                  rows={5}
                  spellCheck={false}
                  value={p.mqtt.template}
                  onChange={(e) => update((s) => (s.printing.mqtt.template = e.target.value))}
                />
              </Field>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => update((s) => (s.printing.mqtt.template = DEFAULT_MQTT_TEMPLATE))}
                >
                  <RotateCcw size={14} /> Reset template
                </button>
              </div>
              <ImageWithPreview image={p.mqtt.image} enforceMultipleOf8={false} onChange={(v) => update((s) => (s.printing.mqtt.image = v))} />
            </>,
          )}
      </div>
    </div>
  );
}
