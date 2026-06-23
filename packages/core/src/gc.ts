import type { Doc } from "./doc.js";
import { GC_TOKEN, type FugueTree, type TNode } from "./fugue.js";
import { parseKey, svGet } from "./id.js";
import type { CharRange } from "./ops.js";
import type { GCReport, StateVector } from "./types.js";

/**
 * Tombstone garbage collection.
 *
 * ## Why tombstones cannot simply be deleted
 *
 * A deleted character is still a *position*. Another replica may be about to
 * insert next to it, naming it as an anchor. Drop it and that insert can never
 * be placed, so the replica stalls forever. Every sequence CRDT pays this tax;
 * the question is only how much of it can be reclaimed and when.
 *
 * ## When collection is safe
 *
 * An operation is *causally stable* once every replica we know about has
 * observed it — the pointwise minimum of all state vectors. Nothing concurrent
 * with it can still be in flight. That is the condition this pass uses.
 *
 * ## What is actually reclaimed
 *
 * Three things, in order of how much they are worth:
 *
 * 1. **Text.** A stable tombstoned run keeps its identity and loses its
 *    characters. For a text document this is nearly all of the memory: a run
 *    of 10,000 deleted characters drops from ~20 KB to a node header.
 * 2. **Adjacent skeleton runs are merged.** Deleting a paragraph produces one
 *    tombstoned run per typing session, and consecutive ones from the same
 *    replica collapse into a single node. A later insert that anchors inside
 *    the merged range just splits it again, so nothing is lost.
 * 3. **The target lists of delete records** — but never the records
 *    themselves. A delete consumes a counter from the same per-replica
 *    sequence as characters do, and integration requires that sequence to be
 *    contiguous, so removing one strands every later operation by that author.
 *    See `dropRecords` below.
 *
 * ## What is deliberately *not* reclaimed, and why
 *
 * The skeleton node — replica id, counter, length — is kept forever. Removing
 * it outright is unsafe even when it is stable, because "stable" only means no
 * *concurrent* operation is in flight; a replica is still free to insert next
 * to a tombstone at any later time and name it as an anchor. Replicas that had
 * collected would then stall on an operation they cannot place. So the floor
 * is O(distinct deleted runs) node headers, not zero. The benchmark reports
 * that floor rather than rounding it away.
 */
export function collect(doc: Doc, frontier: StateVector): GCReport {
  const before = doc.stats().bytes;
  const tree = doc.tree;
  const pinned = doc.pinnedTokens();

  const stable = (r: string, c: number): boolean => c < svGet(frontier, r);

  let charsReclaimed = 0;
  let nodesCollapsed = 0;

  for (const n of tree.walk()) {
    if (n === tree.root || n.content === null || !n.deleted) continue;
    // Every character of the run must be stable, not just its first.
    if (!stable(n.r, n.c + n.len - 1)) continue;
    if (n.del === null) continue;

    let collectable = true;
    for (const token of n.del) {
      if (token === GC_TOKEN) continue;
      if (pinned.has(token)) {
        collectable = false;
        break;
      }
      const id = parseKey(token);
      if (!stable(id.r, id.c)) {
        collectable = false;
        break;
      }
    }
    if (!collectable) continue;

    charsReclaimed += n.len;
    n.content = null;
    n.del = new Set<string>([GC_TOKEN]);
    nodesCollapsed++;
  }

  const nodesRemoved = mergeSkeletons(tree);
  const recordsDropped = dropRecords(doc, frontier, stable);
  void recordsDropped;

  tree.invalidate();
  const after = doc.stats().bytes;

  return {
    nodesRemoved,
    nodesCollapsed,
    charsReclaimed,
    bytesBefore: before,
    bytesAfter: after,
    frontier: { ...frontier },
  };
}

/**
 * Collapses `A -> B` where both are skeletons from the same replica with
 * contiguous counters and B is A's only right child with no left children of
 * its own. Order is preserved exactly, and the merged run can be split again
 * on demand if a later operation anchors inside it.
 */
function mergeSkeletons(tree: FugueTree): number {
  let removed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of [...tree.walk()]) {
      if (a === tree.root || !a.skeleton) continue;
      if (a.children.length !== a.leftCount + 1) continue;
      const b: TNode | undefined = a.children[a.leftCount];
      if (b === undefined || !b.skeleton) continue;
      if (b.r !== a.r || a.c + a.len !== b.c) continue;
      if (b.leftCount !== 0) continue;

      a.len += b.len;
      a.children.length = a.leftCount;
      for (const ch of b.children) {
        ch.parent = a;
        a.children.push(ch);
      }
      // Detach `b` completely. The sweep walks a materialised list, so `b` is
      // still in it; leaving its child array populated lets a later step
      // "merge" through a node that is no longer in the tree. The live tree
      // recovers on the next pass, but the removal is counted twice, and a GC
      // statistic that overstates what it reclaimed is worse than no statistic.
      b.children.length = 0;
      tree.dropFromIndex(b);
      removed++;
      changed = true;
    }
  }
  return removed;
}

/**
 * Shrinks delete records rather than removing them.
 *
 * A delete operation consumes a counter from the same per-replica sequence as
 * characters do, and integration requires that sequence to be contiguous.
 * *Removing* a record therefore punches a permanent hole: a peer that has not
 * seen it can never advance past that counter, so every later operation from
 * that replica buffers forever. The document does not merely lose the delete —
 * it stops accepting anything else from that author.
 *
 * So the record stays and its target list goes. The targets are the large part
 * (one entry per contiguous range), the effect they carried is now asserted
 * directly by the reclaimed runs themselves, and the counter remains
 * deliverable. A record with no targets applies as a no-op that does nothing
 * but move the state vector forward, which is exactly what is needed.
 */
function dropRecords(doc: Doc, frontier: StateVector, stable: (r: string, c: number) => boolean): number {
  const pinned = doc.pinnedTokens();
  let dropped = 0;

  for (const [token, op] of doc.delOps) {
    if (pinned.has(token)) continue;
    if (!stable(op.r, op.c)) continue;
    if (op.targets.length === 0) continue; // already compacted
    if (!op.targets.every((t) => allSkeleton(doc, t))) continue;
    doc.delOps.set(token, { ...op, targets: [] });
    dropped++;
  }
  // Undelete records are only consulted to find the delete they reverse, and
  // they consume a counter too, so they are left in place for the same reason.
  void doc.undelOps;
  void frontier;
  return dropped;
}

function allSkeleton(doc: Doc, range: CharRange): boolean {
  let c = range.c;
  const end = range.c + range.len;
  while (c < end) {
    const loc = doc.tree.findChar(range.r, c);
    if (loc === null) return false;
    if (!loc.node.skeleton) return false;
    c = loc.node.c + loc.node.len;
  }
  return true;
}
