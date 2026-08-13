/**
 * Suite 1 — local-edit throughput.
 *
 * ops/sec (and ns/op) for sequential appends at doc sizes 1e3, 1e4, 1e5,
 * 2e5 chars. This is the best case for every sequence CRDT: every insert
 * lands at the current end of the document, so there is no tree
 * rebalancing and no concurrent-insert tie-breaking to do.
 */

import { formatNumber, markdownTable, ratio, timeSync, throughput, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, sequentialTyping } from "../traces.js";
import type { Subject } from "../subjects.js";

export const id = "local-edit-throughput";
export const title = "1. Local-edit throughput (sequential append)";

interface Row {
  size: number;
  perSubject: Record<string, { opsPerSec: number; nsPerOp: number }>;
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const sizes = ctx.quick ? [200, 1000, 4000] : [1000, 10_000, 100_000, 200_000];
  const rows: Row[] = [];

  for (const size of sizes) {
    const perSubject: Row["perSubject"] = {};
    for (const subject of ctx.subjects) {
      const ops = sequentialTyping(size, mulberry32(ctx.seed));
      const doc = subject.createDoc("solo");
      const { ms } = timeSync(() => {
        for (const op of ops) {
          if (op.type === "insert") doc.insert(op.index, op.text);
          else doc.delete(op.index, op.count);
        }
      });
      perSubject[subject.id] = throughput(ops.length, ms);
    }
    rows.push({ size, perSubject });
  }

  const yjsSubject = ctx.subjects.find((s: Subject) => s.id === "yjs");
  const weaveSubject = ctx.subjects.find((s: Subject) => s.id === "weave");

  const headers = [
    "Size (chars)",
    ...ctx.subjects.flatMap((s) => [`${s.label} ops/sec`, `${s.label} ns/op`]),
    "Ratio ops/sec (Weave / Yjs)",
  ];
  const tableRows = rows.map((row) => {
    const cells = ctx.subjects.flatMap((s) => {
      const r = row.perSubject[s.id];
      return [formatNumber(r?.opsPerSec ?? Number.NaN, 0), formatNumber(r?.nsPerOp ?? Number.NaN, 1)];
    });
    let ratioCell = "n/a";
    if (yjsSubject && weaveSubject) {
      // ops/sec: higher is better, but the ratio must still read as ">1.0x
      // means Weave is worse", so compare ns/op (lower is better)
      // instead of ops/sec directly.
      const cNsPerOp = row.perSubject[weaveSubject.id]?.nsPerOp ?? Number.NaN;
      const yNsPerOp = row.perSubject[yjsSubject.id]?.nsPerOp ?? Number.NaN;
      ratioCell = ratio(cNsPerOp, yNsPerOp);
    }
    return [String(row.size), ...cells, ratioCell];
  });

  const markdown = [
    `### ${title}`,
    "",
    "Sequential append only (no tree rebalancing, no concurrent tie-breaking). Ratio column is ns/op so >1.0x always means Weave is slower.",
    "",
    markdownTable(headers, tableRows),
  ].join("\n");

  return { id, title, status: "ok", markdown, data: { sizes, rows } };
}
