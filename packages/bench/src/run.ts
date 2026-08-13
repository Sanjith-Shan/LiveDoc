#!/usr/bin/env -S node --import tsx
/**
 * run.ts — the bench CLI.
 *
 *   pnpm bench             full-size run
 *   pnpm bench:quick       tiny sizes, fast smoke run
 *   tsx src/run.ts --seed 7 --only wire-size
 *
 * Flow:
 *   1. Make sure global.gc is real (re-exec with --expose-gc if not — every
 *      memory suite depends on this).
 *   2. Import @weave/core. If that fails, print a clear message and
 *      exit 1 — we do NOT silently drop Weave from the comparison.
 *   3. Build all three Subjects, run every suite, printing markdown tables
 *      as they finish. A suite that throws is recorded as "not run", never
 *      omitted.
 *   4. Print the Honesty block, then write JSON + results/latest.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureExposeGCOrReexec,
  formatSystemInfo,
  HONESTY_BLOCK,
  systemInfo,
  type SuiteContext,
  type SuiteModule,
  type SuiteOutcome,
} from "./harness.js";
import { createAutomergeSubject, createWeaveSubject, createYjsSubject, type Subject } from "./subjects.js";

import * as localEditThroughput from "./suites/local-edit-throughput.js";
import * as randomPositionInsert from "./suites/random-position-insert.js";
import * as mergeLatency from "./suites/merge-latency.js";
import * as memory from "./suites/memory.js";
import * as tombstoneGc from "./suites/tombstone-gc.js";
import * as coldStart from "./suites/cold-start.js";
import * as wireSize from "./suites/wire-size.js";
import * as degradationPoint from "./suites/degradation-point.js";

ensureExposeGCOrReexec();

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "results");

interface CliArgs {
  quick: boolean;
  seed: number;
  only: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let quick = false;
  let seed = 42;
  let only: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quick") {
      quick = true;
    } else if (arg === "--seed") {
      const value = argv[++i];
      if (value !== undefined) seed = Number.parseInt(value, 10);
    } else if (arg?.startsWith("--seed=")) {
      seed = Number.parseInt(arg.slice("--seed=".length), 10);
    } else if (arg === "--only") {
      const value = argv[++i];
      if (value !== undefined) only = value;
    } else if (arg?.startsWith("--only=")) {
      only = arg.slice("--only=".length);
    }
  }

  if (!Number.isFinite(seed)) seed = 42;
  return { quick, seed, only };
}

const SUITES: SuiteModule[] = [
  localEditThroughput,
  randomPositionInsert,
  mergeLatency,
  memory,
  tombstoneGc,
  coldStart,
  wireSize,
  degradationPoint,
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let weaveSubject: Subject;
  try {
    weaveSubject = await createWeaveSubject();
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("=".repeat(78));
    console.error("FATAL: failed to import @weave/core.");
    console.error("");
    console.error("The bench harness requires @weave/core to be built (pnpm --filter");
    console.error("@weave/core build) and linked into the workspace (pnpm install at");
    console.error("the repo root) before it can run. This is expected if core hasn't been");
    console.error("implemented/built yet — the harness intentionally does not skip");
    console.error("Weave and benchmark Yjs/Automerge alone; the whole point is the");
    console.error("three-way comparison.");
    console.error("");
    console.error("Underlying error:");
    console.error(message);
    console.error("=".repeat(78));
    process.exit(1);
  }

  const info = systemInfo();
  const yjsSubject = createYjsSubject(info.yjsVersion);
  const automergeSubject = createAutomergeSubject(info.automergeVersion);
  const subjects: Subject[] = [weaveSubject, yjsSubject, automergeSubject];

  const ctx: SuiteContext = { subjects, quick: args.quick, seed: args.seed };

  const suitesToRun = args.only ? SUITES.filter((s) => s.id === args.only) : SUITES;
  if (args.only && suitesToRun.length === 0) {
    console.error(`No suite matches --only ${args.only}. Known suites: ${SUITES.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const outcomes: SuiteOutcome[] = [];
  for (const suite of suitesToRun) {
    process.stderr.write(`Running suite: ${suite.id}...\n`);
    try {
      const outcome = await suite.run(ctx);
      outcomes.push(outcome);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      outcomes.push({
        id: suite.id,
        title: suite.title,
        status: "not run",
        markdown: [`### ${suite.title}`, "", "**not run** — the suite threw an error:", "", "```", message, "```"].join("\n"),
        error: message,
      });
      process.stderr.write(`  -> not run: ${message.split("\n")[0]}\n`);
    }
  }

  const headerLines = [
    "# @weave/bench results",
    "",
    "## Machine / runtime",
    "",
    formatSystemInfo(info),
    "",
    `Seed: ${args.seed}${args.quick ? " (quick mode: reduced sizes)" : ""}`,
    "",
    "Every ratio in this report is printed as **Weave / Yjs**, so a number above 1.0 always means Weave is worse.",
    "",
  ];

  const bodyLines = outcomes.flatMap((o) => [o.markdown, ""]);

  const fullMarkdown = [...headerLines, ...bodyLines, HONESTY_BLOCK].join("\n");

  console.log(fullMarkdown);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `${timestamp}.json`);
  const latestMdPath = join(RESULTS_DIR, "latest.md");

  const jsonPayload = {
    generatedAt: new Date().toISOString(),
    systemInfo: info,
    args,
    outcomes: outcomes.map((o) => ({ id: o.id, title: o.title, status: o.status, data: o.data, error: o.error })),
  };

  writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf8");
  writeFileSync(latestMdPath, fullMarkdown, "utf8");

  process.stderr.write(`\nWrote ${jsonPath}\nWrote ${latestMdPath}\n`);

  const anyNotRun = outcomes.some((o) => o.status === "not run");
  if (anyNotRun) {
    process.stderr.write("\nOne or more suites did not complete (see \"not run\" entries above).\n");
  }
}

main().catch((err) => {
  console.error("FATAL: unhandled error in bench runner:");
  console.error(err);
  process.exit(1);
});
