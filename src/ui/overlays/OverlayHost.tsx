import { useApp } from "../../state/store";
import { CommandPalette } from "./CommandPalette";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { AppSettings } from "./AppSettings";
import { DocSettings } from "./DocSettings";
import { PrintOverlay, PrintSettingsOverlay } from "./PrintOverlays";
import { AboutOverlay, DebugOverlay, PrepareOverlay, StackOverlay, TemplateOverlay } from "./MiscOverlays";
import { BackupsOverlay } from "./BackupsOverlay";

export function OverlayHost() {
  const o = useApp((s) => s.overlay);
  if (!o) return null;
  switch (o.kind) {
    case "command":
      return <CommandPalette pages={o.pages} resume={o.resume} />;
    case "context":
      return <ContextMenu x={o.x} y={o.y} target={o.target} />;
    case "confirm":
      return <ConfirmDialog {...o} />;
    case "prompt":
      return <PromptDialog {...o} />;
    case "appSettings":
      return <AppSettings tab={o.tab} />;
    case "docSettings":
      return <DocSettings tab={o.tab} ruleId={o.ruleId} />;
    case "print":
      return <PrintOverlay scope={o.scope} />;
    case "printSettings":
      return <PrintSettingsOverlay />;
    case "stack":
      return <StackOverlay scope={o.scope} />;
    case "template":
      return <TemplateOverlay target={o.target} />;
    case "debug":
      return <DebugOverlay tab={o.tab} />;
    case "about":
      return <AboutOverlay />;
    case "prepare":
      return <PrepareOverlay date={o.date} />;
    case "backups":
      return <BackupsOverlay />;
  }
}
