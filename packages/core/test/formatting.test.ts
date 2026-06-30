import { describe, expect, it } from "vitest";
import { Doc } from "../src/index.js";
import { sync, syncAll } from "./harness.js";

/**
 * Rich text under concurrent editing.
 *
 * The hard part is not applying bold. It is that a formatting range expressed
 * in indices is wrong the instant someone edits above it, and a range stored
 * on individual characters is wrong the instant someone types inside it. Marks
 * are stored as a pair of anchors — sticky positions — so neither happens.
 */

function plain(d: Doc): string {
  return d.spans().map((s) => s.text).join("");
}

describe("marks", () => {
  it("formats a range", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "hello world");
    d.format(0, 5, "bold", true);
    expect(d.spans()).toEqual([
      { text: "hello", marks: { bold: true } },
      { text: " world", marks: {} },
    ]);
    expect(plain(d)).toBe(d.toString());
  });

  it("keeps overlapping marks of different kinds", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "abcdef");
    d.format(0, 4, "bold", true);
    d.format(2, 4, "italic", true);
    expect(d.spans()).toEqual([
      { text: "ab", marks: { bold: true } },
      { text: "cd", marks: { bold: true, italic: true } },
      { text: "ef", marks: { italic: true } },
    ]);
  });

  it("expands at the end of a range and not at the start", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "bold");
    d.format(0, 4, "bold", true);
    d.insert(4, "er"); // typing at the end of bold text stays bold
    d.insert(0, ">"); // typing before it does not become bold
    expect(d.spans()).toEqual([
      { text: ">", marks: {} },
      { text: "bolder", marks: { bold: true } },
    ]);
  });

  it("covers text a collaborator typed inside the range", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "the end");
    a.format(0, 7, "bold", true);
    sync(a, b);
    b.insert(4, "very ");
    sync(a, b);
    expect(a.toString()).toBe("the very end");
    expect(a.spans()).toEqual([{ text: "the very end", marks: { bold: true } }]);
    expect(b.spans()).toEqual(a.spans());
  });

  it("survives an edit above the range without shifting", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "intro BOLD outro");
    a.format(6, 4, "bold", true);
    sync(a, b);
    b.insert(0, "PREPENDED ");
    sync(a, b);
    const bolded = a.spans().filter((s) => s.marks["bold"] === true).map((s) => s.text);
    expect(bolded).toEqual(["BOLD"]);
    expect(b.spans()).toEqual(a.spans());
  });
});

describe("concurrent formatting", () => {
  it("applies both when two replicas format different keys over crossing ranges", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "abcdefgh");
    sync(a, b);
    a.format(0, 5, "bold", true);
    b.format(3, 5, "italic", true);
    sync(a, b);
    expect(a.spans()).toEqual(b.spans());
    expect(a.spans()).toEqual([
      { text: "abc", marks: { bold: true } },
      { text: "de", marks: { bold: true, italic: true } },
      { text: "fgh", marks: { italic: true } },
    ]);
  });

  it("resolves a bold/unbold race by last writer, and both replicas agree", () => {
    const a = new Doc({ replica: "a" });
    const b = new Doc({ replica: "b" });
    a.insert(0, "contested");
    sync(a, b);
    a.format(0, 9, "bold", true);
    b.format(0, 9, "bold", null); // clears it
    sync(a, b);
    expect(a.spans()).toEqual(b.spans());
    expect(a.spans()).toHaveLength(1);
  });

  it("converges across three replicas formatting at once", () => {
    const docs = ["a", "b", "c"].map((r) => new Doc({ replica: r }));
    docs[0]!.insert(0, "one two three four");
    syncAll(docs);
    docs[0]!.format(0, 3, "bold", true);
    docs[1]!.format(4, 3, "italic", true);
    docs[2]!.format(8, 5, "code", true);
    syncAll(docs);
    const rendered = docs.map((d) => JSON.stringify(d.spans()));
    expect(new Set(rendered).size).toBe(1);
    expect(docs[0]!.toString()).toBe("one two three four");
  });

  it("keeps marks through a snapshot round trip", () => {
    const a = new Doc({ replica: "a" });
    a.insert(0, "styled text");
    a.format(0, 6, "bold", true);
    a.format(3, 8, "italic", true);
    const b = Doc.load(a.snapshot(), { replica: "b" });
    expect(b.spans()).toEqual(a.spans());
  });
});

describe("marks and deletion", () => {
  it("drops a mark whose whole range was deleted", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "keep BOLD keep");
    d.format(5, 4, "bold", true);
    d.delete(5, 5);
    expect(d.toString()).toBe("keep keep");
    expect(d.spans().some((s) => s.marks["bold"] === true)).toBe(false);
  });

  it("keeps the surviving half of a partially deleted range", () => {
    const d = new Doc({ replica: "a" });
    d.insert(0, "abcdefgh");
    d.format(2, 4, "bold", true); // "cdef"
    d.delete(4, 2); // remove "ef"
    expect(d.toString()).toBe("abcdgh");
    const bolded = d.spans().filter((s) => s.marks["bold"] === true).map((s) => s.text);
    expect(bolded).toEqual(["cd"]);
  });
});
