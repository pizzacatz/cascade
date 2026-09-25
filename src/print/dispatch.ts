// Print tickets with the configured mode.

import type { PrintBackend } from "./backend";
import type { ImageOptions, PrintSettings } from "./settings";
import type { Ticket } from "./tickets";
import { printClassic } from "./classic";
import { bluetoothEncoderConfig, encodeTicketsDirect, encodeTicketsImage, receiptEncoderConfig } from "./encode";
import { canvasSizeMm, canvasToPngBytes, ensurePrintFontsLoaded, renderTicketCanvas } from "./render-image";

export interface MqttTemplateValues {
  imageBase64: string;
  paperWidthMm: number;
  paperHeightMm: number;
}

/** Fill `${image_base64}`, `${paper_width_mm}` and `${paper_height_mm}` placeholders. */
export function fillMqttTemplate(template: string, v: MqttTemplateValues): string {
  return template
    .split("${image_base64}")
    .join(v.imageBase64)
    .split("${paper_width_mm}")
    .join(String(v.paperWidthMm))
    .split("${paper_height_mm}")
    .join(String(v.paperHeightMm));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  return (globalThis as unknown as { Buffer: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer.from(
    bytes,
  ).toString("base64");
}

async function renderAll(tickets: Ticket[], image: ImageOptions, enforceMultipleOf8: boolean) {
  await ensurePrintFontsLoaded();
  return tickets.map((t) => renderTicketCanvas(t, { image, enforceMultipleOf8 }));
}

function fail(prefix: string, e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  throw new Error(`${prefix}: ${msg}`);
}

export async function printTickets(
  tickets: Ticket[],
  settings: PrintSettings,
  backend: PrintBackend,
): Promise<{ printed: number }> {
  if (tickets.length === 0) throw new Error("Nothing to print.");
  const p = settings.printing;

  switch (p.mode) {
    case "classic":
      await printClassic(tickets, p.classic);
      break;

    case "receipt_printer": {
      const r = p.receipt;
      if (!r.printerId) throw new Error("Choose a receipt printer in Print Settings first.");
      const cfg = receiptEncoderConfig(r);
      try {
        const bytes =
          r.printType === "image"
            ? encodeTicketsImage(await renderAll(tickets, r.image, true), cfg)
            : encodeTicketsDirect(tickets, cfg);
        await backend.printRaw(r.printerId, bytes);
      } catch (e) {
        fail(r.printType === "image" ? "Receipt image printing failed" : "Receipt printing failed", e);
      }
      break;
    }

    case "lp_printer": {
      const lp = p.lp;
      if (!lp.printerId) throw new Error("Choose a printer in Print Settings first.");
      try {
        for (const canvas of await renderAll(tickets, lp.image, true)) {
          const { widthMm, heightMm } = canvasSizeMm(canvas, lp.image.dpi);
          await backend.printImage(lp.printerId, await canvasToPngBytes(canvas), widthMm, heightMm);
        }
      } catch (e) {
        fail("Printing failed", e);
      }
      break;
    }

    case "bluetooth_printer": {
      const b = p.bluetooth;
      const cfg = bluetoothEncoderConfig(b);
      try {
        const bytes =
          b.printType === "image"
            ? encodeTicketsImage(await renderAll(tickets, b.image, true), cfg)
            : encodeTicketsDirect(tickets, cfg);
        await backend.printBluetooth(bytes);
      } catch (e) {
        fail(b.printType === "image" ? "Bluetooth image printing failed" : "Bluetooth direct printing failed", e);
      }
      break;
    }

    case "mqtt": {
      const m = p.mqtt;
      if (!m.brokerUrl || !m.topic) throw new Error("MQTT printing failed: set a broker URL and topic in Print Settings.");
      try {
        const messages: string[] = [];
        for (const canvas of await renderAll(tickets, m.image, false)) {
          const { widthMm, heightMm } = canvasSizeMm(canvas, m.image.dpi);
          messages.push(
            fillMqttTemplate(m.template, {
              imageBase64: bytesToBase64(await canvasToPngBytes(canvas)),
              paperWidthMm: widthMm,
              paperHeightMm: heightMm,
            }),
          );
        }
        await backend.sendMqttBatch({
          brokerUrl: m.brokerUrl,
          topic: m.topic,
          messages,
          qos: m.qos,
          retain: m.retain,
          auth: m.username && m.password ? { username: m.username, password: m.password } : undefined,
          delayMs: 100,
        });
      } catch (e) {
        fail("MQTT printing failed", e);
      }
      break;
    }
  }
  return { printed: tickets.length };
}
