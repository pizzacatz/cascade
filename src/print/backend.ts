// Bridge to the native printing commands in the Rust backend.

import { invoke, isTauri } from "@tauri-apps/api/core";

export interface PrinterInfo {
  name: string;
  state: string;
  is_default: boolean;
}

export interface BluetoothPrinterInfo {
  id: string;
  name: string;
  language: string;
  codepage_mapping: string;
  rssi: number | null;
}

export interface BluetoothConnectionStatus {
  is_connected: boolean;
  connected_device: BluetoothPrinterInfo | null;
  is_scanning: boolean;
}

export interface MqttBatch {
  brokerUrl: string;
  topic: string;
  messages: string[];
  qos: 0 | 1 | 2;
  retain: boolean;
  auth?: { username: string; password: string };
  delayMs: number;
}

export interface PrintBackend {
  /** False when native printing is unavailable (e.g. running in a browser). */
  readonly native: boolean;
  getPrinters(): Promise<PrinterInfo[]>;
  printRaw(printer: string, data: Uint8Array): Promise<void>;
  printImage(printerName: string, png: Uint8Array, widthMm: number, heightMm: number): Promise<void>;
  scanBluetooth(): Promise<BluetoothPrinterInfo[]>;
  connectBluetooth(deviceId: string): Promise<BluetoothPrinterInfo>;
  disconnectBluetooth(): Promise<void>;
  bluetoothStatus(): Promise<BluetoothConnectionStatus>;
  printBluetooth(data: Uint8Array): Promise<void>;
  sendMqttBatch(batch: MqttBatch): Promise<void>;
}

/** Errors from invoke arrive as plain strings; normalize to Error. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : JSON.stringify(e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw asError(e);
  }
}

export const tauriPrintBackend: PrintBackend = {
  native: true,
  getPrinters: () => call<PrinterInfo[]>("get_all_printers").catch(() => []),
  printRaw: (printer, data) => call("print_raw", { printer, data: Array.from(data) }),
  printImage: (printerName, png, widthMm, heightMm) =>
    call("print_image", { printerName, pngData: Array.from(png), widthMm, heightMm }),
  scanBluetooth: () => call<BluetoothPrinterInfo[]>("scan_bluetooth_printers"),
  connectBluetooth: (deviceId) => call<BluetoothPrinterInfo>("connect_bluetooth_printer", { deviceId }),
  disconnectBluetooth: () => call("disconnect_bluetooth_printer"),
  bluetoothStatus: () => call<BluetoothConnectionStatus>("get_bluetooth_connection_status"),
  printBluetooth: (data) => call("print_bluetooth", { data: Array.from(data) }),
  sendMqttBatch: (b) =>
    call("send_mqtt_messages_batch", {
      brokerUrl: b.brokerUrl,
      topic: b.topic,
      messages: b.messages,
      qos: b.qos,
      retain: b.retain,
      auth: b.auth ?? null,
      delayMs: b.delayMs,
    }),
};

const DESKTOP_ONLY = "Receipt printing requires the desktop app.";
const reject = () => Promise.reject(new Error(DESKTOP_ONLY));

export const browserPrintBackend: PrintBackend = {
  native: false,
  getPrinters: () => Promise.resolve([]),
  printRaw: reject,
  printImage: reject,
  scanBluetooth: reject,
  connectBluetooth: reject,
  disconnectBluetooth: () => Promise.resolve(),
  bluetoothStatus: () => Promise.resolve({ is_connected: false, connected_device: null, is_scanning: false }),
  printBluetooth: reject,
  sendMqttBatch: reject,
};

export function defaultPrintBackend(): PrintBackend {
  try {
    return isTauri() ? tauriPrintBackend : browserPrintBackend;
  } catch {
    return browserPrintBackend;
  }
}
