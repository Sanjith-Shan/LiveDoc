/**
 * harness.ts — timing, memory, and reporting utilities shared by every suite.
 *
 * Nothing in this file knows about Weave, Yjs, or Automerge. It only
 * knows how to time a function, measure retained heap, compute summary
 * statistics over a sample, and render markdown tables. Keeping it subject-
 * agnostic means it never needs `@weave/core` and therefore never fails
 * to import, even before that package exists on disk.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import type { Subject } from "./subjects.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Suite plumbing — shared shapes every suites/*.ts module produces/consumes
// ---------------------------------------------------------------------------

export interface SuiteContext {
  readonly subjects: readonly Subject[];
  /** --quick: use much smaller sizes/repeat counts so a full run finishes fast. */
  readonly quick: boolean;
  readonly seed: number;
}

export interface SuiteOutcome {
  readonly id: string;
  readonly title: string;
  readonly status: "ok" | "not run";
  /** Ready-to-print markdown: heading, prose, table(s). */
  readonly markdown: string;
  /** Structured numbers, for the JSON results file. */
  readonly data?: unknown;
  /** Present when status is "not run". */
  readonly error?: string;
}

export type SuiteModule = {
  readonly id: string;
  readonly title: string;
  run(ctx: SuiteContext): Promise<SuiteOutcome>;
};

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** High-resolution monotonic timestamp, nanoseconds. */
export function nowNs(): bigint {
  return process.hrtime.bigint();
}

/** Milliseconds elapsed since `startNs`. */
export function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

/** Times a synchronous function once. Returns its result and elapsed ms. */
export function timeSync<T>(fn: () => T): { result: T; ms: number } {
  const start = nowNs();
  const result = fn();
  const ms = elapsedMs(start);
  return { result, ms };
}

/** ops/sec and ns/op for `opsCount` operations that took `ms` milliseconds. */
export function throughput(
  opsCount: number,
  ms: number,
): { opsPerSec: number; nsPerOp: number } {
  const seconds = ms / 1000;
  const opsPerSec = seconds > 0 ? opsCount / seconds : Number.POSITIVE_INFINITY;
  const nsPerOp = opsCount > 0 ? (ms * 1e6) / opsCount : Number.NaN;
  return { opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Summary statistics (used by merge-latency, degradation-point)
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx] as number;
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function gcAvailable(): boolean {
  return typeof (global as { gc?: () => void }).gc === "function";
}

export function forceGC(): void {
  const gc = (global as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    throw new Error(
      "global.gc is not available. Run node with --expose-gc (run.ts re-execs itself with this flag automatically).",
    );
  }
  gc();
}

/**
 * If --expose-gc was not passed, re-exec the current script (via `tsx`, so
 * TypeScript keeps working) with it set, then exit this process. Every
 * memory-sensitive suite depends on `global.gc` being real, not a no-op.
 */
export function ensureExposeGCOrReexec(): void {
  if (gcAvailable()) return;
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Cannot determine script path to re-exec with --expose-gc.");
  }
  const rest = process.argv.slice(2);
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", scriptPath, ...rest],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error("Failed to re-exec with --expose-gc:", result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/**
 * Measures heap bytes retained by one call to `build()`.
 *
 * Runs `warmIterations` throwaway builds first (lets the allocator and JIT
 * settle and discards their garbage), forces a GC, snapshots heapUsed, runs
 * `build()` one more time while *keeping* the result alive so it cannot be
 * collected, forces GC again, and reports the delta. The kept object is
 * returned so callers can also inspect it (e.g. call `.stats()` on it)
 * without doing a second, differently-measured build.
 */
export function measureRetainedBytes<T>(
  build: () => T,
  opts: { warmIterations?: number } = {},
): { bytes: number; heapUsedBefore: number; heapUsedAfter: number; kept: T } {
  const warmIterations = opts.warmIterations ?? 3;
  for (let i = 0; i < warmIterations; i++) {
    build();
  }
  forceGC();
  const heapUsedBefore = process.memoryUsage().heapUsed;
  const kept = build();
  forceGC();
  const heapUsedAfter = process.memoryUsage().heapUsed;
  return {
    bytes: Math.max(0, heapUsedAfter - heapUsedBefore),
    heapUsedBefore,
    heapUsedAfter,
    kept,
  };
}

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

export interface SystemInfo {
  cpu: string;
  arch: string;
  node: string;
  yjsVersion: string;
  automergeVersion: string;
  date: string;
}

/**
 * Reads a dependency's version from its package.json. Deliberately does NOT
 * do `require(pkgName + "/package.json")` — some packages (e.g.
 * @automerge/automerge) declare an `exports` map that doesn't expose
 * `./package.json`, which makes that throw even though the file is right
 * there on disk. Instead: resolve the package's real entry file, then walk
 * up directories doing a plain `fs.readFileSync` until we find the
 * package.json that owns it (matched by `name`), which sidesteps the
 * exports map entirely since we're never asking Node's resolver for the
 * subpath.
 */
function readDepVersion(pkgName: string): string {
  try {
    const entry = require.resolve(pkgName);
    let dir = dirname(entry);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === pkgName && pkg.version) return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "unknown (package.json not found)";
  } catch {
    return "unknown (failed to resolve)";
  }
}

export function systemInfo(): SystemInfo {
  const cpus = os.cpus();
  const cpu = cpus.length > 0 ? (cpus[0] as os.CpuInfo).model : "unknown";
  return {
    cpu,
    arch: os.arch(),
    node: process.version,
    yjsVersion: readDepVersion("yjs"),
    automergeVersion: readDepVersion("@automerge/automerge"),
    date: new Date().toISOString(),
  };
}

export function formatSystemInfo(info: SystemInfo): string {
  return [
    `- **CPU**: ${info.cpu}`,
    `- **Arch**: ${info.arch}`,
    `- **Node**: ${info.node}`,
    `- **yjs**: ${info.yjsVersion}`,
    `- **@automerge/automerge**: ${info.automergeVersion}`,
    `- **Date**: ${info.date}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.round(n).toLocaleString("en-US");
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unitIdx = 0;
  while (Math.abs(value) >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${formatNumber(value, 2)} ${units[unitIdx]}`;
}

/** Weave/Yjs style ratio: > 1.0 always means Weave is worse. */
export function ratio(weaveValue: number, otherValue: number): string {
  if (otherValue === 0) return "n/a";
  if (!Number.isFinite(weaveValue) || !Number.isFinite(otherValue)) return "n/a";
  return `${formatNumber(weaveValue / otherValue, 2)}x`;
}

/** Renders a markdown table from headers + rows (rows are already strings). */
export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

export const HONESTY_BLOCK = `## Honesty

- Losing to Yjs is expected — it is years of specialist optimisation.
- These are single-process Node benchmarks on one machine, not a distributed measurement.
- Any suite that did not complete is listed as "not run" rather than omitted.
- Where a measurement lands below the resolution of its instrument (e.g. a
  heapUsed delta that rounds to exactly 0 bytes), we print "below
  measurement resolution" rather than a 0 that would read as a finding.
- Suite 7 (wire size) reports two different numbers on purpose: per-transaction
  update bytes (the headline — what a real provider actually sends) and a
  per-keystroke state-vector diff (a second table, clearly labelled as not
  what a provider sends). They disagree, and the disagreement is itself part
  of the finding — see that suite's own notes.
- Suite 8 (degradation point) warms up every subject with an identical
  throwaway doc before timing anything, and discards the first 20% of each
  checkpoint's samples, so a JIT-compile outlier on the first measurement
  can't decide the answer by itself. Mean, median, and p99 are all reported
  per checkpoint so a remaining outlier stays visible instead of hidden
  inside a single averaged number.
`;
