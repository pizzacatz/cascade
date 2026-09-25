import { useApp } from "../state/store";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const saveError = useApp((s) => s.saveError);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {saveError && <div className="toast is-error is-sticky">{saveError}</div>}
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
