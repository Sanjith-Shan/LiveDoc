/**
 * subjects.ts — a uniform adapter over Weave, Yjs, and Automerge.
 *
 * This is the ONLY file allowed to import `@weave/core`. That import
 * is wrapped in a dynamic `import()` inside `createWeaveSubject()` so
 * that a missing/unbuildable core package fails at a controlled point (a
 * function call in run.ts) instead of crashing module evaluation the moment
 * anything in this file is loaded. Every other file in this package (harness,
 * traces, suites) only ever touches the `Subject`/`SubjectDoc` interfaces
 * below and knows nothing about any of the three libraries.
 *
 * Sync model, deliberately uniform across all three:
 *   stateVector()        -> an opaque token describing "what I have"
 *   changesSince(token)  -> bytes this doc has that `token` does not
 *   applyUpdate(bytes)   -> apply those bytes (idempotent, order-independent)
 *   encodeFull()         -> changesSince(the-empty-token), i.e. "everything"
 *
 * This mirrors the CRDT literature's "state vector diff" pattern, which is
 * exactly the shape `@weave/core` documents (`doc.stateVector()` /
 * `doc.opsSince(sv)` / `doc.applyUpdate(update)`) and the shape Yjs exposes
 * natively. Automerge doesn't have a state-vector concept (it uses causal
 * "heads" - content-addressed hashes of the latest changes - instead of
 * per-replica counters) but `Automerge.saveSince(doc, heads)` /
 * `Automerge.loadIncremental(doc, bytes)` is the same shape and is what a
 * real Automerge-based app uses for network sync, so the comparison is fair.
 */

import * as Automerge from "@automerge/automerge";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Uniform interface
// ---------------------------------------------------------------------------

export interface DocStatsLite {
  chars: number;
  tombstoned: number;
  nodes: number;
  skeletonNodes: number;
  maxDepth: number;
  charsPerNode: number;
  bytes: number;
  marks: number;
}

export interface GCReportLite {
  nodesRemoved: number;
  nodesCollapsed: number;
  charsReclaimed: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface SubjectDoc {
  insert(index: number, text: string): void;
  delete(index: number, count: number): void;
  toString(): string;
  readonly length: number;

  /** Opaque "what I have" token, meaningful only when passed back into
   * `changesSince` on some doc (possibly a different one, same subject). */
  stateVector(): unknown;
  /** Bytes this doc has that a peer holding `token` does not. May be empty. */
  changesSince(token: unknown): Uint8Array;
  /** Apply update bytes produced by `changesSince`/`encodeFull`. Idempotent. */
  applyUpdate(update: Uint8Array): void;
  /** Everything, for bootstrapping a brand new peer. */
  encodeFull(): Uint8Array;

  /** Fires with the bytes of each local-edit transaction, i.e. exactly what
   * a real provider (y-websocket and friends) sends over the wire per
   * change -- NOT a state-vector diff computed after the fact. Returns an
   * unsubscribe function. */
  onUpdate(cb: (bytes: Uint8Array) => void): () => void;

  /** Weave-only introspection. `null` for Yjs/Automerge. */
  stats(): DocStatsLite | null;
  /** Weave-only tombstone GC. `null` for Yjs/Automerge — neither
   * library exposes a comparable explicit-GC API; see suites/tombstone-gc.ts. */
  gc(peerStateVectors: readonly unknown[]): GCReportLite | null;
}

export interface Subject {
  readonly id: "weave" | "yjs" | "automerge";
  readonly label: string;
  readonly version: string;
  createDoc(replica: string): SubjectDoc;
}

// ---------------------------------------------------------------------------
// Weave
// ---------------------------------------------------------------------------

/**
 * Loads `@weave/core` and builds its Subject. Throws if the package
 * cannot be imported (e.g. it hasn't been built yet) — the caller (run.ts)
 * is responsible for catching that, printing a clear message, and exiting 1.
 */
export async function createWeaveSubject(): Promise<Subject> {
  const core = await import("@weave/core");
  const { Doc } = core;

  function wrap(doc: InstanceType<typeof Doc>): SubjectDoc {
    return {
      insert: (index, text) => doc.insert(index, text),
      delete: (index, count) => doc.delete(index, count),
      toString: () => doc.toString(),
      get length() {
        return doc.length;
      },
      stateVector: () => doc.stateVector(),
      changesSince: (token) => doc.opsSince(token as ReturnType<typeof doc.stateVector>),
      applyUpdate: (update) => doc.applyUpdate(update),
      encodeFull: () => doc.encodeStateAsUpdate(),
      // origin is "local" for edits made via insert/delete on this doc, and
      // whatever applyUpdate's caller passed (default "remote") otherwise --
      // filtering to "local" mirrors what a real client would forward.
      onUpdate: (cb) =>
        doc.on("update", (u, origin) => {
          if (origin === "local") cb(u);
        }),
      stats: () => doc.stats() as DocStatsLite,
      gc: (peerStateVectors) => {
        const report = doc.gc(peerStateVectors as Parameters<typeof doc.gc>[0]);
        return {
          nodesRemoved: report.nodesRemoved,
          nodesCollapsed: report.nodesCollapsed,
          charsReclaimed: report.charsReclaimed,
          bytesBefore: report.bytesBefore,
          bytesAfter: report.bytesAfter,
        };
      },
    };
  }

  return {
    id: "weave",
    label: "Weave",
    version: "workspace (packages/core)",
    createDoc(replica: string) {
      const doc = new Doc({ replica });
      return wrap(doc);
    },
  };
}

// ---------------------------------------------------------------------------
// Yjs
// ---------------------------------------------------------------------------

function wrapYjs(ydoc: Y.Doc, ytext: Y.Text): SubjectDoc {
  return {
    insert: (index, text) => ytext.insert(index, text),
    delete: (index, count) => ytext.delete(index, count),
    toString: () => ytext.toString(),
    get length() {
      return ytext.length;
    },
    stateVector: () => Y.encodeStateVector(ydoc),
    changesSince: (token) => Y.encodeStateAsUpdate(ydoc, token as Uint8Array | undefined),
    applyUpdate: (update) => Y.applyUpdate(ydoc, update),
    encodeFull: () => Y.encodeStateAsUpdate(ydoc),
    // Every insert/delete below runs as its own default transaction, so
    // this fires once per op with exactly the bytes a y-websocket-style
    // provider would broadcast for that change.
    onUpdate: (cb) => {
      const handler = (update: Uint8Array) => cb(update);
      ydoc.on("update", handler);
      return () => ydoc.off("update", handler);
    },
    stats: () => null,
    gc: () => null,
  };
}

/**
 * FNV-1a over the replica name, forced into the uint32 range Yjs's own
 * `random.uint32()` draws from. Deterministic, so two runs of the same
 * benchmark encode the same bytes.
 */
function deterministicClientID(replica: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < replica.length; i++) {
    h ^= replica.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createYjsSubject(version: string): Subject {
  return {
    id: "yjs",
    label: "Yjs",
    version,
    createDoc(replica: string) {
      const ydoc = new Y.Doc();
      // Y.Doc otherwise draws a random uint32 clientID, and Yjs writes that
      // id as a varint into every struct it encodes -- so the *same* op
      // sequence costs ~2 more bytes/op at clientID 1e9 than at clientID 7
      // (measured: 23,744 vs 39,740 bytes for 2,000 appends). Left random,
      // the wire-size suite partly measures a coin flip, and its ratio
      // lands on either side of parity depending on the draw. So the id is
      // derived from the replica name instead: reproducible under the
      // benchmark's seed, and still spread across the full uint32 range
      // that a real Yjs client would draw from, so the comparison is not
      // quietly flattered by an unrealistically small id.
      ydoc.clientID = deterministicClientID(replica);
      const ytext = ydoc.getText("text");
      return wrapYjs(ydoc, ytext);
    },
  };
}

// ---------------------------------------------------------------------------
// Automerge
// ---------------------------------------------------------------------------

type AmDoc = Automerge.Doc<{ text: string }>;

/**
 * Automerge quirk that matters for this benchmark: if two replicas each
 * independently call `Automerge.init()` and then set `d.text = ""`, they
 * create *two different* underlying objects that happen to share a map key.
 * Merging them resolves the key conflict by picking one arbitrarily and
 * silently discarding the other replica's edits. Real Automerge apps avoid
 * this by having exactly one origin create the document and everyone else
 * join via `load`/`loadIncremental`. We do the same: a single genesis
 * snapshot (computed once, lazily) is the ancestor of every doc this
 * subject creates, so any two docs from `createDoc()` merge correctly no
 * matter which "replica" created them or in what order.
 */
let genesisBytesCache: Uint8Array | null = null;
function genesisBytes(): Uint8Array {
  if (!genesisBytesCache) {
    let doc = Automerge.init<{ text: string }>("00");
    doc = Automerge.change(doc, (d) => {
      d.text = "";
    });
    genesisBytesCache = Automerge.save(doc);
  }
  return genesisBytesCache;
}

/** Automerge actor IDs must be an even-length lowercase hex string. UTF-8
 * byte-encoding a name always yields an even number of hex digits (two per
 * byte), so this is safe for any replica name. */
function actorIdFor(replica: string): string {
  const hex = Buffer.from(replica, "utf8").toString("hex");
  return hex.length > 0 ? hex : "00";
}

function wrapAutomerge(initial: AmDoc): SubjectDoc {
  // Automerge docs are immutable; "mutating" methods below reassign this
  // closure variable rather than mutating in place. Callers of SubjectDoc
  // never see the raw Automerge.Doc, so there is no risk of anyone holding
  // a stale reference across a mutation (the well-known Automerge "attempting
  // to change an out of date document" footgun).
  let doc = initial;
  const updateListeners = new Set<(bytes: Uint8Array) => void>();

  // Automerge has no update event; the closest equivalent to "the bytes a
  // real peer would send for this change" is Automerge.getLastLocalChange
  // right after Automerge.change, which is exactly what real Automerge
  // network code calls to sync a single edit.
  function applyLocalChange(mutator: (d: { text: string }) => void): void {
    doc = Automerge.change(doc, mutator);
    if (updateListeners.size > 0) {
      const bytes = Automerge.getLastLocalChange(doc);
      if (bytes) {
        for (const l of updateListeners) l(bytes);
      }
    }
  }

  return {
    insert: (index, text) => {
      applyLocalChange((d) => {
        Automerge.splice(d, ["text"], index, 0, text);
      });
    },
    delete: (index, count) => {
      applyLocalChange((d) => {
        Automerge.splice(d, ["text"], index, count);
      });
    },
    toString: () => doc.text,
    get length() {
      return doc.text.length;
    },
    stateVector: () => Automerge.getHeads(doc),
    changesSince: (token) => Automerge.saveSince(doc, token as Automerge.Heads),
    applyUpdate: (update) => {
      doc = Automerge.loadIncremental(doc, update);
    },
    encodeFull: () => Automerge.saveSince(doc, []),
    onUpdate: (cb) => {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    stats: () => null,
    gc: () => null,
  };
}

export function createAutomergeSubject(version: string): Subject {
  return {
    id: "automerge",
    label: "Automerge",
    version,
    createDoc(replica: string) {
      const doc = Automerge.load<{ text: string }>(genesisBytes(), actorIdFor(replica));
      return wrapAutomerge(doc);
    },
  };
}
