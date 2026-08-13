/**
 * traces.ts — reproducible workload generators.
 *
 * Every generator takes a seeded PRNG (mulberry32) so a run with `--seed 7`
 * is bit-for-bit reproducible across machines and across libraries. Ops are
 * produced as plain data ({@link Op}) so the same trace can be replayed
 * against any Subject in subjects.ts without knowing anything about it.
 */

export type PRNG = () => number;

/** A single text mutation. Index/count are always in the coordinate space
 * of the document *at the time the op is applied* (i.e. after prior ops in
 * the same trace have already landed). */
export type Op =
  | { readonly type: "insert"; readonly index: number; readonly text: string }
  | { readonly type: "delete"; readonly index: number; readonly count: number };

/**
 * mulberry32 — small, fast, seeded PRNG. Not cryptographic; deterministic
 * given the same 32-bit seed, which is all we need for reproducible
 * benchmark traces.
 */
export function mulberry32(seed: number): PRNG {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,\n";

function randInt(rng: PRNG, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randChar(rng: PRNG): string {
  return ALPHABET[randInt(rng, ALPHABET.length)] as string;
}

/** Standard-normal sample via Box-Muller, using two PRNG draws. */
function gaussian(rng: PRNG): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Appends one character at a time, always at the current end of the doc.
 * The best case for every sequence CRDT: no tree rebalancing, no
 * concurrent-insert tie-breaking, pure append. */
export function sequentialTyping(n: number, rng: PRNG = mulberry32(1)): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    ops.push({ type: "insert", index: i, text: randChar(rng) });
  }
  return ops;
}

/** Inserts one character at a uniformly random position each time. The
 * adversarial case: no locality at all, so tree-shaped CRDTs get no benefit
 * from cached "last edited here" paths and index lookup cost dominates. */
export function randomInsert(n: number, rng: PRNG = mulberry32(1)): Op[] {
  const ops: Op[] = [];
  let len = 0;
  for (let i = 0; i < n; i++) {
    const index = len === 0 ? 0 : randInt(rng, len + 1);
    ops.push({ type: "insert", index, text: randChar(rng) });
    len++;
  }
  return ops;
}

/**
 * 85% insert at-or-near the cursor (small gaussian jitter), 10% delete
 * near the cursor, 5% cursor jump (no document mutation, just relocates
 * where subsequent inserts/deletes happen). This is the headline number:
 * it is the closest of the four generators to how a human actually types.
 */
export function realisticEditing(n: number, rng: PRNG = mulberry32(1)): Op[] {
  const ops: Op[] = [];
  let len = 0;
  let cursor = 0;
  const JITTER_STDDEV = 2;

  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.85) {
      const jitter = Math.round(gaussian(rng) * JITTER_STDDEV);
      const index = clamp(cursor + jitter, 0, len);
      const text = randChar(rng);
      ops.push({ type: "insert", index, text });
      len++;
      cursor = index + 1;
    } else if (r < 0.95) {
      if (len > 0) {
        const index = clamp(cursor - 1, 0, len - 1);
        ops.push({ type: "delete", index, count: 1 });
        len -= 1;
        cursor = index;
      }
    } else {
      cursor = len === 0 ? 0 : randInt(rng, len + 1);
    }
  }
  return ops;
}

/**
 * `replicas` independent op sequences, one per replica, each typing a
 * distinct word at the same starting position (0) with no knowledge of the
 * others. Applied concurrently (i.e. none of the replicas see each other's
 * ops until merge time) this is the standard interleaving stress test for
 * sequence CRDTs.
 */
export function concurrentRuns(
  replicas: number,
  runLength: number,
  rng: PRNG = mulberry32(1),
): Op[][] {
  const words: string[] = [];
  for (let r = 0; r < replicas; r++) {
    let word = "";
    for (let i = 0; i < runLength; i++) {
      word += randChar(rng);
    }
    words.push(word);
  }
  return words.map((word) => {
    const ops: Op[] = [];
    for (let i = 0; i < word.length; i++) {
      ops.push({ type: "insert", index: i, text: word[i] as string });
    }
    return ops;
  });
}
