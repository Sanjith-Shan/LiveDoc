# @weave/bench results

## Machine / runtime

- **CPU**: Apple M3 Pro
- **Arch**: arm64
- **Node**: v24.2.0
- **yjs**: 13.6.32
- **@automerge/automerge**: 3.4.1
- **Date**: 2026-08-28T07:20:15.294Z

Seed: 42

Every ratio in this report is printed as **Weave / Yjs**, so a number above 1.0 always means Weave is worse.

### 1. Local-edit throughput (sequential append)

Sequential append only (no tree rebalancing, no concurrent tie-breaking). Ratio column is ns/op so >1.0x always means Weave is slower.

| Size (chars) | Weave ops/sec | Weave ns/op | Yjs ops/sec | Yjs ns/op | Automerge ops/sec | Automerge ns/op | Ratio ops/sec (Weave / Yjs) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 235,824 | 4,240.5 | 140,701 | 7,107.3 | 14,768 | 67,716 | 0.6x |
| 10000 | 549,617 | 1,819.5 | 445,472 | 2,244.8 | 30,855 | 32,409.9 | 0.81x |
| 100000 | 889,494 | 1,124.2 | 559,102 | 1,788.6 | 35,758 | 27,966.1 | 0.63x |
| 200000 | 935,371 | 1,069.1 | 561,379 | 1,781.3 | 35,184 | 28,421.8 | 0.6x |

### 2. Random-position insert (adversarial)

Uniformly random insert position at every step. Ratio column is ns/op so >1.0x always means Weave is slower.

| Size (chars) | Weave ops/sec | Weave ns/op | Yjs ops/sec | Yjs ns/op | Automerge ops/sec | Automerge ns/op | Ratio ns/op (Weave / Yjs) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 408,260 | 2,449.4 | 188,881 | 5,294.3 | 28,676 | 34,872.7 | 0.46x |
| 10000 | 547,354 | 1,827 | 345,848 | 2,891.4 | 28,605 | 34,958.9 | 0.63x |
| 100000 | 341,733 | 2,926.3 | 136,392 | 7,331.8 | 23,335 | 42,853.4 | 0.4x |
| 200000 | 246,129 | 4,062.9 | 50,841 | 19,669.2 | 19,028 | 52,554.3 | 0.21x |

Tree depth is what index-lookup cost is a function of; this is the number this workload is designed to stress.

| Size (chars) | Weave maxDepth |
| --- | --- |
| 1000 | 21 |
| 10000 | 31 |
| 100000 | 42 |
| 200000 | 43 |

### 3. Merge latency

**Latency vs document size** — B's concurrent batch fixed at M = 200 ops. Mean of 5 rebuilds.

| Doc size N (chars) | Weave ms | Yjs ms | Automerge ms | Ratio ms (Weave / Yjs) |
| --- | --- | --- | --- | --- |
| 1000 | 0.118 | 0.15 | 3.275 | 0.79x |
| 10000 | 0.06 | 0.069 | 4.822 | 0.87x |
| 100000 | 0.07 | 0.07 | 30.315 | 1x |
| 200000 | 0.118 | 0.075 | 61.228 | 1.58x |

**Latency vs concurrent op count** — replica A's doc size fixed at N = 10000 chars. Mean of 5 rebuilds.

| Concurrent ops M | Weave ms | Yjs ms | Automerge ms | Ratio ms (Weave / Yjs) |
| --- | --- | --- | --- | --- |
| 10 | 0.085 | 0.053 | 3.211 | 1.6x |
| 100 | 0.038 | 0.048 | 3.67 | 0.79x |
| 1000 | 0.087 | 0.051 | 9.49 | 1.71x |
| 10000 | 0.085 | 0.049 | 68.769 | 1.74x |

**Latency vs concurrent replica count** — R replicas each type a distinct 20-char word at position 0, none having seen the others; merged pairwise into one target. Mean of 5 rebuilds.

| Concurrent replicas R | Weave ms | Yjs ms | Automerge ms | Ratio ms (Weave / Yjs) |
| --- | --- | --- | --- | --- |
| 2 | 0.046 | 0.032 | 0.345 | 1.41x |
| 4 | 0.03 | 0.031 | 0.69 | 0.96x |
| 8 | 0.039 | 0.059 | 1.484 | 0.66x |
| 16 | 0.071 | 0.095 | 3.558 | 0.75x |
| 32 | 0.117 | 0.217 | 9.044 | 0.54x |

### 4. Memory (bytes retained per operation)

heapUsed is measured with a forced GC and 3 warm iterations (see harness.measureRetainedBytes). Automerge's real footprint is understated here because most of it lives in WASM linear memory, not the V8 heap. A cell reading "below measurement resolution" means the heapUsed delta rounded to exactly 0 bytes, not that nothing was retained. See README for why heapUsed and stats().bytes diverge.

| Size (chars) | Weave heapUsed bytes/op | Yjs heapUsed bytes/op | Automerge heapUsed bytes/op | Weave stats().bytes/op | Ratio heapUsed (Weave / Yjs) |
| --- | --- | --- | --- | --- | --- |
| 1000 | below measurement resolution | below measurement resolution | 4.47 | 2.12 | n/a |
| 10000 | 29.61 | 28.1 | 29.99 | 2.01 | 1.05x |
| 100000 | 31.52 | 32.22 | 32.14 | 2 | 0.98x |
| 200000 | 31.83 | 32.04 | 32.07 | 2 | 0.99x |

### 5. Tombstone GC (Weave only)

Doc size 50000 chars, first 25000 chars deleted, then `doc.gc([doc.stateVector()])`.

| Subject | Heap freed | Char reclamation rate | Chars reclaimed | stats().bytes before -> after |
| --- | --- | --- | --- | --- |
| Weave | heap: 71.27 KB freed | 100% | 25000 | 98.14 KB -> 49.25 KB |
| Yjs | not run — no comparable explicit tombstone-GC API | — | — | — |
| Automerge | not run — no comparable explicit tombstone-GC API | — | — | — |

### 6. Cold start / offline sync

Fresh, empty replica applying one catch-up update covering N missed ops.

| Missed ops (N) | Weave ms | Weave bytes | Yjs ms | Yjs bytes | Automerge ms | Automerge bytes | Ratio ms (Weave / Yjs) | Ratio bytes (Weave / Yjs) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0.077 | 1,021 B | 0.098 | 1,018 B | 6.529 | 97.39 KB | 0.78x | 1x |
| 10000 | 0.054 | 9.79 KB | 0.027 | 9.78 KB | 77.741 | 978.06 KB | 2.02x | 1x |
| 100000 | 0.242 | 97.68 KB | 0.113 | 97.67 KB | 655.972 | 9.78 MB | 2.15x | 1x |

### 7. Wire size (10k-char realistic typing session)

Target 10000 realistic-editing ops (85% insert-near-cursor, 10% delete, 5% cursor jump); actual mutation count may be slightly lower since cursor jumps don't mutate the doc.

**Per-transaction update bytes** — what a real provider (e.g. y-websocket) actually sends, one message per local edit:

| Subject | Ops applied | Total wire bytes | Bytes/op | Ratio bytes/op (Weave / Yjs) |
| --- | --- | --- | --- | --- |
| Weave | 9,516 | 221.57 KB | 23.84 | 0.95x |
| Yjs | 9,516 | 233.73 KB | 25.15 | 1.0x |
| Automerge | 9,516 | 934.92 KB | 100.6 | n/a |

**State-vector diff per keystroke (not what a provider sends)** — `changesSince(previousStateVector)` recomputed after every single op. No real client does this per keystroke; it's included because the two tables disagree, and the disagreement is itself informative: Yjs's `encodeStateAsUpdate(doc, sv)` re-serialises its full delete set on every call, so with deletes in the mix this number grows with document size in a way the per-transaction number does not.

| Subject | Ops applied | Total wire bytes | Bytes/op | Ratio bytes/op (Weave / Yjs) |
| --- | --- | --- | --- | --- |
| Weave | 9,516 | 221.57 KB | 23.84 | 0.02x |
| Yjs | 9,516 | 12.77 MB | 1,406.92 | 1.0x |
| Automerge | 9,516 | 934.92 KB | 100.6 | n/a |

### 8. Degradation point (mean insert latency > 1ms)

Each subject is warmed up first with a throwaway 2000-char doc (random-position inserts, timings discarded), then grows a single doc geometrically (1000 to 512000 chars). At each checkpoint 30 inserts are timed and the chronologically first 20% are discarded before computing mean/median/p99. A subject stops growing once its mean crosses the threshold; later cells for that subject read "—".

| Subject | Degradation point (size where mean insert > 1ms) | Mean latency at that size (ms) |
| --- | --- | --- |
| Weave | not reached within sweep cap | — |
| Yjs | not reached within sweep cap | — |
| Automerge | not reached within sweep cap | — |

**Mean latency by checkpoint (ms)**

| Size (chars) | Weave mean ms | Yjs mean ms | Automerge mean ms |
| --- | --- | --- | --- |
| 1000 | 0.002 | 0.0026 | 0.0345 |
| 2000 | 0.0022 | 0.0027 | 0.0382 |
| 4000 | 0.0023 | 0.0034 | 0.0337 |
| 8000 | 0.0023 | 0.0031 | 0.0359 |
| 16000 | 0.0033 | 0.004 | 0.0364 |
| 32000 | 0.0028 | 0.0048 | 0.0485 |
| 64000 | 0.005 | 0.0076 | 0.0389 |
| 128000 | 0.0057 | 0.0614 | 0.0631 |
| 256000 | 0.0086 | 0.208 | 0.2234 |
| 512000 | 0.0097 | 0.3076 | 0.1072 |

**Median latency by checkpoint (ms)**

| Size (chars) | Weave median ms | Yjs median ms | Automerge median ms |
| --- | --- | --- | --- |
| 1000 | 0.0018 | 0.0026 | 0.034 |
| 2000 | 0.0019 | 0.0026 | 0.0382 |
| 4000 | 0.002 | 0.0029 | 0.0339 |
| 8000 | 0.0022 | 0.003 | 0.0361 |
| 16000 | 0.0031 | 0.0038 | 0.036 |
| 32000 | 0.0028 | 0.0042 | 0.0398 |
| 64000 | 0.0051 | 0.0071 | 0.0391 |
| 128000 | 0.0053 | 0.0562 | 0.0457 |
| 256000 | 0.007 | 0.1868 | 0.1619 |
| 512000 | 0.01 | 0.278 | 0.1044 |

**p99 latency by checkpoint (ms)**

| Size (chars) | Weave p99 ms | Yjs p99 ms | Automerge p99 ms |
| --- | --- | --- | --- |
| 1000 | 0.0062 | 0.0033 | 0.047 |
| 2000 | 0.0091 | 0.0038 | 0.0481 |
| 4000 | 0.0073 | 0.0142 | 0.0372 |
| 8000 | 0.0054 | 0.0042 | 0.0385 |
| 16000 | 0.0073 | 0.0058 | 0.0424 |
| 32000 | 0.0035 | 0.0105 | 0.2503 |
| 64000 | 0.0066 | 0.0158 | 0.0467 |
| 128000 | 0.011 | 0.1634 | 0.1942 |
| 256000 | 0.0406 | 0.6593 | 0.6199 |
| 512000 | 0.0143 | 0.9593 | 0.1289 |

## Honesty

- Losing to Yjs is expected — it is years of specialist optimisation.
- These are single-process Node benchmarks on one machine, not a distributed measurement.
- Any suite that did not complete is listed as "not run" rather than omitted.
- Where a measurement lands below the resolution of its instrument (e.g. a
  heapUsed delta that rounds to exactly 0 bytes), we print "below
  measurement resolution" rather than a 0 that would read as a finding.
- Suite 7 (wire size) reports two different numbers on purpose: per-transaction
  update bytes (the headline — what a real provider actually sends) and a
  per-keystroke state-vector diff (a second table, clearly labelled as not
  what a provider sends). They disagree, and the disagreement is itself part
  of the finding — see that suite's own notes.
- Suite 8 (degradation point) warms up every subject with an identical
  throwaway doc before timing anything, and discards the first 20% of each
  checkpoint's samples, so a JIT-compile outlier on the first measurement
  can't decide the answer by itself. Mean, median, and p99 are all reported
  per checkpoint so a remaining outlier stays visible instead of hidden
  inside a single averaged number.
