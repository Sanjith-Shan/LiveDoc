# @weave/editor

The visible half of Weave: a real multiplayer text editor, a network
chaos fuzzer with a live packet visualisation, and a CRDT anomaly lab that
proves Fugue avoids the interleaving bugs RGA and Logoot don't.

Built against the documented `@weave/core` API in
[`docs/API_CONTRACT.md`](../../docs/API_CONTRACT.md) — it contains no CRDT
logic of its own.

## Running it

```bash
npm install                    # from the monorepo root
npm run dev -w @weave/editor
```

Then open the printed local URL. **No server required** — on load the app
probes `ws://localhost:8787` (or `?server=` if you pass one) for about a
second; if nothing answers it falls back automatically to an in-browser
loopback transport and shows a banner saying so. Every tab, including the
chaos fuzzer, works identically either way.

Useful query params:

- `?server=ws://host:port` — point at a running `@weave/server`.
- `?room=my-room` — join a specific room name (default `weave-demo`).

Scripts:

```bash
npm run dev        # vite dev server
npm run build      # production build
npm run preview    # preview the production build
npm run typecheck  # tsc --noEmit
```

## Screenshots

Every image below is captured from this app by `scripts/capture.mjs`, driven
through the real UI against a real relay. Nothing is mocked up.

| Tab | Screenshot |
| --- | --- |
| Collaborate — live cursors, presence bar | [`collaborate.png`](../../assets/collaborate.png) |
| Chaos — mid-partition, packets queued, badge reading diverged | [`chaos.png`](../../assets/chaos.png) |
| Anomaly Lab — forward interleaving, all three algorithms | [`anomaly-forward.png`](../../assets/anomaly-forward.png) |
| Anomaly Lab — backward interleaving, where RGA and Logoot break | [`anomaly-lab.png`](../../assets/anomaly-lab.png) |
| The whole arc — two replicas, a partition, and the heal | [`demo.gif`](../../assets/demo.gif) |

## Caret preservation, the fiddly part

Every pane's `<textarea>` is a controlled component whose `value` always
equals `doc.toString()`. On `input`, the new DOM value is diffed against the
previous `doc.toString()` (`lib/diff.ts::diffRange` — smallest common
prefix/suffix) to produce one minimal `delete` + `insert` pair, which is
what actually gets applied to the `Doc`. The document is never rebuilt from
scratch on a keystroke, and because the diff is minimal, the browser's own
caret handling for local typing just works — React reconciles the same
string it already rendered, so it never touches the DOM selection.

The harder direction is a **remote** update landing while you have a
selection or caret sitting in the middle of the text: nothing about the
`<textarea>` API lets an index survive an edit on its own, so every
`Doc` `"change"` event that isn't local walks the current
`selectionStart`/`selectionEnd` through that event's `TextDelta[]`
(`lib/diff.ts::mapIndexThroughDeltas` — insert-before-caret shifts it right,
delete-before-caret shifts it left, same idea as OT position transforms)
and reapplies `setSelectionRange` with the mapped indices on the next
animation frame (has to be next-frame, because React hasn't repainted the
new value yet when the "change" event itself fires). Remote *cursor*
rendering (the colored bars/flags in `Cursors.tsx`) sidesteps this problem
entirely by relying on `Awareness`'s sticky anchors — `cursorIndices()` is
re-resolved against the live document on every render, so peer carets
"just move" as text shifts under them without any index bookkeeping here.

## How the editor uses `@weave/core`

The editor holds no CRDT logic. Everything below is the whole of its
dependency on the engine, and each point is exercised by the app on every
run.

- `new Doc({ replica, algorithm })` — both fields optional, `algorithm`
  defaults to `"fugue"`. `Doc` exposes a readonly `.replica`.
- `doc.on("update" | "change", cb)` returns an **unsubscribe function**
  directly; there is no separate `.off()`.
- `doc.opsSince(sv)` returns an `Update` (`Uint8Array`) that may be empty —
  the loopback relay checks `.byteLength > 0` before treating it as "this
  peer is missing something".
- `awareness.cursorIndices(replica)` returns `{ anchor, head } | null` in the
  *current* document's index space, already resolved from the sticky
  anchors. The editor never touches `Anchor` objects directly, which is why
  remote carets drift correctly as text shifts under them with no index
  bookkeeping in this package.
- `doc.stats()` and `doc.treeJSON()` are called on every `"change"` event in
  the Anomaly Lab and the tree view. That is fine at demo document sizes and
  would not be at real ones — it is a debugging surface, not a hot path.

Two things deliberately live here rather than in core:

- **`ChaosConfig` is not part of `@weave/core`.** Simulated packet loss is
  demo scaffolding, so it is defined locally in `src/net/transport.ts`,
  matching the shape documented in
  [`API_CONTRACT.md`](../../docs/API_CONTRACT.md).
- **Serialising a `StateVector` for the wire is a transport decision.** A
  `StateVector` is a plain `{ replica: number }` object and core takes no
  position on its byte encoding; this transport sends base64'd UTF-8 JSON in
  the protocol's `sv` message, which is what `@weave/server` expects.

The Anomaly Lab's per-character replica attribution avoids depending on any
particular node `id` format or sibling traversal order. It derives
attribution purely from the `TextDelta`s emitted while applying one
replica's update onto another's `Doc` — documented behaviour, not
internals — so it stays correct even if the tree representation changes
underneath it.

## Architecture notes

- `src/net/transport.ts` — `WebSocketTransport` (real protocol, reconnect
  with jittered exponential backoff, a 2s state-vector heartbeat) and
  `LoopbackTransport` + `LoopbackHub` (an in-tab stand-in for
  `@weave/server`: relays updates between every pane that joins the
  same room, applies `ChaosConfig` to its *outbound* relay exactly as
  documented, and answers state-vector catch-up requests via a shadow `Doc`
  built only from public `applyUpdate`/`opsSince` calls — never CRDT
  internals). Both implement the same `Transport` interface so the rest of
  the app never needs to know which one it's talking to.
- `src/hooks/useDoc.ts` — one `Doc` + `Awareness` + `Transport` per pane.
  Panes are never unmounted when "removed" (`active: false` just
  disconnects the transport) so re-adding one resumes cleanly via the sv
  catch-up path instead of starting over.
- Partition state (`ChaosConfig.partitioned`) is the single source of truth
  for "cut the cable" — both the per-pane button in the Collaborate tab and
  the toggle in the Chaos tab write to the same list, so they can't disagree.
- `App.tsx` calls `useDoc` a fixed 4 times every render (never inside a
  loop/`map`) so the pane count (2–4) can change without violating the
  rules of hooks.
