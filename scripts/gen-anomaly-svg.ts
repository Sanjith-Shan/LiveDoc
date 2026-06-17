/**
 * Generates assets/interleaving.svg from a real run of all three algorithms.
 *
 * Nothing here is drawn by hand: the strings and the per-character attribution
 * come out of the engine, so the picture in the README cannot drift away from
 * what the code actually does. Re-run with `npm run assets`.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoc, type Algorithm, type AnyDoc } from "@weave/core";

type Direction = "forward" | "backward";
type Tag = "A" | "B";

const WORD_A = "hello";
const WORD_B = "world";

function type(doc: AnyDoc, index: number, word: string, dir: Direction): void {
  if (dir === "forward") for (let i = 0; i < word.length; i++) doc.insert(index + i, word[i]!);
  else for (let i = word.length - 1; i >= 0; i--) doc.insert(index, word[i]!);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed, so the picture in the README is the same every time it is built. */
const SEED = 12345;

/**
 * Runs the scenario and returns the merged text with one tag per character.
 *
 * Attribution comes from `authors()`, which reports the replica that wrote
 * each visible character. Deriving it by diffing the text before and after the
 * merge does not work: an interleaved merge is not a contiguous edit, so a
 * diff attributes the whole shuffled region to one replica and hides exactly
 * the thing the picture exists to show.
 */
function run(algorithm: Algorithm, dir: Direction): { text: string; tags: Tag[] } {
  const a = createDoc(algorithm, "alice", mulberry32(SEED));
  const b = createDoc(algorithm, "bob", mulberry32(SEED + 1));

  a.insert(0, "[]");
  b.applyUpdate(a.encodeStateAsUpdate());
  type(a, 1, WORD_A, dir);
  type(b, 1, WORD_B, dir);
  b.applyUpdate(a.encodeStateAsUpdate());

  const text = b.toString();
  const tags = b.authors().map((r): Tag => (r === "alice" ? "A" : "B"));
  return { text, tags };
}

const contiguous = (s: string) => s.includes(WORD_A) && s.includes(WORD_B);

const ALGOS: { key: Algorithm; label: string; note: string }[] = [
  { key: "logoot", label: "Logoot", note: "random position ids" },
  { key: "rga", label: "RGA", note: "origin + timestamp" },
  { key: "fugue", label: "Fugue", note: "this engine" },
];

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const CH = 15.5; // monospace advance at 26px
const PAD = 28;
const ROW_H = 74;
const COL_W = 340;
const HEADER = 96;

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  stroke: "#30363d",
  text: "#e6edf3",
  dim: "#8b949e",
  a: "#58a6ff",
  b: "#f0883e",
  good: "#3fb950",
  bad: "#f85149",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chars(text: string, tags: Tag[], x: number, y: number): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const fill = ch === "[" || ch === "]" ? C.dim : tags[i] === "A" ? C.a : C.b;
    out.push(
      `<text x="${(x + i * CH).toFixed(1)}" y="${y}" fill="${fill}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="26" font-weight="600">${esc(ch)}</text>`,
    );
  }
  return out.join("");
}

function chip(x: number, y: number, ok: boolean): string {
  const label = ok ? "contiguous" : "interleaved";
  const color = ok ? C.good : C.bad;
  const w = ok ? 86 : 90;
  return [
    `<rect x="${x}" y="${y - 12}" width="${w}" height="18" rx="9" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.5"/>`,
    `<text x="${x + w / 2}" y="${y + 1}" fill="${color}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="11" font-weight="600" text-anchor="middle">${label}</text>`,
  ].join("");
}

const width = PAD * 2 + COL_W * 2;
const height = HEADER + ROW_H * ALGOS.length + 24;

const parts: string[] = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Interleaving comparison across three sequence CRDTs">`,
  `<rect width="${width}" height="${height}" rx="10" fill="${C.bg}"/>`,
  `<text x="${PAD}" y="34" fill="${C.text}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="15" font-weight="700">Two people type at the same position at the same time</text>`,
  `<text x="${PAD}" y="55" fill="${C.dim}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12.5">` +
    `<tspan fill="${C.a}" font-weight="600">alice types “hello”</tspan><tspan> · </tspan><tspan fill="${C.b}" font-weight="600">bob types “world”</tspan><tspan> · then they merge</tspan></text>`,
];

for (let c = 0; c < 2; c++) {
  const dir: Direction = c === 0 ? "forward" : "backward";
  const x = PAD + c * COL_W;
  parts.push(
    `<text x="${x}" y="${HEADER - 14}" fill="${C.dim}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="11" font-weight="700" letter-spacing="0.9">${dir === "forward" ? "TYPED LEFT TO RIGHT" : "TYPED RIGHT TO LEFT"}</text>`,
  );
}

ALGOS.forEach((algo, r) => {
  const y = HEADER + r * ROW_H;
  parts.push(
    `<rect x="${PAD - 14}" y="${y - 6}" width="${COL_W * 2 + 4}" height="${ROW_H - 12}" rx="8" fill="${C.panel}" stroke="${C.stroke}"/>`,
  );
  for (let c = 0; c < 2; c++) {
    const dir: Direction = c === 0 ? "forward" : "backward";
    const { text, tags } = run(algo.key, dir);
    const x = PAD + c * COL_W;
    if (c === 0) {
      parts.push(
        `<text x="${x}" y="${y + 16}" fill="${C.text}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="700">${algo.label}</text>`,
        `<text x="${x + algo.label.length * 7.6 + 10}" y="${y + 16}" fill="${C.dim}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="11">${algo.note}</text>`,
      );
    }
    parts.push(chars(text, tags, x, y + 44));
    parts.push(chip(x + 200, y + 12, contiguous(text)));
  }
});

parts.push(
  `<text x="${PAD}" y="${height - 8}" fill="${C.dim}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="11">Generated by scripts/gen-anomaly-svg.ts from a real merge. Colour is the replica that typed the character.</text>`,
  `</svg>`,
);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "assets", "interleaving.svg");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join("\n"));

for (const algo of ALGOS) {
  for (const dir of ["forward", "backward"] as const) {
    const { text } = run(algo.key, dir);
    process.stdout.write(`${algo.label.padEnd(7)} ${dir.padEnd(9)} ${text}  ${contiguous(text) ? "contiguous" : "INTERLEAVED"}\n`);
  }
}
process.stdout.write(`\nwrote ${out}\n`);
