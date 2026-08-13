/**
 * Suite 2 — random-position insert.
 *
 * Same sizes as suite 1, but every insert lands at a uniformly random
 * position. This is the adversarial case for tree-shaped CRDTs: no
 * locality at all, so index-lookup cost (driven by tree depth) dominates.
 * We also record Weave's `doc.stats().maxDepth` at each size, since
 * that is the structural number this workload is specifically designed to
 * stress.
 */

import { formatNumber, markdownTable, ratio, timeSync, throughput, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, randomInsert } from "../traces.js";
import type { Subject } from "../subjects.js";

export const id = "random-position-insert";
export const title = "2. Random-position insert (adversarial)";

interface Row {
  size: number;
  perSubject: Record<string, { opsPerSec: number; nsPerOp: number }>;
  weaveMaxDepth: number | null;
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const sizes = ctx.quick ? [200, 1000, 4000] : [1000, 10_000, 100_000, 200_000];
  const rows: Row[] = [];

  for (const size of sizes) {
    const perSubject: Row["perSubject"] = {};
    let weaveMaxDepth: number | null = null;
    for (const subject of ctx.subjects) {
      const ops = randomInsert(size, mulberry32(ctx.seed));
      const doc = subject.createDoc("solo");
      const { ms } = timeSync(() => {
        for (const op of ops) {
          if (op.type === "insert") doc.insert(op.index, op.text);
          else doc.delete(op.index, op.count);
        }
      });
      perSubject[subject.id] = throughput(ops.length, ms);
      if (subject.id === "weave") {
        const stats = doc.stats();
        weaveMaxDepth = stats ? stats.maxDepth : null;
      }
    }
    rows.push({ size, perSubject, weaveMaxDepth });
  }

  const yjsSubject = ctx.subjects.find((s: Subject) => s.id === "yjs");
  const weaveSubject = ctx.subjects.find((s: Subject) => s.id === "weave");

  const headers = [
    "Size (chars)",
    ...ctx.subjects.flatMap((s) => [`${s.label} ops/sec`, `${s.label} ns/op`]),
    "Ratio ns/op (Weave / Yjs)",
  ];
  const tableRows = rows.map((row) => {
    const cells = ctx.subjects.flatMap((s) => {
      const r = row.perSubject[s.id];
      return [formatNumber(r?.opsPerSec ?? Number.NaN, 0), formatNumber(r?.nsPerOp ?? Number.NaN, 1)];
    });
    let ratioCell = "n/a";
    if (yjsSubject && weaveSubject) {
      const cNsPerOp = row.perSubject[weaveSubject.id]?.nsPerOp ?? Number.NaN;
      const yNsPerOp = row.perSubject[yjsSubject.id]?.nsPerOp ?? Number.NaN;
      ratioCell = ratio(cNsPerOp, yNsPerOp);
    }
    return [String(row.size), ...cells, ratioCell];
  });

  const depthHeaders = ["Size (chars)", "Weave maxDepth"];
  const depthRows = rows.map((row) => [String(row.size), row.weaveMaxDepth === null ? "n/a" : String(row.weaveMaxDepth)]);

  const markdown = [
    `### ${title}`,
    "",
    "Uniformly random insert position at every step. Ratio column is ns/op so >1.0x always means Weave is slower.",
    "",
    markdownTable(headers, tableRows),
    "",
    "Tree depth is what index-lookup cost is a function of; this is the number this workload is designed to stress.",
    "",
    markdownTable(depthHeaders, depthRows),
  ].join("\n");

  return { id, title, status: "ok", markdown, data: { sizes, rows } };
}
