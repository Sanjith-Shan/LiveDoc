# @weave/server

A WebSocket relay for the Weave CRDT. It is a **dumb relay**: it does
not import `@weave/core`, does not parse CRDT updates, and does not
know what Fugue, tombstones, or marks are. It forwards opaque bytes between
the peers in a room. That the server needs zero CRDT knowledge to keep
everyone in sync is not a limitation -- it's the point of using a CRDT.

## Run it

```bash
npm install
npm run dev      # tsx watch src/index.ts, restarts on change
npm start        # tsx src/index.ts
npm test         # vitest run
npm run typecheck
```

`PORT` env var controls the listen port (default `8787`). On start it logs
`ws://localhost:<port>`.

## Protocol

JSON envelope, binary payloads base64'd in `d`. One room per document.

| Direction | Message |
|---|---|
| c->s | `{ t: "join", room, replica, name, color }` |
| s->c | `{ t: "welcome", room, replica, peers: PeerInfo[] }` |
| c->s | `{ t: "sv", d }` -- state vector, base64 |
| s->c | `{ t: "sv", d, from }` |
| c->s | `{ t: "update", d }` |
| s->c | `{ t: "update", d, from, seq }` |
| c->s | `{ t: "awareness", d }` |
| s->c | `{ t: "awareness", d, from }` |
| s->c | `{ t: "peers", peers }` |
| c->s | `{ t: "chaos", cfg: Partial<ChaosConfig> }` |
| s->c | `{ t: "chaos", cfg: ChaosConfig }` |
| c->s | `{ t: "resume", seq }` |
| s->c | `{ t: "packet", to, kind, status, bytes }` |

`peers` entries are `PeerInfo { replica, name, color, cursor: null, updatedAt }`.
`cursor` is always `null`: cursor position lives inside the opaque awareness
payload, which only the client-side `Awareness` class decodes.

## Chaos mode

Chaos is demo/testing scaffolding for exercising the CRDT's convergence
under a bad network, without needing an actual bad network. It wraps the
room's outbound relay:

```ts
interface ChaosConfig {
  latencyMs: number;       // added delay, uniform 0..latencyMs
  jitter: boolean;         // deliver out of order
  duplicateRate: number;   // 0..1, probability a message is sent twice
  dropRate: number;        // 0..1, dropped messages are retried on next sv exchange
  partitioned: string[];   // replica ids currently cut off from the room
}
```

It is per-room and toggleable at runtime via the `chaos` message: any
client can send `{ t: "chaos", cfg }` and the server merges it onto the
room's current config, then broadcasts the effective config to the room.
Messages are queued with an independent random delay in `[0, latencyMs]`;
without `jitter` that delay is clamped to preserve per-destination send
order (a link with variable but monotonic latency), and with `jitter` the
clamp is removed so a later message can genuinely land first. `dropRate`
silently discards; `duplicateRate` re-sends the identical bytes a second
time; `partitioned` blocks a replica's traffic in both directions --
nothing relayed to it, nothing it sends is relayed either.

Chaos never has to be lossless on its own: **updates are recoverable by
design**. See the addition below.

## Protocol additions

Beyond the base contract in `docs/API_CONTRACT.md`, this server adds a
ring-buffer resume path:

```
c->s  { t: "resume", seq }
s->c  { t: "update",   d, from, seq }   // seq is new on every "update"
```

Each room keeps a ring buffer of the last 1024 (`RING_SIZE` in `room.ts`)
relayed `update` payloads, keyed by an incrementing per-room sequence
number. Every `update` the server relays now carries that `seq`. A client
tracks the highest `seq` it has seen; after a reconnect or a partition heal
it sends `{ t: "resume", seq }` and the server replays every buffered
update after that seq, bypassing chaos (resume is the recovery path, not
one more place for simulated loss to hide).

This is deliberately the same story as the state-vector exchange described
in the contract ("clients periodically exchange state vectors ... the
server answers with whatever the peer is missing"): the server relays `sv`
to the rest of the room exactly like `update`/`awareness` (broadcast,
`from` attached, no parsing), so any peer that understands the CRDT can
notice the gap and answer with the missing update over the normal relay
path. `resume`/`seq` is a second, server-side safety net for exactly-once
catch-up that doesn't depend on another peer being online to respond.

Beyond that, a second addition supports the demo's packet-lane visualisation:

```
s->c  { t: "packet", to, kind, status, bytes }
```

`update`/`awareness` are the only relayed message kinds a client can watch
fly across the network -- a chaos-affected send has one of three fates
(`delivered`, `dropped`, `duplicated`), and only the server, which owns the
`ChaosScheduler`, knows which one. So every time the server relays an
`update` or `awareness` message toward one destination peer, it also tells
the *original sender* what happened to that copy: `to` is the destination
replica, `kind` is `"update"` or `"awareness"`, `status` is the fate, and
`bytes` is the decoded payload size (measured, never parsed). A partitioned
destination is reported as `"dropped"` -- from the sender's side, a cut
cable and a 100%-drop link are indistinguishable, and the visualisation has
no separate concept for either. `sv` never gets a `packet` notification; it
isn't part of the packet-lane visualisation. Like `resume`'s replay, this is
sent directly (`sendTo`, chaos-free) -- it is a report *about* chaos, not
one more message chaos could itself corrupt.

## Design decisions worth flagging

- **`chaos` cfg is accepted as a partial patch**, not the full `ChaosConfig`
  the contract's client message technically types. The server merges it
  onto the room's current config and always broadcasts the full effective
  config back. This makes a demo control panel (toggle one knob, leave the
  rest) trivial without extra client-side bookkeeping.
- **A partitioned replica is cut off for `update`/`sv`/`awareness` only.**
  `join` and `chaos` control messages still reach the server from a
  partitioned client (there is no real network to sever in this demo --
  chaos toggling has to keep working so a test/host can heal the
  partition). Only relayed CRDT/awareness/presence traffic is blocked in
  both directions.
- **Reconnecting under the same `replica` id replaces the old socket entry**
  in the room rather than being rejected; the stale connection is left to
  error out or time out via the heartbeat.
- Every socket is pinged every 30s; one that doesn't pong before the next
  tick is terminated, so a room can't hold a half-dead peer forever.
