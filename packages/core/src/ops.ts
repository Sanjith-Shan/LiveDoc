import { Decoder, Encoder, ReplicaTable } from "./encoding.js";
import type { Anchor, MarkValue, ReplicaID, Side } from "./types.js";
import { LEFT, RIGHT } from "./types.js";

export const OP_INSERT = 0;
export const OP_DELETE = 1;
export const OP_UNDELETE = 2;
export const OP_MARK = 3;
export const OP_TOMBSTONE = 4;

/**
 * A contiguous run of characters inserted by one replica.
 *
 * `c` is the counter of the *first* character; the run occupies counters
 * `[c, c + content.length)`. Runs are why typing a paragraph costs one
 * operation rather than four hundred.
 */
export interface InsertOp {
  readonly t: typeof OP_INSERT;
  readonly r: ReplicaID;
  readonly c: number;
  /** Number of characters. Equals `content.length` unless `content` is null. */
  readonly len: number;
  /**
   * `null` means "an opaque run of `len` deleted characters".
   *
   * Garbage collection frees the text of causally stable tombstones but keeps
   * their ids, because a later insert may still anchor to one. Sending those
   * ids without their text is what lets a replica that has GC'd still bring a
   * brand-new peer fully up to date. See DESIGN.md, "The GC horizon".
   */
  readonly content: string | null;
  /** Character this run attaches to. `null` = the document root. */
  readonly pr: ReplicaID | null;
  readonly pc: number;
  readonly side: Side;
}

/**
 * Note the absence of a Lamport timestamp on inserts. Fugue does not need one:
 * position comes from the tree and concurrent siblings are ordered by id.
 * Deletes and marks do carry one, because "who wins" is a real question there.
 */

/** Character range, referenced by identity rather than by index. */
export interface CharRange {
  readonly r: ReplicaID;
  readonly c: number;
  readonly len: number;
}

/**
 * Deletion is an *add* of a token to every targeted character. A character is
 * visible when its token set is empty. This makes delete an OR-Set operation,
 * which is what lets undo be exact under concurrency: undoing a delete removes
 * only the token you added, so a concurrent delete by someone else survives
 * your undo.
 */
export interface DeleteOp {
  readonly t: typeof OP_DELETE;
  readonly r: ReplicaID;
  readonly c: number;
  readonly lam: number;
  readonly targets: readonly CharRange[];
}

/** Removes the tokens added by one specific DeleteOp. */
export interface UndeleteOp {
  readonly t: typeof OP_UNDELETE;
  readonly r: ReplicaID;
  readonly c: number;
  readonly lam: number;
  /** id of the DeleteOp being undone */
  readonly ur: ReplicaID;
  readonly uc: number;
}

/** Peritext-style formatting span, anchored to characters rather than indices. */
export interface MarkOp {
  readonly t: typeof OP_MARK;
  readonly r: ReplicaID;
  readonly c: number;
  readonly lam: number;
  readonly key: string;
  readonly value: MarkValue;
  readonly start: Anchor;
  readonly end: Anchor;
}

/**
 * "These characters are deleted, and that is now settled."
 *
 * Deletion is normally carried by a `DeleteOp`, which — unlike an insert —
 * cannot be reconstructed from the tree. Garbage collection eventually drops
 * those records, and once the last replica holding one has dropped it, a peer
 * that was offline when the delete happened could never learn about it: it
 * already has the characters, so the insert side of a sync skips them, and
 * there is no record left to send.
 *
 * This op closes that hole. It states the *state* rather than the operation,
 * so it is derivable from the tree at any time, carries no identity, consumes
 * no counter, and is idempotent. It is only ever emitted for runs whose text
 * has already been reclaimed, which is exactly the case where the record may
 * be gone.
 */
export interface TombstoneOp {
  readonly t: typeof OP_TOMBSTONE;
  readonly r: ReplicaID;
  readonly c: number;
  readonly len: number;
}

export type Op = InsertOp | DeleteOp | UndeleteOp | MarkOp | TombstoneOp;

const V_NULL = 0;
const V_TRUE = 1;
const V_FALSE = 2;
const V_STRING = 3;
const V_NUMBER = 4;

function writeAnchor(enc: Encoder, tbl: ReplicaTable, a: Anchor): void {
  if (a.id === null) {
    enc.u8(0);
    enc.u8(a.after ? 1 : 0);
    return;
  }
  enc.u8(1);
  enc.varint(tbl.index(a.id.r));
  enc.varint(a.id.c);
  enc.u8(a.after ? 1 : 0);
}

function readAnchor(dec: Decoder, tbl: ReplicaTable): Anchor {
  if (dec.u8() === 0) return { id: null, after: dec.u8() === 1 };
  const r = tbl.at(dec.varint());
  const c = dec.varint();
  return { id: { r, c }, after: dec.u8() === 1 };
}

function writeValue(enc: Encoder, v: MarkValue): void {
  if (v === null) enc.u8(V_NULL);
  else if (v === true) enc.u8(V_TRUE);
  else if (v === false) enc.u8(V_FALSE);
  else if (typeof v === "string") {
    enc.u8(V_STRING);
    enc.string(v);
  } else {
    enc.u8(V_NUMBER);
    enc.string(String(v));
  }
}

function readValue(dec: Decoder): MarkValue {
  switch (dec.u8()) {
    case V_NULL:
      return null;
    case V_TRUE:
      return true;
    case V_FALSE:
      return false;
    case V_STRING:
      return dec.string();
    case V_NUMBER:
      return Number(dec.string());
    default:
      throw new RangeError("decodeOps: unknown mark value tag");
  }
}

const MAGIC = 0xc7; // "Weave update", version 1 in the low nibble.
const VERSION = 1;

/**
 * Encodes a batch of operations.
 *
 * Layout: magic, version, replica table, op count, ops. The replica table is
 * built while serialising into a scratch encoder, then written first, so ids
 * are interned across the whole batch.
 */
export function encodeOps(ops: readonly Op[]): Uint8Array {
  const body = new Encoder(Math.max(64, ops.length * 24));
  const tbl = new ReplicaTable();

  body.varint(ops.length);
  for (const op of ops) {
    body.u8(op.t);
    body.varint(tbl.index(op.r));
    body.varint(op.c);
    if (op.t !== OP_INSERT && op.t !== OP_TOMBSTONE) body.varint(op.lam);
    switch (op.t) {
      case OP_INSERT: {
        if (op.content === null) {
          body.u8(0);
          body.varint(op.len);
        } else {
          body.u8(1);
          body.string(op.content);
        }
        if (op.pr === null) {
          body.u8(0);
        } else {
          body.u8(1);
          body.varint(tbl.index(op.pr));
          body.varint(op.pc);
        }
        body.u8(op.side);
        break;
      }
      case OP_DELETE: {
        body.varint(op.targets.length);
        for (const t of op.targets) {
          body.varint(tbl.index(t.r));
          body.varint(t.c);
          body.varint(t.len);
        }
        break;
      }
      case OP_UNDELETE: {
        body.varint(tbl.index(op.ur));
        body.varint(op.uc);
        break;
      }
      case OP_TOMBSTONE: {
        body.varint(op.len);
        break;
      }
      case OP_MARK: {
        body.string(op.key);
        writeValue(body, op.value);
        writeAnchor(body, tbl, op.start);
        writeAnchor(body, tbl, op.end);
        break;
      }
    }
  }

  const out = new Encoder(body.length + 64);
  out.u8(MAGIC);
  out.u8(VERSION);
  tbl.write(out);
  out.bytes(body.finish());
  return out.finish();
}

export function decodeOps(u: Uint8Array): Op[] {
  if (u.length === 0) return [];
  const dec = new Decoder(u);
  if (dec.u8() !== MAGIC) throw new Error("decodeOps: not a Weave update");
  const version = dec.u8();
  if (version !== VERSION) throw new Error(`decodeOps: unsupported version ${version}`);
  const tbl = ReplicaTable.read(dec);
  const body = new Decoder(dec.bytes());

  const n = body.varint();
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const t = body.u8();
    const r = tbl.at(body.varint());
    const c = body.varint();
    const lam = t === OP_INSERT || t === OP_TOMBSTONE ? 0 : body.varint();
    switch (t) {
      case OP_INSERT: {
        const hasContent = body.u8() === 1;
        const content = hasContent ? body.string() : null;
        const len = hasContent ? content!.length : body.varint();
        const hasParent = body.u8() === 1;
        const pr = hasParent ? tbl.at(body.varint()) : null;
        const pc = hasParent ? body.varint() : 0;
        const side = body.u8() === LEFT ? LEFT : RIGHT;
        void lam;
        ops.push({ t: OP_INSERT, r, c, len, content, pr, pc, side });
        break;
      }
      case OP_DELETE: {
        const count = body.varint();
        const targets: CharRange[] = [];
        for (let j = 0; j < count; j++) {
          targets.push({ r: tbl.at(body.varint()), c: body.varint(), len: body.varint() });
        }
        ops.push({ t: OP_DELETE, r, c, lam, targets });
        break;
      }
      case OP_UNDELETE: {
        const ur = tbl.at(body.varint());
        const uc = body.varint();
        ops.push({ t: OP_UNDELETE, r, c, lam, ur, uc });
        break;
      }
      case OP_TOMBSTONE: {
        void lam;
        ops.push({ t: OP_TOMBSTONE, r, c, len: body.varint() });
        break;
      }
      case OP_MARK: {
        const k = body.string();
        const value = readValue(body);
        const start = readAnchor(body, tbl);
        const end = readAnchor(body, tbl);
        ops.push({ t: OP_MARK, r, c, lam, key: k, value, start, end });
        break;
      }
      default:
        throw new RangeError(`decodeOps: unknown op tag ${t}`);
    }
  }
  return ops;
}

/**
 * How many counters an operation consumes. Inserts consume one per character;
 * a tombstone assertion consumes none, because it is a statement about state
 * rather than a new operation.
 */
export function opWidth(op: Op): number {
  if (op.t === OP_INSERT) return op.len;
  if (op.t === OP_TOMBSTONE) return 0;
  return 1;
}
