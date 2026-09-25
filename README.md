# Cascade

**An open-source, horizontal, column-based nested to-do list for the desktop.**

Instead of one long vertical list, Cascade shows your tasks as horizontally scrolling
columns: open a folder and its contents appear in a new column to the right, so the row of
open columns *is* your breadcrumb. A second lens — a calendar of day columns — shows the
same items in time, with recurring templates that prepare themselves onto upcoming days.

Documents are plain, human-readable `.col` JSON files that you own. Cascade has no accounts,
no cloud, no telemetry, and makes no network requests of its own.

![Cascade — columns and calendar](docs/screenshots/columns-calendar.png)

## Features

- **Columns view** — Miller-column navigation of nested folders, per-column progress rings,
  keyboard- and mouse-driven, smooth horizontal scrolling.
- **Calendar view** — per-day columns, an optional month day picker, drag items between
  days, split view with the columns (`Tab` / `Shift+Tab`).
- **Six item types** — task, text note, heading, separator, folder, and template.
- **Type to structure** — `# ` makes a heading, `---` a separator, `::` opens an inline
  command menu (all three triggers are configurable).
- **Keyboard first** — a dense shortcut map, a fuzzy command palette (`Ctrl+K`) with
  sub-pages (move, schedule, search, icons, tags…), and a context-aware help panel (`F1`).
- **Spaces** — separate top-level areas in one document, with icons, colours, archiving,
  and a Trash space for soft deletion.
- **Tags, colours and icons** — a shared ten-colour palette that adapts to light and dark
  themes; drag colour and tag chips from the toolbar onto items.
- **Conditional formatting** — task and folder rules with all/any logic over tags, text
  (incl. regex), spaces, schedule dates, finished state, and folder statistics
  (progress, overdue/today/future counts…).
- **Recurrence** — daily / weekly / monthly rules (incl. "2nd Tuesday", "last day")
  that copy template contents onto a day when it is prepared.
- **Stack** — a one-task-at-a-time focus session with no timer, a duration, an end time,
  or Pomodoro, plus a compact always-on-top runner window.
- **Printing** — system print, or task tickets on thermal/receipt printers: raw ESC/POS or
  StarPRNT over CUPS, image tickets via `lp`, Bluetooth LE printers, and MQTT print servers.
- **Undo everything** — every gesture is one undo step (`Ctrl+Z` / `Ctrl+Y`).
- **Safe files** — atomic saves, automatic local backups (10 per document, kept 5 days),
  lenient loading that repairs damaged files instead of refusing them.
- **Scriptable CLI** — open files, print, and prepare calendar days from scripts or cron,
  with JSON results and meaningful exit codes.

## Install

Pre-built `.deb`, `.rpm` and AppImage bundles are produced by CI (see
[`.github/workflows/build.yml`](.github/workflows/build.yml)). To build them yourself, see
below.

## Build from source

Requirements: Node.js 22+, Rust (stable), and the Tauri 2 Linux dependencies:

```sh
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev build-essential pkg-config
```

Then:

```sh
npm ci
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce .deb / .rpm / AppImage in src-tauri/target/release/bundle/
```

`npm run dev` runs the UI alone in a browser (documents are kept in `localStorage`), which
is handy for UI work. Printing to receipt printers and file dialogs need the desktop app.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Command palette / search items | `Ctrl+K` / `Ctrl+F` |
| Edit selected item | `Enter` or `F2` |
| New item below / new child | `Shift+Enter` / `Ctrl+Enter` |
| Toggle finished | `Space` |
| Navigate / extend selection | Arrows / `Shift+↑↓` |
| Move up, down / to top, bottom | `Ctrl+↑↓` / `Ctrl+Home`, `Ctrl+End` |
| Indent / unindent (next / previous day in calendar) | `Ctrl+→` / `Ctrl+←` |
| Move to… / schedule… | `Ctrl+Shift+←` / `Ctrl+Shift+→` |
| Duplicate / delete to Trash | `Ctrl+D` / `Delete` |
| Copy, cut, paste (as a plain-text outline) | `Ctrl+C`, `Ctrl+X`, `Ctrl+V` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Switch focus Columns ↔ Calendar / cycle visible views | `Tab` / `Shift+Tab` |
| Print / Stack | `Ctrl+P` / `Ctrl+L` |
| New / open / close document | `Ctrl+N` / `Ctrl+O` / `Ctrl+Shift+W` |
| Settings / document settings | `Ctrl+,` / `Ctrl+Shift+,` |
| Help panel / fullscreen | `F1` / `F11` |

While editing: `Enter` finishes and creates the next item, `Esc` stops editing,
`↑`/`↓` move to the previous/next item, `Alt+←`/`Alt+→` jump to the parent/first child.
Items left empty are removed automatically when you leave them.

## Command line

```
cascade [FILE.col]
cascade open FILE [--target ITEM_OR_SPACE_ID]
cascade print <calendar|space|item> --file FILE [--date YYYY-MM-DD | -d N] [--id ID]
              [--option task_tickets|task_tickets_recursive|selection_tickets|selection_tickets_recursive] [--wait]
cascade prepare-calendar --file FILE (--date YYYY-MM-DD | -d N)
```

`prepare-calendar` and `print … --wait` block until the running app has finished, print a
JSON result on stdout, and exit with `0` (prepared / already prepared / printed), `2` (no
matching recurrence rule) or `1` (error). A second launch forwards its arguments to the
running instance. Example cron entry that prepares tomorrow every evening:

```
0 21 * * * cascade prepare-calendar --file ~/Documents/life.col -d 1
```

## The `.col` file format

A document is UTF-8 JSON, written with two-space indentation:

```json
{
  "file_version": 4,
  "configuration": { "spaces": [], "tags": [], "conditionalFormatting": [],
                     "recurrenceRules": [], "preparedDays": [], "progressionMode": "by_level",
                     "viewState": {} },
  "items": [
    { "id": "…", "t": 90, "parent_id": "root", "position": "a0", "text": "Project" },
    { "id": "…", "t": 1, "parent_id": "…", "position": "a0", "text": "A task", "finished": true }
  ]
}
```

Items are a flat list; the tree is rebuilt from `parent_id`, and sibling order is a
fractional-index string in `position` (so moving an item rewrites only that item). Type codes
in `t`: `1` task, `2` text, `3` separator, `4` heading, `90` folder, `91` template.
Defaults are omitted; `c` is a colour index (0–9), `ic` an icon name, `tg` a tag-id list.
A calendar placement is `scheduleDate` + `schedulePosition`. The reader also accepts
older versions (a bare item array, `file_version` 2 and 3) and upgrades them on open.

This format is compatible with documents from the commercial app *Colonnes*; Cascade is an
independent project, not affiliated with or endorsed by its author, and contains none of
its code.

## Privacy

Cascade reads and writes only the files you open, its settings, and its backups. It never
contacts a server. The only network traffic it can produce is what *you* configure: sending
print jobs to an MQTT broker, or to a network printer through CUPS.

## Architecture

```
src/model/     pure TypeScript: types, .col codec, ordering keys, tree index,
               progression, conditional formatting, recurrence, outline (clipboard) format
src/state/     zustand store with immer-patch undo; operations (items, config, navigation),
               shortcut table, file lifecycle and autosave, CLI handling, Stack
src/print/     ticket building, canvas rasterisation, ESC/POS encoding, print dispatch, UI
src/ui/        React components (columns, calendar, overlays, palette, settings)
src/platform/  Tauri plugins in the desktop app, localStorage fallback in a browser
src-tauri/     Rust backend: CLI reply protocol, single instance, CUPS (lp), Bluetooth LE
               (btleplug/BlueZ), MQTT (rumqttc), packaging
```

Run the tests with `npm test` (TypeScript) and `cargo test` in `src-tauri/` (Rust).

## License

[MIT](LICENSE)
