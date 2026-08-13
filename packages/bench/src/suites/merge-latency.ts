/**
 * Suite 3 — merge latency.
 *
 * Replica A has N ops applied locally; replica B independently has M ops
 * applied locally. We measure the time to `applyUpdate` B's full batch
 * into A. Swept two ways, independently:
 *   - latency vs document size N, with M (concurrent op count) held fixed
 *   - latency vs concurrent op count M, with N held fixed
 *
 * Each measurement rebuilds replica A from scratch every repetition: since
 * applyUpdate is idempotent, re-applying the same bytes to an already-merged
 * A would measure a fast no-op, not a real merge.
 */

import { markdownTable, mean, ratio, timeSync, formatNumber, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { concurrentRuns, mulberry32, sequentialTyping } from "../traces.js";
import type { Subject } from "../subjects.js";

export const id = "merge-latency";
export const title = "3. Merge latency";

function measure(subject: Subject, n: number, m: number, repeats: number, seed: number): number {
  // B's batch is fixed across repetitions — only A is rebuilt each time.
  const bOps = sequentialTyping(m, mulberry32(seed + 1));
  const bDoc = subject.createDoc("B");
  for (const op of bOps) {
    if (op.type === "insert") bDoc.insert(op.index, op.text);
    else bDoc.delete(op.index, op.count);
  }
  const batch = bDoc.encodeFull();

  const samples: number[] = [];
  for (let rep = 0; rep < repeats; rep++) {
    const aOps = sequentialTyping(n, mulberry32(seed));
    const aDoc = subject.createDoc("A");
    for (const op of aOps) {
      if (op.type === "insert") aDoc.insert(op.index, op.text);
      else aDoc.delete(op.index, op.count);
    }
    const { ms } = timeSync(() => aDoc.applyUpdate(batch));
    samples.push(ms);
  }
  return mean(samples);
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const nSizes = ctx.quick ? [200, 1000, 4000] : [1000, 10_000, 100_000, 200_000];
  const mFixed = ctx.quick ? 50 : 200;
  const mSizes = ctx.quick ? [10, 50, 200] : [10, 100, 1000, 10_000];
  const nFixed = ctx.quick ? 500 : 10_000;
  const repeats = ctx.quick ? 2 : 5;

  const byDocSize: { n: number; perSubject: Record<string, number> }[] = [];
  for (const n of nSizes) {
    const perSubject: Record<string, number> = {};
    for (const subject of ctx.subjects) {
      perSubject[subject.id] = measure(subject, n, mFixed, repeats, ctx.seed);
    }
    byDocSize.push({ n, perSubject });
  }

  const byConcurrentOps: { m: number; perSubject: Record<string, number> }[] = [];
  for (const m of mSizes) {
    const perSubject: Record<string, number> = {};
    for (const subject of ctx.subjects) {
      perSubject[subject.id] = measure(subject, nFixed, m, repeats, ctx.seed);
    }
    byConcurrentOps.push({ m, perSubject });
  }

  const yjsSubject = ctx.subjects.find((s: Subject) => s.id === "yjs");
  const weaveSubject = ctx.subjects.find((s: Subject) => s.id === "weave");

  function renderTable(
    varyingLabel: string,
    fixedNote: string,
    rows: { key: number; perSubject: Record<string, number> }[],
  ): string {
    const headers = [varyingLabel, ...ctx.subjects.map((s) => `${s.label} ms`), "Ratio ms (Weave / Yjs)"];
    const tableRows = rows.map((row) => {
      const cells = ctx.subjects.map((s) => formatNumber(row.perSubject[s.id] ?? Number.NaN, 3));
      let ratioCell = "n/a";
      if (yjsSubject && weaveSubject) {
        ratioCell = ratio(row.perSubject[weaveSubject.id] ?? Number.NaN, row.perSubject[yjsSubject.id] ?? Number.NaN);
      }
      return [String(row.key), ...cells, ratioCell];
    });
    return [fixedNote, "", markdownTable(headers, tableRows)].join("\n");
  }

  // Bonus third curve: an R-way concurrent merge using traces.concurrentRuns
  // (every replica types a distinct word at the same position, none of them
  // having seen any of the others). Not one of the two required N/M curves,
  // but concurrentRuns exists specifically for this shape of scenario and
  // "cost of merging R simultaneous writers" is a real, distinct question
  // from "cost of merging one big batch".
  const replicaCounts = ctx.quick ? [2, 4, 8] : [2, 4, 8, 16, 32];
  const wordLength = ctx.quick ? 10 : 20;
  const byReplicaCount: { r: number; perSubject: Record<string, number> }[] = [];
  for (const r of replicaCounts) {
    const perSubject: Record<string, number> = {};
    for (const subject of ctx.subjects) {
      const runs = concurrentRuns(r, wordLength, mulberry32(ctx.seed));
      const samples: number[] = [];
      for (let rep = 0; rep < repeats; rep++) {
        const batches = runs.map((ops, i) => {
          const replicaDoc = subject.createDoc(`concurrent-${i}`);
          for (const op of ops) {
            if (op.type === "insert") replicaDoc.insert(op.index, op.text);
            else replicaDoc.delete(op.index, op.count);
          }
          return replicaDoc.encodeFull();
        });
        const target = subject.createDoc("concurrent-target");
        const { ms } = timeSync(() => {
          for (const batch of batches) target.applyUpdate(batch);
        });
        samples.push(ms);
        if (target.length !== r * wordLength) {
          throw new Error(
            `concurrent merge sanity check failed for ${subject.label} at R=${r}: expected ${r * wordLength} chars, got ${target.length}`,
          );
        }
      }
      perSubject[subject.id] = mean(samples);
    }
    byReplicaCount.push({ r, perSubject });
  }
  const table3 = renderTable(
    "Concurrent replicas R",
    `**Latency vs concurrent replica count** — R replicas each type a distinct ${wordLength}-char word at position 0, none having seen the others; merged pairwise into one target. Mean of ${repeats} rebuilds.`,
    byReplicaCount.map((row) => ({ key: row.r, perSubject: row.perSubject })),
  );

  const table1 = renderTable(
    "Doc size N (chars)",
    `**Latency vs document size** — B's concurrent batch fixed at M = ${mFixed} ops. Mean of ${repeats} rebuilds.`,
    byDocSize.map((r) => ({ key: r.n, perSubject: r.perSubject })),
  );
  const table2 = renderTable(
    "Concurrent ops M",
    `**Latency vs concurrent op count** — replica A's doc size fixed at N = ${nFixed} chars. Mean of ${repeats} rebuilds.`,
    byConcurrentOps.map((r) => ({ key: r.m, perSubject: r.perSubject })),
  );

  const markdown = [`### ${title}`, "", table1, "", table2, "", table3].join("\n");

  return {
    id,
    title,
    status: "ok",
    markdown,
    data: { nFixed, mFixed, repeats, byDocSize, byConcurrentOps, byReplicaCount },
  };
}
