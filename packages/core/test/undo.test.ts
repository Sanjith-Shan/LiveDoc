import { describe, expect, it } from "vitest";
import { Doc } from "../src/index.js";
import { sync } from "./harness.js";

/**
 * Undo and redo under concurrency.
 *
 * Single-user undo is a stack. Multi-user undo is not, and the difference is
 * where implementations go wrong:
 *
 *   - undo must affect *your* edits, not the document's most recent edits
 *   - undoing your delete must not resurrect text someone else also deleted
 *   - redo has to work after remote edits have landed on top of the change
 *
 * All three fall out of representing deletion as an OR-Set of tokens: your
 * undo removes only your token.
 */

describe("undo on one replica", () => {
  it("undoes and redoes an insert", () => {
    const d = new Doc({ replica: "a" });
    const um = d.undoManager();
    d.insert(0, "hello");
    um.stopCapturing();
    d.insert(5, " world");

    expect(d.toString()).toBe("hello world");
    um.undo();
    expect(d.toString()).toBe("hello");
    um.undo();
    expect(d.toString()).toBe("");
    um.redo();
    expect(d.toString()).toBe("hello");
    um.redo();
    expect(d.toString()).toBe("hello world");
    expect(um.canRedo).toBe(false);
  });

  it("undoes and redoes a delete", () => {
    const d = new Doc({ replica: "a" });
    const um = d.undoManager();
    d.insert(0, "hello world");
    um.stopCapturing();
    d.delete(5, 6);
    expect(d.toString()).toBe("hello");
    um.undo();
    expect(d.toString()).toBe("hello world");
    um.redo();
    expect(d.toString()).toBe("hello");
  });

  it("groups keystrokes typed inside the capture window", () => {
    const d = new Doc({ replica: "a" });
    const um = d.undoManager();
    for (const ch of "hello") d.insert(d.length, ch);
    expect(um.depth).toBe(1);
    um.undo();
    expect(d.toString()).toBe("");
  });

  it("a new edit clears the redo stack", () => {
    const d = new Doc({ replica: "a" });
    const um = d.undoManager();
    d.insert(0, "abc");
    um.undo();
    expect(um.canRedo).toBe(true);
    d.insert(0, "z");
    expect(um.canRedo).toBe(false);
  });
});

describe("undo with someone else in the document", () => {
  it("undoes your own insert even after a remote edit landed on top of it", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const um = a.undoManager();
    a.insert(0, "shared ");
    sync(a, b);
    um.stopCapturing();

    a.insert(a.length, "MINE");
    sync(a, b);
    b.insert(b.length, " and theirs");
    sync(a, b);
    expect(a.toString()).toBe("shared MINE and theirs");

    um.undo();
    sync(a, b);
    expect(a.toString()).toBe("shared  and theirs");
    expect(b.toString()).toBe(a.toString());
  });

  it("does not undo the other replica's edits", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const um = a.undoManager();
    a.insert(0, "A");
    sync(a, b);
    b.insert(1, "B");
    sync(a, b);
    expect(a.toString()).toBe("AB");

    um.undo();
    sync(a, b);
    expect(a.toString()).toBe("B");
    expect(b.toString()).toBe("B");
    expect(um.canUndo).toBe(false); // nothing of a's left to undo
  });

  it("undoing your delete does not resurrect text the other replica also deleted", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "keep DOOMED keep");
    sync(a, b);
    const um = a.undoManager();

    // Both delete the same word, independently, with no contact.
    a.delete(5, 7);
    b.delete(5, 7);
    sync(a, b);
    expect(a.toString()).toBe("keep keep");

    // a changes its mind. b never did.
    um.undo();
    sync(a, b);

    // b's deletion token survives, so the word stays gone — and both agree.
    expect(a.toString()).toBe("keep keep");
    expect(b.toString()).toBe("keep keep");
  });

  it("restores the text when the only deletion was yours", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "keep DOOMED keep");
    sync(a, b);
    const um = a.undoManager();
    a.delete(5, 7);
    sync(a, b);
    expect(b.toString()).toBe("keep keep");

    um.undo();
    sync(a, b);
    expect(a.toString()).toBe("keep DOOMED keep");
    expect(b.toString()).toBe("keep DOOMED keep");
  });

  it("survives a concurrent undo and delete race", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "one two three");
    sync(a, b);
    const um = a.undoManager();

    a.delete(4, 4); // "two "
    sync(a, b);
    expect(b.toString()).toBe("one three");

    // Concurrently: a takes its delete back, b deletes a different word.
    // Neither has seen the other when it acts.
    um.undo();
    b.delete(4, 5); // "three"
    sync(a, b);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("one two ");
  });

  it("redo mints a fresh operation rather than replaying an old one", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "abcdef");
    sync(a, b);
    const um = a.undoManager();
    a.delete(2, 2);
    sync(a, b);
    um.undo();
    sync(a, b);
    um.redo();
    sync(a, b);
    expect(a.toString()).toBe("abef");
    expect(b.toString()).toBe("abef");
    // A replayed operation would be discarded as a duplicate and the redo
    // would silently do nothing; a fresh one takes effect on both replicas.
  });
});

describe("the undo horizon", () => {
  it("drops entries that garbage collection has passed", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const um = a.undoManager();
    a.insert(0, "old text ");
    sync(a, b);
    um.stopCapturing();
    a.insert(a.length, "new text");
    sync(a, b);
    expect(um.depth).toBe(2);

    // Everything both replicas hold is now causally stable.
    a.gc([b.stateVector()]);
    expect(um.depth).toBeLessThan(2);
  });

  it("keeps an entry whose delete the document still depends on", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    const um = a.undoManager();
    a.insert(0, "hello world");
    sync(a, b);
    um.stopCapturing();
    a.delete(5, 6);
    sync(a, b);

    // The delete is pinned by the undo stack, so its characters are not freed.
    const report = a.gc([b.stateVector()]);
    expect(report.charsReclaimed).toBe(0);
    um.undo();
    expect(a.toString()).toBe("hello world");
  });
});
