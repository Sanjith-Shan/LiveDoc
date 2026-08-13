/**
 * Suite 7 — wire size.
 *
 * A ~10k-char realistic typing session (traces.realisticEditing — the
 * generator meant to look most like a human, so this is the headline
 * "what would actually get sent over the wire" number).
 *
 * Two measurements, on the same op sequence, and they are NOT
 * interchangeable:
 *
 *   1. HEADLINE — per-transaction update bytes, via `doc.onUpdate`. This is
 *      what a real provider (y-websocket and friends) actually broadcasts:
 *      one message per local edit. This is the number that matters for
 *      bandwidth on a live collaborative session.
 *   2. SECOND TABLE — a state-vector diff computed after every op
 *      (`changesSince(previousStateVector)`). No real provider does this
 *      per keystroke; it is kept here because the two numbers disagree in
 *      an instructive way (see the note above that table).
 */

import { formatBytes, formatInt, formatNumber, markdownTable, ratio, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, realisticEditing } from "../traces.js";
import type { Subject } from "../subjects.js";

export const id = "wire-size";
export const title = "7. Wire size (10k-char realistic typing session)";

interface Row {
  subject: Subject;
  opsApplied: number;
  totalBytes: number;
  bytesPerOp: number;
}

/** Ratio cell: the real value on the Weave row, "1.0x" on the Yjs row
 * (it's the baseline being compared against), "n/a" elsewhere. Printing the
 * same computed ratio on both rows (the old behavior) made it look like two
 * independent measurements instead of one comparison. */
function ratioCellFor(row: Row, weaveRow: Row | undefined, yjsRow: Row | undefined): string {
  if (row.subject.id === "weave" && yjsRow) return ratio(row.bytesPerOp, yjsRow.bytesPerOp);
  if (row.subject.id === "yjs" && weaveRow) return "1.0x";
  return "n/a";
}

function buildRows(entries: { subject: Subject; opsApplied: number; totalBytes: number }[]): Row[] {
  return entries.map((e) => ({
    ...e,
    bytesPerOp: e.opsApplied > 0 ? e.totalBytes / e.opsApplied : Number.NaN,
  }));
}

function renderTable(rows: Row[]): string {
  const weaveRow = rows.find((r) => r.subject.id === "weave");
  const yjsRow = rows.find((r) => r.subject.id === "yjs");
  const headers = ["Subject", "Ops applied", "Total wire bytes", "Bytes/op", "Ratio bytes/op (Weave / Yjs)"];
  const tableRows = rows.map((row) => [
    row.subject.label,
    formatInt(row.opsApplied),
    formatBytes(row.totalBytes),
    formatNumber(row.bytesPerOp, 2),
    ratioCellFor(row, weaveRow, yjsRow),
  ]);
  return markdownTable(headers, tableRows);
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const targetOps = ctx.quick ? 500 : 10_000;

  const updateEntries: { subject: Subject; opsApplied: number; totalBytes: number }[] = [];
  const svDiffEntries: { subject: Subject; opsApplied: number; totalBytes: number }[] = [];

  for (const subject of ctx.subjects) {
    const ops = realisticEditing(targetOps, mulberry32(ctx.seed));
    const doc = subject.createDoc("typist");

    // Headline: bytes of each local-edit transaction, exactly what a
    // provider would broadcast for it.
    let updateBytes = 0;
    const unsubscribe = doc.onUpdate((bytes) => {
      updateBytes += bytes.byteLength;
    });

    // Second table: state-vector diff recomputed after every op.
    let token = doc.stateVector();
    let svBytes = 0;
    let opsApplied = 0;

    for (const op of ops) {
      if (op.type === "insert") doc.insert(op.index, op.text);
      else doc.delete(op.index, op.count);
      const delta = doc.changesSince(token);
      svBytes += delta.byteLength;
      token = doc.stateVector();
      opsApplied++;
    }

    unsubscribe();

    updateEntries.push({ subject, opsApplied, totalBytes: updateBytes });
    svDiffEntries.push({ subject, opsApplied, totalBytes: svBytes });
  }

  const updateRows = buildRows(updateEntries);
  const svDiffRows = buildRows(svDiffEntries);

  const markdown = [
    `### ${title}`,
    "",
    `Target ${targetOps} realistic-editing ops (85% insert-near-cursor, 10% delete, 5% cursor jump); actual mutation count may be slightly lower since cursor jumps don't mutate the doc.`,
    "",
    "**Per-transaction update bytes** — what a real provider (e.g. y-websocket) actually sends, one message per local edit:",
    "",
    renderTable(updateRows),
    "",
    "**State-vector diff per keystroke (not what a provider sends)** — `changesSince(previousStateVector)` recomputed after every single op. No real client does this per keystroke; it's included because the two tables disagree, and the disagreement is itself informative: Yjs's `encodeStateAsUpdate(doc, sv)` re-serialises its full delete set on every call, so with deletes in the mix this number grows with document size in a way the per-transaction number does not.",
    "",
    renderTable(svDiffRows),
  ].join("\n");

  return {
    id,
    title,
    status: "ok",
    markdown,
    data: { targetOps, updateRows, svDiffRows },
  };
}
