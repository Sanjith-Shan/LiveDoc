import type { Doc } from "./doc.js";
import type { Anchor, CursorState, PeerState, ReplicaID } from "./types.js";

/**
 * Presence: who is here, and where their caret is.
 *
 * Deliberately *not* part of the CRDT. Presence is ephemeral, high-frequency
 * and worthless five seconds later; putting it in the document would mean
 * paying tombstone and history costs forever for data with a two-second
 * lifetime. It is last-writer-wins per replica with a timeout, which is all it
 * needs to be.
 *
 * The one part that does need care: a cursor is stored as a pair of *sticky
 * anchors*, not integers. If a collaborator inserts a paragraph above you,
 * your caret has to stay on the same character rather than sliding. That is
 * the same anchor machinery the formatting marks use.
 */
export class Awareness {
  private readonly states = new Map<ReplicaID, PeerState>();
  private readonly listeners = new Set<(peers: PeerState[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly doc: Doc,
    readonly timeoutMs = 30_000,
  ) {
    this.states.set(doc.replica, {
      replica: doc.replica,
      name: doc.replica.slice(0, 4),
      color: colorFor(doc.replica),
      cursor: null,
      updatedAt: Date.now(),
    });
  }

  get local(): PeerState {
    return this.states.get(this.doc.replica)!;
  }

  setLocal(patch: Partial<Pick<PeerState, "name" | "color">>): void {
    const cur = this.local;
    this.states.set(this.doc.replica, { ...cur, ...patch, updatedAt: Date.now() });
    this.emit();
  }

  /** Integer selection to sticky anchors. Pass `null` to clear. */
  setCursor(anchorIndex: number | null, headIndex: number | null): void {
    const cur = this.local;
    const cursor: CursorState | null =
      anchorIndex === null || headIndex === null
        ? null
        : {
            anchor: this.doc.anchorAt(anchorIndex, anchorIndex >= this.doc.length),
            head: this.doc.anchorAt(headIndex, headIndex >= this.doc.length),
          };
    this.states.set(this.doc.replica, { ...cur, cursor, updatedAt: Date.now() });
    this.emit();
  }

  /** Sticky anchors back to indices in the document as it stands right now. */
  cursorIndices(replica: ReplicaID): { anchor: number; head: number } | null {
    const s = this.states.get(replica);
    if (s === undefined || s.cursor === null) return null;
    const a = s.cursor.anchor;
    const h = s.cursor.head;
    if (a === null || h === null) return null;
    return { anchor: this.doc.indexOfAnchor(a), head: this.doc.indexOfAnchor(h) };
  }

  peers(): PeerState[] {
    this.expire();
    return [...this.states.values()];
  }

  remotePeers(): PeerState[] {
    return this.peers().filter((p) => p.replica !== this.doc.replica);
  }

  encode(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.local));
  }

  applyRemote(bytes: Uint8Array): void {
    let state: PeerState;
    try {
      state = JSON.parse(new TextDecoder().decode(bytes)) as PeerState;
    } catch {
      return; // presence is best-effort; a malformed frame is not an error
    }
    if (typeof state?.replica !== "string" || state.replica === this.doc.replica) return;
    const prev = this.states.get(state.replica);
    if (prev !== undefined && prev.updatedAt > state.updatedAt) return;
    this.states.set(state.replica, { ...state, updatedAt: Date.now() });
    this.emit();
  }

  removePeer(replica: ReplicaID): void {
    if (this.states.delete(replica)) this.emit();
  }

  on(_ev: "change", cb: (peers: PeerState[]) => void): () => void {
    this.listeners.add(cb);
    if (this.timer === null) {
      this.timer = setInterval(() => this.expire(), Math.max(1000, this.timeoutMs / 4));
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(cb);
    };
  }

  destroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.states.clear();
  }

  private expire(): void {
    const cutoff = Date.now() - this.timeoutMs;
    let changed = false;
    for (const [r, s] of this.states) {
      if (r !== this.doc.replica && s.updatedAt < cutoff) {
        this.states.delete(r);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = [...this.states.values()];
    for (const l of this.listeners) l(snapshot);
  }
}

/**
 * Four hues chosen to stay distinguishable on both light and dark backgrounds
 * and under deuteranopia and protanopia. Red and green are never the only
 * pairing on screen.
 */
export const PRESENCE_COLORS = ["#3b82f6", "#f59e0b", "#a855f7", "#14b8a6"] as const;

export function colorFor(replica: ReplicaID): string {
  let h = 0;
  for (let i = 0; i < replica.length; i++) h = (h * 31 + replica.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}
