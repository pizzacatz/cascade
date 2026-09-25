// Plain-text outline format used for copy/paste, so content round-trips
// through any text field or other app:
//
//   # Heading            heading
//   ---                  separator
//   - [ ] Task           task (- [x] when finished)
//   + Folder             folder (children indented by two spaces)
//   > Note               text
//
// Parsing also accepts generic outlines: bullets (-, *, 1.) and bare lines
// become tasks, and anything with indented children becomes a folder.

import type { Item, ItemType } from "./types";
import { isContainerType } from "./types";
import type { DocIndex } from "./tree";
import { childrenOf } from "./tree";

export interface OutlineNode {
  type: ItemType;
  text: string;
  finished: boolean;
  /** Full item data when the node came from an in-app copy. */
  source?: Item;
  children: OutlineNode[];
}

function lineFor(it: Item): string {
  switch (it.type) {
    case "task":
      return `- [${it.finished ? "x" : " "}] ${it.text}`;
    case "heading":
      return `# ${it.text}`;
    case "separator":
      return "---";
    case "text":
      return `> ${it.text}`;
    case "folder":
    case "template":
      return `+ ${it.text}`;
  }
}

/** Build outline nodes for items (optionally with their subtrees). */
export function nodesFromItems(ix: DocIndex, items: Item[], withChildren: boolean): OutlineNode[] {
  const build = (it: Item): OutlineNode => ({
    type: it.type,
    text: it.text,
    finished: it.finished,
    source: it,
    children: withChildren ? childrenOf(ix, it.id).map(build) : [],
  });
  return items.map(build);
}

export function outlineToText(nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (ns: OutlineNode[], depth: number) => {
    for (const n of ns) {
      const fake = { type: n.type, text: n.text, finished: n.finished } as Item;
      lines.push("  ".repeat(depth) + lineFor(fake));
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

function parseLine(content: string): Omit<OutlineNode, "children"> {
  let m: RegExpExecArray | null;
  if ((m = /^#{1,6}\s+(.*)$/.exec(content))) return { type: "heading", text: m[1].trim(), finished: false };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(content)) return { type: "separator", text: "", finished: false };
  if ((m = /^[-*+]\s+\[( |x|X)\]\s?(.*)$/.exec(content)))
    return { type: "task", text: m[2].trim(), finished: m[1].toLowerCase() === "x" };
  if ((m = /^\+\s+(.*)$/.exec(content))) return { type: "folder", text: m[1].trim(), finished: false };
  if ((m = /^>\s?(.*)$/.exec(content))) return { type: "text", text: m[1].trim(), finished: false };
  if ((m = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(content))) return { type: "task", text: m[1].trim(), finished: false };
  return { type: "task", text: content.trim(), finished: false };
}

export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { indent: number; node: OutlineNode }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const ws = /^[\t ]*/.exec(raw)![0];
    const indent = ws.replace(/\t/g, "  ").length;
    const node: OutlineNode = { ...parseLine(raw.slice(ws.length)), children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  const fix = (ns: OutlineNode[]) => {
    for (const n of ns) {
      if (n.children.length && !isContainerType(n.type)) {
        if (n.type === "separator") {
          // Separators cannot hold children; hoist them as siblings is complex,
          // so treat the separator as an untitled folder instead.
          n.text = "";
        }
        n.type = "folder";
        n.finished = false;
      }
      fix(n.children);
    }
  };
  fix(roots);
  return roots;
}
