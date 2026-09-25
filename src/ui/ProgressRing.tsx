import type React from "react";
export function ProgressRing({ value, size = 16, stroke = 2.2 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value < 0 ? 0 : Math.min(1, value);
  return (
    <svg className="progress-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="progress-ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={`${c * v} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className={`progress-ring-value ${v >= 1 ? "is-done" : ""}`}
      />
    </svg>
  );
}

/**
 * The default folder icon: a circle that fills up (like a pie) as the tasks
 * inside the folder are completed.
 */
export function ProgressPie({ value, size = 16 }: { value: number; size?: number }) {
  const v = value < 0 ? 0 : Math.min(1, value);
  const c = size / 2;
  const r = c - 1.25;
  const inner = r - 1.6;
  let fill: React.ReactNode = null;
  if (v >= 1) fill = <circle cx={c} cy={c} r={inner} className="progress-pie-fill" />;
  else if (v > 0) {
    const a = v * 2 * Math.PI;
    const x = c + inner * Math.sin(a);
    const y = c - inner * Math.cos(a);
    const large = v > 0.5 ? 1 : 0;
    fill = <path d={`M ${c} ${c} L ${c} ${c - inner} A ${inner} ${inner} 0 ${large} 1 ${x} ${y} Z`} className="progress-pie-fill" />;
  }
  return (
    <svg className={`progress-pie ${v >= 1 ? "is-done" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={c} cy={c} r={r} fill="none" strokeWidth={1.5} className="progress-pie-outline" />
      {fill}
      {v >= 1 && (
        <path
          d={`M ${c - inner * 0.5} ${c} L ${c - inner * 0.1} ${c + inner * 0.4} L ${c + inner * 0.55} ${c - inner * 0.4}`}
          className="progress-pie-check"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** Folders with no custom icon (or the "progression" icon) show the progress pie. */
export const usesProgressPie = (type: string, icon: string | null | undefined) =>
  type === "folder" && (!icon || icon === "progression");
