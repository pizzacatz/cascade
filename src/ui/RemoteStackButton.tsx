import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { setCompact } from "../state/stack";
import { startRemoteStack, stopRemoteStack, useRemoteStack } from "../state/remoteStack";
import { toast } from "../state/store";

/** Stack runner button: control the Stack from a phone on this network. */
export function RemoteStackButton({ compact }: { compact: boolean }) {
  const info = useRemoteStack((s) => s.info);
  const busy = useRemoteStack((s) => s.busy);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (compact) {
    // No room for the QR code here; show that it's on and offer the full view.
    if (!info) return null;
    return (
      <button className="btn btn-ghost btn-sm btn-icon is-active" title="Remote control is on — expand to see the address" aria-label="Remote control is on" onClick={() => void setCompact(false)}>
        <Smartphone size={13} />
      </button>
    );
  }

  const turnOn = () => startRemoteStack().catch((e) => toast(`Remote control failed: ${String(e)}`, "error", 6000));

  return (
    <span className="remote-stack" ref={ref}>
      <button
        className={`btn btn-ghost btn-sm btn-icon ${info ? "is-active" : ""}`}
        aria-label="Remote control"
        aria-expanded={open}
        title={info ? "Remote control is on" : "Control this Stack from a phone"}
        onClick={() => setOpen((o) => !o)}
      >
        <Smartphone size={14} />
      </button>
      {open && (
        <div className="popover remote-stack-panel" role="dialog" aria-label="Remote control">
          <div className="remote-stack-title">Remote control</div>
          {info ? (
            <>
              {/* Generated locally by the backend from our own URL. */}
              <div className="remote-stack-qr" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
              <input className="input remote-stack-url" readOnly value={info.url} onFocus={(e) => e.currentTarget.select()} aria-label="Remote control address" />
              <p className="faint">Scan with a phone on the same network, or open the address in its browser. It stops when the Stack ends.</p>
              <button className="btn btn-sm" onClick={() => void stopRemoteStack()}>
                Turn off
              </button>
            </>
          ) : (
            <>
              <p className="faint">
                Show the current task on a phone on this network and mark tasks done, skip or pause from there. Anyone who has the address can control
                this Stack until it ends.
              </p>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={turnOn}>
                Turn on
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
