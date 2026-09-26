// FNV-1a 64-bit, used to name backup folders/files deterministically. Shared
// by the app and cascade-cli so both write backups to the same place.

export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Backups kept per document, and for how long. */
export const BACKUP_MAX_PER_DOC = 10;
export const BACKUP_MAX_AGE_MS = 5 * 24 * 3600 * 1000;

/** A backup file is named `<epoch ms>.<content hash>.col`. */
export function parseBackupName(name: string): { time: number; hash: string } | null {
  const m = /^(\d+)\.([0-9a-f]+)\.col$/.exec(name);
  return m ? { time: Number(m[1]), hash: m[2] } : null;
}
