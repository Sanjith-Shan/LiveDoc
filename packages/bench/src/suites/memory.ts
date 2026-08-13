/**
 * Suite 4 — memory.
 *
 * Bytes retained per operation, two ways:
 *   1. `process.memoryUsage().heapUsed` delta from building the doc, with a
 *      forced GC and 3 warm iterations (see harness.measureRetainedBytes).
 *      This is "what the V8 heap actually grew by" — the number that
 *      matters for a real process's RSS.
 *   2. `doc.stats().bytes` — Weave-only, its own structural accounting
 *      of the CRDT tree (node arrays + char buffers), which is a lower,
 *      more theoretical number since it doesn't include V8 object
 *      overhead, hidden classes, or GC slack.
 *
 * These will not match, and that's expected — see README "Honesty" notes.
 * Automerge in particular runs its CRDT core in WebAssembly, so a large
 * share of its true memory footprint lives in WASM linear memory, which
 * `heapUsed` cannot see at all; its heapUsed numbers here are expected to
 * understate its real footprint.
 */

import { formatNumber, markdownTable, measureRetainedBytes, ratio, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, sequentialTyping } from "../traces.js";
import type { Subject, SubjectDoc } from "../subjects.js";

export const id = "memory";
export const title = "4. Memory (bytes retained per operation)";

function buildDoc(subject: Subject, size: number, seed: number): SubjectDoc {
  const ops = sequentialTyping(size, mulberry32(seed));
  const doc = subject.createDoc("mem");
  for (const op of ops) {
    if (op.type === "insert") doc.insert(op.index, op.text);
    else doc.delete(op.index, op.count);
  }
  return doc;
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const sizes = ctx.quick ? [200, 1000, 4000] : [1000, 10_000, 100_000, 200_000];

  const rows: {
    size: number;
    perSubject: Record<string, { heapBytesPerOp: number; statsBytesPerOp: number | null }>;
  }[] = [];

  for (const size of sizes) {
    const perSubject: (typeof rows)[number]["perSubject"] = {};
    for (const subject of ctx.subjects) {
      const { bytes, kept } = measureRetainedBytes(() => buildDoc(subject, size, ctx.seed), { warmIterations: 3 });
      const stats = kept.stats();
      perSubject[subject.id] = {
        heapBytesPerOp: bytes / size,
        statsBytesPerOp: stats ? stats.bytes / size : null,
      };
    }
    rows.push({ size, perSubject });
  }

  const yjsSubject = ctx.subjects.find((s: Subject) => s.id === "yjs");
  const weaveSubject = ctx.subjects.find((s: Subject) => s.id === "weave");

  const headers = [
    "Size (chars)",
    ...ctx.subjects.map((s) => `${s.label} heapUsed bytes/op`),
    "Weave stats().bytes/op",
    "Ratio heapUsed (Weave / Yjs)",
  ];

  // A delta of exactly 0 bytes is not a real "retains nothing" finding at
  // these sizes -- it's the heapUsed sample landing below what a single
  // forced-GC snapshot can resolve. Say so instead of printing a 0 that
  // reads as a measurement.
  function formatBytesPerOpCell(v: number | undefined): string {
    if (v === undefined || Number.isNaN(v)) return "n/a";
    if (v === 0) return "below measurement resolution";
    return formatNumber(v, 2);
  }

  const tableRows = rows.map((row) => {
    const heapCells = ctx.subjects.map((s) => formatBytesPerOpCell(row.perSubject[s.id]?.heapBytesPerOp));
    const weaveStats = weaveSubject ? row.perSubject[weaveSubject.id]?.statsBytesPerOp ?? null : null;

    const weaveHeap = weaveSubject ? row.perSubject[weaveSubject.id]?.heapBytesPerOp : undefined;
    const yjsHeap = yjsSubject ? row.perSubject[yjsSubject.id]?.heapBytesPerOp : undefined;
    // Don't compute a ratio off a noise-zero on either side -- that would
    // print a fabricated "0.00x" or divide-by-noise instead of "n/a".
    let ratioCell = "n/a";
    if (weaveHeap !== undefined && yjsHeap !== undefined && weaveHeap !== 0 && yjsHeap !== 0) {
      ratioCell = ratio(weaveHeap, yjsHeap);
    }

    return [
      String(row.size),
      ...heapCells,
      weaveStats === null ? "n/a" : formatBytesPerOpCell(weaveStats),
      ratioCell,
    ];
  });

  const markdown = [
    `### ${title}`,
    "",
    "heapUsed is measured with a forced GC and 3 warm iterations (see harness.measureRetainedBytes). Automerge's real footprint is understated here because most of it lives in WASM linear memory, not the V8 heap. A cell reading \"below measurement resolution\" means the heapUsed delta rounded to exactly 0 bytes, not that nothing was retained. See README for why heapUsed and stats().bytes diverge.",
    "",
    markdownTable(headers, tableRows),
  ].join("\n");

  return { id, title, status: "ok", markdown, data: { sizes, rows } };
}
