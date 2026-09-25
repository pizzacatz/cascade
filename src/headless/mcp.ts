// MCP server exposing Cascade document operations as tools, so LLM agents can
// read and edit .col to-do lists directly. Started with `cascade-cli mcp`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as core from "./core";

const TYPES = ["task", "text", "heading", "separator", "folder", "template"] as const;
const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

const INSTRUCTIONS = `Cascade to-do lists are .col documents organised as spaces (e.g. "Home") containing items.
Folders hold child items and open as columns; tasks can be finished; items can be scheduled on calendar days.
Refer to items by id (preferred, from list/search results), exact text, or a path like "Home/Work/Launch".
Parents can be a space name, a folder id or name, or a path. Dates: YYYY-MM-DD, today, tomorrow, +N.
Adding a child under a task turns that task into a folder. Deleting moves items to Trash unless permanent.
Changes are saved immediately; the Cascade app reloads the file automatically if it is open.`;

export async function startMcpServer(defaultFile?: string): Promise<void> {
  const server = new McpServer({ name: "cascade", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const fileArg = z
    .string()
    .optional()
    .describe(defaultFile ? `Path to the .col document (default: ${defaultFile})` : "Path to the .col document");
  const fileOf = (f?: string) => {
    const file = f ?? defaultFile;
    if (!file) throw new core.CascadeError("No document: pass `file` (or start the server with --file).");
    return file;
  };
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
  const read = <T>(f: string | undefined, fn: () => T) => {
    try {
      return ok(core.withDoc(fileOf(f), fn, false));
    } catch (e) {
      return fail(e);
    }
  };
  const write = <T>(f: string | undefined, fn: () => T) => {
    try {
      return ok(core.withDoc(fileOf(f), fn, true));
    } catch (e) {
      return fail(e);
    }
  };
  const refs = z.array(z.string()).min(1).describe("Item ids (preferred), exact texts, or paths");

  server.registerTool(
    "list_items",
    {
      title: "List items",
      description: "List the items in a space or folder (the top of the Home space by default), optionally with nested children.",
      inputSchema: {
        file: fileArg,
        parent: z.string().optional().describe('Space name, folder id/name, or path like "Home/Work". Default: Home'),
        depth: z.union([z.number().int().min(1), z.literal("all")]).optional().describe("Levels of children to include (default 1)"),
        include_finished: z.boolean().optional().describe("Include finished tasks (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ file, parent, depth, include_finished }) => read(file, () => core.listItems({ parent, depth, includeFinished: include_finished })),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Get one item with its location, tags, date, and direct children.",
      inputSchema: { file: fileArg, item: z.string().describe("Item id, exact text, or path") },
      annotations: { readOnlyHint: true },
    },
    ({ file, item }) => read(file, () => core.getItem(item, 1)),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description: "Find items whose text contains a query, optionally filtered by type and tags (all tags must match).",
      inputSchema: {
        file: fileArg,
        query: z.string().optional().describe("Case-insensitive text to look for (empty = all items)"),
        types: z.array(z.enum(TYPES)).optional(),
        tags: z.array(z.string()).optional().describe("Tag names"),
        include_trash: z.boolean().optional(),
        include_finished: z.boolean().optional().describe("Default true"),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ file, query, types, tags, include_trash, include_finished, limit }) =>
      read(file, () => core.search(query ?? "", { types, tags, includeTrash: include_trash, includeFinished: include_finished, limit })),
  );

  server.registerTool(
    "get_agenda",
    {
      title: "Get agenda",
      description: "Items scheduled on a calendar day; for today, also unfinished overdue tasks.",
      inputSchema: { file: fileArg, date: z.string().optional().describe("YYYY-MM-DD, today, tomorrow, +N (default today)") },
      annotations: { readOnlyHint: true },
    },
    ({ file, date }) => read(file, () => core.agenda(date ?? "today")),
  );

  server.registerTool(
    "list_spaces_and_tags",
    {
      title: "List spaces and tags",
      description: "The document's spaces (top-level areas) and tags.",
      inputSchema: { file: fileArg },
      annotations: { readOnlyHint: true },
    },
    ({ file }) => read(file, () => ({ spaces: core.listSpaces(), tags: core.listTags() })),
  );

  server.registerTool(
    "add_item",
    {
      title: "Add item",
      description:
        "Create an item. Place it in a space/folder (`parent`), right after another item (`after`), or only on a calendar day (`date` without parent). Missing tags are created.",
      inputSchema: {
        file: fileArg,
        text: z.string().describe("The item's text"),
        type: z.enum(TYPES).optional().describe("Default task"),
        parent: z.string().optional().describe("Space/folder id, name, or path. Default: Home (unless only a date is given)"),
        after: z.string().optional().describe("Insert right after this item (same column)"),
        first: z.boolean().optional().describe("Insert at the top of the column instead of the bottom"),
        date: z.string().optional().describe("Also schedule on this day"),
        color: z.enum(COLORS).optional(),
        tags: z.array(z.string()).optional().describe("Tag names (tasks, folders, templates only)"),
        icon: z.string().optional().describe("Folder/template icon name"),
        finished: z.boolean().optional(),
      },
    },
    (a) => write(a.file, () => core.addItem({ ...a })),
  );

  server.registerTool(
    "add_items",
    {
      title: "Add several items",
      description: "Create several items in order in the same place (e.g. a checklist). Returns them all.",
      inputSchema: {
        file: fileArg,
        texts: z.array(z.string()).min(1),
        type: z.enum(TYPES).optional(),
        parent: z.string().optional(),
        date: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    ({ file, texts, type, parent, date, tags }) =>
      write(file, () => texts.map((text) => core.addItem({ text, type, parent, date, tags }))),
  );

  server.registerTool(
    "update_item",
    {
      title: "Update item",
      description: "Change an item's text, type, color, icon, tags, or finished state. Omitted fields are left unchanged.",
      inputSchema: {
        file: fileArg,
        item: z.string().describe("Item id, exact text, or path"),
        text: z.string().optional(),
        type: z.enum(TYPES).optional(),
        color: z.enum(COLORS).optional(),
        icon: z.string().nullable().optional().describe("Icon name; null restores the default progress circle"),
        add_tags: z.array(z.string()).optional(),
        remove_tags: z.array(z.string()).optional(),
        finished: z.boolean().optional(),
      },
    },
    ({ file, item, text, type, color, icon, add_tags, remove_tags, finished }) =>
      write(file, () => core.updateItem(item, { text, type, color, icon, addTags: add_tags, removeTags: remove_tags, finished })),
  );

  server.registerTool(
    "set_finished",
    {
      title: "Finish or reopen tasks",
      description: "Mark tasks finished (or unfinished).",
      inputSchema: { file: fileArg, items: refs, finished: z.boolean().optional().describe("Default true") },
    },
    ({ file, items, finished }) => write(file, () => core.setFinished(items, finished ?? true)),
  );

  server.registerTool(
    "move_items",
    {
      title: "Move items",
      description: "Move items into a space or folder (moving into a task turns it into a folder), optionally after a given item or first.",
      inputSchema: {
        file: fileArg,
        items: refs,
        to: z.string().describe("Destination space/folder id, name, or path"),
        after: z.string().optional(),
        first: z.boolean().optional(),
      },
    },
    ({ file, items, to, after, first }) => write(file, () => core.moveItems(items, to, { after, first })),
  );

  server.registerTool(
    "schedule_items",
    {
      title: "Schedule items",
      description: "Put items on a calendar day, or remove them from the calendar with date = null.",
      inputSchema: { file: fileArg, items: refs, date: z.string().nullable().describe("YYYY-MM-DD, today, tomorrow, +N, or null") },
    },
    ({ file, items, date }) => write(file, () => core.scheduleItems(items, date)),
  );

  server.registerTool(
    "delete_items",
    {
      title: "Delete items",
      description: "Move items (and their children) to Trash. Items already in Trash, or with permanent=true, are deleted for good.",
      inputSchema: { file: fileArg, items: refs, permanent: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    ({ file, items, permanent }) => write(file, () => core.deleteItems(items, { permanent })),
  );

  server.registerTool(
    "add_space",
    {
      title: "Add space",
      description: "Create a new top-level space.",
      inputSchema: { file: fileArg, name: z.string() },
    },
    ({ file, name }) => write(file, () => core.addSpace(name)),
  );

  server.registerTool(
    "prepare_day",
    {
      title: "Prepare recurring tasks",
      description: "Copy the templates of matching recurrence rules onto a day (today or later). Idempotent.",
      inputSchema: { file: fileArg, date: z.string().describe("YYYY-MM-DD, today, tomorrow, +N") },
    },
    ({ file, date }) => write(file, () => core.prepare(date)),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description: `Create a new .col document (fails if it exists). Templates: ${core.TEMPLATE_IDS.join(", ")}.`,
      inputSchema: { path: z.string(), template: z.string().optional() },
    },
    ({ path, template }) => {
      try {
        return ok(core.createDocument(path, template));
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
