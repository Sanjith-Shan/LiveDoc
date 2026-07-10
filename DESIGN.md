# Design

Why this engine is built the way it is, what it costs, and where it breaks.

---

## 1. The problem

Two people type at the same position at the same time. Neither can wait for the
other, because a text editor that blocks on the network is not a text editor.
Both edits have to apply locally and immediately, travel in either order, and
end up producing the same document on both machines.

There are two families of answer.

**Operational Transformation** sends operations and rewrites their indices
against the operations that arrived first. It is what Google Docs uses and it
works, but the transformation functions have to be correct against every pair
of operation types, which is where OT implementations historically go wrong —
several published OT algorithms were later shown not to converge. OT also
usually needs a central server to impose a total order, which rules out
peer-to-peer and makes offline editing awkward.

**CRDTs** change the data structure instead of the operations. Every character
gets an immutable identity and a position defined relative to other characters,
so merging is a set union: commutative, associative, idempotent. No
transformation functions, no server required, and convergence is a property of
the structure rather than of a case analysis.

This engine is a CRDT. The cost of that choice is metadata — every character
carries an id, and deleted characters leave tombstones — and most of the
engineering here is about making that cost small.

---

## 2. Why Fugue, and not the obvious alternatives

Convergence is the easy half. Every algorithm below converges. The question is
what the merged text *says*.

### The interleaving anomaly

Alice types `hello` and Bob types `world`, at the same position, at the same
time. A merge that only guarantees convergence is free to produce:

```
hweolrllod
```

Both replicas agree on it. It is still garbage. Nobody wrote it.

There are two directions, and they are different problems:

- **Forward** — each character is typed to the right of the last, the way
  people normally type. Every character's anchor is the character before it.
- **Backward** — each character is typed to the *left* of the last. This
  happens when you type a word in front of existing text, and it is what an IME
  or a paste-then-edit sequence often produces. Every character in the run
  shares a single anchor.

`packages/core/test/interleaving.anomaly.test.ts` runs the same scenario
through three algorithms and prints what each produces. This is the actual test
output:

```
┌─────────┬────────────────┬────────────────┐
│ (index) │ forward        │ backward       │
├─────────┼────────────────┼────────────────┤
│ Fugue   │ '[helloworld]' │ '[helloworld]' │
│ RGA     │ '[worldhello]' │ '[whoerllldo]' │
│ Logoot  │ '[whoerlllod]' │ '[hworelldlo]' │
└─────────┴────────────────┴────────────────┘
```

**Logoot** (and LSEQ, and every position-identifier CRDT) fails both. A
position identifier says only "somewhere in the gap between these two
characters", chosen at random to keep identifiers short. Two replicas typing
into the same gap draw independently, so their characters shuffle. This is not
a bug in the implementation; it is what the algorithm is.

**RGA** fixes the forward case and misses the backward one. In RGA a character
is inserted immediately after its origin, and concurrent inserts at the same
origin are ordered by descending timestamp. A forward run is a chain — each
character's origin is the previous one — so it stays whole. A backward run is
not a chain: every character has the *same* origin, so the run becomes one
sibling list sorted by timestamp, and two concurrent backward runs interleave
by construction. `whoerllldo` is Alice and Bob's characters sorted by Lamport
clock.

**Fugue** (Weidner, Toomim & Kleppmann, 2023) fixes both, and it is a small
change: a character can anchor to the *left* of its successor as well as to the
right of its predecessor.

```
insert at index i:
  left = the character at i-1        (or the document root)
  if left has no right children:
      new character becomes a right child of left
  else:
      new character becomes a left child of left's successor
```

That second branch is the whole difference. Under it, a backward run becomes a
chain of left children — `b` is a left child of `a`, `a` is a left child of the
character that follows — so it is a subtree, and a subtree is contiguous in an
in-order traversal. Two concurrent backward runs become two sibling subtrees,
ordered against each other but never merged.

The correctness of the second branch depends on a small fact: if `left` has
right children, then `left`'s successor in the full tree order is the leftmost
node of `left`'s right subtree, which by definition has no left children of its
own. So attaching there really does land immediately after `left`.

The engine also ships RGA and Logoot, in `packages/core/src/reference.ts`.
They are not there for comparison benchmarking. They are there so the claim
"this avoids interleaving" sits next to something that does not, on the same
input, in the same test file. A property test generalises it:
`convergence.property.test.ts` generates 2–5 replicas typing runs in either
direction and asserts every run survives the merge unbroken.

### What about Yjs?

`differential.test.ts` runs the same scenarios through Yjs (YATA). On the
two-replica case Yjs is clean in both directions:

```
┌────────────┬────────────────┬────────────────┐
│ (index)    │ forward        │ backward       │
├────────────┼────────────────┼────────────────┤
│ Yjs        │ '[worldhello]' │ '[worldhello]' │
│ Weave │ '[helloworld]' │ '[helloworld]' │
└────────────┴────────────────┴────────────────┘
```

That is worth stating plainly rather than implying otherwise: YATA is much
closer to Fugue than RGA is, and on this scenario it does the right thing. The
Fugue paper's contribution is a proof of *maximal* non-interleaving and a
characterisation of the cases where YATA still interleaves — it is a sharper
result than "Yjs is broken", which it is not.

### Sibling order is free

Concurrent siblings are ordered by `(replica id, counter)`, ascending. Any
total order converges, and this one is arbitrary. It can afford to be, because
of an invariant the tree maintains:

> **A node's first-character id is the id of the operation that positioned it.**

A run of characters is a subtree, not a sibling list, so only the *first*
character of a run ever participates in a sibling comparison. Whatever order
the comparator picks, whole runs move together. That is also why inserts carry
no Lamport timestamp: position comes from the tree, not from a clock. Deletes
and formatting marks do carry one, because "who wins" is a real question there.

---

## 3. The data structure

### Runs

A node covers a *run* of characters `[c, c + len)` from one replica with
consecutive counters, not a single character. Typing a 2,000-character
paragraph produces one node.

This is the single largest constant-factor win in the engine. It collapses node
count, per-character object overhead, tree depth, and wire size all at once, and
it is why the wire encoding costs ~23 bytes per operation for a realistic
editing session rather than ~23 bytes per character.

Runs extend in place when the next insert is from the same replica, with the
next counter, anchored to the run's last character, and that character has no
right children. Otherwise a new node is created.

### Splitting

A run is split whenever an operation needs to anchor inside it. The left half
keeps the parent and the left children; the right half takes the right children
and becomes the sole right child of the left half.

Splitting is what preserves the invariant above. Consider a replica that has
seen `[c0]` and typed after it, producing an operation anchored at `c0`. A
different replica has already merged `c0` and `c1` into one node, so `c0` is
mid-run there. It splits at `c1`, and now compares the incoming operation
against a node whose first character is `c1` — which is exactly the id of the
operation that created `c1`. Both replicas run the same comparison and reach
the same order. Split history does not affect the outcome.

### Index lookup

Each node stores the number of visible characters in its subtree, so a visible
index resolves by descending the tree, and `indexOf` walks back up. Complexity
is O(depth), and depth depends on the workload:

- **Append-heavy typing** — one node, depth 1. This is the common case.
- **Random-position editing** — inserting at random positions builds a
  random-ish tree, so depth is O(log n) in expectation.
- **A long backward run** — a left-child chain, depth O(n). This is the
  pathological case. It is not currently compressed the way forward runs are,
  because a reversed run would break the "run is contiguous in traversal order"
  invariant that splitting relies on. See §9.

On top of the descent there is a one-entry position cache keyed by a structure
version counter. Sequential typing hits it every time, which makes the common
case O(1) rather than O(depth).

---

## 4. Causality and delivery

Every operation carries `(replica, counter)`. The state vector maps each
replica to the next counter it expects, and it is contiguous by construction:
an operation is applied only when its counter is exactly what is expected and
every character it anchors to is present. Anything else is buffered and retried
after the next successful application.

That gives the three properties that matter, and each is tested directly in
`network.fuzz.test.ts`:

| Property | What breaks without it | Test |
| --- | --- | --- |
| order independence | reordered delivery | reordering fuzz |
| idempotence | duplicate delivery | 33% duplicate rate |
| recoverability | dropped messages | 40% drop rate, then state-vector reconcile |

Duplicates deserve the emphasis they get. Idempotence is a defining property of
a CRDT and it is easy to lose the moment operations carry counters, so it is
asserted rather than assumed.

---

## 5. Sync without an operation log

The obvious way to answer "send me everything since state vector V" is to keep
every operation ever produced. That would make the memory claims meaningless —
garbage collection would free tombstones while the log grew forever.

So insert operations are **not** logged. They are regenerated from the tree on
demand: walk it in pre-order, and for each node emit an insert for the portion
of its run the peer is missing, anchored at the node's parent (or, for a partial
run, at the preceding character of the same run). Pre-order guarantees a parent
is emitted before its children, so the peer applies the whole batch without
buffering anything.

Deletes, undeletes and marks *are* logged, because their effect cannot be
inverted back into an operation from the state alone. They are small, and far
rarer than inserts.

---

## 6. Tombstone garbage collection

### Why tombstones cannot simply be removed

A deleted character is still a *position*. Another replica may be about to
insert next to it and name it as an anchor. Drop it, and that insert can never
be placed — the receiving replica buffers it forever. Every sequence CRDT pays
this tax. The only question is how much can be reclaimed, and when.

### When it is safe

An operation is **causally stable** once every replica in contact has observed
it. That is the pointwise minimum of all state vectors. Nothing concurrent with
a causally stable operation can still be in flight, which is the condition the
collector uses.

Pass the peers' state vectors to `doc.gc([...])`. An empty list collects
nothing: it means "I do not know what any other replica has seen", and reading
that as "therefore everything is settled" is exactly how a collector strands a
replica it forgot about. A document that genuinely has no other replicas says
so explicitly with `doc.gc([doc.stateVector()])`.

### What is reclaimed

1. **Text.** A stable tombstoned run keeps its identity and loses its
   characters. For a text document this is nearly all of the memory.
2. **Adjacent skeleton runs are merged.** Consecutive tombstones from the same
   replica with contiguous counters collapse into one node. A later insert that
   anchors inside the merged range simply splits it again, so nothing is lost.
3. **The target lists of delete records** — but not the records themselves.
   See below; this is the part I got wrong first.

### Two things that made collection unsafe, and what fixes them

Both of these produced silent, permanent divergence, and neither was caught by
the original test suite. They are written up because the reasoning that missed
them is more instructive than the final code.

**A delete is the only record that a deletion happened.** An insert can be
regenerated from the tree — that is the whole reason inserts are not logged.
A delete cannot: once applied, the tree shows a tombstone but nothing says
which operation produced it. The original collector dropped delete records once
they were causally stable, which is sound as far as "no concurrent operation is
still in flight" goes, and completely wrong as far as "every interested peer
can still learn this happened" goes. A replica that was offline when the delete
occurred already has the characters, so the insert side of a sync skips them,
and with the record gone there was nothing left to send. It kept the text
forever, and no amount of re-syncing fixed it.

The fix is to make deletion derivable from the tree after all: a reclaimed run
*asserts its own tombstone* during sync. That assertion carries no identity,
consumes no counter, and is idempotent, because it states a fact about settled
state rather than a new operation.

**A delete consumes a counter.** Character ids and operation ids share one
per-replica sequence, and integration requires that sequence to be contiguous —
an operation waits until everything before it from the same replica has
arrived. Removing a delete record therefore punched a permanent hole in that
sequence. A peer missing that counter could never advance past it, so every
later operation *from that author* buffered forever. The document did not
merely lose one delete; it stopped accepting anything else that replica wrote.

The fix is that records are compacted rather than removed: the target list —
the large part — goes, and the record stays as a counter that still delivers
and applies as a no-op. Its effect is already carried by the tombstone
assertion above.

The general lesson is one worth stating: **causal stability answers "can
anything still conflict with this?", not "does everyone already know it?"**.
Those are different questions, and a collector needs the second one.

### What is deliberately not reclaimed, and why

The skeleton node — replica id, counter, length — is kept forever. Removing it
outright is unsafe even when it is stable, because a replica is free to insert
next to a tombstone at any later time and name it as an anchor. Replicas that
had collected would then stall on an operation they cannot place.

Delete records are likewise kept forever, compacted. That is a bounded but real
cost — O(number of delete operations ever performed), at roughly a node header
each — and it is the honest price of the sync model. It is also why the claim
in this document is "insert operations are not logged", not "nothing is
logged".

### The GC horizon

A replica that has collected still needs to be able to bring a brand-new peer
fully up to date — otherwise collection would mean losing the ability to
onboard anyone. It can: a collected run is sent as an **opaque tombstone run**,
an insert operation carrying a length and no text. The new peer gets the ids it
may need to anchor against, without the characters nobody can see anyway.

That removes the horizon entirely for sync. It does not remove it for undo —
see below.

---

## 7. Undo and redo under concurrency

Single-user undo is a stack. Multi-user undo is not, and three things have to
hold:

- undo affects *your* edits, not the document's most recent edits
- undoing your delete must not resurrect text someone else also deleted
- redo has to work after remote edits have landed on top of the change

All three fall out of one representation. **Deletion is an OR-Set of tokens.** A
delete adds a token to each targeted character; a character is visible when its
token set is empty. Undoing a delete removes only *your* token, so a
collaborator's concurrent delete survives your undo — which is what a user
expects, and what a boolean tombstone flag gets wrong.

Insert and delete then collapse into the same shape, which is the point:
undoing an insert *is* hiding it, and undoing a delete *is* unhiding it. One
mechanism, so there is one set of concurrency semantics to reason about. Each
undo and redo mints a fresh operation rather than replaying an old one, so a
redo is never discarded as a duplicate.

**Known limit: the undo horizon is the GC horizon.** An entry cannot be undone
once its operations fall below the collection frontier, because the characters'
text may already have been freed. `UndoManager.prune` drops those entries, and
the collector refuses to free anything the undo stack still pins. In practice
undo history is bounded anyway, but it is a real limitation and it is stated
rather than hidden.

---

## 8. Rich text and presence

**Marks** are Peritext-style (Litt, Lim, Kleppmann & van Hardenberg, 2022): a
key, a value, and a pair of *anchors* — positions that stick to a character
rather than to an integer index. Formatting stored in indices is wrong the
instant someone edits above it; formatting stored on individual characters is
wrong the instant someone types inside it. Anchors are wrong in neither case.

The end anchor sits *before the character that follows the range*, not after
the last character in it. That is what makes bold text stay bold as you keep
typing at its end: new characters land before the anchor. A range reaching the
end of the document anchors to the document end instead. If an anchored
character is later deleted, the anchor collapses onto the tombstone's position
and `after` stops applying — a character with no visible width has no "after" —
which prevents an end anchor from swallowing the next live character.

Overlap resolves per key, not per range. Concurrent bold and italic over
crossing ranges both apply; concurrent `bold=true` and `bold=false` over the
same range is a last-writer-wins race decided by `(Lamport, replica id)`.

**Presence** is deliberately *not* part of the CRDT. Cursors are ephemeral,
high-frequency, and worthless five seconds later; putting them in the document
means paying tombstone and history costs forever for data with a two-second
lifetime. It is last-writer-wins per replica with a timeout. The one part that
does need care is that a cursor is stored as a pair of sticky anchors, so your
caret stays on the same character when a collaborator inserts a paragraph
above you.

---

## 9. Limits, stated up front

- **Structure is never fully reclaimed.** GC frees text, not positions. The
  floor is one node header per distinct deleted run. §6 explains why removing
  them is unsafe rather than merely unimplemented.
- **Backward runs are not run-length compressed.** A long right-to-left run
  produces a left-child chain of depth O(n), so index lookups into it degrade
  linearly. Forward runs — the overwhelmingly common case — are compressed.
  Compressing a reversed run would break the invariant that a run is contiguous
  in traversal order, which splitting depends on.
- **The undo horizon equals the GC horizon.** §7.
- **A stable delete cannot be undone by a remote replica.** This follows from
  the previous point and is the reason freeing text is safe at all.
- **Mark resolution is O(marks × spans) per render**, not incremental. Fine for
  documents with tens of marks; not for thousands.
- **Presence is not authenticated and not persisted.** It is demo scaffolding.
- **The sync server is a dumb relay** with no auth, no persistence, and no
  horizontal scaling. That is a deliberate scope choice: a CRDT that needs a
  clever server is not doing its job. The server never parses a CRDT payload.
- **Benchmarks are single-process Node measurements on one machine.** They
  measure the merge algorithm, not a distributed system.

---

## 10. How correctness is established

| Technique | What it catches | Where |
| --- | --- | --- |
| Property-based convergence over random histories | order-dependence, non-idempotence, non-commutativity | `convergence.property.test.ts` |
| Property-based non-interleaving, 2–5 replicas, both directions | run interleaving in general, not just the example | `convergence.property.test.ts` |
| Named anomaly tests across three algorithms | the specific documented failure modes | `interleaving.anomaly.test.ts` |
| Network fuzzing: reorder, duplicate, drop, partition | delivery assumptions | `network.fuzz.test.ts` |
| Differential testing against Yjs | the case nobody thought to write down | `differential.test.ts` |
| Single-replica equivalence to a JavaScript string | plain index arithmetic bugs | `convergence.property.test.ts` |
| GC safety: insert next to a collected tombstone | the unsafe-removal trap | `gc.test.ts` |

On differential testing: exact string equality is asserted only where the
answer is *forced* — a single replica, or replicas that always sync before
editing again. Under genuine concurrency Yjs and Fugue may legitimately order
two independent runs differently, and asserting equality there would be
asserting that Weave is Yjs. So the concurrent tests assert what is
actually forced: the same multiset of characters when no deletes are involved,
the same length when they are, and internal convergence in both libraries.

---

## References

- Weidner, Toomim & Kleppmann, *The Art of the Fugue: Minimizing Interleaving
  in Collaborative Text Editing* (2023) — the list CRDT this engine implements.
- Roh, Jeon, Kim & Lee, *Replicated Abstract Data Types* (2011) — RGA.
- Weiss, Urso & Molli, *Logoot: A Scalable Optimistic Replication Algorithm*
  (2009) — position identifiers.
- Litt, Lim, Kleppmann & van Hardenberg, *Peritext: A CRDT for Rich-Text
  Collaboration* (2022) — the formatting model.
- Nicolaescu et al., *Near Real-Time Peer-to-Peer Shared Editing on Extensible
  Data Types* (2016) — YATA, the algorithm behind Yjs.
- Kleppmann & Beresford, *A Conflict-Free Replicated JSON Datatype* (2017) —
  causal stability, and the basis of Automerge.
- Figma, *How Figma's multiplayer technology works* (2019) — the industrial
  framing of the same problem.
