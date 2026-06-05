/**
 * Weave — a CRDT engine for real-time collaborative editing.
 *
 * The document is a Fugue sequence CRDT with run-length compressed nodes,
 * causal-stability tombstone collection, Peritext-style rich text and undo
 * that behaves under concurrency. See DESIGN.md for why each of those is the
 * way it is, and what it costs.
 */
export { Doc, type DocOptions } from "./doc.js";
export { Awareness, PRESENCE_COLORS, colorFor } from "./awareness.js";
export { UndoManager } from "./undo.js";
export { FugueTree, TNode, GC_TOKEN } from "./fugue.js";
export { RGA, Logoot } from "./reference.js";
export { FugueText, createCRDT, createDoc, ALGORITHMS, type AnyDoc } from "./algorithms.js";
export { causallyStableFrontier, compareIds, key, parseKey, randomReplicaID } from "./id.js";
export { Decoder, Encoder } from "./encoding.js";
export {
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
  type TombstoneOp,
  type UndeleteOp,
} from "./ops.js";
export { resolveSpans } from "./marks.js";
export * from "./types.js";
