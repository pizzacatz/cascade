// Encode tickets as receipt-printer command bytes (ESC/POS, StarPRNT,
// StarLine) using @point-of-sale/receipt-printer-encoder.

import ReceiptPrinterEncoder from "@point-of-sale/receipt-printer-encoder";
import type { ReceiptPrinterEncoderOptions } from "@point-of-sale/receipt-printer-encoder";
import type { AdvancedOptions, BluetoothConfig, PrinterLanguage, ReceiptConfig } from "./settings";
import type { Ticket } from "./tickets";
import { blockPrefix } from "./tickets";
import { canvasToImageData } from "./render-image";

export interface EncoderConfig {
  language: PrinterLanguage;
  codepageMapping: string;
  printerModel: string | null;
  advanced: AdvancedOptions;
}

const ESC_POS_MAPPINGS = [
  "bixolon",
  "bixolon/legacy",
  "citizen",
  "epson",
  "epson/legacy",
  "fujitsu",
  "hp",
  "metapace",
  "mpt",
  "pos-5890",
  "pos-8360",
  "star",
  "sunmi",
  "xprinter",
  "youku",
];
const STAR_MAPPINGS = ["star"];
const MAPPING_ALIASES: Record<string, string> = { zjiang: "pos-5890", zijang: "pos-5890" };

/** Codepage mappings the encoder accepts for a language. */
export function codepageMappingsFor(language: PrinterLanguage): string[] {
  return language === "esc-pos" ? ESC_POS_MAPPINGS : STAR_MAPPINGS;
}

/** Resolve a (possibly unknown) mapping name to one the encoder accepts. */
export function resolveCodepageMapping(language: PrinterLanguage, mapping: string): string {
  const name = MAPPING_ALIASES[mapping] ?? mapping;
  const valid = codepageMappingsFor(language);
  if (valid.includes(name)) return name;
  return language === "esc-pos" ? "epson" : "star";
}

export interface PrinterModelChoice {
  id: string;
  name: string;
}

export function printerModels(): PrinterModelChoice[] {
  try {
    return ReceiptPrinterEncoder.printerModels.map((m) => ({ id: m.id, name: m.name }));
  } catch {
    return [];
  }
}

export function receiptEncoderConfig(r: ReceiptConfig): EncoderConfig {
  return {
    language: r.advanced.language,
    codepageMapping: r.codepageMapping,
    printerModel: r.printerModel,
    advanced: r.advanced,
  };
}

export function bluetoothEncoderConfig(b: BluetoothConfig): EncoderConfig {
  return {
    language: b.advanced.enabled ? b.advanced.language : b.language,
    codepageMapping: b.codepageMapping,
    printerModel: null,
    advanced: b.advanced,
  };
}

function encoderOptions(cfg: EncoderConfig): ReceiptPrinterEncoderOptions {
  const models = new Set(printerModels().map((m) => m.id));
  const model = cfg.printerModel && models.has(cfg.printerModel) ? cfg.printerModel : null;
  const opts: ReceiptPrinterEncoderOptions = {};
  if (model) opts.printerModel = model as ReceiptPrinterEncoderOptions["printerModel"];
  if (!model || cfg.advanced.enabled) {
    opts.language = cfg.language;
    opts.columns = cfg.advanced.columns;
    opts.feedBeforeCut = cfg.advanced.feedBeforeCut;
    opts.imageMode = cfg.advanced.imageMode;
    opts.newline = cfg.advanced.newline === "\r\n" ? "\n\r" : "\n";
  }
  const language = (opts.language ?? cfg.language) as PrinterLanguage;
  opts.codepageMapping = resolveCodepageMapping(language, cfg.codepageMapping) as never;
  return opts;
}

function createEncoder(cfg: EncoderConfig): ReceiptPrinterEncoder {
  try {
    return new ReceiptPrinterEncoder(encoderOptions(cfg));
  } catch (e) {
    throw new Error(`Invalid printer configuration: ${(e as Error).message}`);
  }
}

/** Wrap text to a fixed character width with a hanging indent. */
export function wrapColumns(text: string, width: number, firstPrefix: string, restPrefix: string): string[] {
  const out: string[] = [];
  let prefix = firstPrefix;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [firstPrefix.trimEnd()];
  let line = "";
  const push = () => {
    out.push(prefix + line);
    prefix = restPrefix;
    line = "";
  };
  for (let word of words) {
    const room = Math.max(1, width - prefix.length);
    if ((line ? line.length + 1 : 0) + word.length <= room) {
      line = line ? `${line} ${word}` : word;
      continue;
    }
    if (line) push();
    while (word.length > Math.max(1, width - prefix.length)) {
      const n = Math.max(1, width - prefix.length);
      line = word.slice(0, n);
      word = word.slice(n);
      push();
    }
    line = word;
  }
  if (line) push();
  return out;
}

export function encodeTicketsDirect(tickets: Ticket[], cfg: EncoderConfig): Uint8Array {
  try {
    const enc = createEncoder(cfg);
    const width = enc.columns;
    enc.initialize().codepage("auto");
    for (const t of tickets) {
      if (t.breadcrumb && t.breadcrumb.length) {
        for (const l of wrapColumns(t.breadcrumb.join(" / "), width, "", "")) enc.line(l);
      }
      if (t.title) {
        enc.bold(true);
        for (const l of wrapColumns(t.title, width, "", "")) enc.line(l);
        enc.bold(false);
        enc.rule();
      }
      for (const b of t.blocks) {
        const indent = "  ".repeat(b.depth);
        switch (b.kind) {
          case "separator":
            enc.rule();
            break;
          case "heading":
            enc.bold(true).size(1, 2);
            for (const l of wrapColumns(b.text, width, indent, indent)) enc.line(l);
            enc.size(1, 1).bold(false);
            break;
          case "folder":
            enc.bold(true);
            for (const l of wrapColumns(b.text || "Untitled", width, indent + blockPrefix(b), indent + "  ")) enc.line(l);
            enc.bold(false);
            break;
          case "task": {
            const p = blockPrefix(b);
            for (const l of wrapColumns(b.text, width, indent + p, indent + " ".repeat(p.length))) enc.line(l);
            break;
          }
          default:
            for (const l of wrapColumns(b.text, width, indent, indent)) enc.line(l);
        }
      }
      enc.newline().cut();
    }
    return enc.encode();
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(msg.startsWith("Invalid printer configuration") ? msg : `Could not encode the receipt: ${msg}`);
  }
}

export function encodeTicketsImage(canvases: HTMLCanvasElement[], cfg: EncoderConfig): Uint8Array {
  try {
    const enc = createEncoder(cfg);
    enc.initialize();
    for (const c of canvases) {
      const data = canvasToImageData(c);
      enc.image(data, c.width, c.height, "threshold", 128).cut();
    }
    return enc.encode();
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(msg.startsWith("Invalid printer configuration") ? msg : `Could not encode the receipt image: ${msg}`);
  }
}
