import { describe, expect, it } from "vitest";
import { Logoot, RGA } from "../src/reference.js";
import { FugueText } from "../src/algorithms.js";
import type { SequenceCRDT } from "../src/types.js";
import { mulberry32 } from "./harness.js";

/**
 * The interleaving anomaly.
 *
 * Two people type at the same position at the same time. A naive merge
 * shuffles their characters together and produces text neither of them wrote:
 *
 *     Alice types "hello", Bob types "world"  ->  "hweolrllod"
 *
 * This file demonstrates the anomaly on two real algorithms and then shows the
 * engine's algorithm avoiding it, on the same inputs, in both directions.
 *
 * There are two directions and they are not the same problem:
 *
 *   forward   — each character is typed to the right of the last, the way
 *               people normally type. Every character's anchor is the
 *               character before it.
 *   backward  — each character is typed to the *left* of the last, which is
 *               what happens when you type a word before an existing one, or
 *               when an IME or a paste-and-edit sequence works right to left.
 *               Every character shares one anchor.
 *
 * Position-identifier CRDTs (Logoot, LSEQ) fail both, because an identifier
 * says only "somewhere in this gap". RGA fixes the forward case and still
 * fails the backward one, because a backward run collapses into one sibling
 * list ordered by timestamp. Fugue fixes both, which is the reason it is the
 * algorithm this engine implements.
 */

type Direction = "forward" | "backward";

interface Factory {
  name: string;
  make: (replica: string, seed: number) => SequenceCRDT;
}

const ALGOS: Factory[] = [
  { name: "Fugue", make: (r) => new FugueText(r) },
  { name: "RGA", make: (r) => new RGA(r) },
  { name: "Logoot", make: (r, seed) => new Logoot(r, mulberry32(seed)) },
];

/** Types `word` at `index`, one character at a time, in the given direction. */
function type(doc: SequenceCRDT, index: number, word: string, dir: Direction): void {
  if (dir === "forward") {
    for (let i = 0; i < word.length; i++) doc.insert(index + i, word[i]!);
  } else {
    for (let i = word.length - 1; i >= 0; i--) doc.insert(index, word[i]!);
  }
}

function exchange(a: SequenceCRDT, b: SequenceCRDT): void {
  const forA = b.opsSince(a.stateVector());
  const forB = a.opsSince(b.stateVector());
  a.applyOps(forA);
  b.applyOps(forB);
}

/**
 * Both replicas start from the same document, are cut off from each other,
 * type their own word at the same position, and reconnect.
 */
function concurrentRuns(f: Factory, seed: number, wordA: string, wordB: string, dir: Direction) {
  const a = f.make("alice", seed);
  const b = f.make("bob", seed + 1);
  a.insert(0, "[]");
  exchange(a, b);

  type(a, 1, wordA, dir);
  type(b, 1, wordB, dir);
  const beforeA = a.toString();
  const beforeB = b.toString();

  exchange(a, b);
  return { merged: a.toString(), other: b.toString(), beforeA, beforeB };
}

/** True when both words survive the merge as unbroken substrings. */
function contiguous(text: string, words: readonly string[]): boolean {
  return words.every((w) => text.includes(w));
}

// Disjoint alphabets, so "the word is present as a substring" cannot be
// satisfied by accident through shared letters.
const WORD_A = "ABCDE";
const WORD_B = "vwxyz";

const SEEDS = Array.from({ length: 25 }, (_, i) => i * 7919 + 1);

/** How often each algorithm interleaves, over the same 25 seeded histories. */
function interleaveRate(f: Factory, dir: Direction): number {
  let bad = 0;
  for (const seed of SEEDS) {
    const { merged, other } = concurrentRuns(f, seed, WORD_A, WORD_B, dir);
    expect(merged, `${f.name} diverged (${dir}, seed ${seed})`).toBe(other);
    if (!contiguous(merged, [WORD_A, WORD_B])) bad++;
  }
  return bad / SEEDS.length;
}

describe("every algorithm here converges — that is the easy part", () => {
  for (const f of ALGOS) {
    for (const dir of ["forward", "backward"] as const) {
      it(`${f.name} converges on concurrent ${dir} runs`, () => {
        for (const seed of SEEDS.slice(0, 5)) {
          const { merged, other } = concurrentRuns(f, seed, WORD_A, WORD_B, dir);
          expect(merged).toBe(other);
          expect(merged).toHaveLength(WORD_A.length + WORD_B.length + 2);
        }
      });
    }
  }
});

describe("forward interleaving", () => {
  it("Logoot interleaves: a position identifier does not know what you were writing next to", () => {
    const rate = interleaveRate({ ...ALGOS[2]! }, "forward");
    expect(rate).toBeGreaterThan(0.5);
  });

  it("RGA does not interleave forward runs: each character anchors to the previous one", () => {
    expect(interleaveRate(ALGOS[1]!, "forward")).toBe(0);
  });

  it("Fugue does not interleave forward runs", () => {
    expect(interleaveRate(ALGOS[0]!, "forward")).toBe(0);
  });
});

describe("backward interleaving — the one RGA misses", () => {
  it("RGA interleaves backward runs: they collapse into one timestamp-ordered sibling list", () => {
    expect(interleaveRate(ALGOS[1]!, "backward")).toBe(1);
  });

  it("Logoot interleaves backward runs too", () => {
    expect(interleaveRate(ALGOS[2]!, "backward")).toBeGreaterThan(0.5);
  });

  it("Fugue does not interleave backward runs: a backward run is a left-child chain", () => {
    expect(interleaveRate(ALGOS[0]!, "backward")).toBe(0);
  });
});

describe("the anomaly, in the words people actually use", () => {
  it("produces the textbook garbage on Logoot and clean text on Fugue", () => {
    const table: Record<string, Record<Direction, string>> = {};
    for (const f of ALGOS) {
      table[f.name] = {
        forward: concurrentRuns(f, 12345, "hello", "world", "forward").merged,
        backward: concurrentRuns(f, 12345, "hello", "world", "backward").merged,
      };
    }

    // Printed on purpose: this table is the artifact, not the assertion.
    // eslint-disable-next-line no-console
    console.table(table);

    expect(contiguous(table["Fugue"]!.forward, ["hello", "world"])).toBe(true);
    expect(contiguous(table["Fugue"]!.backward, ["hello", "world"])).toBe(true);
    expect(contiguous(table["RGA"]!.forward, ["hello", "world"])).toBe(true);
    expect(contiguous(table["RGA"]!.backward, ["hello", "world"])).toBe(false);
    expect(contiguous(table["Logoot"]!.forward, ["hello", "world"])).toBe(false);
  });
});

describe("three replicas typing at once", () => {
  it("Fugue keeps all three runs whole, in both directions", () => {
    for (const dir of ["forward", "backward"] as const) {
      const words = ["ABCDE", "vwxyz", "12345"];
      const docs = ["alice", "bob", "carol"].map((r) => new FugueText(r));
      docs[0]!.insert(0, "[]");
      for (let i = 0; i < 2; i++) {
        for (const a of docs) for (const b of docs) if (a !== b) exchange(a, b);
      }
      docs.forEach((d, i) => type(d, 1, words[i]!, dir));
      for (let i = 0; i < 2; i++) {
        for (const a of docs) for (const b of docs) if (a !== b) exchange(a, b);
      }
      const texts = docs.map((d) => d.toString());
      expect(new Set(texts).size, `diverged (${dir}): ${texts.join(" | ")}`).toBe(1);
      expect(contiguous(texts[0]!, words), `interleaved (${dir}): ${texts[0]}`).toBe(true);
    }
  });
});

describe("a run interrupted by a remote edit is not the same as an interleave", () => {
  it("splits only where the other replica actually inserted", () => {
    const a = new FugueText("alice");
    const b = new FugueText("bob");
    a.insert(0, "[]");
    exchange(a, b);

    // Alice types half a word, hears from Bob, then finishes it. Her run is
    // *supposed* to be broken here: she saw his text before typing the rest.
    type(a, 1, "ABC", "forward");
    exchange(a, b);
    type(b, 4, "vwxyz", "forward");
    exchange(a, b);
    type(a, 4, "DE", "forward");
    exchange(a, b);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("[ABCDEvwxyz]");
  });
});
