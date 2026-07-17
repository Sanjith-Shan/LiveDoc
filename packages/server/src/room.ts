import type { WebSocket } from "ws";
import { ChaosScheduler } from "./chaos.js";
import {
  decodeBase64,
  isValidPayload,
  type ChaosConfig,
  type ClientMessage,
  type PacketFate,
  type PeerInfo,
  type ServerMessage,
} from "./protocol.js";

/** How many relayed updates each room remembers for late/reconnecting peers. */
const RING_SIZE = 1024;

interface RingEntry {
  seq: number;
  from: string;
  d: string;
}

interface Peer {
  ws: WebSocket;
  replica: string;
  name: string;
  color: string;
  joinedAt: number;
}

/**
 * One CRDT document's worth of connected peers. This is the whole relay: it
 * never parses `d`. The only CRDT-shaped thing it tracks is the ring
 * buffer, and even that stores opaque base64 blobs keyed by an incrementing
 * seq -- it never looks inside them.
 */
export class Room {
  readonly name: string;
  private readonly peers = new Map<string, Peer>();
  private readonly chaos = new ChaosScheduler();
  private readonly ring: RingEntry[] = [];
  private nextSeq = 1;

  constructor(name: string) {
    this.name = name;
  }

  get isEmpty(): boolean {
    return this.peers.size === 0;
  }

  join(ws: WebSocket, replica: string, name: string, color: string): void {
    // A reconnect under the same replica id just replaces the stale socket
    // entry; the old one will error/close on its own and hit leave().
    this.peers.set(replica, { ws, replica, name, color, joinedAt: Date.now() });

    this.sendTo(replica, {
      t: "welcome",
      room: this.name,
      replica,
      peers: this.peerInfos(),
    });
    this.broadcastPeerList();
  }

  leave(replica: string): void {
    if (!this.peers.delete(replica)) return;
    this.broadcastPeerList();
  }

  dispose(): void {
    this.chaos.dispose();
  }

  handleMessage(replica: string, msg: ClientMessage): void {
    if (!this.peers.has(replica)) return; // sent before/without a successful join

    switch (msg.t) {
      case "update":
        return this.relayUpdate(replica, msg.d);
      case "sv":
        return this.relayOpaque(replica, "sv", msg.d);
      case "awareness":
        return this.relayOpaque(replica, "awareness", msg.d);
      case "chaos":
        return this.setChaos(msg.cfg);
      case "resume":
        return this.resume(replica, msg.seq);
      default:
        return; // unknown / join-while-joined; ignore rather than crash
    }
  }

  private relayUpdate(from: string, d: string): void {
    if (!isValidPayload(d)) return;
    if (this.chaos.config.partitioned.includes(from)) return; // sender is network-cut

    const seq = this.nextSeq++;
    this.ring.push({ seq, from, d });
    if (this.ring.length > RING_SIZE) this.ring.shift();

    this.broadcast(from, { t: "update", d, from, seq }, { kind: "update", bytes: decodeBase64(d).length });
  }

  /** `sv` and `awareness` relay identically to each other: broadcast as-is
   * with the sender attached, no buffering. `sv` reaching other peers is
   * what lets *them* notice a gap and answer with the update that fills
   * it -- the same relay path a partition heal uses to catch a peer up. */
  private relayOpaque(from: string, t: "sv" | "awareness", d: string): void {
    if (!isValidPayload(d)) return;
    if (this.chaos.config.partitioned.includes(from)) return;
    // `sv` isn't part of the packet-lane visualisation -- only update/awareness are.
    const packetMeta = t === "awareness" ? { kind: "awareness" as const, bytes: decodeBase64(d).length } : undefined;
    this.broadcast(from, { t, d, from }, packetMeta);
  }

  /** Replays ring-buffered updates newer than `sinceSeq`, bypassing chaos:
   * resume is the recovery path chaos is supposed to be recoverable
   * *through*, not one more place for simulated loss to hide. */
  private resume(replica: string, sinceSeq: number): void {
    for (const entry of this.ring) {
      if (entry.seq > sinceSeq) {
        this.sendTo(replica, { t: "update", d: entry.d, from: entry.from, seq: entry.seq });
      }
    }
  }

  private setChaos(cfg: Partial<ChaosConfig>): void {
    this.chaos.configure(cfg);
    this.broadcast(null, { t: "chaos", cfg: this.chaos.config });
  }

  private broadcastPeerList(): void {
    this.broadcast(null, { t: "peers", peers: this.peerInfos() });
  }

  private peerInfos(): PeerInfo[] {
    return [...this.peers.values()].map((p) => ({
      replica: p.replica,
      name: p.name,
      color: p.color,
      cursor: null,
      updatedAt: p.joinedAt,
    }));
  }

  /** Sends to every peer except `exclude` (if given), through the chaos
   * scheduler so latency/jitter/drop/duplicate/partition all apply. When
   * `packetMeta` is given (update/awareness relays only), the fate the
   * scheduler decides for each destination is reported back to `exclude`
   * (the original sender) as a `packet` message -- the client-side
   * packet-lane visualisation has no other way to learn a fate only the
   * chaos scheduler decides. */
  private broadcast(
    exclude: string | null,
    msg: ServerMessage,
    packetMeta?: { kind: "update" | "awareness"; bytes: number },
  ): void {
    const data = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.replica === exclude) continue;
      const onFate: ((status: PacketFate) => void) | undefined =
        packetMeta && exclude
          ? (status) =>
              this.sendTo(exclude, { t: "packet", to: peer.replica, kind: packetMeta.kind, status, bytes: packetMeta.bytes })
          : undefined;
      this.chaos.send(peer.ws, peer.replica, data, onFate);
    }
  }

  /** Direct, chaos-free send to one peer (welcome + resume replay only). */
  private sendTo(replica: string, msg: ServerMessage): void {
    const peer = this.peers.get(replica);
    if (!peer || peer.ws.readyState !== peer.ws.OPEN) return;
    try {
      peer.ws.send(JSON.stringify(msg));
    } catch {
      // Socket died mid-send; the connection's close handler reaps the peer.
    }
  }
}
