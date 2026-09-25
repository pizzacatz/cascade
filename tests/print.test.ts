import { describe, expect, it } from "vitest";
import { emptyDoc, makeItem } from "../src/model/defaults";
import { buildIndex } from "../src/model/tree";
import type { Doc, ItemType } from "../src/model/types";
import { buildTickets, type TicketOptions } from "../src/print/tickets";
import {
  DEFAULT_MQTT_TEMPLATE,
  defaultPrintSettings,
  normalizePrintSettings,
  isImageMode,
  effectivePrintOption,
  printOptionsFor,
  printSettingsProblem,
} from "../src/print/settings";
import { capTickets, countItems, estimateLines } from "../src/print/limits";
import type { Ticket } from "../src/print/tickets";
import { encodeTicketsDirect, resolveCodepageMapping, wrapColumns, type EncoderConfig } from "../src/print/encode";
import { bytesToBase64, fillMqttTemplate } from "../src/print/dispatch";
import { ticketWidthPx } from "../src/print/render-image";

function fixture(): Doc {
  const d = emptyDoc();
  const add = (id: string, type: ItemType, parentId: string, position: string, extra: object = {}) =>
    (d.items[id] = makeItem(type, { id, parentId, position, text: id, ...extra }));
  add("F", "folder", "root", "a0");
  add("t1", "task", "F", "a0");
  add("t2", "task", "F", "a1", { finished: true });
  add("h", "heading", "F", "a2");
  add("G", "folder", "F", "a3");
  add("g1", "task", "G", "a0");
  add("g2", "task", "G", "a1");
  add("top", "task", "root", "a1");
  d.items.day1 = makeItem("task", {
    id: "day1",
    text: "day task",
    scheduleDate: "2026-10-01",
    schedulePosition: "a0",
  });
  d.items.day2 = makeItem("task", {
    id: "day2",
    text: "day done",
    scheduleDate: "2026-10-01",
    schedulePosition: "a1",
    finished: true,
  });
  return d;
}

const ix = buildIndex(fixture());
const opts = (o: Partial<TicketOptions>): TicketOptions => ({
  printOption: "task_tickets",
  printBreadcrumb: true,
  printFinishedTasks: false,
  ...o,
});

describe("buildTickets", () => {
  it("task_tickets: one ticket per unfinished task directly in scope", () => {
    const t = buildTickets(ix, { kind: "column", parentId: "F" }, opts({}));
    expect(t.map((x) => x.taskIds[0])).toEqual(["t1"]);
    expect(t[0].breadcrumb).toEqual(["Home", "F"]);
    expect(t[0].blocks).toEqual([{ kind: "task", text: "t1", finished: false, depth: 0 }]);
  });

  it("task_tickets can include finished tasks and omit breadcrumbs", () => {
    const t = buildTickets(ix, { kind: "column", parentId: "F" }, opts({ printFinishedTasks: true, printBreadcrumb: false }));
    expect(t.map((x) => x.taskIds[0])).toEqual(["t1", "t2"]);
    expect(t[0].breadcrumb).toBeNull();
  });

  it("task_tickets_recursive descends into folders", () => {
    const t = buildTickets(ix, { kind: "space", spaceId: "root" }, opts({ printOption: "task_tickets_recursive" }));
    expect(t.map((x) => x.taskIds[0])).toEqual(["t1", "g1", "g2", "top"]);
    expect(t[1].breadcrumb).toEqual(["Home", "F", "G"]);
  });

  it("selection_tickets: one ticket per selected item listing direct children", () => {
    const t = buildTickets(ix, { kind: "selection", ids: ["F", "top"] }, opts({ printOption: "selection_tickets" }));
    expect(t).toHaveLength(2);
    expect(t[0].title).toBe("F");
    expect(t[0].breadcrumb).toEqual(["Home"]);
    expect(t[0].blocks.map((b) => [b.kind, b.text])).toEqual([
      ["task", "t1"],
      ["heading", "h"],
      ["folder", "G"],
    ]);
    expect(t[0].taskIds).toEqual(["t1"]);
    expect(t[1].title).toBeNull();
    expect(t[1].blocks[0].text).toBe("top");
  });

  it("selection_tickets_recursive nests children with depth", () => {
    const t = buildTickets(ix, { kind: "selection", ids: ["F", "g1"] }, opts({ printOption: "selection_tickets_recursive" }));
    // g1 is inside F so it is folded into F's ticket.
    expect(t).toHaveLength(1);
    expect(t[0].blocks.map((b) => [b.text, b.depth])).toEqual([
      ["t1", 0],
      ["h", 0],
      ["G", 0],
      ["g1", 1],
      ["g2", 1],
    ]);
    expect(t[0].taskIds).toEqual(["t1", "g1", "g2"]);
  });

  it("column selection ticket uses the folder title", () => {
    const t = buildTickets(ix, { kind: "column", parentId: "G" }, opts({ printOption: "selection_tickets" }));
    expect(t[0].title).toBe("G");
    expect(t[0].breadcrumb).toEqual(["Home", "F"]);
  });

  it("day scope uses items on that day", () => {
    const tasks = buildTickets(ix, { kind: "day", date: "2026-10-01" }, opts({}));
    expect(tasks.map((x) => x.taskIds[0])).toEqual(["day1"]);
    expect(tasks[0].breadcrumb?.length).toBe(1); // falls back to the day label
    const one = buildTickets(ix, { kind: "day", date: "2026-10-01" }, opts({ printOption: "selection_tickets", printFinishedTasks: true }));
    expect(one).toHaveLength(1);
    expect(one[0].title).toBeTruthy();
    expect(one[0].blocks).toHaveLength(2);
  });

  it("drops empty tickets", () => {
    const t = buildTickets(ix, { kind: "day", date: "2030-01-01" }, opts({ printOption: "selection_tickets" }));
    expect(t).toEqual([]);
  });
});

describe("settings", () => {
  it("defaults", () => {
    const s = defaultPrintSettings();
    expect(s.printing.mode).toBe("classic");
    expect(s.printOption).toBe("task_tickets");
    expect(s.printBreadcrumb).toBe(true);
    expect(s.printing.mqtt.template).toBe(DEFAULT_MQTT_TEMPLATE);
    expect(isImageMode(s)).toBe(false);
  });

  it("normalizes and clamps leniently", () => {
    const s = normalizePrintSettings({
      printOption: "bogus",
      printMarkAsFinished: true,
      printing: {
        mode: "lp_printer",
        lp: { printerId: "Zebra", image: { widthMm: 500, dpi: "300", padding: { top: -3 } } },
        receipt: { advanced: { columns: 40, feedBeforeCut: 99, language: "star-line" } },
        mqtt: { qos: "2", template: "" },
      },
    });
    expect(s.printOption).toBe("task_tickets");
    expect(s.printMarkAsFinished).toBe(true);
    expect(s.printing.mode).toBe("lp_printer");
    expect(s.printing.lp.printerId).toBe("Zebra");
    expect(s.printing.lp.image.widthMm).toBe(200);
    expect(s.printing.lp.image.dpi).toBe(300);
    expect(s.printing.lp.image.padding.top).toBe(0);
    expect(s.printing.lp.image.padding.left).toBe(2);
    expect(s.printing.receipt.advanced.columns).toBe(48);
    expect(s.printing.receipt.advanced.feedBeforeCut).toBe(20);
    expect(s.printing.receipt.advanced.language).toBe("star-line");
    expect(s.printing.mqtt.qos).toBe(2);
    expect(s.printing.mqtt.template).toBe(DEFAULT_MQTT_TEMPLATE);
    expect(isImageMode(s)).toBe(true);
    expect(normalizePrintSettings(null)).toEqual(defaultPrintSettings());
  });

  it("computes ticket widths", () => {
    const img = defaultPrintSettings().printing.lp.image;
    expect(ticketWidthPx(img, true) % 8).toBe(0);
    expect(ticketWidthPx({ ...img, widthMm: 58, dpi: 203 }, false)).toBe(464);
  });
});

describe("encoding", () => {
  const cfg: EncoderConfig = {
    language: "esc-pos",
    codepageMapping: "zjiang",
    printerModel: null,
    advanced: { enabled: false, language: "esc-pos", columns: 32, feedBeforeCut: 4, newline: "\n", imageMode: "column" },
  };

  it("maps unknown codepage mappings to safe defaults", () => {
    expect(resolveCodepageMapping("esc-pos", "zjiang")).toBe("pos-5890");
    expect(resolveCodepageMapping("esc-pos", "default")).toBe("epson");
    expect(resolveCodepageMapping("star-line", "epson")).toBe("star");
  });

  it("encodes direct tickets starting with ESC @", () => {
    const tickets = buildTickets(ix, { kind: "selection", ids: ["F"] }, opts({ printOption: "selection_tickets_recursive" }));
    const bytes = encodeTicketsDirect(tickets, cfg);
    expect(bytes[0]).toBe(27);
    expect(bytes[1]).toBe(64);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("[ ] t1");
    expect(text).toContain("[ ] g1");
  });

  it("wraps with a hanging indent", () => {
    const lines = wrapColumns("one two three four five", 12, "[ ] ", "    ");
    expect(lines).toEqual(["[ ] one two", "    three", "    four", "    five"]);
    expect(lines.every((l) => l.length <= 12)).toBe(true);
  });
});

describe("mqtt template", () => {
  it("fills placeholders", () => {
    const out = fillMqttTemplate(DEFAULT_MQTT_TEMPLATE, { imageBase64: "QUJD", paperWidthMm: 58, paperHeightMm: 71 });
    expect(JSON.parse(out)).toEqual({
      data_type: "png",
      data_base64: "QUJD",
      paper_type: 0,
      paper_width_mm: 58,
      paper_height_mm: 71,
      cut_paper: 1,
    });
  });
  it("base64-encodes bytes", () => {
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe("QUJD");
  });
});

describe("system print settings", () => {
  it("defaults and clamps the classic layout options", () => {
    const d = defaultPrintSettings().printing.classic;
    expect(d).toEqual({ color: true, layout: 1, fontSize: 11, marginX: 4, marginY: 4 });
    const s = normalizePrintSettings({
      printing: { classic: { color: false, layout: "2", fontSize: 99, marginX: -5, marginY: "abc" } },
    });
    expect(s.printing.classic).toEqual({ color: false, layout: 2, fontSize: 24, marginX: 0, marginY: 4 });
    expect(normalizePrintSettings({ printing: { classic: { layout: 3, fontSize: 2 } } }).printing.classic).toMatchObject({
      layout: 1,
      fontSize: 7,
    });
  });

  it("maps task tickets to selection tickets in System Print mode", () => {
    const s = defaultPrintSettings();
    s.printOption = "task_tickets_recursive";
    expect(effectivePrintOption(s)).toBe("selection_tickets_recursive");
    s.printOption = "task_tickets";
    expect(effectivePrintOption(s)).toBe("selection_tickets");
    expect(printOptionsFor("classic")).toEqual(["selection_tickets", "selection_tickets_recursive"]);
    s.printing.mode = "receipt_printer";
    expect(effectivePrintOption(s)).toBe("task_tickets");
    expect(printOptionsFor("receipt_printer")).toHaveLength(4);
  });

  it("reports incomplete printer setups", () => {
    const s = defaultPrintSettings();
    expect(printSettingsProblem(s)).toBeNull();
    s.printing.mode = "receipt_printer";
    s.printing.receipt.printerId = "";
    expect(printSettingsProblem(s)).toMatch(/printer/i);
    s.printing.receipt.printerId = "usb:1";
    expect(printSettingsProblem(s)).toBeNull();
    s.printing.mode = "mqtt";
    s.printing.mqtt.brokerUrl = " ";
    expect(printSettingsProblem(s)).toMatch(/broker/i);
    s.printing.mode = "bluetooth_printer";
    s.printing.bluetooth.deviceId = "";
    expect(printSettingsProblem(s)).toMatch(/Bluetooth/);
  });
});

describe("print limits", () => {
  const ticket = (n: number, withTitle = true): Ticket => ({
    breadcrumb: null,
    title: withTitle ? "T" : null,
    blocks: Array.from({ length: n }, (_, i) => ({ kind: "task" as const, text: `x${i}`, finished: false, depth: 0 })),
    taskIds: Array.from({ length: n }, (_, i) => `id${i}`),
  });

  it("counts items and estimates lines", () => {
    const ts = [ticket(3), ticket(2, false)];
    expect(countItems(ts)).toBe(5);
    expect(estimateLines(ts)).toBe(3 + 1 + 1 + 2 + 1);
  });

  it("caps output to the item limit, trimming the crossing ticket", () => {
    const ts = [ticket(6), ticket(6), ticket(6)];
    expect(capTickets(ts, 100)).toEqual({ tickets: ts, capped: false });
    const r = capTickets(ts, 8);
    expect(r.capped).toBe(true);
    expect(r.tickets).toHaveLength(2);
    expect(countItems(r.tickets)).toBe(8);
    expect(r.tickets[1].taskIds).toEqual(["id0", "id1"]);
  });
});
