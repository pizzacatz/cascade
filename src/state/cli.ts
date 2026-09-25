// Command-line interface, interpreted by the frontend. The Rust side forwards
// argv (from the initial process or a second instance) and relays results
// back to a waiting `cascade … --wait` client via requestId.
//
//   cascade FILE.col
//   cascade open FILE [--target ID]
//   cascade print <calendar|space|item> --file FILE [--date YYYY-MM-DD | -d N] [--id ID] [--option OPT] [--wait]
//   cascade prepare-calendar --file FILE (--date YYYY-MM-DD | -d N)

import { isDayKey, addDays } from "../model/dates";
import { platform, type CliPayload } from "../platform";
import { get, set, toast, type PrintScopeRef } from "./store";
import { today } from "./derived";
import { openPath } from "./files";
import { prepareDay } from "./config";
import { runPrint } from "./printing";
import { selectColumnItem, switchSpace } from "./nav";
import { PRINT_OPTIONS, type PrintOption } from "../print/settings";

export type CliCommand =
  | { kind: "open"; file: string; target?: string }
  | { kind: "print"; scope: "calendar" | "space" | "item"; file: string; date?: string; id?: string; option?: PrintOption }
  | { kind: "prepare-calendar"; file: string; date: string }
  | { kind: "error"; message: string };

function takeOption(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    for (const n of names) if (args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
  }
  return undefined;
}

function resolveDate(args: string[], base = today()): string | undefined {
  const date = takeOption(args, "--date");
  if (date) return isDayKey(date) ? date : undefined;
  const d = takeOption(args, "-d", "--days");
  if (d !== undefined && /^-?\d+$/.test(d)) return addDays(base, Number(d));
  return undefined;
}

const isColPath = (a: string) => /\.col$/i.test(a) || a.startsWith("file://");

export function parseCli(argv: string[]): CliCommand | null {
  const [verb, ...rest] = argv;
  if (!verb) return null;
  if (verb === "open") {
    const file = rest.find((a) => !a.startsWith("-") && a !== takeOption(rest, "--target"));
    if (!file) return { kind: "error", message: "open: missing file" };
    return { kind: "open", file, target: takeOption(rest, "--target") };
  }
  if (verb === "print") {
    const scope = rest[0];
    if (scope !== "calendar" && scope !== "space" && scope !== "item")
      return { kind: "error", message: "print: expected calendar, space or item" };
    const file = takeOption(rest, "--file", "-f");
    if (!file) return { kind: "error", message: "print: --file is required" };
    const option = takeOption(rest, "--option") as PrintOption | undefined;
    if (option && !PRINT_OPTIONS.includes(option)) return { kind: "error", message: `print: unknown --option ${option}` };
    const date = scope === "calendar" ? resolveDate(rest) ?? today() : undefined;
    return { kind: "print", scope, file, date, id: takeOption(rest, "--id"), option };
  }
  if (verb === "prepare-calendar") {
    const file = takeOption(rest, "--file", "-f");
    if (!file) return { kind: "error", message: "prepare-calendar: --file is required" };
    const date = resolveDate(rest);
    if (!date) return { kind: "error", message: "prepare-calendar: --date YYYY-MM-DD or -d N is required" };
    return { kind: "prepare-calendar", file, date };
  }
  if (isColPath(verb)) return { kind: "open", file: verb };
  return { kind: "error", message: `Unknown command: ${verb}` };
}

async function ensureOpen(file: string, cwd?: string): Promise<string | null> {
  const p = platform();
  const path = await p.normalizePath(file, cwd);
  const s = get();
  const current = s.filePath ? await p.normalizePath(s.filePath) : null;
  if (current === path) return path;
  return (await openPath(path)) ? path : null;
}

export async function handleCliPayload(payload: CliPayload): Promise<void> {
  const p = platform();
  const cmd = parseCli(payload.argv);
  const requestId = payload.requestId;
  const reply = async (result: Record<string, unknown>) => {
    if (requestId) await p.completeCliRequest(requestId, { ...result, requestId }).catch((e) => console.warn(e));
  };
  if (!cmd) return;
  if (requestId) {
    try {
      await p.validateCliRequest(requestId);
    } catch (e) {
      toast(String(e), "error");
      return;
    }
  }
  if (cmd.kind === "error") {
    toast(cmd.message, "error", 6000);
    await reply({ status: "error", message: cmd.message, createdCount: 0 });
    return;
  }

  const path = await ensureOpen(cmd.file, payload.cwd);
  if (!path) {
    await reply({ status: "error", file: cmd.file, message: `Could not open ${cmd.file}`, createdCount: 0 });
    return;
  }

  if (cmd.kind === "open") {
    if (cmd.target) {
      const s = get();
      if (s.doc?.items[cmd.target]) selectColumnItem(cmd.target);
      else if (s.doc?.config.spaces.some((x) => x.id === cmd.target)) switchSpace(cmd.target);
    }
    return;
  }

  if (cmd.kind === "prepare-calendar") {
    const r = prepareDay(cmd.date);
    if (r.status === "prepared") toast(`Prepared ${r.createdCount} item(s) for ${cmd.date}`, "success");
    await reply({ file: path, date: cmd.date, status: r.status, createdCount: r.createdCount, ...(r.message ? { message: r.message } : {}) });
    return;
  }

  // print
  const s = get();
  let scope: PrintScopeRef;
  if (cmd.scope === "calendar") scope = { kind: "day", date: cmd.date! };
  else if (cmd.scope === "space") scope = { kind: "space", spaceId: cmd.id ?? s.view.currentSpaceId };
  else {
    if (!cmd.id || !s.doc?.items[cmd.id]) {
      await reply({ status: "error", file: path, message: "print item: --id of an existing item is required", createdCount: 0 });
      return;
    }
    scope = { kind: "selection", ids: [cmd.id] };
  }
  const saved = s.printSettings;
  try {
    if (cmd.option) useOption(cmd.option);
    const r = await runPrint(scope);
    await reply({ status: "printed", file: path, date: cmd.date ?? null, createdCount: 0, message: `Printed ${r.printed} ticket(s)` });
  } catch (e) {
    const message = (e as Error).message;
    toast(message, "error", 6000);
    await reply({ status: "error", file: path, date: cmd.date ?? null, createdCount: 0, message });
  } finally {
    if (cmd.option) restore(saved);
  }
}

function useOption(option: PrintOption) {
  set((st) => ({ printSettings: { ...st.printSettings, printOption: option } }));
}
function restore(saved: ReturnType<typeof get>["printSettings"]) {
  set({ printSettings: saved });
}

export async function startCli(): Promise<() => void> {
  const p = platform();
  const startup = await p.getStartupPayload().catch(() => null);
  let handledStartup = false;
  if (startup && startup.argv.length) {
    handledStartup = true;
    await handleCliPayload(startup);
  }
  const queued = await p.markCliReady().catch(() => []);
  for (const q of queued) await handleCliPayload(q);
  const unlisten = await p.onCliCommand((payload) => void handleCliPayload(payload));
  startupHandled = handledStartup || queued.length > 0;
  return unlisten;
}

let startupHandled = false;
export const cliOpenedSomething = () => startupHandled;
