// Small fuzzy matcher: subsequence match with bonuses for word starts and
// consecutive characters. Returns null when the query does not match.

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += 10;
    if (found === prev + 1) score += 15;
    if (found === 0 || /[\s\-_/.]/.test(t[found - 1])) score += 20;
    score -= Math.min(found - ti, 10);
    prev = found;
    ti = found + 1;
  }
  return score;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (x: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: { x: T; s: number; i: number }[] = [];
  items.forEach((x, i) => {
    const s = fuzzyScore(query, text(x));
    if (s !== null) scored.push({ x, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((e) => e.x);
}

/** Parse a loose date phrase for the schedule page. */
export function parseDatePhrase(q: string, today: string, weekStartsOn: "monday" | "sunday"): string | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const add = (n: number) => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  if (s === "today" || s === "tod") return today;
  if (s === "tomorrow" || s === "tom") return add(1);
  if (s === "yesterday") return add(-1);
  let m = /^\+?(\d+)\s*(d|day|days)?$/.exec(s);
  if (m) return add(Number(m[1]));
  m = /^\+?(\d+)\s*(w|week|weeks)$/.exec(s);
  if (m) return add(Number(m[1]) * 7);
  m = /^in\s+(\d+)\s*(d|days?|w|weeks?)$/.exec(s);
  if (m) return add(Number(m[1]) * (m[2].startsWith("w") ? 7 : 1));
  if (s === "next week") {
    const [y, mo, d] = today.split("-").map(Number);
    const wd = new Date(y, mo - 1, d).getDay();
    const start = weekStartsOn === "monday" ? 1 : 0;
    return add(((start - wd + 7) % 7) || 7);
  }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const name = s.replace(/^next\s+/, "");
  const idx = days.findIndex((d) => d.startsWith(name) && name.length >= 2);
  if (idx >= 0) {
    const [y, mo, d] = today.split("-").map(Number);
    const wd = new Date(y, mo - 1, d).getDay();
    return add(((idx - wd + 7) % 7) || 7);
  }
  // Month/day like "10/3" or "3.10" is ambiguous; accept M/D in the current year.
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const year = today.slice(0, 4);
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}
