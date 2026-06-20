import { describe, expect, it } from "vitest";
import { Doc } from "../src/index.js";
import { TestNetwork, mulberry32, randInt, syncAll } from "./harness.js";

/**
 * Network fuzzing.
 *
 * Convergence proofs assume a network that eventually delivers everything.
 * Real networks reorder, duplicate, delay, drop and partition. Each of those
 * breaks a different assumption, so each gets its own test:
 *
 *   reorder   — breaks any implementation that relies on arrival order
 *   duplicate — breaks any implementation whose merge is not idempotent
 *   delay     — breaks anything that assumes a bounded window of disagreement
 *   drop      — breaks anything that cannot recover state from a state vector
 *   partition — breaks anything that assumes it has seen recent history
 *
 * Duplicates matter more than they look. Idempotence is a defining property of
 * a CRDT and it is easy to get wrong the moment an operation carries a
 * counter, so it is tested directly rather than assumed.
 */

function edit(doc: Doc, rand: () => number, count: number): void {
  const alphabet = "abcdefghijklmnopqrstuvwxyz \n";
  for (let i = 0; i < count; i++) {
    if (doc.length > 4 && rand() < 0.25) {
      const at = randInt(rand, 0, doc.length - 1);
      doc.delete(at, Math.min(randInt(rand, 1, 4), doc.length - at));
    } else {
      const at = randInt(rand, 0, doc.length + 1);
      const n = randInt(rand, 1, 5);
      let s = "";
      for (let k = 0; k < n; k++) s += alphabet[randInt(rand, 0, alphabet.length)]!;
      doc.insert(Math.min(at, doc.length), s);
    }
  }
}

function build(count: number, opts: ConstructorParameters<typeof TestNetwork>[1], seed: number) {
  const rand = mulberry32(seed);
  const net = new TestNetwork(rand, opts);
  const docs = Array.from({ length: count }, (_, i) => new Doc({ replica: `r${i}` }));
  for (const d of docs) net.add(d);
  return { net, docs, rand };
}

describe("network fuzzing", () => {
  it("converges under aggressive reordering", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, docs, rand } = build(4, { reorder: true }, seed);
      for (let round = 0; round < 12; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 4));
        net.flush();
      }
      net.flush();
      net.reconcile();
      expect(new Set(docs.map((d) => d.toString())).size, `seed ${seed}`).toBe(1);
      for (const d of docs) expect(d.pendingCount).toBe(0);
    }
  });

  it("converges when a third of all messages are delivered twice", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, docs, rand } = build(4, { duplicateRate: 0.33, reorder: true }, seed);
      for (let round = 0; round < 12; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 4));
        net.flush();
      }
      net.reconcile();
      const texts = docs.map((d) => d.toString());
      expect(new Set(texts).size, `seed ${seed}`).toBe(1);
      // Duplicates must not duplicate text.
      expect(docs[0]!.stats().chars).toBe(texts[0]!.length);
    }
  });

  it("recovers everything that was dropped, once state vectors are exchanged", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, docs, rand } = build(3, { dropRate: 0.4, reorder: true, duplicateRate: 0.2 }, seed);
      for (let round = 0; round < 15; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 3));
        net.flush();
      }
      // Losing messages leaves replicas out of step. This is the reconnect
      // path: ask for what you are missing by state vector and get it back.
      net.reconcile();
      expect(new Set(docs.map((d) => d.toString())).size, `seed ${seed}`).toBe(1);
    }
  });

  it("heals a partition, however long it lasted", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const { net, docs, rand } = build(4, { reorder: true }, seed);
      for (const d of docs) edit(d, rand, 3);
      net.flush();
      net.reconcile();
      const shared = docs[0]!.toString();
      expect(new Set(docs.map((d) => d.toString())).size).toBe(1);

      // Cut two replicas off entirely and let everyone keep working.
      net.partition("r0");
      net.partition("r1");
      for (let round = 0; round < 10; round++) {
        for (const d of docs) edit(d, rand, 2);
        net.flush();
      }
      // Everyone still holds their own view, and it diverged.
      expect(docs[0]!.toString()).not.toBe(docs[2]!.toString());

      net.heal("r0");
      net.heal("r1");
      net.reconcile();
      const texts = docs.map((d) => d.toString());
      expect(new Set(texts).size, `seed ${seed}`).toBe(1);
      // Nothing anyone wrote before the split was lost.
      expect(texts[0]!.length).toBeGreaterThanOrEqual(shared.length - 40);
    }
  });

  it("converges when messages are held for a random number of rounds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, docs, rand } = build(4, { maxDelayRounds: 5, reorder: true }, seed);
      for (let round = 0; round < 15; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 3));
        net.flush();
      }
      // Messages are still in the air at this point; that is the state a naive
      // convergence check would pass by accident.
      expect(net.inFlight()).toBeGreaterThan(0);
      net.drain();
      expect(net.inFlight()).toBe(0);
      expect(new Set(docs.map((d) => d.toString())).size, `seed ${seed}`).toBe(1);
      for (const d of docs) expect(d.pendingCount).toBe(0);
    }
  });

  it("converges when one replica is an order of magnitude slower than the rest", () => {
    for (let seed = 1; seed <= 15; seed++) {
      // r0's messages always take the full delay; everyone else is fast. This
      // is the shape of a peer on a bad connection rather than a clean split.
      const { net, docs, rand } = build(4, { maxDelayRounds: 8, slowReplicas: ["r0"], reorder: true }, seed);
      for (let round = 0; round < 20; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 3));
        net.flush();
      }
      net.drain();
      expect(new Set(docs.map((d) => d.toString())).size, `seed ${seed}`).toBe(1);
      for (const d of docs) expect(d.pendingCount).toBe(0);
    }
  });

  it("converges with everything wrong at once", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { net, docs, rand } = build(5, { reorder: true, dropRate: 0.3, duplicateRate: 0.3, maxDelayRounds: 4 }, seed);
      for (let round = 0; round < 20; round++) {
        if (round === 5) net.partition("r2");
        if (round === 12) net.heal("r2");
        if (round === 8) net.partition("r4");
        if (round === 16) net.heal("r4");
        for (const d of docs) edit(d, rand, randInt(rand, 1, 3));
        net.flush();
      }
      net.heal("r2");
      net.heal("r4");
      net.reconcile();
      expect(new Set(docs.map((d) => d.toString())).size, `seed ${seed}`).toBe(1);
      for (const d of docs) expect(d.pendingCount).toBe(0);
    }
  });
});

describe("fuzzing with garbage collection running", () => {
  /**
   * The fuzz suite originally never called `gc()`, and that gap hid a real
   * convergence bug: collection could drop the only record of a delete while a
   * partitioned replica had not yet seen it. Collection now runs *during* the
   * chaos, citing only the replicas that are currently reachable — the way a
   * real client would, and the way that used to break it.
   */
  it("converges when replicas collect while a peer is partitioned", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, docs, rand } = build(4, { reorder: true, maxDelayRounds: 2 }, seed);
      for (const d of docs) edit(d, rand, 4);
      net.reconcile();

      const away = docs[3]!;
      net.partition(away.replica);

      for (let round = 0; round < 12; round++) {
        for (const d of docs) edit(d, rand, randInt(rand, 1, 3));
        net.flush();
        if (round % 3 === 2) {
          // Everyone still connected collects, citing only each other. The
          // partitioned replica is invisible to them, which is the point.
          const reachable = docs.filter((d) => d !== away);
          for (const d of reachable) {
            d.gc(reachable.filter((o) => o !== d).map((o) => o.stateVector()));
          }
        }
      }

      net.heal(away.replica);
      net.reconcile();
      const texts = docs.map((d) => d.toString());
      expect(new Set(texts).size, `seed ${seed} diverged:\n${texts.map((t, i) => `  r${i}: ${JSON.stringify(t)}`).join("\n")}`).toBe(1);
      for (const d of docs) expect(d.pendingCount).toBe(0);
    }
  });

  it("converges when a replica that collected is the only source for a newcomer", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rand = mulberry32(seed * 7717);
      const a = new Doc({ replica: "a" });
      const b = new Doc({ replica: "b" });
      edit(a, rand, 40);
      syncAll([a, b]);
      for (let i = 0; i < 6; i++) {
        edit(a, rand, 5);
        edit(b, rand, 5);
        syncAll([a, b]);
        a.gc([b.stateVector()]);
        b.gc([a.stateVector()]);
      }
      const fresh = new Doc({ replica: "fresh" });
      fresh.applyUpdate(a.opsSince(fresh.stateVector()));
      expect(fresh.toString(), `seed ${seed}`).toBe(a.toString());
      expect(fresh.pendingCount).toBe(0);
    }
  });
});

describe("cold start", () => {
  it("a replica that has seen nothing catches up from a single update", () => {
    const rand = mulberry32(99);
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    edit(a, rand, 200);
    syncAll([a, b]);
    edit(b, rand, 50);
    syncAll([a, b]);

    const fresh = new Doc({ replica: "fresh" });
    fresh.applyUpdate(a.opsSince(fresh.stateVector()));
    expect(fresh.toString()).toBe(a.toString());
    expect(fresh.pendingCount).toBe(0);
  });

  it("a replica that missed N operations receives only what it is missing", () => {
    const rand = mulberry32(7);
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    edit(a, rand, 300);
    syncAll([a, b]);
    const caughtUp = b.stateVector();

    edit(a, rand, 5);
    const catchUp = a.opsSince(caughtUp);
    const everything = a.encodeStateAsUpdate();
    expect(catchUp.length).toBeLessThan(everything.length / 5);

    b.applyUpdate(catchUp);
    expect(b.toString()).toBe(a.toString());
  });
});
