// Rasterize tickets to monochrome bitmaps for image-based printing (receipt
// image mode, CUPS image, Bluetooth image, MQTT) and for on-screen previews.

import type { ImageOptions } from "./settings";
import { MAX_WIDTH_MM, MIN_WIDTH_MM } from "./settings";
import type { Ticket, TicketBlock } from "./tickets";

export const PRINT_FONT_FAMILY = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
const HEIGHT_MULTIPLE = 8;
const LINE_GAP = 1.3;

export interface RenderOptions {
  image: ImageOptions;
  /** Thermal print heads need a width divisible by 8 (receipt/Bluetooth/lp). */
  enforceMultipleOf8: boolean;
  /** Canvas factory (defaults to document.createElement). */
  createCanvas?: (w: number, h: number) => HTMLCanvasElement;
}

export const mmToPx = (mm: number, dpi: number) => (mm / 25.4) * dpi;

export function ticketWidthPx(image: ImageOptions, enforceMultipleOf8: boolean): number {
  const mm = Math.min(MAX_WIDTH_MM, Math.max(MIN_WIDTH_MM, image.widthMm));
  const px = Math.round(mmToPx(mm, image.dpi));
  return enforceMultipleOf8 ? Math.max(HEIGHT_MULTIPLE, Math.floor(px / 8) * 8) : px;
}

const roundUpTo = (v: number, m: number) => Math.max(m, Math.ceil(v / m) * m);

function defaultCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Wait for the print font so the first rendered ticket is not in a fallback font. */
export async function ensurePrintFontsLoaded(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`400 16px ${PRINT_FONT_FAMILY}`),
      document.fonts.load(`700 16px ${PRINT_FONT_FAMILY}`),
    ]);
  } catch {
    // Fall back silently to the system monospace font.
  }
}

const font = (size: number, bold = false) => `${bold ? 700 : 400} ${size}px ${PRINT_FONT_FAMILY}`;

/** Greedy word wrap with hard breaks for over-long words. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      // Break words that are wider than the line on their own.
      while (ctx.measureText(word).width > maxWidth && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && ctx.measureText(word.slice(0, n)).width > maxWidth) n--;
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}

type Op =
  | { kind: "text"; x: number; y: number; text: string; size: number; bold: boolean; strike: boolean }
  | { kind: "box"; x: number; y: number; size: number; checked: boolean }
  | { kind: "rule"; y: number; thickness: number };

interface Layout {
  width: number;
  height: number;
  ops: Op[];
}

function layoutTicket(ctx: CanvasRenderingContext2D, ticket: Ticket, width: number, image: ImageOptions): Layout {
  const px = (mm: number) => Math.round(mmToPx(mm, image.dpi));
  const left = px(image.padding.left);
  const right = width - px(image.padding.right);
  const fs = image.fontSizes;
  const ops: Op[] = [];
  let y = px(image.padding.top);

  const addLines = (text: string, x: number, size: number, bold: boolean, strike = false) => {
    ctx.font = font(size, bold);
    const lines = wrapText(ctx, text, right - x);
    for (const line of lines) {
      ops.push({ kind: "text", x, y, text: line, size, bold, strike });
      y += Math.round(size * LINE_GAP);
    }
    return lines.length;
  };

  if (ticket.breadcrumb && ticket.breadcrumb.length) {
    addLines(ticket.breadcrumb.join(" / "), left, fs.breadcrumb, false);
    y += Math.round(fs.breadcrumb * 0.3);
  }
  if (ticket.title) {
    addLines(ticket.title, left, fs.title, true);
    ops.push({ kind: "rule", y: y + 2, thickness: 2 });
    y += Math.round(fs.title * 0.5);
  }

  const drawBlock = (b: TicketBlock) => {
    const indent = left + Math.round(b.depth * fs.task);
    switch (b.kind) {
      case "separator": {
        const gap = Math.round(fs.text * 0.6);
        ops.push({ kind: "rule", y: y + gap, thickness: 2 });
        y += gap * 2;
        return;
      }
      case "heading":
        y += Math.round(fs.heading * 0.3);
        addLines(b.text || " ", indent, fs.heading, true);
        return;
      case "folder":
        addLines(b.text || "Untitled", indent, fs.text, true);
        return;
      case "text":
        addLines(b.text || " ", indent, fs.text, false);
        return;
      case "task": {
        const box = Math.round(fs.task * 0.8);
        ops.push({ kind: "box", x: indent, y: y + Math.round(fs.task * 0.15), size: box, checked: b.finished });
        addLines(b.text || " ", indent + box + Math.round(fs.task * 0.4), fs.task, false, b.finished);
        return;
      }
    }
  };
  for (const b of ticket.blocks) drawBlock(b);

  y += px(image.padding.bottom);
  return { width, height: roundUpTo(y, HEIGHT_MULTIPLE), ops };
}

/** Force every pixel to pure black or white (luminance threshold 128). */
export function thresholdCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    // Composite over white before measuring luminance.
    const r = d[i] * a + 255 * (1 - a);
    const g = d[i + 1] * a + 255 * (1 - a);
    const b = d[i + 2] * a + 255 * (1 - a);
    const v = 0.299 * r + 0.587 * g + 0.114 * b >= 128 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function renderTicketCanvas(ticket: Ticket, opts: RenderOptions): HTMLCanvasElement {
  const create = opts.createCanvas ?? defaultCanvas;
  const width = ticketWidthPx(opts.image, opts.enforceMultipleOf8);
  const scratch = create(width, 8);
  const sctx = scratch.getContext("2d");
  if (!sctx) throw new Error("Canvas rendering is not available.");
  const layout = layoutTicket(sctx, ticket, width, opts.image);

  const canvas = create(layout.width, layout.height);
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.textBaseline = "top";

  const left = Math.round(mmToPx(opts.image.padding.left, opts.image.dpi));
  const right = canvas.width - Math.round(mmToPx(opts.image.padding.right, opts.image.dpi));
  for (const op of layout.ops) {
    switch (op.kind) {
      case "text": {
        ctx.font = font(op.size, op.bold);
        ctx.fillText(op.text, op.x, op.y);
        if (op.strike && op.text) {
          const w = ctx.measureText(op.text).width;
          ctx.fillRect(op.x, op.y + Math.round(op.size * 0.5), w, Math.max(1, Math.round(op.size / 12)));
        }
        break;
      }
      case "box": {
        const lw = Math.max(2, Math.round(op.size / 10));
        ctx.lineWidth = lw;
        ctx.strokeRect(op.x + lw / 2, op.y + lw / 2, op.size - lw, op.size - lw);
        if (op.checked) {
          ctx.beginPath();
          ctx.moveTo(op.x + op.size * 0.22, op.y + op.size * 0.52);
          ctx.lineTo(op.x + op.size * 0.43, op.y + op.size * 0.74);
          ctx.lineTo(op.x + op.size * 0.8, op.y + op.size * 0.28);
          ctx.stroke();
        }
        break;
      }
      case "rule":
        ctx.fillRect(left, op.y, right - left, op.thickness);
        break;
    }
  }
  if (opts.image.preventTrim) {
    // A dark bottom row stops CUPS/drivers from trimming the bottom padding.
    ctx.fillRect(0, canvas.height - 1, canvas.width, 1);
  }
  thresholdCanvas(canvas);
  return canvas;
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is not available.");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode the ticket image."));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

/** Physical size of a rendered canvas in millimetres (rounded up). */
export function canvasSizeMm(canvas: HTMLCanvasElement, dpi: number): { widthMm: number; heightMm: number } {
  return {
    widthMm: Math.ceil((canvas.width / dpi) * 25.4),
    heightMm: Math.ceil((canvas.height / dpi) * 25.4),
  };
}

export function renderPreviewDataUrl(ticket: Ticket, opts: RenderOptions): string {
  return renderTicketCanvas(ticket, opts).toDataURL("image/png");
}
