/**
 * Suite 8 — degradation point.
 *
 * Grows each doc geometrically and, at every checkpoint size, measures the
 * latency of a small batch of random-position inserts at that size.
 * Reports the checkpoint size at which mean insert latency first exceeds
 * 1ms — this is the direct answer to "the document size where performance
 * degrades". A subject that never crosses 1ms within the sweep cap is
 * reported as such rather than extrapolated.
 *
 * Two precautions against a single outlier deciding the answer:
 *   1. Each subject is warmed up first with a throwaway ~2000-char doc
 *      (random-position inserts, timings discarded) before the timed sweep
 *      starts, so a JIT-compile pause doesn't land on the first checkpoint.
 *      Every subject gets identical treatment.
 *   2. At each checkpoint the first 20% of samples are discarded before
 *      computing statistics, and mean/median/p99 are all reported (not
 *      just the mean that decides the threshold), so a lingering outlier
 *      is visible in the table instead of silently deciding the result.
 */

import {
  formatNumber,
  markdownTable,
  mean,
  median,
  quantile,
  timeSync,
  type SuiteContext,
  type SuiteOutcome,
} from "../harness.js";
import { mulberry32, type PRNG } from "../traces.js";
import type { Subject, SubjectDoc } from "../subjects.js";

export const id = "degradation-point";
export const title = "8. Degradation point (mean insert latency > 1ms)";

const THRESHOLD_MS = 1.0;
const WARMUP_CHARS = 2000;
const DISCARD_FRACTION = 0.2;

interface CheckpointStats {
  mean: number;
  median: number;
  p99: number;
}

function checkpointSizes(quick: boolean): number[] {
  const cap = quick ? 6400 : 512_000;
  const start = quick ? 200 : 1000;
  const sizes: number[] = [];
  let size = start;
  while (size <= cap) {
    sizes.push(size);
    size *= 2;
  }
  return sizes;
}

function randChar(rng: PRNG): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  return alphabet[Math.floor(rng() * alphabet.length)] as string;
}

/** Inserts `count` chars, growing `doc` from its current length to
 * `targetLength`, at uniformly random positions. */
function growTo(doc: SubjectDoc, targetLength: number, rng: PRNG): void {
  while (doc.length < targetLength) {
    const index = doc.length === 0 ? 0 : Math.floor(rng() * (doc.length + 1));
    doc.insert(index, randChar(rng));
  }
}

/** Times `samples` single-char random-position inserts at the doc's current
 * size, in order. Mutates the doc (each sample insert grows it by one
 * char), which is fine — checkpoint sizes are far enough apart that
 * `samples` extra chars don't materially change "the size we measured at". */
function sampleInsertLatenciesMs(doc: SubjectDoc, samples: number, rng: PRNG): number[] {
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const index = doc.length === 0 ? 0 : Math.floor(rng() * (doc.length + 1));
    const text = randChar(rng);
    const { ms } = timeSync(() => doc.insert(index, text));
    times.push(ms);
  }
  return times;
}

/** Discards the chronologically first `DISCARD_FRACTION` of `times` (not
 * the smallest values — the point is dropping early-sample warm-up noise
 * within this checkpoint, not cherry-picking low numbers), then computes
 * mean/median/p99 over what's left. */
function trimmedStats(times: readonly number[]): CheckpointStats {
  const discardCount = Math.floor(times.length * DISCARD_FRACTION);
  const trimmed = times.slice(discardCount);
  return {
    mean: mean(trimmed),
    median: median(trimmed),
    p99: quantile(trimmed, 0.99),
  };
}

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const sizes = checkpointSizes(ctx.quick);
  const samplesPerCheckpoint = ctx.quick ? 10 : 30;

  const statsBySubjectAndSize: Record<string, Record<number, CheckpointStats | null>> = {};
  const degradationPoint: Record<string, { size: number | null; meanMs: number | null }> = {};

  for (const subject of ctx.subjects) {
    // Warm-up: build a throwaway doc first so the JIT/allocator have already
    // settled before any timed checkpoint. Same size, same op shape, same
    // treatment for every subject — discarded entirely, no timings kept.
    growTo(subject.createDoc("warmup"), WARMUP_CHARS, mulberry32(ctx.seed + 1));

    const rng = mulberry32(ctx.seed);
    const doc = subject.createDoc("grower");
    statsBySubjectAndSize[subject.id] = {};
    degradationPoint[subject.id] = { size: null, meanMs: null };

    for (const size of sizes) {
      growTo(doc, size, rng);
      const times = sampleInsertLatenciesMs(doc, samplesPerCheckpoint, rng);
      const stats = trimmedStats(times);
      statsBySubjectAndSize[subject.id]![size] = stats;

      if (degradationPoint[subject.id]!.size === null && stats.mean > THRESHOLD_MS) {
        degradationPoint[subject.id] = { size, meanMs: stats.mean };
        break;
      }
    }
  }

  const summaryHeaders = [
    "Subject",
    `Degradation point (size where mean insert > ${THRESHOLD_MS}ms)`,
    "Mean latency at that size (ms)",
  ];
  const summaryRows = ctx.subjects.map((s: Subject) => {
    const dp = degradationPoint[s.id]!;
    return [
      s.label,
      dp.size === null ? `not reached within sweep cap` : String(dp.size),
      dp.meanMs === null ? "—" : formatNumber(dp.meanMs, 4),
    ];
  });

  function detailTable(statLabel: string, pick: (s: CheckpointStats) => number): string {
    const headers = ["Size (chars)", ...ctx.subjects.map((s) => `${s.label} ${statLabel} ms`)];
    const rows = sizes.map((size) => [
      String(size),
      ...ctx.subjects.map((s) => {
        const stats = statsBySubjectAndSize[s.id]?.[size];
        return stats ? formatNumber(pick(stats), 4) : "—";
      }),
    ]);
    return markdownTable(headers, rows);
  }

  const markdown = [
    `### ${title}`,
    "",
    `Each subject is warmed up first with a throwaway ${WARMUP_CHARS}-char doc (random-position inserts, timings discarded), then grows a single doc geometrically (${sizes[0]} to ${sizes[sizes.length - 1]!} chars). At each checkpoint ${samplesPerCheckpoint} inserts are timed and the chronologically first ${Math.round(DISCARD_FRACTION * 100)}% are discarded before computing mean/median/p99. A subject stops growing once its mean crosses the threshold; later cells for that subject read "—".`,
    "",
    markdownTable(summaryHeaders, summaryRows),
    "",
    "**Mean latency by checkpoint (ms)**",
    "",
    detailTable("mean", (s) => s.mean),
    "",
    "**Median latency by checkpoint (ms)**",
    "",
    detailTable("median", (s) => s.median),
    "",
    "**p99 latency by checkpoint (ms)**",
    "",
    detailTable("p99", (s) => s.p99),
  ].join("\n");

  return {
    id,
    title,
    status: "ok",
    markdown,
    data: { sizes, samplesPerCheckpoint, discardFraction: DISCARD_FRACTION, warmupChars: WARMUP_CHARS, statsBySubjectAndSize, degradationPoint },
  };
}
