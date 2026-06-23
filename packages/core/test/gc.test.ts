import { describe, expect, it } from "vitest";
import { Doc } from "../src/index.js";
import { sync, syncAll } from "./harness.js";

/**
 * Tombstone garbage collection.
 *
 * Two things have to be true at once, and it is easy to get one at the cost of
 * the other:
 *
 *   it must actually reclaim memory, and
 *   a replica that has collected must still be able to accept an operation
 *   that anchors next to something it collected.
 *
 * The second is the one that breaks naive implementations, so it gets more
 * tests here than the first.
 */

describe("collecting tombstones", () => {
  it("frees the text of deleted runs once every peer has seen the delete", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "x".repeat(10_000));
    sync(a, b);
    a.delete(0, 9_000);
    sync(a, b);

    const before = a.stats();
    expect(before.tombstoned).toBe(9_000);

    const report = a.gc([b.stateVector()]);

    const after = a.stats();
    expect(a.toString()).toBe("x".repeat(1_000));
    expect(report.charsReclaimed).toBe(9_000);
    expect(after.tombstoned).toBe(9_000); // still positions
    expect(after.skeletonNodes).toBeGreaterThan(0);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore / 2);
  });

  it("refuses to collect anything a peer has not acknowledged", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "hello world");
    sync(a, b);
    a.delete(0, 6);

    // b has not seen the delete, so it is not causally stable.
    const report = a.gc([b.stateVector()]);
    expect(report.charsReclaimed).toBe(0);

    sync(a, b);
    expect(a.gc([b.stateVector()]).charsReclaimed).toBe(6);
  });

  it("collects nothing at all when a peer is far behind", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "abcdef");
    const stale = b.stateVector(); // b has seen nothing
    a.delete(0, 3);
    expect(a.gc([stale]).charsReclaimed).toBe(0);
  });

  it("merges adjacent skeleton runs from the same replica", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "0123456789");
    sync(a, b);
    // Three separate deletes leave three adjacent tombstone runs with
    // consecutive counters — exactly the shape that can be merged.
    a.delete(1, 2);
    a.delete(1, 2);
    a.delete(1, 2);
    sync(a, b);
    expect(a.toString()).toBe("0789");

    const before = a.stats().nodes;
    const report = a.gc([b.stateVector()]);
    const after = a.stats().nodes;
    expect(report.nodesCollapsed).toBeGreaterThan(0);
    expect(report.nodesRemoved).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(a.toString()).toBe("0789");
  });

  it("needs no merging when a typed run was never fragmented", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    // Run-length compression has already done the work: consecutive typing is
    // one node whatever the pause between keystrokes.
    for (let i = 0; i < 5; i++) {
      a.insert(a.length, `session-${i} `);
      sync(a, b);
    }
    expect(a.stats().nodes).toBe(1);
    a.delete(0, a.length - 1);
    sync(a, b);
    a.gc([b.stateVector()]);
    expect(a.stats().nodes).toBe(2); // one tombstone skeleton, one live run
    expect(a.toString()).toBe(" ");
  });
});

describe("collecting is safe", () => {
  it("collects nothing when no peer state vectors are supplied", () => {
    const a = new Doc({ replica: "a" });
    a.insert(0, "abcdef");
    a.delete(0, 3);
    // An empty peer list means "I do not know what anyone else has seen".
    // Reading that as "therefore everything is settled" is how a CRDT strands
    // a replica it forgot about.
    expect(a.gc([]).charsReclaimed).toBe(0);
    // A document that really is alone says so explicitly.
    expect(a.gc([a.stateVector()]).charsReclaimed).toBe(3);
  });


  it("still accepts an insert anchored next to a collected tombstone", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "keep DELETE keep");
    sync(a, b);
    a.delete(5, 7); // remove "DELETE "
    sync(a, b);

    a.gc([b.stateVector()]);
    expect(a.stats().skeletonNodes).toBeGreaterThan(0);

    // b never collected, and inserts right at the boundary of what a threw away.
    b.insert(5, "NEW ");
    sync(a, b);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("keep NEW keep");
    expect(a.pendingCount).toBe(0);
  });

  it("brings a brand-new replica fully up to date after collecting", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "the quick brown fox jumps over the lazy dog");
    sync(a, b);
    a.delete(4, 6); // "quick "
    a.delete(10, 6); // "jumps "
    sync(a, b);
    const collected = a.gc([b.stateVector()]);
    expect(collected.charsReclaimed).toBeGreaterThan(0);

    // The collected replica is now the only one a newcomer can talk to.
    const fresh = new Doc({ replica: "fresh" });
    fresh.applyUpdate(a.opsSince(fresh.stateVector()));
    expect(fresh.toString()).toBe(a.toString());
    expect(fresh.pendingCount).toBe(0);

    // And the newcomer can edit next to the gaps without stalling anyone.
    fresh.insert(4, "slow ");
    syncAll([a, b, fresh]);
    expect(new Set([a, b, fresh].map((d) => d.toString())).size).toBe(1);
  });

  it("two replicas that collect at different times still converge", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const c = new Doc({ replica: "c" });
    a.insert(0, "one two three four five");
    syncAll([a, b, c]);
    a.delete(4, 4);
    syncAll([a, b, c]);

    a.gc([b.stateVector(), c.stateVector()]);
    // b collects later, after more edits have happened.
    c.insert(c.length, " six");
    syncAll([a, b, c]);
    b.gc([a.stateVector(), c.stateVector()]);
    a.insert(0, "zero ");
    syncAll([a, b, c]);

    const texts = [a, b, c].map((d) => d.toString());
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe("zero one three four five six");
  });

  it("is idempotent — running it twice reclaims nothing the second time", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "y".repeat(500));
    sync(a, b);
    a.delete(0, 400);
    sync(a, b);
    const first = a.gc([b.stateVector()]);
    const second = a.gc([b.stateVector()]);
    expect(first.charsReclaimed).toBe(400);
    expect(second.charsReclaimed).toBe(0);
    expect(a.toString()).toBe("y".repeat(100));
  });
});

describe("collecting while a peer is away", () => {
  /**
   * The case that a first version of this engine got wrong.
   *
   * A delete operation, unlike an insert, cannot be reconstructed from the
   * tree — which is why deletes are logged and inserts are not. Garbage
   * collection eventually drops those records. If every replica holding a
   * record drops it while some peer is still offline, that peer can never
   * learn the deletion happened: it already has the characters, so the insert
   * side of a sync skips them, and there is nothing left to send.
   *
   * The fix is to state deletion from the *tree* rather than only from the
   * log: a reclaimed run asserts its own tombstone during sync.
   */
  it("a peer that was offline during the delete still learns about it", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const away = new Doc({ replica: "c" });
    a.insert(0, "hello world");
    syncAll([a, b, away]);

    // `away` drops off the network here and misses everything below.
    a.delete(0, 6);
    sync(a, b);

    // Each collects citing the peer it can actually reach, which is the
    // natural reading of the API and must not be able to corrupt anything.
    a.gc([b.stateVector()]);
    b.gc([a.stateVector()]);
    // The record's target list is reclaimed, but the record itself stays: its
    // counter has to remain deliverable or the peer can never advance past it.
    expect([...a.delOps.values()].every((op) => op.targets.length === 0)).toBe(true);
    expect([...b.delOps.values()].every((op) => op.targets.length === 0)).toBe(true);

    syncAll([a, b, away]);
    const texts = [a, b, away].map((d) => d.toString());
    expect(new Set(texts).size, `diverged: ${texts.join(" | ")}`).toBe(1);
    expect(texts[0]).toBe("world");
    for (const d of [a, b, away]) expect(d.pendingCount).toBe(0);
  });

  it("holds when the returning peer also edited while it was away", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const away = new Doc({ replica: "c" });
    a.insert(0, "one two three");
    syncAll([a, b, away]);

    a.delete(0, 4); // "one "
    sync(a, b);
    away.insert(away.length, " four"); // concurrent, offline
    a.gc([b.stateVector()]);
    b.gc([a.stateVector()]);

    syncAll([a, b, away]);
    const texts = [a, b, away].map((d) => d.toString());
    expect(new Set(texts).size, `diverged: ${texts.join(" | ")}`).toBe(1);
    expect(texts[0]).toBe("two three four");
  });

  it("survives collection happening twice with the peer still away", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const away = new Doc({ replica: "c" });
    a.insert(0, "0123456789");
    syncAll([a, b, away]);

    a.delete(0, 3);
    sync(a, b);
    a.gc([b.stateVector()]);
    b.gc([a.stateVector()]);
    a.delete(0, 3); // now deleting "345"
    sync(a, b);
    a.gc([b.stateVector()]);
    b.gc([a.stateVector()]);

    syncAll([a, b, away]);
    const texts = [a, b, away].map((d) => d.toString());
    expect(new Set(texts).size, `diverged: ${texts.join(" | ")}`).toBe(1);
    expect(texts[0]).toBe("6789");
  });
});

describe("merging a long skeleton chain", () => {
  it("merges the whole chain, keeps every id resolvable, and counts honestly", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "0123456789ABCDEF");
    sync(a, b);
    // Six separate deletes leave six adjacent tombstone runs with consecutive
    // counters, so the merge has to cascade rather than fire once.
    for (let i = 0; i < 6; i++) a.delete(1, 2);
    sync(a, b);
    expect(a.toString()).toBe("0DEF");

    const before = a.stats().nodes;
    const report = a.gc([b.stateVector()]);
    const after = a.stats().nodes;
    expect(a.toString()).toBe("0DEF");

    // The count has to match what actually left the tree. A cascading merge
    // walks a materialised node list, so it is easy to count a removal twice
    // by merging through a node that has already been detached.
    expect(report.nodesRemoved).toBe(before - after);
    expect(report.nodesRemoved).toBeGreaterThanOrEqual(4);

    // Every character of the original run must still resolve to a node, or a
    // later operation anchored to one of them would buffer forever.
    for (let c = 0; c < 16; c++) {
      expect(a.tree.findChar("a", c), `character a@${c} was lost by the merge`).not.toBeNull();
    }

    // And the surviving text must still report the right indices, which is
    // what breaks first if a parent pointer is left dangling.
    for (let i = 0; i < a.length; i++) {
      const loc = a.tree.findByIndex(i)!;
      expect(a.tree.indexOf(loc.node, loc.offset)).toBe(i);
    }
  });

  it("still accepts a peer's insert anchored inside the merged region", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "0123456789ABCDEF");
    sync(a, b);
    for (let i = 0; i < 6; i++) a.delete(1, 2);
    sync(a, b);
    a.gc([b.stateVector()]);

    // b never collected, so it still anchors against characters a has merged.
    b.insert(1, "|");
    b.insert(3, "~");
    sync(a, b);

    expect(a.toString()).toBe(b.toString());
    expect(a.pendingCount).toBe(0);
    expect(b.pendingCount).toBe(0);
    expect(a.toString()).toBe("0|D~EF");
  });
});

describe("the floor", () => {
  it("keeps one skeleton node per deleted run and says so", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    // Ten separate deletes, interleaved with surviving text.
    for (let i = 0; i < 10; i++) a.insert(a.length, `keep${i}DROP${i}`);
    sync(a, b);
    for (let i = 9; i >= 0; i--) {
      const at = a.toString().indexOf(`DROP${i}`);
      a.delete(at, `DROP${i}`.length);
    }
    sync(a, b);
    a.gc([b.stateVector()]);

    const s = a.stats();
    // Structure is retained on purpose; only the text goes. This is the
    // documented floor, not a leak.
    expect(s.skeletonNodes).toBeGreaterThan(0);
    expect(s.skeletonNodes).toBeLessThanOrEqual(20);
    expect(a.toString()).toBe(Array.from({ length: 10 }, (_, i) => `keep${i}`).join(""));
  });
});
