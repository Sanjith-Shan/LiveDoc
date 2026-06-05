import { FugueTree, GC_TOKEN, type TNode } from "./fugue.js";
import { causallyStableFrontier, key, randomReplicaID, svGet } from "./id.js";
import { resolveSpans } from "./marks.js";
import {
  OP_DELETE,
  OP_INSERT,
  OP_MARK,
  OP_TOMBSTONE,
  OP_UNDELETE,
  decodeOps,
  encodeOps,
  type CharRange,
  type DeleteOp,
  type InsertOp,
  type MarkOp,
  type Op,
  type UndeleteOp,
} from "./ops.js";
import type {
  Anchor,
  ChangeEvent,
  DocStats,
  FormattedSpan,
  GCReport,
  MarkValue,
  ReplicaID,
  StateVector,
  TextDelta,
  TreeNodeJSON,
  Update,
} from "./types.js";
import { collect } from "./gc.js";
import { UndoManager } from "./undo.js";

export interface DocOptions {
  replica?: ReplicaID;
}

type Listener<T extends unknown[]> = (...args: T) => void;

/**
 * A collaborative text document.
 *
 * Local edits apply immediately and never wait on the network. Remote updates
 * are commutative, associative and idempotent, so they can arrive in any
 * order, more than once, or after an arbitrary partition, and every replica
 * that has seen the same set of operations holds the same text.
 */
export class Doc {
  readonly replica: ReplicaID;
  readonly tree = new FugueTree();

  /** Next counter to hand out, per replica. Also the state vector. */
  private readonly sv: StateVector = {};
  private lamport = 0;

  /**
   * Insert operations are regenerated from the tree on demand, so they are not
   * logged. Deletes, undeletes and marks are, because their effect cannot be
   * inverted back into an operation from the state alone. They are small and
   * far rarer than inserts.
   */
  readonly delOps = new Map<string, DeleteOp>();
  readonly undelOps = new Map<string, UndeleteOp>();
  readonly markOps: MarkOp[] = [];

  /** Operations whose causal dependencies have not arrived yet. */
  private pending: Op[] = [];

  private readonly changeListeners = new Set<Listener<[ChangeEvent]>>();
  private readonly updateListeners = new Set<Listener<[Update, unknown]>>();

  private undoMgr: UndoManager | null = null;
  private txDeltas: TextDelta[] | null = null;
  private txOps: Op[] | null = null;

  constructor(opts: DocOptions = {}) {
    this.replica = opts.replica ?? randomReplicaID();
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  get length(): number {
    return this.tree.length;
  }

  toString(): string {
    return this.tree.text();
  }

  insert(index: number, text: string): void {
    if (text.length === 0) return;
    if (index < 0 || index > this.tree.length) {
      throw new RangeError(`insert index ${index} out of range (length ${this.tree.length})`);
    }
    this.transact(() => {
      const anchor = this.tree.anchorFor(index);
      const op: InsertOp = {
        t: OP_INSERT,
        r: this.replica,
        c: this.nextCounter(text.length),
        len: text.length,
        content: text,
        pr: anchor.pr,
        pc: anchor.pc,
        side: anchor.side,
      };
      this.tree.applyInsert(op, index);
      this.record(op, [{ type: "insert", index, text }]);
      this.undoMgr?.noteInsert([{ r: op.r, c: op.c, len: op.len }]);
    });
  }

  delete(index: number, count: number): void {
    if (count <= 0) return;
    this.transact(() => {
      const targets = this.tree.rangeFor(index, count);
      if (targets.length === 0) return;
      const op: DeleteOp = {
        t: OP_DELETE,
        r: this.replica,
        c: this.nextCounter(1),
        lam: ++this.lamport,
        targets,
      };
      const token = key(op.r, op.c);
      const deltas = this.tree.mutateTokens(targets, token, true);
      this.delOps.set(token, op);
      this.record(op, deltas ?? []);
      this.undoMgr?.noteDelete(token, targets);
    });
  }

  // -------------------------------------------------------------------------
  // Rich text
  // -------------------------------------------------------------------------

  format(index: number, count: number, name: string, value: MarkValue): void {
    if (count <= 0) return;
    if (index < 0 || index + count > this.tree.length) {
      throw new RangeError(`format [${index}, ${index + count}) out of range (length ${this.tree.length})`);
    }
    this.transact(() => {
      const first = this.tree.findByIndex(index)!;
      // The end anchor sits *before the character that follows the range*, not
      // after the last one in it. That is what makes the range grow when you
      // keep typing at its end: new text lands before the anchor. A range that
      // reaches the end of the document anchors to the document end instead.
      const follows = index + count < this.tree.length ? this.tree.findByIndex(index + count) : null;
      const op: MarkOp = {
        t: OP_MARK,
        r: this.replica,
        c: this.nextCounter(1),
        lam: ++this.lamport,
        key: name,
        value,
        // Sticky at the end, not at the start: typing at the end of a bold run
        // continues to be bold, typing just before it does not become bold.
        start: { id: { r: first.node.r, c: first.node.c + first.offset }, after: false },
        end:
          follows === null
            ? { id: null, after: true }
            : { id: { r: follows.node.r, c: follows.node.c + follows.offset }, after: false },
      };
      this.markOps.push(op);
      this.record(op, []);
    });
  }

  spans(): FormattedSpan[] {
    return resolveSpans(this.tree, this.markOps);
  }

  /** Sticky position for an integer index, for cursors and anchors. */
  anchorAt(index: number, after = false): Anchor {
    if (this.tree.length === 0) return { id: null, after };
    const clamped = Math.max(0, Math.min(index, this.tree.length - 1));
    const loc = this.tree.findByIndex(clamped)!;
    return { id: { r: loc.node.r, c: loc.node.c + loc.offset }, after: after || index >= this.tree.length };
  }

  /** Resolves a sticky position back to an index in the current state. */
  indexOfAnchor(a: Anchor): number {
    if (a.id === null) return a.after ? this.tree.length : 0;
    const loc = this.tree.findChar(a.id.r, a.id.c);
    if (loc === null) return a.after ? this.tree.length : 0;
    const at = this.tree.indexOf(loc.node, loc.offset);
    return Math.min(this.tree.length, a.after && !loc.node.deleted ? at + 1 : at);
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  stateVector(): StateVector {
    return { ...this.sv };
  }

  /**
   * Everything this replica has that `sv` does not.
   *
   * Inserts are reconstructed from the tree in pre-order, so a parent is
   * always emitted before its children and the peer can apply the batch
   * without buffering. A node whose text has been reclaimed by GC is emitted
   * as an opaque tombstone run: the peer gets the ids it may need to anchor
   * against, without the text nobody can see anyway.
   */
  opsSince(sv: StateVector): Update {
    const ops: Op[] = [];
    for (const n of this.tree.preorder()) {
      if (n === this.tree.root || n.len === 0) continue;
      const have = svGet(sv, n.r);
      if (n.c + n.len <= have) continue;
      const from = Math.max(n.c, have);
      const off = from - n.c;
      const anchor = off > 0 ? { pr: n.r, pc: from - 1, side: 1 as const } : this.tree.anchorOf(n);
      ops.push({
        t: OP_INSERT,
        r: n.r,
        c: from,
        len: n.len - off,
        content: n.content === null ? null : n.content.slice(off),
        pr: anchor.pr,
        pc: anchor.pc,
        side: anchor.side,
      });
    }
    // A run whose text has been reclaimed may no longer have a delete record
    // anywhere, so its deletion has to be stated from the tree instead. Only
    // skeletons need this: while a record still exists it is sent below.
    for (const n of this.tree.walk()) {
      if (n === this.tree.root || !n.skeleton || n.len === 0) continue;
      if (svGet(sv, n.r) <= n.c) continue; // the peer gets it as an opaque insert run
      ops.push({ t: OP_TOMBSTONE, r: n.r, c: n.c, len: n.len });
    }
    for (const op of this.delOps.values()) if (op.c >= svGet(sv, op.r)) ops.push(op);
    for (const op of this.undelOps.values()) if (op.c >= svGet(sv, op.r)) ops.push(op);
    for (const op of this.markOps) if (op.c >= svGet(sv, op.r)) ops.push(op);
    return encodeOps(ops);
  }

  encodeStateAsUpdate(): Update {
    return this.opsSince({});
  }

  /** Idempotent and order-independent. Safe to call with anything, twice. */
  applyUpdate(u: Update, origin: unknown = "remote"): void {
    if (u.length === 0) return;
    const ops = decodeOps(u);
    const deltas: TextDelta[] = [];
    const applied: Op[] = [];
    for (const op of ops) {
      const r = this.integrate(op, deltas);
      if (r === "applied") applied.push(op);
      else if (r === "wait") this.enqueue(op);
    }
    if (applied.length > 0) this.drainPending(deltas, applied);
    if (applied.length > 0) {
      const forward = encodeOps(applied);
      for (const l of this.updateListeners) l(forward, origin);
    }
    if (deltas.length > 0) this.emitChange(deltas, false, origin);
  }

  snapshot(): Uint8Array {
    return this.encodeStateAsUpdate();
  }

  static load(bytes: Uint8Array, opts: DocOptions = {}): Doc {
    const d = new Doc(opts);
    d.applyUpdate(bytes, "load");
    return d;
  }

  /** Operations received but not yet applicable. Should be 0 at rest. */
  get pendingCount(): number {
    return this.pending.length;
  }

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  private nextCounter(width: number): number {
    const c = svGet(this.sv, this.replica);
    this.sv[this.replica] = c + width;
    return c;
  }

  /**
   * Applies one operation. `wait` means its causal dependencies have not
   * arrived; the caller buffers it and retries after the next success.
   */
  private integrate(op: Op, deltas: TextDelta[]): Verdict {
    const have = svGet(this.sv, op.r);

    if (op.t === OP_INSERT) {
      // A peer may regenerate a longer run than we are missing. Trim to the
      // suffix we actually need rather than dropping the whole operation.
      if (have >= op.c + op.len) return "skip";
      let use = op;
      if (have > op.c) {
        const off = have - op.c;
        use = {
          t: OP_INSERT,
          r: op.r,
          c: have,
          len: op.len - off,
          content: op.content === null ? null : op.content.slice(off),
          pr: op.r,
          pc: have - 1,
          side: 1,
        };
      } else if (have < op.c) {
        return "wait";
      }
      if (!this.tree.applyInsert(use)) return "wait";
      this.sv[op.r] = use.c + use.len;
      if (use.content !== null) {
        const loc = this.tree.findChar(use.r, use.c)!;
        deltas.push({ type: "insert", index: this.tree.indexOf(loc.node, loc.offset), text: use.content });
      }
      return "applied";
    }

    if (op.t === OP_TOMBSTONE) {
      // Carries no identity and consumes no counter, so the state-vector
      // guards below do not apply: it is applicable exactly when its
      // characters are present, and applying it twice changes nothing.
      const range = { r: op.r, c: op.c, len: op.len };
      if (!this.tree.has(range)) return "wait";
      const d = this.tree.mutateTokens([range], GC_TOKEN, true);
      if (d === null) return "wait";
      deltas.push(...d);
      return "applied";
    }

    if (have > op.c) return "skip"; // already seen
    if (have < op.c) return "wait";

    switch (op.t) {
      case OP_DELETE: {
        if (op.targets.some((t) => !this.tree.has(t))) return "wait";
        const token = key(op.r, op.c);
        const d = this.tree.mutateTokens(op.targets, token, true);
        if (d === null) return "wait";
        deltas.push(...d);
        this.delOps.set(token, op);
        break;
      }
      case OP_UNDELETE: {
        const token = key(op.ur, op.uc);
        const del = this.delOps.get(token);
        if (del === undefined) return "wait";
        const d = this.tree.mutateTokens(del.targets, token, false);
        if (d === null) return "wait";
        deltas.push(...d);
        this.undelOps.set(key(op.r, op.c), op);
        break;
      }
      case OP_MARK: {
        for (const a of [op.start, op.end]) {
          if (a.id !== null && this.tree.findChar(a.id.r, a.id.c) === null) return "wait";
        }
        this.markOps.push(op);
        break;
      }
    }

    this.sv[op.r] = op.c + 1;
    this.lamport = Math.max(this.lamport, op.lam);
    return "applied";
  }

  private enqueue(op: Op): void {
    for (const q of this.pending) if (q.t === op.t && q.r === op.r && q.c === op.c) return;
    this.pending.push(op);
  }

  /**
   * Retries buffered operations until a pass applies nothing new. Each pass is
   * linear in the buffer, and the buffer only shrinks, so this terminates.
   */
  private drainPending(deltas: TextDelta[], applied: Op[]): void {
    while (this.pending.length > 0) {
      let progress = false;
      const still: Op[] = [];
      for (const op of this.pending) {
        const r = this.integrate(op, deltas);
        if (r === "applied") {
          progress = true;
          applied.push(op);
        } else if (r === "wait") {
          still.push(op);
        }
      }
      this.pending = still;
      if (!progress) break;
    }
  }

  // -------------------------------------------------------------------------
  // Local operation plumbing
  // -------------------------------------------------------------------------

  /** Groups a local mutation so listeners see one update and one change. */
  private transact(fn: () => void): void {
    if (this.txOps !== null) {
      fn();
      return;
    }
    this.txOps = [];
    this.txDeltas = [];
    try {
      fn();
    } finally {
      const ops = this.txOps;
      const deltas = this.txDeltas!;
      this.txOps = null;
      this.txDeltas = null;
      if (ops.length > 0) {
        const u = encodeOps(ops);
        for (const l of this.updateListeners) l(u, "local");
      }
      if (deltas.length > 0) this.emitChange(deltas, true, "local");
    }
  }

  private record(op: Op, deltas: readonly TextDelta[]): void {
    this.txOps?.push(op);
    if (this.txDeltas !== null) this.txDeltas.push(...deltas);
  }

  private emitChange(deltas: TextDelta[], local: boolean, origin: unknown): void {
    if (this.changeListeners.size === 0) return;
    const e: ChangeEvent = { deltas, local, origin };
    for (const l of this.changeListeners) l(e);
  }

  /** Used by UndoManager to emit its inverse operations. */
  applyLocalOp(op: DeleteOp | UndeleteOp): void {
    this.transact(() => {
      if (op.t === OP_DELETE) {
        const token = key(op.r, op.c);
        const d = this.tree.mutateTokens(op.targets, token, true);
        this.delOps.set(token, op);
        this.record(op, d ?? []);
      } else {
        const token = key(op.ur, op.uc);
        const del = this.delOps.get(token);
        if (del === undefined) return;
        const d = this.tree.mutateTokens(del.targets, token, false);
        this.undelOps.set(key(op.r, op.c), op);
        this.record(op, d ?? []);
      }
    });
  }

  mintCounter(): number {
    return this.nextCounter(1);
  }

  mintLamport(): number {
    return ++this.lamport;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(ev: "change", cb: Listener<[ChangeEvent]>): () => void;
  on(ev: "update", cb: Listener<[Update, unknown]>): () => void;
  on(ev: "change" | "update", cb: Listener<[ChangeEvent]> | Listener<[Update, unknown]>): () => void {
    if (ev === "change") {
      const l = cb as Listener<[ChangeEvent]>;
      this.changeListeners.add(l);
      return () => {
        this.changeListeners.delete(l);
      };
    }
    const l = cb as Listener<[Update, unknown]>;
    this.updateListeners.add(l);
    return () => {
      this.updateListeners.delete(l);
    };
  }

  // -------------------------------------------------------------------------
  // Undo / GC / introspection
  // -------------------------------------------------------------------------

  undoManager(): UndoManager {
    return (this.undoMgr ??= new UndoManager(this));
  }

  /**
   * Reclaims tombstones that every known replica has already observed.
   *
   * Pass the state vector of every peer you are in contact with. The frontier
   * is their pointwise minimum together with your own: operations strictly
   * below it can never be concurrent with a future operation, which is what
   * makes collection safe.
   *
   * **An empty peer list collects nothing.** It means "I do not know what any
   * other replica has seen", and the safe reading of that is not "therefore
   * everything is settled". A document that genuinely has no other replicas
   * says so explicitly by passing its own state vector:
   *
   * ```ts
   * doc.gc([]);                    // no peers known -> collects nothing
   * doc.gc([doc.stateVector()]);   // "I am the only replica" -> collects
   * ```
   */
  gc(peers: readonly StateVector[] = []): GCReport {
    if (peers.length === 0) {
      return {
        nodesRemoved: 0,
        nodesCollapsed: 0,
        charsReclaimed: 0,
        bytesBefore: this.stats().bytes,
        bytesAfter: this.stats().bytes,
        frontier: {},
      };
    }
    const frontier = causallyStableFrontier([this.stateVector(), ...peers]);
    this.undoMgr?.prune(frontier);
    return collect(this, frontier);
  }

  /** Delete tokens the local undo stack still needs. GC must not pass these. */
  pinnedTokens(): ReadonlySet<string> {
    return this.undoMgr?.pinnedTokens() ?? EMPTY_TOKENS;
  }

  stats(): DocStats {
    let chars = 0;
    let tombstoned = 0;
    let nodes = 0;
    let skeletonNodes = 0;
    let bytes = 0;
    for (const n of this.tree.walk()) {
      if (n === this.tree.root) continue;
      nodes++;
      if (n.deleted) tombstoned += n.len;
      else chars += n.len;
      if (n.skeleton) skeletonNodes++;
      bytes += NODE_BYTES + n.children.length * 8;
      if (n.content !== null) bytes += STRING_BYTES + n.content.length * 2;
      if (n.del !== null) bytes += SET_BYTES + n.del.size * 48;
    }
    for (const op of this.delOps.values()) bytes += 64 + op.targets.length * 40;
    bytes += this.undelOps.size * 64;
    bytes += this.markOps.length * 160;
    return {
      chars,
      tombstoned,
      nodes,
      skeletonNodes,
      maxDepth: this.tree.maxDepth(),
      charsPerNode: nodes === 0 ? 0 : (chars + tombstoned) / nodes,
      bytes,
      marks: this.markOps.length,
    };
  }

  /** The replica that authored each visible character, in document order. */
  authors(): ReplicaID[] {
    const out: ReplicaID[] = [];
    for (const n of this.tree.walk()) {
      if (n === this.tree.root || n.deleted || n.content === null) continue;
      for (let i = 0; i < n.len; i++) out.push(n.r);
    }
    return out;
  }

  treeJSON(): TreeNodeJSON {
    const build = (n: TNode, side: "L" | "R" | "root"): TreeNodeJSON => ({
      id: n === this.tree.root ? "root" : key(n.r, n.c),
      content: n.content,
      length: n.len,
      side,
      deleted: n.deleted,
      skeleton: n.skeleton,
      children: n.children.map((c, i) => build(c, i < n.leftCount ? "L" : "R")),
    });
    return build(this.tree.root, "root");
  }

  /** Frontier below which operations are stable across every peer given. */
  stableFrontier(peers: readonly StateVector[]): StateVector {
    return causallyStableFrontier([this.stateVector(), ...peers]);
  }
}

export { GC_TOKEN };
export type { CharRange };

const EMPTY_TOKENS: ReadonlySet<string> = new Set<string>();

type Verdict = "applied" | "skip" | "wait";

/** Rough retained-size model; validated against heap measurements in bench. */
const NODE_BYTES = 96;
const STRING_BYTES = 24;
const SET_BYTES = 96;
