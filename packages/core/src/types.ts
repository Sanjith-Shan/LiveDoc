/**
 * Public type surface for @weave/core.
 *
 * Everything a consumer (editor, server, benchmarks) needs is declared here.
 * Implementation lives in doc.ts / fugue.ts / marks.ts / undo.ts / gc.ts.
 */

/** Stable per-session identifier for a replica. 8 chars of base36 by default. */
export type ReplicaID = string;

/** Identity of a single character (or of an operation). Unique forever. */
export interface OpID {
  /** replica that created it */
  readonly r: ReplicaID;
  /** monotonically increasing per-replica counter */
  readonly c: number;
}

/** `{ replicaA: 12, replicaB: 5 }` — next expected counter per replica. */
export type StateVector = Record<ReplicaID, number>;

/** Encoded, order-independent, idempotent batch of operations. */
export type Update = Uint8Array;

/** Which side of its parent a tree node sits on. */
export const LEFT = 0;
export const RIGHT = 1;
export type Side = typeof LEFT | typeof RIGHT;

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/** Formatting value. `null` clears the mark. */
export type MarkValue = string | number | boolean | null;

/**
 * A Peritext-style anchor: a position that sticks to a character rather than
 * to an integer index, so it survives concurrent edits.
 *
 * `after: true`  -> the anchor sits immediately *after* the character.
 * `after: false` -> immediately *before* it.
 *
 * `id: null` means the virtual start (before=false) or end of document.
 */
export interface Anchor {
  readonly id: OpID | null;
  readonly after: boolean;
}

export interface Mark {
  readonly id: OpID;
  readonly key: string;
  readonly value: MarkValue;
  readonly start: Anchor;
  readonly end: Anchor;
  /** Lamport timestamp, for last-writer-wins on the same key. */
  readonly lamport: number;
}

/** A run of characters that share identical formatting. */
export interface FormattedSpan {
  readonly text: string;
  readonly marks: Readonly<Record<string, MarkValue>>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Minimal text delta, in the shape a text editor can apply directly. */
export type TextDelta =
  | { readonly type: "insert"; readonly index: number; readonly text: string }
  | { readonly type: "delete"; readonly index: number; readonly count: number };

export interface ChangeEvent {
  readonly deltas: readonly TextDelta[];
  /** `true` when produced by a local call rather than by applyUpdate. */
  readonly local: boolean;
  readonly origin: unknown;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface DocStats {
  /** Visible characters. */
  chars: number;
  /** Characters retained only as tombstones. */
  tombstoned: number;
  /** Tree nodes (a node covers a run of 1..n characters). */
  nodes: number;
  /** Nodes whose content has been reclaimed by GC but whose id is retained. */
  skeletonNodes: number;
  /** Deepest root-to-leaf path. Drives index-lookup cost. */
  maxDepth: number;
  /** Mean characters per node — the run-length compression ratio. */
  charsPerNode: number;
  /** Approximate retained heap bytes for the document structure. */
  bytes: number;
  marks: number;
}

export interface GCReport {
  /** Nodes removed from the tree entirely. */
  nodesRemoved: number;
  /** Nodes whose content was freed but whose id was retained as structure. */
  nodesCollapsed: number;
  /** Tombstoned characters reclaimed. */
  charsReclaimed: number;
  bytesBefore: number;
  bytesAfter: number;
  /** The causally stable frontier used for this pass. */
  frontier: StateVector;
}

/** Serialisable view of the CRDT tree, for the visualiser. */
export interface TreeNodeJSON {
  id: string;
  content: string | null;
  length: number;
  side: "L" | "R" | "root";
  deleted: boolean;
  skeleton: boolean;
  children: TreeNodeJSON[];
}

// ---------------------------------------------------------------------------
// Presence (ephemeral — deliberately NOT part of the CRDT)
// ---------------------------------------------------------------------------

export interface CursorState {
  /** Anchor + head, as sticky positions. */
  anchor: Anchor | null;
  head: Anchor | null;
}

export interface PeerState {
  replica: ReplicaID;
  name: string;
  color: string;
  cursor: CursorState | null;
  /** ms since epoch of last update; peers time out. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

/**
 * `fugue`  — the real engine (Weidner et al. 2023). No interleaving.
 * `rga`    — Replicated Growable Array. Correct, but interleaves backward runs.
 * `logoot` — dense position identifiers. Correct, but interleaves everything.
 *
 * `rga` and `logoot` exist so the anomalies can be demonstrated rather than
 * asserted. See test/interleaving.anomaly.test.ts.
 */
export type Algorithm = "fugue" | "rga" | "logoot";

/** Minimal interface all three algorithms satisfy, for anomaly comparison. */
export interface SequenceCRDT {
  readonly replica: ReplicaID;
  insert(index: number, text: string): void;
  delete(index: number, count: number): void;
  toString(): string;
  get length(): number;
  /** Ops this replica has that the given state vector does not. */
  opsSince(sv: StateVector): unknown[];
  stateVector(): StateVector;
  /** Idempotent and order-independent. Buffers ops that are not yet causally ready. */
  applyOps(ops: unknown[]): void;
  /**
   * The replica that authored each visible character, in document order.
   * `authors()[i]` corresponds to `toString()[i]`.
   *
   * This is what makes interleaving *visible* rather than merely asserted:
   * colour the characters by author and a shuffled merge is obvious at a
   * glance. Deriving it by diffing text before and after a merge does not
   * work, because an interleaved merge is not a contiguous edit.
   */
  authors(): ReplicaID[];
}
