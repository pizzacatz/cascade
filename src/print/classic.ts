// System Print: lay tickets out as HTML in a hidden #print-root element and
// open the OS/webview print dialog.

import "./print.css";
import type { Ticket, TicketBlock } from "./tickets";
import { defaultClassicConfig, type ClassicConfig } from "./settings";

const ROOT_ID = "print-root";

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderBlock(b: TicketBlock): HTMLElement {
  if (b.kind === "separator") {
    const sep = el("div", "pr-separator");
    sep.style.marginLeft = `${b.depth * 14}pt`;
    return sep;
  }
  const row = el("div", `pr-block pr-${b.kind}${b.finished ? " pr-finished" : ""}`);
  row.style.paddingLeft = `${b.depth * 14}pt`;
  if (b.kind === "task") row.appendChild(el("span", `pr-box${b.finished ? " pr-checked" : ""}`));
  row.appendChild(el("span", "pr-text", b.text || (b.kind === "folder" ? "Untitled" : "")));
  return row;
}

/** Accepts a full System Print config, or just the colour flag. */
function toConfig(cfg: ClassicConfig | boolean): ClassicConfig {
  return typeof cfg === "boolean" ? { ...defaultClassicConfig(), color: cfg } : cfg;
}

/** Build the printable DOM for tickets (also used for on-screen previews). */
export function renderTicketsHtml(tickets: Ticket[], config: ClassicConfig | boolean): HTMLElement {
  const cfg = toConfig(config);
  const doc = el("div", `pr-doc${cfg.layout === 2 ? " pr-two-col" : ""}`);
  doc.dataset.theme = cfg.color ? "print" : "print-bw";
  doc.style.fontSize = `${cfg.fontSize}pt`;
  doc.style.padding = `${cfg.marginY}vh ${cfg.marginX}%`;
  for (const t of tickets) {
    const card = el("section", "pr-ticket");
    if (t.breadcrumb && t.breadcrumb.length) card.appendChild(el("div", "pr-crumb", t.breadcrumb.join(" / ")));
    if (t.title) card.appendChild(el("div", "pr-title", t.title));
    for (const b of t.blocks) card.appendChild(renderBlock(b));
    doc.appendChild(card);
  }
  return doc;
}

function printRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Print tickets through the system print dialog. The print root is emptied
 * after printing; it is hidden on screen so leaving it in place is harmless if
 * the webview never fires `afterprint`.
 */
export async function printClassic(tickets: Ticket[], config: ClassicConfig | boolean): Promise<void> {
  const cfg = toConfig(config);
  const root = printRoot();
  root.replaceChildren(renderTicketsHtml(tickets, cfg));
  root.dataset.theme = cfg.color ? "print" : "print-bw";
  const cleanup = () => {
    root.replaceChildren();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Let layout settle so fonts and styles apply before the snapshot.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  window.print();
}
