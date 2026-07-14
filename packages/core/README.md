# @weave/core

The engine. A Fugue sequence CRDT for collaborative text, with tombstone
garbage collection, rich text, and undo that behaves under concurrency.

No runtime dependencies. See [DESIGN.md](../../DESIGN.md) for why it is built
this way and what it costs.

```ts
import { Doc } from "@weave/core";

const alice = new Doc({ replica: "alice" });
const bob = new Doc({ replica: "bob" });

alice.insert(0, "hello");
bob.applyUpdate(alice.opsSince(bob.stateVector()));

// Both type at the same position, neither has seen the other.
alice.insert(5, " world");
bob.insert(5, " there");

alice.applyUpdate(bob.opsSince(alice.stateVector()));
bob.applyUpdate(alice.opsSince(bob.stateVector()));

alice.toString() === bob.toString(); // true, and neither run is interleaved
```

## Text

```ts
doc.insert(index, text);
doc.delete(index, count);
doc.toString();
doc.length;
```

Local edits apply immediately and never wait on the network.

## Sync

Deliberately Yjs-shaped, because that shape is familiar and it works.

```ts
const sv = doc.stateVector();          // { replicaId: nextCounter }
const update = doc.opsSince(sv);       // Uint8Array; may be empty
doc.applyUpdate(update);               // idempotent, order-independent
doc.encodeStateAsUpdate();             // everything, for a fresh peer
const snap = doc.snapshot();
const restored = Doc.load(snap);
```

`applyUpdate` is safe to call with anything, in any order, more than once.
Operations whose dependencies have not arrived are buffered; `doc.pendingCount`
is zero once a document is settled.

There is no operation log. Insert operations are regenerated from the tree on
demand, which is what lets garbage collection actually free memory rather than
trade a tombstone for a log entry.

## Events

```ts
const off = doc.on("update", (bytes, origin) => transport.send(bytes));
doc.on("change", (e) => {
  for (const d of e.deltas) {
    // { type: "insert", index, text } | { type: "delete", index, count }
  }
});
```

`change` deltas are minimal and ordered so they can be replayed straight onto a
string or a DOM text node — each delta's index is valid in the state left by
the previous one.

## Rich text

```ts
doc.format(0, 5, "bold", true);
doc.format(3, 8, "italic", true);
doc.spans(); // [{ text, marks: { bold: true } }, ...]
```

Marks are Peritext-style: a key, a value, and a pair of sticky anchors. A bold
range survives someone editing above it *and* someone typing inside it.
Concurrent bold and italic over crossing ranges both apply; concurrent
`bold=true` and `bold=false` over the same range is last-writer-wins per key.

## Undo

```ts
const um = doc.undoManager();
um.undo();
um.redo();
um.canUndo;
um.canRedo;
um.stopCapturing(); // start a new entry rather than coalescing
```

Deletion is an OR-Set of tokens, so undoing your delete removes only *your*
token — a collaborator's concurrent delete of the same text survives it.

## Garbage collection

```ts
const report = doc.gc([peerStateVector1, peerStateVector2]);
```

Only operations every listed peer has already observed are collected.

```ts
doc.gc([]);                   // no peers known -> collects nothing
doc.gc([doc.stateVector()]);  // "I am the only replica" -> collects
```

An empty peer list means "I do not know what anyone else has seen", and the
safe reading of that is not "therefore everything is settled" — so a document
that genuinely has no other replicas has to say so explicitly. Text is
reclaimed; character identities are not, and
[DESIGN.md §6](../../DESIGN.md) explains why removing them would strand peers.

## Presence

```ts
import { Awareness } from "@weave/core";

const aw = new Awareness(doc);
aw.setLocal({ name: "Alice", color: "#3b82f6" });
aw.setCursor(selectionStart, selectionEnd);
aw.cursorIndices("bob"); // { anchor, head } in the *current* document
transport.send(aw.encode());
```

Presence is not part of the CRDT. It is last-writer-wins per replica with a
timeout, because cursors are worthless five seconds later and should not cost a
tombstone forever. Cursors are stored as sticky anchors, so a caret stays on
its character when someone inserts a paragraph above it.

## Introspection

```ts
doc.stats();    // chars, tombstoned, nodes, skeletonNodes, maxDepth, charsPerNode, bytes, marks
doc.treeJSON(); // the tree, for a visualiser
doc.authors();  // one replica id per visible character, aligned with toString()
```

`authors()` is what makes interleaving *visible* — colour the characters by
author and a shuffled merge is obvious. Deriving it by diffing text before and
after a merge does not work, because an interleaved merge is not a contiguous
edit.

## The other two algorithms

```ts
import { createDoc, RGA, Logoot } from "@weave/core";

createDoc("fugue", "alice");
createDoc("rga", "alice");
createDoc("logoot", "alice", seededRandom); // Logoot needs a seed to be reproducible
```

RGA and Logoot are included as *controls*. They converge and they interleave —
RGA on backward-typed runs, Logoot on everything — which is what makes the
claim about Fugue mean something. They are straightforward O(n) array
implementations and are not optimised.

## Tests

```bash
npm test -w @weave/core
```

90 tests: property-based convergence and non-interleaving over generated
histories, one named test per known anomaly, network fuzzing, differential
testing against Yjs, and GC safety.
