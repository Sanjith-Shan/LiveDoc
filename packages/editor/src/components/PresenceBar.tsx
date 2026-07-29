import type { ConnectionStatus } from "../net/transport";

export interface PresenceEntry {
  replica: string;
  name: string;
  color: string;
  status: ConnectionStatus;
}

export function PresenceBar({ entries }: { entries: PresenceEntry[] }) {
  return (
    <div className="presence-bar">
      {entries.map((e) => (
        <div key={e.replica} className="presence-chip" title={`${e.name} — ${e.replica} — ${e.status}`}>
          <span className="presence-avatar" style={{ background: e.color }}>
            {e.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="presence-name">{e.name}</span>
          <span className={`presence-status presence-status-${e.status}`} />
        </div>
      ))}
    </div>
  );
}
