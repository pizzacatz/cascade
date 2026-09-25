import { useApp } from "../../state/store";
import { CommandPalette } from "./CommandPalette";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { InlineMenu } from "./InlineMenu";
import { AppSettings } from "./AppSettings";
import { DocSettings } from "./DocSettings";
import { PrintOverlay, PrintSettingsOverlay } from "./PrintOverlays";
import { AboutOverlay, DebugOverlay, StackOverlay, TemplateOverlay } from "./MiscOverlays";

export function OverlayHost() {
  const o = useApp((s) => s.overlay);
  if (!o) return null;
  switch (o.kind) {
    case "command":
      return <CommandPalette pages={o.pages} />;
    case "context":
      return <ContextMenu x={o.x} y={o.y} target={o.target} />;
    case "confirm":
      return <ConfirmDialog {...o} />;
    case "prompt":
      return <PromptDialog {...o} />;
    case "inline":
      return <InlineMenu itemId={o.itemId} x={o.x} y={o.y} />;
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
  }
}
