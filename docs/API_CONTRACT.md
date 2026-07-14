# @weave/core — API contract

The interface the editor, server, and benchmark packages build against. The
authoritative types live in [`packages/core/src/types.ts`](../packages/core/src/types.ts);
this is the narrative version. For usage guidance rather than shape, see
[`packages/core/README.md`](../packages/core/README.md).

```ts
import { Doc, Awareness, createDoc, type Update, type StateVector } from "@weave/core";

const doc = new Doc({ replica: "alice" });   // replica id is optional; random if omitted

// --- text ---------------------------------------------------------------
doc.insert(0, "hello");
doc.delete(0, 2);
doc.toString();            // "llo"
doc.length;                // 3

// --- rich text ----------------------------------------------------------
doc.format(0, 3, "bold", true);
doc.spans();               // [{ text: "llo", marks: { bold: true } }]

// --- sync (Yjs-shaped, deliberately) ------------------------------------
const sv: StateVector = doc.stateVector();
const update: Update = doc.opsSince(sv);   // Uint8Array; may be empty
doc.applyUpdate(update, origin?);          // idempotent + order independent
doc.encodeStateAsUpdate();                 // everything, for a fresh peer
const snap = doc.snapshot();               // Uint8Array
const doc2 = Doc.load(snap, { replica: "bob" });
doc.pendingCount;                          // ops waiting on dependencies; 0 at rest

// --- events -------------------------------------------------------------
const off = doc.on("update", (u: Update, origin: unknown) => send(u));
doc.on("change", (e) => applyDeltasToTextarea(e.deltas));

// --- sticky positions ---------------------------------------------------
const a = doc.anchorAt(index, after?);     // survives concurrent edits
doc.indexOfAnchor(a);                      // back to an index, in the current state

// --- undo ---------------------------------------------------------------
const um = doc.undoManager();
um.undo(); um.redo(); um.canUndo; um.canRedo; um.depth; um.stopCapturing();

// --- gc -----------------------------------------------------------------
const report = doc.gc([peerSv1, peerSv2]);  // only collects causally stable ops
doc.stableFrontier([peerSv1, peerSv2]);

// --- introspection ------------------------------------------------------
doc.stats();      // { chars, tombstoned, nodes, skeletonNodes, maxDepth, charsPerNode, bytes, marks }
doc.treeJSON();   // TreeNodeJSON, for the tree visualiser
doc.authors();    // one replica id per visible character, aligned with toString()

// --- the other algorithms, for the anomaly lab --------------------------
createDoc("fugue" | "rga" | "logoot", replicaId, rand?);  // returns AnyDoc
// AnyDoc = insert / delete / toString / length / encodeStateAsUpdate /
//          applyUpdate / on("change") / authors()
// `rand` seeds Logoot, whose interleaving is genuinely random and therefore
// has to be seeded to demonstrate anything reproducibly.

// --- presence (ephemeral, NOT in the CRDT) ------------------------------
const aw = new Awareness(doc, timeoutMs?);
aw.setLocal({ name: "Alice", color: "#3b82f6" });
aw.setCursor(selStart, selEnd);            // integer indices -> sticky anchors
aw.encode();                               // Uint8Array to broadcast
aw.applyRemote(bytes);
aw.peers(); aw.remotePeers(); aw.removePeer(id);
aw.cursorIndices(replicaId);               // { anchor, head } | null, current state
aw.on("change", cb); aw.destroy();
```

## Notes that matter to callers

- **`applyUpdate` is total.** Any bytes, any order, any number of times. Ops
  whose dependencies have not arrived are buffered and retried.
- **`on("update")` fires for remote updates too**, with the `origin` you passed
  to `applyUpdate`. A transport must check `origin` to avoid echoing.
- **`change` deltas are replayable in order** — each delta's index is valid in
  the state left by the previous one.
- **`gc([])` collects nothing.** With no peers nothing is causally stable. That
  is correct, not a bug.
- **`authors()` is the only sound way to attribute characters.** Deriving
  attribution by diffing text across a merge fails, because an interleaved
  merge is not a contiguous edit.

## Wire protocol (server ↔ client)

JSON envelope, binary payloads base64'd in `d`. One room per document. The
server never parses a CRDT payload — it forwards opaque bytes.

```
c->s  { t: "join",      room, replica, name, color }
s->c  { t: "welcome",   room, replica, peers: PeerInfo[] }
c->s  { t: "sv",        d }              state vector, base64
s->c  { t: "sv",        d, from }        relayed, so peers can spot a gap
c->s  { t: "update",    d }
s->c  { t: "update",    d, from, seq }
c->s  { t: "awareness", d }
s->c  { t: "awareness", d, from }
s->c  { t: "peers",     peers }
c->s  { t: "chaos",     cfg }            partial ChaosConfig, merged server-side
s->c  { t: "chaos",     cfg }            full effective config
c->s  { t: "resume",    seq }            catch up from the room ring buffer
s->c  { t: "packet",    to, kind, status, bytes }
```

`ChaosConfig` — the server applies it to its own outbound relay, so the fuzzing
story is visible in the live demo and not only in the tests:

```ts
interface ChaosConfig {
  latencyMs: number;       // added delay, uniform 0..latencyMs
  jitter: boolean;         // deliver out of order
  duplicateRate: number;   // 0..1, probability a message is sent twice
  dropRate: number;        // 0..1
  partitioned: string[];   // replica ids currently cut off from the room
}
```

Dropped updates must never lose data. Clients exchange state vectors every 2s
and the server relays them, so a peer that notices a gap answers with whatever
is missing. That is the offline/reconnect path, and it is the same code path a
partition heal uses.

`packet` is a fate report sent back to the *sender* only, because the chaos
scheduler is the only thing that knows whether a given relay was delivered,
dropped, or duplicated. A send that never reaches the server at all — because
the sending replica is partitioned — is reported locally by the client with
status `queued`; see [`packages/server/README.md`](../packages/server/README.md)
under "Protocol additions".
