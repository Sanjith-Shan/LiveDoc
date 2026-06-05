import { Doc } from "../src/index.js";
import type { StateVector, Update } from "../src/types.js";

/** Deterministic PRNG so every failing case in this suite is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo));
}

/** Full two-way exchange, the way two peers reconcile after a partition. */
export function sync(a: Doc, b: Doc): void {
  const forA = b.opsSince(a.stateVector());
  const forB = a.opsSince(b.stateVector());
  a.applyUpdate(forA);
  b.applyUpdate(forB);
}

export function syncAll(docs: readonly Doc[]): void {
  // Two passes: everyone pulls from everyone, then again so transitive
  // knowledge propagates in a single call regardless of ordering.
  for (let round = 0; round < 2; round++) {
    for (const a of docs) {
      for (const b of docs) {
        if (a !== b) a.applyUpdate(b.opsSince(a.stateVector()));
      }
    }
  }
}

/**
 * A network you can abuse: it holds messages, reorders them, duplicates them,
 * drops them, and cuts replicas off entirely.
 */
export class TestNetwork {
  private readonly queues = new Map<string, { to: string; u: Update; at: number; due: number }[]>();
  private readonly docs = new Map<string, Doc>();
  private partitioned = new Set<string>();
  private clock = 0;
  private round = 0;

  constructor(
    readonly rand: () => number,
    readonly opts: {
      duplicateRate?: number;
      dropRate?: number;
      reorder?: boolean;
      /** Hold each message for 0..maxDelayRounds flushes before delivering it. */
      maxDelayRounds?: number;
      /** Replicas whose messages are held for `maxDelayRounds` every time. */
      slowReplicas?: readonly string[];
    } = {},
  ) {}

  add(doc: Doc): void {
    this.docs.set(doc.replica, doc);
    this.queues.set(doc.replica, []);
    doc.on("update", (u, origin) => {
      if (origin !== "local") return;
      this.broadcast(doc.replica, u);
    });
  }

  partition(replica: string): void {
    this.partitioned.add(replica);
  }

  heal(replica: string): void {
    this.partitioned.delete(replica);
  }

  private broadcast(from: string, u: Update): void {
    if (this.partitioned.has(from)) return;
    for (const to of this.docs.keys()) {
      if (to === from || this.partitioned.has(to)) continue;
      if ((this.opts.dropRate ?? 0) > this.rand()) continue;
      const copies = (this.opts.duplicateRate ?? 0) > this.rand() ? 2 : 1;
      const maxDelay = this.opts.maxDelayRounds ?? 0;
      const slow = this.opts.slowReplicas?.includes(from) ?? false;
      const delay = slow ? maxDelay : Math.floor(this.rand() * (maxDelay + 1));
      for (let i = 0; i < copies; i++) {
        this.queues.get(to)!.push({
          to,
          u,
          at: this.opts.reorder ? this.rand() : this.clock++,
          due: this.round + delay,
        });
      }
    }
  }

  /**
   * Delivers everything that is due, in whatever order the flags imply.
   * Messages held by `maxDelayRounds` stay queued for a later flush.
   */
  flush(): void {
    this.round++;
    for (const [to, q] of this.queues) {
      if (q.length === 0) continue;
      const due = q.filter((m) => m.due <= this.round);
      const held = q.filter((m) => m.due > this.round);
      q.length = 0;
      q.push(...held);
      if (due.length === 0) continue;
      due.sort((x, y) => x.at - y.at);
      const doc = this.docs.get(to)!;
      for (const m of due) doc.applyUpdate(m.u, "net");
    }
  }

  /** Delivers every message still in flight, however far in the future it is due. */
  drain(): void {
    for (let i = 0; i < 64; i++) {
      const inFlight = [...this.queues.values()].reduce((n, q) => n + q.length, 0);
      if (inFlight === 0) return;
      this.flush();
    }
  }

  /** Closes the gaps that dropped messages leave, the way a real client does. */
  reconcile(): void {
    this.drain();
    syncAll([...this.docs.values()]);
  }

  inFlight(): number {
    return [...this.queues.values()].reduce((n, q) => n + q.length, 0);
  }

  all(): Doc[] {
    return [...this.docs.values()];
  }
}

export function svEqual(a: StateVector, b: StateVector): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}
