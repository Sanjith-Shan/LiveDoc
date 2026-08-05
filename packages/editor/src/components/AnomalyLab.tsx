import { useEffect, useMemo, useState } from "react";
import { Doc, createDoc } from "@weave/core";
import type { Algorithm, AnyDoc, DocStats, TreeNodeJSON } from "@weave/core";

/**
 * Logoot's interleaving is genuinely random, so the demonstration is seeded.
 * Without this the panel says something different on every render, which reads
 * as flakiness rather than as the point being made.
 */
const SEED = 12345;

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
import { TreeView } from "./TreeView";
import { colorForIndex } from "../lib/colors";

type Direction = "forward" | "backward";
type Tag = "A" | "B";

interface AttributedResult {
  merged: string;
  tags: Tag[];
  verdict: "clean" | "interleaved";
}

/** Types a word into `doc` either left-to-right (append) or right-to-left (repeated prepend). */
function typeWord(doc: AnyDoc, word: string, direction: Direction): void {
  if (direction === "forward") {
    for (let i = 0; i < word.length; i++) doc.insert(i, word.charAt(i));
  } else {
    const reversed = Array.from(word).reverse();
    for (const ch of reversed) doc.insert(0, ch);
  }
}

/**
 * Runs the classic interleaving scenario for one algorithm and reports, for
 * every character in the merged result, which replica wrote it.
 *
 * Attribution comes from `authors()`. Deriving it by replaying the
 * ChangeEvent/TextDelta stream does not work here: an interleaved merge is not
 * a contiguous edit, so a delta-based attribution paints the whole shuffled
 * region a single colour and hides the exact thing this panel exists to show.
 */
function runScenario(algorithm: Algorithm, wordA: string, wordB: string, direction: Direction): AttributedResult {
  const docA = createDoc(algorithm, "replA", seededRandom(SEED));
  const docB = createDoc(algorithm, "replB", seededRandom(SEED + 1));
  typeWord(docA, wordA, direction);
  typeWord(docB, wordB, direction);
  docB.applyUpdate(docA.encodeStateAsUpdate());

  const merged = docB.toString();
  const tags: Tag[] = docB.authors().map((r): Tag => (r === "replA" ? "A" : "B"));

  let transitions = 0;
  for (let i = 1; i < tags.length; i++) {
    if (tags[i] !== tags[i - 1]) transitions++;
  }
  const verdict: AttributedResult["verdict"] = transitions <= 1 ? "clean" : "interleaved";
  return { merged, tags, verdict };
}

const ALGORITHMS: Algorithm[] = ["fugue", "rga", "logoot"];
const ALGO_LABEL: Record<Algorithm, string> = { fugue: "Fugue", rga: "RGA", logoot: "Logoot" };
const ALGO_COLOR: Record<Algorithm, string> = { fugue: colorForIndex(0), rga: colorForIndex(1), logoot: colorForIndex(2) };
const TAG_COLOR: Record<Tag, string> = { A: colorForIndex(0), B: colorForIndex(1) };

export interface AnomalyLabProps {
  /** The Fugue doc backing the live tree view — pane A from the Collaborate tab. */
  sourceDoc: InstanceType<typeof Doc>;
}

export function AnomalyLab({ sourceDoc }: AnomalyLabProps) {
  const [enabled, setEnabled] = useState<Record<Algorithm, boolean>>({ fugue: true, rga: true, logoot: true });
  const [scenario, setScenario] = useState<Direction>("forward");
  const wordA = "hello";
  const wordB = "world";

  const results = useMemo(() => {
    const out = {} as Record<Algorithm, AttributedResult>;
    for (const alg of ALGORITHMS) out[alg] = runScenario(alg, wordA, wordB, scenario);
    return out;
  }, [scenario]);

  const [tree, setTree] = useState<TreeNodeJSON | null>(null);
  const [stats, setStats] = useState<DocStats | null>(null);

  useEffect(() => {
    const refresh = () => {
      setTree(sourceDoc.treeJSON());
      setStats(sourceDoc.stats());
    };
    refresh();
    return sourceDoc.on("change", refresh);
  }, [sourceDoc]);

  return (
    <div className="anomaly-lab">
      <div className="anomaly-toolbar">
        <div className="algo-filter">
          {ALGORITHMS.map((alg) => (
            <button
              key={alg}
              type="button"
              className={`algo-chip ${enabled[alg] ? "algo-chip-active" : ""}`}
              style={{ borderColor: ALGO_COLOR[alg] }}
              onClick={() => setEnabled((prev) => ({ ...prev, [alg]: !prev[alg] }))}
            >
              <span className="algo-chip-dot" style={{ background: ALGO_COLOR[alg] }} />
              {ALGO_LABEL[alg]}
            </button>
          ))}
        </div>
        <div className="scenario-buttons">
          <button
            type="button"
            className={`primary-btn ${scenario === "forward" ? "primary-btn-active" : ""}`}
            onClick={() => setScenario("forward")}
          >
            Forward interleaving
          </button>
          <button
            type="button"
            className={`primary-btn ${scenario === "backward" ? "primary-btn-active" : ""}`}
            onClick={() => setScenario("backward")}
          >
            Backward interleaving
          </button>
        </div>
      </div>

      <div className="anomaly-reference">
        clean reference: <code>{wordA + wordB}</code> or <code>{wordB + wordA}</code> — either is a valid unbroken merge
      </div>

      <div className="anomaly-results">
        {ALGORITHMS.filter((a) => enabled[a]).map((alg) => {
          const r = results[alg];
          return (
            <div key={alg} className="anomaly-row">
              <div className="anomaly-row-head">
                <span className="anomaly-algo" style={{ color: ALGO_COLOR[alg] }}>
                  {ALGO_LABEL[alg]}
                </span>
                <span className={`verdict-chip verdict-${r.verdict}`}>{r.verdict}</span>
              </div>
              <div className="anomaly-chars">
                {Array.from(r.merged).map((ch, i) => (
                  <span key={i} className="anomaly-char" style={{ color: TAG_COLOR[r.tags[i] ?? "B"] }}>
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <p className="anomaly-caption">
        Two replicas concurrently insert &ldquo;{wordA}&rdquo; and &ldquo;{wordB}&rdquo; at the same position with no
        coordination between them, then merge. Fugue keeps each replica&rsquo;s run of characters intact because it
        orders concurrent insertions by where they branched from, not by raw position, while RGA and Logoot can
        splice the two runs together character by character. The colors below trace exactly which replica
        contributed each character of the final, converged string.
      </p>

      {stats && (
        <div className="doc-stats">
          <span>chars {stats.chars}</span>
          <span>tombstoned {stats.tombstoned}</span>
          <span>nodes {stats.nodes}</span>
          <span>skeleton {stats.skeletonNodes}</span>
          <span>depth {stats.maxDepth}</span>
          <span>chars/node {stats.charsPerNode.toFixed(2)}</span>
          <span>bytes {stats.bytes}</span>
          <span>marks {stats.marks}</span>
        </div>
      )}

      <TreeView root={tree} />
    </div>
  );
}
