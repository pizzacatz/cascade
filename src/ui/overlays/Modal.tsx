import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { closeOverlay } from "../../state/overlays";

interface Props {
  title?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  height?: number | string;
  onClose?: () => void;
  className?: string;
  /** Let Escape be handled by the content instead of closing. */
  captureEscape?: boolean;
  labelledBy?: string;
}

export function Modal({ title, icon, children, footer, width = 560, height, onClose = closeOverlay, className, captureEscape }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], input[type=text], input:not([type]), textarea");
    (first ?? el)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !captureEscape) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose, captureEscape]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        style={{ width, height }}
      >
        {title !== undefined && (
          <header className="modal-header">
            {icon}
            <h2>{title}</h2>
            <button className="btn btn-ghost btn-sm btn-icon modal-close" aria-label="Close" onClick={onClose}>
              <X size={15} />
            </button>
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
