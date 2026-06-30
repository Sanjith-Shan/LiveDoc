import type { FugueTree } from "./fugue.js";
import type { MarkOp } from "./ops.js";
import type { Anchor, FormattedSpan, MarkValue } from "./types.js";

/**
 * Rich text, Peritext-style (Litt, Lim, Kleppmann & van Hardenberg, 2022).
 *
 * A mark is not stored on characters. It is a pair of *anchors* — positions
 * that stick to a character rather than to an integer index — plus a key and a
 * value. That is what makes formatting survive concurrent editing: if someone
 * inserts three words in the middle of a bold range, the range still covers
 * them, because the range was never expressed in indices.
 *
 * Overlap is resolved per key, not per range, so concurrent bold and italic
 * over crossing ranges both apply, while concurrent bold=true and bold=false
 * over the same range is a last-writer-wins race decided by (Lamport, replica).
 */

/**
 * Where an anchor sits, as a visible index.
 *
 * If the anchored character has since been deleted, the anchor collapses onto
 * the tombstone's position and `after` stops mattering: a character with no
 * visible width has no "after". Without that, an end anchor on a deleted
 * character swallows the next live character into the range.
 */
export function anchorIndex(tree: FugueTree, a: Anchor): number {
  if (a.id === null) return a.after ? tree.length : 0;
  const loc = tree.findChar(a.id.r, a.id.c);
  if (loc === null) return a.after ? tree.length : 0;
  const at = tree.indexOf(loc.node, loc.offset);
  return a.after && !loc.node.deleted ? at + 1 : at;
}

function wins(a: MarkOp, b: MarkOp): boolean {
  if (a.lam !== b.lam) return a.lam > b.lam;
  return a.r > b.r;
}

/**
 * Splits the document into runs of identical formatting.
 *
 * O(m log m + m + n) for m marks over n characters: resolve every anchor,
 * sweep the boundaries, then slice the text once.
 */
export function resolveSpans(tree: FugueTree, marks: readonly MarkOp[]): FormattedSpan[] {
  const text = tree.text();
  if (text.length === 0) return [];
  if (marks.length === 0) return [{ text, marks: {} }];

  interface Resolved {
    op: MarkOp;
    from: number;
    to: number;
  }
  const resolved: Resolved[] = [];
  for (const op of marks) {
    const from = anchorIndex(tree, op.start);
    const to = anchorIndex(tree, op.end);
    if (to > from) resolved.push({ op, from, to });
  }
  if (resolved.length === 0) return [{ text, marks: {} }];

  const cuts = new Set<number>([0, text.length]);
  for (const r of resolved) {
    if (r.from > 0 && r.from < text.length) cuts.add(r.from);
    if (r.to > 0 && r.to < text.length) cuts.add(r.to);
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const out: FormattedSpan[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const winners = new Map<string, MarkOp>();
    for (const r of resolved) {
      if (r.from > lo || r.to < hi) continue;
      const cur = winners.get(r.op.key);
      if (cur === undefined || wins(r.op, cur)) winners.set(r.op.key, r.op);
    }
    const attrs: Record<string, MarkValue> = {};
    for (const [k, op] of winners) if (op.value !== null) attrs[k] = op.value;

    const chunk = text.slice(lo, hi);
    const prev = out[out.length - 1];
    if (prev !== undefined && sameAttrs(prev.marks, attrs)) {
      out[out.length - 1] = { text: prev.text + chunk, marks: prev.marks };
    } else {
      out.push({ text: chunk, marks: attrs });
    }
  }
  return out;
}

function sameAttrs(a: Readonly<Record<string, MarkValue>>, b: Readonly<Record<string, MarkValue>>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
