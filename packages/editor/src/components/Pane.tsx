import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@weave/core";
import type { UseDocResult } from "../hooks/useDoc";
import { Cursors } from "./Cursors";
import { mapIndexThroughDeltas } from "../lib/diff";

export interface PaneProps {
  label: string;
  replica: string;
  color: string;
  docState: UseDocResult;
  onRemove?: () => void;
  removable: boolean;
  onToggleCable: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  connected: "connected",
  reconnecting: "reconnecting",
  offline: "offline",
};

/**
 * One independent editor replica: a textarea whose value is kept in sync
 * with `doc.toString()` by diffing (see useDoc.applyLocalEdit — never a
 * full rebuild), plus the live cursor overlay for every other peer.
 *
 * Caret preservation: on every doc "change" event that did *not* originate
 * locally, the current browser selection is walked through the event's
 * TextDeltas (mapIndexThroughDeltas) and the textarea's selection is
 * reset to the mapped indices on the next frame. That is what keeps your
 * caret from jumping around while someone else is typing above you.
 */
export function Pane({ label, replica, color, docState, onRemove, removable, onToggleCable }: PaneProps) {
  const {
    doc,
    awareness,
    text,
    status,
    peers,
    applyLocalEdit,
    setCursor,
    undo,
    redo,
    canUndo,
    canRedo,
    partitioned,
    usingLoopback,
  } = docState;

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(text);

  useEffect(() => {
    return doc.on("change", (e: ChangeEvent) => {
      setValue(doc.toString());
      if (!e.local && taRef.current) {
        const ta = taRef.current;
        const newStart = mapIndexThroughDeltas(ta.selectionStart, e.deltas);
        const newEnd = mapIndexThroughDeltas(ta.selectionEnd, e.deltas);
        requestAnimationFrame(() => {
          if (document.activeElement === ta) ta.setSelectionRange(newStart, newEnd);
        });
      }
    });
  }, [doc]);

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    applyLocalEdit(e.target.value);
  };

  const reportSelection = () => {
    const ta = taRef.current;
    if (!ta) return;
    setCursor(ta.selectionStart, ta.selectionEnd);
  };

  return (
    <div className={`pane ${partitioned ? "pane-partitioned" : ""}`}>
      <div className="pane-header">
        <div className="pane-title">
          <span className="pane-dot" style={{ background: color }} />
          <span className="pane-label">{label}</span>
          <span className="pane-replica">{replica}</span>
        </div>
        <div className="pane-controls">
          <span className={`status-pill status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
          <button type="button" className="ghost-btn" onClick={onToggleCable}>
            {partitioned ? "reconnect" : "cut cable"}
          </button>
          <button type="button" className="ghost-btn" onClick={undo} disabled={!canUndo}>
            undo
          </button>
          <button type="button" className="ghost-btn" onClick={redo} disabled={!canRedo}>
            redo
          </button>
          {removable && onRemove && (
            <button type="button" className="ghost-btn ghost-btn-danger" onClick={onRemove}>
              remove
            </button>
          )}
        </div>
      </div>
      <div className="pane-editor">
        <textarea
          ref={taRef}
          className="pane-textarea"
          value={value}
          spellCheck={false}
          onChange={onInput}
          onSelect={reportSelection}
          onKeyUp={reportSelection}
          onClick={reportSelection}
          placeholder="Start typing — every keystroke becomes a CRDT op."
        />
        <Cursors textareaRef={taRef} awareness={awareness} peers={peers} selfReplica={replica} text={value} />
      </div>
      <div className="pane-footer">
        <span>{value.length} chars</span>
        {usingLoopback && <span className="pane-loopback-tag">loopback</span>}
      </div>
    </div>
  );
}
