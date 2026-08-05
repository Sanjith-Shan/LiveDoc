import type { ChaosConfig } from "../net/transport";

export interface ChaosPanelPane {
  replica: string;
  label: string;
  color: string;
  partitioned: boolean;
}

/** One step of the "go offline, type, come back" script, for the phase
 * indicator. `null` when no script is running. */
export interface ChaosScriptPhase {
  step: number;
  total: number;
  label: string;
}

export interface ChaosPanelProps {
  chaos: ChaosConfig;
  onChange: (cfg: ChaosConfig) => void;
  panes: ChaosPanelPane[];
  onTogglePartition: (replica: string) => void;
  onRunScript: () => void;
  scriptRunning: boolean;
  scriptPhase: ChaosScriptPhase | null;
}

export function ChaosPanel({ chaos, onChange, panes, onTogglePartition, onRunScript, scriptRunning, scriptPhase }: ChaosPanelProps) {
  return (
    <div className="chaos-panel">
      <div className="chaos-controls">
        <label className="chaos-field">
          <span className="chaos-field-label">
            Latency <b>{chaos.latencyMs}ms</b>
          </span>
          <input
            type="range"
            min={0}
            max={3000}
            step={50}
            value={chaos.latencyMs}
            onChange={(e) => onChange({ ...chaos, latencyMs: Number(e.target.value) })}
          />
        </label>
        <label className="chaos-field chaos-field-toggle">
          <span className="chaos-field-label">Reorder (jitter)</span>
          <input type="checkbox" checked={chaos.jitter} onChange={(e) => onChange({ ...chaos, jitter: e.target.checked })} />
        </label>
        <label className="chaos-field">
          <span className="chaos-field-label">
            Duplicate rate <b>{Math.round(chaos.duplicateRate * 100)}%</b>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(chaos.duplicateRate * 100)}
            onChange={(e) => onChange({ ...chaos, duplicateRate: Number(e.target.value) / 100 })}
          />
        </label>
        <label className="chaos-field">
          <span className="chaos-field-label">
            Drop rate <b>{Math.round(chaos.dropRate * 100)}%</b>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(chaos.dropRate * 100)}
            onChange={(e) => onChange({ ...chaos, dropRate: Number(e.target.value) / 100 })}
          />
        </label>
      </div>

      <div className="chaos-partitions">
        <span className="chaos-partitions-label">Cut the cable</span>
        <div className="chaos-partitions-list">
          {panes.map((p) => (
            <button
              key={p.replica}
              type="button"
              className={`partition-toggle ${p.partitioned ? "partition-toggle-active" : ""}`}
              style={{ borderColor: p.color }}
              onClick={() => onTogglePartition(p.replica)}
            >
              <span className="partition-dot" style={{ background: p.color }} />
              {p.label} · {p.partitioned ? "offline" : "online"}
            </button>
          ))}
        </div>
      </div>

      <button type="button" className="primary-btn script-btn" onClick={onRunScript} disabled={scriptRunning}>
        {scriptRunning ? "running the script…" : "Go offline, type, come back"}
      </button>
      {scriptPhase && (
        <div className="chaos-phase" aria-live="polite">
          <b>
            {scriptPhase.step}/{scriptPhase.total}
          </b>{" "}
          {scriptPhase.label}
        </div>
      )}
    </div>
  );
}
