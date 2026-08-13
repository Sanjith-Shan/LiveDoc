# @weave/bench

Benchmark harness comparing `@weave/core` against [Yjs](https://github.com/yjs/yjs)
and [Automerge](https://github.com/automerge/automerge) on the same machine, same
process, same seeded workloads. This is what produces the comparison table in the
top-level README.

## Running

```sh
npm run bench -w @weave/bench          # full sizes
npm run bench:quick -w @weave/bench    # tiny sizes, fast smoke run
npm run typecheck -w @weave/bench

# from inside packages/bench:
tsx src/run.ts                  # same as `npm run bench`
tsx src/run.ts --quick
tsx src/run.ts --seed 7
tsx src/run.ts --only wire-size # run a single suite by id
```

Output: markdown tables print to stdout, a full JSON dump goes to
`results/<timestamp>.json`, and the same markdown is written to
`results/latest.md`.

`run.ts` re-execs itself with `node --expose-gc` automatically if `global.gc`
isn't already available — the memory suites need a real (not no-op) GC to
produce meaningful before/after heap deltas.

`@weave/core` must be built before the harness will run — `npm run build`
at the repo root does it. `run.ts` imports core as the very first thing it
does and, on failure, prints a clear message and exits 1 rather than
silently benchmarking Yjs and Automerge alone and reporting it as a
comparison.

## What each suite measures

All suites live in `src/suites/`, one file each, and all read a shared
`SuiteContext { subjects, quick, seed }` and return a `SuiteOutcome` with
ready-to-print markdown plus structured `data` for the JSON dump.

1. **local-edit-throughput** — ops/sec and ns/op for sequential appends
   (`traces.sequentialTyping`) at doc sizes 1e3/1e4/1e5/2e5 chars. The best
   case for any sequence CRDT: no rebalancing, no concurrent tie-breaking.
2. **random-position-insert** — same sizes, `traces.randomInsert` (uniform
   random position every time). The adversarial case for tree-shaped CRDTs;
   also records Weave's `doc.stats().maxDepth` at each size, since
   that's the structural number this workload stresses.
3. **merge-latency** — replica A has N ops, replica B has M ops (built
   independently, never having seen each other), timed `applyUpdate` of B's
   full batch into A. Two required curves (latency vs N with M fixed;
   latency vs M with N fixed) plus a bonus third curve using
   `traces.concurrentRuns` — R replicas typing distinct words at the same
   position, merged pairwise, latency vs R.
4. **memory** — bytes retained per operation, two ways: `process.memoryUsage().heapUsed`
   delta (forced GC + 3 warm iterations) and, for Weave only,
   `doc.stats().bytes`. See "Why heapUsed and stats().bytes differ" below.
5. **tombstone-gc** — Weave only. Build a doc, delete the first half,
   measure heap before/after `doc.gc([doc.stateVector()])`, report the char
   reclamation rate. Yjs and Automerge rows read "not run" — neither
   exposes a comparable explicit tombstone-collection API (see below).
6. **cold-start** — a fresh, empty replica applies one catch-up update
   covering N missed ops (N = 1e3/1e4/1e5): time to apply it, and its byte
   size. This is the same code path as a partition heal per
   `docs/API_CONTRACT.md` — reconnect exchanges state vectors and the
   answer is exactly this kind of "everything since the beginning" update.
7. **wire-size** — bytes per operation on the wire for a ~10k-op realistic
   typing session (`traces.realisticEditing` — the generator meant to look
   most like a human, so this is the headline "what actually crosses the
   network" number). Measured as `changesSince(previous-state-vector)`
   after every single mutation, mirroring a client that sends one update
   per local edit.
8. **degradation-point** — grows each doc geometrically, sampling insert
   latency at every checkpoint size, and reports the size at which mean
   insert latency first exceeds 1ms (or "not reached" if the sweep cap is
   hit first). Direct answer to "where does this stop being fast enough".

## Honesty caveats

Printed verbatim after every run's tables:

- Losing to Yjs is expected — it is years of specialist optimisation.
- These are single-process Node benchmarks on one machine, not a distributed measurement.
- Any suite that did not complete is listed as "not run" rather than omitted.

Beyond that block:

**Ratio direction.** Every ratio column is `Weave / Yjs`. A number
above 1.0 always means Weave is worse (slower, bigger, hungrier) at
that metric — this holds whether the underlying metric is "bigger is
better" (ops/sec, where we invert to ns/op before dividing) or "smaller is
better" (latency, bytes). Never read a ratio as "Yjs / Weave".

**Why `heapUsed` and `doc.stats().bytes` differ (suite 4).**
`process.memoryUsage().heapUsed` is what the V8 heap actually grew by: it
includes object headers, hidden-class overhead, string representation
overhead, array backing-store slack, and whatever the allocator didn't
manage to compact away even after a forced GC. `doc.stats().bytes` is
Weave's own accounting of just its structural payload — tree node
arrays and character buffers — which is a lower, more theoretical number
by design. Expect `heapUsed` to be a small constant multiple of
`stats().bytes`, not equal to it; if it's off by orders of magnitude
instead, that's a real signal, not measurement noise.

**Automerge's real memory footprint is understated here.** `@automerge/automerge`
(v2+) runs its CRDT core as a Rust/WebAssembly module (`automerge-wasm`).
Its actual document state — the op log, the materialized value tree —
mostly lives in WASM linear memory, not on the V8 JS heap.
`process.memoryUsage().heapUsed` cannot see WASM linear memory at all, so
suite 4's Automerge numbers measure only the small JS-side wrapper
allocations, not Automerge's true footprint. Treat Automerge's memory
numbers in this report as a lower bound, not a fair comparison to
Weave's or Yjs's (both of which keep their entire state on the JS
heap, so `heapUsed` sees all of it).

**Tombstone GC has no Yjs/Automerge equivalent (suite 5).** Yjs runs
internal garbage collection automatically as part of integrating updates
(`Y.Doc({ gc: true })`, the default) — there is no explicit call to make or
time separately, and no way to force it independent of that mechanism.
Automerge never dereferences old ops at all; its `save()`-time compaction
is about compact *encoding* of history, not application-visible
reclamation of a specific range you just deleted, and there's no comparable
"reclaim what's now causally stable" call. Rather than inventing a fake
equivalent for either library, both rows in suite 5's table read "not run —
no comparable explicit tombstone-GC API".

**Suite 5's stability frontier.** `doc.gc(peerStateVectors)` "only collects
causally stable ops" per the API contract — normally you'd pass the state
vectors of every peer that might still be behind. This is a single-replica
benchmark with no other peers, so the doc's own current state vector is the
correct (and only) frontier: `doc.gc([doc.stateVector()])`.

## Workload generators (`src/traces.ts`)

All four take a seeded `mulberry32` PRNG so a run with a given `--seed` is
bit-for-bit reproducible across machines and across libraries:

- `sequentialTyping(n)` — append one char at a time.
- `randomInsert(n)` — insert one char at a uniformly random position each time.
- `realisticEditing(n)` — 85% insert at-or-near the cursor with small
  gaussian jitter, 10% delete near the cursor, 5% cursor jump (no
  mutation, just relocates where subsequent edits land). The closest of the
  four to how a human actually types; used as the headline number in
  suite 7.
- `concurrentRuns(replicas, runLength)` — `replicas` independent op
  sequences, each typing a distinct word at position 0, none aware of the
  others. Used by suite 3's bonus third curve.

## Adapter assumptions (`src/subjects.ts`) — double-check these against the real core

`subjects.ts` is the only file that imports `@weave/core`, and the
following was written against `docs/API_CONTRACT.md` /
`packages/core/src/types.ts` before the implementation existed. If the
harness fails at runtime once core is built (not just "module not found"),
these are the first things to check:

- `new Doc({ replica })` — brand new empty doc. Assumed synchronous, no
  further setup needed before `.insert()` works.
- `doc.stateVector()` / `doc.opsSince(sv)` / `doc.applyUpdate(update)` /
  `doc.encodeStateAsUpdate()` — assumed to behave exactly like their Yjs
  namesakes (`Y.encodeStateVector` / `Y.encodeStateAsUpdate(doc, sv)` /
  `Y.applyUpdate` / `Y.encodeStateAsUpdate(doc)`), which the contract
  explicitly says is deliberate ("sync (Yjs-shaped, deliberately)").
- `doc.stats()` — assumed cheap enough to call once per benchmark
  measurement point (suites 2, 4, 5 all call it) without materially
  perturbing the timing of the surrounding operation.
- `doc.gc(peerStateVectors)` — assumed to accept an array of `StateVector`
  and return a `GCReport` synchronously; suite 5 passes `[doc.stateVector()]`
  as the sole frontier (see above).
- Two independently-created `new Doc({replica: "A"})` and
  `new Doc({replica: "B"})` are assumed mergeable out of the box via
  `applyUpdate`/`opsSince` with no shared setup step — unlike Automerge,
  which needs every replica to descend from one shared genesis snapshot or
  merges silently drop content (see the comment above
  `genesisBytes()` in `subjects.ts` for the full explanation). If Weave
  turns out to have a similar "must share an origin" requirement, every
  suite that calls `subject.createDoc()` more than once per scenario
  (3, 6, and the concurrent-merge curve in 3) would need the same
  genesis-snapshot treatment the Automerge adapter already has.

## Known slow point if you do run this

Automerge's `Automerge.change()` has real per-call overhead (it commits a
new immutable version and crosses the JS/WASM boundary), so single-char-at-
a-time workloads (suites 1, 2, 8, and the per-op loop in suite 7) run one
`change()` per character for Automerge specifically. This is intentional —
it's the realistic cost of that API shape, not a bug — but it does mean the
full-size run (2e5-char docs) is meaningfully slower for Automerge than for
Yjs or Weave. `--quick` uses much smaller sizes for exactly this
reason.

## What these numbers are not

Every suite here is a single-process Node measurement on one machine. It
measures the merge algorithm and the data structure around it — not a
distributed system, not a browser, not a network. Nothing here says
anything about how any of the three libraries behaves under a real
connection with real users on it.

Numbers move between runs. Where a suite is unstable enough that no
honest single figure can be quoted, the report says so and quotes a range
instead of picking the flattering end of it — and one suite
(`local-edit-throughput`) is excluded from the headline claims entirely,
because it swung by more than a factor of three across seeds. The
reasoning is in the root [README](../../README.md#benchmarks).
