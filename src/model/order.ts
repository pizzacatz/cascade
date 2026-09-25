// Fractional ordering keys. Sibling order is a lexicographically sortable
// base-62 string, so inserting or moving an item only rewrites that one item.
//
// Keys produced by the standard fractional-indexing scheme (e.g. "a0", "a1")
// are used whenever the neighbours are valid keys in that scheme. Documents in
// the wild also contain bare keys such as "a" and "b" (used for spaces), which
// that scheme rejects, so we fall back to a plain digit-string midpoint that
// works for any base-62 strings.

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Midpoint of two digit strings (a < b, either may be empty/null meaning -∞/+∞). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  // Find the common prefix.
  let n = 0;
  if (b !== null) {
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // Adjacent digits: keep a's first digit and recurse on the rest.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function trimZeros(s: string): string {
  return s.replace(/0+$/, "");
}

export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? null;
  const hi = b ?? null;
  try {
    return generateKeyBetween(lo, hi);
  } catch {
    try {
      const key = midpoint(trimZeros(lo ?? ""), hi);
      if (key !== "" && (lo === null || key > lo) && (hi === null || key < hi)) return key;
    } catch {
      // fall through
    }
    // No key strictly between exists (e.g. "a" and "a0"); append after the
    // lower bound. Callers re-balance siblings when ordering degrades.
    return (lo ?? "") + "V";
  }
}

export function keysBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
): string[] {
  if (n <= 0) return [];
  try {
    return generateNKeysBetween(a ?? null, b ?? null, n);
  } catch {
    const out: string[] = [];
    let lo = a ?? null;
    for (let i = 0; i < n; i++) {
      const k = keyBetween(lo, b ?? null);
      out.push(k);
      lo = k;
    }
    return out;
  }
}

export const keyAfter = (a: string | null | undefined) => keyBetween(a, null);
export const keyBefore = (b: string | null | undefined) => keyBetween(null, b);
