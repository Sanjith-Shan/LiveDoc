import type { WebSocket } from "ws";
import { DEFAULT_CHAOS, type ChaosConfig, type PacketFate } from "./protocol.js";

/**
 * Applies simulated network conditions to a room's outbound relay traffic.
 * One instance per room; `configure` can be called at any time (the `chaos`
 * control message) and takes effect on the next send.
 *
 * Ordering model: every send is scheduled with an independent random delay
 * drawn from [0, latencyMs]. With `jitter` off, that alone would still
 * occasionally reorder messages sent in the same tick, so each destination's
 * delivery time is additionally clamped to be >= the previous one scheduled
 * for it -- simulating a link with variable-but-monotonic latency. Turning
 * `jitter` on removes that clamp, so independently-drawn delays can and do
 * let a later message land first.
 */
export class ChaosScheduler {
  private cfg: ChaosConfig = { ...DEFAULT_CHAOS };
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly lastDeliveryAt = new Map<string, number>();

  configure(patch: Partial<ChaosConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  get config(): ChaosConfig {
    return this.cfg;
  }

  /** Sends `data` to `ws`, subject to partition/drop/latency/duplicate rules
   * for the `toReplica` destination. `onFate`, when given, is told what
   * happened synchronously (before this call returns) -- every decision
   * here is made up front, only the actual delivery is delayed by latency.
   * A partitioned destination is reported as "dropped": from the sender's
   * point of view a cut cable and a 100%-drop link look identical, and the
   * packet-lane visualisation has no separate concept for either. */
  send(ws: WebSocket, toReplica: string, data: string, onFate?: (status: PacketFate) => void): void {
    if (this.cfg.partitioned.includes(toReplica)) {
      onFate?.("dropped");
      return;
    }
    if (this.cfg.dropRate > 0 && Math.random() < this.cfg.dropRate) {
      onFate?.("dropped");
      return;
    }

    this.enqueue(ws, toReplica, data);
    onFate?.("delivered");
    if (this.cfg.duplicateRate > 0 && Math.random() < this.cfg.duplicateRate) {
      this.enqueue(ws, toReplica, data);
      onFate?.("duplicated");
    }
  }

  private enqueue(ws: WebSocket, toReplica: string, data: string): void {
    const now = Date.now();
    const draw = this.cfg.latencyMs > 0 ? Math.random() * this.cfg.latencyMs : 0;
    let deliverAt = now + draw;

    if (!this.cfg.jitter) {
      const floor = (this.lastDeliveryAt.get(toReplica) ?? 0) + 1;
      deliverAt = Math.max(deliverAt, floor);
    }
    this.lastDeliveryAt.set(toReplica, deliverAt);

    const delay = Math.max(0, deliverAt - now);
    if (delay === 0) {
      this.deliver(ws, data);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.deliver(ws, data);
    }, delay);
    this.timers.add(timer);
  }

  private deliver(ws: WebSocket, data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(data);
    } catch {
      // Socket died mid-send; the connection's close handler reaps the peer.
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
