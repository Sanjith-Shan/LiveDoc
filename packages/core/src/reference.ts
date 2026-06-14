import { randomReplicaID, svGet } from "./id.js";
import type { ReplicaID, SequenceCRDT, StateVector } from "./types.js";

/**
 * Reference implementations of two other sequence CRDTs.
 *
 * They exist to be *wrong* in specific, documented ways. A claim that Fugue
 * avoids interleaving is worth very little without something next to it that
 * does interleave, on the same input, in the same test file. See
 * test/interleaving.anomaly.test.ts.
 *
 * Both are straightforward O(n) array implementations. They are not optimised
 * and are not meant to be: they are the control group, not the product.
 */

// ---------------------------------------------------------------------------
// RGA — Replicated Growable Array (Roh, Jeon, Kim & Lee, 2011)
// ---------------------------------------------------------------------------

interface RGAElem {
  r: ReplicaID;
  c: number;
  lam: number;
  ch: string;
  deleted: boolean;
}

interface RGAInsert {
  t: "i";
  r: ReplicaID;
  c: number;
  lam: number;
  ch: string;
  /** Origin: the character this one was inserted immediately after. */
  or: ReplicaID | null;
  oc: number;
}

interface RGADelete {
  t: "d";
  r: ReplicaID;
  c: number;
  tr: ReplicaID;
  tc: number;
}

type RGAOp = RGAInsert | RGADelete;

/**
 * RGA orders concurrent inserts at the same origin by descending timestamp.
 *
 * Forward runs survive that, because each character's origin is the previous
 * character, so a run forms a chain. **Backward** runs do not: every character
 * of a right-to-left run shares the same origin, so two concurrent backward
 * runs become one sibling list and shuffle together by timestamp. That is the
 * backward interleaving anomaly, and it is why this engine uses Fugue instead.
 */
export class RGA implements SequenceCRDT {
  readonly replica: ReplicaID;
  private readonly elems: RGAElem[] = [];
  private readonly log: RGAOp[] = [];
  private readonly seen = new Set<string>();
  private readonly sv: StateVector = {};
  private lam = 0;

  constructor(replica: ReplicaID = randomReplicaID()) {
    this.replica = replica;
  }

  get length(): number {
    let n = 0;
    for (const e of this.elems) if (!e.deleted) n++;
    return n;
  }

  toString(): string {
    let s = "";
    for (const e of this.elems) if (!e.deleted) s += e.ch;
    return s;
  }

  private visibleToRaw(i: number): number {
    let seen = 0;
    for (let k = 0; k < this.elems.length; k++) {
      if (this.elems[k]!.deleted) continue;
      if (seen === i) return k;
      seen++;
    }
    return this.elems.length;
  }

  insert(index: number, text: string): void {
    for (let k = 0; k < text.length; k++) {
      const raw = this.visibleToRaw(index + k);
      const prev = raw === 0 ? null : this.elems[raw - 1]!;
      const op: RGAInsert = {
        t: "i",
        r: this.replica,
        c: this.sv[this.replica] ?? 0,
        lam: ++this.lam,
        ch: text[k]!,
        or: prev === null ? null : prev.r,
        oc: prev === null ? 0 : prev.c,
      };
      this.apply(op);
    }
  }

  delete(index: number, count: number): void {
    for (let k = 0; k < count; k++) {
      const raw = this.visibleToRaw(index);
      const target = this.elems[raw];
      if (target === undefined) return;
      this.apply({ t: "d", r: this.replica, c: this.sv[this.replica] ?? 0, tr: target.r, tc: target.c });
    }
  }

  /** Later timestamps sort first, which is the RGA tie-break. */
  private newer(a: RGAElem, b: { lam: number; r: ReplicaID }): boolean {
    if (a.lam !== b.lam) return a.lam > b.lam;
    return a.r > b.r;
  }

  private apply(op: RGAOp): boolean {
    const k = `${op.r}@${op.c}`;
    if (this.seen.has(k)) return true;

    if (op.t === "i") {
      let at: number;
      if (op.or === null) {
        at = 0;
      } else {
        const oi = this.elems.findIndex((e) => e.r === op.or && e.c === op.oc);
        if (oi < 0) return false;
        at = oi + 1;
      }
      // The RGA scan: step over anything newer that already sits here.
      while (at < this.elems.length && this.newer(this.elems[at]!, op)) at++;
      this.elems.splice(at, 0, { r: op.r, c: op.c, lam: op.lam, ch: op.ch, deleted: false });
      this.lam = Math.max(this.lam, op.lam);
    } else {
      const target = this.elems.find((e) => e.r === op.tr && e.c === op.tc);
      if (target === undefined) return false;
      target.deleted = true;
    }

    this.seen.add(k);
    this.log.push(op);
    this.sv[op.r] = Math.max(svGet(this.sv, op.r), op.c + 1);
    return true;
  }

  authors(): ReplicaID[] {
    const out: ReplicaID[] = [];
    for (const e of this.elems) if (!e.deleted) out.push(e.r);
    return out;
  }

  stateVector(): StateVector {
    return { ...this.sv };
  }

  opsSince(sv: StateVector): RGAOp[] {
    return this.log.filter((op) => op.c >= svGet(sv, op.r));
  }

  applyOps(ops: unknown[]): void {
    let queue = ops as RGAOp[];
    for (;;) {
      const still: RGAOp[] = [];
      let progress = false;
      for (const op of queue) {
        if (this.apply(op)) progress = true;
        else still.push(op);
      }
      if (!progress || still.length === 0) break;
      queue = still;
    }
  }
}

// ---------------------------------------------------------------------------
// Logoot — dense position identifiers (Weiss, Urso & Molli, 2009)
// ---------------------------------------------------------------------------

interface Digit {
  d: number;
  r: ReplicaID;
}
type Pos = Digit[];

const BASE = 1 << 16;

function cmpPos(a: Pos, b: Pos): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.d !== y.d) return x.d - y.d;
    if (x.r !== y.r) return x.r < y.r ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Picks a position strictly between `p` and `q`.
 *
 * The choice is random within the available gap, which is what gives Logoot
 * its good expected identifier length — and what makes it interleave. Two
 * replicas typing concurrently into the same gap each draw independently, so
 * their characters shuffle: "hello" and "world" become "hweolrllod".
 */
function between(p: Pos, q: Pos, r: ReplicaID, rand: () => number): Pos {
  const out: Pos = [];
  let qBounds = true;
  for (let i = 0; ; i++) {
    const pd = p[i]?.d ?? 0;
    const qd = qBounds && i < q.length ? q[i]!.d : BASE;
    if (qd - pd > 1) {
      out.push({ d: pd + 1 + Math.floor(rand() * (qd - pd - 1)), r });
      return out;
    }
    const taken = p[i] ?? { d: pd, r };
    out.push(taken);
    if (qBounds && (i >= q.length || taken.d < (q[i]?.d ?? BASE))) qBounds = false;
    if (i > 64) {
      out.push({ d: 1 + Math.floor(rand() * (BASE - 2)), r });
      return out; // depth guard; unreachable for realistic documents
    }
  }
}

interface LogootElem {
  pos: Pos;
  ch: string;
  r: ReplicaID;
  c: number;
  deleted: boolean;
}

interface LogootOp {
  t: "i" | "d";
  r: ReplicaID;
  c: number;
  pos: Pos;
  ch: string;
}

/**
 * Logoot, the canonical position-identifier CRDT.
 *
 * Convergent and simple, and it interleaves in *both* directions, because a
 * position identifier says only "somewhere in this gap" and carries no record
 * of what the author was writing next to. Included as the strongest possible
 * contrast to the tree-based approach.
 */
export class Logoot implements SequenceCRDT {
  readonly replica: ReplicaID;
  private readonly elems: LogootElem[] = [];
  private readonly log: LogootOp[] = [];
  private readonly seen = new Set<string>();
  private readonly sv: StateVector = {};
  private readonly rand: () => number;

  constructor(replica: ReplicaID = randomReplicaID(), rand: () => number = Math.random) {
    this.replica = replica;
    this.rand = rand;
  }

  get length(): number {
    let n = 0;
    for (const e of this.elems) if (!e.deleted) n++;
    return n;
  }

  toString(): string {
    let s = "";
    for (const e of this.elems) if (!e.deleted) s += e.ch;
    return s;
  }

  private visibleToRaw(i: number): number {
    let seen = 0;
    for (let k = 0; k < this.elems.length; k++) {
      if (this.elems[k]!.deleted) continue;
      if (seen === i) return k;
      seen++;
    }
    return this.elems.length;
  }

  insert(index: number, text: string): void {
    for (let k = 0; k < text.length; k++) {
      const raw = this.visibleToRaw(index + k);
      const before = raw === 0 ? [] : this.elems[raw - 1]!.pos;
      const after = raw < this.elems.length ? this.elems[raw]!.pos : [];
      const pos = between(before, after, this.replica, this.rand);
      this.apply({ t: "i", r: this.replica, c: svGet(this.sv, this.replica), pos, ch: text[k]! });
    }
  }

  delete(index: number, count: number): void {
    for (let k = 0; k < count; k++) {
      const raw = this.visibleToRaw(index);
      const target = this.elems[raw];
      if (target === undefined) return;
      this.apply({ t: "d", r: this.replica, c: svGet(this.sv, this.replica), pos: target.pos, ch: "" });
    }
  }

  private apply(op: LogootOp): boolean {
    const k = `${op.r}@${op.c}`;
    if (this.seen.has(k)) return true;

    if (op.t === "i") {
      let lo = 0;
      let hi = this.elems.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmpPos(this.elems[mid]!.pos, op.pos) < 0) lo = mid + 1;
        else hi = mid;
      }
      this.elems.splice(lo, 0, { pos: op.pos, ch: op.ch, r: op.r, c: op.c, deleted: false });
    } else {
      const found = this.elems.find((e) => cmpPos(e.pos, op.pos) === 0);
      if (found === undefined) return false;
      found.deleted = true;
    }

    this.seen.add(k);
    this.log.push(op);
    this.sv[op.r] = Math.max(svGet(this.sv, op.r), op.c + 1);
    return true;
  }

  authors(): ReplicaID[] {
    const out: ReplicaID[] = [];
    for (const e of this.elems) if (!e.deleted) out.push(e.r);
    return out;
  }

  stateVector(): StateVector {
    return { ...this.sv };
  }

  opsSince(sv: StateVector): LogootOp[] {
    return this.log.filter((op) => op.c >= svGet(sv, op.r));
  }

  applyOps(ops: unknown[]): void {
    let queue = ops as LogootOp[];
    for (;;) {
      const still: LogootOp[] = [];
      let progress = false;
      for (const op of queue) {
        if (this.apply(op)) progress = true;
        else still.push(op);
      }
      if (!progress || still.length === 0) break;
      queue = still;
    }
  }
}
