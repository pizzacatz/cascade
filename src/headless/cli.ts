// cascade-cli — create, read, update and delete items in .col documents from
// scripts and agents, without the app. Also serves the MCP server (`mcp`).

import * as core from "./core";
import type { ItemInfo } from "./core";

const VERSION = "0.1.0";

const HELP = `cascade-cli ${VERSION} — edit Cascade (.col) documents from the command line

Usage: cascade-cli <command> [FILE.col] [arguments] [--json]
  FILE may be omitted when CASCADE_FILE is set (or pass --file FILE).
  Items can be referred to by id, by exact text, or by path ("Home/Work/Launch").
  Parents can be a space name, a folder id/name, or a path.

Reading
  list    [--parent REF] [--depth N|all] [--hide-finished]   Items in a space/folder
  show    ITEM                                                One item (with children)
  search  [QUERY] [--type T]... [--tag NAME]... [--include-trash] [--hide-finished]
  agenda  [--date D]                                          A day's items (+ overdue today)
  spaces | tags                                               Spaces / tags in the document

Writing
  add       TEXT [--type T] [--parent REF | --after ITEM] [--first] [--date D]
                 [--color C] [--tag NAME]... [--icon NAME] [--finished]
  edit      ITEM [--text T] [--type T] [--color C] [--icon NAME] [--tag NAME]... [--untag NAME]...
  finish    ITEM...          unfinish ITEM...
  move      ITEM... --to REF [--after ITEM | --first]
  schedule  ITEM... --date D     unschedule ITEM...
  delete    ITEM... [--permanent]    (moves to Trash; items already in Trash are deleted)
  add-space NAME
  prepare   --date D          Copy recurring templates onto a day
  init      FILE [--template ${core.TEMPLATE_IDS.join("|")}]

Other
  mcp [--file DEFAULT.col]    Run the MCP server on stdio (for LLM agents)
  --help, --version

Types: task, text, heading, separator, folder, template
Colors: default gray brown orange yellow green blue purple pink red
Dates: YYYY-MM-DD, today, tomorrow, yesterday, +N, -N
Exit codes: 0 ok, 1 error, 2 bad usage`;

interface Parsed {
  positional: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
}

const BOOL_FLAGS = new Set(["json", "first", "permanent", "include-trash", "hide-finished", "finished", "help", "version"]);

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && isNaN(Number(a)))) {
      let name = a.replace(/^--?/, "");
      let value: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (name === "h") name = "help";
      if (name === "f") name = "file";
      if (BOOL_FLAGS.has(name) && value === undefined) {
        out.bools.add(name);
        continue;
      }
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
      (out.flags[name] ??= []).push(value);
    } else out.positional.push(a);
  }
  return out;
}

class UsageError extends Error {}

const one = (p: Parsed, name: string) => p.flags[name]?.at(-1);
const many = (p: Parsed, name: string) => p.flags[name] ?? [];

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function line(i: ItemInfo): string {
  let mark: string;
  switch (i.type) {
    case "task":
      mark = i.finished ? "[x]" : "[ ]";
      break;
    case "folder":
      mark = "▸";
      break;
    case "template":
      mark = "▣";
      break;
    case "heading":
      mark = "#";
      break;
    case "separator":
      return `——————  (${i.id})`;
    default:
      mark = "·";
  }
  const extra = [
    i.progress && `${i.progress} done`,
    i.date && `📅 ${i.date}`,
    i.tags?.length && i.tags.map((t) => `#${t}`).join(" "),
    i.color && i.color,
  ]
    .filter(Boolean)
    .join("  ");
  return `${mark} ${i.text || "(untitled)"}${extra ? `  ${extra}` : ""}  (${i.id})`;
}

function printTree(items: ItemInfo[], indent = "") {
  for (const i of items) {
    console.log(indent + line(i));
    if (i.children) printTree(i.children, indent + "    ");
  }
}

function printItems(items: ItemInfo[], withPath = false) {
  if (!items.length) console.log("(nothing)");
  for (const i of items) console.log(line(i) + (withPath && i.path ? `   — ${i.path}` : ""));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fileFrom(p: Parsed): string {
  if (p.positional[0]?.toLowerCase().endsWith(".col")) return p.positional.shift()!;
  const f = one(p, "file") ?? process.env.CASCADE_FILE;
  if (!f) throw new UsageError("No document given: pass FILE.col, --file FILE, or set CASCADE_FILE");
  return f;
}

function need(p: Parsed, what: string, n = 1): string[] {
  if (p.positional.length < n) throw new UsageError(`Missing ${what}`);
  return p.positional;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(`cascade-cli ${VERSION}`);
    return 0;
  }
  const p = parseArgs(rest);
  if (p.bools.has("help")) {
    console.log(HELP);
    return 0;
  }
  const json = p.bools.has("json");
  const emit = (data: unknown, human: () => void) => (json ? console.log(JSON.stringify(data, null, 2)) : human());

  if (cmd === "mcp") {
    const { startMcpServer } = await import("./mcp");
    await startMcpServer(one(p, "file") ?? process.env.CASCADE_FILE);
    return -1; // keep running
  }
  if (cmd === "init") {
    const file = need(p, "FILE")[0];
    const r = core.createDocument(file, one(p, "template"));
    emit(r, () => console.log(`Created ${r.path} (${r.template})`));
    return 0;
  }

  const file = fileFrom(p);
  switch (cmd) {
    case "list": {
      const depthFlag = one(p, "depth");
      const r = core.withDoc(
        file,
        () =>
          core.listItems({
            parent: one(p, "parent") ?? p.positional[0],
            depth: depthFlag === "all" ? "all" : depthFlag ? Number(depthFlag) : 1,
            includeFinished: !p.bools.has("hide-finished"),
          }),
        false,
      );
      emit(r, () => {
        console.log(r.location);
        if (!r.items.length) console.log("    (empty)");
        printTree(r.items, "    ");
      });
      return 0;
    }
    case "show": {
      const ref = need(p, "ITEM")[0];
      const r = core.withDoc(file, () => core.getItem(ref, 1), false);
      emit(r, () => {
        console.log(line(r));
        if (r.path) console.log(`    in ${r.path}`);
        if (r.children) printTree(r.children, "    ");
      });
      return 0;
    }
    case "search": {
      const r = core.withDoc(
        file,
        () =>
          core.search(p.positional.join(" "), {
            types: many(p, "type"),
            tags: many(p, "tag"),
            includeTrash: p.bools.has("include-trash"),
            includeFinished: !p.bools.has("hide-finished"),
          }),
        false,
      );
      emit(r, () => printItems(r, true));
      return 0;
    }
    case "agenda": {
      const r = core.withDoc(file, () => core.agenda(one(p, "date") ?? p.positional[0] ?? "today"), false);
      emit(r, () => {
        console.log(r.date);
        printItems(r.items, true);
        if (r.overdue.length) {
          console.log("\nOverdue");
          printItems(r.overdue, true);
        }
      });
      return 0;
    }
    case "spaces": {
      const r = core.withDoc(file, core.listSpaces, false);
      emit(r, () => r.forEach((s) => console.log(`${s.name}  (${s.itemCount} items, id ${s.id})`)));
      return 0;
    }
    case "tags": {
      const r = core.withDoc(file, core.listTags, false);
      emit(r, () => (r.length ? r.forEach((t) => console.log(`#${t.name}  ${t.color}  (id ${t.id})`)) : console.log("(no tags)")));
      return 0;
    }
    case "add": {
      const text = need(p, "TEXT").join(" ");
      const r = core.withDoc(file, () =>
        core.addItem({
          text,
          type: one(p, "type"),
          parent: one(p, "parent"),
          after: one(p, "after"),
          first: p.bools.has("first"),
          date: one(p, "date"),
          color: one(p, "color"),
          tags: many(p, "tag"),
          icon: one(p, "icon"),
          finished: p.bools.has("finished"),
        }),
      );
      emit(r, () => console.log(`Added ${line(r)}${r.path ? `   — ${r.path}` : ""}`));
      return 0;
    }
    case "edit": {
      const ref = need(p, "ITEM")[0];
      const icon = one(p, "icon");
      const r = core.withDoc(file, () =>
        core.updateItem(ref, {
          text: one(p, "text"),
          type: one(p, "type"),
          color: one(p, "color"),
          icon: icon === undefined ? undefined : icon === "default" ? null : icon,
          addTags: many(p, "tag"),
          removeTags: many(p, "untag"),
        }),
      );
      emit(r, () => console.log(`Updated ${line(r)}`));
      return 0;
    }
    case "finish":
    case "unfinish": {
      const refs = need(p, "ITEM");
      const r = core.withDoc(file, () => core.setFinished(refs, cmd === "finish"));
      emit(r, () => printItems(r));
      return 0;
    }
    case "move": {
      const refs = need(p, "ITEM");
      const to = one(p, "to");
      if (!to) throw new UsageError("move needs --to REF");
      const r = core.withDoc(file, () => core.moveItems(refs, to, { after: one(p, "after"), first: p.bools.has("first") }));
      emit(r, () => printItems(r, true));
      return 0;
    }
    case "schedule":
    case "unschedule": {
      const refs = need(p, "ITEM");
      const date = cmd === "schedule" ? one(p, "date") : null;
      if (cmd === "schedule" && !date) throw new UsageError("schedule needs --date D");
      const r = core.withDoc(file, () => core.scheduleItems(refs, date ?? null));
      emit(r, () => printItems(r));
      return 0;
    }
    case "delete": {
      const refs = need(p, "ITEM");
      const r = core.withDoc(file, () => core.deleteItems(refs, { permanent: p.bools.has("permanent") }));
      emit(r, () => {
        if (r.trashed.length) console.log(`Moved ${r.trashed.length} item(s) to Trash`);
        if (r.deleted.length) console.log(`Deleted ${r.deleted.length} item(s) permanently`);
      });
      return 0;
    }
    case "add-space": {
      const name = need(p, "NAME").join(" ");
      const r = core.withDoc(file, () => core.addSpace(name));
      emit(r, () => console.log(`Added space ${r.name} (id ${r.id})`));
      return 0;
    }
    case "prepare": {
      const date = one(p, "date") ?? p.positional[0];
      if (!date) throw new UsageError("prepare needs --date D");
      const r = core.withDoc(file, () => core.prepare(date));
      emit(r, () => console.log(`${r.date}: ${r.status}${r.createdCount ? ` (${r.createdCount} created)` : ""}${r.message ? ` — ${r.message}` : ""}`));
      return r.status === "error" ? 1 : r.status === "no_matching_rule" ? 2 : 0;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}" (see --help)`);
  }
}

run(process.argv.slice(2))
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((e) => {
    if (e instanceof UsageError) {
      console.error(`cascade-cli: ${e.message}`);
      process.exit(2);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: msg }));
    else console.error(`cascade-cli: ${msg}`);
    process.exit(1);
  });
