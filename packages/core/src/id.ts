import type { OpID, ReplicaID, StateVector } from "./types.js";

/** Map key for a character or operation id. Hot path — keep it a plain string. */
export function key(r: ReplicaID, c: number): string {
  return r + "@" + c;
}

export function idKey(id: OpID): string {
  return id.r + "@" + id.c;
}

export function parseKey(k: string): OpID {
  const at = k.lastIndexOf("@");
  return { r: k.slice(0, at), c: Number(k.slice(at + 1)) };
}

/**
 * Total order over ids, used to order concurrent siblings in the Fugue tree.
 *
 * Any total order converges. This one is arbitrary but deterministic: replica
 * id ascending, then counter ascending. It is *not* Lamport-ordered, and it
 * does not need to be — see DESIGN.md, "Why sibling order is free".
 */
export function compareIds(ar: ReplicaID, ac: number, br: ReplicaID, bc: number): number {
  if (ar === br) return ac - bc;
  return ar < br ? -1 : 1;
}

/** 8 characters of base36. Collision risk across a session is negligible. */
export function randomReplicaID(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

export function svGet(sv: StateVector, r: ReplicaID): number {
  return sv[r] ?? 0;
}

export function svClone(sv: StateVector): StateVector {
  return { ...sv };
}

/**
 * Pointwise minimum across every peer's state vector, including our own.
 *
 * Operations strictly below this frontier have been observed by every replica
 * we know about, so no future operation can be concurrent with them. That is
 * the safety condition for tombstone collection.
 */
export function causallyStableFrontier(svs: StateVector[]): StateVector {
  if (svs.length === 0) return {};
  const replicas = new Set<ReplicaID>();
  for (const sv of svs) for (const r of Object.keys(sv)) replicas.add(r);
  const out: StateVector = {};
  for (const r of replicas) {
    let min = Infinity;
    for (const sv of svs) min = Math.min(min, svGet(sv, r));
    out[r] = min === Infinity ? 0 : min;
  }
  return out;
}
