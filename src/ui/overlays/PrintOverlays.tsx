import { useMemo } from "react";
import { Printer } from "lucide-react";
import { useApp, set, toast, type PrintScopeRef } from "../../state/store";
import { runPrint, ticketsFor } from "../../state/printing";
import { closeOverlay } from "../../state/overlays";
import { PrintDialog } from "../../print/ui/PrintDialog";
import { PrintSettingsPanel } from "../../print/ui/PrintSettingsPanel";
import { defaultPrintBackend } from "../../print/backend";
import type { PrintSettings } from "../../print/settings";
import "../../print/ui/print-ui.css";
import "../../print/print.css";
import { Modal } from "./Modal";

const setSettings = (next: PrintSettings) => set({ printSettings: next });

export function PrintOverlay({ scope }: { scope: PrintScopeRef }) {
  const settings = useApp((s) => s.printSettings);
  const doc = useApp((s) => s.doc);
  // Recompute when the document or content options change.
  const tickets = useMemo(() => ticketsFor(scope), [scope, doc, settings.printOption, settings.printBreadcrumb, settings.printFinishedTasks]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div className="modal print-modal" role="dialog" aria-label="Print" style={{ width: 760 }}>
        <PrintDialog
          tickets={tickets}
          settings={settings}
          onChangeSettings={setSettings}
          onPrint={async () => {
            const r = await runPrint(scope);
            closeOverlay();
            if (settings.printing.mode !== "classic") toast(`Printed ${r.printed} ticket${r.printed === 1 ? "" : "s"}`, "success");
          }}
          onClose={closeOverlay}
        />
      </div>
    </div>
  );
}

export function PrintSettingsOverlay() {
  const settings = useApp((s) => s.printSettings);
  const backend = useMemo(() => defaultPrintBackend(), []);
  return (
    <Modal title="Print settings" icon={<Printer size={16} />} width={720} height="min(86vh, 820px)">
      <PrintSettingsPanel settings={settings} onChange={setSettings} backend={backend} />
    </Modal>
  );
}
