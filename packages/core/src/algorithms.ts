import { Doc } from "./doc.js";
import { Logoot, RGA } from "./reference.js";
import type { Algorithm, ChangeEvent, ReplicaID, SequenceCRDT, StateVector, TextDelta } from "./types.js";

/**
 * Wraps `Doc` in the same shape as the reference implementations, so the
 * anomaly and convergence tests can drive all three algorithms through one
 * loop and the results sit side by side.
 */
export class FugueText implements SequenceCRDT {
  readonly doc: Doc;

  constructor(replica?: ReplicaID) {
    this.doc = new Doc(replica === undefined ? {} : { replica });
  }

  get replica(): ReplicaID {
    return this.doc.replica;
  }

  get length(): number {
    return this.doc.length;
  }

  insert(index: number, text: string): void {
    this.doc.insert(index, text);
  }

  delete(index: number, count: number): void {
    this.doc.delete(index, count);
  }

  toString(): string {
    return this.doc.toString();
  }

  stateVector(): StateVector {
    return this.doc.stateVector();
  }

  /** One element: the encoded batch. Kept as an array to match the interface. */
  opsSince(sv: StateVector): Uint8Array[] {
    const u = this.doc.opsSince(sv);
    return u.length === 0 ? [] : [u];
  }

  applyOps(ops: unknown[]): void {
    for (const u of ops as Uint8Array[]) this.doc.applyUpdate(u);
  }

  authors(): ReplicaID[] {
    return this.doc.authors();
  }
}

export function createCRDT(algorithm: Algorithm, replica: ReplicaID): SequenceCRDT {
  switch (algorithm) {
    case "fugue":
      return new FugueText(replica);
    case "rga":
      return new RGA(replica);
    case "logoot":
      return new Logoot(replica);
  }
}

export const ALGORITHMS: readonly Algorithm[] = ["fugue", "rga", "logoot"];

/**
 * The subset of `Doc` the anomaly demonstration needs, implemented for the
 * reference algorithms too so all three can be driven through one code path.
 */
export interface AnyDoc {
  readonly replica: ReplicaID;
  readonly length: number;
  insert(index: number, text: string): void;
  delete(index: number, count: number): void;
  toString(): string;
  encodeStateAsUpdate(): Uint8Array;
  applyUpdate(u: Uint8Array): void;
  on(ev: "change", cb: (e: ChangeEvent) => void): () => void;
  /** One replica id per visible character, aligned with `toString()`. */
  authors(): ReplicaID[];
}

const JSON_ENC = new TextEncoder();
const JSON_DEC = new TextDecoder();

/**
 * Wraps RGA or Logoot in the `AnyDoc` surface.
 *
 * Two shortcuts, both fine for a demonstration and both deliberate: operations
 * go over the wire as JSON rather than the binary encoding, and change deltas
 * are derived by diffing the text before and after rather than being produced
 * by the algorithm. Neither affects what is being demonstrated, which is the
 * order the characters end up in.
 */
class ReferenceDoc implements AnyDoc {
  private readonly listeners = new Set<(e: ChangeEvent) => void>();

  constructor(private readonly inner: SequenceCRDT) {}

  get replica(): ReplicaID {
    return this.inner.replica;
  }

  get length(): number {
    return this.inner.length;
  }

  insert(index: number, text: string): void {
    this.mutate(() => this.inner.insert(index, text), true);
  }

  delete(index: number, count: number): void {
    this.mutate(() => this.inner.delete(index, count), true);
  }

  toString(): string {
    return this.inner.toString();
  }

  authors(): ReplicaID[] {
    return this.inner.authors();
  }

  encodeStateAsUpdate(): Uint8Array {
    return JSON_ENC.encode(JSON.stringify(this.inner.opsSince({})));
  }

  applyUpdate(u: Uint8Array): void {
    const ops = JSON.parse(JSON_DEC.decode(u)) as unknown[];
    this.mutate(() => this.inner.applyOps(ops), false);
  }

  on(_ev: "change", cb: (e: ChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private mutate(fn: () => void, local: boolean): void {
    if (this.listeners.size === 0) {
      fn();
      return;
    }
    const before = this.inner.toString();
    fn();
    const after = this.inner.toString();
    const deltas = diff(before, after);
    if (deltas.length === 0) return;
    const e: ChangeEvent = { deltas, local, origin: local ? "local" : "remote" };
    for (const l of this.listeners) l(e);
  }
}

/** Minimal edit script: trim the shared prefix and suffix, replace the middle. */
function diff(before: string, after: string): TextDelta[] {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;

  const removed = before.length - start - end;
  const added = after.slice(start, after.length - end);
  const out: TextDelta[] = [];
  if (removed > 0) out.push({ type: "delete", index: start, count: removed });
  if (added.length > 0) out.push({ type: "insert", index: start, text: added });
  return out;
}

/**
 * One factory for all three algorithms, for the anomaly demonstration.
 *
 * `rand` seeds Logoot's position generator. Logoot's interleaving is genuinely
 * random, so a demonstration of it has to be seeded or it says something
 * different every time it runs.
 */
export function createDoc(algorithm: Algorithm, replica: ReplicaID, rand?: () => number): AnyDoc {
  if (algorithm === "fugue") return new Doc({ replica });
  if (algorithm === "rga") return new ReferenceDoc(new RGA(replica));
  return new ReferenceDoc(rand === undefined ? new Logoot(replica) : new Logoot(replica, rand));
}
