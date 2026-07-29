/**
 * Smallest common-prefix / common-suffix diff between two strings.
 *
 * Returns `[start, endOfOldRange, endOfNewRange]`: the old document should
 * have `[start, endOfOldRange)` deleted and `newValue.slice(start, endOfNewRange)`
 * inserted at `start`. Used to turn a raw textarea value into the minimal
 * `insert`/`delete` pair instead of rebuilding the whole document.
 */
export function diffRange(oldValue: string, newValue: string): [number, number, number] {
  const maxCommon = Math.min(oldValue.length, newValue.length);
  let start = 0;
  while (start < maxCommon && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldValue.length;
  let newEnd = newValue.length;
  while (oldEnd > start && newEnd > start && oldValue.charCodeAt(oldEnd - 1) === newValue.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return [start, oldEnd, newEnd];
}

/** Maps a single index through a sequence of TextDeltas, in application order. */
export function mapIndexThroughDeltas(
  index: number,
  deltas: readonly { type: "insert" | "delete"; index: number; text?: string; count?: number }[],
): number {
  let out = index;
  for (const d of deltas) {
    if (d.type === "insert") {
      const len = d.text?.length ?? 0;
      if (d.index <= out) out += len;
    } else {
      const count = d.count ?? 0;
      if (d.index < out) out -= Math.min(count, out - d.index);
    }
  }
  return out;
}

/** Cheap, deterministic, non-cryptographic string hash — for the convergence badge. */
export function shortHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = (h1 >>> 0) * 4294967296 + (h2 >>> 0);
  return combined.toString(16).padStart(12, "0").slice(0, 8);
}
