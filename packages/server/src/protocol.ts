/**
 * Wire envelope types for the relay's WebSocket protocol (see
 * docs/API_CONTRACT.md). The server never decodes `d` — it is opaque,
 * base64'd CRDT/awareness bytes that only the client-side @weave/core
 * understands. These types exist so the relay can route messages by shape,
 * not so it can inspect their contents.
 */

export interface ChaosConfig {
  /** Added delay per message, uniform in [0, latencyMs]. */
  latencyMs: number;
  /** Deliver out of order instead of preserving per-destination send order. */
  jitter: boolean;
  /** 0..1, probability a message is sent twice. */
  duplicateRate: number;
  /** 0..1, probability a message is silently dropped. */
  dropRate: number;
  /** Replica ids currently cut off from the room (both directions). */
  partitioned: string[];
}

export const DEFAULT_CHAOS: ChaosConfig = {
  latencyMs: 0,
  jitter: false,
  duplicateRate: 0,
  dropRate: 0,
  partitioned: [],
};

/** The outcome the chaos scheduler decided for one relayed message, on its
 * way to one destination. Reported back to the *sender* via `packet` (see
 * README "Protocol additions") since the sender has no other way to learn
 * it -- the server is the only thing that knows what chaos did. */
export type PacketFate = "delivered" | "dropped" | "duplicated";

/**
 * What the server knows about a peer without decoding awareness bytes.
 * `cursor` is always null here — cursor position lives inside the opaque
 * awareness payload, which only the client-side Awareness class parses.
 */
export interface PeerInfo {
  replica: string;
  name: string;
  color: string;
  cursor: null;
  updatedAt: number;
}

export type ClientMessage =
  | { t: "join"; room: string; replica: string; name: string; color: string }
  | { t: "sv"; d: string }
  | { t: "update"; d: string }
  | { t: "awareness"; d: string }
  // The contract types this as a full ChaosConfig; the relay accepts a
  // partial patch and merges it onto the room's current config, which is
  // friendlier for a demo control panel that toggles one knob at a time.
  | { t: "chaos"; cfg: Partial<ChaosConfig> }
  // Addition beyond the base contract, see README "Protocol additions".
  | { t: "resume"; seq: number };

export type ServerMessage =
  | { t: "welcome"; room: string; replica: string; peers: PeerInfo[] }
  | { t: "update"; d: string; from: string; seq: number }
  | { t: "sv"; d: string; from: string }
  | { t: "awareness"; d: string; from: string }
  | { t: "peers"; peers: PeerInfo[] }
  | { t: "chaos"; cfg: ChaosConfig }
  // Addition beyond the base contract, see README "Protocol additions". Sent
  // to the original sender of an update/awareness message, once per
  // destination peer, reporting what the chaos scheduler did with it. Never
  // sent for `sv` -- that kind isn't part of the packet-lane visualisation.
  | { t: "packet"; to: string; kind: "update" | "awareness"; status: PacketFate; bytes: number };

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Cheap sanity check that `d` is a base64 string, without ever inspecting
 * the CRDT structure it decodes to. */
export function isValidPayload(d: unknown): d is string {
  if (typeof d !== "string") return false;
  try {
    decodeBase64(d);
    return true;
  } catch {
    return false;
  }
}
