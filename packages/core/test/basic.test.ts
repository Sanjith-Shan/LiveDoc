import { describe, expect, it } from "vitest";
import { Doc, decodeOps, encodeOps, OP_INSERT } from "../src/index.js";
import { sync, syncAll } from "./harness.js";

describe("local editing", () => {
  it("inserts and deletes like a string", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "hello");
    d.insert(5, " world");
    expect(d.toString()).toBe("hello world");
    d.delete(5, 6);
    expect(d.toString()).toBe("hello");
    d.insert(0, ">> ");
    expect(d.toString()).toBe(">> hello");
    expect(d.length).toBe(8);
  });

  it("rejects out-of-range edits", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "abc");
    expect(() => d.insert(9, "x")).toThrow(RangeError);
    expect(() => d.delete(2, 9)).toThrow(RangeError);
  });

  it("compresses a typed run into a single node", () => {
    const d = new Doc({ replica: "a" });
    for (let i = 0; i < 500; i++) d.insert(i, "x");
    expect(d.toString()).toBe("x".repeat(500));
    expect(d.stats().nodes).toBe(1);
    expect(d.stats().maxDepth).toBe(1);
  });
});

describe("two replicas", () => {
  it("converges on a simple concurrent edit", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "hello world");
    sync(a, b);
    a.insert(5, ",");
    b.insert(11, "!");
    sync(a, b);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("hello, world!");
  });

  it("survives concurrent deletes of the same range", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "abcdef");
    sync(a, b);
    a.delete(1, 3);
    b.delete(1, 3);
    sync(a, b);
    expect(a.toString()).toBe("aef");
    expect(b.toString()).toBe("aef");
  });

  it("merges an offline session on reconnect", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "shared. ");
    sync(a, b);
    // The partition: both edit with no contact at all.
    a.insert(a.length, "a was offline. ");
    a.insert(a.length, "a wrote more. ");
    b.insert(b.length, "b was offline too. ");
    sync(a, b);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toContain("a was offline.");
    expect(a.toString()).toContain("b was offline too.");
  });

  it("is idempotent under duplicate delivery", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "abc");
    a.delete(1, 1);
    const u = a.encodeStateAsUpdate();
    b.applyUpdate(u);
    b.applyUpdate(u);
    b.applyUpdate(u);
    expect(b.toString()).toBe("ac");
    expect(b.stats().chars).toBe(2);
  });

  it("buffers operations that arrive before their dependencies", () => {
    const a = new Doc({ replica: "a" });
    a.insert(0, "first");
    const u1 = a.encodeStateAsUpdate();
    const sv1 = a.stateVector();
    a.insert(5, "second");
    const u2 = a.opsSince(sv1);

    const b = new Doc({ replica: "b" });
    b.applyUpdate(u2); // out of order on purpose
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBeGreaterThan(0);
    b.applyUpdate(u1);
    expect(b.toString()).toBe("firstsecond");
    expect(b.pendingCount).toBe(0);
  });
});

describe("three replicas", () => {
  it("converges when all three edit the same position", () => {
    const docs = ["a", "b", "c"].map((r) => new Doc({ replica: r }));
    docs[0]!.insert(0, "|");
    syncAll(docs);
    docs[0]!.insert(0, "one");
    docs[1]!.insert(0, "two");
    docs[2]!.insert(0, "three");
    syncAll(docs);
    const texts = docs.map((d) => d.toString());
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]!).toHaveLength("onetwothree|".length);
  });
});

describe("encoding", () => {
  it("round-trips an update", () => {
    const a = new Doc({ replica: "alice" });
    a.insert(0, "hello");
    a.format(0, 5, "bold", true);
    a.delete(1, 1);
    const bytes = a.encodeStateAsUpdate();
    const ops = decodeOps(bytes);
    const again = encodeOps(ops);
    expect([...again]).toEqual([...bytes]);
    expect(ops.some((o) => o.t === OP_INSERT)).toBe(true);
  });

  it("loads from a snapshot", () => {
    const a = new Doc({ replica: "a" });
    a.insert(0, "snapshot me");
    a.format(0, 8, "italic", true);
    const b = Doc.load(a.snapshot(), { replica: "b" });
    expect(b.toString()).toBe(a.toString());
    expect(b.spans()).toEqual(a.spans());
  });

  it("interns replica ids so a batch costs less than the naive encoding", () => {
    const a = new Doc({ replica: "a-fairly-long-replica-identifier" });
    for (let i = 0; i < 200; i++) a.insert(i, "x");
    const bytes = a.encodeStateAsUpdate();
    // The naive encoding writes the replica id on every one of the 200 ops.
    const naive = 200 * (a.replica.length + 4);
    // We write it once, and the 200 keystrokes have already merged into one run.
    expect(bytes.length).toBeLessThan(naive / 10);
    expect(bytes.length).toBeLessThan(200 + a.replica.length + 64);
  });
});

describe("anchors", () => {
  it("keeps a position stable across a remote insert above it", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "0123456789");
    sync(a, b);
    const anchor = a.anchorAt(5);
    expect(a.indexOfAnchor(anchor)).toBe(5);
    b.insert(0, "XXX");
    sync(a, b);
    expect(a.indexOfAnchor(anchor)).toBe(8);
  });
});
