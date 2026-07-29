import { useEffect, useState } from "react";
import type { Awareness, PeerState, ReplicaID } from "@weave/core";
import { getCaretCoordinates, getSelectionRects } from "../lib/caret";
import { withAlpha } from "../lib/colors";

export interface CursorsProps {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  awareness: InstanceType<typeof Awareness>;
  peers: PeerState[];
  selfReplica: ReplicaID;
  /** Not read directly — its identity change is what tells us to re-measure after remote edits. */
  text: string;
}

/**
 * Renders every remote peer's caret as a thin vertical bar with a name flag,
 * and their live selection as a translucent highlight, absolutely
 * positioned over the pane's textarea. Positions are recomputed from
 * `awareness.cursorIndices`, which resolves each peer's sticky anchor
 * against the *current* document — so cursors move on their own whenever
 * remote text changes upstream of them, exactly as Peritext-style anchors
 * are meant to.
 */
export function Cursors({ textareaRef, awareness, peers, selfReplica, text }: CursorsProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const bump = () => setTick((t) => t + 1);
    ta.addEventListener("scroll", bump);
    window.addEventListener("resize", bump);
    return () => {
      ta.removeEventListener("scroll", bump);
      window.removeEventListener("resize", bump);
    };
  }, [textareaRef]);

  const ta = textareaRef.current;
  if (!ta) return null;

  const others = peers.filter((p) => p.replica !== selfReplica);

  return (
    <div className="cursor-layer" aria-hidden="true" data-text-length={text.length}>
      {others.map((peer) => {
        const idx = awareness.cursorIndices(peer.replica);
        if (!idx) return null;
        const { anchor, head } = idx;
        const caret = getCaretCoordinates(ta, head);
        const rects = anchor !== head ? getSelectionRects(ta, anchor, head) : [];
        return (
          <div key={peer.replica}>
            {rects.map((r, i) => (
              <div
                key={i}
                className="cursor-selection"
                style={{ left: r.left, top: r.top, width: r.width, height: r.height, background: withAlpha(peer.color, 0.28) }}
              />
            ))}
            <div className="cursor-caret" style={{ left: caret.left, top: caret.top, height: caret.height, background: peer.color }}>
              <span className="cursor-flag" style={{ background: peer.color }}>
                {peer.name}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
