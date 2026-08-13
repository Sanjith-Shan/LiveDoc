/**
 * Suite 5 — tombstone GC. Weave only.
 *
 * Build a doc, delete the first half of it (so half its characters become
 * tombstones), measure heapUsed before/after `doc.gc(...)`, and report the
 * char reclamation rate. Yjs and Automerge have no comparable *explicit*
 * tombstone-collection API exposed to the application — Yjs runs its own
 * internal GC automatically as part of integrating updates (there is
 * nothing to call, and nothing to time separately), and Automerge simply
 * never dereferences old ops (its compaction on `save()` is about compact
 * *encoding*, not application-visible reclamation). So both are reported as
 * "not run" in this suite rather than benchmarked with a fabricated
 * equivalent.
 *
 * We call `doc.gc([doc.stateVector()])` — in a single-replica benchmark
 * there is no other peer to be behind, so the doc's own current state
 * vector is the correct (and only) causal-stability frontier to pass.
 */

import { formatBytes, formatNumber, forceGC, markdownTable, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, sequentialTyping } from "../traces.js";

export const id = "tombstone-gc";
export const title = "5. Tombstone GC (Weave only)";

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const size = ctx.quick ? 2000 : 50_000;
  const weave = ctx.subjects.find((s) => s.id === "weave");

  const rows: string[][] = [];
  for (const subject of ctx.subjects) {
    if (subject.id !== "weave") {
      rows.push([subject.label, "not run — no comparable explicit tombstone-GC API", "—", "—", "—"]);
      continue;
    }

    const ops = sequentialTyping(size, mulberry32(ctx.seed));
    const doc = subject.createDoc("gc-subject");
    for (const op of ops) {
      if (op.type === "insert") doc.insert(op.index, op.text);
    }

    const deleteCount = Math.floor(size / 2);
    doc.delete(0, deleteCount);

    forceGC();
    const heapBefore = process.memoryUsage().heapUsed;
    const report = doc.gc([doc.stateVector()]);
    forceGC();
    const heapAfter = process.memoryUsage().heapUsed;

    if (!report) {
      rows.push([subject.label, "gc() returned null unexpectedly", "—", "—", "—"]);
      continue;
    }

    const reclaimRate = deleteCount > 0 ? (report.charsReclaimed / deleteCount) * 100 : 0;
    rows.push([
      subject.label,
      `heap: ${formatBytes(Math.max(0, heapBefore - heapAfter))} freed`,
      `${formatNumber(reclaimRate, 1)}%`,
      String(report.charsReclaimed),
      `${formatBytes(report.bytesBefore)} -> ${formatBytes(report.bytesAfter)}`,
    ]);
  }

  const headers = ["Subject", "Heap freed", "Char reclamation rate", "Chars reclaimed", "stats().bytes before -> after"];

  const markdown = [
    `### ${title}`,
    "",
    `Doc size ${size} chars, first ${Math.floor(size / 2)} chars deleted, then \`doc.gc([doc.stateVector()])\`.`,
    "",
    markdownTable(headers, rows),
  ].join("\n");

  return {
    id,
    title,
    status: weave ? "ok" : "not run",
    markdown,
    data: { size },
    error: weave ? undefined : "weave subject unavailable",
  };
}
