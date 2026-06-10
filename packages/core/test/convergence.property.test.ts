import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/index.js";
import { syncAll } from "./harness.js";

/**
 * Property-based convergence testing.
 *
 * A CRDT that converges on the cases you thought of is not a CRDT. These
 * properties generate random histories across several replicas, deliver them
 * in random orders with random duplication, and assert the invariants that
 * define the data type:
 *
 *   convergence   — same set of operations, same state, whatever the order
 *   idempotence   — delivering an operation twice changes nothing
 *   commutativity — order of delivery does not matter
 *   validity      — a single replica behaves exactly like a plain string
 *
 * fast-check shrinks any counterexample down to a minimal failing history, so
 * a failure arrives as something small enough to read rather than a 400-step
 * log. That is most of the value of writing them this way.
 */

type Step =
  | { kind: "insert"; replica: number; at: number; text: string }
  | { kind: "delete"; replica: number; at: number; count: number }
  | { kind: "sync"; from: number; to: number };

const stepArb = (replicas: number) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.record({
      kind: fc.constant("insert" as const),
      replica: fc.integer({ min: 0, max: replicas - 1 }),
      at: fc.nat({ max: 1000 }),
      text: fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom(..."abcdefghij") }),
    }) },
    { weight: 2, arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      replica: fc.integer({ min: 0, max: replicas - 1 }),
      at: fc.nat({ max: 1000 }),
      count: fc.integer({ min: 1, max: 5 }),
    }) },
    { weight: 3, arbitrary: fc.record({
      kind: fc.constant("sync" as const),
      from: fc.integer({ min: 0, max: replicas - 1 }),
      to: fc.integer({ min: 0, max: replicas - 1 }),
    }) },
  ) as fc.Arbitrary<Step>;

const historyArb = fc
  .integer({ min: 2, max: 5 })
  .chain((replicas) =>
    fc.record({
      replicas: fc.constant(replicas),
      steps: fc.array(stepArb(replicas), { minLength: 1, maxLength: 80 }),
    }),
  );

/** Runs a history, returning the replicas and every update that was produced. */
function run(replicas: number, steps: readonly Step[]) {
  const docs = Array.from({ length: replicas }, (_, i) => new Doc({ replica: `r${i}` }));
  const updates: Uint8Array[] = [];
  for (const d of docs) d.on("update", (u, origin) => { if (origin === "local") updates.push(u); });

  for (const s of steps) {
    if (s.kind === "sync") {
      if (s.from === s.to) continue;
      docs[s.to]!.applyUpdate(docs[s.from]!.opsSince(docs[s.to]!.stateVector()));
      continue;
    }
    const d = docs[s.replica]!;
    if (s.kind === "insert") {
      d.insert(Math.min(s.at, d.length), s.text);
    } else if (d.length > 0) {
      const at = Math.min(s.at, d.length - 1);
      d.delete(at, Math.min(s.count, d.length - at));
    }
  }
  return { docs, updates };
}

describe("convergence", () => {
  it("every replica agrees once every operation has reached every replica", () => {
    fc.assert(
      fc.property(historyArb, ({ replicas, steps }) => {
        const { docs } = run(replicas, steps);
        syncAll(docs);
        const texts = docs.map((d) => d.toString());
        expect(new Set(texts).size).toBe(1);
        for (const d of docs) expect(d.pendingCount).toBe(0);
      }),
      { numRuns: 400 },
    );
  });

  it("holds when updates are delivered in a shuffled order", () => {
    fc.assert(
      fc.property(historyArb, fc.integer({ min: 0, max: 2 ** 31 }), ({ replicas, steps }, seed) => {
        const { docs, updates } = run(replicas, steps);
        syncAll(docs);
        const expected = docs[0]!.toString();

        // A fresh replica receives the whole history in a random order.
        const shuffled = shuffle(updates, seed);
        const fresh = new Doc({ replica: "fresh" });
        for (const u of shuffled) fresh.applyUpdate(u);
        expect(fresh.pendingCount).toBe(0);
        expect(fresh.toString()).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent: replaying every update again changes nothing", () => {
    fc.assert(
      fc.property(historyArb, ({ replicas, steps }) => {
        const { docs, updates } = run(replicas, steps);
        syncAll(docs);
        const before = docs[0]!.toString();
        const statsBefore = docs[0]!.stats();
        for (const u of updates) docs[0]!.applyUpdate(u);
        for (const u of updates) docs[0]!.applyUpdate(u);
        expect(docs[0]!.toString()).toBe(before);
        expect(docs[0]!.stats().chars).toBe(statsBefore.chars);
        expect(docs[0]!.stats().nodes).toBe(statsBefore.nodes);
      }),
      { numRuns: 200 },
    );
  });

  it("is commutative: two different delivery orders reach the same state", () => {
    fc.assert(
      fc.property(
        historyArb,
        fc.integer({ min: 0, max: 2 ** 31 }),
        fc.integer({ min: 0, max: 2 ** 31 }),
        ({ replicas, steps }, s1, s2) => {
          const { updates } = run(replicas, steps);
          const one = new Doc({ replica: "x" });
          const two = new Doc({ replica: "y" });
          for (const u of shuffle(updates, s1)) one.applyUpdate(u);
          for (const u of shuffle(updates, s2)) two.applyUpdate(u);
          expect(one.toString()).toBe(two.toString());
        },
      ),
      { numRuns: 250 },
    );
  });

  it("a lone replica behaves exactly like a JavaScript string", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("insert" as const), at: fc.nat({ max: 200 }), text: fc.string({ minLength: 1, maxLength: 8 }) }),
            fc.record({ kind: fc.constant("delete" as const), at: fc.nat({ max: 200 }), count: fc.integer({ min: 1, max: 6 }) }),
          ),
          { minLength: 1, maxLength: 120 },
        ),
        (ops) => {
          const d = new Doc({ replica: "solo" });
          let model = "";
          for (const op of ops) {
            if (op.kind === "insert") {
              const at = Math.min(op.at, model.length);
              d.insert(at, op.text);
              model = model.slice(0, at) + op.text + model.slice(at);
            } else if (model.length > 0) {
              const at = Math.min(op.at, model.length - 1);
              const n = Math.min(op.count, model.length - at);
              d.delete(at, n);
              model = model.slice(0, at) + model.slice(at + n);
            }
            expect(d.toString()).toBe(model);
            expect(d.length).toBe(model.length);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("non-interleaving, as a property rather than an example", () => {
  it("concurrent runs stay contiguous for any number of replicas and either direction", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 1, max: 8 }),
        fc.boolean(),
        (replicas, runLength, backward) => {
          const alphabets = ["ABCDEFGH", "vwxyzabc", "12345678", "!@#$%^&*", "IJKLMNOP"];
          const docs = Array.from({ length: replicas }, (_, i) => new Doc({ replica: `r${i}` }));
          docs[0]!.insert(0, "[]");
          syncAll(docs);

          const words = docs.map((_, i) => alphabets[i]!.slice(0, runLength));
          docs.forEach((d, i) => {
            const w = words[i]!;
            if (backward) for (let k = w.length - 1; k >= 0; k--) d.insert(1, w[k]!);
            else for (let k = 0; k < w.length; k++) d.insert(1 + k, w[k]!);
          });
          syncAll(docs);

          const text = docs[0]!.toString();
          expect(new Set(docs.map((d) => d.toString())).size).toBe(1);
          for (const w of words) {
            expect(text.includes(w), `run "${w}" was interleaved in "${text}"`).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
