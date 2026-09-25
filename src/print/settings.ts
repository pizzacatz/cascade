// Print settings: what gets printed (content options) and how (printer mode
// plus per-mode printer configuration). Persisted in the printing store and
// normalized leniently on load so hand-edited or older values never break
// printing.

export const PRINT_OPTIONS = [
  "task_tickets",
  "task_tickets_recursive",
  "selection_tickets",
  "selection_tickets_recursive",
] as const;
export type PrintOption = (typeof PRINT_OPTIONS)[number];

export const PRINT_MODES = ["classic", "receipt_printer", "lp_printer", "bluetooth_printer", "mqtt"] as const;
export type PrintMode = (typeof PRINT_MODES)[number];

export const PRINTER_LANGUAGES = ["esc-pos", "star-prnt", "star-line"] as const;
export type PrinterLanguage = (typeof PRINTER_LANGUAGES)[number];

export const PRINTER_COLUMNS = [32, 35, 42, 44, 48] as const;
export type PrinterColumns = (typeof PRINTER_COLUMNS)[number];

export type PrintType = "direct" | "image";
export type Newline = "\n" | "\r\n";

export interface ImageOptions {
  dpi: number;
  widthMm: number;
  padding: { top: number; bottom: number; left: number; right: number };
  fontSizes: { breadcrumb: number; title: number; task: number; text: number; heading: number };
  preventTrim: boolean;
}

export interface AdvancedOptions {
  enabled: boolean;
  language: PrinterLanguage;
  columns: PrinterColumns;
  feedBeforeCut: number;
  newline: Newline;
  imageMode: "column" | "raster";
}

export interface ReceiptConfig {
  printerId: string;
  printType: PrintType;
  printerModel: string | null;
  codepageMapping: string;
  image: ImageOptions;
  advanced: AdvancedOptions;
}

export interface LpConfig {
  printerId: string;
  image: ImageOptions;
}

export interface BluetoothConfig {
  deviceId: string;
  deviceName: string;
  language: PrinterLanguage;
  codepageMapping: string;
  printType: PrintType;
  image: ImageOptions;
  advanced: AdvancedOptions;
}

export interface MqttConfig {
  brokerUrl: string;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  username: string;
  password: string;
  template: string;
  image: ImageOptions;
}

/** System Print layout options. Margins are percentages of the page. */
export interface ClassicConfig {
  color: boolean;
  layout: 1 | 2;
  /** Base font size in points. */
  fontSize: number;
  marginX: number;
  marginY: number;
}

export interface PrintingConfig {
  mode: PrintMode;
  classic: ClassicConfig;
  receipt: ReceiptConfig;
  lp: LpConfig;
  bluetooth: BluetoothConfig;
  mqtt: MqttConfig;
}

export interface PrintSettings {
  printBreadcrumb: boolean;
  printFinishedTasks: boolean;
  printMarkAsFinished: boolean;
  printOption: PrintOption;
  hidePrintButtons: boolean;
  printing: PrintingConfig;
}

export const DEFAULT_MQTT_TEMPLATE =
  '{"data_type":"png","data_base64":"${image_base64}","paper_type":0,"paper_width_mm":${paper_width_mm},"paper_height_mm":${paper_height_mm},"cut_paper":1}';

export const MIN_WIDTH_MM = 20;
export const MAX_WIDTH_MM = 200;

export function defaultImageOptions(): ImageOptions {
  return {
    dpi: 203,
    widthMm: 58,
    padding: { top: 4, bottom: 4, left: 2, right: 2 },
    fontSizes: { breadcrumb: 16, title: 28, task: 24, text: 22, heading: 26 },
    preventTrim: true,
  };
}

export function defaultClassicConfig(): ClassicConfig {
  return { color: true, layout: 1, fontSize: 11, marginX: 4, marginY: 4 };
}

export function defaultAdvancedOptions(): AdvancedOptions {
  return { enabled: false, language: "esc-pos", columns: 48, feedBeforeCut: 4, newline: "\n", imageMode: "column" };
}

export function defaultPrintSettings(): PrintSettings {
  return {
    printBreadcrumb: true,
    printFinishedTasks: false,
    printMarkAsFinished: false,
    printOption: "task_tickets",
    hidePrintButtons: false,
    printing: {
      mode: "classic",
      classic: defaultClassicConfig(),
      receipt: {
        printerId: "",
        printType: "direct",
        printerModel: null,
        codepageMapping: "epson",
        image: defaultImageOptions(),
        advanced: defaultAdvancedOptions(),
      },
      lp: { printerId: "", image: defaultImageOptions() },
      bluetooth: {
        deviceId: "",
        deviceName: "",
        language: "esc-pos",
        codepageMapping: "epson",
        printType: "direct",
        image: defaultImageOptions(),
        advanced: defaultAdvancedOptions(),
      },
      mqtt: {
        brokerUrl: "",
        topic: "",
        qos: 1,
        retain: false,
        username: "",
        password: "",
        template: DEFAULT_MQTT_TEMPLATE,
        image: defaultImageOptions(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
function num(v: unknown, d: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}
function oneOf<T extends string | number>(v: unknown, options: readonly T[], d: T): T {
  return options.includes(v as T) ? (v as T) : d;
}

function normalizeImage(raw: unknown): ImageOptions {
  const d = defaultImageOptions();
  const r = obj(raw);
  const p = obj(r.padding);
  const f = obj(r.fontSizes);
  return {
    dpi: Math.round(num(r.dpi, d.dpi, 72, 600)),
    widthMm: num(r.widthMm, d.widthMm, MIN_WIDTH_MM, MAX_WIDTH_MM),
    padding: {
      top: num(p.top, d.padding.top, 0, 50),
      bottom: num(p.bottom, d.padding.bottom, 0, 50),
      left: num(p.left, d.padding.left, 0, 50),
      right: num(p.right, d.padding.right, 0, 50),
    },
    fontSizes: {
      breadcrumb: num(f.breadcrumb, d.fontSizes.breadcrumb, 8, 96),
      title: num(f.title, d.fontSizes.title, 8, 96),
      task: num(f.task, d.fontSizes.task, 8, 96),
      text: num(f.text, d.fontSizes.text, 8, 96),
      heading: num(f.heading, d.fontSizes.heading, 8, 96),
    },
    preventTrim: bool(r.preventTrim, d.preventTrim),
  };
}

function normalizeAdvanced(raw: unknown): AdvancedOptions {
  const d = defaultAdvancedOptions();
  const r = obj(raw);
  const columns = typeof r.columns === "string" ? Number(r.columns) : r.columns;
  return {
    enabled: bool(r.enabled, d.enabled),
    language: oneOf(r.language, PRINTER_LANGUAGES, d.language),
    columns: oneOf(columns, PRINTER_COLUMNS, d.columns),
    feedBeforeCut: Math.round(num(r.feedBeforeCut, d.feedBeforeCut, 0, 20)),
    newline: oneOf(r.newline, ["\n", "\r\n"] as const, d.newline),
    imageMode: oneOf(r.imageMode, ["column", "raster"] as const, d.imageMode),
  };
}

export function normalizePrintSettings(raw: unknown): PrintSettings {
  const d = defaultPrintSettings();
  const r = obj(raw);
  const p = obj(r.printing);
  const classic = obj(p.classic);
  const receipt = obj(p.receipt);
  const lp = obj(p.lp);
  const bt = obj(p.bluetooth);
  const mqtt = obj(p.mqtt);
  const qos = typeof mqtt.qos === "string" ? Number(mqtt.qos) : mqtt.qos;
  return {
    printBreadcrumb: bool(r.printBreadcrumb, d.printBreadcrumb),
    printFinishedTasks: bool(r.printFinishedTasks, d.printFinishedTasks),
    printMarkAsFinished: bool(r.printMarkAsFinished, d.printMarkAsFinished),
    printOption: oneOf(r.printOption, PRINT_OPTIONS, d.printOption),
    hidePrintButtons: bool(r.hidePrintButtons, d.hidePrintButtons),
    printing: {
      mode: oneOf(p.mode, PRINT_MODES, d.printing.mode),
      classic: {
        color: bool(classic.color, d.printing.classic.color),
        layout: oneOf(typeof classic.layout === "string" ? Number(classic.layout) : classic.layout, [1, 2] as const, 1),
        fontSize: num(classic.fontSize, d.printing.classic.fontSize, 7, 24),
        marginX: num(classic.marginX, d.printing.classic.marginX, 0, 25),
        marginY: num(classic.marginY, d.printing.classic.marginY, 0, 25),
      },
      receipt: {
        printerId: str(receipt.printerId, ""),
        printType: oneOf(receipt.printType, ["direct", "image"] as const, "direct"),
        printerModel: typeof receipt.printerModel === "string" && receipt.printerModel ? receipt.printerModel : null,
        codepageMapping: str(receipt.codepageMapping, d.printing.receipt.codepageMapping) || "epson",
        image: normalizeImage(receipt.image),
        advanced: normalizeAdvanced(receipt.advanced),
      },
      lp: { printerId: str(lp.printerId, ""), image: normalizeImage(lp.image) },
      bluetooth: {
        deviceId: str(bt.deviceId, ""),
        deviceName: str(bt.deviceName, ""),
        language: oneOf(bt.language, PRINTER_LANGUAGES, "esc-pos"),
        codepageMapping: str(bt.codepageMapping, "epson") || "epson",
        printType: oneOf(bt.printType, ["direct", "image"] as const, "direct"),
        image: normalizeImage(bt.image),
        advanced: normalizeAdvanced(bt.advanced),
      },
      mqtt: {
        brokerUrl: str(mqtt.brokerUrl, ""),
        topic: str(mqtt.topic, ""),
        qos: oneOf(qos, [0, 1, 2] as const, 1),
        retain: bool(mqtt.retain, false),
        username: str(mqtt.username, ""),
        password: str(mqtt.password, ""),
        template: str(mqtt.template, "") || DEFAULT_MQTT_TEMPLATE,
        image: normalizeImage(mqtt.image),
      },
    },
  };
}

/** The image options used by the active mode (classic has none). */
export function activeImageOptions(settings: PrintSettings): ImageOptions | null {
  const p = settings.printing;
  switch (p.mode) {
    case "receipt_printer":
      return p.receipt.image;
    case "lp_printer":
      return p.lp.image;
    case "bluetooth_printer":
      return p.bluetooth.image;
    case "mqtt":
      return p.mqtt.image;
    default:
      return null;
  }
}

/** Whether the active mode renders tickets as images (vs. text or HTML). */
export function isImageMode(settings: PrintSettings): boolean {
  const p = settings.printing;
  switch (p.mode) {
    case "receipt_printer":
      return p.receipt.printType === "image";
    case "bluetooth_printer":
      return p.bluetooth.printType === "image";
    case "lp_printer":
    case "mqtt":
      return true;
    default:
      return false;
  }
}

export const PRINT_MODE_LABELS: Record<PrintMode, string> = {
  classic: "System Print",
  receipt_printer: "Receipt Printer (USB / CUPS raw)",
  lp_printer: "Receipt Printer (CUPS image)",
  bluetooth_printer: "Receipt Printer (Bluetooth)",
  mqtt: "Receipt Printer (MQTT)",
};

export const PRINT_OPTION_LABELS: Record<PrintOption, string> = {
  task_tickets: "One ticket per task",
  task_tickets_recursive: "One ticket per task, including nested folders",
  selection_tickets: "One ticket per selected item",
  selection_tickets_recursive: "One ticket per selected item, with nested items",
};

export const PRINT_OPTION_DESCRIPTIONS: Record<PrintOption, string> = {
  task_tickets: "Each task directly in the scope gets its own ticket.\nFolders are skipped.",
  task_tickets_recursive: "Each task gets its own ticket,\nincluding tasks inside nested folders.",
  selection_tickets: "One ticket per selected item (or the whole column),\nlisting its direct contents.",
  selection_tickets_recursive: "One ticket per selected item (or the whole column),\nwith everything nested inside.",
};

/** Ticket options that make sense for a mode: task tickets are for receipt printers only. */
export function printOptionsFor(mode: PrintMode): readonly PrintOption[] {
  return mode === "classic" ? (["selection_tickets", "selection_tickets_recursive"] as const) : PRINT_OPTIONS;
}

/** The ticket option actually used: System Print maps task tickets to their selection equivalent. */
export function effectivePrintOption(settings: PrintSettings): PrintOption {
  const o = settings.printOption;
  if (settings.printing.mode !== "classic") return o;
  if (o === "task_tickets") return "selection_tickets";
  if (o === "task_tickets_recursive") return "selection_tickets_recursive";
  return o;
}

/** Why the active mode can't print yet (missing printer, broker…), or null when ready. */
export function printSettingsProblem(settings: PrintSettings): string | null {
  const p = settings.printing;
  switch (p.mode) {
    case "receipt_printer":
      return p.receipt.printerId ? null : "Choose a USB receipt printer in Print Settings.";
    case "lp_printer":
      return p.lp.printerId ? null : "Choose a CUPS printer in Print Settings.";
    case "bluetooth_printer":
      return p.bluetooth.deviceId ? null : "Connect a Bluetooth printer in Print Settings.";
    case "mqtt":
      if (!p.mqtt.brokerUrl.trim()) return "Set the MQTT broker URL in Print Settings.";
      if (!p.mqtt.topic.trim()) return "Set the MQTT topic in Print Settings.";
      return null;
    default:
      return null;
  }
}
