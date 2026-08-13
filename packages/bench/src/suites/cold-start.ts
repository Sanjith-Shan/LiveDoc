/**
 * Suite 6 — cold start / offline sync.
 *
 * A fresh replica that missed N operations joins: how long does applying
 * the catch-up update take, and how big is that update on the wire? This
 * is the same code path as a partition heal per docs/API_CONTRACT.md — a
 * client that reconnects after being offline exchanges state vectors and
 * receives exactly this kind of "everything since the beginning" update.
 */

import { formatBytes, formatNumber, markdownTable, ratio, timeSync, type SuiteContext, type SuiteOutcome } from "../harness.js";
import { mulberry32, sequentialTyping } from "../traces.js";
import type { Subject } from "../subjects.js";

export const id = "cold-start";
export const title = "6. Cold start / offline sync";

export async function run(ctx: SuiteContext): Promise<SuiteOutcome> {
  const sizes = ctx.quick ? [200, 1000, 4000] : [1000, 10_000, 100_000];

  const rows: { n: number; perSubject: Record<string, { ms: number; bytes: number }> }[] = [];

  for (const n of sizes) {
    const perSubject: (typeof rows)[number]["perSubject"] = {};
    for (const subject of ctx.subjects) {
      const source = subject.createDoc("source");
      const ops = sequentialTyping(n, mulberry32(ctx.seed));
      for (const op of ops) {
        if (op.type === "insert") source.insert(op.index, op.text);
        else source.delete(op.index, op.count);
      }
      const update = source.encodeFull();

      const fresh = subject.createDoc("fresh-peer");
      const { ms } = timeSync(() => fresh.applyUpdate(update));

      if (fresh.toString() !== source.toString()) {
        throw new Error(
          `cold-start sanity check failed for ${subject.label} at N=${n}: catch-up update did not reproduce source content`,
        );
      }

      perSubject[subject.id] = { ms, bytes: update.byteLength };
    }
    rows.push({ n, perSubject });
  }

  const yjsSubject = ctx.subjects.find((s: Subject) => s.id === "yjs");
  const weaveSubject = ctx.subjects.find((s: Subject) => s.id === "weave");

  const headers = [
    "Missed ops (N)",
    ...ctx.subjects.flatMap((s) => [`${s.label} ms`, `${s.label} bytes`]),
    "Ratio ms (Weave / Yjs)",
    "Ratio bytes (Weave / Yjs)",
  ];
  const tableRows = rows.map((row) => {
    const cells = ctx.subjects.flatMap((s) => {
      const r = row.perSubject[s.id];
      return [formatNumber(r?.ms ?? Number.NaN, 3), formatBytes(r?.bytes ?? Number.NaN)];
    });
    let msRatio = "n/a";
    let bytesRatio = "n/a";
    if (yjsSubject && weaveSubject) {
      msRatio = ratio(row.perSubject[weaveSubject.id]?.ms ?? Number.NaN, row.perSubject[yjsSubject.id]?.ms ?? Number.NaN);
      bytesRatio = ratio(
        row.perSubject[weaveSubject.id]?.bytes ?? Number.NaN,
        row.perSubject[yjsSubject.id]?.bytes ?? Number.NaN,
      );
    }
    return [String(row.n), ...cells, msRatio, bytesRatio];
  });

  const markdown = [
    `### ${title}`,
    "",
    "Fresh, empty replica applying one catch-up update covering N missed ops.",
    "",
    markdownTable(headers, tableRows),
  ].join("\n");

  return { id, title, status: "ok", markdown, data: { sizes, rows } };
}
