/**
 * Wire transport for the collaborative room, plus a zero-server loopback
 * that lets the whole app run with no `@weave/server` process.
 *
 * Protocol (see docs/API_CONTRACT.md and packages/server/README.md
 * "Protocol additions" for `resume`/`packet`, both server-only extensions):
 *
 *   c->s  { t: "join",      room, replica, name, color }
 *   s->c  { t: "welcome",   room, replica, peers: PeerState[] }
 *   c->s  { t: "sv",        d }            state vector, base64
 *   s->c  { t: "update",    d, from, seq } CRDT update, base64
 *   c->s  { t: "update",    d }
 *   c->s  { t: "awareness", d }
 *   s->c  { t: "awareness", d, from }
 *   s->c  { t: "peers",     peers }
 *   c->s  { t: "chaos",     cfg: ChaosConfig }
 *   s->c  { t: "chaos",     cfg }
 *   c->s  { t: "resume",    seq }          catch-up after reconnect/heal
 *   s->c  { t: "packet",    to, kind, status, bytes }  chaos fate of one send
 *
 * `LoopbackTransport` plays both roles at once inside the tab: every pane
 * that asks for the same room name is wired into an in-memory `LoopbackHub`,
 * which relays updates the same way a real server would, chaos config and
 * all. It keeps a shadow `Doc` (via the public core API only — it never
 * touches CRDT internals) purely so it can answer state-vector catch-up
 * requests the same way the real server is documented to.
 */
import { Doc } from "@weave/core";
import type { Algorithm, PeerState, ReplicaID, StateVector, Update } from "@weave/core";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Demo-only config; not part of the core CRDT contract. Shape from API_CONTRACT.md. */
export interface ChaosConfig {
  latencyMs: number;
  jitter: boolean;
  duplicateRate: number;
  dropRate: number;
  partitioned: ReplicaID[];
}

export const DEFAULT_CHAOS: ChaosConfig = {
  latencyMs: 0,
  jitter: false,
  duplicateRate: 0,
  dropRate: 0,
  partitioned: [],
};

export type ConnectionStatus = "connected" | "reconnecting" | "offline";

export interface PacketEvent {
  id: string;
  from: ReplicaID;
  to: ReplicaID | "*";
  kind: "update" | "awareness";
  /**
   * `queued` is the partitioned case: the send never left this replica, but
   * it is held rather than lost and will go out when the partition heals.
   * Showing it as `dropped` would tell the opposite of the story the CRDT is
   * actually telling.
   */
  status: "inflight" | "delivered" | "dropped" | "duplicated" | "queued";
  bytes: number;
  ts: number;
}

export interface TransportIdentity {
  room: string;
  replica: ReplicaID;
  name: string;
  color: string;
}

interface TransportEventMap {
  status: ConnectionStatus;
  welcome: PeerState[];
  peers: PeerState[];
  update: { update: Update; from: ReplicaID };
  awareness: { data: Uint8Array; from: ReplicaID };
  packet: PacketEvent;
}

type Listener<T> = (arg: T) => void;

class Emitter<M extends object> {
  private listeners = new Map<keyof M, Set<Listener<never>>>();

  on<K extends keyof M>(event: K, cb: Listener<M[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<never>);
    return () => {
      set?.delete(cb as Listener<never>);
    };
  }

  emit<K extends keyof M>(event: K, arg: M[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) (cb as Listener<M[K]>)(arg);
  }
}

export interface Transport {
  readonly replica: ReplicaID;
  readonly kind: "server" | "loopback";
  connect(): void;
  disconnect(): void;
  sendUpdate(update: Update): void;
  sendStateVector(sv: StateVector): void;
  sendAwareness(bytes: Uint8Array): void;
  setChaos(cfg: ChaosConfig): void;
  setPartitioned(partitioned: boolean): void;
  on<K extends keyof TransportEventMap>(event: K, cb: Listener<TransportEventMap[K]>): () => void;
}

// ---------------------------------------------------------------------------
// base64 helpers (binary payloads travel base64'd in `d`, per the contract)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// StateVector is a small plain object ({replica: counter}); the contract
// only documents binary encodings for Update, not StateVector, so the wire
// transport encodes it itself as base64'd JSON. This is a transport-layer
// choice, not a core API assumption.
function encodeStateVector(sv: StateVector): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sv));
}
function decodeStateVector(bytes: Uint8Array): StateVector {
  return JSON.parse(new TextDecoder().decode(bytes)) as StateVector;
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// WebSocketTransport — talks to @weave/server
// ---------------------------------------------------------------------------

/**
 * Sends made while there is no open socket (mid-reconnect, or the whole
 * time a replica is partitioned — `setPartitioned` closes the socket
 * outright to simulate a real cut cable) are queued rather than dropped,
 * and flushed in order once a connection reopens. That, plus `resume`
 * catching this replica up on whatever it missed (see server/README.md),
 * is what makes a partition heal actually converge instead of merely
 * reconnecting: recoverable-by-design isn't just a server-side promise.
 *
 * Packet-lane events are entirely server-sourced (the `packet` message):
 * this transport can observe *that* it sent something, but only the
 * server's `ChaosScheduler` knows what happened to it, so making up a
 * status here would just be lying earlier. See server/README.md
 * "Protocol additions".
 */
export class WebSocketTransport implements Transport {
  readonly kind = "server" as const;
  private emitter = new Emitter<TransportEventMap>();
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private svTimer: ReturnType<typeof setInterval> | undefined;
  private closedByUser = false;
  private partitioned = false;
  private chaos: ChaosConfig = { ...DEFAULT_CHAOS };
  private pending: unknown[] = [];
  /** Highest `seq` seen on an "update"; where `resume` picks up from after a reconnect. */
  private lastSeq = 0;

  constructor(
    private url: string,
    private identity: TransportIdentity,
    private getStateVector: () => StateVector,
  ) {}

  get replica(): ReplicaID {
    return this.identity.replica;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    if (this.partitioned) {
      this.emitter.emit("status", "offline");
      return;
    }
    this.emitter.emit("status", this.reconnectAttempt === 0 ? "reconnecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.send({
        t: "join",
        room: this.identity.room,
        replica: this.identity.replica,
        name: this.identity.name,
        color: this.identity.color,
      });
      this.send({ t: "chaos", cfg: this.chaos });
      // Catch up on whatever was relayed while this socket was down (a plain
      // drop, or the whole partition window), then flush anything this
      // replica tried to send during the same gap.
      this.send({ t: "resume", seq: this.lastSeq });
      this.flushPending();
      this.emitter.emit("status", "connected");
      this.startSvLoop();
    });
    ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.stopSvLoop();
      this.ws = null;
      if (!this.closedByUser && !this.partitioned) this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // "close" fires right after; reconnect is scheduled there.
    });
  }

  private scheduleReconnect(): void {
    this.emitter.emit("status", "reconnecting");
    const backoff = Math.min(5000, 300 * Math.pow(1.7, this.reconnectAttempt));
    const delay = backoff + Math.random() * 200;
    this.reconnectAttempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopSvLoop();
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  setPartitioned(partitioned: boolean): void {
    this.partitioned = partitioned;
    if (partitioned) {
      this.emitter.emit("status", "offline");
      this.stopSvLoop();
      clearTimeout(this.reconnectTimer);
      this.ws?.close();
      this.ws = null;
    } else {
      this.reconnectAttempt = 0;
      this.open();
    }
  }

  setChaos(cfg: ChaosConfig): void {
    this.chaos = cfg;
    this.send({ t: "chaos", cfg });
  }

  sendUpdate(update: Update): void {
    this.send({ t: "update", d: bytesToBase64(update) }, { kind: "update", bytes: update.length });
  }

  sendAwareness(bytes: Uint8Array): void {
    this.send({ t: "awareness", d: bytesToBase64(bytes) }, { kind: "awareness", bytes: bytes.length });
  }

  sendStateVector(sv: StateVector): void {
    this.send({ t: "sv", d: bytesToBase64(encodeStateVector(sv)) });
  }

  on<K extends keyof TransportEventMap>(event: K, cb: Listener<TransportEventMap[K]>): () => void {
    return this.emitter.on(event, cb);
  }

  private startSvLoop(): void {
    this.stopSvLoop();
    this.svTimer = setInterval(() => {
      this.sendStateVector(this.getStateVector());
    }, 2000);
  }

  private stopSvLoop(): void {
    clearInterval(this.svTimer);
    this.svTimer = undefined;
  }

  /** Queues rather than drops when there is no open socket — see the class
   * doc comment. `open()`'s "open" handler flushes the queue once a
   * connection (re)establishes.
   *
   * A queued send emits its own packet event. Otherwise a partitioned replica
   * goes completely silent in the visualisation, which reads as "nothing is
   * happening" when what is actually happening is the whole point: edits are
   * piling up locally and will merge on reconnect. The server cannot report
   * this one, because the message never reached it. */
  private send(obj: unknown, meta?: { kind: PacketEvent["kind"]; bytes: number }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return;
    }
    this.pending.push(obj);
    if (meta !== undefined) {
      this.emitter.emit("packet", {
        id: makeId(),
        from: this.identity.replica,
        to: "*",
        kind: meta.kind,
        status: "queued",
        bytes: meta.bytes,
        ts: Date.now(),
      });
    }
  }

  private flushPending(): void {
    const queued = this.pending;
    this.pending = [];
    for (const obj of queued) this.send(obj);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.emitter.emit("welcome", (msg.peers ?? []) as PeerState[]);
        break;
      case "peers":
        this.emitter.emit("peers", (msg.peers ?? []) as PeerState[]);
        break;
      case "update": {
        const update = base64ToBytes(msg.d as string);
        if (typeof msg.seq === "number") this.lastSeq = Math.max(this.lastSeq, msg.seq);
        this.emitter.emit("update", { update, from: msg.from as ReplicaID });
        break;
      }
      case "awareness":
        this.emitter.emit("awareness", {
          data: base64ToBytes(msg.d as string),
          from: msg.from as ReplicaID,
        });
        break;
      case "chaos":
        // Server-echoed config; the ChaosPanel is the local source of truth,
        // so there's nothing to reconcile here beyond acknowledging receipt.
        break;
      case "packet":
        // The fate of one send this replica made, reported by the server
        // because only it knows what its ChaosScheduler did (see
        // server/README.md "Protocol additions"). `from` is always this
        // replica: the server only ever tells a sender about its own sends.
        this.emitter.emit("packet", {
          id: makeId(),
          from: this.identity.replica,
          to: msg.to as ReplicaID,
          kind: msg.kind as PacketEvent["kind"],
          status: msg.status as PacketEvent["status"],
          bytes: msg.bytes as number,
          ts: Date.now(),
        });
        break;
      default:
        break;
    }
  }
}

export function probeServer(url: string, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.addEventListener("open", () => finish(true));
    ws.addEventListener("error", () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// LoopbackTransport — zero-server, in-tab relay
// ---------------------------------------------------------------------------

interface HubMember {
  replica: ReplicaID;
  name: string;
  color: string;
  partitioned: boolean;
  receiveUpdate: (u: Update, from: ReplicaID) => void;
  receiveAwareness: (bytes: Uint8Array, from: ReplicaID) => void;
  receivePeers: (peers: PeerState[]) => void;
}

/**
 * One in-memory "room" that every LoopbackTransport for the same room name
 * shares. Stands in for `@weave/server`: relays updates between
 * members, applies ChaosConfig to its outbound relay exactly as documented,
 * and answers state-vector catch-up requests via a shadow Doc built purely
 * from the public core API (applyUpdate / opsSince) — never CRDT internals.
 */
class LoopbackHub {
  private members = new Map<ReplicaID, HubMember>();
  private shadow: InstanceType<typeof Doc>;
  private chaos: ChaosConfig = { ...DEFAULT_CHAOS };
  private edgeClock = new Map<string, number>();
  private packetListeners = new Map<ReplicaID, Set<(p: PacketEvent) => void>>();

  constructor(
    private room: string,
    algorithm: Algorithm,
  ) {
    void algorithm;
    this.shadow = new Doc({ replica: `relay-${room}` });
  }

  join(member: HubMember): void {
    this.members.set(member.replica, member);
    this.broadcastPeers();
  }

  leave(replica: ReplicaID): void {
    this.members.delete(replica);
    this.packetListeners.delete(replica);
    this.broadcastPeers();
  }

  setPartitioned(replica: ReplicaID, partitioned: boolean): void {
    const member = this.members.get(replica);
    if (member) member.partitioned = partitioned;
  }

  setChaos(cfg: ChaosConfig): void {
    this.chaos = cfg;
  }

  peerStates(): PeerState[] {
    return Array.from(this.members.values()).map((m) => ({
      replica: m.replica,
      name: m.name,
      color: m.color,
      cursor: null,
      updatedAt: Date.now(),
    }));
  }

  broadcastPeers(): void {
    const peers = this.peerStates();
    for (const m of this.members.values()) m.receivePeers(peers);
  }

  onPacketFrom(replica: ReplicaID, cb: (p: PacketEvent) => void): () => void {
    let set = this.packetListeners.get(replica);
    if (!set) {
      set = new Set();
      this.packetListeners.set(replica, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  ingestUpdate(from: ReplicaID, update: Update): void {
    this.shadow.applyUpdate(update);
    for (const [replica, member] of this.members) {
      if (replica === from) continue;
      this.relay(from, replica, "update", update, member);
    }
  }

  ingestAwareness(from: ReplicaID, bytes: Uint8Array): void {
    for (const [replica, member] of this.members) {
      if (replica === from) continue;
      this.relay(from, replica, "awareness", bytes, member);
    }
  }

  ingestStateVector(from: ReplicaID, sv: StateVector): void {
    const member = this.members.get(from);
    if (!member) return;
    const missing = this.shadow.opsSince(sv);
    if (missing && missing.byteLength > 0) {
      // Catch-up is the recovery path itself — deliver reliably, no chaos.
      member.receiveUpdate(missing, `relay-${this.room}`);
    }
  }

  private relay(from: ReplicaID, to: ReplicaID, kind: "update" | "awareness", payload: Uint8Array, member: HubMember): void {
    const sender = this.members.get(from);
    if (sender?.partitioned || member.partitioned) return;
    const cfg = this.chaos;

    const attempt = (duplicateTag: boolean) => {
      const dropped = cfg.dropRate > 0 && Math.random() < cfg.dropRate;
      const rawDelay = cfg.latencyMs > 0 ? Math.random() * cfg.latencyMs : 0;
      const edgeKey = `${from}>${to}:${kind}`;
      let deliverAt = performance.now() + rawDelay;
      if (!cfg.jitter) {
        const last = this.edgeClock.get(edgeKey) ?? 0;
        deliverAt = Math.max(deliverAt, last + 1);
      }
      this.edgeClock.set(edgeKey, deliverAt);

      this.emitPacket({
        id: makeId(),
        from,
        to,
        kind,
        status: dropped ? "dropped" : duplicateTag ? "duplicated" : "inflight",
        bytes: payload.byteLength,
        ts: Date.now(),
      });
      if (dropped) return;

      const wait = Math.max(0, deliverAt - performance.now());
      setTimeout(() => {
        if (kind === "update") member.receiveUpdate(payload, from);
        else member.receiveAwareness(payload, from);
      }, wait);
    };

    attempt(false);
    if (cfg.duplicateRate > 0 && Math.random() < cfg.duplicateRate) {
      setTimeout(() => attempt(true), 5 + Math.random() * 40);
    }
  }

  private emitPacket(p: PacketEvent): void {
    const set = this.packetListeners.get(p.from);
    if (!set) return;
    for (const cb of Array.from(set)) cb(p);
  }
}

const hubs = new Map<string, LoopbackHub>();

function getHub(room: string, algorithm: Algorithm): LoopbackHub {
  const key = `${room}::${algorithm}`;
  let hub = hubs.get(key);
  if (!hub) {
    hub = new LoopbackHub(room, algorithm);
    hubs.set(key, hub);
  }
  return hub;
}

export class LoopbackTransport implements Transport {
  readonly kind = "loopback" as const;
  private emitter = new Emitter<TransportEventMap>();
  private hub: LoopbackHub;
  private svTimer: ReturnType<typeof setInterval> | undefined;
  private partitioned = false;
  private unsubPackets: (() => void) | undefined;
  private connected = false;

  constructor(
    private identity: TransportIdentity,
    algorithm: Algorithm,
    private getStateVector: () => StateVector,
  ) {
    this.hub = getHub(identity.room, algorithm);
  }

  get replica(): ReplicaID {
    return this.identity.replica;
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.hub.join({
      replica: this.identity.replica,
      name: this.identity.name,
      color: this.identity.color,
      partitioned: this.partitioned,
      receiveUpdate: (u, from) => this.emitter.emit("update", { update: u, from }),
      receiveAwareness: (b, from) => this.emitter.emit("awareness", { data: b, from }),
      receivePeers: (peers) => this.emitter.emit("peers", peers),
    });
    this.unsubPackets = this.hub.onPacketFrom(this.identity.replica, (p) => this.emitter.emit("packet", p));
    this.emitter.emit("welcome", this.hub.peerStates());
    this.emitter.emit("status", this.partitioned ? "offline" : "connected");
    this.svTimer = setInterval(() => {
      this.hub.ingestStateVector(this.identity.replica, this.getStateVector());
    }, 2000);
  }

  disconnect(): void {
    this.connected = false;
    clearInterval(this.svTimer);
    this.svTimer = undefined;
    this.unsubPackets?.();
    this.hub.leave(this.identity.replica);
  }

  sendUpdate(update: Update): void {
    this.hub.ingestUpdate(this.identity.replica, update);
  }

  sendAwareness(bytes: Uint8Array): void {
    this.hub.ingestAwareness(this.identity.replica, bytes);
  }

  sendStateVector(sv: StateVector): void {
    this.hub.ingestStateVector(this.identity.replica, sv);
  }

  setChaos(cfg: ChaosConfig): void {
    this.hub.setChaos(cfg);
  }

  setPartitioned(partitioned: boolean): void {
    this.partitioned = partitioned;
    this.hub.setPartitioned(this.identity.replica, partitioned);
    this.emitter.emit("status", partitioned ? "offline" : "connected");
  }

  on<K extends keyof TransportEventMap>(event: K, cb: Listener<TransportEventMap[K]>): () => void {
    return this.emitter.on(event, cb);
  }
}

export function createTransport(
  mode: "server" | "loopback",
  serverUrl: string,
  identity: TransportIdentity,
  algorithm: Algorithm,
  getStateVector: () => StateVector,
): Transport {
  return mode === "server"
    ? new WebSocketTransport(serverUrl, identity, getStateVector)
    : new LoopbackTransport(identity, algorithm, getStateVector);
}
