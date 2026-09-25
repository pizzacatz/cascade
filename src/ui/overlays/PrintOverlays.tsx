import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useApp, get, set, toast, type PrintScopeRef } from "../../state/store";
import { currentPrintScope } from "../../state/printing";
import { indexOf, selectionOf } from "../../state/derived";
import { setFinished } from "../../state/items";
import { closeOverlay, openOverlay } from "../../state/overlays";
import { PrintDialog, type WhatToPrint } from "../../print/ui/PrintDialog";
import { PrintSettingsPanel } from "../../print/ui/PrintSettingsPanel";
import { defaultPrintBackend } from "../../print/backend";
import { printTickets } from "../../print/dispatch";
import { buildTickets, type Ticket } from "../../print/tickets";
import { effectivePrintOption, type PrintSettings } from "../../print/settings";
import { platform } from "../../platform";
import "../../print/ui/print-ui.css";
import "../../print/print.css";
import { Modal, SettingsSwitcher } from "./Modal";

const setSettings = (next: PrintSettings) => set({ printSettings: next });

/** The column and selection scopes the dialog can switch between. */
function scopeChoices(scope: PrintScopeRef): Partial<Record<WhatToPrint, PrintScopeRef>> {
  if (scope.kind === "selection") {
    const column = currentPrintScope("column");
    return column ? { selection: scope, column } : { selection: scope };
  }
  const sel = selectionOf(get());
  return sel.length ? { column: scope, selection: { kind: "selection", ids: sel } } : { column: scope };
}

export function PrintOverlay({ scope }: { scope: PrintScopeRef }) {
  const settings = useApp((s) => s.printSettings);
  const doc = useApp((s) => s.doc);
  const choices = useMemo(() => scopeChoices(scope), [scope]);
  const [which, setWhich] = useState<WhatToPrint>(scope.kind === "selection" ? "selection" : "column");
  const active = choices[which] ?? scope;
  // Recompute when the document, scope or content options change.
  const option = effectivePrintOption(settings);
  const tickets = useMemo(
    () => buildTickets(indexOf(doc), active, { printOption: option, printBreadcrumb: settings.printBreadcrumb, printFinishedTasks: settings.printFinishedTasks }),
    [active, doc, option, settings.printBreadcrumb, settings.printFinishedTasks],
  );
  const print = async (toPrint: Ticket[]) => {
    const s = get().printSettings;
    const res = await printTickets(toPrint, s, defaultPrintBackend());
    if (s.printMarkAsFinished) {
      const ids = [...new Set(toPrint.flatMap((t) => t.taskIds))];
      if (ids.length) setFinished(ids, true);
    }
    closeOverlay();
    if (s.printing.mode !== "classic") toast(`Printed ${res.printed} ticket${res.printed === 1 ? "" : "s"}`, "success");
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div className="modal print-modal" role="dialog" aria-label="Print" style={{ width: 860, maxWidth: "calc(100vw - 32px)" }}>
        <PrintDialog
          tickets={tickets}
          settings={settings}
          onChangeSettings={setSettings}
          onPrint={print}
          onClose={closeOverlay}
          whatToPrint={which}
          availableScopes={(Object.keys(choices) as WhatToPrint[])}
          onChangeWhatToPrint={setWhich}
          onOpenSettings={() => openOverlay({ kind: "printSettings" }, { stack: true })}
          copyText={(t) => platform().writeClipboard(t)}
        />
      </div>
    </div>
  );
}

export function PrintSettingsOverlay() {
  const settings = useApp((s) => s.printSettings);
  const backend = useMemo(() => defaultPrintBackend(), []);
  return (
    <Modal title="Print settings" icon={<Printer size={16} />} width={820} height="min(86vh, 820px)" footer={<SettingsSwitcher current="print" />}>
      <PrintSettingsPanel settings={settings} onChange={setSettings} backend={backend} />
    </Modal>
  );
}
